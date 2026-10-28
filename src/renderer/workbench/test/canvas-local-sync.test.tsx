// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CanvasLocalSyncState } from '../../../shared/canvas-local';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(async () => {}),
  courses: [
    { id: 9, name: '本学期课程', term: '2026-2027 Fall', archived: false },
    { id: 8, name: '历史课程', term: '2025-2026 Fall', archived: false },
  ],
}));
vi.mock('../../workspace/store', () => ({
  errorText: (cause: unknown) => String(cause),
  useWorkspaceStore: Object.assign(
    (select: (state: unknown) => unknown) => select({ canvas: { courses: mocks.courses } }),
    { getState: () => ({ refresh: mocks.refresh }) },
  ),
}));

import { CanvasLocalSyncDialog } from '../CanvasLocalSyncDialog';

let root: Root;
let host: HTMLDivElement;
const state: CanvasLocalSyncState = {
  root: '/课程',
  projectId: 'project',
  courseIds: [9],
  courses: [{ id: 9, name: '本学期课程', directory: '本学期课程' }],
  syncedAt: null,
  lastResult: null,
};
const canvas = {
  localSyncState: vi.fn(),
  configureLocalSync: vi.fn(),
  syncLocal: vi.fn(),
};
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((item) => item.textContent?.includes(label))!;
const click = async (label: string) =>
  act(async () => {
    button(label).click();
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, 'dela', { value: { canvas }, configurable: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it('keeps a canceled folder selection unconfigured and never starts a sync', async () => {
  canvas.localSyncState.mockResolvedValue(null);
  canvas.configureLocalSync.mockResolvedValue(null);
  await act(async () => root.render(<CanvasLocalSyncDialog onClose={() => {}} />));
  expect([...document.querySelectorAll('input')].map((item) => item.checked)).toEqual([
    true,
    false,
  ]);
  await click('选择课程文件夹');
  expect(canvas.configureLocalSync).toHaveBeenCalledWith([9]);
  expect(button('开始同步').disabled).toBe(true);
  expect(canvas.syncLocal).not.toHaveBeenCalled();
});

it('reuses the configured root and shows conflicts without hiding partial failures', async () => {
  canvas.localSyncState.mockResolvedValue(state);
  canvas.configureLocalSync.mockResolvedValue(state);
  canvas.syncLocal.mockResolvedValue({
    root: state.root,
    projectId: state.projectId,
    added: 1,
    updated: 0,
    unchanged: 2,
    adopted: 3,
    conflicts: [{ path: '课件/a.pdf', reason: '本地已修改', incomingPath: '课件/a-Canvas.pdf' }],
    failed: ['另一门课：网络不可用'],
    syncedAt: '2026-10-28T00:00:00Z',
  });
  await act(async () => root.render(<CanvasLocalSyncDialog onClose={() => {}} />));
  await click('开始同步');
  expect(canvas.configureLocalSync).toHaveBeenCalledWith([9], '/课程');
  expect(canvas.syncLocal).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain('本地已修改');
  expect(document.body.textContent).toContain('课件/a-Canvas.pdf');
  expect(document.body.textContent).toContain('网络不可用');
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
});
