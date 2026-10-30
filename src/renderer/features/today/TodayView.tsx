import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, CalendarDays, Check, ListChecks, Pin, Plus } from 'lucide-react';
import type { TodoItem, TodoState } from '../../../shared/todo';
import { rankTodos, todoStatusLabels } from '../../../shared/todo';
import type { LifeState } from '../../../shared/life';
import { addDays, shanghaiDate } from '../../../shared/life';
import type { ScheduleResult } from '../../../shared/timetable';
import { Button } from '../../components/ui/button';
import { useNavigationStore } from '../../navigation/view';
import { errorText } from '../../workspace/store';
import { useJobs } from '../jobs/store';
import { JobCard } from '../jobs/JobCard';

const time = (value: string) =>
  new Date(value).toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
  });
const due = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const panel = 'rounded-card border border-line bg-surface p-5';

export function TodayView() {
  const [todos, setTodos] = useState<TodoState | null>(null);
  const [life, setLife] = useState<LifeState | null>(null);
  const [schedule, setSchedule] = useState<ScheduleResult | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [day, setDay] = useState(shanghaiDate());
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const { jobs, error: jobsError, refresh: refreshJobs } = useJobs();
  const nav = useNavigationStore.getState();
  const load = useCallback(async () => {
    const current = shanghaiDate();
    setDay(current);
    const results = await Promise.allSettled([
      window.dela!.todo.getState(),
      window.dela!.life.getState({ startDate: addDays(current, -30), endDate: current }),
      window.dela!.timetable.querySchedule({
        startAt: `${current}T00:00:00+08:00`,
        endAt: `${addDays(current, 1)}T00:00:00+08:00`,
      }),
    ]);
    const next: Record<string, string> = {};
    const [todoResult, lifeResult, scheduleResult] = results;
    if (todoResult.status === 'fulfilled') setTodos(todoResult.value);
    else next['事项'] = errorText(todoResult.reason);
    if (lifeResult.status === 'fulfilled') setLife(lifeResult.value);
    else next['生活记录'] = errorText(lifeResult.reason);
    if (scheduleResult.status === 'fulfilled') setSchedule(scheduleResult.value);
    else next['日程'] = errorText(scheduleResult.reason);
    setErrors(next);
    setLoading(false);
  }, []);
  useEffect(() => {
    if (!window.dela) {
      setErrors({ 连接: '请在 Dela 桌面应用中打开今天。' });
      setLoading(false);
      return;
    }
    void load();
    const todoOff = window.dela.todo.onUpdate(() => void load());
    const lifeOff = window.dela.life.onUpdate(() => void load());
    const scheduleOff = window.dela.timetable.onUpdate(() => void load());
    const timer = setInterval(() => void load(), 60_000);
    const focus = () => void load();
    window.addEventListener('focus', focus);
    return () => {
      todoOff();
      lifeOff();
      scheduleOff();
      clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, [load]);
  const mutate = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setActionError('');
    try {
      await action();
      await load();
    } catch (reason) {
      setActionError(errorText(reason));
    } finally {
      setBusy(null);
    }
  };
  const occurrences = life?.occurrences ?? [];
  const occurrenceMap = new Map(occurrences.map((item) => [item.id, item]));
  const expanded: TodoItem[] = occurrences
    .filter((item) => !item.completed)
    .map((item) => ({
      ...todos?.items.find((todo) => todo.id === item.todoId),
      id: item.id,
      title: item.title,
      dueAt: item.dueAt,
      source: 'personal',
      status: 'pending',
      recurrence: null,
      notes: '',
      readAt: null,
      createdAt: `${item.date}T00:00:00+08:00`,
    }));
  const priorities = rankTodos([
    ...(todos?.items ?? []).filter(
      (item) =>
        item.source === 'personal' || ['pending', 'resubmit', 'unknown'].includes(item.status),
    ),
    ...expanded,
  ]);
  const active = jobs.filter((job) =>
    ['running', 'queued', 'needs_input', 'interrupted'].includes(job.status),
  );
  const recent = jobs
    .filter((job) => job.files.length && !active.includes(job))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 4);
  const warnings = [
    ...Object.entries(errors).map(([label, message]) => `${label}：${message}`),
    ...(schedule?.coverage.warnings ?? []),
    ...(todos?.error ? [`Canvas：${todos.error}`] : []),
    ...(jobsError ? [`任务中心：${jobsError}`] : []),
  ];
  return (
    <div className="h-full overflow-auto bg-inset">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-7 max-md:px-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs text-ink-3">
              {new Date(`${day}T12:00:00+08:00`).toLocaleDateString('zh-CN', {
                timeZone: 'Asia/Shanghai',
                month: 'long',
                day: 'numeric',
                weekday: 'long',
              })}{' '}
              · 北京时间
            </p>
            <h1 className="mt-1 text-2xl font-semibold">今天</h1>
            <p className="mt-2 text-13 text-ink-3">先看重要事项，再查看进度与成果。</p>
          </div>
          <Button
            variant="outline"
            onClick={() => {
              void load();
              void refreshJobs();
            }}
          >
            刷新
          </Button>
        </header>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!title.trim() || busy) return;
            void mutate('capture', async () => {
              await window.dela!.todo.save({ title: title.trim(), area: 'inbox' });
              setTitle('');
            });
          }}
        >
          <input
            aria-label="快速记录事项"
            className="min-w-0 flex-1 rounded-control bg-surface px-4 py-3 text-sm shadow-hairline"
            placeholder="先记下来，稍后归入生活、课程或项目…"
            value={title}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Button type="submit" disabled={!!busy || !title.trim()}>
            <Plus />
            记入收集箱
          </Button>
        </form>
        {actionError && (
          <p role="alert" className="text-sm text-red">
            {actionError}
          </p>
        )}
        {!!warnings.length && (
          <div role="status" className="rounded-control border border-line bg-surface p-3 text-sm">
            <p>部分信息暂未核对，以下内容可能不是最新。</p>
            <details className="mt-1 text-xs text-ink-3">
              <summary>查看原因（{warnings.length}）</summary>
              {warnings.map((warning) => (
                <p key={warning} className="mt-1">
                  {warning}
                </p>
              ))}
            </details>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void load();
                void refreshJobs();
              }}
            >
              重新读取
            </Button>
          </div>
        )}
        {loading && (
          <p role="status" className="py-6 text-ink-3">
            正在读取事项与日程…
          </p>
        )}
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <section className={panel} aria-label="现在该做什么">
            <div className="flex justify-between items-center gap-2">
              <h2 className="font-semibold">现在该做什么</h2>
              <Button variant="ghost" size="sm" onClick={() => nav.navigate('life')}>
                管理事项
                <ArrowRight />
              </Button>
            </div>
            <p className="mt-1 text-xs text-ink-3">
              按置顶、逾期、临近截止和重要程度排序；重复事项显示近 30 天未完成项。不会自动安排日历。
            </p>
            <div className="mt-4 divide-y divide-line">
              {priorities.slice(0, 10).map(({ item, reason }) => {
                const occurrence = occurrenceMap.get(item.id);
                return (
                  <article key={item.id} className="flex gap-3 py-3">
                    {item.source === 'personal' ? (
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label={`完成 ${item.title}`}
                        disabled={!!busy}
                        onClick={() =>
                          void mutate(item.id, () =>
                            occurrence
                              ? window.dela!.life.saveOccurrence({
                                  todoId: occurrence.todoId,
                                  date: occurrence.date,
                                  completed: true,
                                })
                              : window.dela!.todo.save({
                                  id: item.id,
                                  title: item.title,
                                  completed: true,
                                }),
                          )
                        }
                      >
                        <Check />
                      </Button>
                    ) : (
                      <ListChecks className="mt-1 size-5 shrink-0 text-ink-3" />
                    )}
                    <button
                      className="min-w-0 flex-1 text-left"
                      onClick={() => (occurrence ? nav.navigate('life') : nav.openTodo(item.id))}
                    >
                      <p className="break-words text-sm font-medium">{item.title}</p>
                      <p className="mt-1 text-xs text-ink-3">
                        {reason}
                        {item.courseName
                          ? ` · ${item.courseName}`
                          : occurrence
                            ? ` · 重复事项 ${occurrence.date}`
                            : item.area === 'inbox'
                              ? ' · 收集箱'
                              : ''}
                        {item.estimateMinutes ? ` · 预计 ${item.estimateMinutes} 分钟` : ''}
                      </p>
                      {item.dueAt && (
                        <p className="mt-1 text-xs text-ink-3">
                          截止 {due(item.dueAt)}
                          {item.source === 'canvas'
                            ? ` · Canvas ${todoStatusLabels[item.status]}`
                            : ''}
                        </p>
                      )}
                    </button>
                    {item.source === 'personal' && !occurrence && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`${item.pinned ? '取消置顶' : '置顶'} ${item.title}`}
                        disabled={!!busy}
                        onClick={() =>
                          void mutate(item.id, () =>
                            window.dela!.todo.save({
                              id: item.id,
                              title: item.title,
                              pinned: !item.pinned,
                            }),
                          )
                        }
                      >
                        <Pin className={item.pinned ? 'text-bui-accent' : 'text-ink-3'} />
                      </Button>
                    )}
                  </article>
                );
              })}
            </div>
            {!loading && !priorities.length && (
              <p className="py-8 text-center text-sm text-ink-3">
                当前没有待处理事项。可以先记下一件想做的事。
              </p>
            )}
            {priorities.length > 10 && (
              <p className="mt-3 text-xs text-ink-3">
                另有 {priorities.length - 10} 项，可在学习和生活页面查看。
              </p>
            )}
            <Button className="mt-3" variant="outline" onClick={() => nav.navigate('learning')}>
              查看各课程作业
            </Button>
          </section>
          <section className={panel} aria-label="今日课程和事件">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold">今日课程和事件</h2>
              <Button variant="ghost" size="sm" onClick={() => nav.navigate('timetable')}>
                <CalendarDays />
                日历
              </Button>
            </div>
            <div className="mt-4 space-y-3">
              {schedule?.items.map((item) => (
                <div key={`${item.source}:${item.id}`} className="rounded-control bg-inset p-3">
                  <div className="flex gap-2 text-xs text-ink-3">
                    <span>
                      {item.source === 'deadline'
                        ? '截止'
                        : item.source === 'course'
                          ? '课程'
                          : '事件'}
                    </span>
                    <span>
                      {time(item.startAt)}
                      {item.source !== 'deadline' ? `—${time(item.endAt)}` : ''}
                    </span>
                  </div>
                  <p className="mt-1 text-sm font-medium">{item.title}</p>
                  {item.location && <p className="mt-1 text-xs text-ink-3">{item.location}</p>}
                </div>
              ))}
            </div>
            {!loading && !schedule?.items.length && (
              <p className="py-8 text-center text-sm text-ink-3">
                {errors['日程']
                  ? '暂时无法读取日程，请重试。'
                  : '今日没有已记录的课程、事件或截止事项。'}
              </p>
            )}
          </section>
        </div>
        <section className={panel}>
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">
              正在处理与待补充 <span className="text-ink-3">{active.length}</span>
            </h2>
            <Button variant="ghost" onClick={() => nav.navigate('jobs')}>
              任务中心
              <ArrowRight />
            </Button>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {active.slice(0, 6).map((job) => (
              <JobCard key={job.id} job={job} compact />
            ))}
          </div>
          {!active.length && (
            <p className="py-5 text-sm text-ink-3">
              暂无运行任务。选中作业、笔记或项目任务后，一键开始。
            </p>
          )}
          {active.length > 6 && (
            <p className="mt-2 text-xs text-ink-3">任务中心还有 {active.length - 6} 项。</p>
          )}
        </section>
        <section className={panel}>
          <h2 className="font-semibold">最近成果</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {recent.map((job) => (
              <JobCard key={job.id} job={job} compact />
            ))}
          </div>
          {!recent.length && (
            <p className="py-5 text-sm text-ink-3">
              任务保存的成果会显示在这里。已有文件仍在原课程和项目目录中。
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
