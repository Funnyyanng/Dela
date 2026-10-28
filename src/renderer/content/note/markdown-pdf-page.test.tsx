// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareMarkdownPdf } from './MarkdownPdfPage';

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement('main');
  document.body.append(root);
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
});

afterEach(() => {
  root.remove();
  vi.unstubAllGlobals();
});

it('等待所有流程图插入 SVG 后才完成打印准备', async () => {
  root.innerHTML = '<div data-pdf-mermaid="pending"></div>';
  let ready = false;
  const preparing = prepareMarkdownPdf(root).then(() => {
    ready = true;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  root.firstElementChild!.innerHTML = '<svg></svg>';
  root.firstElementChild!.setAttribute('data-pdf-mermaid', 'ready');
  await preparing;
  expect(ready).toBe(true);
});

it('流程图语法错误时拒绝导出，避免生成缺图的 PDF', async () => {
  root.innerHTML = '<div data-pdf-mermaid="error" data-pdf-error="syntax error"></div>';
  await expect(prepareMarkdownPdf(root)).rejects.toThrow('流程图无法渲染：syntax error');
});

it('已完成但损坏的图片不会被误判为可打印', async () => {
  const image = document.createElement('img');
  image.alt = '课程截图';
  Object.defineProperty(image, 'complete', { value: true });
  Object.defineProperty(image, 'naturalWidth', { value: 0 });
  root.append(image);
  await expect(prepareMarkdownPdf(root)).rejects.toThrow('图片无法载入：课程截图');
});
