import { useEffect, useState } from 'react';
import type { ContextNote } from '../../../../shared/context';
import { Button } from '../../../components/ui/button';
import { errorText, useWorkspaceStore } from '../../../workspace/store';

export function ContextSettings() {
  const [notes, setNotes] = useState<ContextNote[]>([]);
  const [courses, setCourses] = useState<{ id: number; name: string }[]>([]);
  const projects = useWorkspaceStore((state) => state.workspace.entries).filter(
    (entry) => entry.kind === 'project',
  );
  const [editing, setEditing] = useState<string | undefined>();
  const [scope, setScope] = useState<ContextNote['scope']>('personal');
  const [scopeId, setScopeId] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const load = async () => {
    if (!window.dela?.context) return;
    try {
      setNotes(await window.dela.context.list());
      setCourses((await window.dela.learning.getState()).courses);
      setLoaded(true);
      setError('');
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const reset = () => {
    setEditing(undefined);
    setTitle('');
    setContent('');
  };
  const save = async () => {
    if (!window.dela || busy) return;
    setBusy(true);
    try {
      setNotes(await window.dela.context.save({ id: editing, scope, scopeId, title, content }));
      reset();
      setError('');
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    if (!window.dela || busy) return;
    setBusy(true);
    try {
      setNotes(await window.dela.context.remove(id));
      if (editing === id) reset();
      setError('');
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const field = 'w-full rounded-control bg-field p-2 text-13 shadow-hairline';
  return (
    <section aria-label="偏好与约定" className="space-y-4">
      <div>
        <h2 className="text-15 font-medium">偏好与约定</h2>
        <p className="mt-1 text-13 text-ink-3">
          只记住你在这里保存的内容。个人偏好用于各任务，课程和项目约定只带入对应工作；详细资料仍保存在文件中。
        </p>
      </div>
      {error && (
        <p role="alert" className="text-13 text-red">
          {error}{' '}
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            重新读取
          </Button>
        </p>
      )}
      {!loaded && !error && <p className="text-13 text-ink-3">正在读取约定…</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-ink-3">
          适用范围
          <select
            aria-label="约定适用范围"
            className={field}
            value={scope}
            onChange={(event) => {
              setScope(event.target.value as ContextNote['scope']);
              setScopeId('');
            }}
          >
            <option value="personal">个人偏好</option>
            <option value="course">课程约定</option>
            <option value="project">项目约定</option>
          </select>
        </label>
        {scope !== 'personal' && (
          <label className="text-xs text-ink-3">
            关联对象
            <select
              aria-label="约定关联对象"
              className={field}
              value={scopeId}
              onChange={(event) => setScopeId(event.target.value)}
            >
              <option value="">请选择</option>
              {(scope === 'course' ? courses : projects).map((item) => (
                <option key={item.id} value={String(item.id)}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <input
        aria-label="约定标题"
        className={field}
        placeholder="例如：笔记应保留公式推导"
        maxLength={120}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <textarea
        aria-label="约定内容"
        className={`${field} min-h-28`}
        placeholder="写下希望长期沿用的偏好或要求"
        maxLength={6000}
        value={content}
        onChange={(event) => setContent(event.target.value)}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy || !title.trim() || !content.trim() || (scope !== 'personal' && !scopeId)}
          onClick={() => void save()}
        >
          {editing ? '保存修改' : '保存约定'}
        </Button>
        {editing && (
          <Button size="sm" variant="ghost" onClick={reset}>
            取消编辑
          </Button>
        )}
      </div>
      {loaded && !notes.length && (
        <p className="text-13 text-ink-3">还没有保存约定。临时对话不会自动加入这里。</p>
      )}
      <div className="space-y-2">
        {notes.map((note) => (
          <article key={note.id} className="rounded-control border border-line p-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-13 font-medium">{note.title}</h3>
              <span className="text-xs text-ink-3">
                {note.scope === 'personal'
                  ? '个人'
                  : note.scope === 'course'
                    ? (courses.find((item) => String(item.id) === note.scopeId)?.name ?? '课程')
                    : (projects.find((item) => item.id === note.scopeId)?.name ?? '项目')}
              </span>
            </div>
            <p className="my-2 whitespace-pre-wrap text-13 text-ink-2">{note.content}</p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setEditing(note.id);
                  setScope(note.scope);
                  setScopeId(note.scopeId);
                  setTitle(note.title);
                  setContent(note.content);
                }}
              >
                编辑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void remove(note.id)}
              >
                移除约定
              </Button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
