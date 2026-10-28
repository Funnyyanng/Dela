// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NoteTab } from './NoteTab';
import { NoteDraftSourceProvider, type NoteDraftSource } from './draft-source';
import { useNoteDrafts } from './drafts';
import type { DelaApi, DocumentContent } from '../../../shared/api';

vi.mock('./MarkdownEditor', () => ({
  MarkdownEditor: ({ value }: { value: string }) => <pre>{value}</pre>,
}));

let root: Root;
let container: HTMLDivElement;
let changed: (() => void) | undefined;
let disk: DocumentContent;
let source: NoteDraftSource;
const unsubscribe = vi.fn();
const key = '/courses/note.md';

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  disk = { title: 'note.md', format: 'markdown', text: 'old', revision: 'r1' };
  window.dela = {
    workspace: {
      read: vi.fn(async () => ({ ...disk })),
      saveNote: vi.fn(async () => {
        throw new Error('文件已在外部修改');
      }),
    },
  } as unknown as DelaApi;
  source = {
    useDraft: (entryId) => useNoteDrafts((state) => state.drafts[entryId]),
    acquire: (entryId, force) => useNoteDrafts.getState().acquire(entryId, force),
    refresh: (entryId) => useNoteDrafts.getState().refresh(entryId),
    release: (entryId) => useNoteDrafts.getState().release(entryId),
    edit: (entryId, text) => useNoteDrafts.getState().edit(entryId, text),
    save: (entryId) => useNoteDrafts.getState().save(entryId),
    onFileChanged: vi.fn((_entryId, listener) => {
      changed = listener;
      return unsubscribe;
    }),
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useNoteDrafts.setState({ drafts: {} });
  delete window.dela;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function open() {
  await act(async () =>
    root.render(
      <NoteDraftSourceProvider source={source}>
        <NoteTab tabId={`note:${key}`} groupId="test" />
      </NoteDraftSourceProvider>,
    ),
  );
}

it('已开干净文本收到内容通知即刷新，卸载会取消订阅', async () => {
  await open();
  expect(source.onFileChanged).toHaveBeenCalledWith(key, expect.any(Function));
  disk = { ...disk, text: 'first step', revision: 'r2' };
  await act(async () => changed!());
  expect(container.querySelector('pre')?.textContent).toBe('first step');
  disk = { ...disk, text: 'second step', revision: 'r3' };
  await act(async () => changed!());
  expect(container.querySelector('pre')?.textContent).toBe('second step');
  await act(async () => root.unmount());
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it('外部写入不覆盖未保存草稿，并沿用冲突提示', async () => {
  await open();
  await act(async () => useNoteDrafts.getState().edit(key, 'my unsaved text'));
  disk = { ...disk, text: 'AI text', revision: 'r2' };
  await act(async () => changed!());
  expect(container.querySelector('pre')?.textContent).toBe('my unsaved text');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('草稿仍在');
  expect(useNoteDrafts.getState().drafts[key]?.content.revision).toBe('r1');
});
