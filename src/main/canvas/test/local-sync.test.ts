import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasState, SourceItem } from '../../../shared/canvas';
import type { CanvasQuizSummary } from '../../../shared/canvas-local';
import type { StoredSource } from '../api';

vi.mock('electron', () => ({ app: { getPath: () => '' } }));
vi.mock('../../database', () => ({ getDatabase: vi.fn() }));
vi.mock('../../workspace/api', () => ({ linkProjectFolder: vi.fn() }));
vi.mock('../api', () => ({
  getCanvasState: vi.fn(),
  syncCanvasCourses: vi.fn(),
  syncCanvasCourse: vi.fn(),
  syncCanvasAssignment: vi.fn(),
  getSource: vi.fn(),
  cachedFile: vi.fn(),
  getCanvasQuizzes: vi.fn(),
  getCanvasAttachment: vi.fn(),
}));

import { getDatabase } from '../../database';
import { linkProjectFolder } from '../../workspace/api';
import {
  cachedFile,
  getCanvasAttachment,
  getCanvasQuizzes,
  getCanvasState,
  getSource,
  syncCanvasCourse,
  syncCanvasAssignment,
  syncCanvasCourses,
} from '../api';
import { boundCanvasFile } from '../local-bindings';
import {
  configureLocalCanvasSync,
  getLocalCanvasSyncState,
  localCourseContext,
  syncLocalCanvas,
} from '../local-sync';

let db: DatabaseSync;
let temporary: string;
let root: string;
let courseDirectory: string;
let state: CanvasState;
let sources: Map<string, StoredSource>;
let downloads: Map<string, string>;
const courseName = '概率论与数理统计';
const originalTime = new Date('2000-01-01T00:00:00.000Z');

function putFile(name: string, text: string, id = 10): StoredSource {
  const source: StoredSource = {
    id: `file:${id}`,
    courseId: 1,
    fileId: id,
    title: name,
    kind: 'file',
    mime: 'application/pdf',
    size: Buffer.byteLength(text),
    updatedAt: '2026-10-20T00:00:00.000Z',
  };
  sources.set(source.id, source);
  downloads.set(`${source.id}:${source.updatedAt}`, text);
  state.items.push({
    id: `1:files/${source.id}`,
    parentId: '1:files',
    courseId: 1,
    name,
    kind: 'file',
    sourceId: source.id,
  });
  return source;
}

function localFile(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  utimesSync(path, originalTime, originalTime);
  return path;
}

function putAssignment(id: number, title: string, html: string): StoredSource {
  const source: StoredSource = {
    id: `assignment:${id}`,
    courseId: 1,
    title,
    kind: 'assignment',
    html,
    dueAt: '2026-11-01T15:59:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    url: `https://oc.sjtu.edu.cn/courses/1/assignments/${id}`,
  };
  sources.set(source.id, source);
  state.items.push({
    id: source.id,
    parentId: '1:assignments',
    courseId: 1,
    name: title,
    kind: 'assignment',
    sourceId: source.id,
  });
  return source;
}

function quiz(courseId: number, title: string, dueAt: string): CanvasQuizSummary {
  const id = courseId * 10 + 3;
  return {
    id,
    title,
    description: `<p>${title}覆盖第1至第5章。</p>`,
    dueAt,
    url: `https://oc.sjtu.edu.cn/courses/${courseId}/quizzes/${id}`,
    updatedAt: '2026-10-27T00:00:00.000Z',
  };
}

function snapshot(directory = root): Record<string, { text: string; mtime: number }> {
  const result: Record<string, { text: string; mtime: number }> = {};
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile())
        result[relative(directory, path)] = {
          text: readFileSync(path).toString('utf8'),
          mtime: statSync(path).mtimeMs,
        };
    }
  }
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  temporary = realpathSync(mkdtempSync(join(tmpdir(), 'dela-canvas-local-')));
  root = join(temporary, '大三上');
  courseDirectory = join(root, courseName);
  mkdirSync(courseDirectory, { recursive: true });
  db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE workspace_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  vi.mocked(getDatabase).mockReturnValue({
    prepare: (sql: string) => db.prepare(sql),
    transaction: (work: () => unknown) => () => {
      db.exec('BEGIN');
      try {
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as ReturnType<typeof getDatabase>);
  vi.mocked(linkProjectFolder).mockImplementation((path) => ({
    id: 'semester-project',
    parentId: null,
    name: basename(String(path)),
    kind: 'project',
    sourceId: null,
    path: String(path),
    updatedAt: '2026-10-28T00:00:00.000Z',
  }));
  state = {
    connected: true,
    syncedAt: '2026-10-28T00:00:00.000Z',
    courses: [
      {
        id: 1,
        name: courseName,
        term: '2026-2027秋季学期',
        code: 'MATH1001',
        syncedAt: '2026-10-28T00:00:00.000Z',
        error: null,
      },
    ],
    items: [
      {
        id: '1:files',
        parentId: null,
        courseId: 1,
        name: '文件',
        kind: 'folder',
        sourceId: null,
      },
    ],
  };
  sources = new Map();
  downloads = new Map();
  vi.mocked(getCanvasState).mockImplementation(() => state);
  vi.mocked(syncCanvasCourses).mockImplementation(async () => state);
  vi.mocked(syncCanvasCourse).mockImplementation(async () => state);
  vi.mocked(syncCanvasAssignment).mockImplementation(async (_courseId, id) =>
    sources.get(`assignment:${id}`)!,
  );
  vi.mocked(getSource).mockImplementation((id) => {
    const source = sources.get(id);
    if (!source) throw new Error(`未设置测试资料 ${id}`);
    return source;
  });
  vi.mocked(cachedFile).mockImplementation(async (source) => {
    const key = `${source.id}:${source.updatedAt}`;
    const body = downloads.get(key);
    if (body === undefined) throw new Error(`未设置测试下载 ${key}`);
    const path = join(temporary, 'cache', key.replaceAll(':', '_'));
    if (!existsSync(path)) localFile(path, body);
    return { path, mime: source.mime || 'application/octet-stream' };
  });
  vi.mocked(getCanvasQuizzes).mockResolvedValue([]);
  vi.mocked(getCanvasAttachment).mockImplementation(async (courseId, fileId) => {
    const source = sources.get(`file:${fileId}`);
    if (!source || source.courseId !== courseId) throw new Error('未设置测试附件');
    return source;
  });
});

afterEach(() => {
  db.close();
  rmSync(temporary, { recursive: true, force: true });
});

describe('Canvas 本地课程目录同步', () => {
  it('原地登记学期项目，只接管内容相同的现有课件并保持 mtime', async () => {
    const source = putFile('第1讲.pdf', '原始课件');
    const existing = localFile(join(courseDirectory, '课件', source.title), '原始课件');
    const note = localFile(join(courseDirectory, '学习笔记', '第1讲.md'), '自己的学习笔记');
    const before = statSync(existing).mtimeMs;

    const configured = configureLocalCanvasSync(root, [1]);
    expect(configured).toMatchObject({ root, projectId: 'semester-project', courseIds: [1] });
    expect(getLocalCanvasSyncState()).toEqual(configured);
    expect(linkProjectFolder).toHaveBeenCalledWith(root);
    const result = await syncLocalCanvas();

    expect(result).toMatchObject({ adopted: 1, updated: 0, conflicts: [], failed: [] });
    expect(statSync(existing).mtimeMs).toBe(before);
    expect(readFileSync(note, 'utf8')).toBe('自己的学习笔记');
    expect(await boundCanvasFile(source)).toEqual({ path: existing, mime: source.mime });
    expect(getLocalCanvasSyncState()?.lastResult).toEqual(result);
  });

  it('依据历史 manifest 接管改名后的扁平课件，不重建远端目录树', async () => {
    const source = putFile('第1讲.pdf', '原始课件');
    state.items.push({
      id: 'folder:11',
      parentId: '1:files',
      courseId: 1,
      name: '第1周',
      kind: 'folder',
      sourceId: null,
    });
    state.items.find((item) => item.sourceId === source.id)!.parentId = 'folder:11';
    const existing = localFile(join(courseDirectory, '课件', '01-概率空间.pdf'), '原始课件');
    localFile(
      join(root, '.canvas-1-files.json'),
      JSON.stringify([
        {
          name: source.title,
          local_path: existing,
          url: 'https://oc.sjtu.edu.cn/courses/1/files/10/download',
        },
      ]),
    );
    configureLocalCanvasSync(root, [1]);

    const result = await syncLocalCanvas();

    expect(result).toMatchObject({ adopted: 1, updated: 0, conflicts: [], failed: [] });
    expect(await boundCanvasFile(source)).toEqual({ path: existing, mime: source.mime });
    expect(statSync(existing).mtimeMs).toBe(originalTime.getTime());
    expect(existsSync(join(courseDirectory, '课件', '第1周'))).toBe(false);
    expect(existsSync(join(courseDirectory, '课件', source.title))).toBe(false);
  });

  it('没有 manifest 时只接管课件子目录中名称、大小及 hash 全部匹配的文件', async () => {
    const source = putFile('第1讲.pdf', '课程资料');
    state.items.push({
      id: 'folder:11',
      parentId: '1:files',
      courseId: 1,
      name: '第1周',
      kind: 'folder',
      sourceId: null,
    });
    state.items.find((item) => item.sourceId === source.id)!.parentId = 'folder:11';
    const edited = localFile(join(courseDirectory, '课件', '其他材料', source.title), '个人批注');
    const existing = localFile(join(courseDirectory, '课件', '自选目录', source.title), '课程资料');
    expect(statSync(edited).size).toBe(statSync(existing).size);
    configureLocalCanvasSync(root, [1]);

    const result = await syncLocalCanvas();

    expect(result).toMatchObject({ adopted: 1, conflicts: [], failed: [] });
    expect(await boundCanvasFile(source)).toEqual({ path: existing, mime: source.mime });
    expect(statSync(existing).mtimeMs).toBe(originalTime.getTime());
    expect(readFileSync(edited, 'utf8')).toBe('个人批注');
    expect(statSync(edited).mtimeMs).toBe(originalTime.getTime());
    expect(existsSync(join(courseDirectory, '课件', '第1周'))).toBe(false);
  });

  it('历史 manifest 不能把其他课程的文件认领到本课程', async () => {
    const source = putFile('第1讲.pdf', '原始课件');
    const otherFile = localFile(join(root, '其他课程', '课件', source.title), '原始课件');
    localFile(
      join(root, '.canvas-1-files.json'),
      JSON.stringify([{ name: source.title, local_path: relative(root, otherFile) }]),
    );
    configureLocalCanvasSync(root, [1]);

    const result = await syncLocalCanvas();

    expect(result.adopted).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toContain('对应课程');
    expect(cachedFile).not.toHaveBeenCalled();
    expect(await boundCanvasFile(source)).toBeNull();
    expect(readFileSync(otherFile, 'utf8')).toBe('原始课件');
    expect(statSync(otherFile).mtimeMs).toBe(originalTime.getTime());
    expect(existsSync(join(courseDirectory, '课件', source.title))).toBe(false);
  });

  it('相同远端重复同步时全部已有文件保持内容和 mtime', async () => {
    putFile('第1讲.pdf', '课件内容');
    configureLocalCanvasSync(root, [1]);
    await syncLocalCanvas();
    for (const path of Object.keys(snapshot()))
      utimesSync(join(root, path), originalTime, originalTime);
    const before = snapshot();

    const result = await syncLocalCanvas();

    expect(result).toMatchObject({ added: 0, updated: 0, adopted: 0, conflicts: [], failed: [] });
    expect(snapshot()).toEqual(before);
  });

  it('远端新增和更新只更新已绑定课件，保留用户成果', async () => {
    const source = putFile('第1讲.pdf', '第一版');
    const existing = localFile(join(courseDirectory, '课件', source.title), '第一版');
    const work = localFile(join(courseDirectory, '作业', '自己的解答.md'), '我的解答');
    configureLocalCanvasSync(root, [1]);
    await syncLocalCanvas();
    const originalWork = snapshot()[relative(root, work)];
    source.updatedAt = '2026-10-27T00:00:00.000Z';
    downloads.set(`${source.id}:${source.updatedAt}`, '第二版');
    const addition = putFile('第2讲.pdf', '新增课件', 11);

    const result = await syncLocalCanvas();

    expect(result).toMatchObject({ added: 1, updated: 1, conflicts: [], failed: [] });
    expect(readFileSync(existing, 'utf8')).toBe('第二版');
    expect(await boundCanvasFile(addition)).toMatchObject({ mime: addition.mime });
    expect(snapshot()[relative(root, work)]).toEqual(originalWork);
  });

  it('本地修改与远端更新冲突时保留本地内容，并只保存一份远端版本', async () => {
    const source = putFile('第1讲.pdf', '第一版');
    const existing = localFile(join(courseDirectory, '课件', source.title), '第一版');
    configureLocalCanvasSync(root, [1]);
    await syncLocalCanvas();
    localFile(existing, '加了自己的批注');
    source.updatedAt = '2026-10-27T00:00:00.000Z';
    downloads.set(`${source.id}:${source.updatedAt}`, '远端第二版');

    const result = await syncLocalCanvas();

    expect(result.failed).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    const incoming = result.conflicts[0]!.incomingPath!;
    expect(incoming).toBeTruthy();
    expect(readFileSync(existing, 'utf8')).toBe('加了自己的批注');
    expect(readFileSync(incoming, 'utf8')).toBe('远端第二版');
    expect(await boundCanvasFile(source)).toEqual({ path: incoming, mime: source.mime });
    const before = snapshot();
    await syncLocalCanvas();
    expect(snapshot()).toEqual(before);
  });

  it('下载远端新版期间出现本地编辑时，保存用户内容并将新版另存', async () => {
    const source = putFile('第1讲.pdf', '第一版');
    const existing = localFile(join(courseDirectory, '课件', source.title), '第一版');
    configureLocalCanvasSync(root, [1]);
    await syncLocalCanvas();
    source.updatedAt = '2026-10-27T00:00:00.000Z';
    downloads.set(`${source.id}:${source.updatedAt}`, '远端第二版');
    const download = vi.mocked(cachedFile).getMockImplementation()!;
    vi.mocked(cachedFile).mockImplementationOnce(async (requested) => {
      localFile(existing, '下载期间新增的用户批注');
      return download(requested);
    });

    const result = await syncLocalCanvas();

    expect(result).toMatchObject({ updated: 0, failed: [] });
    expect(result.conflicts).toHaveLength(1);
    expect(readFileSync(existing, 'utf8')).toBe('下载期间新增的用户批注');
    const incoming = result.conflicts[0]!.incomingPath!;
    expect(readFileSync(incoming, 'utf8')).toBe('远端第二版');
    expect(await boundCanvasFile(source)).toEqual({ path: incoming, mime: source.mime });
  });

  it('首次遇到同名但内容不同的本地文件时，不将其认作 Canvas 原件', async () => {
    const source = putFile('第1讲.pdf', 'Canvas 原始课件');
    const existing = localFile(join(courseDirectory, '课件', source.title), '自己整理过的课件');
    configureLocalCanvasSync(root, [1]);

    const result = await syncLocalCanvas();

    expect(result.adopted).toBe(0);
    expect(result.conflicts).toHaveLength(1);
    expect(readFileSync(existing, 'utf8')).toBe('自己整理过的课件');
    const incoming = result.conflicts[0]!.incomingPath!;
    expect(readFileSync(incoming, 'utf8')).toBe('Canvas 原始课件');
    expect(await boundCanvasFile(source)).toEqual({ path: incoming, mime: source.mime });
    expect(result.failed).toEqual([]);
  });

  it('远端版本未变时，本地编辑仍通过内容摘要识别并保留', async () => {
    const source = putFile('第1讲.pdf', 'Canvas 原始课件');
    const existing = localFile(join(courseDirectory, '课件', source.title), 'Canvas 原始课件');
    configureLocalCanvasSync(root, [1]);
    await syncLocalCanvas();
    localFile(existing, '自己的批注');
    vi.mocked(cachedFile).mockClear();

    const result = await syncLocalCanvas();

    expect(readFileSync(existing, 'utf8')).toBe('自己的批注');
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.incomingPath).toBeUndefined();
    expect(cachedFile).not.toHaveBeenCalled();
    expect(await boundCanvasFile(source)).toBeNull();
  });

  it('相同大小文件修改后即使恢复 mtime，也不会复用过期的 hash 缓存', async () => {
    const source = putFile('第1讲.pdf', '原始课件');
    const existing = localFile(join(courseDirectory, '课件', source.title), '原始课件');
    configureLocalCanvasSync(root, [1]);
    await syncLocalCanvas();
    expect(await boundCanvasFile(source)).toEqual({ path: existing, mime: source.mime });
    const original = statSync(existing);

    localFile(existing, '本地批注');

    expect(statSync(existing).size).toBe(original.size);
    expect(statSync(existing).mtimeMs).toBe(original.mtimeMs);
    expect(await boundCanvasFile(source)).toBeNull();
    const result = await syncLocalCanvas();
    expect(result.conflicts).toHaveLength(1);
    expect(readFileSync(existing, 'utf8')).toBe('本地批注');
  });

  it('无法证明远端二进制版本时报告失败并保留已有资料', async () => {
    const source = putFile('第1讲.pdf', '远端内容');
    source.updatedAt = null;
    const existing = localFile(join(courseDirectory, '课件', source.title), '本地原有内容');
    configureLocalCanvasSync(root, [1]);

    const result = await syncLocalCanvas();

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toContain('更新时间');
    expect(cachedFile).not.toHaveBeenCalled();
    expect(readFileSync(existing, 'utf8')).toBe('本地原有内容');
    expect(statSync(existing).mtimeMs).toBe(originalTime.getTime());
    expect(await boundCanvasFile(source)).toBeNull();
  });

  it('用户在课程内改名后仍识别原文件，远端更新沿用本地命名', async () => {
    const source = putFile('第1讲.pdf', '第一版');
    const existing = localFile(join(courseDirectory, '课件', source.title), '第一版');
    configureLocalCanvasSync(root, [1]);
    await syncLocalCanvas();
    const renamed = join(courseDirectory, '课件', '01-概率空间.pdf');
    renameSync(existing, renamed);
    const mtime = statSync(renamed).mtimeMs;

    await syncLocalCanvas();

    expect(statSync(renamed).mtimeMs).toBe(mtime);
    expect(existsSync(existing)).toBe(false);
    expect(await boundCanvasFile(source)).toEqual({ path: renamed, mime: source.mime });
    source.updatedAt = '2026-10-27T00:00:00.000Z';
    downloads.set(`${source.id}:${source.updatedAt}`, '第二版');
    const result = await syncLocalCanvas();
    expect(result).toMatchObject({ updated: 1, conflicts: [], failed: [] });
    expect(readFileSync(renamed, 'utf8')).toBe('第二版');
    expect(existsSync(existing)).toBe(false);
  });

  it('课程目录中的符号链接不能使新资料写到所选根目录外', async () => {
    putFile('第1讲.pdf', '课件内容');
    const outside = join(temporary, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(courseDirectory, '课件'), 'dir');
    configureLocalCanvasSync(root, [1]);

    const result = await syncLocalCanvas();

    expect(readdirSync(outside)).toEqual([]);
    expect(result.failed.length + result.conflicts.length).toBeGreaterThan(0);
  });

  it('拒绝把课程目录映射到根目录以外', () => {
    localFile(
      join(root, '.canvas-layout.json'),
      JSON.stringify({ course_directories: { 1: '../outside' } }),
    );

    expect(() => configureLocalCanvasSync(root, [1])).toThrow('本地 Canvas 路径');
    expect(linkProjectFolder).not.toHaveBeenCalled();
    expect(getLocalCanvasSyncState()).toBeNull();
    expect(existsSync(join(temporary, 'outside'))).toBe(false);
  });

  it('归档作业说明及题目附件，忽略外站链接和自己的提交文件', async () => {
    const attachment = putFile('作业题目.pdf', '老师提供的题目', 29);
    const submission = putFile('我的提交.pdf', '自己的答案', 30);
    state.items = state.items.filter(
      (item) => item.sourceId !== attachment.id && item.sourceId !== submission.id,
    );
    const assignment = putAssignment(
      9,
      '第1次作业',
      '<p>完成概率空间证明。</p><a href="/courses/1/files/29/download?download_frd=1">题目</a><a href="https://example.org/files/88">外站</a>',
    );
    const submitted: SourceItem = {
      id: 'assignment:9:submission/file:30',
      parentId: 'assignment:9:submission',
      courseId: 1,
      name: submission.title,
      kind: 'file',
      sourceId: submission.id,
    };
    state.items.push(submitted);
    configureLocalCanvasSync(root, [1]);

    const result = await syncLocalCanvas();

    const directory = join(courseDirectory, '作业', `${courseName}-${assignment.title}`);
    const html = readFileSync(join(directory, 'Canvas作业说明.html'), 'utf8');
    expect(html).toContain('完成概率空间证明');
    expect(html).toContain(assignment.dueAt);
    expect(html).toContain('2026-11-01 23:59（北京时间）');
    expect(html).toContain(assignment.url);
    expect(readFileSync(join(directory, attachment.title), 'utf8')).toBe('老师提供的题目');
    expect(getCanvasAttachment).toHaveBeenCalledExactlyOnceWith(1, 29);
    expect(vi.mocked(cachedFile).mock.calls.map(([source]) => source.id)).toEqual([attachment.id]);
    expect(result).toMatchObject({ conflicts: [], failed: [] });
    expect(await boundCanvasFile(attachment)).toEqual({
      path: join(directory, attachment.title),
      mime: attachment.mime,
    });
  });

  it('沿用现有大作业分类，并把测验内容和 DDL 汇总在测试目录及根目录', async () => {
    const assignment = putAssignment(9, '期末大作业', '<p>完成课程项目。</p>');
    const taskDirectory = join(courseDirectory, '大作业', `${courseName}-${assignment.title}`);
    const answer = localFile(join(taskDirectory, '自己的报告.md'), '用户报告');
    localFile(
      join(root, '.canvas-layout.json'),
      JSON.stringify({
        course_directories: { 1: courseName },
        assignment_categories: { [relative(root, taskDirectory)]: '大作业' },
      }),
    );
    vi.mocked(getCanvasQuizzes).mockResolvedValue([
      {
        id: 3,
        title: '期中测试',
        description: '<p>覆盖第1至第5章，闭卷。</p>',
        dueAt: '2026-11-12T10:00:00.000Z',
        url: 'https://oc.sjtu.edu.cn/courses/1/quizzes/3',
        updatedAt: '2026-10-27T00:00:00.000Z',
      },
    ]);
    configureLocalCanvasSync(root, [1]);

    const result = await syncLocalCanvas();

    expect(existsSync(join(taskDirectory, 'Canvas作业说明.html'))).toBe(true);
    expect(readFileSync(answer, 'utf8')).toBe('用户报告');
    const quizDirectory = join(courseDirectory, '测试', `${courseName}-期中测试`);
    const quizHtml = readFileSync(join(quizDirectory, 'Canvas测试说明.html'), 'utf8');
    expect(quizHtml).toContain('覆盖第1至第5章');
    expect(quizHtml).toContain('2026-11-12T10:00:00.000Z');
    expect(quizHtml).toContain('2026-11-12 18:00（北京时间）');
    const overview = readFileSync(join(root, 'Canvas测试总览.md'), 'utf8');
    expect(overview).toContain(courseName);
    expect(overview).toContain('期中测试');
    expect(overview).toContain('2026-11-12 18:00（北京时间）');
    expect(overview).toContain('Canvas测试说明.html');
    expect(result).toMatchObject({ conflicts: [], failed: [] });
    for (const category of ['课件', '作业', '测试', '大作业', '学习笔记'])
      expect(statSync(join(courseDirectory, category)).isDirectory()).toBe(true);
  });

  it('本地课程上下文只出现在已绑定项目范围内，并给出真实目录和资料规则', () => {
    configureLocalCanvasSync(root, [1]);

    expect(localCourseContext(courseDirectory)).toContain(root);
    expect(localCourseContext(courseDirectory)).toContain('学习笔记');
    expect(localCourseContext(courseDirectory)).toContain('作业答案');
    expect(localCourseContext(root)).toContain(root);
    expect(localCourseContext(`${root}-other`)).toBeFalsy();
    expect(localCourseContext(join(temporary, 'other'))).toBeFalsy();
  });

  it('项目通过符号链接别名打开时仍提供对应真实目录的课程上下文', () => {
    configureLocalCanvasSync(root, [1]);
    const alias = join(temporary, 'semester-link');
    symlinkSync(root, alias, 'dir');

    expect(localCourseContext(alias)).toContain(root);
    expect(localCourseContext(join(alias, courseName))).toContain(courseName);
  });

  it('测试分支暂时不可用时保留说明及缓存 DDL，并在总览标明沿用快照', async () => {
    vi.mocked(getCanvasQuizzes).mockResolvedValue([
      {
        id: 3,
        title: '期中测试',
        description: '<p>覆盖第1至第5章。</p>',
        dueAt: '2026-11-12T10:00:00.000Z',
        url: 'https://oc.sjtu.edu.cn/courses/1/quizzes/3',
      },
    ]);
    configureLocalCanvasSync(root, [1]);
    await syncLocalCanvas();
    const descriptionPath = join(
      courseName,
      '测试',
      `${courseName}-期中测试`,
      'Canvas测试说明.html',
    );
    const before = snapshot()[descriptionPath];
    vi.mocked(getCanvasQuizzes).mockRejectedValue(new Error('暂时离线'));

    const result = await syncLocalCanvas();

    expect(result.failed).toContain(`${courseName}/测试：暂时离线`);
    expect(snapshot()[descriptionPath]).toEqual(before);
    const overview = readFileSync(join(root, 'Canvas测试总览.md'), 'utf8');
    expect(overview).toContain('期中测试');
    expect(overview).toContain('2026-11-12 18:00（北京时间）');
    expect(overview).toContain('本次未能核对测试，沿用上次核对成功的记录');
    const stale = snapshot();
    await syncLocalCanvas();
    expect(snapshot()).toEqual(stale);
  });

  it('一门课程测试失败时沿用其快照，同时更新其他课程的新 DDL', async () => {
    const otherCourse = '数值分析';
    state.courses.push({ ...state.courses[0]!, id: 2, name: otherCourse, code: 'MATH2001' });
    const a = quiz(1, '概率测试', '2026-11-01T16:30:00.000Z');
    const b = quiz(2, '数值测试', '2026-11-03T10:00:00.000Z');
    vi.mocked(getCanvasQuizzes).mockImplementation(async (id) => [id === 1 ? a : b]);
    configureLocalCanvasSync(root, [1, 2]);
    await syncLocalCanvas();
    const bDescription = join(
      otherCourse,
      '测试',
      `${otherCourse}-${b.title}`,
      'Canvas测试说明.html',
    );
    const originalB = snapshot()[bDescription];
    a.dueAt = '2026-11-04T16:30:00.000Z';
    vi.mocked(getCanvasQuizzes).mockImplementation(async (id) => {
      if (id === 2) throw new Error('Canvas HTTP 404');
      return [a];
    });

    const result = await syncLocalCanvas();

    expect(result.failed).toContain(`${otherCourse}/测试：Canvas HTTP 404`);
    const overview = readFileSync(join(root, 'Canvas测试总览.md'), 'utf8');
    expect(overview).toContain('概率测试');
    expect(overview).toContain('2026-11-05 00:30（北京时间）');
    expect(overview).not.toContain('2026-11-02 00:30（北京时间）');
    expect(overview).toContain('数值测试');
    expect(overview).toContain('2026-11-03 18:00（北京时间）');
    expect(overview).toContain('本次未能核对测试，沿用上次核对成功的记录');
    expect(snapshot()[bDescription]).toEqual(originalB);
    const aHtml = readFileSync(
      join(courseDirectory, '测试', `${courseName}-${a.title}`, 'Canvas测试说明.html'),
      'utf8',
    );
    expect(aHtml).toContain('2026-11-05 00:30（北京时间）');
  });

  it('首次无法核对某门课程测试时明确标为未知，并保留其他课程已核对内容', async () => {
    const otherCourse = '数值分析';
    state.courses.push({ ...state.courses[0]!, id: 2, name: otherCourse, code: 'MATH2001' });
    const a = quiz(1, '概率测试', '2026-11-01T16:30:00.000Z');
    vi.mocked(getCanvasQuizzes).mockImplementation(async (id) => {
      if (id === 2) throw new Error('Canvas HTTP 404');
      return [a];
    });
    configureLocalCanvasSync(root, [1, 2]);

    const result = await syncLocalCanvas();

    expect(result.failed).toContain(`${otherCourse}/测试：Canvas HTTP 404`);
    const overview = readFileSync(join(root, 'Canvas测试总览.md'), 'utf8');
    expect(overview).toContain('概率测试');
    expect(overview).toContain('2026-11-02 00:30（北京时间）');
    expect(overview).toContain(otherCourse);
    expect(overview).toContain('本次未能核对测试，尚无上次成功记录，测试安排未知');
    expect(overview).not.toContain('沿用上次核对成功的记录');
  });

  it('跨 UTC 日期的 DDL 在 HTML 和总览中显示北京时间，HTML 保留原始时间身份', async () => {
    const test = quiz(1, '跨日测试', '2026-11-12T18:00:00.000Z');
    vi.mocked(getCanvasQuizzes).mockResolvedValue([test]);
    configureLocalCanvasSync(root, [1]);

    await syncLocalCanvas();

    const html = readFileSync(
      join(courseDirectory, '测试', `${courseName}-${test.title}`, 'Canvas测试说明.html'),
      'utf8',
    );
    expect(html).toContain(
      '<time datetime="2026-11-12T18:00:00.000Z">2026-11-13 02:00（北京时间）</time>',
    );
    const overview = readFileSync(join(root, 'Canvas测试总览.md'), 'utf8');
    expect(overview).toContain('2026-11-13 02:00（北京时间）');
    expect(overview).not.toContain('2026-11-12T18:00:00.000Z');
  });

  it('课件下载失败和课程文件错误不把成功核对的测试安排标为未知', async () => {
    putFile('未发布课件.pdf', '未发布内容');
    state.courses[0]!.error = '文件：Canvas HTTP 401：未发布';
    vi.mocked(cachedFile).mockRejectedValue(new Error('Canvas HTTP 401：未发布'));
    const test = quiz(1, '已发布测试', '2026-11-12T18:00:00.000Z');
    vi.mocked(getCanvasQuizzes).mockResolvedValue([test]);
    configureLocalCanvasSync(root, [1]);

    const result = await syncLocalCanvas();

    expect(result.failed.some((error) => error.includes('401'))).toBe(true);
    const overview = readFileSync(join(root, 'Canvas测试总览.md'), 'utf8');
    expect(overview).toContain(test.title);
    expect(overview).toContain('2026-11-13 02:00（北京时间）');
    expect(overview).not.toContain('未能核对测试');
    expect(overview).not.toContain('测试安排未知');
  });

  it('测试说明保存失败时沿用该课程最后一次成功的 DDL 快照', async () => {
    const test = quiz(1, '期中测试', '2026-11-12T18:00:00.000Z');
    vi.mocked(getCanvasQuizzes).mockResolvedValue([test]);
    configureLocalCanvasSync(root, [1]);
    await syncLocalCanvas();
    const descriptionPath = join(
      courseDirectory,
      '测试',
      `${courseName}-${test.title}`,
      'Canvas测试说明.html',
    );
    const outside = localFile(join(temporary, 'outside.html'), '用户保留的内容');
    rmSync(descriptionPath);
    symlinkSync(outside, descriptionPath);
    test.dueAt = '2026-11-15T18:00:00.000Z';

    const result = await syncLocalCanvas();

    expect(result.failed.some((error) => error.includes('符号链接'))).toBe(true);
    const overview = readFileSync(join(root, 'Canvas测试总览.md'), 'utf8');
    expect(overview).toContain('2026-11-13 02:00（北京时间）');
    expect(overview).not.toContain('2026-11-16 02:00（北京时间）');
    expect(overview).toContain('本次未能核对测试，沿用上次核对成功的记录');
    expect(readFileSync(outside, 'utf8')).toBe('用户保留的内容');
  });

  it('同一课程在另一个本地根目录中不会沿用其他根目录的测试快照', async () => {
    const test = quiz(1, '第一学期专属测试', '2026-11-12T18:00:00.000Z');
    vi.mocked(getCanvasQuizzes).mockResolvedValue([test]);
    configureLocalCanvasSync(root, [1]);
    await syncLocalCanvas();
    const previousOverview = readFileSync(join(root, 'Canvas测试总览.md'), 'utf8');
    const otherRoot = join(temporary, '另一学期');
    mkdirSync(otherRoot);
    configureLocalCanvasSync(otherRoot, [1]);
    vi.mocked(getCanvasQuizzes).mockRejectedValue(new Error('Canvas HTTP 404'));

    await syncLocalCanvas();

    const overview = readFileSync(join(otherRoot, 'Canvas测试总览.md'), 'utf8');
    expect(overview).toContain('本次未能核对测试，尚无上次成功记录，测试安排未知');
    expect(overview).not.toContain(test.title);
    expect(overview).not.toContain('2026-11-13 02:00（北京时间）');
    expect(readFileSync(join(root, 'Canvas测试总览.md'), 'utf8')).toBe(previousOverview);
  });
});

describe('精准同步范围', () => {
  it('只更新指定作业原题和附件，保留其他课程、答案及总览，不推进全量时间', async () => {
    state.courses.push({ ...state.courses[0]!, id: 2, name: '其他课程' });
    configureLocalCanvasSync(root, [1, 2]);
    putAssignment(71, '第一次作业', '<p>题目 <a href="/courses/1/files/90/download">附件</a></p>');
    putAssignment(72, '第二次作业', '<p>其他题目</p>');
    putFile('附件.pdf', '题目附件', 90);
    putFile('课件.pdf', '无关课件', 91);
    const answer = localFile(
      join(courseDirectory, '作业', `${courseName}-第一次作业`, '我的答案.md'),
      '保留用户答案',
    );
    const overview = localFile(join(root, 'Canvas测试总览.md'), '原有全量总览');
    const other = localFile(join(root, '其他课程', '课件', '资料.txt'), '其他课程原件');
    const result = await syncLocalCanvas({ courseId: 1, assignmentIds: [71] });
    expect(result).toMatchObject({
      added: 2,
      failed: [],
      scope: { courseIds: [1], assignmentIds: [71], completeLibrary: false },
    });
    expect(syncCanvasAssignment).toHaveBeenCalledExactlyOnceWith(1, 71);
    expect(syncCanvasCourses).not.toHaveBeenCalled();
    expect(syncCanvasCourse).not.toHaveBeenCalled();
    expect(getCanvasQuizzes).not.toHaveBeenCalled();
    expect(cachedFile).toHaveBeenCalledTimes(1);
    expect(readFileSync(answer, 'utf8')).toBe('保留用户答案');
    expect(readFileSync(overview, 'utf8')).toBe('原有全量总览');
    expect(readFileSync(other, 'utf8')).toBe('其他课程原件');
    expect(getLocalCanvasSyncState()?.syncedAt).toBeNull();
    expect(existsSync(join(courseDirectory, '作业', `${courseName}-第二次作业`))).toBe(false);
    expect(
      readFileSync(
        join(courseDirectory, '作业', `${courseName}-第一次作业`, 'Canvas作业说明.html'),
        'utf8',
      ),
    ).toContain('题目');
  });
  it('指定课程不会刷新其他课程；单作业失败不沿用旧原题冒充成功', async () => {
    state.courses.push({ ...state.courses[0]!, id: 2, name: '其他课程' });
    configureLocalCanvasSync(root, [1, 2]);
    await syncLocalCanvas({ courseId: 1 });
    expect(syncCanvasCourse).toHaveBeenCalledExactlyOnceWith(1);
    expect(syncCanvasCourses).not.toHaveBeenCalled();
    expect(getLocalCanvasSyncState()?.syncedAt).toBeNull();
    putAssignment(71, '旧题', '<p>旧题</p>');
    vi.mocked(syncCanvasAssignment).mockRejectedValueOnce(new Error('未能获取当前原题'));
    const failed = await syncLocalCanvas({ courseId: 1, assignmentIds: [71] });
    expect(failed.failed).toEqual([`${courseName}/作业 71：未能获取当前原题`]);
    expect(failed.added).toBe(0);
    expect(existsSync(join(courseDirectory, '作业', `${courseName}-旧题`))).toBe(false);
  });
});
