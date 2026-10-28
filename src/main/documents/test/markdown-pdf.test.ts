import type { BrowserWindowConstructorOptions, WebContents } from 'electron';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MarkdownPdfDocument } from '../../../shared/workspace';

interface TestWindow {
  options: BrowserWindowConstructorOptions;
  destroyed: boolean;
  webContents: {
    id: number;
    printToPDF: ReturnType<typeof vi.fn>;
    emit: (name: string) => void;
  };
}

const state = vi.hoisted(() => ({
  windows: [] as TestWindow[],
  showSaveDialog: vi.fn(),
  load: vi.fn(),
  print: vi.fn(),
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    dialog: { showSaveDialog: state.showSaveDialog },
    BrowserWindow: class extends EventEmitter {
      destroyed = false;
      webContents = Object.assign(new EventEmitter(), {
        id: 100 + state.windows.length,
        printToPDF: state.print,
      });
      constructor(public options: BrowserWindowConstructorOptions) {
        super();
        state.windows.push(this);
      }
      static fromWebContents() {
        return null;
      }
      loadURL(url: string) {
        return state.load(this, url);
      }
      isDestroyed() {
        return this.destroyed;
      }
      destroy() {
        this.destroyed = true;
        this.emit('closed');
      }
    },
  };
});
vi.mock('../../workspace/api', () => ({
  readWorkspaceEntry: vi.fn(),
  workspaceFilePath: vi.fn(),
}));

import { readWorkspaceEntry, workspaceFilePath } from '../../workspace/api';
import { exportMarkdownPdf, markdownPdfDocument, markdownPdfReady } from '../markdown-pdf';

let directory: string;
let source: string;
let target: string;
const owner = {
  id: 1,
  getURL: () => 'file:///Applications/Dela/out/renderer/index.html?existing=1#document',
} as WebContents;

beforeEach(() => {
  vi.resetAllMocks();
  state.windows.length = 0;
  directory = mkdtempSync(join(tmpdir(), 'dela-markdown-pdf-'));
  source = join(directory, '笔记.md');
  target = join(directory, '笔记.pdf');
  writeFileSync(source, '# 已保存的笔记');
  vi.mocked(readWorkspaceEntry).mockResolvedValue({
    title: '笔记.md',
    format: 'markdown',
    text: '# 已保存的笔记',
  });
  vi.mocked(workspaceFilePath).mockResolvedValue(source);
  state.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });
  state.print.mockResolvedValue(Buffer.from('%PDF-1.7\nmarkdown'));
  state.load.mockImplementation(async (window: TestWindow) =>
    markdownPdfReady(window.webContents.id, null),
  );
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

it('取消保存时不创建打印窗口，也不生成文件', async () => {
  state.showSaveDialog.mockResolvedValue({ canceled: true });
  await expect(exportMarkdownPdf(owner, source, '# 草稿')).resolves.toBeNull();
  expect(state.windows).toHaveLength(0);
  expect(state.load).not.toHaveBeenCalled();
  expect(state.print).not.toHaveBeenCalled();
  expect(readdirSync(directory)).toEqual(['笔记.md']);
});

it('只向打印窗口提供当前草稿快照，准备完成后生成 A4 PDF 并清理窗口', async () => {
  const draft = '# 尚未保存\n\n![图片](assets/图.png)';
  let snapshot: MarkdownPdfDocument | undefined;
  state.load.mockImplementation(async (window: TestWindow, value: string) => {
    const url = new URL(value);
    expect(url.pathname).toBe('/Applications/Dela/out/renderer/index.html');
    expect(url.searchParams.get('existing')).toBe('1');
    expect(url.searchParams.get('markdown-pdf')).toBe('1');
    expect(url.hash).toBe('#document');
    expect(() => markdownPdfDocument(owner.id)).toThrow('没有 Markdown PDF 导出任务');
    expect(() => markdownPdfReady(owner.id, null)).toThrow('没有 Markdown PDF 导出任务');
    snapshot = markdownPdfDocument(window.webContents.id);
    expect(state.print).not.toHaveBeenCalled();
    markdownPdfReady(window.webContents.id, null);
  });

  await expect(exportMarkdownPdf(owner, source, draft)).resolves.toBe(target);
  expect(snapshot).toEqual({ entryId: source, title: '笔记.md', text: draft });
  expect(state.showSaveDialog).toHaveBeenCalledWith(
    expect.objectContaining({
      defaultPath: target,
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
    }),
  );
  expect(state.windows[0]?.options).toMatchObject({
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: expect.stringContaining('preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  expect(state.print).toHaveBeenCalledWith({
    pageSize: 'A4',
    preferCSSPageSize: true,
    printBackground: true,
    displayHeaderFooter: false,
    generateTaggedPDF: true,
  });
  expect(readFileSync(target, 'utf8')).toBe('%PDF-1.7\nmarkdown');
  expect(readFileSync(source, 'utf8')).toBe('# 已保存的笔记');
  expect(state.windows[0]?.destroyed).toBe(true);
  expect(() => markdownPdfDocument(state.windows[0]!.webContents.id)).toThrow('没有');
});

it('选择源文件名时补 PDF 扩展名，保留 Markdown 文件', async () => {
  state.showSaveDialog.mockResolvedValue({ canceled: false, filePath: source });
  await expect(exportMarkdownPdf(owner, source, '# 草稿')).resolves.toBe(`${source}.pdf`);
  expect(readFileSync(source, 'utf8')).toBe('# 已保存的笔记');
  expect(readFileSync(`${source}.pdf`, 'utf8')).toBe('%PDF-1.7\nmarkdown');
});

it('非 Markdown 文档在弹出保存框前拒绝导出', async () => {
  vi.mocked(readWorkspaceEntry).mockResolvedValue({ title: '文本.txt', format: 'text', text: 'x' });
  await expect(exportMarkdownPdf(owner, source, 'x')).rejects.toThrow('只有本地 Markdown');
  expect(state.showSaveDialog).not.toHaveBeenCalled();
  expect(state.windows).toHaveLength(0);
});

it.each(['resources', 'load', 'print', 'empty', 'crash'])(
  '%s 失败保留已有 PDF 并销毁窗口、清除快照',
  async (failure) => {
    writeFileSync(target, 'existing pdf');
    if (failure === 'resources')
      state.load.mockImplementation(async (window: TestWindow) =>
        markdownPdfReady(window.webContents.id, '图片加载失败'),
      );
    if (failure === 'load') state.load.mockRejectedValue(new Error('页面加载失败'));
    if (failure === 'print') state.print.mockRejectedValue(new Error('打印失败'));
    if (failure === 'empty') state.print.mockResolvedValue(Buffer.alloc(0));
    if (failure === 'crash')
      state.load.mockImplementation(async (window: TestWindow) =>
        window.webContents.emit('render-process-gone'),
      );

    await expect(exportMarkdownPdf(owner, source, '# 草稿')).rejects.toThrow(
      '无法导出 Markdown PDF',
    );
    expect(readFileSync(target, 'utf8')).toBe('existing pdf');
    expect(state.windows[0]?.destroyed).toBe(true);
    expect(() => markdownPdfDocument(state.windows[0]!.webContents.id)).toThrow('没有');
    if (['resources', 'load', 'crash'].includes(failure))
      expect(state.print).not.toHaveBeenCalled();
  },
);

it.each(['load', 'ready'])('%s 无响应在 45 秒后终止并清理', async (phase) => {
  vi.useFakeTimers();
  state.load.mockImplementation(() =>
    phase === 'load' ? new Promise(() => {}) : Promise.resolve(),
  );
  const work = exportMarkdownPdf(owner, source, '# 草稿');
  const result = expect(work).rejects.toThrow('45 秒');
  await vi.advanceTimersByTimeAsync(45_000);
  await result;
  expect(state.windows[0]?.destroyed).toBe(true);
  expect(state.print).not.toHaveBeenCalled();
  expect(readdirSync(directory)).toEqual(['笔记.md']);
  expect(() => markdownPdfDocument(state.windows[0]!.webContents.id)).toThrow('没有');
});
