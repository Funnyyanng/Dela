import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../database', () => ({ getDatabase: vi.fn() }));
vi.mock('../ipc', () => ({ checkWorkspaceSender: vi.fn() }));
import { getDatabase } from '../database';
import { contextFor, listContextNotes, removeContextNote, saveContextNote } from './index';
let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(
    "CREATE TABLE workspace_settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE workspace_entries(id TEXT,kind TEXT); CREATE TABLE canvas_courses(id INTEGER); INSERT INTO workspace_entries VALUES('p1','project'),('p2','project'); INSERT INTO canvas_courses VALUES(1),(2)",
  );
  vi.mocked(getDatabase).mockReturnValue(db as unknown as ReturnType<typeof getDatabase>);
});
afterEach(() => db.close());
it('injects only explicit personal and matching course/project preferences, stably', () => {
  saveContextNote({ scope: 'personal', scopeId: '', title: '语言', content: '中文解释' });
  saveContextNote({ scope: 'project', scopeId: 'p1', title: '规范', content: '保留原目录' });
  saveContextNote({ scope: 'course', scopeId: '2', title: '课程', content: '写出推导' });
  expect(contextFor({ projectId: 'p2', courseId: 1 })).toContain('中文解释');
  expect(contextFor({ projectId: 'p2', courseId: 1 })).not.toContain('保留原目录');
  expect(contextFor({ projectId: 'p1', courseId: 1 })).not.toContain('写出推导');
  expect(contextFor({ courseId: 2, personal: false })).toContain('写出推导');
  expect(contextFor({ courseId: 2, personal: false })).not.toContain('中文解释');
  expect(contextFor({ projectId: 'p1' })).toBe(contextFor({ projectId: 'p1' }));
});
it('edits and removes preferences without retaining a deleted fact', () => {
  const [note] = saveContextNote({
    scope: 'personal',
    scopeId: '',
    title: '偏好',
    content: '旧内容',
  });
  saveContextNote({
    id: note!.id,
    scope: 'personal',
    scopeId: '',
    title: '偏好',
    content: '新内容',
  });
  expect(contextFor({})).toContain('新内容');
  expect(contextFor({})).not.toContain('旧内容');
  removeContextNote(note!.id);
  expect(contextFor({})).toBe('');
  expect(db.prepare('SELECT value FROM workspace_settings').all()).toHaveLength(0);
});
it('rejects nonexistent scope and overlong context instead of silently truncating', () => {
  expect(() =>
    saveContextNote({ scope: 'project', scopeId: 'missing', title: 'test', content: 'data' }),
  ).toThrow('不存在');
  for (let i = 0; i < 3; i++)
    saveContextNote({
      scope: 'personal',
      scopeId: '',
      title: `条目${i}`,
      content: '字'.repeat(6000),
    });
  expect(() =>
    saveContextNote({ scope: 'personal', scopeId: '', title: '更多', content: '字' }),
  ).toThrow('精简');
  expect(listContextNotes()).toHaveLength(3);
});
