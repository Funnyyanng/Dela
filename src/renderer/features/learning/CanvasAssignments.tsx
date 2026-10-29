import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { LearningState } from '../../../shared/learning';
import type { TodoItem, TodoState } from '../../../shared/todo';
import { todoStatusLabels } from '../../../shared/todo';
import { Button } from '../../components/ui/button';
import { useNavigationStore } from '../../navigation/view';
import { errorText } from '../../workspace/store';
import { startLearning } from './start-learning';

function dateLabel(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString('zh-CN') : '未公布';
}

export function CanvasAssignments({
  state,
  reload,
}: {
  state: LearningState | null;
  reload: number;
}) {
  const [todos, setTodos] = useState<TodoState | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [courseId, setCourseId] = useState('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [running, setRunning] = useState<string[]>([]);
  const runningRef = useRef(new Set<string>());

  useEffect(() => {
    const api = window.dela?.todo;
    if (!api) {
      setRefreshing(false);
      setError('暂时无法读取 Canvas 作业，请重新打开 Dela 后重试。');
      return;
    }
    let active = true;
    setRefreshing(true);
    setError(null);
    const accept = (next: TodoState) => {
      if (!active) return;
      setTodos(next);
      setSelected((ids) =>
        ids.filter((id) =>
          next.items.some(
            (item) => item.id === id && ['pending', 'resubmit'].includes(item.status),
          ),
        ),
      );
    };
    const unsubscribe = api.onUpdate(accept);
    void (async () => {
      try {
        accept(await api.getState());
        accept(await api.refresh());
      } catch (reason) {
        if (active) setError(errorText(reason));
      } finally {
        if (active) setRefreshing(false);
      }
    })();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [reload, revision]);

  const canvasItems = (todos?.items ?? []).filter((item) => item.source === 'canvas');
  const courseNames = new Map<number, string>();
  for (const course of todos?.canvasCourses ?? []) courseNames.set(course.id, course.name);
  for (const item of canvasItems)
    if (item.courseId) courseNames.set(item.courseId, item.courseName ?? `课程 ${item.courseId}`);
  const visible = canvasItems.filter(
    (item) => courseId === 'all' || String(item.courseId) === courseId,
  );
  const pending = visible.filter((item) => item.status === 'pending' || item.status === 'resubmit');
  const uncertain = visible.filter(
    (item) => item.status === 'unknown' || item.status === 'offline',
  );
  const courseFor = (item: TodoItem) =>
    state?.courses.find((course) => course.id === item.courseId);
  const courseFresh = (item: TodoItem) => {
    const coverage = todos?.canvasCourses?.find((course) => course.id === item.courseId);
    return Boolean(
      todos?.connected &&
      !refreshing &&
      !error &&
      (todos.canvasCourses
        ? coverage?.syncedAt && !coverage.error
        : todos.syncedAt && !todos.error),
    );
  };
  const eligible = pending.filter(
    (item) => courseFor(item) && courseFresh(item) && !running.includes(item.id),
  );
  const selectedItems = eligible.filter((item) => selected.includes(item.id));

  const start = (items: TodoItem[], action: 'assignment' | 'review') => {
    setActionError(null);
    for (const item of items) {
      const course = courseFor(item);
      if (!course || !courseFresh(item) || runningRef.current.has(item.id)) continue;
      runningRef.current.add(item.id);
      setRunning([...runningRef.current]);
      const source = course.sources.find(
        (source) => source.sourceId === `assignment:${item.assignmentId}`,
      );
      const task = state?.tasks.find(
        (task) =>
          task.courseId === course.id &&
          task.assignmentSourceId === `assignment:${item.assignmentId}`,
      );
      void startLearning(course, action, task, {
        sources: source ? [source] : [],
        assignment: item,
      })
        .catch((reason) => setActionError(errorText(reason)))
        .finally(() => {
          runningRef.current.delete(item.id);
          setRunning([...runningRef.current]);
        });
    }
    setSelected((ids) => ids.filter((id) => !items.some((item) => item.id === id)));
  };

  const openCanvas = (item: TodoItem) => {
    if (item.url)
      void window.dela?.canvas
        .openLink(item.url)
        .catch((reason) => setActionError(errorText(reason)));
  };

  return (
    <section aria-label="选择作业" className="space-y-4 rounded-card border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-15 font-medium">Canvas 未提交作业 · 所有课程</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">
            按 Canvas 提交状态筛选，包含逾期作业。本地已复核的答案仍需你提交。
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={refreshing}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'} />
          {refreshing ? '正在核对 Canvas…' : '刷新提交状态'}
        </Button>
      </div>
      {(error || todos?.error) && (
        <p
          role="alert"
          className="whitespace-pre-line rounded-control bg-orange-tint p-3 text-xs text-orange"
        >
          {error || todos?.error}
          {'\n'}未能核对的课程保留上次记录，不能据此认定已查全或已完成。
        </p>
      )}
      {actionError && (
        <p role="alert" className="text-xs text-red">
          {actionError}
        </p>
      )}
      {todos && !todos.connected && (
        <p className="text-13 text-orange">请先在设置中连接 Canvas，才能核对未提交作业。</p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <select
          aria-label="筛选作业课程"
          value={courseId}
          onChange={(event) => {
            setCourseId(event.target.value);
            setSelected([]);
          }}
          className="h-8 max-w-80 rounded-control bg-field px-3 text-13 text-ink shadow-hairline"
        >
          <option value="all">所有课程（{courseNames.size} 门）</option>
          {[...courseNames].map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <p className="text-xs text-ink-3">
          {refreshing ? '正在读取最新提交状态' : `上次完整核对：${dateLabel(todos?.syncedAt)}`}
        </p>
      </div>
      {pending.length > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-inset p-3">
            <label className="flex items-center gap-2 text-13">
              <input
                type="checkbox"
                aria-label="全选可处理的未提交作业"
                checked={eligible.length > 0 && selectedItems.length === eligible.length}
                disabled={!eligible.length}
                onChange={(event) =>
                  setSelected(event.target.checked ? eligible.map((item) => item.id) : [])
                }
              />
              全选可处理作业 · 已选 {selectedItems.length} / {pending.length} 项
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={!selectedItems.length}
              onClick={() => start(selectedItems, 'assignment')}
            >
              完成所选作业
            </Button>
          </div>
          <ul className="divide-y divide-line">
            {pending.map((item) => {
              const course = courseFor(item);
              const task = state?.tasks.find(
                (task) =>
                  task.courseId === item.courseId &&
                  task.assignmentSourceId === `assignment:${item.assignmentId}`,
              );
              const fresh = courseFresh(item);
              const busy = running.includes(item.id);
              return (
                <li key={item.id} className="flex flex-wrap items-start gap-3 py-4">
                  <input
                    type="checkbox"
                    className="mt-1"
                    aria-label={`选择作业：${item.courseName} · ${item.title}`}
                    checked={selected.includes(item.id)}
                    disabled={!course || !fresh || busy}
                    onChange={(event) =>
                      setSelected((ids) =>
                        event.target.checked
                          ? [...ids, item.id]
                          : ids.filter((id) => id !== item.id),
                      )
                    }
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <h3 className="break-words text-13 font-medium">{item.title}</h3>
                    <p className="text-xs text-ink-3">
                      {item.courseName} {item.courseTerm ? `· ${item.courseTerm}` : ''}
                    </p>
                    <p className="text-xs text-ink-2">
                      {fresh ? 'Canvas：' : '上次记录（待核对）：'}
                      {item.status === 'resubmit' ? '需重新提交' : '未提交'} · 截止{' '}
                      {dateLabel(item.dueAt)}
                    </p>
                    {item.assignmentRequirements?.lockedForUser && (
                      <p className="text-xs text-orange">
                        Canvas 当前未开放或已关闭；完成内容后需核对提交安排。
                      </p>
                    )}
                    {task && (
                      <p className="text-xs text-ink-3">
                        本地：
                        {task.status === 'checked' ? '已复核（提交状态见上方）' : '已有作业进度'}
                      </p>
                    )}
                    {!course && (
                      <p className="text-xs text-orange">
                        尚未关联本地课程文件夹，请先在课程资料中添加到项目。
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {item.url && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`查看 Canvas 原题：${item.title}`}
                        onClick={() => openCanvas(item)}
                      >
                        查看原题
                      </Button>
                    )}
                    {!course ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => useNavigationStore.getState().openProject('')}
                      >
                        关联课程资料
                      </Button>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!fresh || busy}
                          aria-label={`完成作业：${item.title}`}
                          onClick={() => start([item], 'assignment')}
                        >
                          {busy ? '已加入处理队列' : '完成作业'}
                        </Button>
                        {task && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!fresh || busy}
                            aria-label={`检查答案：${item.title}`}
                            onClick={() => start([item], 'review')}
                          >
                            检查答案
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {!pending.length && !refreshing && todos?.connected && (
        <p className="py-6 text-center text-13 text-ink-3">
          {error || todos.error
            ? '暂时无法确认完整的未提交作业清单。'
            : '当前筛选范围内没有 Canvas 明确标记为未提交的作业。'}
        </p>
      )}
      {uncertain.length > 0 && (
        <details className="rounded-control bg-inset p-3 text-xs text-ink-3">
          <summary className="cursor-pointer">
            另有 {uncertain.length} 项线下作业或提交状态待确认
          </summary>
          <ul className="mt-3 space-y-2">
            {uncertain.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3">
                <span>
                  {item.courseName} · {item.title} · {todoStatusLabels[item.status]} · 截止{' '}
                  {dateLabel(item.dueAt)}
                </span>
                {item.url && (
                  <Button size="sm" variant="ghost" onClick={() => openCanvas(item)}>
                    查看 Canvas
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
