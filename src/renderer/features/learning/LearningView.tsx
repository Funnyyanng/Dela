import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowUpRight,
  BookOpen,
  CheckCircle2,
  Circle,
  ClipboardCheck,
  FileText,
  GraduationCap,
  RefreshCw,
} from 'lucide-react';
import type {
  LearningCourse,
  LearningNote,
  LearningState,
  LearningTask,
} from '../../../shared/learning';
import { Button } from '../../components/ui/button';
import { SegmentedControl } from '../../components/ui/beautifului/atoms/SegmentedControl';
import { StatusPill } from '../../components/ui/beautifului/atoms/StatusPill';
import { DesktopOnlyNotice } from '../../components/ui/desktop-only-notice';
import { useNavigationStore } from '../../navigation/view';
import { errorText } from '../../workspace/store';
import { showToast } from '../../app/toasts';
import { cn } from '../../lib/utils';
import type { LearningAction, LearningSelection } from './learning-prompt';
import { startLearning } from './start-learning';
import { PracticeReview } from './PracticeReview';
import { CanvasAssignments } from './CanvasAssignments';
import { LearningJobProgress } from './LearningJobProgress';
import { useLearningJobs } from './learning-jobs';

function dateLabel(value: string | null) {
  return value
    ? new Date(value).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '未设置截止时间';
}

function Warnings({ values }: { values: string[] }) {
  if (!values.length) return null;
  return (
    <div
      className="space-y-1 rounded-control bg-orange-tint px-3 py-2 text-xs leading-relaxed text-orange"
      role="status"
    >
      {values.map((value, index) => (
        <p className="flex items-start gap-2" key={`${index}-${value}`}>
          <AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {value}
        </p>
      ))}
    </div>
  );
}

export function LearningView() {
  const [state, setState] = useState<LearningState | null>(null);
  const [courseId, setCourseId] = useState<number | null>(() => {
    const saved = Number(localStorage.getItem('learning:last-course'));
    return Number.isInteger(saved) && saved > 0 ? saved : null;
  });
  const [tab, setTab] = useState<'作业' | '笔记' | '练习'>('作业');
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [sourceQuery, setSourceQuery] = useState('');
  const finishedJobs = useLearningJobs((value) =>
    value.jobs
      .filter((job) => job.finishedAt !== null)
      .map((job) => `${job.id}:${job.finishedAt}`)
      .join('|'),
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const api = window.dela?.learning;
    if (!api) return;
    let active = true;
    setLoading(true);
    void api
      .getState()
      .then((next) => {
        if (active) {
          setState(next);
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(errorText(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reload, finishedJobs]);

  if (!window.dela?.learning) {
    return (
      <DesktopOnlyNotice
        title="学习中心仅在 Dela 桌面端可用"
        description="在这里继续课程作业、整理笔记，并记录每一次真实练习。"
      />
    );
  }

  const course = state?.courses.find((item) => item.id === courseId) ?? state?.courses[0];
  const tasks = state?.tasks.filter((item) => item.courseId === course?.id) ?? [];
  const notes = state?.notes.filter((item) => item.courseId === course?.id) ?? [];
  const materials =
    course?.sources.filter(
      (source) =>
        source.kind !== 'assignment' &&
        source.kind !== 'quiz' &&
        !source.sourceId.startsWith('assignment:') &&
        !source.sourceId.startsWith('quiz:'),
    ) ?? [];
  const selectedMaterials = materials.filter((source) => selectedSources.includes(source.sourceId));
  const visibleMaterials = materials.filter((source) =>
    source.title.toLocaleLowerCase().includes(sourceQuery.trim().toLocaleLowerCase()),
  );
  const coveredSources = new Set(
    notes.flatMap((note) => note.coveredSources.map((source) => source.sourceId)),
  );
  const uncoveredSources =
    course?.sources.filter(
      (source) =>
        source.localPath?.replaceAll('\\', '/').includes('/课件/') &&
        !coveredSources.has(source.sourceId),
    ) ?? [];
  const practice = state?.practice.filter((item) => item.courseId === course?.id) ?? [];
  const due = practice.filter((item) => Date.parse(item.dueAt) <= now);
  const upcoming = practice
    .filter((item) => Date.parse(item.dueAt) > now)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const syncHistory = state?.syncHistory;
  const historyGroups = syncHistory
    ? [
        { label: '当时无法获取', values: syncHistory.unavailable },
        { label: '版本冲突', values: syncHistory.conflicts },
        { label: '其他失败', values: syncHistory.failed },
      ].filter((group) => group.values.length > 0)
    : [];
  const historyCount = historyGroups.reduce((count, group) => count + group.values.length, 0);
  const sourceOrigins = [
    { origin: 'canvas', label: 'Canvas' },
    { origin: 'wechat', label: '微信' },
    { origin: 'local', label: '本地参考' },
  ] as const;

  const start = async (
    action: LearningAction,
    target?: LearningTask | LearningNote,
    selection?: LearningSelection,
  ) => {
    if (!course || !window.dela || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setError(null);
    try {
      await startLearning(course, action, target, selection);
    } catch (reason) {
      const description = errorText(reason);
      setError(description);
      showToast({ variant: 'error', title: '学习任务未能完成', description });
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };

  const openFile = (selectedCourse: LearningCourse, path: string) => {
    const navigation = useNavigationStore.getState();
    if (navigation.openProject(selectedCourse.projectId))
      navigation.openDocument(path, { keep: true });
  };

  return (
    <div className="h-full overflow-y-auto bg-surface">
      <div className="mx-auto w-full max-w-6xl space-y-6 px-8 py-7 max-md:px-4">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">学习中心</h1>
            <p className="mt-1.5 text-13 text-ink-3">
              把课程资料变成完成的作业、可靠的笔记和扎实的理解。
            </p>
          </div>
          <div className="flex items-center gap-2">
            {state && state.courses.length > 0 && (
              <label className="flex items-center gap-2 text-xs text-ink-3">
                笔记与练习课程
                <select
                  aria-label="选择笔记与练习课程"
                  className="h-8 max-w-72 rounded-control bg-field px-3 text-13 text-ink shadow-hairline outline-none focus-visible:outline-2 focus-visible:outline-bui-accent"
                  onChange={(event) => {
                    localStorage.setItem('learning:last-course', event.target.value);
                    setCourseId(Number(event.target.value));
                    setSelectedSources([]);
                    setSourceQuery('');
                  }}
                  value={course?.id ?? ''}
                >
                  {state.courses.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Button
              aria-label="刷新学习中心"
              disabled={loading}
              onClick={() => setReload((value) => value + 1)}
              size="icon"
              title="刷新学习中心"
              variant="ghost"
            >
              <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
            </Button>
          </div>
        </header>

        {error && (
          <p className="rounded-control bg-red-tint px-3 py-2 text-13 text-red" role="alert">
            {error}
          </p>
        )}
        {historyCount > 0 && (
          <details className="rounded-control border border-line bg-inset text-ink-3">
            <summary className="cursor-pointer rounded-control px-3 py-2 text-xs focus-visible:outline-2 focus-visible:outline-bui-accent">
              上次同步记录 · {dateLabel(syncHistory!.syncedAt)} · {historyCount} 项
            </summary>
            <div className="space-y-3 px-3 pb-3 text-xs leading-relaxed">
              <p>这是上次同步所有课程时的记录，不代表当前课程缺少这些资料。</p>
              {historyGroups.map((group) => (
                <div key={group.label}>
                  <h2 className="font-medium text-ink-2">
                    {group.label} · {group.values.length} 项
                  </h2>
                  <ul className="mt-1 list-inside list-disc space-y-1">
                    {group.values.map((value, index) => (
                      <li key={`${index}-${value}`}>{value}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </details>
        )}
        {state && state.warnings.length > 0 && (
          <details className="rounded-control bg-orange-tint text-orange">
            <summary className="cursor-pointer rounded-control px-3 py-2 text-xs focus-visible:outline-2 focus-visible:outline-bui-accent">
              学习资料有 {state.warnings.length} 项提示
            </summary>
            <div className="px-1 pb-1">
              <Warnings values={state.warnings} />
            </div>
          </details>
        )}
        {course && course.sources.some((source) => source.warning) && (
          <details className="rounded-control bg-orange-tint text-orange">
            <summary className="cursor-pointer rounded-control px-3 py-2 text-xs focus-visible:outline-2 focus-visible:outline-bui-accent">
              本课程有 {course.sources.filter((source) => source.warning).length} 份资料需要处理
            </summary>
            <div className="px-1 pb-1">
              <Warnings
                values={course.sources.flatMap((source) =>
                  source.warning ? [`${source.title}：${source.warning}`] : [],
                )}
              />
            </div>
          </details>
        )}
        {course && course.sources.length > 0 && (
          <details className="rounded-control border border-line bg-inset text-ink-3">
            <summary className="cursor-pointer rounded-control px-3 py-2 text-xs focus-visible:outline-2 focus-visible:outline-bui-accent">
              资料来源 ·{' '}
              {sourceOrigins
                .map(
                  ({ origin, label }) =>
                    `${label} ${course.sources.filter((source) => (source.origin ?? 'canvas') === origin).length}`,
                )
                .join(' / ')}
            </summary>
            <div className="space-y-3 px-3 pb-3 text-xs leading-relaxed">
              <p>Canvas、微信和本地参考资料都可用于学习；学习笔记与作业成果独立管理。</p>
              <ul className="space-y-2">
                {course.sources.map((source) => (
                  <li className="rounded-control bg-surface p-2" key={source.sourceId}>
                    <div className="flex items-start justify-between gap-2">
                      {source.localPath ? (
                        <button
                          className="flex min-w-0 items-start gap-1.5 text-left text-13 text-ink-2 hover:underline focus-visible:outline-2 focus-visible:outline-bui-accent"
                          onClick={() => openFile(course, source.localPath!)}
                          type="button"
                        >
                          <span className="break-all">{source.title}</span>
                          <ArrowUpRight className="mt-0.5 size-3.5 shrink-0" />
                        </button>
                      ) : (
                        <span className="text-13 text-ink-2">{source.title}</span>
                      )}
                      <span className="shrink-0">
                        {
                          sourceOrigins.find(
                            ({ origin }) => origin === (source.origin ?? 'canvas'),
                          )!.label
                        }
                      </span>
                    </div>
                    {source.provenance && <p className="mt-1">{source.provenance}</p>}
                    {source.notice && <p className="mt-1">{source.notice}</p>}
                  </li>
                ))}
              </ul>
            </div>
          </details>
        )}
        <LearningJobProgress />
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
          <SegmentedControl
            className="min-w-60"
            onChange={setTab}
            options={['作业', '笔记', '练习']}
            value={tab}
          />
        </div>
        {tab === '作业' && <CanvasAssignments state={state} reload={reload} />}
        {!state && loading ? (
          <p className="py-16 text-center text-13 text-ink-3">正在读取课程与学习记录…</p>
        ) : !state && error ? (
          <p className="py-16 text-center text-13 text-ink-3">读取失败，请点击右上角刷新后重试。</p>
        ) : !course ? (
          <div className="mx-auto flex max-w-lg flex-col items-center gap-3 rounded-card border border-line py-12 text-center">
            <GraduationCap className="size-8 text-ink-3" />
            <h2 className="text-15 font-medium">从一门课程开始</h2>
            <p className="px-6 text-13 leading-relaxed text-ink-3">
              在资料页同步 Canvas，将课程资料添加到项目后，即可在这里完成作业、整理笔记和安排复习。
            </p>
            <Button onClick={() => useNavigationStore.getState().openProject('')} variant="outline">
              打开课程资料
              <ArrowUpRight className="size-4" />
            </Button>
          </div>
        ) : (
          <>
            <section
              aria-label="开始学习工作"
              className="grid grid-cols-3 gap-3 max-lg:grid-cols-1"
            >
              {[
                {
                  action: 'assignment' as const,
                  label: '完成作业',
                  icon: ClipboardCheck,
                  description: '所有课程的 Canvas 未提交作业',
                  detail: '勾选作业后直接处理，在当前页面查看进度',
                },
                {
                  action: 'notes' as const,
                  label: '整理笔记',
                  icon: BookOpen,
                  description: '选择一份或多份资料，一键整理笔记',
                  detail: `${notes.length} 份已登记笔记`,
                },
                {
                  action: 'study' as const,
                  label: '带我学习',
                  icon: GraduationCap,
                  description: '讲解、提问、反馈，把理解落到练习',
                  detail: `${due.length} 道练习到期`,
                },
              ].map(({ action, label, icon: Icon, description, detail }) => (
                <button
                  className="group flex items-start gap-3 rounded-card border border-line p-4 text-left transition-colors hover:border-line-strong hover:bg-hover disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-bui-accent"
                  disabled={starting}
                  key={action}
                  onClick={() => {
                    if (action === 'assignment') setTab('作业');
                    else if (action === 'notes') setTab('笔记');
                    else void start(action);
                  }}
                  type="button"
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-control bg-inset text-ink-2">
                    <Icon className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between text-15 font-medium">
                      {label}
                      <ArrowUpRight className="size-4 text-ink-3" />
                    </span>
                    <span className="mt-1 block text-xs leading-relaxed text-ink-3">
                      {description}
                    </span>
                    <span className="mt-3 block text-xs text-ink-2">{detail}</span>
                  </span>
                </button>
              ))}
            </section>
            {tab === '作业' && tasks.length > 0 && (
              <details className="space-y-4 rounded-card border border-line p-4">
                <summary className="cursor-pointer text-13 text-ink-3">
                  本地作业记录 · {course.name} · {tasks.length} 项（与 Canvas 提交状态分别记录）
                </summary>
                <section aria-label="本地作业记录" className="space-y-4">
                  {tasks.map((task) => (
                    <article
                      className="space-y-4 rounded-card border border-line p-5"
                      key={task.id}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h2 className="text-15 font-semibold">{task.title}</h2>
                          <p className="mt-1 text-xs text-ink-3">截止 {dateLabel(task.dueAt)}</p>
                        </div>
                        <StatusPill tone={task.status === 'checked' ? 'green' : 'orange'}>
                          {task.status === 'checked' ? '已复核' : '待完成与复核'}
                        </StatusPill>
                      </div>
                      <Warnings values={task.warnings} />
                      {task.requirements.length ? (
                        <ul className="space-y-3">
                          {task.requirements.map((requirement) => (
                            <li className="flex items-start gap-2 text-13" key={requirement.id}>
                              {requirement.status === 'met' ? (
                                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green" />
                              ) : (
                                <Circle className="mt-0.5 size-4 shrink-0 text-ink-3" />
                              )}
                              <div>
                                <p className="leading-relaxed">{requirement.text}</p>
                                <p className="mt-0.5 text-xs text-ink-3">
                                  {requirement.status === 'met' ? '已有成果与证据' : '尚待落实'} ·{' '}
                                  {requirement.deliverableIds.length} 份成果 ·{' '}
                                  {requirement.evidenceIds.length} 项证据
                                </p>
                              </div>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-13 text-ink-3">
                          尚未提取作业要求，继续工作时先核对原始说明。
                        </p>
                      )}
                      {task.findings.some((finding) => finding.status === 'open') && (
                        <div className="rounded-control bg-inset p-3">
                          <h3 className="text-xs font-medium text-ink-2">待解决问题</h3>
                          <ul className="mt-2 space-y-1 text-13 text-ink-2">
                            {task.findings
                              .filter((finding) => finding.status === 'open')
                              .map((finding) => (
                                <li key={finding.id}>· {finding.text}</li>
                              ))}
                          </ul>
                        </div>
                      )}
                      {task.checks.length > 0 && (
                        <div className="space-y-2 rounded-control bg-inset p-3">
                          <h3 className="text-xs font-medium text-ink-2">复核结果</h3>
                          {task.checks.map((check) => (
                            <p className="text-13 leading-relaxed text-ink-2" key={check.kind}>
                              <span className="font-medium">
                                {
                                  {
                                    requirements: '要求检查',
                                    sources: '来源核对',
                                    calculations: '计算验证',
                                  }[check.kind]
                                }{' '}
                                · {check.status === 'passed' ? '已通过' : '不适用'}
                              </span>
                              <span className="mt-0.5 block text-xs text-ink-3">
                                {check.description}
                              </span>
                            </p>
                          ))}
                        </div>
                      )}
                      {(task.deliverables.length > 0 || task.evidence.length > 0) && (
                        <div className="flex flex-wrap gap-2">
                          {[...task.deliverables, ...task.evidence].map((file) => (
                            <Button
                              key={file.id}
                              onClick={() => openFile(course, file.path)}
                              size="sm"
                              title={file.description}
                              variant="outline"
                            >
                              <FileText className="size-3.5" />
                              {file.description || file.path.split(/[\\/]/).at(-1)}
                            </Button>
                          ))}
                        </div>
                      )}
                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
                        <p className="text-xs text-ink-3">
                          {task.checkedAt
                            ? `上次复核 ${dateLabel(task.checkedAt)}`
                            : '完成后将核对成果、要求与检查证据'}
                        </p>
                      </div>
                    </article>
                  ))}
                </section>
              </details>
            )}
            {tab === '笔记' && (
              <section aria-label="课程笔记" className="space-y-3">
                {materials.length > 0 && (
                  <section
                    aria-label="选择笔记资料"
                    className="space-y-3 rounded-card border border-line p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h2 className="text-15 font-medium">选择要整理的资料</h2>
                        <p className="mt-1 text-xs text-ink-3">
                          可选一份或多份，自动沿用相关的已有笔记。
                        </p>
                      </div>
                      <Button
                        disabled={starting || selectedMaterials.length === 0}
                        onClick={() =>
                          void start('notes', undefined, { sources: selectedMaterials })
                        }
                        size="sm"
                        variant="outline"
                      >
                        整理所选笔记
                      </Button>
                    </div>
                    <input
                      aria-label="筛选笔记资料"
                      className="h-8 w-full rounded-control bg-field px-3 text-13 shadow-hairline outline-none focus-visible:outline-2 focus-visible:outline-bui-accent"
                      placeholder="搜索资料名称…"
                      value={sourceQuery}
                      onChange={(event) => setSourceQuery(event.target.value)}
                    />
                    <div className="max-h-64 space-y-1 overflow-y-auto">
                      {visibleMaterials.map((source) => (
                        <label
                          className="flex cursor-pointer items-start gap-3 rounded-control px-2 py-2 hover:bg-hover"
                          key={source.sourceId}
                        >
                          <input
                            type="checkbox"
                            aria-label={`选择资料：${source.title}`}
                            className="mt-0.5 size-4 shrink-0 accent-bui-accent"
                            checked={selectedSources.includes(source.sourceId)}
                            onChange={(event) =>
                              setSelectedSources((previous) =>
                                event.target.checked
                                  ? [...previous, source.sourceId]
                                  : previous.filter((id) => id !== source.sourceId),
                              )
                            }
                          />
                          <span className="min-w-0 text-13">
                            <span className="block break-words">{source.title}</span>
                            <span className="mt-0.5 block text-xs text-ink-3">
                              {coveredSources.has(source.sourceId) ? '已有相关笔记' : '尚未整理'}
                            </span>
                          </span>
                        </label>
                      ))}
                      {!visibleMaterials.length && (
                        <p className="py-3 text-xs text-ink-3">没有匹配的资料</p>
                      )}
                    </div>
                    <div className="flex items-center justify-between text-xs text-ink-3">
                      <p aria-live="polite">已选 {selectedMaterials.length} 份资料</p>
                      {selectedMaterials.length > 0 && (
                        <button
                          className="hover:underline"
                          onClick={() => setSelectedSources([])}
                          type="button"
                        >
                          清空选择
                        </button>
                      )}
                    </div>
                  </section>
                )}
                {uncoveredSources.length > 0 && (
                  <details className="rounded-card border border-line bg-inset p-4">
                    <summary className="cursor-pointer text-13 font-medium focus-visible:outline-2 focus-visible:outline-bui-accent">
                      尚未纳入笔记的资料 · {uncoveredSources.length} 份
                    </summary>
                    <p className="mt-1 text-xs text-ink-3">
                      可在继续整理时选择补充；参考资料也可以保留原样。
                    </p>
                    <ul className="mt-3 space-y-1">
                      {uncoveredSources.map((source) => (
                        <li key={source.sourceId}>
                          <button
                            className="flex w-full items-center justify-between gap-2 rounded-control px-2 py-1.5 text-left text-13 text-ink-2 hover:bg-hover focus-visible:outline-2 focus-visible:outline-bui-accent"
                            onClick={() => openFile(course, source.localPath!)}
                            type="button"
                          >
                            <span className="min-w-0 truncate">{source.title}</span>
                            <ArrowUpRight className="size-3.5 shrink-0" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {!notes.length ? (
                  <EmptyState
                    text="还没有课程笔记"
                    detail="勾选上方资料，再点击「整理所选笔记」。本地文件也可从项目文件列表直接开始。"
                  />
                ) : (
                  notes.map((note) => (
                    <article
                      className="space-y-3 rounded-card border border-line p-5"
                      key={note.id}
                    >
                      <div className="flex items-start gap-3">
                        <BookOpen className="mt-0.5 size-5 text-ink-3" />
                        <div className="min-w-0 flex-1">
                          <h2 className="text-15 font-medium">{note.title}</h2>
                          <p className="mt-1 text-xs text-ink-3">
                            覆盖 {note.coveredSources.length} 份资料 · 更新于{' '}
                            {dateLabel(note.updatedAt)}
                          </p>
                        </div>
                      </div>
                      <Warnings values={note.warnings} />
                      <div className="flex justify-end gap-2">
                        <Button
                          disabled={starting}
                          onClick={() => void start('notes', note)}
                          size="sm"
                          variant="ghost"
                        >
                          {note.warnings.length ? '核对来源并更新' : '继续整理'}
                        </Button>
                        <Button
                          onClick={() => openFile(course, note.path)}
                          size="sm"
                          variant="outline"
                        >
                          打开笔记
                          <ArrowUpRight className="size-3.5" />
                        </Button>
                      </div>
                    </article>
                  ))
                )}
              </section>
            )}
            {tab === '练习' && (
              <section aria-label="课程练习" className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-15 font-medium">今天待复习 · {due.length} 题</h2>
                  {upcoming[0] && (
                    <p className="text-xs text-ink-3">下一次复习 {dateLabel(upcoming[0].dueAt)}</p>
                  )}
                </div>
                {!due.length ? (
                  <EmptyState
                    text={practice.length ? '到期练习已完成' : '还没有练习题'}
                    detail={
                      practice.length
                        ? '可以回顾笔记，或点击「带我学习」继续一个新主题。'
                        : '点击「带我学习」，从讲解到独立作答，逐步建立练习记录。'
                    }
                  />
                ) : (
                  due.map((card) => (
                    <PracticeReview
                      card={card}
                      key={card.id}
                      onSubmit={async (input) => {
                        const next = await window.dela!.learning.submitPracticeAttempt(input);
                        setState(next);
                        showToast({ variant: 'success', title: '已记录作答，下一次复习已安排' });
                      }}
                    />
                  ))
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function EmptyState({ text, detail }: { text: string; detail: string }) {
  return (
    <div className="rounded-card border border-dashed border-line px-5 py-10 text-center">
      <p className="text-13 font-medium text-ink-2">{text}</p>
      <p className="mt-2 text-xs leading-relaxed text-ink-3">{detail}</p>
    </div>
  );
}
