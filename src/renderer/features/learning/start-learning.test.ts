// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import type { LearningCourse, LearningState, LearningTask } from '../../../shared/learning';
import { learningPrompt } from './learning-prompt';
import { resolveLearningSelection, startLearning } from './start-learning';
import { stopLearningJob, useLearningJobs } from './learning-jobs';
import type { RunEvent, WorkspaceChat } from '../../../shared/session';
import type { TodoItem } from '../../../shared/todo';

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
const todoRefresh = vi.fn();
const cancelRun = vi.fn();
let runListener: (event: RunEvent) => void;
const chat = {
  sessionId: 'chat-three',
  configured: true,
  running: false,
  messages: [{ role: 'assistant', content: '结果已保存' }],
} as WorkspaceChat;
const assignment: TodoItem = {
  id: 'canvas:7:3',
  source: 'canvas',
  courseId: 7,
  assignmentId: 3,
  title: 'EX3',
  notes: '',
  dueAt: null,
  status: 'pending',
  readAt: null,
  createdAt: '',
  syncedAt: '2026-10-29T00:00:00Z',
};
const todos = {
  items: [assignment],
  connected: true,
  syncing: false,
  syncedAt: assignment.syncedAt,
  error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  openChat.mockReturnValue(true);
  create.mockResolvedValue({ sessionId: 'chat-three', configured: true });
  ask.mockResolvedValue(chat);
  todoRefresh.mockResolvedValue(todos);
  useLearningJobs.setState({ jobs: [] });
  Object.defineProperty(window, 'dela', {
    configurable: true,
    value: {
      session: {
        create,
        ask,
        cancelRun,
        onRunEvent: (listener: typeof runListener) => {
          runListener = listener;
          return vi.fn();
        },
      },
      todo: { refresh: todoRefresh },
      learning: { getState: async () => state },
    },
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
  await Promise.resolve();
  expect(create).toHaveBeenCalledTimes(1);
  ready({ sessionId: 'chat-three', configured: true });
  await Promise.all([first, duplicate]);
  expect(openChat).not.toHaveBeenCalled();
  expect(useLearningJobs.getState().jobs).toEqual([
    expect.objectContaining({ status: 'completed', result: '结果已保存' }),
  ]);
  expect(ask).toHaveBeenCalledTimes(1);
  expect(ask.mock.calls[0]![1].text).toContain('"sourceId":"file:4"');
  expect(ask.mock.calls[0]![1].text).not.toContain('"sourceId":"assignment:3"');
});

it('never sends with an unconfigured model and never depends on navigation', async () => {
  create.mockResolvedValueOnce({ sessionId: 'chat-three', configured: false });
  await expect(startLearning(course, 'notes')).rejects.toThrow('配置模型');
  expect(ask).not.toHaveBeenCalled();
  openChat.mockReturnValue(false);
  await startLearning(course, 'notes');
  expect(ask).toHaveBeenCalledTimes(1);
  expect(openChat).not.toHaveBeenCalled();
});

it('allows a retry after sending fails', async () => {
  ask.mockRejectedValueOnce(new Error('模型连接失败'));
  await expect(startLearning(course, 'review', task)).rejects.toThrow('模型连接失败');
  await startLearning(course, 'review', task);
  expect(ask).toHaveBeenCalledTimes(2);
});

it('queues distinct jobs and can cancel one before it starts', async () => {
  let finish!: (value: WorkspaceChat) => void;
  ask.mockReturnValueOnce(
    new Promise<WorkspaceChat>((resolve) => {
      finish = resolve;
    }),
  );
  const first = startLearning(course, 'notes', undefined, { sources: [course.sources[1]!] });
  const second = startLearning(course, 'review', task);
  await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
  expect(useLearningJobs.getState().jobs.map((job) => job.status)).toEqual(['running', 'queued']);
  stopLearningJob(useLearningJobs.getState().jobs[1]!.id);
  finish(chat);
  await Promise.all([first, second]);
  expect(create).toHaveBeenCalledTimes(1);
  expect(useLearningJobs.getState().jobs[1]!.status).toBe('stopped');
});

it('refreshes Canvas at execution time and refuses an assignment submitted while queued', async () => {
  todoRefresh.mockResolvedValueOnce({ ...todos, items: [{ ...assignment, status: 'submitted' }] });
  await expect(startLearning(course, 'assignment', task, { assignment })).rejects.toThrow(
    '不是 Canvas 已确认的未提交作业',
  );
  expect(ask).not.toHaveBeenCalled();
  expect(useLearningJobs.getState().jobs[0]!.status).toBe('failed');
});

it('deduplicates a Canvas row and a local assignment file and uses fresh requirements', async () => {
  todoRefresh.mockResolvedValueOnce({
    ...todos,
    items: [{ ...assignment, dueAt: '2026-11-04T15:59:00Z' }],
  });
  const first = startLearning(course, 'assignment', task, { assignment });
  const duplicate = startLearning(course, 'assignment', task, {
    sources: [course.sources[0]!],
    paths: ['/courses/密码学/作业/EX3/说明.html'],
  });
  expect(first).toBe(duplicate);
  await first;
  expect(ask).toHaveBeenCalledTimes(1);
  expect(ask.mock.calls[0]![1].text).toContain('2026-11-04T15:59:00Z');
});

it('continues a verified course if another course failed but refuses stale target coverage', async () => {
  todoRefresh.mockResolvedValueOnce({
    ...todos,
    error: '另一门课失败',
    canvasCourses: [{ id: 7, syncedAt: assignment.syncedAt, error: null }],
  });
  await startLearning(course, 'assignment', task, { assignment });
  expect(ask).toHaveBeenCalledTimes(1);
  todoRefresh.mockResolvedValueOnce({
    ...todos,
    error: '本课程失败',
    canvasCourses: [{ id: 7, syncedAt: assignment.syncedAt, error: '本课程失败' }],
  });
  await expect(startLearning(course, 'assignment', task, { assignment })).rejects.toThrow(
    '本课程失败',
  );
  expect(ask).toHaveBeenCalledTimes(1);
});

it('treats a model failure returned as a snapshot as failed and continues the queue', async () => {
  ask.mockImplementationOnce(async () => {
    runListener({ sessionId: 'chat-three', runId: 'run', status: 'failed' });
    return { ...chat, messages: [{ role: 'assistant', content: '模型连接失败' }] };
  });
  const first = startLearning(course, 'review', task);
  const next = startLearning(course, 'notes');
  await expect(first).rejects.toThrow('模型连接失败');
  await next;
  expect(useLearningJobs.getState().jobs.map((job) => job.status)).toEqual(['failed', 'completed']);
});

it('records a stopped run without claiming completion', async () => {
  ask.mockImplementationOnce(async () => {
    runListener({ sessionId: 'chat-three', runId: 'run', status: 'stopped' });
    return chat;
  });
  await startLearning(course, 'notes');
  expect(useLearningJobs.getState().jobs[0]!.status).toBe('stopped');
});

it('refuses a local task without Canvas identity and a course missing from the latest coverage', async () => {
  await expect(startLearning(course, 'assignment')).rejects.toThrow('具体的 Canvas 未提交作业');
  expect(todoRefresh).not.toHaveBeenCalled();
  todoRefresh.mockResolvedValueOnce({ ...todos, canvasCourses: [] });
  await expect(startLearning(course, 'assignment', task, { assignment })).rejects.toThrow(
    '尚未核对这门课',
  );
  expect(ask).not.toHaveBeenCalled();
});

it('offers registered notes for a selected local file after its source is discovered', async () => {
  const localPath = '/courses/密码学/课件/补充材料.pdf';
  const discovered = { ...course.sources[1]!, sourceId: 'local:new', localPath };
  window.dela!.learning.getState = async () => ({
    ...state,
    courses: [{ ...course, sources: [...course.sources, discovered] }],
    notes: [
      {
        id: 'note',
        courseId: 7,
        title: '补充笔记',
        path: '/courses/密码学/笔记.md',
        revision: 'v1',
        coveredSources: [{ sourceId: 'local:new', version: 'v1' }],
        updatedAt: '',
        warnings: [],
      },
    ],
  });
  await startLearning(course, 'notes', undefined, { paths: [localPath] });
  expect(useLearningJobs.getState().jobs[0]).toEqual(
    expect.objectContaining({
      title: '补充材料.pdf',
      files: [{ title: '补充笔记', path: '/courses/密码学/笔记.md' }],
    }),
  );
});
