import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { copyFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type {
  CanvasLocalSyncOptions,
  CanvasLocalSyncResult,
  CanvasLocalSyncState,
} from '../../shared/canvas-local';
import { getDatabase } from '../database';
import { availablePath, diskName } from '../storage';
import { linkProjectFolder } from '../workspace/api';
import {
  cachedFile,
  getCanvasAttachment,
  getCanvasQuizzes,
  getCanvasState,
  getSource,
  syncCanvasAssignment,
  syncCanvasCourse,
  syncCanvasCourses,
  type StoredSource,
} from './api';
import { collectCourseFileEntries } from './course-files';
import {
  findLocalCanvasBindingPath,
  localCanvasHash,
  localCanvasPath,
  localCanvasSignature,
  readLocalCanvasBindings,
  saveLocalCanvasBindings,
  type LocalCanvasBinding,
} from './local-bindings';

const courseSchema = z.object({ id: z.number(), name: z.string(), directory: z.string() });
const resultSchema = z.object({
  root: z.string(),
  projectId: z.string(),
  added: z.number(),
  updated: z.number(),
  unchanged: z.number(),
  adopted: z.number(),
  conflicts: z.array(
    z.object({ path: z.string(), reason: z.string(), incomingPath: z.string().optional() }),
  ),
  failed: z.array(z.string()),
  syncedAt: z.string(),
  scope: z
    .object({
      courseIds: z.array(z.number()),
      assignmentIds: z.array(z.number()).optional(),
      completeLibrary: z.boolean(),
    })
    .optional(),
});
const stateSchema = z.object({
  root: z.string(),
  projectId: z.string(),
  courseIds: z.array(z.number()),
  courses: z.array(courseSchema),
  syncedAt: z.string().nullable(),
  lastResult: resultSchema.nullable(),
});
const layoutSchema = z.object({
  course_directories: z.record(z.string(), z.string()).default({}),
  assignment_categories: z.record(z.string(), z.string()).default({}),
});
const legacySchema = z.array(
  z.object({
    course_id: z.union([z.string(), z.number()]),
    name: z.string(),
    path: z.string(),
    canvas_file_id: z.union([z.string(), z.number()]).optional(),
    file_id: z.union([z.string(), z.number()]).optional(),
  }),
);
const manifestSchema = z.array(
  z.object({ name: z.string(), local_path: z.string().optional(), url: z.string().optional() }),
);
const testSnapshotSchema = z.array(
  z.object({
    sourceId: z.string(),
    title: z.string(),
    dueAt: z.string().nullable(),
    path: z.string(),
    url: z.string(),
  }),
);
type TestSnapshot = z.infer<typeof testSnapshotSchema>;
const categories = ['课件', '作业', '测试', '大作业', '学习笔记'];

export function getLocalCanvasSyncState(): CanvasLocalSyncState | null {
  const row = getDatabase()
    .prepare("SELECT value FROM workspace_settings WHERE key='canvas-local-sync'")
    .get() as { value: string } | undefined;
  return row ? stateSchema.parse(JSON.parse(row.value)) : null;
}

function saveState(state: CanvasLocalSyncState) {
  getDatabase()
    .prepare('INSERT OR REPLACE INTO workspace_settings VALUES (?, ?)')
    .run('canvas-local-sync', JSON.stringify(state));
}

function readLayout(root: string) {
  const path = join(root, '.canvas-layout.json');
  return existsSync(path)
    ? layoutSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    : layoutSchema.parse({});
}

export function configureLocalCanvasSync(root: string, courseIds: number[]): CanvasLocalSyncState {
  const directory = realpathSync(resolve(z.string().min(1).parse(root)));
  if (!statSync(directory).isDirectory()) throw new Error('请选择已有课程文件夹');
  const selected = [...new Set(z.array(z.number().int().positive()).min(1).parse(courseIds))];
  const layout = readLayout(directory);
  const canvas = getCanvasState();
  const courses = selected.map((id) => {
    const course = canvas.courses.find((item) => item.id === id);
    if (!course) throw new Error(`课程 ${id} 尚未同步，请先刷新课程列表`);
    const path = localCanvasPath(directory, layout.course_directories[id] ?? diskName(course.name));
    return { id, name: course.name, directory: relative(directory, path) };
  });
  if (new Set(courses.map((course) => course.directory)).size !== courses.length)
    throw new Error('不同课程不能绑定到同一个本地文件夹');
  const project = linkProjectFolder(directory);
  const previous = getLocalCanvasSyncState();
  const state: CanvasLocalSyncState = {
    root: directory,
    projectId: project.id,
    courseIds: selected,
    courses,
    syncedAt: previous?.root === directory ? previous.syncedAt : null,
    lastResult: previous?.root === directory ? previous.lastResult : null,
  };
  saveState(state);
  return state;
}

function htmlEscape(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function readableDueAt(value: string | null | undefined) {
  if (!value) return '未设置';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '时间无效（请在 Canvas 核对）';
  return `${new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date)}（北京时间）`;
}

function sourceHtml(title: string, body: string, dueAt: string | null | undefined, url: string) {
  const due = dueAt
    ? `<time datetime="${htmlEscape(dueAt)}">${readableDueAt(dueAt)}</time>`
    : '未设置';
  return Buffer.from(
    `<!doctype html>\n<html lang="zh-CN"><meta charset="utf-8"><title>${htmlEscape(title)}</title>\n<body><h1>${htmlEscape(title)}</h1><p>DDL：${due}</p><p>Canvas 来源：${htmlEscape(url)}</p>\n${body}</body></html>\n`,
  );
}

function attachmentIds(html: string, courseId: number) {
  const ids = new Set<number>();
  for (const match of html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    let url: URL;
    try {
      url = new URL(match[1]!.replaceAll('&amp;', '&'), 'https://oc.sjtu.edu.cn');
    } catch {
      continue;
    }
    if (url.origin !== 'https://oc.sjtu.edu.cn') continue;
    const file = url.pathname.match(/^(?:\/api\/v1)?(?:\/courses\/(\d+))?\/files\/(\d+)(?:\/|$)/);
    if (file && (!file[1] || Number(file[1]) === courseId)) ids.add(Number(file[2]));
  }
  return [...ids];
}

interface Material {
  key: string;
  sourceId: string;
  version: string;
  path: string;
  scanRoot: string;
  mime: string;
  bytes?: Buffer;
  source?: StoredSource;
  candidates?: string[];
}

export const localSyncOptionsSchema = z
  .object({
    courseId: z.number().int().positive().optional(),
    assignmentIds: z.array(z.number().int().positive()).min(1).max(100).optional(),
  })
  .strict()
  .refine((value) => !value.assignmentIds || value.courseId, {
    message: '同步具体作业时必须指定课程',
  });
let syncQueue: Promise<unknown> = Promise.resolve();
const pendingSyncs = new Map<string, Promise<CanvasLocalSyncResult>>();
export function syncLocalCanvas(raw: CanvasLocalSyncOptions = {}): Promise<CanvasLocalSyncResult> {
  const options = localSyncOptionsSchema.parse(raw);
  if (options.assignmentIds)
    options.assignmentIds = [...new Set(options.assignmentIds)].sort((a, b) => a - b);
  const key = JSON.stringify(options);
  const pending = pendingSyncs.get(key);
  if (pending) return pending;
  const work = syncQueue.then(() => syncLocalCanvasFiles(options));
  const result = work.finally(() => pendingSyncs.delete(key));
  pendingSyncs.set(key, result);
  syncQueue = result.catch(() => {});
  return result;
}

async function syncLocalCanvasFiles(
  options: CanvasLocalSyncOptions,
): Promise<CanvasLocalSyncResult> {
  const state = getLocalCanvasSyncState();
  if (!state) throw new Error('请先关联本地课程文件夹');
  const courses = options.courseId
    ? state.courses.filter((course) => course.id === options.courseId)
    : state.courses;
  if (!courses.length) throw new Error('这门课程尚未关联本地文件夹');
  const result: CanvasLocalSyncResult = {
    root: state.root,
    projectId: state.projectId,
    added: 0,
    updated: 0,
    unchanged: 0,
    adopted: 0,
    conflicts: [],
    failed: [],
    syncedAt: new Date().toISOString(),
    scope: {
      courseIds: courses.map((course) => course.id),
      assignmentIds: options.assignmentIds,
      completeLibrary: !options.courseId,
    },
  };
  const bindings = readLocalCanvasBindings(state.root);
  const finish = () => {
    saveLocalCanvasBindings(state.root, bindings);
    saveState({
      ...state,
      syncedAt:
        result.scope?.completeLibrary && !result.failed.length ? result.syncedAt : state.syncedAt,
      lastResult: result,
    });
    return result;
  };
  const apply = async (material: Material) => {
    const old = bindings[material.key];
    let path = localCanvasPath(state.root, old?.path ?? material.path);
    if (old) {
      const moved = findLocalCanvasBindingPath(state.root, old);
      if (moved) {
        path = moved;
        old.path = relative(state.root, moved);
      }
    }
    let localHash: string | null = null;
    if (existsSync(path) && statSync(path).isFile()) localHash = await localCanvasHash(path);
    if (old?.version === material.version && localHash === old.hash) {
      old.signature = localCanvasSignature(path);
      result.unchanged += 1;
      return path;
    }
    if (old?.incoming?.version === material.version) {
      const incoming = localCanvasPath(state.root, old.incoming.path);
      if (existsSync(incoming) && (await localCanvasHash(incoming)) === old.incoming.hash) {
        result.conflicts.push({
          path,
          reason: '本地文件与 Canvas 版本不同，已保留两份',
          incomingPath: incoming,
        });
        result.unchanged += 1;
        return incoming;
      }
    }
    if (old?.version === material.version && localHash !== null) {
      result.conflicts.push({ path, reason: '本地文件已修改，保留本地内容' });
      return path;
    }
    const downloaded = material.source ? await cachedFile(material.source) : null;
    const remoteHash = material.bytes
      ? createHash('sha256').update(material.bytes).digest('hex')
      : await localCanvasHash(downloaded!.path);
    if (!old)
      for (const candidate of material.candidates ?? []) {
        const candidatePath = localCanvasPath(state.root, candidate);
        if (
          statSync(candidatePath, { throwIfNoEntry: false })?.isFile() &&
          (await localCanvasHash(candidatePath)) === remoteHash
        ) {
          path = candidatePath;
          localHash = remoteHash;
          break;
        }
      }
    localHash = statSync(path, { throwIfNoEntry: false })?.isFile()
      ? await localCanvasHash(path)
      : null;
    const record = (saved: string): LocalCanvasBinding => {
      const stats = statSync(saved);
      return {
        sourceId: material.sourceId,
        version: material.version,
        path: relative(state.root, saved),
        hash: remoteHash,
        mime: downloaded?.mime ?? material.mime,
        scanRoot: material.candidates?.includes(relative(state.root, saved))
          ? dirname(relative(state.root, saved))
          : material.scanRoot,
        ino: stats.ino,
        dev: stats.dev,
        signature: localCanvasSignature(saved),
      };
    };
    if (localHash === remoteHash) {
      bindings[material.key] = record(path);
      if (old) result.unchanged += 1;
      else result.adopted += 1;
      return path;
    }
    const occupied = existsSync(path);
    const conflict = occupied && (!old || localHash !== old.hash);
    const target = conflict
      ? availablePath(
          dirname(path),
          `${basename(path, extname(path))} [Canvas ${material.version.replace(/[^\w-]/g, '_').slice(0, 32)}]${extname(path)}`,
        )
      : path;
    localCanvasPath(state.root, relative(state.root, target));
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.part`;
    try {
      if (material.bytes) await writeFile(temporary, material.bytes, { flag: 'wx' });
      else await copyFile(downloaded!.path, temporary);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    if (conflict) {
      const original = old ?? {
        ...record(target),
        path: relative(state.root, path),
        ino: 0,
        dev: 0,
      };
      original.incoming = {
        version: material.version,
        path: relative(state.root, target),
        hash: remoteHash,
      };
      bindings[material.key] = original;
      result.conflicts.push({
        path,
        reason: old ? '本地文件已修改，Canvas 新版本另存' : '同名本地文件内容不同，Canvas 版本另存',
        incomingPath: target,
      });
    } else {
      bindings[material.key] = record(target);
      if (old) result.updated += 1;
      else result.added += 1;
    }
    saveLocalCanvasBindings(state.root, bindings);
    return target;
  };
  const safely = async (name: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      result.failed.push(`${name}：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  try {
    const layout = readLayout(state.root);
    const legacyPath = join(state.root, '.canvas-local-status.json');
    const legacy = existsSync(legacyPath)
      ? legacySchema.parse(JSON.parse(readFileSync(legacyPath, 'utf8')))
      : [];
    if (!options.courseId) await syncCanvasCourses();
    const testGroups: { course: string; tests: TestSnapshot; warning: string }[] = [];
    for (const course of courses) {
      const tests: TestSnapshot = [];
      const refreshedAssignments = new Set<number>();
      let testsVerified = false;
      let testsFailed = false;
      await safely(course.name, async () => {
        for (const category of categories)
          mkdirSync(localCanvasPath(state.root, join(course.directory, category)), {
            recursive: true,
          });
        if (options.assignmentIds) {
          for (const id of options.assignmentIds)
            await safely(`${course.name}/作业 ${id}`, async () => {
              await syncCanvasAssignment(course.id, id);
              refreshedAssignments.add(id);
            });
        } else await syncCanvasCourse(course.id);
        const canvas = getCanvasState();
        const synced = canvas.courses.find((item) => item.id === course.id);
        if (!options.assignmentIds && synced?.error)
          result.failed.push(`${course.name}：${synced.error}`);
        if (!options.assignmentIds && synced?.error?.includes('作业：')) testsFailed = true;
        if (!options.assignmentIds) {
          const manifestPath = join(state.root, `.canvas-${course.id}-files.json`);
          const manifest = existsSync(manifestPath)
            ? manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
            : [];
          const candidatePath = (path: string) => {
            const absolute = localCanvasPath(state.root, path);
            const insideCourse = relative(localCanvasPath(state.root, course.directory), absolute);
            if (
              !insideCourse ||
              insideCourse === '..' ||
              insideCourse.startsWith(`..${sep}`) ||
              isAbsolute(insideCourse) ||
              insideCourse.split(sep).includes('学习笔记')
            )
              throw new Error('历史资料路径必须属于对应课程且不能位于学习笔记');
            return relative(state.root, absolute);
          };
          const lectureFiles = new Map<string, string[]>();
          const pending = [localCanvasPath(state.root, join(course.directory, '课件'))];
          while (pending.length) {
            for (const item of readdirSync(pending.pop()!, { withFileTypes: true })) {
              if (item.isSymbolicLink() || item.name === '学习笔记') continue;
              const path = join(item.parentPath, item.name);
              if (item.isDirectory()) pending.push(path);
              else if (item.isFile()) {
                const paths = lectureFiles.get(item.name) ?? [];
                paths.push(path);
                lectureFiles.set(item.name, paths);
              }
            }
          }
          for (const entry of collectCourseFileEntries(course.id, canvas.items)) {
            await safely(`${course.name}/${entry.name}`, async () => {
              const source = getSource(entry.sourceId);
              if (!source.updatedAt)
                throw new Error('Canvas 未提供文件更新时间，无法证明二进制版本，未更新本地文件');
              const matches = legacy.filter(
                (item) =>
                  Number(item.course_id) === course.id &&
                  (String(item.canvas_file_id ?? item.file_id ?? '') === String(source.fileId) ||
                    item.name === entry.name),
              );
              const manifestMatches = manifest.filter(
                (item) =>
                  item.local_path &&
                  (item.name === entry.name ||
                    (item.url &&
                      new URL(item.url, 'https://oc.sjtu.edu.cn').pathname.match(
                        /\/files\/(\d+)/,
                      )?.[1] === String(source.fileId))),
              );
              const candidates = [
                ...new Set(
                  [
                    ...manifestMatches.map((item) => item.local_path!),
                    ...matches.map((item) => item.path),
                  ].map(candidatePath),
                ),
              ];
              for (const path of lectureFiles.get(diskName(entry.name)) ?? [])
                if (source.size === undefined || statSync(path).size === source.size)
                  candidates.push(relative(state.root, path));
              const legacyFile = candidates.find((path) =>
                statSync(localCanvasPath(state.root, path), { throwIfNoEntry: false })?.isFile(),
              );
              const folders = entry.folders
                .filter((folder) => folder !== '资料' && folder !== '课件')
                .map(diskName);
              await apply({
                key: source.id,
                sourceId: source.id,
                version: source.updatedAt,
                path:
                  legacyFile ?? join(course.directory, '课件', ...folders, diskName(entry.name)),
                scanRoot: join(course.directory, '课件'),
                mime: source.mime ?? 'application/octet-stream',
                source,
                candidates,
              });
            });
          }
        }
        const quizzes = options.assignmentIds
          ? []
          : await getCanvasQuizzes(course.id)
              .then((items) => {
                testsVerified = true;
                return items;
              })
              .catch((error: unknown) => {
                result.failed.push(
                  `${course.name}/测试：${error instanceof Error ? error.message : String(error)}`,
                );
                return [];
              });
        const quizAssignments = new Set(
          quizzes.map((quiz) => quiz.assignmentId).filter((id) => id !== undefined),
        );
        const taskInfo = (title: string, test: boolean) => {
          const folderName = diskName(`${course.name}-${title}`);
          const categoryEntry = Object.entries(layout.assignment_categories).find(
            ([path, category]) =>
              basename(path) === folderName &&
              path.startsWith(`${course.directory}/${category}/`) &&
              ['作业', '大作业', '测试'].includes(category),
          );
          const category = test ? '测试' : (categoryEntry?.[1] ?? '作业');
          return {
            category,
            directory:
              categoryEntry && categoryEntry[1] === category
                ? categoryEntry[0]
                : join(course.directory, category, folderName),
          };
        };
        const description = async (
          sourceId: string,
          title: string,
          body: string,
          dueAt: string | null | undefined,
          url: string,
          updatedAt: string | null | undefined,
          test: boolean,
        ) => {
          const { category, directory: taskDirectory } = taskInfo(title, test);
          localCanvasPath(state.root, taskDirectory);
          const bytes = sourceHtml(title, body, dueAt, url);
          const hash = createHash('sha256').update(bytes).digest('hex');
          const path = join(
            taskDirectory,
            category === '测试' ? 'Canvas测试说明.html' : 'Canvas作业说明.html',
          );
          const savedPath = await apply({
            key: `${sourceId}:description`,
            sourceId,
            version: `${updatedAt ?? 'content'}:${hash}`,
            path,
            scanRoot: taskDirectory,
            mime: 'text/html',
            bytes,
          });
          if (category === '测试')
            tests.push({
              sourceId,
              title,
              dueAt: dueAt ?? null,
              path: relative(state.root, savedPath),
              url,
            });
          for (const id of attachmentIds(body, course.id))
            await safely(`${course.name}/${title}/附件 ${id}`, async () => {
              const source = await getCanvasAttachment(course.id, id);
              if (!source.updatedAt)
                throw new Error('Canvas 未提供附件更新时间，无法证明二进制版本，未更新本地文件');
              await apply({
                key: `${sourceId}:attachment:${id}`,
                sourceId: source.id,
                version: source.updatedAt,
                path: join(taskDirectory, diskName(source.title)),
                scanRoot: taskDirectory,
                mime: source.mime ?? 'application/octet-stream',
                source,
              });
            });
        };
        const assignments = new Map(
          canvas.items
            .filter(
              (item) =>
                item.courseId === course.id &&
                item.kind === 'assignment' &&
                item.sourceId &&
                (!options.assignmentIds ||
                  refreshedAssignments.has(Number(item.sourceId.split(':').at(-1)))),
            )
            .map((item) => [item.sourceId!, item.name]),
        );
        for (const [sourceId, title] of assignments)
          await safely(`${course.name}/${sourceId}`, async () => {
            if (quizAssignments.has(Number(sourceId.split(':').at(-1)))) return;
            try {
              const source = getSource(sourceId);
              if (source.html === undefined) throw new Error('作业说明尚未完整同步，保留已有文件');
              await description(
                sourceId,
                source.title,
                source.html,
                source.dueAt,
                source.url ?? '',
                source.updatedAt,
                Boolean(source.quizId),
              );
            } catch (error) {
              if (taskInfo(title, false).category === '测试') testsFailed = true;
              throw error;
            }
          });
        for (const quiz of quizzes)
          await safely(`${course.name}/${quiz.title}`, async () => {
            try {
              await description(
                `quiz:${course.id}:${quiz.id}`,
                quiz.title,
                quiz.description,
                quiz.dueAt,
                quiz.url,
                quiz.updatedAt,
                true,
              );
            } catch (error) {
              testsFailed = true;
              throw error;
            }
          });
      });
      if (options.assignmentIds) continue;
      const snapshotKey = `canvas-local-tests:${state.root}:${course.id}`;
      if (testsVerified && !testsFailed) {
        getDatabase()
          .prepare('INSERT OR REPLACE INTO workspace_settings VALUES (?, ?)')
          .run(snapshotKey, JSON.stringify(tests));
        testGroups.push({ course: course.name, tests, warning: '' });
      } else {
        const snapshot = getDatabase()
          .prepare('SELECT value FROM workspace_settings WHERE key=?')
          .get(snapshotKey) as { value: string } | undefined;
        testGroups.push({
          course: course.name,
          tests: snapshot ? testSnapshotSchema.parse(JSON.parse(snapshot.value)) : [],
          warning: snapshot
            ? '本次未能核对测试，沿用上次核对成功的记录。'
            : '本次未能核对测试，尚无上次成功记录，测试安排未知。',
        });
      }
    }
    if (options.courseId) return finish();
    const bytes = Buffer.from(
      `# Canvas 测试总览\n\n${testGroups.map((group) => `${group.warning ? `> ${group.course}：${group.warning}\n\n` : ''}${group.tests.map((test) => `- ${group.course} / ${test.title}\n  - DDL：${readableDueAt(test.dueAt)}\n  - 内容：[测试说明](<${test.path.split(sep).join('/')}>)\n  - Canvas：${test.url}`).join('\n')}`).join('\n')}\n`,
    );
    const hash = createHash('sha256').update(bytes).digest('hex');
    await safely('Canvas测试总览', () =>
      apply({
        key: 'canvas:test-overview',
        sourceId: 'canvas:test-overview',
        version: hash,
        path: 'Canvas测试总览.md',
        scanRoot: state.courses[0]!.directory,
        mime: 'text/markdown',
        bytes,
      }),
    );
  } catch (error) {
    result.failed.push(error instanceof Error ? error.message : String(error));
  }
  return finish();
}

export function localCourseContext(cwd: string): string {
  const state = getLocalCanvasSyncState();
  if (!state) return '';
  const path = relative(state.root, existsSync(cwd) ? realpathSync(cwd) : resolve(cwd));
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return '';
  return `本地课程资料根目录：${state.root}。课程映射：${state.courses.map((course) => `${course.id} → ${course.directory}`).join('；')}。复用现有课程目录：课件（含资料）、作业/课程-作业名（说明与题目附件）、大作业、测试（DDL与内容）、学习笔记；根目录保留测试总览。整理笔记或完成作业时只处理用户指定课程与范围，完整成果保存到对应本地目录，并返回文件路径；用户明确要求时可更新已有笔记或作业成果。Canvas 同步只管理已登记的来源文件与 Canvas说明/总览，不得覆盖学习笔记、作业答案和用户成果；原始题目与附件保留。已有资料先按路径与来源核对再读取，不重复下载或复制；同步冲突与失败以本地同步报告为准。`;
}
