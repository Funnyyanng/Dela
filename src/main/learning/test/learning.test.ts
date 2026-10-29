import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasLocalSyncState } from '../../../shared/canvas-local';
import type { StoredSource } from '../../canvas/api';

const fixture = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => fixture.userData } }));
vi.mock('../../database', () => ({ getDatabase: vi.fn() }));
vi.mock('../../canvas/local-sync', () => ({ getLocalCanvasSyncState: vi.fn() }));
vi.mock('../../canvas/api', () => ({ getSource: vi.fn() }));

import { getDatabase } from '../../database';
import { getLocalCanvasSyncState } from '../../canvas/local-sync';
import { getSource } from '../../canvas/api';
import { localCanvasSignature } from '../../canvas/local-bindings';
import * as localBindings from '../../canvas/local-bindings';
import {
  getLearningCourses,
  getLearningState,
  inspectLearningFiles,
  refreshLearningSources,
  registerLocalLearningSource,
  saveLearningNote,
  saveLearningPractice,
  saveLearningTask,
  submitLearningPracticeAttempt,
} from '../index';

let db: DatabaseSync;
let root: string;
let course: string;
let source: StoredSource;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dela-learning-')));
  fixture.userData = join(root, 'app-data');
  course = join(root, '课程');
  mkdirSync(join(course, '学习笔记'), { recursive: true });
  mkdirSync(join(course, '作业'), { recursive: true });
  mkdirSync(join(course, '课件'), { recursive: true });
  writeFileSync(join(course, '课件', '第一讲.pdf'), 'source');
  db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE workspace_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  vi.mocked(getDatabase).mockReturnValue(db as unknown as ReturnType<typeof getDatabase>);
  const state: CanvasLocalSyncState = {
    root,
    projectId: 'semester-project',
    courseIds: [1],
    courses: [{ id: 1, name: '课程', directory: '课程' }],
    syncedAt: null,
    lastResult: null,
  };
  vi.mocked(getLocalCanvasSyncState).mockReturnValue(state);
  source = { id: 'file:1', courseId: 1, title: '第一讲.pdf', kind: 'file', updatedAt: 'version-1' };
  vi.mocked(getSource).mockImplementation(() => source);
  db.prepare('INSERT INTO workspace_settings VALUES (?, ?)').run(
    `canvas-local-bindings:${root}`,
    JSON.stringify({
      one: {
        sourceId: source.id,
        version: 'version-1',
        path: '课程/课件/第一讲.pdf',
        hash: hash('source'),
        mime: 'application/pdf',
        scanRoot: '课程/课件',
        ino: 0,
        dev: 0,
        signature: localCanvasSignature(join(course, '课件', '第一讲.pdf')),
      },
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function taskInput() {
  const path = join(course, '作业', '答案.md');
  writeFileSync(path, 'answer');
  const [file] = await inspectLearningFiles({ courseId: 1, paths: [path] });
  return {
    courseId: 1,
    title: '习题一',
    status: 'checked' as const,
    requirements: [
      {
        id: 'r1',
        text: '给出完整推导',
        status: 'met' as const,
        deliverableIds: ['d1'],
        evidenceIds: ['e1'],
      },
    ],
    deliverables: [{ id: 'd1', path: file!.path, revision: file!.revision }],
    evidence: [
      {
        id: 'e1',
        path: file!.path,
        revision: file!.revision,
        description: '第 1 节，推导逐项核对通过',
      },
    ],
    findings: [] as { id: string; text: string; status: 'open' | 'closed' }[],
    checks: [
      { kind: 'requirements' as const, status: 'passed' as const, description: '所有题目逐条对应' },
      { kind: 'sources' as const, status: 'passed' as const, description: '与第一讲定义核对' },
      { kind: 'calculations' as const, status: 'passed' as const, description: '重新计算并代回' },
    ],
  };
}

describe('assignment review gates', () => {
  it('requires the reviewed assignment version and rejects background updates during long tasks', async () => {
    const input = { ...(await taskInput()), assignmentSourceId: 'file:1' };
    await expect(saveLearningTask(input)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const draft = await saveLearningTask({ ...input, status: 'draft' });
    expect(draft.assignmentSourceVersion).toBe('version-1');
    const key = `canvas-local-bindings:${root}`;
    const row = db.prepare('SELECT value FROM workspace_settings WHERE key=?').get(key) as {
      value: string;
    };
    const bindings = JSON.parse(row.value);
    bindings.one.version = 'version-2';
    source = { ...source, updatedAt: 'version-2' };
    db.prepare('UPDATE workspace_settings SET value=? WHERE key=?').run(
      JSON.stringify(bindings),
      key,
    );
    await expect(saveLearningTask({ ...input, id: draft.id })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    await expect(
      saveLearningTask({ ...input, id: draft.id, assignmentSourceVersion: 'version-1' }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const checked = await saveLearningTask({
      ...input,
      id: draft.id,
      assignmentSourceVersion: 'version-2',
    });
    expect(checked.status).toBe('checked');
    expect(checked.assignmentSourceVersion).toBe('version-2');
  });

  it('invalidates checked tasks when assignment sources update, conflict, disappear or change locally', async () => {
    const input = {
      ...(await taskInput()),
      assignmentSourceId: 'file:1',
      assignmentSourceVersion: 'version-1',
    };
    const task = await saveLearningTask(input);
    expect(task.assignmentSourceVersion).toBe('version-1');
    source = { ...source, updatedAt: 'version-2' };
    expect(getLearningState().tasks[0]!.status).toBe('draft');
    await expect(saveLearningTask({ ...input, id: task.id })).rejects.toThrow('作业来源已变化');
    source = { ...source, updatedAt: 'version-1' };
    const bindingRow = db
      .prepare('SELECT value FROM workspace_settings WHERE key=?')
      .get(`canvas-local-bindings:${root}`) as { value: string };
    const bindings = JSON.parse(bindingRow.value);
    bindings.one.version = 'version-2';
    source = { ...source, updatedAt: 'version-2' };
    db.prepare('UPDATE workspace_settings SET value=? WHERE key=?').run(
      JSON.stringify(bindings),
      `canvas-local-bindings:${root}`,
    );
    expect(getLearningState().tasks[0]!.status).toBe('draft');
    bindings.one.version = 'version-1';
    source = { ...source, updatedAt: 'version-1' };
    bindings.one.incoming = { version: 'new', path: bindings.one.path, hash: bindings.one.hash };
    db.prepare('UPDATE workspace_settings SET value=? WHERE key=?').run(
      JSON.stringify(bindings),
      `canvas-local-bindings:${root}`,
    );
    expect(getLearningState().tasks[0]!.status).toBe('draft');
    delete bindings.one.incoming;
    db.prepare('UPDATE workspace_settings SET value=? WHERE key=?').run(
      JSON.stringify(bindings),
      `canvas-local-bindings:${root}`,
    );
    writeFileSync(join(course, '课件', '第一讲.pdf'), 'locally changed source');
    expect(getLearningState().tasks[0]!.status).toBe('draft');
    await expect(saveLearningTask({ ...input, id: task.id })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    vi.mocked(getSource).mockImplementation(() => {
      throw new Error('removed');
    });
    expect(getLearningState().tasks[0]!.status).toBe('draft');
  });

  it('requires explicit review, mapped met requirements, closed findings and existing versioned evidence', async () => {
    const input = await taskInput();
    await expect(saveLearningTask({ ...input, checks: [] })).rejects.toThrow('尚未明确复核');
    await expect(
      saveLearningTask({ ...input, requirements: [{ ...input.requirements[0], status: 'open' }] }),
    ).rejects.toThrow('未满足');
    await expect(
      saveLearningTask({ ...input, requirements: [{ ...input.requirements[0], evidenceIds: [] }] }),
    ).rejects.toThrow('尚未关联');
    await expect(
      saveLearningTask({ ...input, findings: [{ id: 'f1', text: '漏掉条件', status: 'open' }] }),
    ).rejects.toThrow('未关闭');
    await expect(
      saveLearningTask({ ...input, evidence: [{ ...input.evidence[0], path: '作业/不存在.md' }] }),
    ).rejects.toThrow('文件不可用');
    await expect(
      saveLearningTask({ ...input, evidence: [{ ...input.evidence[0], description: '' }] }),
    ).rejects.toThrow('定位方式');
    const saved = await saveLearningTask(input);
    expect(saved.status).toBe('checked');
    expect(saved.warnings).toEqual([]);
  });

  it('downgrades stale checked files and refuses old SHA-256 without overwriting the saved record', async () => {
    const input = await taskInput();
    const saved = await saveLearningTask(input);
    writeFileSync(input.deliverables[0]!.path, 'changed answer');
    expect(getLearningState().tasks[0]).toMatchObject({ id: saved.id, status: 'draft' });
    await expect(saveLearningTask({ ...input, id: saved.id })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect(getLearningState().tasks[0]!.deliverables[0]!.revision).toBe(hash('answer'));
  });

  it('allows a concrete draft plan and rejects dangling evidence ids', async () => {
    const input = await taskInput();
    const draft = await saveLearningTask({
      ...input,
      status: 'draft',
      checks: [],
      deliverables: [{ id: 'd1', path: '作业/尚未完成.md' }],
      requirements: [{ ...input.requirements[0], status: 'open' }],
    });
    expect(draft.status).toBe('draft');
    expect(draft.warnings.length).toBeGreaterThan(0);
    await expect(
      saveLearningTask({
        ...input,
        requirements: [{ ...input.requirements[0], evidenceIds: ['missing'] }],
      }),
    ).rejects.toThrow('不存在的成果或证据');
  });

  it('accepts review evidence in the private work directory while final deliverables stay in the course', async () => {
    const input = await taskInput();
    const review = join(getLearningCourses()[0]!.workingDirectory, 'review.md');
    writeFileSync(review, '独立复核结果');
    const [file] = await inspectLearningFiles({ courseId: 1, paths: [review] });
    const evidence = [
      { id: 'e1', path: review, revision: file!.revision, description: '逐项复核记录第 1 节' },
    ];
    expect((await saveLearningTask({ ...input, evidence })).status).toBe('checked');
    await expect(
      saveLearningTask({
        ...input,
        deliverables: [{ id: 'd1', path: review, revision: file!.revision }],
      }),
    ).rejects.toThrow('课程目录');
  });
});

describe('canonical note coverage', () => {
  it('checks only registered legacy sources and refuses to bless local source edits', async () => {
    const key = `canvas-local-bindings:${root}`;
    const row = db.prepare('SELECT value FROM workspace_settings WHERE key=?').get(key) as {
      value: string;
    };
    const bindings = JSON.parse(row.value);
    delete bindings.one.signature;
    db.prepare('UPDATE workspace_settings SET value=? WHERE key=?').run(
      JSON.stringify(bindings),
      key,
    );
    const path = join(course, '学习笔记', '笔记.md');
    writeFileSync(path, 'notes');
    const input = {
      courseId: 1,
      title: '笔记',
      path,
      coveredSources: [{ sourceId: 'file:1', version: 'version-1' }],
    };
    expect(getLearningCourses()[0]!.sources[0]!.warning).toBeUndefined();
    expect(getLearningCourses()[0]!.sources[0]!.notice).toContain('正在核对');
    expect((await saveLearningNote(input)).warnings).toEqual([]);
    expect(getLearningCourses()[0]!.sources[0]!.warning).toBeUndefined();
    writeFileSync(join(course, '课件', '第一讲.pdf'), 'modified after registration');
    expect(getLearningCourses()[0]!.sources[0]!.warning).toContain('已变化');
    expect(getLearningState().notes[0]!.warnings.length).toBeGreaterThan(0);
    await expect(saveLearningNote(input)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('uses the full synchronized assignment version and retains provenance when Canvas cache is unavailable', () => {
    source = {
      ...source,
      id: 'assignment:1:10',
      title: '作业一',
      kind: 'assignment',
      updatedAt: '2026-10-29T00:00:00Z',
    };
    const version = `${source.updatedAt}:${hash('source')}`;
    db.prepare('UPDATE workspace_settings SET value=? WHERE key=?').run(
      JSON.stringify({
        one: {
          sourceId: source.id,
          version,
          path: '课程/课件/第一讲.pdf',
          hash: hash('source'),
          mime: 'text/html',
          scanRoot: '课程/课件',
          ino: 0,
          dev: 0,
          signature: localCanvasSignature(join(course, '课件', '第一讲.pdf')),
        },
      }),
      `canvas-local-bindings:${root}`,
    );
    expect(getLearningCourses()[0]!.sources[0]!.version).toBe(version);
    expect(getLearningCourses()[0]!.sources[0]!.warning).toBeUndefined();
    vi.mocked(getSource).mockImplementation(() => {
      throw new Error('removed');
    });
    expect(getLearningCourses()[0]!.sources[0]).toMatchObject({ sourceId: source.id, version });
    expect(getLearningCourses()[0]!.sources[0]!.warning).toBeUndefined();
    expect(getLearningCourses()[0]!.sources[0]!.notice).toContain('当前缓存未提供');
  });

  it('reuses canonical registration and warns when its source version changes', async () => {
    const path = join(course, '学习笔记', '第一讲.md');
    writeFileSync(path, '# 学习笔记\n');
    const input = {
      courseId: 1,
      title: '第一讲',
      path,
      coveredSources: [{ sourceId: 'file:1', version: 'version-1' }],
    };
    const first = await saveLearningNote(input);
    const next = await saveLearningNote(input);
    expect(next.id).toBe(first.id);
    expect(getLearningState().notes).toHaveLength(1);
    source = { ...source, updatedAt: 'version-2' };
    expect(
      getLearningState().notes[0]!.warnings.some((warning) => warning.includes('来源有变化')),
    ).toBe(true);
    await expect(saveLearningNote(input)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(getLearningState().practice).toEqual([]);
  });

  it('keeps original materials outside canonical note registration', async () => {
    await expect(
      saveLearningNote({
        courseId: 1,
        title: '来源',
        path: '课件/第一讲.pdf',
        coveredSources: [{ sourceId: 'file:1', version: 'version-1' }],
      }),
    ).rejects.toThrow('课程目录');
    const courseState = getLearningCourses()[0]!;
    expect(courseState.projectId).toBe('semester-project');
    expect(courseState.workingDirectory.startsWith(fixture.userData)).toBe(true);
    expect(courseState.sources[0]!.localPath).toBe(join(course, '课件', '第一讲.pdf'));
  });
});

describe('source provenance and incremental verification', () => {
  function changeBinding(
    change: (binding: ReturnType<typeof localBindings.readLocalCanvasBindings>[string]) => void,
  ) {
    const bindings = localBindings.readLocalCanvasBindings(root);
    change(bindings.one!);
    localBindings.saveLocalCanvasBindings(root, bindings);
  }

  it('repairs matching legacy download signatures automatically and skips unchanged files', async () => {
    changeBinding((binding) => {
      delete binding.signature;
    });
    const readHash = vi.spyOn(localBindings, 'localCanvasHash');
    await refreshLearningSources();
    expect(localBindings.readLocalCanvasBindings(root).one!.signature).toBe(
      localCanvasSignature(join(course, '课件', '第一讲.pdf')),
    );
    expect(getLearningCourses()[0]!.sources[0]).toMatchObject({
      origin: 'canvas',
      revision: hash('source'),
    });
    expect(getLearningCourses()[0]!.sources[0]!.warning).toBeUndefined();
    readHash.mockClear();
    await refreshLearningSources();
    expect(readHash).not.toHaveBeenCalled();
  });

  it('keeps true legacy content mismatches while healing metadata-only changes', async () => {
    const path = join(course, '课件', '第一讲.pdf');
    changeBinding((binding) => {
      delete binding.signature;
    });
    writeFileSync(path, 'modified');
    await refreshLearningSources();
    expect(getLearningCourses()[0]!.sources[0]!.warning).toContain('内容与 Canvas 下载记录不一致');
    expect(localBindings.readLocalCanvasBindings(root).one!.signature).toBeUndefined();
    writeFileSync(path, 'source');
    await refreshLearningSources();
    expect(getLearningCourses()[0]!.sources[0]!.warning).toBeUndefined();
    const later = new Date(Date.now() + 60_000);
    utimesSync(path, later, later);
    await refreshLearningSources();
    expect(getLearningCourses()[0]!.sources[0]!.warning).toBeUndefined();
    expect(localBindings.readLocalCanvasBindings(root).one!.signature).toBe(
      localCanvasSignature(path),
    );
  });

  it('retains upstream conflicts and missing files after baseline repair', async () => {
    changeBinding((binding) => {
      delete binding.signature;
      binding.incoming = { version: 'version-2', path: '课程/课件/待核对.pdf', hash: hash('new') };
    });
    writeFileSync(join(course, '课件', '待核对.pdf'), 'new');
    await refreshLearningSources();
    expect(getLearningCourses()[0]!.sources).toHaveLength(1);
    expect(getLearningCourses()[0]!.sources[0]!.warning).toContain('新版本');
    changeBinding((binding) => {
      delete binding.incoming;
    });
    source.updatedAt = 'version-2';
    expect(getLearningCourses()[0]!.sources[0]!.warning).toContain('新版本');
    source.updatedAt = 'version-1';
    rmSync(join(course, '课件', '第一讲.pdf'));
    await refreshLearningSources();
    expect(getLearningCourses()[0]!.sources[0]!.warning).toContain('缺失');
  });

  it('does not overwrite a newer sync binding when verification is still reading', async () => {
    changeBinding((binding) => {
      delete binding.signature;
    });
    const originalHash = localBindings.localCanvasHash;
    vi.spyOn(localBindings, 'localCanvasHash').mockImplementation(async (path) => {
      const value = await originalHash(path);
      changeBinding((binding) => {
        binding.version = 'version-2';
        binding.hash = hash('new source');
      });
      return value;
    });
    await refreshLearningSources();
    const updated = localBindings.readLocalCanvasBindings(root).one!;
    expect(updated.version).toBe('version-2');
    expect(updated.hash).toBe(hash('new source'));
    expect(updated.signature).toBeUndefined();
  });

  it('isolates unreadable files from other source verification', async () => {
    changeBinding((binding) => {
      delete binding.signature;
    });
    const originalHash = localBindings.localCanvasHash;
    vi.spyOn(localBindings, 'localCanvasHash').mockImplementation(async (path) => {
      if (path.endsWith('第一讲.pdf')) throw new Error('unreadable');
      return originalHash(path);
    });
    writeFileSync(join(course, '课件', '补充阅读.pdf'), 'extra');
    await refreshLearningSources();
    expect(getLearningCourses()[0]!.sources.some((item) => item.title === '补充阅读.pdf')).toBe(
      true,
    );
    expect(getLearningCourses()[0]!.sources[0]!.warning).toContain('无法读取');
  });

  it('discovers only reading materials and never guesses WeChat or AI provenance from names', async () => {
    for (const path of [
      '课件/微信下载.pdf',
      '课件/GPT说明.md',
      '学习笔记/用户笔记.md',
      '课件/.secret.md',
      '课件/资料清单.json',
      '课件/node_modules/pkg/index.js',
      '课件/dist/bundle.js',
    ]) {
      const target = join(course, path);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, 'content');
    }
    symlinkSync(join(course, '学习笔记'), join(course, '课件', '笔记链接'));
    await refreshLearningSources();
    const local = getLearningCourses()[0]!.sources.filter((item) =>
      item.sourceId.startsWith('local:'),
    );
    expect(local.map((item) => item.title).sort()).toEqual(['GPT说明.md', '微信下载.pdf']);
    expect(local.every((item) => item.origin === 'local')).toBe(true);
  });

  it('tracks stable local IDs and content versions without treating timestamp changes as new content', async () => {
    const path = join(course, '课件', '参考资料.pdf');
    writeFileSync(path, 'original');
    await refreshLearningSources();
    const first = getLearningCourses()[0]!.sources.find((item) => item.title === '参考资料.pdf')!;
    const later = new Date(Date.now() + 60_000);
    utimesSync(path, later, later);
    await refreshLearningSources();
    expect(
      getLearningCourses()[0]!.sources.find((item) => item.sourceId === first.sourceId)!.version,
    ).toBe(first.version);
    writeFileSync(path, 'updated');
    await refreshLearningSources();
    expect(
      getLearningCourses()[0]!.sources.find((item) => item.sourceId === first.sourceId)!.version,
    ).toBe(hash('updated'));
    rmSync(path);
    await refreshLearningSources();
    expect(
      getLearningCourses()[0]!.sources.find((item) => item.sourceId === first.sourceId)!.warning,
    ).toContain('缺失');
  });

  it('registers evidence-based local archives and WeChat attachments without fabricating Canvas bindings', async () => {
    const path = join(course, '大作业', '报告', '讲稿.md');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'actual lecture draft');
    const source = await registerLocalLearningSource({
      courseId: 1,
      path,
      origin: 'wechat',
      provenance: 'macOS 下载隔离记录应用为 WeChat',
    });
    expect(source.origin).toBe('wechat');
    expect(source.provenance).toContain('WeChat');
    await refreshLearningSources();
    expect(
      getLearningCourses()[0]!.sources.find((item) => item.sourceId === source.sourceId)!.origin,
    ).toBe('wechat');
    const archived = await registerLocalLearningSource({
      courseId: 1,
      path,
      origin: 'canvas',
      provenance: '下载清单明确记录来自 Canvas 压缩包的解压附件',
    });
    expect(archived.sourceId).toBe(source.sourceId);
    expect(archived.notice).toContain('本地归档');
    expect(Object.values(localBindings.readLocalCanvasBindings(root))).toHaveLength(1);
    await expect(
      registerLocalLearningSource({
        courseId: 1,
        path: '学习笔记/用户笔记.md',
        origin: 'local',
        provenance: '本地文件',
      }),
    ).rejects.toThrow('学习成果');
  });

  it('supports mixed Canvas and local note coverage and rejects stale local revisions', async () => {
    const path = join(course, '课件', '微信参考.pdf');
    writeFileSync(path, 'reference');
    const local = await registerLocalLearningSource({
      courseId: 1,
      path,
      origin: 'wechat',
      provenance: '用户明确提供的微信附件',
    });
    const notePath = join(course, '学习笔记', '综合笔记.md');
    writeFileSync(notePath, 'mixed notes');
    const input = {
      courseId: 1,
      title: '综合笔记',
      path: notePath,
      coveredSources: [
        { sourceId: 'file:1', version: 'version-1' },
        { sourceId: local.sourceId, version: local.version },
      ],
    };
    expect((await saveLearningNote(input)).warnings).toEqual([]);
    writeFileSync(path, 'changed reference');
    await expect(saveLearningNote(input)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await refreshLearningSources();
    expect(
      getLearningState().notes[0]!.warnings.some((warning) => warning.includes('微信参考')),
    ).toBe(true);
    await expect(saveLearningNote(input)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('excludes registered deliverables from automatic material discovery', async () => {
    const path = join(course, '课件', '成果.md');
    writeFileSync(path, 'result');
    await saveLearningTask({
      courseId: 1,
      title: 'draft',
      requirements: [{ id: 'r1', text: 'draft', status: 'open' }],
      deliverables: [{ id: 'd1', path }],
    });
    await refreshLearningSources();
    expect(getLearningCourses()[0]!.sources.some((item) => item.localPath === path)).toBe(false);
    await expect(
      registerLocalLearningSource({ courseId: 1, path, origin: 'local', provenance: '本地文件' }),
    ).rejects.toThrow('学习成果');
  });
});

describe('learner practice scheduling', () => {
  it('rejects a response recorded against an earlier question version even in the same millisecond', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T00:00:00Z'));
    const card = saveLearningPractice({
      courseId: 1,
      prompt: '旧题',
      answer: '旧答案',
      sourceIds: ['file:1'],
    });
    const changed = saveLearningPractice({
      id: card.id,
      courseId: 1,
      prompt: '新题',
      answer: '新答案',
      sourceIds: ['file:1'],
    });
    expect(changed.updatedAt).not.toBe(card.updatedAt);
    expect(() =>
      submitLearningPracticeAttempt({
        cardId: card.id,
        expectedUpdatedAt: card.updatedAt,
        response: '旧题答案',
        outcome: 'good',
      }),
    ).toThrow('练习题已更新');
    expect(getLearningState().practice[0]!.attempts).toEqual([]);
  });

  it('starts without attempts and schedules from real responses while keeping error causes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T00:00:00Z'));
    const card = saveLearningPractice({
      courseId: 1,
      prompt: '写出定义',
      answer: '参考答案',
      sourceIds: ['file:1'],
    });
    expect(card.attempts).toEqual([]);
    expect(card.successfulAttempts).toBe(0);
    expect(() =>
      submitLearningPracticeAttempt({ cardId: card.id, response: '  ', outcome: 'good' }),
    ).toThrow();
    const retry = submitLearningPracticeAttempt({
      cardId: card.id,
      response: '遗漏条件',
      outcome: 'again',
      errorCause: '忘记独立性假设',
    });
    expect(retry.dueAt).toBe('2026-10-29T00:10:00.000Z');
    expect(retry.attempts[0]!.errorCause).toBe('忘记独立性假设');
    const good = submitLearningPracticeAttempt({
      cardId: card.id,
      response: '完整定义',
      outcome: 'good',
    });
    expect(good.dueAt).toBe('2026-10-30T00:00:00.000Z');
    const second = submitLearningPracticeAttempt({
      cardId: card.id,
      response: '再次回忆',
      outcome: 'good',
    });
    expect(second.intervalDays).toBe(3);
    const changed = saveLearningPractice({
      id: card.id,
      courseId: 1,
      prompt: '新题面',
      answer: '新答案',
      sourceIds: ['file:1'],
    });
    expect(changed.successfulAttempts).toBe(0);
    expect(changed.intervalDays).toBe(0);
    expect(changed.attempts).toHaveLength(3);
  });
});
