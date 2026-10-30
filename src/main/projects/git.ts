import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { ProjectGitReview } from '../../shared/projects';
import { getProjectProfile } from './index';

const execute = promisify(execFile);
const syncing = new Set<string>();
async function git(cwd: string, ...args: string[]) {
  const result = await execute('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 4_000_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return result.stdout;
}
const scopeMatches = (path: string, scope: string[]) =>
  scope.some((root) => path === root || path.startsWith(`${root}/`));
const safeFile = (path: string) =>
  !path
    .split('/')
    .some(
      (part) =>
        part === '..' || part === '.git' || part.startsWith('.env') || part.startsWith('.canvas-'),
    );

export async function reviewProjectGit(projectId: string): Promise<ProjectGitReview> {
  const project = getProjectProfile(projectId);
  const empty: ProjectGitReview = {
    available: false,
    branch: null,
    remote: null,
    head: null,
    digest: '',
    changes: [],
    diff: '',
    pendingCommits: [],
  };
  if (project.remote || !project.directory)
    return { ...empty, reason: '远程或不可用的目录请在项目终端中管理 Git。' };
  const cwd = project.directory;
  let root: string;
  try {
    root = (await git(cwd, 'rev-parse', '--show-toplevel')).trim();
  } catch {
    return { ...empty, reason: '这个项目尚未建立 Git 仓库，可打开项目终端配置。' };
  }
  if ((await realpath(root)) !== (await realpath(cwd)))
    return { ...empty, reason: '项目目录位于其他 Git 仓库内部，请关联仓库根目录后同步。' };
  const [head, branch, remoteRaw, status, pending] = await Promise.all([
    git(cwd, 'rev-parse', 'HEAD')
      .then((x) => x.trim())
      .catch(() => null),
    git(cwd, 'symbolic-ref', '--short', 'HEAD')
      .then((x) => x.trim())
      .catch(() => null),
    git(cwd, 'remote', 'get-url', 'origin')
      .then((x) => x.trim())
      .catch(() => null),
    git(
      cwd,
      '-c',
      'core.quotepath=false',
      'status',
      '--porcelain=v1',
      '--no-renames',
      '-z',
      '--untracked-files=all',
    ),
    git(cwd, 'log', '--oneline', '@{upstream}..HEAD')
      .then((x) => x.trim().split('\n').filter(Boolean))
      .catch(() => []),
  ]);
  const remote = remoteRaw?.replace(/(https?:\/\/)[^/@]+@/, '$1') ?? null;
  const changes = status
    .split('\0')
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2), path: line.slice(3), allowed: false }));
  const hash = createHash('sha256').update(
    JSON.stringify({ head, branch, remote: remoteRaw, scope: project.syncPaths, pending }),
  );
  for (const change of changes) {
    const path = join(cwd, change.path);
    const stats = await lstat(path).catch(() => null);
    const inside = !relative(cwd, resolve(path)).startsWith('..');
    change.allowed =
      inside &&
      safeFile(change.path) &&
      scopeMatches(change.path, project.syncPaths) &&
      (!stats || stats.isFile()) &&
      !/[U]/.test(change.status);
    hash.update(change.status).update(change.path);
    if (change.allowed && stats?.isFile()) {
      for await (const chunk of createReadStream(path)) hash.update(chunk);
    }
  }
  const allowed = changes.filter((item) => item.allowed).map((item) => item.path);
  const diff = allowed.length
    ? await git(cwd, 'diff', 'HEAD', '--', ...allowed).catch(() =>
        git(cwd, 'diff', '--', ...allowed),
      )
    : '';
  return {
    available: true,
    head,
    branch,
    remote,
    digest: hash.digest('hex'),
    changes,
    diff: diff.slice(0, 100_000),
    pendingCommits: pending,
  };
}

const syncSchema = z
  .object({
    projectId: z.string().uuid(),
    expectedHead: z.string().min(1),
    expectedDigest: z.string().min(1),
    message: z.string().trim().min(1).max(2000),
    paths: z.array(z.string().min(1)).max(500),
  })
  .strict();
export async function syncProjectGit(raw: unknown): Promise<ProjectGitReview> {
  const input = syncSchema.parse(raw);
  if (syncing.has(input.projectId)) throw new Error('这个项目正在同步，请等待完成');
  syncing.add(input.projectId);
  try {
    const current = await reviewProjectGit(input.projectId);
    if (!current.available || !current.branch || !current.remote || !current.head)
      throw new Error('请先在终端建立首个提交、当前分支和 origin 远程仓库');
    if (current.head !== input.expectedHead || current.digest !== input.expectedDigest)
      throw new Error('文件或 Git 状态已变化，请重新查看改动后再同步');
    if (current.pendingCommits.length)
      throw new Error('分支已有尚未推送的提交，请先在项目终端核对并同步；这里仅提交本次选中的文件');
    if (
      !input.paths.length ||
      new Set(input.paths).size !== input.paths.length ||
      input.paths.some(
        (path) => !current.changes.some((change) => change.path === path && change.allowed),
      )
    )
      throw new Error('请选择同步范围内的有效改动文件');
    if (
      current.changes.some(
        (change) =>
          change.status[0] !== ' ' &&
          change.status[0] !== '?' &&
          !input.paths.includes(change.path),
      )
    )
      throw new Error('暂存区有未选中的改动，请先在终端处理后再同步');
    const cwd = getProjectProfile(input.projectId).directory!;
    const upstream = await git(cwd, 'rev-parse', '--abbrev-ref', '@{upstream}')
      .then((value) => value.trim())
      .catch(() => {
        throw new Error('当前分支尚未关联远程分支，请先在项目终端配置');
      });
    if (upstream !== `origin/${current.branch}`)
      throw new Error('当前分支关联的远程目标与 origin 同名分支不同，请在项目终端核对后同步');
    await git(cwd, 'add', '--', ...input.paths);
    await git(cwd, 'commit', '--only', '-m', input.message, '--', ...input.paths);
    try {
      await git(cwd, 'push', 'origin', `HEAD:refs/heads/${current.branch}`);
    } catch {
      throw new Error(
        '本地提交已保存，但远程同步未成功。请打开项目终端检查网络、登录状态或分支冲突后继续同步。',
      );
    }
    return reviewProjectGit(input.projectId);
  } finally {
    syncing.delete(input.projectId);
  }
}
