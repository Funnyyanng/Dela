import { useCallback, useEffect, useRef, useState } from 'react';
import type { Habit, LifeState, TodoOccurrence } from '../../../shared/life';
import { addDays, shanghaiDate, weeklyLifeReview } from '../../../shared/life';
import type { TodoCanvasCourse, TodoItem, TodoSaveInput } from '../../../shared/todo';
import { rankTodos } from '../../../shared/todo';
import { Button } from '../../components/ui/button';
import { useNavigationStore } from '../../navigation/view';
import { errorText } from '../../workspace/store';

const field = 'rounded-control bg-field px-3 py-2 text-sm shadow-hairline min-w-0';
const localTime = (value: string | null | undefined) =>
  value ? new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 16) : '';
const utc = (value: string) => (value ? new Date(`${value}:00+08:00`).toISOString() : null);

function TodoEditor({
  item,
  onSaved,
  onClose,
}: {
  item?: TodoItem;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [projectId, setProjectId] = useState(item?.projectId ?? '');
  const [courseId, setCourseId] = useState(item?.courseId?.toString() ?? '');
  const [projects, setProjects] = useState<{ projectId: string; name: string }[]>([]);
  const [courses, setCourses] = useState<TodoCanvasCourse[]>([]);
  const [title, setTitle] = useState(item?.title ?? '');
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [due, setDue] = useState(localTime(item?.dueAt));
  const [reminder, setReminder] = useState(localTime(item?.remindAt));
  const [area, setArea] = useState<TodoSaveInput['area']>(item?.area ?? 'life');
  const [priority, setPriority] = useState<TodoSaveInput['priority']>(item?.priority ?? 'normal');
  const [estimate, setEstimate] = useState(item?.estimateMinutes?.toString() ?? '');
  const [frequency, setFrequency] = useState(item?.recurrence?.frequency ?? 'none');
  const [startDate, setStartDate] = useState(item?.recurrence?.startDate ?? shanghaiDate());
  const [endDate, setEndDate] = useState(item?.recurrence?.endDate ?? '');
  const [weekdays, setWeekdays] = useState(item?.recurrence?.weekdays ?? [1]);
  const [monthDay, setMonthDay] = useState(item?.recurrence?.monthDay ?? 1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all([window.dela!.projects.getState(), window.dela!.todo.getState()])
      .then(([projectState, todoState]) => {
        if (active) {
          setProjects(projectState.projects);
          setCourses(todoState.canvasCourses ?? []);
        }
      })
      .catch((reason) => {
        if (active) setError(errorText(reason));
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <form
      aria-label={item ? '编辑事项' : '新增事项'}
      className="rounded-card border border-line p-4 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError('');
        void window
          .dela!.todo.save({
            id: item?.id,
            title,
            notes,
            dueAt: utc(due),
            remindAt: utc(reminder),
            area,
            projectId: area === 'project' ? projectId : null,
            courseId: area === 'course' ? Number(courseId) : null,
            priority,
            estimateMinutes: estimate ? Number(estimate) : null,
            calendar: true,
            recurrence:
              frequency === 'none'
                ? null
                : {
                    frequency: frequency as 'daily' | 'weekly' | 'monthly',
                    startDate,
                    ...(endDate ? { endDate } : {}),
                    ...(frequency === 'weekly' ? { weekdays } : {}),
                    ...(frequency === 'monthly' ? { monthDay } : {}),
                  },
          })
          .then(onSaved)
          .catch((reason) => setError(errorText(reason)))
          .finally(() => setBusy(false));
      }}
    >
      <h2 className="font-medium">{item ? '编辑事项或重复规则' : '新增事项'}</h2>
      <input
        aria-label="事项名称"
        className={`${field} w-full`}
        required
        maxLength={200}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="需要做什么？"
      />
      <textarea
        aria-label="事项备注"
        className={`${field} w-full`}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="说明、要求或相关资料"
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs">
          分类
          <select
            className={field}
            value={area}
            onChange={(e) => setArea(e.target.value as typeof area)}
          >
            <option value="inbox">收集箱</option>
            <option value="life">生活</option>
            <option value="course">课程</option>
            <option value="project">项目</option>
          </select>
        </label>
        {area === 'project' && (
          <label className="grid gap-1 text-xs">
            所属项目
            <select
              className={field}
              required
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">请选择项目</option>
              {projects.map((project) => (
                <option key={project.projectId} value={project.projectId}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {area === 'course' && (
          <label className="grid gap-1 text-xs">
            所属课程
            <select
              className={field}
              required
              value={courseId}
              onChange={(e) => setCourseId(e.target.value)}
            >
              <option value="">请选择课程</option>
              {courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="grid gap-1 text-xs">
          重要程度
          <select
            className={field}
            value={priority}
            onChange={(e) => setPriority(e.target.value as typeof priority)}
          >
            <option value="normal">普通</option>
            <option value="high">重要</option>
            <option value="low">较低</option>
          </select>
        </label>
        <label className="grid gap-1 text-xs">
          截止时间（北京时间）
          <input
            className={field}
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs">
          提醒时间（北京时间）
          <input
            className={field}
            type="datetime-local"
            value={reminder}
            onChange={(e) => setReminder(e.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs">
          预计耗时（分钟）
          <input
            className={field}
            type="number"
            min={1}
            max={10080}
            value={estimate}
            onChange={(e) => setEstimate(e.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs">
          重复
          <select
            className={field}
            value={frequency}
            onChange={(e) => setFrequency(e.target.value)}
          >
            <option value="none">不重复</option>
            <option value="daily">每天</option>
            <option value="weekly">每周指定日期</option>
            <option value="monthly">每月指定日期</option>
          </select>
        </label>
      </div>
      {frequency !== 'none' && (
        <div className="space-y-2 text-xs">
          <div className="flex flex-wrap gap-3">
            <label>
              开始日期{' '}
              <input
                className={field}
                type="date"
                required
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </label>
            <label>
              结束日期（可选）{' '}
              <input
                className={field}
                type="date"
                min={startDate}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </label>
          </div>
          {frequency === 'weekly' && (
            <div className="flex gap-3">
              {['一', '二', '三', '四', '五', '六', '日'].map((name, index) => (
                <label key={name}>
                  <input
                    type="checkbox"
                    checked={weekdays.includes(index + 1)}
                    onChange={(e) =>
                      setWeekdays((old) =>
                        e.target.checked
                          ? [...old, index + 1]
                          : old.filter((day) => day !== index + 1),
                      )
                    }
                  />
                  周{name}
                </label>
              ))}
            </div>
          )}
          {frequency === 'monthly' && (
            <label>
              每月{' '}
              <input
                aria-label="每月日期"
                className={field}
                type="number"
                min={1}
                max={31}
                value={monthDay}
                onChange={(e) => setMonthDay(Number(e.target.value))}
              />{' '}
              日（当月不足该日时使用月底）
            </label>
          )}
          <p className="text-ink-3">
            截止时间的时刻用于每次重复；提醒与截止的时间差会沿用。勾选完成只影响当天。
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-red">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? '保存中…' : '保存事项'}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          取消
        </Button>
      </div>
    </form>
  );
}
function OccurrenceEditor({
  item,
  onSaved,
  onClose,
}: {
  item: TodoOccurrence;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(item.title),
    [due, setDue] = useState(localTime(item.dueAt)),
    [reminder, setReminder] = useState(localTime(item.remindAt)),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="rounded-control border border-line p-3 space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void window
          .dela!.life.saveOccurrence({
            todoId: item.todoId,
            date: item.date,
            title,
            dueAt: utc(due)!,
            remindAt: utc(reminder),
          })
          .then(onSaved)
          .catch((reason) => setError(errorText(reason)))
          .finally(() => setBusy(false));
      }}
    >
      <p className="text-sm">仅修改 {item.date} 这一次</p>
      <input
        className={field}
        aria-label="本次事项名称"
        required
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <label className="block text-xs">
        本次截止{' '}
        <input
          className={field}
          type="datetime-local"
          required
          value={due}
          onChange={(e) => setDue(e.target.value)}
        />
      </label>
      <label className="block text-xs">
        本次提醒{' '}
        <input
          className={field}
          type="datetime-local"
          value={reminder}
          onChange={(e) => setReminder(e.target.value)}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <Button type="submit" disabled={busy}>
        保存本次
      </Button>
      <Button type="button" variant="ghost" onClick={onClose}>
        取消
      </Button>
    </form>
  );
}
export function LifeView({ date }: { date?: string | null } = {}) {
  const api = window.dela;
  const mutationPending = useRef(false);
  const loadGeneration = useRef(0);
  const [saving, setSaving] = useState(false);
  const [habitId, setHabitId] = useState<string | undefined>();
  const [life, setLife] = useState<LifeState | null>(null),
    [todos, setTodos] = useState<TodoItem[]>([]),
    [tab, setTab] = useState<'事项' | '习惯' | '作息' | '周回顾'>('事项'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<TodoItem | null | undefined>(undefined),
    [occurrence, setOccurrence] = useState<TodoOccurrence | null>(null);
  const [day, setDay] = useState(date ?? shanghaiDate()),
    [habitTitle, setHabitTitle] = useState(''),
    [habitKind, setHabitKind] = useState<Habit['kind']>('count'),
    [habitUnit, setHabitUnit] = useState(''),
    [habitTarget, setHabitTarget] = useState('');
  const [sleepStart, setSleepStart] = useState(''),
    [sleepEnd, setSleepEnd] = useState(''),
    [sleepNote, setSleepNote] = useState(''),
    [sleepId, setSleepId] = useState<string | undefined>();
  useEffect(() => {
    if (date) setDay(date);
  }, [date]);
  const load = useCallback(async () => {
    if (!api?.life) return;
    const generation = ++loadGeneration.current;
    setBusy(true);
    try {
      const [next, todo] = await Promise.all([
        api.life.getState({ startDate: addDays(day, -6), endDate: addDays(day, 30) }),
        api.todo.getState(),
      ]);
      if (generation !== loadGeneration.current) return;
      setLife(next);
      setTodos(todo.items);
      setError('');
    } catch (reason) {
      if (generation === loadGeneration.current) setError(errorText(reason));
    } finally {
      if (generation === loadGeneration.current) setBusy(false);
    }
  }, [api, day]);
  useEffect(() => {
    void load();
    const a = api?.life?.onUpdate(() => void load()),
      b = api?.todo?.onUpdate(() => void load());
    return () => {
      a?.();
      b?.();
    };
  }, [api, load]);
  const mutate = (action: () => Promise<unknown>) => {
    if (mutationPending.current) return;
    mutationPending.current = true;
    setSaving(true);
    setError('');
    void Promise.resolve()
      .then(action)
      .then(() => load())
      .catch((reason) => setError(errorText(reason)))
      .finally(() => {
        mutationPending.current = false;
        setSaving(false);
      });
  };
  if (!api?.life) return <p className="p-8">请在 Dela 桌面端打开生活页面。</p>;
  const personal = todos.filter(
    (item) =>
      item.source === 'personal' &&
      !item.archived &&
      (item.area === 'life' || item.area === 'inbox' || !item.area),
  );
  const completed = personal.filter((item) => item.status === 'completed' && !item.recurrence);
  const occurrences =
    life?.occurrences.filter((item) => personal.some((todo) => todo.id === item.todoId)) ?? [];
  const weeklyLogs =
    life?.habitLogs.filter((log) => log.date >= addDays(day, -6) && log.date <= day) ?? [];
  const review = life ? weeklyLifeReview(life, day) : null;
  return (
    <div className="h-full overflow-y-auto bg-surface">
      <div className="mx-auto max-w-5xl space-y-5 p-7">
        <header className="flex flex-wrap justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">生活</h1>
            <p className="mt-1 text-sm text-ink-3">记录生活事项和真实完成情况，按你的节奏安排。</p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => void useNavigationStore.getState().navigate('timetable')}
            >
              打开日历
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => void load()}>
              刷新
            </Button>
          </div>
        </header>
        <div className="flex gap-2">
          {(['事项', '习惯', '作息', '周回顾'] as const).map((name) => (
            <Button
              key={name}
              variant={tab === name ? 'default' : 'ghost'}
              onClick={() => setTab(name)}
            >
              {name}
            </Button>
          ))}
          <label className="ml-auto text-sm">
            查看日期{' '}
            <input
              aria-label="生活记录日期"
              type="date"
              className={field}
              value={day}
              onChange={(e) => e.target.value && setDay(e.target.value)}
            />
          </label>
        </div>
        {error && (
          <p role="alert" className="rounded-control bg-red-tint p-3 text-red">
            {error}
          </p>
        )}
        {busy && !life && <p role="status">正在读取生活记录…</p>}
        {tab === '事项' && (
          <>
            <Button onClick={() => setEditing(null)}>新增事项</Button>
            {editing !== undefined && (
              <TodoEditor
                key={editing?.id ?? 'new'}
                item={editing ?? undefined}
                onClose={() => setEditing(undefined)}
                onSaved={() => {
                  setEditing(undefined);
                  void load();
                }}
              />
            )}
            <section className="space-y-2" aria-label="生活事项">
              {rankTodos(personal).map(({ item, reason }, index) => (
                <article key={item.id} className="rounded-control border border-line p-3">
                  <div className="flex items-start gap-3">
                    <input
                      aria-label={`完成：${item.title}`}
                      className="mt-1"
                      type="checkbox"
                      checked={false}
                      onChange={() =>
                        mutate(() =>
                          api.todo.save({ id: item.id, title: item.title, completed: true }),
                        )
                      }
                    />
                    <div className="flex-1">
                      <p className="font-medium">{item.title}</p>
                      <p className="text-xs text-ink-3">
                        {item.area === 'inbox' ? '收集箱' : '生活'} · {reason}
                        {item.estimateMinutes ? ` · 预计 ${item.estimateMinutes} 分钟` : ''}
                        {item.dueAt
                          ? ` · 截止 ${new Date(item.dueAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
                          : ''}
                      </p>
                      {item.notes && (
                        <p className="mt-1 text-sm whitespace-pre-wrap">{item.notes}</p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        mutate(() =>
                          api.todo.save({ id: item.id, title: item.title, pinned: !item.pinned }),
                        )
                      }
                    >
                      {item.pinned ? '取消置顶' : '置顶'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={
                        index === 0 || (!item.pinned && rankTodos(personal)[index - 1]?.item.pinned)
                      }
                      onClick={() => {
                        const previous = rankTodos(personal)[index - 1]!.item;
                        mutate(() =>
                          api.todo.save({
                            id: item.id,
                            title: item.title,
                            order: (previous.order ?? 0) - 1,
                          }),
                        );
                      }}
                    >
                      提前处理
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(item)}>
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        mutate(() =>
                          api.todo.save({ id: item.id, title: item.title, archived: true }),
                        )
                      }
                    >
                      归档
                    </Button>
                  </div>
                </article>
              ))}
              {!rankTodos(personal).length && (
                <p className="py-5 text-sm text-ink-3">
                  没有待处理的单次事项，可以先把想到的事情记下来。
                </p>
              )}
            </section>
            <section aria-label="重复事项" className="space-y-3">
              <h2 className="font-medium">重复事项</h2>
              {personal
                .filter((item) => item.recurrence)
                .map((item) => (
                  <div key={item.id} className="flex items-center gap-2 text-sm">
                    <span className="flex-1">{item.title}</span>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(item)}>
                      编辑重复规则
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        mutate(() =>
                          api.todo.save({ id: item.id, title: item.title, archived: true }),
                        )
                      }
                    >
                      停用
                    </Button>
                  </div>
                ))}
              {occurrence && (
                <OccurrenceEditor
                  item={occurrence}
                  onClose={() => setOccurrence(null)}
                  onSaved={() => {
                    setOccurrence(null);
                    void load();
                  }}
                />
              )}
              {occurrences
                .filter((item) => item.date <= day)
                .map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-3 rounded-control bg-inset p-3 text-sm"
                  >
                    <input
                      type="checkbox"
                      aria-label={`完成 ${item.date} ${item.title}`}
                      checked={item.completed}
                      onChange={(e) => {
                        const completed = e.target.checked;
                        mutate(() =>
                          api.life.saveOccurrence({
                            todoId: item.todoId,
                            date: item.date,
                            completed,
                          }),
                        );
                      }}
                    />
                    <span className="flex-1">
                      {item.date} · {item.title}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setOccurrence(item)}>
                      修改本次
                    </Button>
                  </div>
                ))}
              {!occurrences.length && <p className="text-sm text-ink-3">尚未设置重复事项。</p>}
              <details className="text-sm">
                <summary>查看未来 30 天的重复事项</summary>
                {occurrences
                  .filter((item) => item.date > day)
                  .map((item) => (
                    <div className="flex justify-between py-2" key={item.id}>
                      <span>
                        {item.date} · {item.title}
                      </span>
                      <Button size="sm" variant="ghost" onClick={() => setOccurrence(item)}>
                        修改本次
                      </Button>
                    </div>
                  ))}
              </details>
            </section>
            <details>
              <summary className="text-sm text-ink-3">已完成与归档</summary>
              {[
                ...completed,
                ...todos.filter((item) => item.source === 'personal' && item.archived),
              ].map((item) => (
                <div key={item.id} className="flex justify-between p-2 text-sm">
                  <span>{item.title}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      mutate(() =>
                        api.todo.save({
                          id: item.id,
                          title: item.title,
                          archived: false,
                          ...(item.recurrence ? {} : { completed: false }),
                        }),
                      )
                    }
                  >
                    恢复事项
                  </Button>
                </div>
              ))}
            </details>
          </>
        )}
        {tab === '习惯' && (
          <>
            <form
              className="flex flex-wrap gap-2 rounded-card border border-line p-4"
              onSubmit={(e) => {
                e.preventDefault();
                mutate(async () => {
                  await api.life.saveHabit({
                    id: habitId,
                    title: habitTitle,
                    kind: habitKind,
                    unit: habitUnit || undefined,
                    target: habitTarget ? Number(habitTarget) : null,
                  });
                  setHabitTitle('');
                  setHabitId(undefined);
                  setHabitUnit('');
                  setHabitTarget('');
                });
              }}
            >
              <input
                className={field}
                aria-label="习惯名称"
                required
                value={habitTitle}
                onChange={(e) => setHabitTitle(e.target.value)}
                placeholder="习惯名称"
              />
              <select
                className={field}
                aria-label="记录类型"
                value={habitKind}
                onChange={(e) => setHabitKind(e.target.value as Habit['kind'])}
              >
                <option value="count">次数</option>
                <option value="duration">时长</option>
                <option value="number">数值</option>
              </select>
              <input
                aria-label="单位"
                className={field}
                value={habitUnit}
                onChange={(e) => setHabitUnit(e.target.value)}
                placeholder="单位（可选）"
              />
              <input
                aria-label="每日目标"
                className={field}
                type="number"
                min={0}
                step="any"
                value={habitTarget}
                onChange={(e) => setHabitTarget(e.target.value)}
                placeholder="每日目标（可选）"
              />
              <Button type="submit" disabled={saving}>
                {habitId ? '保存习惯' : '添加习惯'}
              </Button>
              {habitId && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setHabitId(undefined);
                    setHabitTitle('');
                    setHabitUnit('');
                    setHabitTarget('');
                  }}
                >
                  取消编辑
                </Button>
              )}
            </form>
            <p className="text-sm text-ink-3">
              最近七天有 {weeklyLogs.length} 条实际记录；未记录的日期保持未知。
            </p>
            {life?.habits
              .filter((habit) => !habit.archived)
              .map((habit) => (
                <HabitCard
                  key={`${habit.id}:${day}:${life.habitLogs.find((log) => log.habitId === habit.id && log.date === day)?.value ?? 'unknown'}`}
                  habit={habit}
                  date={day}
                  value={
                    life.habitLogs.find((log) => log.habitId === habit.id && log.date === day)
                      ?.value
                  }
                  recent={weeklyLogs
                    .filter((log) => log.habitId === habit.id)
                    .map((log) => `${log.date.slice(5)}：${log.value} ${habit.unit}`)
                    .join('；')}
                  onEdit={() => {
                    setHabitId(habit.id);
                    setHabitTitle(habit.title);
                    setHabitKind(habit.kind);
                    setHabitUnit(habit.unit);
                    setHabitTarget(habit.target?.toString() ?? '');
                  }}
                  onSave={(value) =>
                    mutate(() =>
                      api.life.logHabit({ habitId: habit.id, date: day, value, note: '' }),
                    )
                  }
                  onRemove={() => mutate(() => api.life.removeHabitLog(habit.id, day))}
                  onArchive={() => mutate(() => api.life.archiveHabit(habit.id, true))}
                />
              ))}
            {!life?.habits.some((habit) => !habit.archived) && (
              <p className="text-sm text-ink-3">添加一个习惯，记录今天实际做了多少。</p>
            )}
            <details>
              <summary className="text-sm">已停用习惯</summary>
              {life?.habits
                .filter((habit) => habit.archived)
                .map((habit) => (
                  <div key={habit.id} className="flex justify-between p-2">
                    {habit.title}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => mutate(() => api.life.archiveHabit(habit.id, false))}
                    >
                      恢复
                    </Button>
                  </div>
                ))}
            </details>
          </>
        )}
        {tab === '周回顾' && review && (
          <section className="space-y-4" aria-label="近七天回顾">
            <h2 className="font-medium">
              近七天回顾：{review.startDate} 至 {review.endDate}
            </h2>
            <p className="text-sm text-ink-3">
              按北京时间统计。仅计入实际记录；单次事项缺少完成时间，不推断为本周完成。
            </p>
            <div className="rounded-card border border-line p-4">
              <h3 className="font-medium">重复事项</h3>
              <p className="mt-2 text-sm">
                已记录完成 {review.recurring.completed} 次，共 {review.recurring.scheduled}{' '}
                次安排。其余不视为已完成。
              </p>
            </div>
            <div className="rounded-card border border-line p-4 space-y-2">
              <h3 className="font-medium">习惯记录</h3>
              {review.habits.map(({ habit, recordedDays, unknownDays, total }) => (
                <p className="text-sm" key={habit.id}>
                  {habit.title}：已记录 {recordedDays} 天，未记录 {unknownDays} 天；
                  {recordedDays ? `实际记录合计 ${total} ${habit.unit}` : '没有实测数据'}
                </p>
              ))}
              {!review.habits.length && <p className="text-sm text-ink-3">尚未设置习惯。</p>}
            </div>
            <div className="rounded-card border border-line p-4 space-y-2">
              <h3 className="font-medium">睡眠记录</h3>
              <p className="text-sm">
                已记录 {review.sleep.recordedDays} 天，未记录 {review.sleep.unknownDays} 天。
              </p>
              <p className="text-sm">
                {review.sleep.averageHours === null
                  ? '平均时长未知（尚无实际记录）'
                  : `已记录日期平均 ${review.sleep.averageHours.toFixed(1)} 小时`}
              </p>
              <p className="text-xs text-ink-3">
                以醒来日期归属；同日多段相加，未记录日期不参与平均。
              </p>
            </div>
          </section>
        )}
        {tab === '作息' && (
          <>
            <form
              className="rounded-card border border-line p-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                mutate(async () => {
                  await api.life.saveSleep({
                    id: sleepId,
                    startAt: utc(sleepStart)!,
                    endAt: utc(sleepEnd)!,
                    note: sleepNote,
                  });
                  setSleepId(undefined);
                  setSleepStart('');
                  setSleepEnd('');
                  setSleepNote('');
                });
              }}
            >
              <h2 className="font-medium">{sleepId ? '编辑睡眠记录' : '记录实际睡眠'}</h2>
              <div className="flex flex-wrap gap-3">
                <label className="grid text-xs gap-1">
                  入睡时间（北京时间）
                  <input
                    className={field}
                    type="datetime-local"
                    required
                    value={sleepStart}
                    onChange={(e) => setSleepStart(e.target.value)}
                  />
                </label>
                <label className="grid text-xs gap-1">
                  醒来时间（北京时间）
                  <input
                    className={field}
                    type="datetime-local"
                    required
                    value={sleepEnd}
                    onChange={(e) => setSleepEnd(e.target.value)}
                  />
                </label>
              </div>
              <input
                className={`${field} w-full`}
                aria-label="睡眠备注"
                placeholder="备注（可选）"
                value={sleepNote}
                onChange={(e) => setSleepNote(e.target.value)}
              />
              <Button type="submit" disabled={saving}>
                保存睡眠记录
              </Button>
              {sleepId && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setSleepId(undefined);
                    setSleepStart('');
                    setSleepEnd('');
                    setSleepNote('');
                  }}
                >
                  取消编辑
                </Button>
              )}
            </form>
            <p className="text-sm text-ink-3">仅统计你手动记录的时间，不推测未记录日期。</p>
            {life?.sleepLogs
              .filter((log) => shanghaiDate(log.endAt) <= day)
              .map((log) => (
                <div
                  key={log.id}
                  className="rounded-control bg-inset p-3 flex flex-wrap items-center gap-2"
                >
                  <span className="flex-1 text-sm">
                    {localTime(log.startAt).replace('T', ' ')} —{' '}
                    {localTime(log.endAt).replace('T', ' ')} ·{' '}
                    {((Date.parse(log.endAt) - Date.parse(log.startAt)) / 3600000).toFixed(1)} 小时
                    {log.note ? ` · ${log.note}` : ''}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setSleepId(log.id);
                      setSleepStart(localTime(log.startAt));
                      setSleepEnd(localTime(log.endAt));
                      setSleepNote(log.note);
                    }}
                  >
                    编辑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => mutate(() => api.life.removeSleep(log.id))}
                  >
                    移除记录
                  </Button>
                </div>
              ))}
            {!life?.sleepLogs.length && (
              <p className="text-sm text-ink-3">这一时段尚未记录睡眠。</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
function HabitCard({
  habit,
  date,
  value,
  recent,
  onSave,
  onRemove,
  onArchive,
  onEdit,
}: {
  habit: Habit;
  date: string;
  value?: number;
  recent: string;
  onSave: (value: number) => void;
  onRemove: () => void;
  onArchive: () => void;
  onEdit: () => void;
}) {
  const [draft, setDraft] = useState(value?.toString() ?? '');
  return (
    <form
      className="rounded-card border border-line p-4 space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(Number(draft));
      }}
    >
      <div className="flex justify-between">
        <h2 className="font-medium">{habit.title}</h2>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
            编辑
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onArchive}>
            停用
          </Button>
        </div>
      </div>
      <p className="text-xs text-ink-3">
        {date} · {value === undefined ? '未记录' : `${value} ${habit.unit}`}
        {habit.target !== null ? ` · 目标 ${habit.target} ${habit.unit}` : ''}
      </p>
      <div className="flex gap-2">
        <input
          aria-label={`记录 ${habit.title}`}
          className={field}
          type="number"
          min={0}
          step={habit.kind === 'count' ? 1 : 'any'}
          required
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit">保存实际记录</Button>
        {value !== undefined && (
          <Button type="button" variant="ghost" onClick={onRemove}>
            清除本日记录
          </Button>
        )}
      </div>
      {recent && <p className="text-xs text-ink-3">近七天：{recent}</p>}
    </form>
  );
}
