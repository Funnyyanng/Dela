// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectsView } from './ProjectsView';
import type { ProjectOverview } from '../../../shared/projects';
vi.mock('../learning/LearningJobProgress', () => ({ LearningJobProgress: () => null }));
const project: ProjectOverview = {
  projectId: 'ad857632-dca2-4314-9584-8498e25c7367',
  name: '原型项目',
  directory: '/projects/demo',
  remote: false,
  type: 'code',
  goal: '完成可用原型',
  successCriteria: '检查通过',
  stage: '实现',
  nextStep: '验证',
  conventions: '保留已有成果',
  milestones: [],
  references: [],
  syncPaths: [],
  updatedAt: null,
};
const enqueue = vi.fn();
const prepare = vi.fn();
const saveTodo = vi.fn();
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  prepare.mockResolvedValue({
    domain: 'project',
    projectId: project.projectId,
    title: '检查项目成果',
    action: 'review',
    prompt: 'verify',
  });
  window.dela = {
    projects: {
      getState: vi.fn(async () => ({ projects: [project] })),
      onUpdate: () => () => {},
      prepareAction: prepare,
    },
    todo: {
      getState: vi.fn(async () => ({ items: [] })),
      onUpdate: () => () => {},
      save: saveTodo,
    },
    jobs: { enqueue },
    workspace: { importProjectFolder: vi.fn() },
  } as unknown as typeof window.dela;
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete window.dela;
  vi.unstubAllGlobals();
});
it('shows existing project metadata and queues a concrete review without completing user tasks', async () => {
  await act(async () => root.render(<ProjectsView />));
  expect(host.textContent).toContain('原型项目');
  expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('完成可用原型');
  await act(async () =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === '检查项目成果')!
      .click(),
  );
  expect(prepare).toHaveBeenCalledWith(project.projectId, 'review', undefined);
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({ domain: 'project', projectId: project.projectId }),
  );
  expect(saveTodo).not.toHaveBeenCalled();
  expect(host.textContent).toContain('已加入任务中心');
});
it('shows a retryable read failure rather than a successful empty project list', async () => {
  vi.mocked(window.dela!.projects.getState).mockRejectedValue(new Error('项目读取失败'));
  await act(async () => root.render(<ProjectsView />));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('项目读取失败');
  expect([...host.querySelectorAll('button')].some((button) => button.textContent === '刷新')).toBe(
    true,
  );
});

it('keeps the original revision while editing and preserves the draft after a concurrent update conflict', async () => {
  let update: ((state: { projects: ProjectOverview[] }) => void) | undefined;
  window.dela!.projects.onUpdate = (listener) => {
    update = listener;
    return () => {};
  };
  const save = vi.fn().mockRejectedValue(new Error('项目记录已由其他操作更新'));
  window.dela!.projects.save = save;
  await act(async () => root.render(<ProjectsView />));
  const select = [...host.querySelectorAll('label')]
    .find((label) => label.textContent?.startsWith('项目类型'))!
    .querySelector('select')!;
  await act(async () => {
    select.value = 'research';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(host.textContent).toContain('有未保存的修改');
  expect(
    [...host.querySelectorAll('button')].find((button) => button.textContent === '保存项目记录')!
      .disabled,
  ).toBe(false);
  await act(async () =>
    update!({
      projects: [
        {
          ...project,
          updatedAt: '2026-10-30T00:00:00.000Z',
          references: [
            {
              id: 'output',
              title: '后台成果',
              path: '/projects/demo/output.md',
              kind: 'deliverable',
            },
          ],
        },
      ],
    }),
  );
  await act(async () =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === '保存项目记录')!
      .click(),
  );
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ expectedUpdatedAt: null, type: 'research' }),
  );
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('项目记录已由其他操作更新');
  expect(select.value).toBe('research');
  await act(async () =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === '放弃修改')!
      .click(),
  );
  expect(host.textContent).toContain('后台成果');
});
