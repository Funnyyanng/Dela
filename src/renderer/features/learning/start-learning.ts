import type {
  LearningCourse,
  LearningNote,
  LearningState,
  LearningTask,
} from '../../../shared/learning';
import { workspacePathAffected } from '../../../shared/workspace';
import { useSessions } from '../../sessions/store';
import { useLearningJobs } from './learning-jobs';
import { learningPrompt, type LearningAction, type LearningSelection } from './learning-prompt';

export function resolveLearningSelection(
  state: LearningState,
  projectId: string,
  entry: { localPath?: string | null; sourceId?: string | null },
): { course: LearningCourse; selection: LearningSelection; target?: LearningTask } | null {
  const course = state.courses.find(
    (item) =>
      item.projectId === projectId &&
      ((entry.localPath && workspacePathAffected(entry.localPath, item.directory)) ||
        (entry.sourceId && item.sources.some((source) => source.sourceId === entry.sourceId))),
  );
  if (!course) return null;
  const sources = course.sources.filter((source) => {
    if (entry.sourceId && source.sourceId === entry.sourceId) return true;
    if (!source.localPath || !entry.localPath) return false;
    if (workspacePathAffected(source.localPath, entry.localPath)) return true;
    if (source.kind !== 'assignment') return false;
    const directory = source.localPath.replace(/[\\/][^\\/]+$/, '');
    return directory !== course.directory && workspacePathAffected(entry.localPath, directory);
  });
  const assignments = sources.filter((source) => source.kind === 'assignment');
  const targets = state.tasks.filter(
    (task) =>
      task.courseId === course.id &&
      ((assignments.length === 1 && task.assignmentSourceId === assignments[0]!.sourceId) ||
        (entry.localPath &&
          task.deliverables.some((file) => workspacePathAffected(file.path, entry.localPath!)))),
  );
  return {
    course,
    selection: { sources, paths: entry.localPath ? [entry.localPath] : [] },
    target: targets.length === 1 ? targets[0] : undefined,
  };
}

const starting = new Map<string, Promise<void>>();
let queue: Promise<void> = Promise.resolve();

export function startLearning(
  course: LearningCourse,
  action: LearningAction,
  target?: LearningTask | LearningNote,
  selection?: LearningSelection,
): Promise<void> {
  const assignmentSources =
    selection?.sources?.filter((source) => source.kind === 'assignment') ?? [];
  const assignmentSourceId = selection?.assignment?.assignmentId
    ? `assignment:${selection.assignment.assignmentId}`
    : assignmentSources.length === 1
      ? assignmentSources[0]!.sourceId
      : target && 'assignmentSourceId' in target
        ? target.assignmentSourceId
        : undefined;
  const identity =
    (action === 'assignment' || action === 'review') && assignmentSourceId
      ? assignmentSourceId
      : JSON.stringify({
          target: target?.id,
          sources: selection?.sources?.map((source) => source.sourceId).sort(),
          paths: selection?.paths?.slice().sort(),
        });
  const key = `${course.projectId}\0${course.id}\0${action}\0${identity}`;
  const pending = starting.get(key);
  if (pending) return pending;
  const id = crypto.randomUUID();
  const jobs = useLearningJobs.getState();
  jobs.add({
    id,
    projectId: course.projectId,
    courseId: course.id,
    courseName: course.name,
    title:
      selection?.assignment?.title ||
      target?.title ||
      selection?.sources?.map((source) => source.title).join('、') ||
      selection?.paths?.map((path) => path.split(/[\\/]/).at(-1)).join('、') ||
      course.name,
    action,
    status: 'queued',
    sessionId: null,
    error: null,
    result: '',
    files: [],
    startedAt: null,
    finishedAt: null,
  });
  const stopped = () =>
    useLearningJobs.getState().jobs.find((job) => job.id === id)?.status === 'stopped';
  const operation = queue
    .then(async () => {
      if (stopped()) return;
      jobs.update(id, { status: 'running', startedAt: Date.now() });
      const api = window.dela;
      if (!api) throw new Error('请在 Dela 桌面端开始学习。');
      let currentSelection = selection;
      if (action === 'assignment') {
        const assignmentId = Number(assignmentSourceId?.match(/^assignment:(\d+)$/)?.[1]);
        if (!assignmentId)
          throw new Error('请选择一份具体的 Canvas 未提交作业，可在学习中心查看全部课程的作业。');
        const todos = await api.todo.refresh();
        const coverage = todos.canvasCourses?.find((item) => item.id === course.id);
        if (
          !todos.connected ||
          (todos.canvasCourses
            ? !coverage || !coverage.syncedAt || coverage.error
            : todos.error || !todos.syncedAt)
        )
          throw new Error(
            coverage?.error || todos.error || '尚未核对这门课的提交状态，请先连接 Canvas 并刷新。',
          );
        const assignment = todos.items.find(
          (item) =>
            item.source === 'canvas' &&
            item.courseId === course.id &&
            item.assignmentId === assignmentId,
        );
        if (!assignment || !['pending', 'resubmit'].includes(assignment.status))
          throw new Error(
            '这份作业目前不是 Canvas 已确认的未提交作业，已停止处理。请刷新作业列表。',
          );
        currentSelection = { ...selection, assignment };
      }
      if (stopped()) return;
      const chat = await api.session.create(course.projectId, 'library');
      if (!chat.sessionId) throw new Error('未能创建学习任务，请重试。');
      if (!chat.configured) throw new Error('请先在设置中配置模型，再开始处理。');
      useSessions.getState().putChat(chat.sessionId, chat);
      jobs.update(id, { sessionId: chat.sessionId });
      if (stopped()) return;
      const run: { status: 'completed' | 'failed' | 'stopped' } = { status: 'completed' };
      const unsubscribe = api.session.onRunEvent((event) => {
        if (
          event.sessionId === chat.sessionId &&
          ['completed', 'failed', 'stopped', 'interrupted'].includes(event.status)
        )
          run.status =
            event.status === 'completed'
              ? 'completed'
              : event.status === 'failed'
                ? 'failed'
                : 'stopped';
      });
      try {
        const next = await api.session.ask(chat.sessionId, {
          text: learningPrompt(course, action, target, currentSelection),
          attachments: [],
          context: [],
        });
        useSessions.getState().putChat(chat.sessionId, next);
        const reply = next.messages.findLast((message) => message.role === 'assistant');
        if (run.status === 'failed') throw new Error(reply?.content || '模型处理失败，请重试。');
        const status =
          stopped() || run.status === 'stopped' || reply?.stopped || reply?.interrupted
            ? 'stopped'
            : 'completed';
        jobs.update(id, { status, result: reply?.content ?? '', finishedAt: Date.now() });
        if (status === 'completed') {
          try {
            const state = await api.learning.getState();
            const sourceIds = new Set(
              currentSelection?.sources?.map((source) => source.sourceId) ?? [],
            );
            for (const source of state.courses.find((item) => item.id === course.id)?.sources ?? [])
              if (
                source.localPath &&
                currentSelection?.paths?.some((path) =>
                  workspacePathAffected(source.localPath!, path),
                )
              )
                sourceIds.add(source.sourceId);
            const assignmentId = currentSelection?.assignment?.assignmentId;
            const files =
              action === 'notes'
                ? state.notes
                    .filter(
                      (note) =>
                        note.courseId === course.id &&
                        (note.id === target?.id ||
                          note.coveredSources.some((source) => sourceIds.has(source.sourceId))),
                    )
                    .map((note) => ({ path: note.path, title: note.title }))
                : state.tasks
                    .filter(
                      (task) =>
                        task.courseId === course.id &&
                        (task.id === target?.id ||
                          task.assignmentSourceId === `assignment:${assignmentId}` ||
                          (task.assignmentSourceId && sourceIds.has(task.assignmentSourceId))),
                    )
                    .flatMap((task) =>
                      task.deliverables.map((file) => ({
                        path: file.path,
                        title: file.description || file.path.split(/[\\/]/).at(-1)!,
                      })),
                    );
            jobs.update(id, { files });
          } catch {
            jobs.update(id, {
              error: '处理已结束，但成果目录未能刷新；可查看处理结果或稍后刷新学习中心。',
            });
          }
        }
        void useSessions
          .getState()
          .refresh(course.projectId)
          .catch(() => {});
      } finally {
        unsubscribe();
      }
    })
    .catch((reason: unknown) => {
      jobs.update(id, {
        status: stopped() ? 'stopped' : 'failed',
        error: reason instanceof Error ? reason.message : String(reason),
        finishedAt: Date.now(),
      });
      throw reason;
    })
    .finally(() => starting.delete(key));
  starting.set(key, operation);
  queue = operation.catch(() => {});
  return operation;
}
