import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../database', () => ({ getDatabase: vi.fn() }));
vi.mock('../workspace/api', () => ({ entry: vi.fn(), projectLocation: vi.fn() }));
vi.mock('../todo', () => ({ getTodoState: vi.fn(() => ({ items: [] })) }));
import { getDatabase } from '../database';
import { entry, projectLocation } from '../workspace/api';
import { getTodoState } from '../todo';
import {
  addProjectReference,
  getProjectsState,
  prepareProjectAction,
  saveProjectProfile,
} from './index';
import { reviewProjectGit, syncProjectGit } from './git';

const id = 'ad857632-dca2-4314-9584-8498e25c7367';
let db: DatabaseSync;
let root: string;
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
const profile = () => ({
  projectId: id,
  expectedUpdatedAt: null,
  type: 'code' as const,
  goal: '可靠地交付原型',
  successCriteria: '通过计算核验',
  stage: '实现',
  nextStep: '检查输入',
  conventions: '保留原件',
  milestones: [{ id: 'm1', title: '通过验收', completed: false, dueAt: null }],
  references: [],
  syncPaths: [],
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dela-projects-'));
  db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE workspace_entries(id TEXT,name TEXT,kind TEXT)');
  db.prepare("INSERT INTO workspace_entries VALUES (?,'项目甲','project')").run(id);
  vi.mocked(getDatabase).mockReturnValue(db as unknown as ReturnType<typeof getDatabase>);
  vi.mocked(entry).mockReturnValue({
    id,
    name: '项目甲',
    kind: 'project',
    parentId: null,
    sourceId: null,
    updatedAt: 'now',
    path: root,
  });
  vi.mocked(projectLocation).mockReturnValue({ kind: 'local', path: root });
  vi.mocked(getTodoState).mockReturnValue({
    items: [],
    connected: false,
    error: null,
    syncedAt: null,
    syncing: false,
  });
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

it('adopts existing folder projects without moving files or declaring progress complete', () => {
  writeFileSync(join(root, 'original.md'), '用户原稿');
  expect(getProjectsState().projects[0]).toMatchObject({
    projectId: id,
    directory: root,
    goal: '',
    milestones: [],
    syncPaths: [],
  });
  saveProjectProfile(profile());
  addProjectReference(id, '原稿', 'original.md', 'source');
  expect(getProjectsState().projects[0]?.references[0]?.path).toBe(join(root, 'original.md'));
  expect(getProjectsState().projects[0]?.milestones[0]?.completed).toBe(false);
  expect(readFileSync(join(root, 'original.md'), 'utf8')).toBe('用户原稿');
});
it('builds a concrete project job with selected task and requires real verification', () => {
  saveProjectProfile(profile());
  vi.mocked(getTodoState).mockReturnValue({
    ...getTodoState(),
    items: [
      {
        id: 't1',
        projectId: id,
        source: 'personal',
        title: '核对模型',
        notes: '验证输入',
        status: 'pending',
        dueAt: null,
        createdAt: 'now',
        readAt: null,
      },
    ],
  });
  const job = prepareProjectAction(id, 'review', 't1');
  expect(job).toMatchObject({
    domain: 'project',
    action: 'review',
    objectKey: 't1',
    projectId: id,
  });
  expect(job.prompt).toContain('核对模型');
  expect(job.prompt).toContain('生成计划不代表任务或里程碑完成');
  expect(job.prompt).toContain('禁止自行');
  expect(() => prepareProjectAction(id, 'continue', 'missing')).toThrow('项目任务已不存在');
});
it('does not silently accept invalid sync scopes or non-project entries', () => {
  expect(() => saveProjectProfile({ ...profile(), syncPaths: ['../private'] })).toThrow();
  vi.mocked(entry).mockReturnValue({ ...entry(id), kind: 'folder' });
  expect(() => saveProjectProfile(profile())).toThrow('请选择一个项目');
});
it('reviews changed files against explicit scope and refuses a stale preview', async () => {
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  writeFileSync(join(root, 'answer.md'), 'original');
  git('add', '.');
  git('commit', '-m', 'initial');
  git('remote', 'add', 'origin', 'https://example.test/repository.git');
  saveProjectProfile({ ...profile(), syncPaths: ['answer.md'] });
  writeFileSync(join(root, 'answer.md'), 'edited');
  writeFileSync(join(root, 'private.md'), 'private');
  const before = await reviewProjectGit(id);
  expect(before.changes).toEqual(
    expect.arrayContaining([
      { path: 'answer.md', status: ' M', allowed: true },
      { path: 'private.md', status: '??', allowed: false },
    ]),
  );
  expect(before.diff).toContain('+edited');
  writeFileSync(join(root, 'answer.md'), 'changed again');
  await expect(
    syncProjectGit({
      projectId: id,
      expectedHead: before.head,
      expectedDigest: before.digest,
      paths: ['answer.md'],
      message: 'Update',
    }),
  ).rejects.toThrow('状态已变化');
  expect(git('log', '--oneline')).toContain('initial');
});
it('commits and pushes only explicitly reviewed selected files to a local test remote', async () => {
  const remote = join(root, 'remote.git');
  git('init', '--bare', remote);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  writeFileSync(join(root, '.gitignore'), 'remote.git/\n');
  writeFileSync(join(root, 'answer.md'), 'original');
  git('add', '.');
  git('commit', '-m', 'initial');
  git('remote', 'add', 'origin', remote);
  git('push', '-u', 'origin', 'main');
  saveProjectProfile({ ...profile(), syncPaths: ['answer.md'] });
  writeFileSync(join(root, 'answer.md'), 'final');
  writeFileSync(join(root, 'private.md'), 'private');
  const review = await reviewProjectGit(id);
  await syncProjectGit({
    projectId: id,
    expectedHead: review.head,
    expectedDigest: review.digest,
    paths: ['answer.md'],
    message: 'Update answer',
  });
  expect(git('show', 'HEAD:answer.md')).toBe('final');
  expect(git('status', '--porcelain')).toContain('private.md');
  expect(git('rev-parse', 'HEAD')).toBe(git('rev-parse', 'origin/main'));
});

it('rejects a stale editor save without dropping an artifact registered by an ongoing job', () => {
  const saved = saveProjectProfile(profile()).projects[0]!;
  const stale = { ...profile(), expectedUpdatedAt: saved.updatedAt, goal: '用户正在编辑的目标' };
  addProjectReference(id, '新成果', 'result.md', 'deliverable');
  expect(() => saveProjectProfile(stale)).toThrow('项目记录已由其他操作更新');
  const latest = getProjectsState().projects[0]!;
  expect(latest.references[0]?.title).toBe('新成果');
  expect(latest.updatedAt).not.toBe(saved.updatedAt);
  expect(latest.goal).toBe(saved.goal);
  saveProjectProfile({
    ...stale,
    expectedUpdatedAt: latest.updatedAt,
    references: latest.references,
  });
  expect(getProjectsState().projects[0]).toMatchObject({
    goal: '用户正在编辑的目标',
    references: latest.references,
  });
});
