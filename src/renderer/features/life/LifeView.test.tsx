// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LifeState } from '../../../shared/life';
import { LifeView } from './LifeView';
vi.mock('../../navigation/view', () => ({
  useNavigationStore: { getState: () => ({ navigate: vi.fn() }) },
}));
vi.mock('../../workspace/store', () => ({ errorText: (error: unknown) => String(error) }));
let root: Root, container: HTMLDivElement;
const saveOccurrence = vi.fn(),
  saveTodo = vi.fn();
let life: LifeState;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  vi.setSystemTime(new Date('2026-10-30T04:00:00Z'));
  life = {
    startDate: '2026-10-24',
    endDate: '2026-11-29',
    habits: [
      { id: 'a', title: '阅读时长', kind: 'duration', unit: '分钟', target: null, archived: false },
      { id: 'b', title: '饮水次数', kind: 'count', unit: '次', target: null, archived: false },
    ],
    habitLogs: [{ habitId: 'b', date: '2026-10-30', value: 0, note: '' }],
    sleepLogs: [],
    occurrences: [
      {
        id: 'series:2026-10-30',
        todoId: 'series',
        date: '2026-10-30',
        title: '整理房间',
        dueAt: '2026-10-30T13:00:00Z',
        remindAt: null,
        completed: false,
      },
    ],
  };
  saveOccurrence.mockImplementation(async (input) => {
    life = {
      ...life,
      occurrences: life.occurrences.map((item) => ({ ...item, completed: input.completed })),
    };
  });
  window.dela = {
    life: { getState: async () => life, onUpdate: () => () => {}, saveOccurrence },
    todo: {
      getState: async () => ({
        items: [
          {
            id: 'series',
            source: 'personal',
            title: '整理房间',
            notes: '',
            status: 'pending',
            dueAt: null,
            readAt: null,
            createdAt: '2026-10-01T00:00:00Z',
            recurrence: { frequency: 'daily', startDate: '2026-10-30' },
          },
        ],
      }),
      onUpdate: () => () => {},
      save: saveTodo,
    },
  } as unknown as typeof window.dela;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const click = async (label: string) => {
  const button = Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent === label,
  )!;
  await act(async () => button.click());
};
it('shows missing observations as unknown and keeps actual zero distinct', async () => {
  await act(async () => root.render(<LifeView />));
  await click('习惯');
  expect(container.textContent).toContain('2026-10-30 · 未记录');
  expect(container.textContent).toContain('2026-10-30 · 0 次');
  await click('作息');
  expect(container.textContent).toContain('这一时段尚未记录睡眠');
  expect(container.textContent).not.toContain('平均');
});
it('completes only the selected repeating instance without completing the master', async () => {
  await act(async () => root.render(<LifeView />));
  const check = container.querySelector(
    'input[aria-label="完成 2026-10-30 整理房间"]',
  ) as HTMLInputElement;
  await act(async () => check.click());
  expect(saveOccurrence).toHaveBeenCalledWith({
    todoId: 'series',
    date: '2026-10-30',
    completed: true,
  });
  expect(saveTodo).not.toHaveBeenCalled();
  expect(check.checked).toBe(true);
});

it('weekly review reports unknown sleep and never invents completion dates', async () => {
  await act(async () => root.render(<LifeView />));
  await click('周回顾');
  expect(container.textContent).toContain('2026-10-24 至 2026-10-30');
  expect(container.textContent).toContain('已记录完成 0 次');
  expect(container.textContent).toContain('已记录 1 天，未记录 6 天');
  expect(container.textContent).toContain('平均时长未知');
  expect(container.textContent).toContain('单次事项缺少完成时间');
});
