import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TodoState } from '../../../shared/todo';
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }] },
}));
vi.mock('../../database', () => ({ getDatabase: vi.fn() }));
vi.mock('../../campus', () => ({
  CampusAuthError: class extends Error {},
  campusRequest: vi.fn(),
  flushCampusSession: vi.fn(),
  getCampusSession: vi.fn(),
  openCampusLoginWindow: vi.fn(),
}));
vi.mock('../../todo', () => ({ getTodoState: vi.fn() }));
vi.mock('../../life', () => ({ getLifeState: vi.fn() }));
import { getDatabase } from '../../database';
import { getTodoState } from '../../todo';
import { getLifeState } from '../../life';
import {
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  querySchedule,
} from '../api';
import { queryScheduleTool } from '../../agent/domain/timetable/query-schedule';
let db: DatabaseSync;
const todo: TodoState = {
  connected: true,
  syncing: false,
  syncedAt: '2026-10-30T00:00:00Z',
  error: null,
  items: [
    {
      id: 'canvas:1',
      source: 'canvas',
      title: '公司金融作业',
      notes: '',
      dueAt: '2026-10-30T15:59:00.000Z',
      status: 'pending',
      createdAt: '2026-10-29T00:00:00Z',
      readAt: null,
    },
  ],
};
const range = {
  semester: '2026-2027-1',
  startAt: '2026-10-29T16:00:00.000Z',
  endAt: '2026-10-30T16:00:00.000Z',
};
beforeEach(() => {
  vi.clearAllMocks();
  db = new DatabaseSync(':memory:');
  vi.mocked(getDatabase).mockReturnValue(db as unknown as ReturnType<typeof getDatabase>);
  vi.mocked(getTodoState).mockReturnValue(todo);
  vi.mocked(getLifeState).mockReturnValue({
    startDate: '2026-10-30',
    endDate: '2026-10-30',
    habits: [],
    habitLogs: [],
    sleepLogs: [],
    occurrences: [],
  });
  db.exec(`CREATE TABLE timetable_sync(semester TEXT,last_synced_at TEXT,semester_start TEXT); INSERT INTO timetable_sync VALUES('2026-2027-1','2026-10-30T00:00:00Z','2026-09-14');
  CREATE TABLE timetable_lessons(id INTEGER,semester TEXT,course_code TEXT,course_name TEXT,class_name TEXT,teacher TEXT,campus TEXT,classroom TEXT,weekday INTEGER,start_period INTEGER,end_period INTEGER,periods_text TEXT,weeks_text TEXT,week_numbers TEXT,credits REAL,note TEXT);
  INSERT INTO timetable_lessons VALUES(1,'2026-2027-1','FIN','公司金融学',NULL,NULL,NULL,'东上院',5,1,2,'1-2','1-16','[7]',NULL,NULL);
  CREATE TABLE calendar_events(id INTEGER PRIMARY KEY,title TEXT,start_at TEXT,end_at TEXT,location TEXT,color TEXT,created_at TEXT);`);
});
afterEach(() => db.close());
it('UI and AI read the same classes, events and true point-in-time deadlines', () => {
  createCalendarEvent({
    title: '小组讨论',
    startAt: '2026-10-30T06:00:00.000Z',
    endAt: '2026-10-30T07:00:00.000Z',
  });
  const state = querySchedule(range);
  expect(state.items.map((item) => item.source)).toEqual(['course', 'event', 'deadline']);
  const deadline = state.items.find((item) => item.source === 'deadline')!;
  expect(deadline.startAt).toBe(todo.items[0]!.dueAt);
  expect(deadline.endAt).toBe(deadline.startAt);
  const ai = queryScheduleTool.execute(range) as { items: unknown[] };
  expect(ai.items).toEqual(state.items);
});
it('moving and deleting a personal event never edits a Canvas deadline and broadcasts changes', () => {
  const event = createCalendarEvent({
    title: '讨论',
    startAt: '2026-10-30T06:00:00.000Z',
    endAt: '2026-10-30T07:00:00.000Z',
  });
  updateCalendarEvent(event.id, {
    title: '延期讨论',
    startAt: '2026-10-30T08:00:00.000Z',
    endAt: '2026-10-30T09:00:00.000Z',
  });
  expect(querySchedule(range).items.find((item) => item.source === 'deadline')?.startAt).toBe(
    '2026-10-30T15:59:00.000Z',
  );
  expect(querySchedule(range).items.find((item) => item.source === 'event')?.startAt).toBe(
    '2026-10-30T08:00:00.000Z',
  );
  expect(() =>
    updateCalendarEvent('todo:canvas:1', {
      title: '修改DDL',
      startAt: range.startAt,
      endAt: range.endAt,
    }),
  ).toThrow();
  deleteCalendarEvent(event.id);
  expect(querySchedule(range).items.filter((item) => item.source === 'event')).toEqual([]);
  expect(todo.items[0]!.dueAt).toBe('2026-10-30T15:59:00.000Z');
  expect(send).toHaveBeenCalledTimes(3);
  expect(send).toHaveBeenLastCalledWith('timetable:updated');
});

it('normalizes Shanghai ISO ranges used by Today to the same UTC schedule', () => {
  expect(
    querySchedule({
      semester: range.semester,
      startAt: '2026-10-30T00:00:00+08:00',
      endAt: '2026-10-31T00:00:00+08:00',
    }),
  ).toEqual(querySchedule(range));
});

it('treats recurring deadlines as points without changing event duration', () => {
  vi.mocked(getTodoState).mockReturnValue({
    ...todo,
    items: [
      ...todo.items,
      {
        id: 'repeat',
        source: 'personal',
        title: '阅读',
        notes: '',
        status: 'pending',
        dueAt: null,
        calendar: true,
        recurrence: { frequency: 'daily', startDate: '2026-10-30' },
        createdAt: 'now',
        readAt: null,
      },
    ],
  });
  vi.mocked(getLifeState).mockReturnValue({
    ...getLifeState(),
    occurrences: [
      {
        id: 'repeat:2026-10-29',
        todoId: 'repeat',
        date: '2026-10-29',
        title: '改期阅读',
        dueAt: '2026-10-30T12:00:00.000Z',
        remindAt: null,
        completed: false,
      },
    ],
  });
  const point = querySchedule(range).items.find((item) => item.todoId === 'repeat');
  expect(point).toMatchObject({
    startAt: '2026-10-30T12:00:00.000Z',
    endAt: '2026-10-30T12:00:00.000Z',
    deadline: true,
    source: 'deadline',
  });
});
