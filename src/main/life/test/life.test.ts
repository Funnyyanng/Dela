import { DatabaseSync } from 'node:sqlite';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
}));
vi.mock('../../database', () => ({ getDatabase: vi.fn() }));
vi.mock('../../todo', () => ({ getTodoState: vi.fn() }));
vi.mock('../../ipc', () => ({ checkWorkspaceSender: vi.fn() }));
import { getDatabase } from '../../database';
import { getTodoState } from '../../todo';
import {
  getLifeState,
  saveHabit,
  logHabit,
  saveSleep,
  saveOccurrence,
  dueLifeReminders,
  markLifeReminderNotified,
} from '..';
let db: DatabaseSync;
const todo = {
  id: '12345678-1234-4123-8123-123456789abc',
  source: 'personal' as const,
  title: '阅读',
  notes: '',
  status: 'pending' as const,
  dueAt: '2026-10-30T13:00:00.000Z',
  remindAt: '2026-10-30T12:00:00.000Z',
  createdAt: '2026-10-29T00:00:00Z',
  readAt: null,
  recurrence: { frequency: 'daily' as const, startDate: '2026-10-30' },
};
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  vi.mocked(getDatabase).mockReturnValue(db as unknown as ReturnType<typeof getDatabase>);
  vi.mocked(getTodoState).mockReturnValue({
    items: [todo],
    connected: false,
    syncedAt: null,
    syncing: false,
    error: null,
  });
});
afterEach(() => db.close());
it('retains unknown habit dates and records actual zero distinctly', () => {
  const habit = saveHabit({ title: '阅读', kind: 'duration' });
  expect(getLifeState().habitLogs).toEqual([]);
  logHabit({ habitId: habit.id, date: '2026-10-30', value: 0 });
  const state = getLifeState({ startDate: '2026-10-29', endDate: '2026-10-31' });
  expect(state.habitLogs).toHaveLength(1);
  expect(state.habitLogs[0]?.value).toBe(0);
  expect(() => logHabit({ habitId: habit.id, date: '2026-02-30', value: 3 })).toThrow();
});
it('changes only the selected occurrence, retains master and following day', () => {
  saveOccurrence({
    todoId: todo.id,
    date: '2026-10-30',
    completed: true,
    title: '只改今天',
    dueAt: '2026-10-30T14:00:00.000Z',
  });
  const items = getLifeState({ startDate: '2026-10-30', endDate: '2026-10-31' }).occurrences;
  expect(items[0]).toMatchObject({ completed: true, title: '只改今天' });
  expect(items[1]).toMatchObject({
    completed: false,
    title: '阅读',
    dueAt: '2026-10-31T13:00:00.000Z',
  });
  expect(todo.title).toBe('阅读');
});
it('reminders are durable and not emitted twice', () => {
  const now = new Date('2026-10-30T12:30:00Z');
  const items = dueLifeReminders(now);
  expect(items).toHaveLength(1);
  markLifeReminderNotified(items[0]!.id);
  expect(dueLifeReminders(now)).toEqual([]);
});
it('sleep logs preserve real intervals and reject overlap', () => {
  expect(getLifeState().sleepLogs).toEqual([]);
  const log = saveSleep({ startAt: '2026-10-29T15:00:00Z', endAt: '2026-10-29T23:00:00Z' });
  expect(getLifeState({ startDate: '2026-10-30', endDate: '2026-10-30' }).sleepLogs[0]?.id).toBe(
    log.id,
  );
  expect(() =>
    saveSleep({ startAt: '2026-10-29T16:00:00Z', endAt: '2026-10-30T00:00:00Z' }),
  ).toThrow('重叠');
});
it('includes advance reminders before the repeating occurrence day', () => {
  vi.mocked(getTodoState).mockReturnValue({
    ...getTodoState(),
    items: [
      {
        ...todo,
        dueAt: '2026-10-31T13:00:00Z',
        remindAt: '2026-10-30T12:00:00Z',
        recurrence: { frequency: 'daily', startDate: '2026-10-31' },
      },
    ],
  });
  expect(dueLifeReminders(new Date('2026-10-30T12:30:00Z'))).toHaveLength(1);
});
it('preserves the recorded occurrence snapshot after the recurring title and rule change', () => {
  saveOccurrence({ todoId: todo.id, date: '2026-10-30', completed: true });
  vi.mocked(getTodoState).mockReturnValue({
    ...getTodoState(),
    items: [
      {
        ...todo,
        title: '新标题',
        recurrence: { frequency: 'weekly', startDate: '2026-11-01', weekdays: [1] },
      },
    ],
  });
  expect(
    getLifeState({ startDate: '2026-10-30', endDate: '2026-10-30' }).occurrences[0],
  ).toMatchObject({ title: '阅读', completed: true, dueAt: todo.dueAt });
});

it('summarizes reminders missed during a long shutdown instead of dropping the older month', () => {
  vi.mocked(getTodoState).mockReturnValue({
    ...getTodoState(),
    items: [
      { ...todo, recurrence: { frequency: 'monthly', startDate: '2026-08-30', monthDay: 30 } },
    ],
  });
  const reminders = dueLifeReminders(new Date('2026-10-30T12:30:00Z'));
  expect(reminders.map((item) => item.body)).toEqual(
    expect.arrayContaining([
      '重复事项 · 2026-08-30',
      '重复事项 · 2026-09-30',
      '重复事项 · 2026-10-30',
    ]),
  );
});
