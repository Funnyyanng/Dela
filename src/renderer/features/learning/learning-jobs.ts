export { useJobs as useLearningJobs } from '../jobs/store';
export type { ExecutionJob as LearningJob } from '../../../shared/jobs';
export function stopLearningJob(id: string): void {
  void window.dela?.jobs.cancel(id);
}
