import type {
  HabitInput,
  HabitLog,
  LifeApi,
  LifeRange,
  OccurrenceInput,
  SleepLog,
} from '../shared/life';
import { invoke, on } from './lib';
export const life = {
  getState: (range?: LifeRange) => invoke('life:get-state', range),
  saveHabit: (input: HabitInput) => invoke('life:save-habit', input),
  archiveHabit: (id: string, archived: boolean) => invoke('life:archive-habit', id, archived),
  logHabit: (input: HabitLog) => invoke('life:log-habit', input),
  removeHabitLog: (id: string, date: string) => invoke('life:remove-habit-log', id, date),
  saveSleep: (input: Omit<SleepLog, 'id'> & { id?: string }) => invoke('life:save-sleep', input),
  removeSleep: (id: string) => invoke('life:remove-sleep', id),
  saveOccurrence: (input: OccurrenceInput) => invoke('life:save-occurrence', input),
  onUpdate: (listener: () => void) => on('life:updated', listener),
} satisfies LifeApi;
