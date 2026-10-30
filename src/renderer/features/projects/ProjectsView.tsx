import { useEffect, useState } from 'react';
import type {
  ProjectAction,
  ProjectGitReview,
  ProjectOverview,
  ProjectSaveInput,
  ProjectsState,
} from '../../../shared/projects';
import type { TodoItem } from '../../../shared/todo';
import { Button } from '../../components/ui/button';
import { useNavigationStore } from '../../navigation/view';
import { errorText } from '../../workspace/store';
import { LearningJobProgress } from '../learning/LearningJobProgress';

const inputClass =
  'w-full rounded-control border border-line bg-field px-3 py-2 text-13 outline-none focus:border-bui-accent';
const types = { course: '课程', research: '研究', code: '编程', internship: '实习' };
const labels = {
  continue: '继续任务',
  organize: '整理资料',
  review: '检查项目成果',
  summary: '生成进展总结',
};
const unsavedProfiles = new Map<string, ProjectSaveInput>();
function profileOf(project: ProjectOverview): ProjectSaveInput {
  const {
    name: _name,
    directory: _directory,
    remote: _remote,
    warning: _warning,
    updatedAt: expectedUpdatedAt,
    ...profile
  } = project;
  return { ...profile, expectedUpdatedAt };
}

function ProjectEditor({
  project,
  onSaved,
}: {
  project: ProjectOverview;
  onSaved: (state: ProjectsState) => void;
}) {
  const [draft, setDraft] = useState(
    () => unsavedProfiles.get(project.projectId) ?? profileOf(project),
  );
  const [dirty, setDirty] = useState(() => unsavedProfiles.has(project.projectId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [tasks, setTasks] = useState<TodoItem[]>([]);
  const [taskTitle, setTaskTitle] = useState('');
  const [referencePath, setReferencePath] = useState('');
  const [referenceKind, setReferenceKind] = useState<'source' | 'deliverable'>('source');
  const [milestoneTitle, setMilestoneTitle] = useState('');
  const [review, setReview] = useState<ProjectGitReview | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [commitMessage, setCommitMessage] = useState('');
  const [reviewed, setReviewed] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(profileOf(project));
  }, [project, dirty]);
  useEffect(() => {
    const api = window.dela?.todo;
    if (!api) return;
    let active = true;
    const accept = (items: TodoItem[]) => {
      if (active)
        setTasks(items.filter((item) => item.projectId === project.projectId && !item.archived));
    };
    void api
      .getState()
      .then((state) => accept(state.items))
      .catch((reason) => {
        if (active) setError(errorText(reason));
      });
    const unsubscribe = api.onUpdate((state) => accept(state.items));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [project.projectId]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  const update = (patch: Partial<ProjectSaveInput>) => {
    setDraft((value) => {
      const next = { ...value, ...patch };
      unsavedProfiles.set(project.projectId, next);
      return next;
    });
    setDirty(true);
    setNotice('');
  };
  const perform = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await fn();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    onSaved(await window.dela!.projects.save(draft));
    unsavedProfiles.delete(project.projectId);
    setDirty(false);
    setNotice('项目记录已保存');
  };
  const launch = (action: ProjectAction, taskId?: string) =>
    void perform(async () => {
      if (dirty) await save();
      const input = await window.dela!.projects.prepareAction(project.projectId, action, taskId);
      await window.dela!.jobs.enqueue(input);
      setNotice('已加入任务中心，可在这里查看进度');
    });
  const inspectGit = async () => {
    const result = await window.dela!.projects.gitReview(project.projectId);
    setReview(result);
    setSelectedFiles([]);
    setReviewed(false);
  };
  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{project.name}</h2>
          <p className="mt-1 break-all text-xs text-ink-3">{project.directory ?? '目录不可用'}</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => useNavigationStore.getState().openProject(project.projectId)}
          >
            打开文件工作台
          </Button>
          <Button
            variant="ghost"
            onClick={() => useNavigationStore.getState().openTerminal(project.projectId)}
          >
            项目终端
          </Button>
        </div>
      </div>
      {project.warning && (
        <p role="alert" className="text-13 text-orange">
          {project.warning}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-control bg-red-tint p-3 text-13 text-red">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-13 text-ink-2">
          {notice}
        </p>
      )}
      <section className="rounded-card border border-line p-4 space-y-4" aria-label="项目概况">
        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          <label className="space-y-1 text-xs text-ink-3">
            项目类型
            <select
              className={inputClass}
              value={draft.type}
              onChange={(event) => update({ type: event.target.value as ProjectSaveInput['type'] })}
            >
              {Object.entries(types).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs text-ink-3">
            当前阶段
            <input
              className={inputClass}
              value={draft.stage}
              onChange={(event) => update({ stage: event.target.value })}
            />
          </label>
        </div>
        {(
          [
            ['goal', '目标'],
            ['successCriteria', '成功标准'],
            ['nextStep', '下一步'],
            ['conventions', '项目约定与偏好'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="block space-y-1 text-xs text-ink-3">
            {label}
            <textarea
              className={inputClass}
              rows={key === 'nextStep' ? 2 : 3}
              value={draft[key]}
              onChange={(event) => update({ [key]: event.target.value })}
            />
          </label>
        ))}
        <div className="flex items-center gap-3">
          <Button disabled={busy || !dirty} onClick={() => void perform(save)}>
            保存项目记录
          </Button>
          {dirty && (
            <>
              <span className="text-xs text-orange">有未保存的修改</span>
              <Button
                variant="ghost"
                onClick={() => {
                  unsavedProfiles.delete(project.projectId);
                  setDirty(false);
                  setDraft(profileOf(project));
                }}
              >
                放弃修改
              </Button>
            </>
          )}
        </div>
      </section>
      <section aria-label="项目操作" className="flex flex-wrap gap-2">
        {(Object.keys(labels) as ProjectAction[]).map((action) => (
          <Button
            key={action}
            variant="outline"
            disabled={busy || !project.directory}
            onClick={() => launch(action)}
          >
            {labels[action]}
          </Button>
        ))}
      </section>
      <LearningJobProgress domain="project" projectId={project.projectId} />
      <section className="rounded-card border border-line p-4 space-y-3" aria-label="项目里程碑">
        <h3 className="font-medium">里程碑</h3>
        {!draft.milestones.length && (
          <p className="text-xs text-ink-3">添加可检查的阶段目标，实际完成后再勾选。</p>
        )}
        {draft.milestones.map((item) => (
          <div className="flex flex-wrap items-center gap-2" key={item.id}>
            <input
              type="checkbox"
              aria-label={`完成里程碑：${item.title}`}
              checked={item.completed}
              onChange={(event) =>
                update({
                  milestones: draft.milestones.map((value) =>
                    value.id === item.id ? { ...value, completed: event.target.checked } : value,
                  ),
                })
              }
            />
            <span className="flex-1 text-13">{item.title}</span>
            <input
              aria-label={`截止日期：${item.title}`}
              className={`${inputClass} !w-auto`}
              type="date"
              value={item.dueAt?.slice(0, 10) ?? ''}
              onChange={(event) =>
                update({
                  milestones: draft.milestones.map((value) =>
                    value.id === item.id
                      ? {
                          ...value,
                          dueAt: event.target.value
                            ? new Date(`${event.target.value}T23:59:00`).toISOString()
                            : null,
                        }
                      : value,
                  ),
                })
              }
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                update({ milestones: draft.milestones.filter((value) => value.id !== item.id) })
              }
            >
              移除
            </Button>
          </div>
        ))}
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!milestoneTitle.trim()) return;
            update({
              milestones: [
                ...draft.milestones,
                {
                  id: crypto.randomUUID(),
                  title: milestoneTitle.trim(),
                  dueAt: null,
                  completed: false,
                },
              ],
            });
            setMilestoneTitle('');
          }}
        >
          <input
            aria-label="新里程碑"
            className={inputClass}
            placeholder="例如：完成原型并通过测试"
            value={milestoneTitle}
            onChange={(event) => setMilestoneTitle(event.target.value)}
          />
          <Button type="submit" variant="outline">
            添加里程碑
          </Button>
        </form>
      </section>
      <section className="rounded-card border border-line p-4 space-y-3" aria-label="项目待办">
        <h3 className="font-medium">项目任务</h3>
        <p className="text-xs text-ink-3">与今天、生活中的统一待办共用记录。</p>
        {tasks.length === 0 && <p className="text-13 text-ink-3">还没有项目任务。</p>}
        {tasks.map((item) => (
          <div key={item.id} className="flex items-center gap-2">
            <input
              aria-label={`完成任务：${item.title}`}
              type="checkbox"
              checked={item.status === 'completed'}
              disabled={busy}
              onChange={(event) =>
                void perform(async () => {
                  await window.dela!.todo.save({
                    id: item.id,
                    title: item.title,
                    completed: event.target.checked,
                  });
                })
              }
            />
            <span className="min-w-0 flex-1 break-words text-13">{item.title}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || item.status === 'completed'}
              onClick={() => launch('continue', item.id)}
            >
              继续任务
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await window.dela!.todo.save({ id: item.id, title: item.title, archived: true });
                })
              }
            >
              归档
            </Button>
          </div>
        ))}
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!taskTitle.trim()) return;
            void perform(async () => {
              await window.dela!.todo.save({
                title: taskTitle.trim(),
                area: 'project',
                projectId: project.projectId,
              });
              setTaskTitle('');
            });
          }}
        >
          <input
            aria-label="新项目任务"
            className={inputClass}
            value={taskTitle}
            onChange={(event) => setTaskTitle(event.target.value)}
            placeholder="下一件具体要做的事"
          />
          <Button type="submit" disabled={busy} variant="outline">
            添加任务
          </Button>
        </form>
      </section>
      <section
        className="rounded-card border border-line p-4 space-y-3"
        aria-label="项目资料与成果"
      >
        <h3 className="font-medium">资料与成果</h3>
        <p className="text-xs text-ink-3">关联原文件，不移动或复制。成果登记与检查通过分别记录。</p>
        {draft.references.map((ref) => (
          <div key={ref.id} className="flex items-center gap-2">
            <span className="text-xs text-ink-3">{ref.kind === 'source' ? '资料' : '成果'}</span>
            <Button
              className="min-w-0 !whitespace-normal break-all text-left"
              variant="link"
              onClick={() => {
                const nav = useNavigationStore.getState();
                if (nav.openProject(project.projectId)) nav.openDocument(ref.path, { keep: true });
              }}
            >
              {ref.title}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                update({ references: draft.references.filter((value) => value.id !== ref.id) })
              }
            >
              解除关联
            </Button>
          </div>
        ))}
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const path = referencePath.trim();
            if (!path) return;
            update({
              references: [
                ...draft.references,
                {
                  id: crypto.randomUUID(),
                  title: path.split(/[\\/]/).at(-1) ?? path,
                  path,
                  kind: referenceKind,
                },
              ],
            });
            setReferencePath('');
          }}
        >
          <select
            aria-label="关联文件类型"
            className={`${inputClass} !w-auto`}
            value={referenceKind}
            onChange={(event) => setReferenceKind(event.target.value as 'source' | 'deliverable')}
          >
            <option value="source">资料</option>
            <option value="deliverable">成果</option>
          </select>
          <input
            aria-label="关联文件路径"
            className={`${inputClass} flex-1`}
            value={referencePath}
            onChange={(event) => setReferencePath(event.target.value)}
            placeholder="输入文件绝对路径或项目内相对路径"
          />
          <Button type="submit" variant="outline">
            关联文件
          </Button>
        </form>
      </section>
      <details className="rounded-card border border-line p-4" aria-label="项目 Git 同步">
        <summary className="cursor-pointer font-medium">Git 改动与同步</summary>
        <div className="mt-4 space-y-3">
          <p className="text-xs text-ink-3">
            只同步你为这个项目设置并选中的文件。先保存范围，再查看改动；课程资料和个人记录不会自动加入。
          </p>
          <label className="block text-xs text-ink-3">
            允许同步的相对路径（每行一项）
            <textarea
              className={inputClass}
              value={draft.syncPaths.join('\n')}
              onChange={(event) =>
                update({
                  syncPaths: event.target.value
                    .split('\n')
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
              }
              placeholder={'src\nREADME.md'}
            />
          </label>
          <Button
            disabled={busy}
            variant="outline"
            onClick={() =>
              void perform(async () => {
                if (dirty) await save();
                await inspectGit();
              })
            }
          >
            查看当前改动
          </Button>
          {review &&
            (!review.available ? (
              <p className="text-13 text-ink-3">{review.reason}</p>
            ) : (
              <>
                <p className="break-all text-13">
                  分支：{review.branch ?? '未选择'} · 远程：{review.remote ?? '未配置'}
                </p>
                {review.pendingCommits.length > 0 && (
                  <p className="text-xs text-orange">
                    已有 {review.pendingCommits.length} 个未推送提交，请在项目终端核对并同步。
                  </p>
                )}
                {review.changes.length === 0 && (
                  <p className="text-xs text-ink-3">当前没有文件改动。</p>
                )}
                {review.changes.map((change) => (
                  <label className="flex items-center gap-2 text-13" key={change.path}>
                    <input
                      type="checkbox"
                      disabled={!change.allowed || busy}
                      checked={selectedFiles.includes(change.path)}
                      onChange={(event) => {
                        setSelectedFiles((values) =>
                          event.target.checked
                            ? [...values, change.path]
                            : values.filter((value) => value !== change.path),
                        );
                        setReviewed(false);
                      }}
                    />
                    <span className="break-all">
                      {change.status} {change.path}
                      {!change.allowed ? ' · 不在可同步范围' : ''}
                    </span>
                  </label>
                ))}
                <pre className="max-h-72 overflow-auto rounded-control bg-inset p-3 text-xs">
                  {review.diff || '没有可显示的文本差异；新文件请打开文件核对内容。'}
                </pre>
                <input
                  aria-label="提交说明"
                  className={inputClass}
                  value={commitMessage}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  placeholder="说明这次修改的目的"
                />
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={reviewed}
                    onChange={(event) => setReviewed(event.target.checked)}
                  />
                  已查看选中文件并完成必要检查，确认同步到上方远程仓库
                </label>
                <Button
                  disabled={
                    busy ||
                    !reviewed ||
                    !selectedFiles.length ||
                    !commitMessage.trim() ||
                    !review.head ||
                    !review.remote ||
                    review.pendingCommits.length > 0
                  }
                  onClick={() =>
                    void perform(async () => {
                      try {
                        await window.dela!.projects.sync({
                          projectId: project.projectId,
                          expectedHead: review.head!,
                          expectedDigest: review.digest,
                          message: commitMessage,
                          paths: selectedFiles,
                        });
                        setNotice('已提交并同步');
                      } finally {
                        await inspectGit();
                      }
                    })
                  }
                >
                  提交并同步所选文件
                </Button>
              </>
            ))}
        </div>
      </details>
    </div>
  );
}

export function ProjectsView() {
  const [state, setState] = useState<ProjectsState | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setState(await window.dela!.projects.getState());
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (!window.dela?.projects) return;
    void load();
    return window.dela.projects.onUpdate(setState);
  }, []);
  const project = state?.projects.find((item) => item.projectId === selected) ?? state?.projects[0];
  return (
    <div className="h-full overflow-y-auto bg-surface">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-7 max-md:px-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">项目</h1>
            <p className="mt-1 text-13 text-ink-3">明确目标，推进下一步，保留可检查的成果。</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void load()} disabled={loading}>
              刷新
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                void window.dela?.workspace
                  .importProjectFolder()
                  .then(async (item) => {
                    if (item) {
                      setSelected(item.id);
                      await load();
                    }
                  })
                  .catch((reason) => setError(errorText(reason)))
              }
            >
              关联已有文件夹
            </Button>
            <Button onClick={() => useNavigationStore.getState().newProject()}>新建项目</Button>
          </div>
        </header>
        {error && (
          <p role="alert" className="text-red">
            {error}
          </p>
        )}
        {loading && !state ? (
          <p role="status">正在读取项目…</p>
        ) : !state?.projects.length ? (
          <div className="rounded-card border border-line p-8 text-center text-ink-3">
            先关联一个现有文件夹，或创建新项目。文件会保留在原位置。
          </div>
        ) : (
          <>
            <label className="block text-xs text-ink-3">
              选择项目
              <select
                aria-label="选择项目"
                className={`${inputClass} mt-1 max-w-md`}
                value={project?.projectId ?? ''}
                onChange={(event) => setSelected(event.target.value)}
              >
                {state.projects.map((item) => (
                  <option value={item.projectId} key={item.projectId}>
                    {item.name} · {types[item.type]}
                  </option>
                ))}
              </select>
            </label>
            {project && (
              <ProjectEditor key={project.projectId} project={project} onSaved={setState} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
