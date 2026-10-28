import {
  ChevronRight,
  Clock,
  Code,
  Download,
  Eye,
  FolderOpen,
  LoaderCircle,
  Pencil,
  RefreshCw,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';

export type NoteMode = 'live' | 'source' | 'preview';

/** 文件内容级工具栏：保存状态低干扰展示、阅读/编辑/源码切换、文件夹定位与重载。
 *  正常状态不常驻保存按钮（自动保存已覆盖该路径）；失败重试与「另存为新笔记」入口在 NoteTab 错误条。 */
export function DocumentToolbar({
  path,
  markdown,
  mode,
  onModeChange,
  saving,
  dirty,
  failed,
  dueAt,
  onOpenInFolder,
  onReload,
  onExportPdf,
  exporting,
  exportDisabled,
}: {
  path: string[];
  /** Markdown 才有阅读/编辑/源码切换；其他文本始终是代码编辑器。 */
  markdown: boolean;
  mode: NoteMode;
  onModeChange: (mode: NoteMode) => void;
  saving: boolean;
  dirty: boolean;
  /** 保存失败时状态文字转警示色（详情在错误条）。 */
  failed: boolean;
  dueAt?: string | null;
  onOpenInFolder: () => void;
  onReload: () => void;
  onExportPdf: () => void;
  exporting: boolean;
  exportDisabled: boolean;
}) {
  return (
    <div
      className="flex min-w-0 shrink-0 items-center gap-2 px-3 py-1.5 text-xs"
      role="toolbar"
      aria-label="文件操作"
    >
      <nav aria-label="文件路径" className="min-w-0 flex-1 text-ink-3" title={path.join(' / ')}>
        <ol className="flex min-w-0 items-center gap-1 overflow-hidden">
          {path.map((name, index) => (
            <li key={index} className="flex min-w-0 items-center gap-1 last:text-ink-2">
              {index > 0 && <ChevronRight aria-hidden className="size-3 shrink-0" />}
              <span
                className="truncate"
                aria-current={index === path.length - 1 ? 'page' : undefined}
              >
                {name}
              </span>
            </li>
          ))}
        </ol>
      </nav>
      {dueAt && (
        <span
          className="flex min-w-0 shrink items-center gap-1 text-ink-3"
          title={`截止 ${new Date(dueAt).toLocaleString('zh-CN')}`}
        >
          <Clock className="size-3 shrink-0" />
          <span className="max-w-40 truncate">截止 {new Date(dueAt).toLocaleString('zh-CN')}</span>
        </span>
      )}
      <span
        className={cn('flex shrink-0 items-center gap-1 text-ink-3', failed && 'text-red')}
        role="status"
        aria-live="polite"
      >
        {saving ? (
          <>
            <LoaderCircle className="size-3 animate-spin" />
            保存中…
          </>
        ) : dirty ? (
          '未保存'
        ) : /* 正常态不常驻「已保存」图标：长期占位无信息增量；失败详情由 NoteTab 错误条承载。 */
        null}
      </span>
      {markdown && (
        <Button
          size="sm"
          variant="ghost"
          onClick={onExportPdf}
          disabled={exporting || exportDisabled}
          title={exportDisabled ? '当前仅显示文件片段，无法导出完整 PDF' : '导出 PDF'}
          aria-label="导出 PDF"
        >
          {exporting ? <LoaderCircle className="animate-spin" /> : <Download />}
          {exporting ? '导出中…' : '导出 PDF'}
        </Button>
      )}
      {markdown && (
        <Button
          size="sm"
          variant={mode === 'preview' ? 'secondary' : 'ghost'}
          title={mode === 'preview' ? '返回编辑' : '阅读预览'}
          aria-label={mode === 'preview' ? '返回编辑' : '阅读预览'}
          aria-pressed={mode === 'preview'}
          onClick={() => onModeChange(mode === 'preview' ? 'live' : 'preview')}
        >
          {mode === 'preview' ? <Pencil /> : <Eye />}
          {mode === 'preview' ? '编辑' : '预览'}
        </Button>
      )}
      {markdown && (
        <Button
          size="icon-xs"
          variant={mode === 'source' ? 'secondary' : 'ghost'}
          title={mode === 'source' ? '返回即时渲染' : '源码模式'}
          aria-label={mode === 'source' ? '返回即时渲染' : '源码模式'}
          aria-pressed={mode === 'source'}
          onClick={() => onModeChange(mode === 'source' ? 'live' : 'source')}
        >
          <Code />
        </Button>
      )}
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          size="icon-xs"
          variant="ghost"
          title="在文件夹中显示"
          aria-label="在文件夹中显示"
          onClick={onOpenInFolder}
        >
          <FolderOpen />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          title="重新载入"
          aria-label="重新载入"
          onClick={onReload}
        >
          <RefreshCw />
        </Button>
      </div>
    </div>
  );
}
