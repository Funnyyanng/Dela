// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExecutionJob, JobState } from '../../../shared/jobs';
import { TaskCenterView } from './TaskCenterView';
import { initializeJobsMirror, useJobs } from './store';
const mocks = vi.hoisted(() => ({
  resume: vi.fn(),
  reorder: vi.fn(),
  openChat: vi.fn(),
  openDocument: vi.fn(),
}));
vi.mock('../../navigation/view', () => ({
  useNavigationStore: {
    getState: () => ({
      openProject: () => true,
      openDocument: mocks.openDocument,
      openChat: mocks.openChat,
    }),
  },
}));
vi.mock('../../content/chat/markdown', () => ({
  ChatMarkdown: ({ children }: { children: string }) => children,
}));
const base: ExecutionJob = {
  id: 'one',
  domain: 'learning',
  projectId: 'semester',
  courseId: 7,
  title: '密码学 EX4',
  action: 'assignment',
  status: 'queued',
  stage: '等待检查已有进度',
  sessionId: 'session',
  result: '',
  error: null,
  question: null,
  files: [],
  usage: null,
  sourceVersions: [],
  createdAt: 1,
  updatedAt: 1,
  startedAt: null,
  finishedAt: null,
  order: 1,
  awaitingResume: true,
};
let root: Root;
let host: HTMLDivElement;
let push: (state: JobState) => void;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useJobs.setState({ jobs: [], loading: true, error: null });
  window.dela = {
    jobs: {
      getState: async () => ({ jobs: [base] }),
      onUpdate: (fn: (state: JobState) => void) => {
        push = fn;
        return () => {};
      },
      resume: mocks.resume.mockResolvedValue({ jobs: [] }),
      reorder: mocks.reorder.mockResolvedValue({ jobs: [] }),
    },
  } as unknown as typeof window.dela;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it('shows persisted waiting work on reopen and resumes only by explicit action', async () => {
  await act(async () => root.render(<TaskCenterView />));
  expect(host.textContent).toContain('等待你恢复');
  expect(mocks.resume).not.toHaveBeenCalled();
  await act(async () =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === '检查进度并继续')!
      .click(),
  );
  expect(mocks.resume).toHaveBeenCalledExactlyOnceWith('one');
  expect(mocks.openChat).not.toHaveBeenCalled();
  await act(async () =>
    push({
      jobs: [
        {
          ...base,
          status: 'completed',
          awaitingResume: false,
          files: [{ path: '/semester/密码学/答案.pdf', title: '答案' }],
        },
      ],
    }),
  );
  await act(async () =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === '打开：答案.pdf')!
      .click(),
  );
  expect(mocks.openDocument).toHaveBeenCalledWith('/semester/密码学/答案.pdf', { keep: true });
});
it('accepts missing information beside its task without navigating to chat', async () => {
  await act(async () => root.render(<TaskCenterView />));
  await act(async () =>
    push({
      jobs: [{ ...base, status: 'needs_input', awaitingResume: false, question: '请补充题目附件' }],
    }),
  );
  const button = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === '补充并继续',
  )!;
  expect(button.disabled).toBe(true);
  await act(async () => {
    const input = host.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      input,
      '附件在课程作业文件夹中',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(mocks.resume).toHaveBeenCalledExactlyOnceWith('one', '附件在课程作业文件夹中');
  expect(mocks.openChat).not.toHaveBeenCalled();
});
it('a delayed initial snapshot cannot hide a newer queue update', async () => {
  let initial!: (state: JobState) => void;
  window.dela!.jobs.getState = () =>
    new Promise((resolve) => {
      initial = resolve;
    });
  initializeJobsMirror();
  push({ jobs: [{ ...base, status: 'running', awaitingResume: false }] });
  initial({ jobs: [] });
  await Promise.resolve();
  expect(useJobs.getState().jobs[0]?.status).toBe('running');
});
