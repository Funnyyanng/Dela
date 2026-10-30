import type { JobInput, JobsApi, JobState } from '../shared/jobs';
import { invoke, on } from './lib';
export const jobs = {
  getState: () => invoke('jobs:get-state'),
  enqueue: (input: JobInput) => invoke('jobs:enqueue', input),
  cancel: (id: string) => invoke('jobs:cancel', id),
  resume: (id: string, response?: string) => invoke('jobs:resume', id, response),
  reorder: (ids: string[]) => invoke('jobs:reorder', ids),
  onUpdate: (listener: (state: JobState) => void) => on('jobs:state', listener),
} satisfies JobsApi;
