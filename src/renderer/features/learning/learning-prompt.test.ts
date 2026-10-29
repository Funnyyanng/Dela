import { expect, it } from 'vitest';
import type { LearningCourse } from '../../../shared/learning';
import type { TodoItem } from '../../../shared/todo';
import { learningPrompt } from './learning-prompt';

const course: LearningCourse = {
  id: 23,
  name: '课程甲',
  projectId: 'semester',
  directory: '/semester/课程甲',
  workingDirectory: '/work/23',
  sources: [],
};
const assignment: TodoItem = {
  id: 'canvas:23:42',
  source: 'canvas',
  courseId: 23,
  assignmentId: 42,
  title: '第一次作业',
  notes: '',
  status: 'pending',
  dueAt: null,
  createdAt: '2026-10-29T00:00:00Z',
  readAt: null,
  syncedAt: '2026-10-29T01:00:00Z',
};

it('keeps a Canvas assignment concrete even when its files are not locally registered', () => {
  const prompt = learningPrompt(course, 'assignment', undefined, { assignment });
  expect(prompt).toContain('完成所选作业');
  expect(prompt).toContain('"courseId":23,"assignmentId":42');
  expect(prompt).toContain('"dueAt":null');
  expect(prompt).toContain('query_assignments');
  expect(prompt).toContain('refresh_canvas_course');
  expect(prompt).toContain('sync_local_canvas');
  expect(prompt).toContain('已经提交、已批改或豁免时跳过');
  expect(prompt).toContain('不要提交到 Canvas');
  expect(prompt).toContain('不开始、继续或提交测验');
});

it('keeps selected notes independent of the Canvas pending assignment gate', () => {
  const prompt = learningPrompt(course, 'notes', undefined, {
    paths: ['/semester/课程甲/课件.pdf'],
  });
  expect(prompt).toContain('所选材料的学习笔记');
  expect(prompt).not.toContain('本次作业来自 Canvas 未提交清单');
});
