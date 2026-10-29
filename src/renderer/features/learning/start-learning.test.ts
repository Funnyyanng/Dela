// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import type { LearningCourse, LearningState, LearningTask } from '../../../shared/learning';
import { learningPrompt } from './learning-prompt';
import { resolveLearningSelection, startLearning } from './start-learning';

const { openChat, putChat, refresh } = vi.hoisted(() => ({
  openChat: vi.fn(() => true),
  putChat: vi.fn(),
  refresh: vi.fn(async () => {}),
}));
vi.mock('../../navigation/view', () => ({
  useNavigationStore: { getState: () => ({ openChat }) },
}));
vi.mock('../../sessions/store', () => ({
  useSessions: { getState: () => ({ putChat, refresh }) },
}));

const course: LearningCourse = {
  id: 7,
  name: '密码学',
  projectId: 'semester',
  directory: '/courses/密码学',
  workingDirectory: '/work/7',
  sources: [
    {
      sourceId: 'assignment:3',
      title: 'EX3',
      kind: 'assignment',
      localPath: '/courses/密码学/作业/EX3/说明.html',
      version: 'v3',
      revision: 'hash3',
    },
    {
      sourceId: 'file:4',
      title: '分组加密',
      kind: 'file',
      localPath: '/courses/密码学/课件/第三讲.pdf',
      version: 'v4',
      revision: 'hash4',
    },
  ],
};
const task: LearningTask = {
  id: 'task-three',
  courseId: 7,
  title: 'EX3 检查',
  assignmentSourceId: 'assignment:3',
  dueAt: null,
  status: 'checked',
  requirements: [],
  deliverables: [],
  evidence: [],
  findings: [],
  checks: [],
  warnings: [],
  updatedAt: '',
  checkedAt: null,
};
const state: LearningState = {
  root: '/courses',
  syncedAt: null,
  courses: [course],
  tasks: [task],
  notes: [],
  practice: [],
  warnings: [],
};
const create = vi.fn();
const ask = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  openChat.mockReturnValue(true);
  create.mockResolvedValue({ sessionId: 'chat-three', configured: true });
  ask.mockResolvedValue({ sessionId: 'chat-three', configured: true, running: true });
  Object.defineProperty(window, 'dela', {
    configurable: true,
    value: { session: { create, ask } },
  });
});

it('resolves an existing answer to its assignment while preserving the selected file', () => {
  const path = '/courses/密码学/作业/EX3/EX3.pdf';
  const resolved = resolveLearningSelection(state, 'semester', { localPath: path });
  expect(resolved?.course.id).toBe(7);
  expect(resolved?.target?.id).toBe('task-three');
  expect(resolved?.selection.paths).toEqual([path]);
  expect(resolved?.selection.sources?.map((source) => source.sourceId)).toEqual(['assignment:3']);
  const prompt = learningPrompt(course, 'review', resolved?.target, resolved?.selection);
  expect(prompt).toContain(path);
  expect(prompt).toContain('"version":"v3"');
  expect(prompt).toContain('记录 id=task-three');
  expect(prompt).not.toContain('第三讲.pdf');
});

it('matches course boundaries and project identity instead of similar prefixes', () => {
  expect(
    resolveLearningSelection(state, 'semester', { localPath: '/courses/密码学旧/答案.pdf' }),
  ).toBeNull();
  expect(
    resolveLearningSelection(state, 'another-project', { sourceId: 'assignment:3' }),
  ).toBeNull();
  const result = resolveLearningSelection(state, 'semester', { sourceId: 'file:4' });
  expect(result?.selection.sources?.[0]?.sourceId).toBe('file:4');
  expect(result?.target).toBeUndefined();
});

it('does not associate an answer with a sibling assignment folder sharing a prefix', () => {
  const result = resolveLearningSelection(state, 'semester', {
    localPath: '/courses/密码学/作业/EX30/答案.pdf',
  });
  expect(result?.target).toBeUndefined();
  expect(result?.selection.sources).toEqual([]);
});

it('starts the selected work with one send even for simultaneous duplicate clicks', async () => {
  let ready!: (value: unknown) => void;
  create.mockReturnValue(
    new Promise((resolve) => {
      ready = resolve;
    }),
  );
  const selection = { sources: [course.sources[1]!] };
  const first = startLearning(course, 'notes', undefined, selection);
  const duplicate = startLearning(course, 'notes', undefined, selection);
  expect(create).toHaveBeenCalledTimes(1);
  ready({ sessionId: 'chat-three', configured: true });
  await Promise.all([first, duplicate]);
  expect(openChat).toHaveBeenCalledWith('chat-three', 'semester');
  expect(ask).toHaveBeenCalledTimes(1);
  expect(ask.mock.calls[0]![1].text).toContain('"sourceId":"file:4"');
  expect(ask.mock.calls[0]![1].text).not.toContain('"sourceId":"assignment:3"');
});

it('never sends when the model is unconfigured or navigation is cancelled', async () => {
  create.mockResolvedValueOnce({ sessionId: 'chat-three', configured: false });
  await expect(startLearning(course, 'assignment')).rejects.toThrow('配置模型');
  expect(ask).not.toHaveBeenCalled();
  openChat.mockReturnValue(false);
  await expect(startLearning(course, 'assignment')).rejects.toThrow('尚未开始处理');
  expect(ask).not.toHaveBeenCalled();
});

it('allows a retry after sending fails', async () => {
  ask.mockRejectedValueOnce(new Error('模型连接失败'));
  await expect(startLearning(course, 'review', task)).rejects.toThrow('模型连接失败');
  await startLearning(course, 'review', task);
  expect(ask).toHaveBeenCalledTimes(2);
});
