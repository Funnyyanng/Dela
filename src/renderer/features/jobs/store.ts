import { useEffect } from 'react';
import { create } from 'zustand';
import type { ExecutionJob, JobsApi } from '../../../shared/jobs';
import { errorText } from '../../workspace/store';
let receivedUpdates = 0;
export const useJobs = create<{
  jobs: ExecutionJob[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  add: (job: ExecutionJob) => void;
  update: (id: string, patch: Partial<ExecutionJob>) => void;
}>((set) => ({
  jobs: [],
  loading: true,
  error: null,
  refresh: async () => {
    if (!window.dela?.jobs) {
      set({ loading: false, error: '任务中心尚未加载，请重新打开 Dela。' });
      return;
    }
    try {
      const before = receivedUpdates;
      const state = await window.dela.jobs.getState();
      if (before === receivedUpdates) set({ ...state, loading: false, error: null });
    } catch (error) {
      set({ loading: false, error: errorText(error) });
    }
  },
  add: (job) => set((state) => ({ jobs: [...state.jobs, job] })),
  update: (id, patch) =>
    set((state) => ({
      jobs: state.jobs.map((job) => (job.id === id ? { ...job, ...patch } : job)),
    })),
}));
let currentApi: JobsApi | undefined;
let unsubscribe: (() => void) | undefined;
export function initializeJobsMirror() {
  const api = window.dela?.jobs;
  if (!api || currentApi === api) return;
  unsubscribe?.();
  currentApi = api;
  unsubscribe = api.onUpdate((state) => {
    receivedUpdates++;
    useJobs.setState({ ...state, loading: false, error: null });
  });
  void useJobs.getState().refresh();
}
export function useInitializeJobs() {
  useEffect(initializeJobsMirror, []);
}
