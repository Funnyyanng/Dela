import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { useInitializeJobs, useJobs } from './store';
import { JobCard } from './JobCard';
import { errorText } from '../../workspace/store';
export function TaskCenterView({ requestId }: { requestId?: string | null }) {
  useInitializeJobs();
  const { jobs, loading, error, refresh } = useJobs();
  const [filter, setFilter] = useState('all');
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => {
    if (requestId) {
      setFilter('all');
      document.getElementById(`job-${requestId}`)?.scrollIntoView({ block: 'center' });
    }
  }, [requestId, jobs.length]);
  const filtered = jobs.filter(
    (job) =>
      filter === 'all' ||
      (filter === 'active'
        ? ['running', 'queued', 'needs_input', 'interrupted'].includes(job.status)
        : ['completed', 'failed', 'stopped', 'skipped'].includes(job.status)),
  );
  const queued = jobs.filter((job) => job.status === 'queued').sort((a, b) => a.order - b.order);
  const move = async (id: string, direction: number) => {
    const ids = queued.map((job) => job.id);
    const i = ids.indexOf(id),
      j = i + direction;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    try {
      await window.dela!.jobs.reorder(ids);
      setActionError(null);
    } catch (reason) {
      setActionError(errorText(reason));
    }
  };
  return (
    <div className="h-full overflow-auto bg-surface">
      <div className="mx-auto max-w-5xl space-y-5 px-8 py-7 max-md:px-4">
        <header className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">任务中心</h1>
            <p className="mt-2 text-13 text-ink-3">
              查看进度、补充信息和打开成果。关闭窗口后仍可继续处理。
            </p>
          </div>
          <Button variant="outline" onClick={() => void refresh()}>
            刷新
          </Button>
        </header>
        <div className="flex gap-2">
          {[
            ['all', '全部'],
            ['active', '进行中与待处理'],
            ['ended', '已结束'],
          ].map(([value, label]) => (
            <Button
              key={value}
              variant={filter === value ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter(value!)}
            >
              {label}
            </Button>
          ))}
        </div>
        {(error || actionError) && (
          <p role="alert" className="rounded-control bg-red-tint p-3 text-red">
            {error || actionError}
          </p>
        )}
        {loading && <p className="py-8 text-center text-ink-3">正在读取任务记录…</p>}
        {!loading && !filtered.length && (
          <p className="rounded-card border border-line p-8 text-center text-ink-3">
            暂无任务。在学习或项目页面选中对象，点击操作后会出现在这里。
          </p>
        )}
        {[...filtered]
          .sort((a, b) => {
            const activeA = ['queued', 'running', 'needs_input', 'interrupted'].includes(a.status),
              activeB = ['queued', 'running', 'needs_input', 'interrupted'].includes(b.status);
            return (
              Number(activeB) - Number(activeA) ||
              (activeA ? a.order - b.order : b.updatedAt - a.updatedAt)
            );
          })
          .map((job) => (
            <div
              key={job.id}
              className={job.id === requestId ? 'rounded-card ring-2 ring-bui-accent' : ''}
            >
              <JobCard job={job} />
              {job.status === 'queued' && queued.length > 1 && (
                <div className="mt-1 flex justify-end gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={queued[0]?.id === job.id}
                    onClick={() => void move(job.id, -1)}
                  >
                    提前
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={queued.at(-1)?.id === job.id}
                    onClick={() => void move(job.id, 1)}
                  >
                    延后
                  </Button>
                </div>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
