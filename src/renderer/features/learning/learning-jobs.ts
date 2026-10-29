import { create } from 'zustand';
import type { LearningAction } from './learning-prompt';

export interface LearningJob {
  id: string;
  projectId: string;
  courseId: number;
  courseName: string;
  title: string;
  action: LearningAction;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'stopped';
  sessionId: string | null;
  error: string | null;
  result: string;
  files: { path: string; title: string }[];
  startedAt: number | null;
  finishedAt: number | null;
}

export const useLearningJobs = create<{
  jobs: LearningJob[];
  add: (job: LearningJob) => void;
  update: (id: string, patch: Partial<LearningJob>) => void;
}>((set) => ({
  jobs: [],
  add: (job) => set((state) => ({ jobs: [...state.jobs, job] })),
  update: (id, patch) =>
    set((state) => ({
      jobs: state.jobs.map((job) => (job.id === id ? { ...job, ...patch } : job)),
    })),
}));

export function stopLearningJob(id: string): void {
  const job = useLearningJobs.getState().jobs.find((item) => item.id === id);
  if (!job || (job.status !== 'queued' && job.status !== 'running')) return;
  useLearningJobs.getState().update(id, { status: 'stopped', finishedAt: Date.now() });
  if (job.sessionId) window.dela?.session.cancelRun(job.sessionId);
}
