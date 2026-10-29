import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { LearningCourse, LearningSource } from '../../shared/learning';
import { toolError } from '../../shared/tool-errors';
import { getDatabase } from '../database';
import { localCanvasHash, localCanvasPath, localCanvasSignature } from '../canvas/local-bindings';

const localSourceSchema = z.object({
  sourceId: z.string(),
  root: z.string(),
  courseId: z.number(),
  path: z.string(),
  hash: z.string(),
  signature: z.string(),
  origin: z.enum(['canvas', 'wechat', 'local']),
  provenance: z.string(),
});
type LocalSource = z.infer<typeof localSourceSchema>;
const ignoredDirectories = new Set([
  'node_modules',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'coverage',
  'target',
]);
const sourceExtensions = new Set([
  '.pdf',
  '.ppt',
  '.pptx',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.csv',
  '.tsv',
  '.md',
  '.txt',
  '.tex',
  '.html',
  '.ipynb',
  '.py',
  '.r',
  '.js',
  '.ts',
  '.c',
  '.cpp',
  '.h',
  '.java',
  '.sql',
  '.zip',
]);

export const registerLocalLearningSourceSchema = z
  .object({
    courseId: z.number().int().positive(),
    path: z.string().trim().min(1).max(4000),
    origin: z.enum(['canvas', 'wechat', 'local']),
    provenance: z.string().trim().min(1).max(2000),
  })
  .strict();

function readSources(root: string, courseId: number): LocalSource[] {
  const rows = getDatabase()
    .prepare('SELECT value FROM workspace_settings WHERE key LIKE ?')
    .all('learning:local-source:%') as { value: string }[];
  return rows
    .map((row) => localSourceSchema.parse(JSON.parse(row.value)))
    .filter((source) => source.root === root && source.courseId === courseId);
}

function persist(source: LocalSource) {
  getDatabase()
    .prepare('INSERT OR REPLACE INTO workspace_settings VALUES (?, ?)')
    .run(`learning:local-source:${source.sourceId}`, JSON.stringify(source));
}

function allowedPath(course: LearningCourse, path: string, excluded: Set<string>): string {
  const target = localCanvasPath(course.directory, resolve(course.directory, path));
  const segments = relative(course.directory, target).split(sep);
  if (
    !['课件', '作业', '大作业'].includes(segments[0]!) ||
    segments.some((segment) => segment.startsWith('.')) ||
    excluded.has(target)
  )
    throw toolError(
      'INVALID_INPUT',
      '来源须为课程课件、作业或大作业中的资料，不能登记已保存的学习成果',
    );
  return target;
}

function sourceView(source: LocalSource): LearningSource {
  let warning: string | undefined;
  let localPath: string | null = null;
  try {
    const path = localCanvasPath(source.root, source.path);
    if (!statSync(path).isFile()) throw new Error('not a file');
    localPath = path;
    if (localCanvasSignature(path) !== source.signature)
      warning = '本地资料已变化，正在重新核对内容版本';
  } catch {
    warning = '本地资料文件缺失或无法读取';
  }
  return {
    sourceId: source.sourceId,
    title: basename(source.path),
    kind: 'file',
    localPath,
    version: source.hash,
    revision: source.hash,
    origin: source.origin,
    provenance: source.provenance,
    ...(source.origin === 'canvas' ? { notice: '本地归档资料，按文件内容追踪版本' } : {}),
    ...(warning ? { warning } : {}),
  };
}

export function getLocalLearningSources(
  root: string,
  course: LearningCourse,
  excluded: Set<string>,
): LearningSource[] {
  return readSources(root, course.id)
    .filter((source) => !excluded.has(resolve(root, source.path)))
    .map(sourceView);
}

export async function registerLocalSource(
  root: string,
  course: LearningCourse,
  input: z.infer<typeof registerLocalLearningSourceSchema>,
  excluded: Set<string>,
): Promise<LearningSource> {
  const path = allowedPath(course, input.path, excluded);
  if (!statSync(path).isFile()) throw toolError('INVALID_INPUT', '资料来源必须为文件');
  const signature = localCanvasSignature(path);
  const hash = await localCanvasHash(path);
  if (localCanvasSignature(path) !== signature)
    throw toolError('VERSION_CONFLICT', '登记期间资料内容发生变化，请重试');
  const relativePath = relative(root, path);
  const source: LocalSource = {
    sourceId: `local:${createHash('sha256').update(`${root}\0${course.id}\0${relativePath}`).digest('hex')}`,
    root,
    courseId: course.id,
    path: relativePath,
    hash,
    signature,
    origin: input.origin,
    provenance: input.provenance,
  };
  persist(source);
  return sourceView(source);
}

export async function refreshLocalLearningSources(
  root: string,
  course: LearningCourse,
  excluded: Set<string>,
): Promise<void> {
  const known = readSources(root, course.id);
  const byPath = new Map(known.map((source) => [resolve(root, source.path), source]));
  const paths = new Set(byPath.keys());
  const pending = [join(course.directory, '课件')];
  while (pending.length) {
    const directory = pending.pop()!;
    try {
      if (lstatSync(directory).isSymbolicLink()) continue;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) pending.push(path);
        else if (
          entry.isFile() &&
          sourceExtensions.has(extname(entry.name).toLowerCase()) &&
          !/^(?:package-lock|package|tsconfig(?:\..*)?)\.json$|\.lock$/i.test(entry.name) &&
          !/(?:清单|下载进度|下载记录|manifest|index)\.(?:json|txt|csv|md)$/i.test(entry.name)
        )
          paths.add(path);
      }
    } catch {}
  }
  const queue = [...paths].filter((path) => !excluded.has(path));
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const path = queue.pop()!;
        try {
          allowedPath(course, path, excluded);
          const before = localCanvasSignature(path);
          const old = byPath.get(path);
          if (old?.signature === before) continue;
          const hash = await localCanvasHash(path);
          if (localCanvasSignature(path) !== before) continue;
          if (old) {
            const current = readSources(root, course.id).find(
              (item) => item.sourceId === old.sourceId,
            );
            if (current && current.hash === old.hash && current.signature === old.signature)
              persist({ ...current, hash, signature: before });
          } else {
            const current = readSources(root, course.id).find(
              (item) => resolve(root, item.path) === path,
            );
            if (!current)
              await registerLocalSource(
                root,
                course,
                {
                  courseId: course.id,
                  path,
                  origin: 'local',
                  provenance: '课程课件文件夹中的本地资料；下载渠道尚未记录',
                },
                excluded,
              );
          }
        } catch {}
      }
    }),
  );
}

export async function verifyLocalLearningSource(
  root: string,
  courseId: number,
  source: LearningSource,
) {
  const current = readSources(root, courseId).find((item) => item.sourceId === source.sourceId);
  if (!current || !source.localPath) throw toolError('VERSION_CONFLICT', '本地资料来源不可用');
  const path = localCanvasPath(root, current.path);
  const before = localCanvasSignature(path);
  if (
    current.hash !== source.version ||
    (await localCanvasHash(path)) !== source.version ||
    localCanvasSignature(path) !== before
  )
    throw toolError('VERSION_CONFLICT', `本地资料版本已变化，请重新读取：${source.title}`);
  const latest = readSources(root, courseId).find((item) => item.sourceId === source.sourceId);
  if (!latest || latest.hash !== current.hash || latest.path !== current.path)
    throw toolError('VERSION_CONFLICT', '核对期间本地资料版本已变化');
  persist({ ...latest, signature: before });
}
