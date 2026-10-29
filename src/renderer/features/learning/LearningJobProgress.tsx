import { Button } from '../../components/ui/button';
import { ChatMarkdown } from '../../content/chat/markdown';
import { useNavigationStore } from '../../navigation/view';
import { useSessions } from '../../sessions/store';
import { stopLearningJob, useLearningJobs, type LearningJob } from './learning-jobs';

const labels = {
  queued: '等待处理',
  running: '正在处理',
  completed: '本轮处理结束',
  failed: '未能完成',
  stopped: '已停止',
};
const actions = {
  assignment: '完成作业',
  notes: '整理笔记',
  review: '检查答案',
  study: '学习辅导',
};

function Job({ job, compact }: { job: LearningJob; compact: boolean }) {
  const chat = useSessions((state) => (job.sessionId ? state.chats[job.sessionId] : undefined));
  const latest = chat?.messages.findLast((message) => message.role === 'assistant');
  const running = job.status === 'running';
  const result = job.result || latest?.content;
  const active = running || job.status === 'queued';
  return (
    <article className="min-w-0 rounded-control bg-inset p-3 text-xs">
      <p className="break-words font-medium">
        {actions[job.action]} · {job.title}
      </p>
      <p role="status" className="mt-1 text-ink-3">
        {labels[job.status]} · {job.courseName}
        {running && chat?.activeTool ? ' · 正在读取或核验资料' : ''}
      </p>
      {job.error && (
        <p role="alert" className="mt-2 break-words text-red">
          {job.error}
        </p>
      )}
      {running && result && (
        <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-ink-2">{result}</p>
      )}
      {!active && result && (
        <details className="mt-2" open={!compact}>
          <summary className="cursor-pointer text-ink-2">查看处理结果</summary>
          <div className="mt-2 max-h-80 overflow-auto break-words">
            <ChatMarkdown>{result}</ChatMarkdown>
          </div>
        </details>
      )}
      {job.files.length > 0 && (
        <div className="mt-2 flex flex-col items-start gap-1">
          {job.files.map((file) => (
            <Button
              key={file.path}
              variant="link"
              size="sm"
              className="h-auto max-w-full whitespace-normal break-words text-left"
              onClick={() => {
                const navigation = useNavigationStore.getState();
                if (navigation.openProject(job.projectId))
                  navigation.openDocument(file.path, { keep: true });
              }}
            >
              打开：{file.title}
            </Button>
          ))}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1">
        {active && (
          <Button size="sm" variant="outline" onClick={() => stopLearningJob(job.id)}>
            {running ? '停止处理' : '取消排队'}
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
    </article>
  );
}

export function LearningJobProgress({
  projectId,
  courseId,
  compact = false,
}: {
  projectId?: string;
  courseId?: number;
  compact?: boolean;
}) {
  const jobs = useLearningJobs((state) => state.jobs);
  const matching = jobs.filter(
    (job) =>
      (!projectId || job.projectId === projectId) &&
      (courseId === undefined || job.courseId === courseId),
  );
  if (!matching.length) return null;
  return (
    <section aria-label="学习任务进度" className="mt-3 space-y-2">
      <p className="text-xs text-ink-3">处理进度 · 可以留在当前页面继续查看资料</p>
      {[...matching].reverse().map((job) => (
        <Job key={job.id} job={job} compact={compact} />
      ))}
    </section>
  );
}
