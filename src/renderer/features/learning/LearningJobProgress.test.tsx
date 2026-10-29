// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WorkspaceChat } from '../../../shared/session';
import { useSessions } from '../../sessions/store';
import { LearningJobProgress } from './LearningJobProgress';
import { useLearningJobs, type LearningJob } from './learning-jobs';

const { openChat, openProject, openDocument } = vi.hoisted(() => ({
  openChat: vi.fn(),
  openProject: vi.fn(() => true),
  openDocument: vi.fn(),
}));
vi.mock('../../navigation/view', () => ({
  useNavigationStore: { getState: () => ({ openChat, openProject, openDocument }) },
}));
vi.mock('../../content/chat/markdown', () => ({
  ChatMarkdown: ({ children }: { children: string }) => children,
}));

const job: LearningJob = {
  id: 'job',
  projectId: 'semester',
  courseId: 7,
  courseName: '密码学',
  title: 'EX4',
  action: 'assignment',
  status: 'queued',
  sessionId: null,
  error: null,
  result: '',
  files: [],
  startedAt: null,
  finishedAt: null,
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  useLearningJobs.setState({ jobs: [job] });
  useSessions.setState({ chats: {} });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('shows queue, live progress and registered results in place without opening chat', async () => {
  await act(async () => root.render(<LearningJobProgress projectId="semester" />));
  expect(container.textContent).toContain('等待处理');
  await act(async () => {
    useLearningJobs.getState().update('job', { status: 'running', sessionId: 'session' });
    useSessions.getState().putChat('session', {
      messages: [{ role: 'assistant', content: '正在核对第四题' }],
      activeTool: 'read_resource',
    } as WorkspaceChat);
  });
  expect(container.textContent).toContain('正在核对第四题');
  expect(container.textContent).toContain('正在读取或核验资料');
  await act(async () =>
    useLearningJobs.getState().update('job', {
      status: 'completed',
      result: '已生成答案，仍需提交',
      files: [{ path: '/courses/密码学/EX4.pdf', title: 'EX4.pdf' }],
    }),
  );
  expect(container.textContent).toContain('本轮处理结束');
  expect(container.textContent).toContain('已生成答案，仍需提交');
  expect(openChat).not.toHaveBeenCalled();
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '打开：EX4.pdf')!
      .click(),
  );
  expect(openDocument).toHaveBeenCalledWith('/courses/密码学/EX4.pdf', { keep: true });
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '查看过程')!
      .click(),
  );
  expect(openChat).toHaveBeenCalledWith('session', 'semester');
});

it('preserves job status across view remount and can cancel queued work', async () => {
  await act(async () => root.render(<LearningJobProgress courseId={9} />));
  expect(container.textContent).toBe('');
  await act(async () => root.render(<LearningJobProgress courseId={7} />));
  expect(container.textContent).toContain('EX4');
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '取消排队')!
      .click(),
  );
  expect(useLearningJobs.getState().jobs[0]!.status).toBe('stopped');
  expect(container.textContent).toContain('已停止');
});
