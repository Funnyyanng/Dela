// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackupSettings } from './BackupSettings';
let root: Root;
let host: HTMLDivElement;
const inspection = {
  path: '/backup',
  manifestHash: 'checked',
  createdAt: '2026-10-30',
  fileCount: 3,
  bytes: 100,
  canRestore: true,
  warnings: ['外部课程未包含'],
  failures: [],
  sections: [{ label: '课程', included: false }],
};
const restore = vi.fn();
const activate = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  restore.mockResolvedValue({
    path: '/new',
    profilePath: '/new/profile',
    previousSnapshot: '/snapshot',
    warnings: [],
  });
  window.dela = {
    backup: {
      getCoverage: vi.fn(async () => ({
        currentProfile: '/original',
        previousProfile: null,
        externalProjects: [{ name: '课程', path: '/course', remote: false }],
      })),
      inspect: vi.fn(async () => inspection),
      restore,
      activate,
    },
  } as unknown as typeof window.dela;
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete window.dela;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const click = async (label: string) =>
  act(async () =>
    [...host.querySelectorAll('button')].find((button) => button.textContent === label)!.click(),
  );
it('shows missing external coverage and requires a separate explicit activation after preflight and restore', async () => {
  await act(async () => root.render(<BackupSettings />));
  expect(host.textContent).toContain('课程：未包含');
  await click('选择备份并预检');
  expect(host.textContent).toContain('外部课程未包含');
  expect(restore).not.toHaveBeenCalled();
  await click('恢复到新位置');
  expect(restore).toHaveBeenCalledWith('/backup', 'checked');
  expect(host.textContent).toContain('当前数据快照：/snapshot');
  expect(activate).not.toHaveBeenCalled();
  await click('启用恢复的数据并重启');
  expect(activate).toHaveBeenCalledWith('/new/profile');
});
it('does not allow a failed preflight to restore', async () => {
  vi.mocked(window.dela!.backup.inspect).mockResolvedValue({
    ...inspection,
    canRestore: false,
    failures: ['文件校验失败'],
  });
  await act(async () => root.render(<BackupSettings />));
  await click('选择备份并预检');
  expect(host.textContent).toContain('文件校验失败');
  expect(
    [...host.querySelectorAll('button')].find((button) => button.textContent === '恢复到新位置')
      ?.disabled,
  ).toBe(true);
  expect(restore).not.toHaveBeenCalled();
});
