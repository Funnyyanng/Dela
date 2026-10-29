import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '' }));
fixture.root = mkdtempSync(join(tmpdir(), 'dela-note-revisions-'));
vi.mock('electron', () => ({ app: { getPath: () => join(fixture.root, 'private') } }));
vi.mock('../canvas/local-sync', () => ({
  getLocalCanvasSyncState: () => ({ root: fixture.root, courses: [{ id: 1, directory: '金融' }] }),
}));
import { inspectLearningNote, updateLearningNote, restoreLearningNote } from './note-revisions';

const target = { courseId: 1, path: '学习笔记/第二章.md' };
const file = () => join(fixture.root, '金融', target.path);
beforeEach(() => {
  rmSync(join(fixture.root, '金融'), { recursive: true, force: true });
  rmSync(join(fixture.root, 'private'), { recursive: true, force: true });
  mkdirSync(join(fixture.root, '金融', '学习笔记'), { recursive: true });
  writeFileSync(file(), '\uFEFF# 第二章\r\n公式：旧式\r\n我的批注：这里还没懂\r\n');
});
afterAll(() => rmSync(fixture.root, { recursive: true, force: true }));

it('仅修改唯一段落，保留个人批注、BOM、换行，并允许撤回', () => {
  const before = readFileSync(file(), 'utf8');
  const original = inspectLearningNote(target);
  const saved = updateLearningNote({
    ...target,
    expectedRevision: original.revision,
    edits: [{ before: '公式：旧式\n', after: '公式：修订式\n' }],
    summary: '核对公式口径',
  });
  expect(readFileSync(file(), 'utf8')).toBe(before.replace('旧式', '修订式'));
  expect(inspectLearningNote(target).versions).toHaveLength(1);
  restoreLearningNote({ ...target, revision: original.revision, expectedRevision: saved.revision });
  expect(readFileSync(file(), 'utf8')).toBe(before);
});

it('用户期间修改或待改段落不唯一时保留原文', () => {
  const original = inspectLearningNote(target);
  writeFileSync(file(), '公式：旧式\n公式：旧式\n用户新批注');
  const current = readFileSync(file(), 'utf8');
  const update = {
    ...target,
    expectedRevision: original.revision,
    edits: [{ before: '公式：旧式', after: '公式：修订式' }],
    summary: '公式修订',
  };
  expect(() => updateLearningNote(update)).toThrow('笔记已变化');
  expect(() =>
    updateLearningNote({ ...update, expectedRevision: inspectLearningNote(target).revision }),
  ).toThrow('不唯一');
  expect(readFileSync(file(), 'utf8')).toBe(current);
});

it('所有段落通过校验后才写入，禁止整篇覆盖已有笔记或修改原始课件', () => {
  const original = inspectLearningNote(target);
  const before = readFileSync(file(), 'utf8');
  expect(() =>
    updateLearningNote({
      ...target,
      expectedRevision: original.revision,
      edits: [
        { before: '旧式', after: '新式' },
        { before: '不存在的段落', after: '内容' },
      ],
      summary: '更新',
    }),
  ).toThrow('不存在');
  expect(readFileSync(file(), 'utf8')).toBe(before);
  expect(() =>
    updateLearningNote({
      ...target,
      expectedRevision: original.revision,
      createText: '替换全文',
      summary: '更新',
    }),
  ).toThrow('不接受整篇覆盖');
  expect(() => inspectLearningNote({ courseId: 1, path: '课件/原课件.md' })).toThrow('学习笔记');
});

it('创建新笔记必须明确不存在，恢复时也检查用户的新修改', () => {
  const newTarget = { courseId: 1, path: '学习笔记/第三章.md' };
  const saved = updateLearningNote({
    ...newTarget,
    expectedRevision: null,
    createText: '# 第三章\n内容',
    summary: '创建章节',
  });
  expect(saved.undoAvailable).toBe(false);
  expect(() =>
    updateLearningNote({
      ...newTarget,
      expectedRevision: null,
      createText: '覆盖',
      summary: '创建',
    }),
  ).toThrow('笔记已变化');
  const original = inspectLearningNote(target);
  updateLearningNote({
    ...target,
    expectedRevision: original.revision,
    edits: [{ before: '旧式', after: '新式' }],
    summary: '更新',
  });
  writeFileSync(file(), '用户新写的内容');
  expect(() =>
    restoreLearningNote({
      ...target,
      expectedRevision: original.revision,
      revision: original.revision,
    }),
  ).toThrow('笔记已变化');
  expect(readFileSync(file(), 'utf8')).toBe('用户新写的内容');
});
