import type {
  LearningCourse,
  LearningNote,
  LearningState,
  LearningTask,
} from '../../../shared/learning';
import { workspacePathAffected } from '../../../shared/workspace';
import { useNavigationStore } from '../../navigation/view';
import { useSessions } from '../../sessions/store';
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

export function startLearning(
  course: LearningCourse,
  action: LearningAction,
  target?: LearningTask | LearningNote,
  selection?: LearningSelection,
): Promise<void> {
  const text = learningPrompt(course, action, target, selection);
  const key = `${course.projectId}\0${text}`;
  const pending = starting.get(key);
  if (pending) return pending;
  const operation = (async () => {
    const api = window.dela;
    if (!api) throw new Error('请在 Dela 桌面端开始学习。');
    const chat = await api.session.create(course.projectId, 'library');
    if (!chat.sessionId) throw new Error('未能创建学习对话，请重试。');
    if (!chat.configured) throw new Error('请先在设置中配置模型，再开始学习对话。');
    useSessions.getState().putChat(chat.sessionId, chat);
    if (!useNavigationStore.getState().openChat(chat.sessionId, course.projectId))
      throw new Error('学习对话未打开，尚未开始处理。请保存当前编辑后重试。');
    const next = await api.session.ask(chat.sessionId, { text, attachments: [], context: [] });
    useSessions.getState().putChat(chat.sessionId, next);
    void useSessions
      .getState()
      .refresh(course.projectId)
      .catch(() => {});
  })().finally(() => starting.delete(key));
  starting.set(key, operation);
  return operation;
}
