import type { LearningApi, PracticeAttemptInput } from '../shared/learning';
import { invoke } from './lib';

export const learning = {
  getState: () => invoke('learning:get-state'),
  submitPracticeAttempt: (input: PracticeAttemptInput) =>
    invoke('learning:submit-practice-attempt', input),
} satisfies LearningApi;
