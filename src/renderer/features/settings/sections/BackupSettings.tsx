import { useEffect, useState } from 'react';
import type {
  BackupCoverage,
  BackupInspection,
  BackupRestoreResult,
} from '../../../../shared/backup';
import { Button } from '../../../components/ui/button';
import { errorText } from '../../../workspace/store';

export function BackupSettings() {
  const [coverage, setCoverage] = useState<BackupCoverage | null>(null);
  const [includeExternal, setIncludeExternal] = useState(false);
  const [inspection, setInspection] = useState<BackupInspection | null>(null);
  const [restored, setRestored] = useState<BackupRestoreResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void window.dela?.backup
      .getCoverage()
      .then(setCoverage)
      .catch((cause) => setError(errorText(cause)));
  }, []);
  return (
    <section className="grid gap-4 rounded-xl border border-line p-5">
      <div>
        <h2 className="font-medium text-ink">备份与恢复</h2>
        <p className="mt-1 text-sm text-ink-3">
          备份包含聊天、任务、学习记录、设置、工作目录与技能。外部课程和项目目录可单独纳入；远程文件不在本机备份中。
        </p>
      </div>
      {coverage ? (
        <>
          <p className="break-all text-xs text-ink-3">当前数据：{coverage.currentProfile}</p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeExternal}
              onChange={(event) => setIncludeExternal(event.target.checked)}
              disabled={busy}
            />
            包含外部课程和项目文件夹（可能较大）
          </label>
          {coverage.externalProjects.length > 0 && (
            <ul className="grid gap-1 text-xs text-ink-3">
              {coverage.externalProjects.map((item) => (
                <li key={`${item.name}:${item.path}`}>
                  {item.name}：
                  {item.remote ? '远程，未包含' : includeExternal ? '将包含' : '未包含'} ·{' '}
                  {item.path}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void run(async () => {
              if (window.dela) setCoverage(await window.dela.backup.getCoverage());
            })
          }
        >
          重新读取备份范围
        </Button>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || !coverage}
          onClick={() =>
            void run(async () => {
              const result = await window.dela!.backup.exportData({ includeExternal });
              if (result.status === 'failed') throw new Error(result.reason);
              if (result.status === 'exported')
                setMessage(
                  `已备份到 ${result.path}${result.skipped.length ? `；${result.skipped.length} 项未复制，详见备份清单` : '；已生成文件校验清单'}`,
                );
            })
          }
        >
          备份到文件夹
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setRestored(null);
              setInspection(await window.dela!.backup.inspect());
            })
          }
        >
          选择备份并预检
        </Button>
      </div>
      {busy && (
        <p role="status" className="text-sm text-ink-3">
          正在检查或复制文件，请保持应用打开…
        </p>
      )}
      {inspection && (
        <div className="grid gap-3 rounded-lg border border-line p-4">
          <p className="font-medium">{inspection.canRestore ? '预检通过' : '预检未通过'}</p>
          <p className="break-all text-xs text-ink-3">
            {inspection.path} · {inspection.createdAt} · {inspection.fileCount} 个文件 ·{' '}
            {(inspection.bytes / 1024 / 1024).toFixed(1)} MB
          </p>
          <ul className="grid gap-1 text-sm">
            {inspection.sections.map((item, index) => (
              <li key={index}>
                {item.label}：{item.included ? '已包含' : '未包含'}
              </li>
            ))}
          </ul>
          {[...inspection.warnings, ...inspection.failures].map((item, index) => (
            <p className="text-sm text-amber-700" key={index}>
              {item}
            </p>
          ))}
          <p className="text-xs text-ink-3">
            下一步先保存当前应用、工作目录和技能快照，再将备份复制到新位置。当前快照不包含外部目录，原文件保留在原处。外部目录若未包含在所选备份中则保持原关联。
          </p>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !inspection.canRestore || !!restored}
            onClick={() =>
              void run(async () => {
                setRestored(
                  await window.dela!.backup.restore(inspection.path, inspection.manifestHash),
                );
              })
            }
          >
            恢复到新位置
          </Button>
        </div>
      )}
      {restored && (
        <div className="grid gap-3 rounded-lg border border-line p-4">
          <p className="font-medium">已恢复并重新关联资料</p>
          <p className="break-all text-sm">新目录：{restored.path}</p>
          <p className="break-all text-xs text-ink-3">
            当前数据快照：{restored.previousSnapshot}（外部目录未包含，原文件保留在原处）
          </p>
          <p className="text-sm text-ink-3">
            启用将重启 Dela，载入恢复的聊天、任务和文件；之后可以在这里返回原数据目录。
          </p>
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await window.dela!.backup.activate(restored.profilePath);
              })
            }
          >
            启用恢复的数据并重启
          </Button>
        </div>
      )}
      {coverage?.previousProfile && (
        <details className="text-sm">
          <summary className="cursor-pointer">返回以前的数据</summary>
          <p className="my-2 break-all text-xs text-ink-3">{coverage.previousProfile}</p>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await window.dela!.backup.returnToPrevious();
              })
            }
          >
            返回该数据目录并重启
          </Button>
        </details>
      )}
      {message && (
        <p role="status" className="break-all text-sm text-ink-3">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}
