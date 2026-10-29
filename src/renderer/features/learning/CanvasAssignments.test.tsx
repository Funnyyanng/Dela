// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LearningState, LearningTask } from '../../../shared/learning';
import type { TodoItem, TodoState } from '../../../shared/todo';
import { CanvasAssignments } from './CanvasAssignments';

const { startLearning, openProject, openLink } = vi.hoisted(() => ({
  startLearning: vi.fn<typeof import('./start-learning').startLearning>(async () => {}),
  openProject: vi.fn(),
  openLink: vi.fn(async () => {}),
}));
vi.mock('./start-learning', () => ({ startLearning }));
vi.mock('../../navigation/view', () => ({
  useNavigationStore: { getState: () => ({ openProject }) },
}));

const state: LearningState = {
  root: '/semester',
  syncedAt: null,
  tasks: [],
  notes: [],
  practice: [],
  warnings: [],
  courses: [1, 2].map((id) => ({
    id,
    name: `课程${id}`,
    projectId: `project-${id}`,
    directory: `/semester/${id}`,
    workingDirectory: `/work/${id}`,
    sources: [],
  })),
};
const item = (id: number, courseId: number, status: TodoItem['status'] = 'pending'): TodoItem => ({
  id: `todo-${id}`,
  source: 'canvas',
  assignmentId: id,
  courseId,
  courseName: `课程${courseId}`,
  title: `作业${id}`,
  status,
  notes: '',
  dueAt: null,
  readAt: null,
  createdAt: '2026-10-29T00:00:00Z',
  syncedAt: '2026-10-29T00:00:00Z',
  url: `https://oc.sjtu.edu.cn/courses/${courseId}/assignments/${id}`,
});
const snapshot = (items: TodoItem[]): TodoState => ({
  items,
  connected: true,
  syncing: false,
  syncedAt: '2026-10-29T00:00:00Z',
  error: null,
});
const getState = vi.fn();
const refresh = vi.fn();
let host: HTMLDivElement;
let root: Root;
let update: (value: TodoState) => void;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const current = snapshot([
    item(1, 1),
    item(2, 2),
    item(3, 1, 'submitted'),
    item(4, 2, 'resubmit'),
    item(5, 2, 'unknown'),
    item(6, 1, 'offline'),
  ]);
  getState.mockResolvedValue(current);
  refresh.mockResolvedValue(current);
  startLearning.mockResolvedValue(undefined);
  window.dela = {
    todo: {
      getState,
      refresh,
      onUpdate: (listener: typeof update) => {
        update = listener;
        return () => {};
      },
    },
    canvas: { openLink },
  } as unknown as typeof window.dela;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete window.dela;
  vi.unstubAllGlobals();
});
function button(label: string) {
  const match = [...host.querySelectorAll('button')].find(
    (node) => node.textContent === label || node.getAttribute('aria-label') === label,
  );
  if (!match) throw new Error(`Missing button ${label}`);
  return match;
}

it('refreshes all courses and lists only confirmed pending or resubmission items as actionable', async () => {
  await act(async () => root.render(<CanvasAssignments state={state} reload={0} />));
  expect(refresh).toHaveBeenCalledOnce();
  expect(host.querySelector('select')?.value).toBe('all');
  expect(button('完成作业：作业1').disabled).toBe(false);
  expect(button('完成作业：作业2').disabled).toBe(false);
  expect(button('完成作业：作业4').disabled).toBe(false);
  expect(host.textContent).not.toContain('作业3');
  expect(host.querySelector('details')?.textContent).toContain('作业5');
  expect(host.querySelector('details')?.textContent).toContain('作业6');
  expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(4);
  expect(startLearning).not.toHaveBeenCalled();
});

it('passes exact Canvas identity and requirements even when no local assignment source exists', async () => {
  await act(async () => root.render(<CanvasAssignments state={state} reload={0} />));
  await act(async () => button('完成作业：作业2').click());
  expect(startLearning).toHaveBeenCalledWith(state.courses[1], 'assignment', undefined, {
    sources: [],
    assignment: item(2, 2),
  });
  expect(openProject).not.toHaveBeenCalled();
});

it('preserves pending eligibility of checked local work and reuses the matching source and record', async () => {
  const source = {
    sourceId: 'assignment:1',
    title: '原题1',
    kind: 'assignment',
    localPath: '/semester/1/assignment.html',
    version: 'v1',
    revision: 'r1',
  };
  const task: LearningTask = {
    id: 'checked-1',
    courseId: 1,
    title: '已复核',
    assignmentSourceId: 'assignment:1',
    dueAt: null,
    status: 'checked',
    requirements: [],
    deliverables: [],
    evidence: [],
    findings: [],
    checks: [],
    updatedAt: '2026-10-29T00:00:00Z',
    checkedAt: null,
    warnings: [],
  };
  const withWork = {
    ...state,
    courses: [{ ...state.courses[0]!, sources: [source] }, state.courses[1]!],
    tasks: [task],
  };
  await act(async () => root.render(<CanvasAssignments state={withWork} reload={0} />));
  expect(host.textContent).toContain('本地：已复核（提交状态见上方）');
  await act(async () => button('检查答案：作业1').click());
  expect(startLearning).toHaveBeenCalledWith(withWork.courses[0], 'review', task, {
    sources: [source],
    assignment: item(1, 1),
  });
});

it('queues selected assignments across courses only after the batch button is clicked', async () => {
  await act(async () => root.render(<CanvasAssignments state={state} reload={0} />));
  await act(async () =>
    host.querySelector<HTMLInputElement>('[aria-label="全选可处理的未提交作业"]')!.click(),
  );
  expect(startLearning).not.toHaveBeenCalled();
  await act(async () => button('完成所选作业').click());
  expect(startLearning).toHaveBeenCalledTimes(3);
  expect(startLearning.mock.calls.map((call) => call[0])).toEqual([
    state.courses[0],
    state.courses[1],
    state.courses[1],
  ]);
});

it('keeps assignments from unbound courses visible and provides a binding action', async () => {
  refresh.mockResolvedValue(snapshot([item(7, 3)]));
  await act(async () => root.render(<CanvasAssignments state={state} reload={0} />));
  expect(host.textContent).toContain('课程3');
  expect(host.textContent).toContain('作业7');
  expect(host.textContent).toContain('尚未关联本地课程文件夹');
  expect(button('完成所选作业').disabled).toBe(true);
  await act(async () => button('关联课程资料').click());
  expect(openProject).toHaveBeenCalledWith('');
  expect(startLearning).not.toHaveBeenCalled();
});

it('retains cached rows but disables processing when the refresh fails', async () => {
  refresh.mockRejectedValue(new Error('Canvas 连接失败'));
  await act(async () => root.render(<CanvasAssignments state={state} reload={0} />));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Canvas 连接失败');
  expect(host.textContent).toContain('上次记录（待核对）');
  expect(button('完成作业：作业1').disabled).toBe(true);
  expect(startLearning).not.toHaveBeenCalled();
});

it('permits only freshly verified courses after a partial Canvas refresh', async () => {
  refresh.mockResolvedValue({
    ...snapshot([item(1, 1), item(2, 2), item(7, 3)]),
    error: '课程2：Canvas 连接失败',
    canvasCourses: [
      { id: 1, name: '课程1', code: '', syncedAt: '2026-10-29T00:00:00Z', error: null },
      {
        id: 2,
        name: '课程2',
        code: '',
        syncedAt: '2026-10-28T00:00:00Z',
        error: 'Canvas 连接失败',
      },
      { id: 4, name: '暂无作业的课程', code: '', syncedAt: '2026-10-29T00:00:00Z', error: null },
    ],
  });
  await act(async () => root.render(<CanvasAssignments state={state} reload={0} />));
  expect(button('完成作业：作业1').disabled).toBe(false);
  expect(button('完成作业：作业2').disabled).toBe(true);
  expect(host.querySelector('select')?.textContent).toContain('暂无作业的课程');
  await act(async () =>
    host.querySelector<HTMLInputElement>('[aria-label="全选可处理的未提交作业"]')!.click(),
  );
  await act(async () => button('完成所选作业').click());
  expect(startLearning).toHaveBeenCalledOnce();
  expect(startLearning.mock.calls[0]?.[0]).toEqual(state.courses[0]);
});

it('does not treat cached rows of an absent Canvas course as freshly verified', async () => {
  refresh.mockResolvedValue({ ...snapshot([item(1, 1)]), canvasCourses: [] });
  await act(async () => root.render(<CanvasAssignments state={state} reload={0} />));
  expect(button('完成作业：作业1').disabled).toBe(true);
  expect(host.textContent).toContain('上次记录（待核对）');
});

it('removes newly submitted items from selection on Canvas state updates', async () => {
  await act(async () => root.render(<CanvasAssignments state={state} reload={0} />));
  await act(async () =>
    host.querySelector<HTMLInputElement>('[aria-label="全选可处理的未提交作业"]')!.click(),
  );
  await act(async () => update(snapshot([item(1, 1, 'submitted'), item(2, 2)])));
  expect(host.textContent).not.toContain('作业1');
  await act(async () => button('完成所选作业').click());
  expect(startLearning).toHaveBeenCalledOnce();
  expect(startLearning.mock.calls[0]?.[0]).toEqual(state.courses[1]);
});

it('does not enqueue twice when the same assignment action is clicked before render', async () => {
  let finish!: () => void;
  startLearning.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => root.render(<CanvasAssignments state={state} reload={0} />));
  await act(async () => {
    button('完成作业：作业1').click();
    button('完成作业：作业1').click();
  });
  expect(startLearning).toHaveBeenCalledOnce();
  await act(async () => finish());
});
