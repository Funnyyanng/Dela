import type { ContextUsageView } from './session';

export interface JobInput {
  domain: 'learning' | 'project';
  projectId: string;
  title: string;
  action: string;
  objectKey?: string;
  prompt?: string;
  courseId?: number;
  targetId?: string;
  sourceIds?: string[];
  paths?: string[];
  assignmentId?: number;
}
export type JobStatus =
  | 'queued'
  | 'running'
  | 'needs_input'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted'
  | 'skipped';
export interface ExecutionJob {
  id: string;
  domain: JobInput['domain'];
  projectId: string;
  courseId?: number;
  courseName?: string;
  title: string;
  action: string;
  status: JobStatus;
  stage: string;
  sessionId: string | null;
  result: string;
  error: string | null;
  question: string | null;
  files: { path: string; title: string }[];
  usage: ContextUsageView | null;
  sourceVersions: { sourceId: string; version: string }[];
  outputDirectory?: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
  order: number;
  awaitingResume: boolean;
}
export interface JobState {
  jobs: ExecutionJob[];
}
export interface JobsApi {
  getState(): Promise<JobState>;
  enqueue(input: JobInput): Promise<ExecutionJob>;
  cancel(id: string): Promise<JobState>;
  resume(id: string, response?: string): Promise<JobState>;
  reorder(ids: string[]): Promise<JobState>;
  onUpdate(listener: (state: JobState) => void): () => void;
}
