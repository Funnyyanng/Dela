import { useState } from 'react';
import type { ExecutionJob } from '../../../shared/jobs';
import { Button } from '../../components/ui/button';
import { ChatMarkdown } from '../../content/chat/markdown';
import { useNavigationStore } from '../../navigation/view';
import { errorText } from '../../workspace/store';
export const jobLabels = {
  queued: '等待处理',
  running: '正在处理',
  needs_input: '需要你补充',
  completed: '本轮处理结束',
  failed: '未能完成',
  stopped: '已停止',
  interrupted: '处理中断',
  skipped: '已跳过',
};
export function JobCard({ job, compact = false }: { job: ExecutionJob; compact?: boolean }) {
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setAnswer('');
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  const active = ['queued', 'running'].includes(job.status);
  return (
    <article
      id={`job-${job.id}`}
      className="min-w-0 rounded-card border border-line bg-inset p-4 text-13"
    >
      <div className="flex flex-wrap justify-between gap-2">
        <h3 className="break-words font-medium">{job.title}</h3>
        <span role="status" className="text-xs text-ink-3">
          {jobLabels[job.status]}
          {job.awaitingResume ? ' · 等待你恢复' : ''}
        </span>
      </div>
      <p className="mt-1 text-xs text-ink-3">
        {job.courseName ?? (job.domain === 'project' ? '项目任务' : '学习任务')} · {job.stage}
      </p>
      {!compact && job.outputDirectory && (
        <p className="mt-1 break-all text-xs text-ink-3">成果保存在：{job.outputDirectory}</p>
      )}
      {job.error && <p className="mt-2 whitespace-pre-wrap text-red">{job.error}</p>}
      {error && (
        <p role="alert" className="mt-2 text-red">
          {error}
        </p>
      )}
      {job.question && (
        <div className="mt-3 rounded-control bg-surface p-3">
          <p className="whitespace-pre-wrap">{job.question}</p>
          {job.status === 'needs_input' && (
            <>
              <textarea
                aria-label={`补充信息：${job.title}`}
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                className="mt-2 min-h-20 w-full rounded-control bg-field p-2"
              />
              <Button
                size="sm"
                disabled={busy || !answer.trim()}
                onClick={() => void run(() => window.dela!.jobs.resume(job.id, answer))}
              >
                补充并继续
              </Button>
            </>
          )}
        </div>
      )}
      {job.result &&
        (active ? (
          <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-ink-2">{job.result}</p>
        ) : (
          <details className="mt-3" open={!compact && job.status === 'needs_input'}>
            <summary className="cursor-pointer">查看处理结果</summary>
            <div className="mt-2 max-h-80 overflow-auto break-words">
              <ChatMarkdown>{job.result}</ChatMarkdown>
            </div>
          </details>
        ))}
      {!!job.files.length && (
        <div className="mt-3 flex flex-wrap gap-2">
          {job.files.map((file) => (
            <Button
              key={file.path}
              size="sm"
              variant="outline"
              title={file.path}
              className="max-w-full truncate"
              onClick={() => {
                const nav = useNavigationStore.getState();
                if (nav.openProject(job.projectId)) nav.openDocument(file.path, { keep: true });
              }}
            >
              打开：{file.path.split(/[\\/]/).at(-1) || file.title}
            </Button>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {(active || job.status === 'needs_input') && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void run(() => window.dela!.jobs.cancel(job.id))}
          >
            {job.status === 'queued' ? '取消排队' : '停止处理'}
          </Button>
        )}
        {(job.awaitingResume || ['failed', 'stopped', 'interrupted'].includes(job.status)) && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void run(() => window.dela!.jobs.resume(job.id))}
          >
            检查进度并继续
          </Button>
        )}
        {job.sessionId && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => useNavigationStore.getState().openChat(job.sessionId!, job.projectId)}
          >
            {job.action === 'study' ? '继续学习与作答' : '查看过程'}
          </Button>
        )}
      </div>
      {!compact && (
        <details className="mt-3 text-xs text-ink-3">
          <summary className="cursor-pointer">用量与来源</summary>
          <p className="mt-2">
            输入：{job.usage?.inputTokens?.toLocaleString() ?? '未知'} · 输出：
            {job.usage?.outputTokens?.toLocaleString() ?? '未知'} · 缓存读取：
            {job.usage?.cachedTokens?.toLocaleString() ?? '未知'}
          </p>
          <p>
            创建于 {new Date(job.createdAt).toLocaleString('zh-CN')} · {job.sourceVersions.length}{' '}
            份已定位来源
          </p>
          <ul>
            {job.sourceVersions.map((source) => (
              <li key={source.sourceId}>
                {source.sourceId} · {source.version}
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}
