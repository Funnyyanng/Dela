import { useEffect, useState } from 'react';
import { Dialog } from 'radix-ui';
import { FolderOpen, Loader2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { dialogOverlay, dialogPanel } from '../components/ui/motion';
import { errorText, useWorkspaceStore } from '../workspace/store';
import { groupCanvasCoursesByTerm, latestTermOf } from '../../shared/canvas';
import type { CanvasLocalSyncResult, CanvasLocalSyncState } from '../../shared/canvas-local';
import { cn } from '../lib/utils';

export function CanvasLocalSyncDialog({ onClose }: { onClose: () => void }) {
  const courses = useWorkspaceStore((state) => state.canvas.courses);
  const [binding, setBinding] = useState<CanvasLocalSyncState | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CanvasLocalSyncResult | null>(null);

  useEffect(() => {
    let active = true;
    void window
      .dela!.canvas.localSyncState()
      .then((state) => {
        if (!active) return;
        setBinding(state);
        setResult(state?.lastResult ?? null);
        const latest = latestTermOf(courses);
        setSelected(
          new Set(
            state?.courseIds ??
              courses
                .filter((course) => course.term === latest && !course.archived)
                .map((course) => course.id),
          ),
        );
      })
      .catch((cause) => {
        if (active) setError(errorText(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [courses]);

  const configure = async () => {
    setBusy(true);
    setError(null);
    try {
      const state = await window.dela!.canvas.configureLocalSync([...selected]);
      if (state) {
        setBinding(state);
        setResult(state.lastResult ?? null);
        await useWorkspaceStore.getState().refresh();
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const sync = async () => {
    if (!binding) return;
    setBusy(true);
    setError(null);
    try {
      const state = await window.dela!.canvas.configureLocalSync([...selected], binding.root);
      if (!state) return;
      setBinding(state);
      const next = await window.dela!.canvas.syncLocal();
      setResult(next);
      await useWorkspaceStore.getState().refresh();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlay} />
        <Dialog.Content className={cn(dialogPanel, 'flex max-h-[85vh] max-w-lg flex-col p-5')}>
          <Dialog.Title className="text-13 font-semibold">同步本地课程</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs leading-relaxed text-ink-3">
            直接使用电脑上的课程文件夹。课件、作业说明和附件、测试安排按课程更新；学习笔记和作业成果保存在原目录。冲突文件保留原件并另存
            Canvas 版本。
          </Dialog.Description>
          <div className="mt-3 min-h-0 space-y-3 overflow-y-auto">
            <div className="rounded-control border border-border p-3">
              <p className="text-xs font-medium">课程根目录</p>
              <p className="mt-1 break-all text-xs text-ink-3">
                {binding?.root ?? '请选择现有的学期文件夹，例如“大三上”。'}
              </p>
              <Button
                className="mt-2"
                disabled={busy || loading || !selected.size}
                onClick={() => void configure()}
                size="sm"
                variant="secondary"
              >
                <FolderOpen aria-hidden="true" />
                {binding ? '更换文件夹' : '选择课程文件夹'}
              </Button>
            </div>
            {groupCanvasCoursesByTerm(courses).map((group) => (
              <fieldset className="grid gap-1" key={group.term} disabled={busy || loading}>
                <legend className="mb-1 text-xs font-medium text-ink-3">{group.term}</legend>
                {group.courses.map((course) => (
                  <label className="flex items-center gap-2 text-13" key={course.id}>
                    <input
                      type="checkbox"
                      className="size-3.5 accent-[var(--ink-2)]"
                      checked={selected.has(course.id)}
                      onChange={(event) =>
                        setSelected((previous) => {
                          const next = new Set(previous);
                          if (event.target.checked) next.add(course.id);
                          else next.delete(course.id);
                          return next;
                        })
                      }
                    />
                    {course.name}
                  </label>
                ))}
              </fieldset>
            ))}
            {result && (
              <div className="space-y-2 text-xs" role="status">
                <p>
                  新增 {result.added} · 更新 {result.updated} · 沿用已有文件 {result.adopted} ·
                  未变化 {result.unchanged}
                </p>
                <p className="text-ink-3">上次同步：{new Date(result.syncedAt).toLocaleString()}</p>
                {!!result.conflicts.length && (
                  <details>
                    <summary>需核对 {result.conflicts.length} 项文件冲突</summary>
                    <ul className="mt-2 space-y-2">
                      {result.conflicts.map((item, index) => (
                        <li className="break-all" key={`${item.path}:${index}`}>
                          {item.path}：{item.reason}
                          {item.incomingPath && <p>Canvas 版本：{item.incomingPath}</p>}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {!!result.failed.length && (
                  <details open>
                    <summary>未完成 {result.failed.length} 项</summary>
                    <ul className="mt-2 space-y-1">
                      {result.failed.map((item, index) => (
                        <li className="break-all" key={index}>
                          {item}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
            {error && (
              <p className="text-xs text-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="mt-4 flex items-center justify-between gap-2">
            <span className="text-xs text-ink-3">
              {busy ? '正在核对并同步，请稍候…' : `已选 ${selected.size} 门课程`}
            </span>
            <div className="flex gap-2">
              <Button disabled={busy} onClick={onClose} size="sm" variant="ghost">
                关闭
              </Button>
              <Button
                disabled={busy || loading || !binding || !selected.size}
                onClick={() => void sync()}
                size="sm"
              >
                {busy && <Loader2 className="animate-spin" aria-hidden="true" />}开始同步
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
