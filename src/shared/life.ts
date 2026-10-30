import type { TodoItem } from './todo';

export interface Recurrence {
  frequency: 'daily' | 'weekly' | 'monthly';
  startDate: string;
  endDate?: string;
  weekdays?: number[];
  monthDay?: number;
}
export interface TodoOccurrence {
  id: string;
  todoId: string;
  date: string;
  title: string;
  dueAt: string;
  remindAt: string | null;
  completed: boolean;
}
export interface OccurrenceInput {
  todoId: string;
  date: string;
  title?: string;
  dueAt?: string;
  remindAt?: string | null;
  completed?: boolean;
}
export interface Habit {
  id: string;
  title: string;
  kind: 'count' | 'duration' | 'number';
  unit: string;
  target: number | null;
  archived: boolean;
}
export interface HabitInput {
  id?: string;
  title: string;
  kind: Habit['kind'];
  unit?: string;
  target?: number | null;
}
export interface HabitLog {
  habitId: string;
  date: string;
  value: number;
  note: string;
}
export interface SleepLog {
  id: string;
  startAt: string;
  endAt: string;
  note: string;
}
export interface LifeRange {
  startDate?: string;
  endDate?: string;
}
export interface LifeState {
  startDate: string;
  endDate: string;
  habits: Habit[];
  habitLogs: HabitLog[];
  sleepLogs: SleepLog[];
  occurrences: TodoOccurrence[];
}
export interface LifeApi {
  getState(range?: LifeRange): Promise<LifeState>;
  saveHabit(input: HabitInput): Promise<Habit>;
  archiveHabit(id: string, archived: boolean): Promise<void>;
  logHabit(input: HabitLog): Promise<void>;
  removeHabitLog(habitId: string, date: string): Promise<void>;
  saveSleep(input: Omit<SleepLog, 'id'> & { id?: string }): Promise<SleepLog>;
  removeSleep(id: string): Promise<void>;
  saveOccurrence(input: OccurrenceInput): Promise<void>;
  onUpdate(listener: () => void): () => void;
}
export function shanghaiDate(value: Date | string = new Date()): string {
  return new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
export function addDays(date: string, amount: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + amount * 86400000).toISOString().slice(0, 10);
}
export function recurrenceMatches(rule: Recurrence, date: string): boolean {
  if (date < rule.startDate || (rule.endDate && date > rule.endDate)) return false;
  if (rule.frequency === 'daily') return true;
  const day = new Date(`${date}T00:00:00Z`);
  if (rule.frequency === 'weekly') return (rule.weekdays ?? []).includes(day.getUTCDay() || 7);
  const last = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate();
  return day.getUTCDate() === Math.min(rule.monthDay ?? Number(rule.startDate.slice(-2)), last);
}
export function todoOccurrences(
  todos: TodoItem[],
  startDate: string,
  endDate: string,
  overrides: OccurrenceInput[] = [],
): TodoOccurrence[] {
  const saved = new Map(overrides.map((item) => [`${item.todoId}:${item.date}`, item]));
  const result: TodoOccurrence[] = [];
  for (const todo of todos) {
    if (todo.source !== 'personal' || !todo.recurrence) continue;
    const dates = new Set<string>();
    for (let date = startDate; date <= endDate; date = addDays(date, 1)) dates.add(date);
    // 改期后的实例仍保留原日期作为身份，同时能在新的截止日期查到。
    for (const override of overrides) {
      if (
        override.todoId === todo.id &&
        override.dueAt &&
        shanghaiDate(override.dueAt) >= startDate &&
        shanghaiDate(override.dueAt) <= endDate
      )
        dates.add(override.date);
    }
    for (const date of dates) {
      const override = saved.get(`${todo.id}:${date}`);
      if (
        todo.archived
          ? !override?.completed
          : !override && !recurrenceMatches(todo.recurrence, date)
      )
        continue;
      const time = todo.dueAt
        ? new Date(Date.parse(todo.dueAt) + 8 * 3600000).toISOString().slice(11, 19)
        : '23:59:00';
      const dueAt = new Date(`${date}T${time}+08:00`).toISOString();
      const baseDue = todo.dueAt ?? `${todo.recurrence.startDate}T23:59:00+08:00`;
      const offset = todo.remindAt ? Date.parse(todo.remindAt) - Date.parse(baseDue) : null;
      result.push({
        id: `${todo.id}:${date}`,
        todoId: todo.id,
        date,
        title: override?.title ?? todo.title,
        dueAt: override?.dueAt ?? dueAt,
        remindAt:
          override?.remindAt !== undefined
            ? override.remindAt
            : offset === null
              ? null
              : new Date(Date.parse(dueAt) + offset).toISOString(),
        completed: override?.completed ?? false,
      });
    }
  }
  return result.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

/** 近七天只统计实际日志；未记录日期不以零参与平均。 */
export function weeklyLifeReview(state: LifeState, endDate: string) {
  const startDate = addDays(endDate, -6);
  const inRange = (date: string) => date >= startDate && date <= endDate;
  const occurrences = state.occurrences.filter((item) => inRange(item.date));
  const sleepByDay = new Map<string, number>();
  for (const log of state.sleepLogs) {
    const day = shanghaiDate(log.endAt);
    if (inRange(day))
      sleepByDay.set(
        day,
        (sleepByDay.get(day) ?? 0) + (Date.parse(log.endAt) - Date.parse(log.startAt)) / 3600000,
      );
  }
  return {
    startDate,
    endDate,
    recurring: {
      scheduled: occurrences.length,
      completed: occurrences.filter((item) => item.completed).length,
    },
    habits: state.habits
      .filter(
        (habit) =>
          !habit.archived ||
          state.habitLogs.some((log) => log.habitId === habit.id && inRange(log.date)),
      )
      .map((habit) => {
        const logs = state.habitLogs.filter((log) => log.habitId === habit.id && inRange(log.date));
        return {
          habit,
          recordedDays: new Set(logs.map((log) => log.date)).size,
          unknownDays: 7 - new Set(logs.map((log) => log.date)).size,
          total: logs.reduce((sum, log) => sum + log.value, 0),
        };
      }),
    sleep: {
      recordedDays: sleepByDay.size,
      unknownDays: 7 - sleepByDay.size,
      averageHours: sleepByDay.size
        ? [...sleepByDay.values()].reduce((sum, value) => sum + value, 0) / sleepByDay.size
        : null,
    },
  };
}
