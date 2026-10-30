import { BrowserWindow, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDatabase } from '../database';
import { checkWorkspaceSender } from '../ipc';
import { getTodoState } from '../todo';
import { addDays, shanghaiDate, todoOccurrences, recurrenceMatches } from '../../shared/life';
import type { Habit, HabitLog, LifeState, OccurrenceInput, SleepLog } from '../../shared/life';

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, '日期无效');
const id = z.string().uuid();
const habitInput = z
  .object({
    id: id.optional(),
    title: z.string().trim().min(1).max(120),
    kind: z.enum(['count', 'duration', 'number']),
    unit: z.string().trim().max(30).optional(),
    target: z.number().finite().nonnegative().nullable().optional(),
  })
  .strict();
export const habitLogSchema = z
  .object({
    habitId: id,
    date,
    value: z.number().finite().nonnegative(),
    note: z.string().max(2000).default(''),
  })
  .strict();
export const sleepLogSchema = z
  .object({
    id: id.optional(),
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
    note: z.string().max(2000).default(''),
  })
  .strict()
  .refine(
    (value) =>
      Date.parse(value.endAt) > Date.parse(value.startAt) &&
      Date.parse(value.endAt) - Date.parse(value.startAt) <= 48 * 3600000,
    '睡眠结束必须晚于开始，且时长不超过48小时',
  );
export const occurrenceSchema = z
  .object({
    todoId: id,
    date,
    title: z.string().trim().min(1).max(200).optional(),
    dueAt: z.string().datetime().optional(),
    remindAt: z.string().datetime().nullable().optional(),
    completed: z.boolean().optional(),
  })
  .strict();
const rangeInput = z.object({ startDate: date.optional(), endDate: date.optional() }).strict();

function db() {
  const database = getDatabase();
  database.exec(
    `CREATE TABLE IF NOT EXISTS life_records (kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS life_reminders (id TEXT PRIMARY KEY, notified_at TEXT NOT NULL);`,
  );
  return database;
}
function list<T>(kind: string): T[] {
  return (
    db().prepare('SELECT data FROM life_records WHERE kind=?').all(kind) as { data: string }[]
  ).map((row) => JSON.parse(row.data) as T);
}
function put(kind: string, key: string, value: unknown) {
  db()
    .prepare('INSERT OR REPLACE INTO life_records(kind,id,data) VALUES(?,?,?)')
    .run(kind, key, JSON.stringify(value));
}
function changed() {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('life:updated');
  }
}
export function getLifeState(raw: unknown = {}): LifeState {
  const range = rangeInput.parse(raw);
  const today = shanghaiDate();
  const startDate = range.startDate ?? addDays(today, -6);
  const endDate = range.endDate ?? addDays(today, 30);
  if (startDate > endDate || Date.parse(endDate) - Date.parse(startDate) > 366 * 86400000)
    throw new Error('查询范围必须为正数且不超过一年');
  return {
    startDate,
    endDate,
    habits: list<Habit>('habit'),
    habitLogs: list<HabitLog>('habit-log').filter(
      (log) => log.date >= startDate && log.date <= endDate,
    ),
    sleepLogs: list<SleepLog>('sleep').filter(
      (log) => shanghaiDate(log.endAt) >= startDate && shanghaiDate(log.startAt) <= endDate,
    ),
    occurrences: todoOccurrences(
      getTodoState().items,
      startDate,
      endDate,
      list<OccurrenceInput>('occurrence'),
    ),
  };
}
export function saveHabit(raw: unknown): Habit {
  const value = habitInput.parse(raw);
  const old = value.id ? list<Habit>('habit').find((habit) => habit.id === value.id) : undefined;
  if (value.id && !old) throw new Error('习惯不存在');
  const habit: Habit = {
    ...value,
    id: value.id ?? randomUUID(),
    unit: value.unit ?? (value.kind === 'duration' ? '分钟' : value.kind === 'count' ? '次' : ''),
    target: value.target ?? null,
    archived: old?.archived ?? false,
  };
  put('habit', habit.id, habit);
  changed();
  return habit;
}
export function archiveHabit(rawId: unknown, rawArchived: unknown) {
  const key = id.parse(rawId),
    archived = z.boolean().parse(rawArchived);
  const habit = list<Habit>('habit').find((item) => item.id === key);
  if (!habit) throw new Error('习惯不存在');
  put('habit', key, { ...habit, archived });
  changed();
}
export function logHabit(raw: unknown) {
  const value = habitLogSchema.parse(raw);
  const habit = list<Habit>('habit').find((item) => item.id === value.habitId);
  if (!habit) throw new Error('习惯不存在');
  if (habit.kind === 'count' && !Number.isInteger(value.value)) throw new Error('次数必须为整数');
  put('habit-log', `${value.habitId}:${value.date}`, value);
  changed();
}
export function removeHabitLog(habitId: unknown, day: unknown) {
  db()
    .prepare("DELETE FROM life_records WHERE kind='habit-log' AND id=?")
    .run(`${id.parse(habitId)}:${date.parse(day)}`);
  changed();
}
export function saveSleep(raw: unknown): SleepLog {
  const value = sleepLogSchema.parse(raw);
  if (value.id && !list<SleepLog>('sleep').some((item) => item.id === value.id))
    throw new Error('睡眠记录不存在');
  const overlap = list<SleepLog>('sleep').find(
    (item) =>
      item.id !== value.id &&
      Date.parse(item.startAt) < Date.parse(value.endAt) &&
      Date.parse(item.endAt) > Date.parse(value.startAt),
  );
  if (overlap) throw new Error('这段时间与已有睡眠记录重叠，请编辑原记录');
  const log = { ...value, id: value.id ?? randomUUID() };
  put('sleep', log.id, log);
  changed();
  return log;
}
export function removeSleep(raw: unknown) {
  db().prepare("DELETE FROM life_records WHERE kind='sleep' AND id=?").run(id.parse(raw));
  changed();
}
export function saveOccurrence(raw: unknown) {
  const value = occurrenceSchema.parse(raw);
  const todo = getTodoState().items.find(
    (item) => item.id === value.todoId && item.source === 'personal',
  );
  const key = `${value.todoId}:${value.date}`;
  const old = list<OccurrenceInput>('occurrence').find(
    (item) => item.todoId === value.todoId && item.date === value.date,
  );
  if (
    !todo?.recurrence ||
    (!old && (todo.archived || !recurrenceMatches(todo.recurrence, value.date)))
  )
    throw new Error('该日期不属于这个重复事项');
  const current = todoOccurrences([todo], value.date, value.date, old ? [old] : [])[0];
  put('occurrence', key, {
    title: current?.title,
    dueAt: current?.dueAt,
    remindAt: current?.remindAt,
    ...old,
    ...value,
  });
  changed();
}
export function dueLifeReminders(now = new Date()) {
  const notified = new Set(
    (db().prepare('SELECT id FROM life_reminders').all() as { id: string }[]).map(
      (item) => item.id,
    ),
  );
  const result: { id: string; title: string; body: string; todoId: string }[] = [];
  const todos = getTodoState().items;
  for (const item of todos) {
    if (
      item.source !== 'personal' ||
      item.recurrence ||
      item.archived ||
      item.status === 'completed' ||
      !item.remindAt ||
      Date.parse(item.remindAt) > now.getTime()
    )
      continue;
    const key = `todo:${item.id}:${item.remindAt}`;
    if (!notified.has(key))
      result.push({ id: key, title: item.title, body: '事项提醒', todoId: item.id });
  }
  const day = shanghaiDate(now);
  const advanceDays = Math.max(
    0,
    ...todos
      .filter((item) => item.recurrence && item.remindAt)
      .map((item) =>
        Math.ceil(
          (Date.parse(item.dueAt ?? `${item.recurrence!.startDate}T23:59:00+08:00`) -
            Date.parse(item.remindAt!)) /
            86400000,
        ),
      ),
  );
  const overrides = list<OccurrenceInput>('occurrence');
  const activeTodos = todos.filter((item) => !item.archived);
  const earliest =
    activeTodos
      .flatMap((item) => (item.recurrence && item.remindAt ? [item.recurrence.startDate] : []))
      .sort()[0] ?? day;
  const candidates = todoOccurrences(activeTodos, earliest, addDays(day, advanceDays), overrides);
  // 单次提醒可以提前到原日期窗口之外，仍应正常通知。
  for (const override of overrides) {
    if (override.remindAt && Date.parse(override.remindAt) <= now.getTime())
      candidates.push(
        ...todoOccurrences(
          activeTodos.filter((item) => item.id === override.todoId),
          override.date,
          override.date,
          [override],
        ),
      );
  }
  for (const item of new Map(candidates.map((item) => [item.id, item])).values()) {
    if (item.completed || !item.remindAt || Date.parse(item.remindAt) > now.getTime()) continue;
    const key = `occurrence:${item.id}:${item.remindAt}`;
    if (!notified.has(key))
      result.push({
        id: key,
        title: item.title,
        body: `重复事项 · ${item.date}`,
        todoId: item.todoId,
      });
  }
  return result;
}
export function markLifeReminderNotified(key: string) {
  db()
    .prepare('INSERT OR IGNORE INTO life_reminders(id,notified_at) VALUES(?,?)')
    .run(key, new Date().toISOString());
}
export function registerLifeIpc() {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    'get-state': getLifeState,
    'save-habit': saveHabit,
    'archive-habit': archiveHabit,
    'log-habit': logHabit,
    'remove-habit-log': removeHabitLog,
    'save-sleep': saveSleep,
    'remove-sleep': removeSleep,
    'save-occurrence': saveOccurrence,
  };
  for (const [name, handler] of Object.entries(handlers))
    ipcMain.handle(`life:${name}`, (event, ...args: unknown[]) => {
      checkWorkspaceSender(event);
      return handler(...args);
    });
}
