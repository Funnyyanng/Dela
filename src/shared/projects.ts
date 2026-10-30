import type { JobInput } from './jobs';

export type ProjectType = 'course' | 'research' | 'code' | 'internship';
export type ProjectAction = 'continue' | 'organize' | 'review' | 'summary';
export interface ProjectProfile {
  projectId: string;
  type: ProjectType;
  goal: string;
  successCriteria: string;
  stage: string;
  nextStep: string;
  conventions: string;
  milestones: { id: string; title: string; dueAt: string | null; completed: boolean }[];
  references: { id: string; title: string; path: string; kind: 'source' | 'deliverable' }[];
  syncPaths: string[];
  updatedAt: string | null;
}
export interface ProjectOverview extends ProjectProfile {
  name: string;
  directory: string | null;
  remote: boolean;
  warning?: string;
}
export interface ProjectsState {
  projects: ProjectOverview[];
}
export type ProjectSaveInput = Omit<ProjectProfile, 'updatedAt'> & {
  expectedUpdatedAt: string | null;
};
export interface ProjectGitReview {
  available: boolean;
  reason?: string;
  branch: string | null;
  remote: string | null;
  head: string | null;
  digest: string;
  changes: { path: string; status: string; allowed: boolean }[];
  diff: string;
  pendingCommits: string[];
}
export interface ProjectSyncInput {
  projectId: string;
  expectedHead: string;
  expectedDigest: string;
  message: string;
  paths: string[];
}
export interface ProjectsApi {
  getState(): Promise<ProjectsState>;
  save(input: ProjectSaveInput): Promise<ProjectsState>;
  prepareAction(projectId: string, action: ProjectAction, taskId?: string): Promise<JobInput>;
  gitReview(projectId: string): Promise<ProjectGitReview>;
  sync(input: ProjectSyncInput): Promise<ProjectGitReview>;
  onUpdate(listener: (state: ProjectsState) => void): () => void;
}
