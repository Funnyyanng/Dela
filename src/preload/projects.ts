import type {
  ProjectsApi,
  ProjectSaveInput,
  ProjectAction,
  ProjectsState,
  ProjectSyncInput,
} from '../shared/projects';
import { invoke, on } from './lib';
export const projects = {
  getState: () => invoke('projects:get-state'),
  save: (input: ProjectSaveInput) => invoke('projects:save', input),
  prepareAction: (projectId: string, action: ProjectAction, taskId?: string) =>
    invoke('projects:prepare-action', projectId, action, taskId),
  gitReview: (projectId: string) => invoke('projects:git-review', projectId),
  sync: (input: ProjectSyncInput) => invoke('projects:sync', input),
  onUpdate: (listener: (state: ProjectsState) => void) =>
    on<ProjectsState>('projects:state', listener),
} satisfies ProjectsApi;
