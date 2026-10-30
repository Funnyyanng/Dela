import { DatabaseSync } from 'node:sqlite';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { RunEvent, WorkspaceChat } from '../../shared/session';
const mock = vi.hoisted(() => ({
  db: null as unknown,
  ask: vi.fn(),
  cancel: vi.fn(),
  fresh: vi.fn(),
  listeners: new Set<(event: RunEvent) => void>(),
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
}));
vi.mock('../database', () => ({ getDatabase: () => mock.db }));
vi.mock('../workspace/api', () => ({ projectDirectory: () => '/project' }));
vi.mock('../learning', () => ({
  refreshLearningSources: async () => {},
  getLearningState: () => ({
    courses: [
      {
        id: 7,
        name: '密码学',
        projectId: '11111111-1111-4111-8111-111111111111',
        directory: '/project/课程',
        workingDirectory: '/work',
        sources: [],
      },
    ],
    tasks: [],
    notes: [],
  }),
}));
vi.mock('../canvas/local-sync', () => ({
  syncLocalCanvas: vi.fn(async () => ({ failed: [], conflicts: [] })),
}));
vi.mock('../context', () => ({ contextFor: () => '' }));
vi.mock('../todo', () => ({ refreshTodos: mock.fresh }));
vi.mock('../agent/session', () => ({
  askSession: mock.ask,
  cancelRun: mock.cancel,
  locateSessionFile: (_id: string, path: string) => path,
  markManagedSession: vi.fn(),
  newSession: () => ({ sessionId: '22222222-2222-4222-8222-222222222222', configured: true }),
  openSession: () => ({ sessionId: '22222222-2222-4222-8222-222222222222', configured: true }),
  subscribeRunEvents: (fn: (event: RunEvent) => void) => {
    mock.listeners.add(fn);
    return () => mock.listeners.delete(fn);
  },
}));
let db: DatabaseSync;
let jobs: typeof import('./index');
const projectId = '11111111-1111-4111-8111-111111111111';
const input = {
  domain: 'project' as const,
  projectId,
  title: '检查成果',
  action: 'review',
  objectKey: 'one',
  prompt: '检查已有成果',
};
const result = {
  messages: [{ role: 'assistant', content: '本轮已完成' }],
  contextUsage: {
    tokens: 100,
    contextWindow: 1000,
    percent: 10,
    inputTokens: 50,
    outputTokens: 30,
    cachedTokens: 20,
  },
} as WorkspaceChat;
async function idle() {
  await vi.waitFor(() =>
    expect(jobs.getJobState().jobs.some((job) => job.status === 'running')).toBe(false),
  );
}
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mock.listeners.clear();
  db = new DatabaseSync(':memory:');
  mock.db = db;
  mock.ask.mockResolvedValue(result);
  mock.fresh.mockResolvedValue({
    connected: true,
    syncedAt: 'now',
    error: null,
    items: [{ source: 'canvas', courseId: 7, assignmentId: 4, status: 'pending' }],
    canvasCourses: [{ id: 7, syncedAt: 'now', error: null }],
  });
  jobs = await import('./index');
  jobs.initializeJobs();
});
afterEach(() => {
  jobs.shutdownJobs();
  db.close();
});
it('deduplicates an active object, queues serially and preserves results and actual usage', async () => {
  let finish!: (r: WorkspaceChat) => void;
  mock.ask.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const one = jobs.enqueueJob(input),
    duplicate = jobs.enqueueJob(input),
    two = jobs.enqueueJob({ ...input, objectKey: 'two' });
  expect(duplicate.id).toBe(one.id);
  expect(jobs.getJobState().jobs.find((job) => job.id === two.id)?.status).toBe('queued');
  expect(mock.ask).toHaveBeenCalledTimes(1);
  finish(result);
  await idle();
  expect(mock.ask).toHaveBeenCalledTimes(2);
  expect(jobs.getJobState().jobs.every((job) => job.status === 'completed')).toBe(true);
  expect(jobs.getJobState().jobs[0]?.usage?.cachedTokens).toBe(20);
});
it('recovers running jobs as interrupted and keeps queued tasks awaiting manual resume', async () => {
  mock.ask.mockReturnValue(new Promise(() => {}));
  const one = jobs.enqueueJob(input);
  jobs.enqueueJob({ ...input, objectKey: 'two' });
  jobs.shutdownJobs();
  vi.resetModules();
  jobs = await import('./index');
  jobs.initializeJobs();
  expect(jobs.getJobState().jobs.map((job) => [job.status, job.awaitingResume])).toEqual([
    ['interrupted', true],
    ['queued', true],
  ]);
  expect(mock.ask).toHaveBeenCalledTimes(1);
  mock.ask.mockResolvedValue(result);
  jobs.resumeJob(one.id);
  await idle();
  expect(jobs.getJobState().jobs[0]?.status).toBe('completed');
  expect(mock.ask.mock.calls.at(-1)?.[1].text).toContain('先检查已经生成的文件');
});
it('shows needs-input, continues other queued work and resumes the same session with the response', async () => {
  mock.ask.mockImplementationOnce(async () => {
    const job = jobs.getJobState().jobs[0]!;
    jobs.reportJobProgress({ jobId: job.id, stage: '核对要求', question: '报告使用哪组数据？' });
    return result;
  });
  const one = jobs.enqueueJob(input);
  jobs.enqueueJob({ ...input, objectKey: 'two' });
  await idle();
  expect(jobs.getJobState().jobs[0]?.status).toBe('needs_input');
  expect(jobs.getJobState().jobs[1]?.status).toBe('completed');
  expect(() => jobs.resumeJob(one.id)).toThrow('补充');
  jobs.resumeJob(one.id, '使用数据 A');
  await idle();
  expect(mock.ask.mock.calls.at(-1)?.[1].text).toContain('使用数据 A');
  expect(jobs.getJobState().jobs[0]?.status).toBe('completed');
});
it('honors explicit model failure events even when ask resolves', async () => {
  mock.ask.mockImplementationOnce(async () => {
    for (const listener of mock.listeners)
      listener({
        sessionId: '22222222-2222-4222-8222-222222222222',
        runId: 'run',
        status: 'failed',
      });
    return result;
  });
  jobs.enqueueJob(input);
  await idle();
  expect(jobs.getJobState().jobs[0]?.status).toBe('failed');
});
it('skips newly submitted Canvas homework and permits a fresh course when another failed', async () => {
  mock.fresh.mockResolvedValueOnce({
    connected: true,
    canvasCourses: [{ id: 7, syncedAt: 'now', error: null }],
    items: [{ source: 'canvas', courseId: 7, assignmentId: 4, status: 'submitted' }],
  });
  jobs.enqueueJob({
    domain: 'learning',
    projectId,
    title: 'EX4',
    action: 'assignment',
    courseId: 7,
    assignmentId: 4,
  });
  await idle();
  expect(jobs.getJobState().jobs[0]?.status).toBe('skipped');
  expect(mock.ask).not.toHaveBeenCalled();
  mock.fresh.mockResolvedValueOnce({
    connected: true,
    error: 'other course failed',
    canvasCourses: [{ id: 7, syncedAt: 'now', error: null }],
    items: [{ source: 'canvas', courseId: 7, assignmentId: 5, status: 'pending' }],
  });
  jobs.enqueueJob({
    domain: 'learning',
    projectId,
    title: 'EX5',
    action: 'assignment',
    courseId: 7,
    assignmentId: 5,
  });
  await idle();
  expect(mock.ask).toHaveBeenCalledOnce();
});
it('refuses stale Canvas status without starting the model', async () => {
  mock.fresh.mockResolvedValueOnce({
    connected: true,
    error: 'network',
    canvasCourses: [{ id: 7, syncedAt: 'old', error: 'network' }],
    items: [],
  });
  jobs.enqueueJob({
    domain: 'learning',
    projectId,
    title: 'EX4',
    action: 'assignment',
    courseId: 7,
    assignmentId: 4,
  });
  await idle();
  expect(jobs.getJobState().jobs[0]?.status).toBe('failed');
  expect(mock.ask).not.toHaveBeenCalled();
});
it('reorders only waiting jobs and cancelled work never runs', async () => {
  let finish!: (r: WorkspaceChat) => void;
  mock.ask.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  jobs.enqueueJob(input);
  const two = jobs.enqueueJob({ ...input, objectKey: 'two', prompt: 'two' }),
    three = jobs.enqueueJob({ ...input, objectKey: 'three', prompt: 'three' });
  jobs.reorderJobs([three.id, two.id]);
  jobs.cancelJob(two.id);
  finish(result);
  await idle();
  expect(mock.ask).toHaveBeenCalledTimes(2);
  expect(mock.ask.mock.calls[1]?.[1].text).toContain('three');
  expect(jobs.getJobState().jobs.find((job) => job.id === two.id)?.status).toBe('stopped');
});

it('after cancelling exit only new tasks run; interrupted and previously queued work wait for recovery', async () => {
  let finish!: (r: WorkspaceChat) => void;
  mock.ask.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = jobs.enqueueJob(input);
  const waiting = jobs.enqueueJob({ ...input, objectKey: 'waiting' });
  jobs.shutdownJobs();
  expect(jobs.getJobState().jobs.find((job) => job.id === first.id)?.status).toBe('interrupted');
  expect(jobs.getJobState().jobs.find((job) => job.id === waiting.id)?.awaitingResume).toBe(true);
  jobs.cancelJobsShutdown();
  const fresh = jobs.enqueueJob({ ...input, objectKey: 'fresh' });
  finish(result);
  await vi.waitFor(() =>
    expect(jobs.getJobState().jobs.find((job) => job.id === fresh.id)?.status).toBe('completed'),
  );
  expect(mock.ask).toHaveBeenCalledTimes(2);
  expect(jobs.getJobState().jobs.find((job) => job.id === first.id)?.status).toBe('interrupted');
  expect(jobs.getJobState().jobs.find((job) => job.id === waiting.id)?.status).toBe('queued');
  expect(jobs.getJobState().jobs.find((job) => job.id === fresh.id)?.status).toBe('completed');
});

it('does not expand a removed selection into a whole-course notes task', async () => {
  jobs.enqueueJob({
    domain: 'learning',
    projectId,
    courseId: 7,
    title: '原选课件',
    action: 'notes',
    sourceIds: ['local:removed'],
  });
  await idle();
  expect(jobs.getJobState().jobs[0]?.error).toContain('重新选择');
  expect(mock.ask).not.toHaveBeenCalled();
});

it('replays persisted terminal notifications on startup without changing their identity or running models', async () => {
  const done = jobs.enqueueJob(input);
  await idle();
  jobs.shutdownJobs();
  const saved = JSON.parse(
    (db.prepare('SELECT data FROM execution_jobs WHERE id=?').get(done.id) as { data: string })
      .data,
  );
  for (const [index, status] of ['failed', 'needs_input'].entries()) {
    const id = `33333333-3333-4333-8333-33333333333${index}`;
    db.prepare('INSERT INTO execution_jobs VALUES (?,?)').run(
      id,
      JSON.stringify({
        ...saved,
        id,
        status,
        question: status === 'needs_input' ? '补充要求' : null,
      }),
    );
  }
  vi.resetModules();
  jobs = await import('./index');
  const notify = vi.fn();
  jobs.initializeJobs({ onTerminal: notify });
  expect(notify).toHaveBeenCalledTimes(3);
  expect(notify.mock.calls.map(([job]) => job.status).sort()).toEqual([
    'completed',
    'failed',
    'needs_input',
  ]);
  expect(notify.mock.calls.find(([job]) => job.id === done.id)?.[0].finishedAt).toBe(
    saved.finishedAt,
  );
  expect(mock.ask).toHaveBeenCalledOnce();
  jobs.initializeJobs({ onTerminal: notify });
  expect(notify).toHaveBeenCalledTimes(3);
});
