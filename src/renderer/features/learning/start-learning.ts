import type {
  LearningCourse,
  LearningNote,
  LearningState,
  LearningTask,
} from '../../../shared/learning';
import { workspacePathAffected } from '../../../shared/workspace';
import { type LearningAction, type LearningSelection } from './learning-prompt';

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

export async function startLearning(
  course: LearningCourse,
  action: LearningAction,
  target?: LearningTask | LearningNote,
  selection?: LearningSelection,
): Promise<void> {
  const api = window.dela?.jobs;
  if (!api) throw new Error('请重新打开 Dela 以加载任务中心。');
  const assignments = selection?.sources?.filter((source) => source.kind === 'assignment') ?? [];
  const sourceId =
    assignments.length === 1
      ? assignments[0]!.sourceId
      : target && 'assignmentSourceId' in target
        ? target.assignmentSourceId
        : undefined;
  const assignmentId =
    selection?.assignment?.assignmentId ||
    Number(sourceId?.match(/^assignment:(\d+)$/)?.[1]) ||
    undefined;
  await api.enqueue({
    domain: 'learning',
    projectId: course.projectId,
    courseId: course.id,
    action,
    title:
      selection?.assignment?.title ||
      target?.title ||
      selection?.sources?.map((source) => source.title).join('、') ||
      selection?.paths?.map((path) => path.split(/[\\/]/).at(-1)).join('、') ||
      course.name,
    targetId: target?.id,
    assignmentId,
    sourceIds: selection?.sources?.map((source) => source.sourceId),
    paths: selection?.paths,
  });
}
