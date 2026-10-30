import { useJobs, useInitializeJobs } from '../jobs/store';
import { JobCard } from '../jobs/JobCard';
export function LearningJobProgress({
  projectId,
  courseId,
  compact = false,
  domain = 'learning',
}: {
  projectId?: string;
  courseId?: number;
  compact?: boolean;
  domain?: 'learning' | 'project';
}) {
  useInitializeJobs();
  const jobs = useJobs((state) => state.jobs);
  const matching = jobs.filter(
    (job) =>
      job.domain === domain &&
      (!projectId || job.projectId === projectId) &&
      (courseId === undefined || job.courseId === courseId),
  );
  if (!matching.length) return null;
  const active = matching.filter((job) =>
    ['running', 'queued', 'needs_input', 'interrupted'].includes(job.status),
  );
  const ended = matching
    .filter((job) => !active.includes(job))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, compact ? 1 : 3);
  return (
    <section
      aria-label={domain === 'learning' ? '学习任务进度' : '项目任务进度'}
      className="mt-3 space-y-2"
    >
      <p className="text-xs text-ink-3">处理进度 · 全部记录可在任务中心查看</p>
      {[...active, ...ended].map((job) => (
        <JobCard key={job.id} job={job} compact={compact} />
      ))}
    </section>
  );
}
