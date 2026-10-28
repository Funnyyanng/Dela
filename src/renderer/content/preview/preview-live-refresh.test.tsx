// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PreviewTab } from './PreviewTab';
import { ContentLoaderProvider, type ContentLoader, type LoadedDocument } from './loader';

vi.mock('./PdfReader', () => ({ PdfReader: ({ url }: { url: string }) => <div data-pdf={url} /> }));

let root: Root;
let container: HTMLDivElement;
let changed: (() => void) | undefined;
const unsubscribe = vi.fn();
let loader: ContentLoader;
const documentOf = (revision: string): LoadedDocument => ({
  watchesDisk: true,
  content: {
    title: 'lecture.pdf',
    format: 'pdf',
    previewUrl: `dela-resource://workspace/lecture?v=${revision}`,
    revision,
  },
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  loader = {
    loadDocument: vi.fn(async () => documentOf('r1')),
    onFileChanged: vi.fn((_tabKey, listener) => {
      changed = listener;
      return unsubscribe;
    }),
    openLink: vi.fn(),
    openShuiyuanTopic: vi.fn(),
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function open() {
  await act(async () =>
    root.render(
      <ContentLoaderProvider loader={loader}>
        <PreviewTab tabId="preview:/courses/lecture.pdf" groupId="test" />
      </ContentLoaderProvider>,
    ),
  );
}

it('内容事件更换 PDF 预览版本，无需重新聚焦窗口', async () => {
  await open();
  expect(container.querySelector('[data-pdf]')?.getAttribute('data-pdf')).toContain('r1');
  vi.mocked(loader.loadDocument).mockResolvedValue(documentOf('r2'));
  await act(async () => changed!());
  expect(container.querySelector('[data-pdf]')?.getAttribute('data-pdf')).toContain('r2');
  await act(async () => root.unmount());
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it('AI 连续写入时旧读取不会覆盖较新的预览', async () => {
  await open();
  const finishes: ((doc: LoadedDocument) => void)[] = [];
  vi.mocked(loader.loadDocument).mockImplementation(
    () => new Promise((resolve) => finishes.push(resolve)),
  );
  await act(async () => {
    changed!();
    changed!();
  });
  await act(async () => finishes[1]!(documentOf('r3')));
  expect(container.querySelector('[data-pdf]')?.getAttribute('data-pdf')).toContain('r3');
  await act(async () => finishes[0]!(documentOf('r2')));
  expect(container.querySelector('[data-pdf]')?.getAttribute('data-pdf')).toContain('r3');
});
