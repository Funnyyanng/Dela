import { BrowserWindow, dialog, type WebContents } from 'electron';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isWorkspaceWindow } from '../notifications/system';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { MarkdownPdfDocument } from '../../shared/workspace';
import { readWorkspaceEntry, workspaceFilePath } from '../workspace/api';

const EXPORT_TIMEOUT_MS = 45_000;
const documents = new Map<
  number,
  { document: MarkdownPdfDocument; ready: (error: string | null) => void }
>();

export function markdownPdfDocument(senderId: number): MarkdownPdfDocument {
  const job = documents.get(senderId);
  if (!job) throw new Error('此窗口没有 Markdown PDF 导出任务');
  return job.document;
}

export function markdownPdfReady(senderId: number, error: string | null): void {
  const job = documents.get(senderId);
  if (!job) throw new Error('此窗口没有 Markdown PDF 导出任务');
  job.ready(error);
}

export async function exportMarkdownPdf(
  sender: WebContents,
  entryId: string,
  text: string,
): Promise<string | null> {
  const source = await readWorkspaceEntry(entryId);
  if (source.format !== 'markdown') throw new Error('只有本地 Markdown 文件可以导出 PDF');
  const sourcePath = await workspaceFilePath(entryId);
  const options = {
    title: '导出 Markdown 为 PDF',
    defaultPath: join(dirname(sourcePath), `${basename(sourcePath, extname(sourcePath))}.pdf`),
    filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
  };
  const parent = BrowserWindow.fromWebContents(sender);
  const selected = await (parent
    ? dialog.showSaveDialog(parent, options)
    : dialog.showSaveDialog(options));
  if (selected.canceled || !selected.filePath) return null;
  const output = /\.pdf$/i.test(selected.filePath) ? selected.filePath : `${selected.filePath}.pdf`;
  if (resolve(output) === resolve(sourcePath))
    throw new Error('PDF 不能覆盖 Markdown 源文件，请选择其他位置');

  return renderMarkdownPdf(sender.getURL(), { entryId, title: source.title, text }, output);
}

export async function exportSavedMarkdownPdf(
  entryId: string,
  outputName?: string,
): Promise<string> {
  const source = await readWorkspaceEntry(entryId);
  if (source.format !== 'markdown') throw new Error('只有本地 Markdown 文件可以导出 PDF');
  const sourcePath = await workspaceFilePath(entryId);
  const name = outputName ?? `${basename(sourcePath, extname(sourcePath))}.pdf`;
  if (!name.trim() || basename(name) !== name || /[\\/]/.test(name) || !/\.pdf$/i.test(name))
    throw new Error('请提供当前目录中的 PDF 文件名');
  const output = join(dirname(sourcePath), name);
  if (existsSync(output))
    throw new Error('此 PDF 已存在；先检查已有成果，需要修改时使用新的修订文件名');
  const owner = BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && isWorkspaceWindow(window.webContents.getURL()),
  );
  if (!owner) throw new Error('PDF 导出页面尚未准备好，请打开 Dela 后重试');
  return renderMarkdownPdf(
    owner.webContents.getURL(),
    { entryId, title: source.title, text: source.text ?? '' },
    output,
    true,
  );
}

async function renderMarkdownPdf(
  senderUrl: string,
  document: MarkdownPdfDocument,
  output: string,
  exclusive = false,
): Promise<string> {
  const url = new URL(senderUrl);
  url.searchParams.set('markdown-pdf', '1');
  const window = new BrowserWindow({
    width: 1000,
    height: 1200,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const senderId = window.webContents.id;
  let fail!: (error: Error) => void;
  const ready = new Promise<void>((complete, reject) => {
    fail = reject;
    documents.set(senderId, {
      document,
      ready: (error) =>
        error === null
          ? complete()
          : reject(new Error(`Markdown 页面准备失败：${error || '未知渲染错误'}`)),
    });
  });
  window.once('closed', () => fail(new Error('Markdown PDF 导出窗口已关闭')));
  window.webContents.once('render-process-gone', () =>
    fail(new Error('Markdown PDF 渲染进程意外退出，请重试')),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pdf = await Promise.race([
      Promise.all([window.loadURL(url.toString()), ready]).then(() =>
        window.webContents.printToPDF({
          pageSize: 'A4',
          preferCSSPageSize: true,
          printBackground: true,
          displayHeaderFooter: false,
          generateTaggedPDF: true,
        }),
      ),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Markdown PDF 导出超时：页面或资源未能在 45 秒内完成')),
          EXPORT_TIMEOUT_MS,
        );
      }),
    ]);
    if (!pdf.byteLength) throw new Error('Markdown PDF 导出未生成内容，请重试');
    await writeFile(output, pdf, { flag: exclusive ? 'wx' : 'w' });
    return output;
  } catch (error) {
    throw new Error(`无法导出 Markdown PDF：${error instanceof Error ? error.message : error}`);
  } finally {
    clearTimeout(timer);
    documents.delete(senderId);
    if (!window.isDestroyed()) window.destroy();
  }
}
