import { useRef, useState } from 'react';
import type { WorkspaceEntry } from '../../shared/api';
import { Button } from '../components/ui/button';
import { showToast } from '../app/toasts';
import { errorText } from '../workspace/store';
import type { LearningAction } from '../features/learning/learning-prompt';
import { resolveLearningSelection, startLearning } from '../features/learning/start-learning';
import { LearningJobProgress } from '../features/learning/LearningJobProgress';

export function FileLearningActions({
  entry,
  projectId,
}: {
  entry: WorkspaceEntry;
  projectId: string;
}) {
  const [starting, setStarting] = useState(false);
  const pending = useRef(false);
  const start = async (action: LearningAction) => {
    const api = window.dela?.learning;
    if (!api || pending.current) return;
    pending.current = true;
    setStarting(true);
    try {
      const state = await api.getState();
      const resolved = resolveLearningSelection(state, projectId, {
        localPath: entry.path ?? entry.id,
        sourceId: entry.sourceId,
      });
      if (!resolved) throw new Error('未找到这个文件对应的课程，请先将课程资料同步到当前项目。');
      if (action === 'assignment') {
        const assignments =
          resolved.selection.sources?.filter((source) => source.kind === 'assignment') ?? [];
        const sourceId =
          assignments.length === 1 ? assignments[0]!.sourceId : resolved.target?.assignmentSourceId;
        const assignmentId = Number(sourceId?.match(/^assignment:(\d+)$/)?.[1]);
        if (!assignmentId)
          throw new Error('这个文件未对应到具体的 Canvas 作业，请在学习中心选择未提交作业。');
        let todos = await window.dela!.todo.getState();
        let assignment = todos.items.find(
          (item) => item.courseId === resolved.course.id && item.assignmentId === assignmentId,
        );
        if (!assignment) {
          todos = await window.dela!.todo.refresh();
          assignment = todos.items.find(
            (item) => item.courseId === resolved.course.id && item.assignmentId === assignmentId,
          );
        }
        if (!assignment)
          throw new Error('Canvas 中未找到这份作业，请在学习中心刷新未提交作业列表。');
        resolved.selection.assignment = assignment;
      }
      await startLearning(
        resolved.course,
        action,
        action === 'notes' ? undefined : resolved.target,
        resolved.selection,
      );
    } catch (reason) {
      showToast({ variant: 'error', title: '学习任务未能完成', description: errorText(reason) });
    } finally {
      pending.current = false;
      setStarting(false);
    }
  };

  return (
    <section aria-label="所选文件的学习操作" className="mx-2 mb-2 rounded-control bg-inset p-2">
      <p className="truncate pb-1.5 text-xs text-ink-3" title={entry.name}>
        已选：{entry.name}
      </p>
      <div className="flex flex-wrap gap-1">
        {(
          [
            { action: 'notes', label: '整理笔记' },
            { action: 'assignment', label: '完成作业' },
            { action: 'review', label: '检查答案' },
          ] as const
        ).map(({ action, label }) => (
          <Button
            key={action}
            disabled={starting}
            onClick={() => void start(action)}
            size="sm"
            variant="outline"
          >
            {label}
          </Button>
        ))}
      </div>
      <LearningJobProgress projectId={projectId} compact />
      {starting && (
        <p role="status" className="pt-1.5 text-xs text-ink-3">
          正在处理…
        </p>
      )}
    </section>
  );
}
