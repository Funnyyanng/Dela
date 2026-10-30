// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import type { LearningCourse, LearningState, LearningTask } from '../../../shared/learning';
import { resolveLearningSelection, startLearning } from './start-learning';
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

const enqueue = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  enqueue.mockResolvedValue({ id: 'job' });
  window.dela = { jobs: { enqueue } } as unknown as typeof window.dela;
});
it('enqueues an exact Canvas assignment without creating or opening a chat', async () => {
  await startLearning(course, 'assignment', task, { sources: [course.sources[0]!] });
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      domain: 'learning',
      projectId: 'semester',
      courseId: 7,
      action: 'assignment',
      assignmentId: 3,
      targetId: 'task-three',
      sourceIds: ['assignment:3'],
    }),
  );
});
it('preserves chosen note paths and reports queue acceptance failures', async () => {
  const paths = ['/courses/密码学/课件/第三讲.pdf'];
  await startLearning(course, 'notes', undefined, { paths });
  expect(enqueue.mock.calls[0]?.[0]).toMatchObject({ action: 'notes', paths, title: '第三讲.pdf' });
  enqueue.mockRejectedValueOnce(new Error('无法保存队列'));
  await expect(startLearning(course, 'notes', undefined, { paths })).rejects.toThrow(
    '无法保存队列',
  );
});
it('resolves assignment files to their concrete course and existing record', () => {
  const selected = resolveLearningSelection(state, 'semester', {
    localPath: '/courses/密码学/作业/EX3/答案.pdf',
  });
  expect(selected?.course.id).toBe(7);
  expect(selected?.target?.id).toBe('task-three');
  expect(selected?.selection.sources?.map((source) => source.sourceId)).toEqual(['assignment:3']);
  expect(
    resolveLearningSelection(state, 'other', { localPath: '/courses/密码学/作业/EX3' }),
  ).toBeNull();
  expect(
    resolveLearningSelection(state, 'semester', { localPath: '/courses/密码学相邻/文件.pdf' }),
  ).toBeNull();
});
