// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DelaApi } from '../../../shared/api';
import { TodayView } from './TodayView';
const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openTodo: vi.fn(),
  refreshJobs: vi.fn(),
  getTodos: vi.fn(),
  getLife: vi.fn(),
  getSchedule: vi.fn(),
  save: vi.fn(),
  occurrence: vi.fn(),
}));
vi.mock('../../navigation/view', () => ({ useNavigationStore: { getState: () => mocks } }));
vi.mock('../jobs/store', () => ({
  useJobs: () => ({ jobs: [], error: null, refresh: mocks.refreshJobs }),
}));
vi.mock('../jobs/JobCard', () => ({ JobCard: () => null }));
let host: HTMLDivElement, root: Root;
let todoListener: () => void;
const todo = {
  id: 'personal:one',
  source: 'personal',
  title: '买书',
  status: 'pending',
  dueAt: null,
  createdAt: '2026-10-01T00:00:00Z',
  readAt: null,
  notes: '',
  area: 'life',
};
beforeEach(async () => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.getTodos.mockResolvedValue({
    items: [
      todo,
      {
        ...todo,
        id: 'canvas:1',
        source: 'canvas',
        title: '课程作业',
        status: 'resubmit',
        courseName: '密码学',
      },
    ],
    error: null,
  });
  mocks.getLife.mockResolvedValue({ occurrences: [] });
  mocks.getSchedule.mockResolvedValue({
    items: [
      {
        id: 'ddl',
        source: 'deadline',
        title: '课程作业截止',
        startAt: '2026-10-30T15:59:00Z',
        endAt: '2026-10-30T15:59:00Z',
      },
    ],
    coverage: { warnings: [] },
  });
  mocks.save.mockResolvedValue({});
  Object.defineProperty(window, 'dela', {
    configurable: true,
    value: {
      todo: {
        getState: mocks.getTodos,
        save: mocks.save,
        onUpdate: (fn: () => void) => {
          todoListener = fn;
          return () => {};
        },
      },
      life: { getState: mocks.getLife, saveOccurrence: mocks.occurrence, onUpdate: () => () => {} },
      timetable: { querySchedule: mocks.getSchedule, onUpdate: () => () => {} },
    } as unknown as DelaApi,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<TodayView />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
it('uses shared pending items, gives actions without a chat redirect, and displays DDL as a point', async () => {
  expect(host.textContent).toContain('课程作业');
  expect(host.textContent).toContain('先看重要事项');
  expect(host.textContent).toContain('23:59');
  expect(host.textContent).not.toContain('23:29');
  const complete = host.querySelector<HTMLButtonElement>('[aria-label="完成 买书"]')!;
  expect(host.querySelector('[aria-label="完成 课程作业"]')).toBeNull();
  await act(async () => complete.click());
  expect(mocks.save).toHaveBeenCalledWith({ id: 'personal:one', title: '买书', completed: true });
  mocks.getTodos.mockResolvedValue({ items: [{ ...todo, status: 'completed' }], error: null });
  await act(async () => todoListener());
  expect(host.querySelector('[aria-label="完成 买书"]')).toBeNull();
  expect(mocks.navigate).not.toHaveBeenCalled();
});
it('retains usable tasks when another data source fails and offers retry', async () => {
  mocks.getSchedule.mockRejectedValue(new Error('日历离线'));
  await act(async () => todoListener());
  expect(host.textContent).toContain('部分信息暂未核对');
  expect(host.textContent).toContain('日历离线');
  expect(host.querySelector('[aria-label="完成 买书"]')).not.toBeNull();
  expect(host.textContent).toContain('重新读取');
});

it("keeps yesterday's incomplete recurring item visible and completes only that instance", async () => {
  mocks.getLife.mockResolvedValue({
    occurrences: [
      {
        id: 'series:2026-10-29',
        todoId: 'series',
        date: '2026-10-29',
        title: '重复阅读',
        dueAt: '2026-10-29T12:00:00Z',
        completed: false,
      },
    ],
  });
  mocks.occurrence.mockResolvedValue(undefined);
  await act(async () => todoListener());
  const button = host.querySelector<HTMLButtonElement>('[aria-label="完成 重复阅读"]')!;
  expect(button).not.toBeNull();
  await act(async () => button.click());
  expect(mocks.occurrence).toHaveBeenCalledWith({
    todoId: 'series',
    date: '2026-10-29',
    completed: true,
  });
  expect(mocks.save).not.toHaveBeenCalled();
});
