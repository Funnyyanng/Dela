import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import { z } from 'zod';
import type { ContextNote } from '../../shared/context';
import { getDatabase } from '../database';
import { checkWorkspaceSender } from '../ipc';

const schema = z
  .object({
    id: z.string().uuid().optional(),
    scope: z.enum(['personal', 'course', 'project']),
    scopeId: z.string().max(512),
    title: z.string().trim().min(1).max(120),
    content: z.string().trim().min(1).max(6000),
  })
  .strict();

export function listContextNotes(): ContextNote[] {
  return (
    getDatabase()
      .prepare("SELECT value FROM workspace_settings WHERE key LIKE 'context-note:%' ORDER BY key")
      .all() as { value: string }[]
  ).map((row) => JSON.parse(row.value) as ContextNote);
}

export function saveContextNote(raw: unknown): ContextNote[] {
  const value = schema.parse(raw);
  if (value.scope === 'personal' && value.scopeId !== '') throw new Error('个人偏好不需要关联对象');
  if (value.scope !== 'personal' && !value.scopeId) throw new Error('请选择课程或项目');
  if (
    value.scope === 'project' &&
    !getDatabase()
      .prepare("SELECT id FROM workspace_entries WHERE id=? AND kind='project'")
      .get(value.scopeId)
  )
    throw new Error('这个项目已不存在，请重新选择');
  if (
    value.scope === 'course' &&
    !getDatabase().prepare('SELECT id FROM canvas_courses WHERE id=?').get(value.scopeId)
  )
    throw new Error('这个课程已不在当前资料中，请重新选择');
  const notes = listContextNotes();
  if (value.id && !notes.some((note) => note.id === value.id)) throw new Error('这条约定已不存在');
  const total = notes
    .filter(
      (note) =>
        note.scope === value.scope && note.scopeId === value.scopeId && note.id !== value.id,
    )
    .reduce((sum, note) => sum + note.content.length, value.content.length);
  if (total > 18000)
    throw new Error('这个范围的约定已较长，请合并或精简后保存；详细资料请保存在文件中');
  const note: ContextNote = {
    ...value,
    id: value.id ?? randomUUID(),
    updatedAt: new Date().toISOString(),
  };
  getDatabase()
    .prepare('INSERT OR REPLACE INTO workspace_settings(key,value) VALUES(?,?)')
    .run(`context-note:${note.id}`, JSON.stringify(note));
  return listContextNotes();
}

export function removeContextNote(raw: unknown): ContextNote[] {
  const id = z.string().uuid().parse(raw);
  getDatabase().prepare('DELETE FROM workspace_settings WHERE key=?').run(`context-note:${id}`);
  return listContextNotes();
}

export function contextFor(scope: {
  projectId?: string | null;
  courseId?: number;
  personal?: boolean;
}): string {
  const notes = listContextNotes().filter(
    (note) =>
      (scope.personal !== false && note.scope === 'personal') ||
      (scope.projectId && note.scope === 'project' && note.scopeId === scope.projectId) ||
      (scope.courseId && note.scope === 'course' && note.scopeId === String(scope.courseId)),
  );
  return notes.length
    ? `用户保存的偏好与约定（只适用于当前范围，用户本次要求优先）：\n${notes.map((note) => `### ${note.title}\n${note.content}`).join('\n\n')}`
    : '';
}

export function registerContextIpc(invalidate: () => void): void {
  ipcMain.handle('context:list', (event) => {
    checkWorkspaceSender(event);
    return listContextNotes();
  });
  ipcMain.handle('context:save', (event, raw: unknown) => {
    checkWorkspaceSender(event);
    const result = saveContextNote(raw);
    invalidate();
    return result;
  });
  ipcMain.handle('context:remove', (event, id: unknown) => {
    checkWorkspaceSender(event);
    const result = removeContextNote(id);
    invalidate();
    return result;
  });
}
