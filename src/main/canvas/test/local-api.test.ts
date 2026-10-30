import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../credentials', () => ({
  loadCanvasToken: () => 'fixture-token',
}));
vi.mock('../../database', () => ({ getDatabase: vi.fn() }));

import {
  getCanvasAttachment,
  syncCanvasAssignment,
  getCanvasQuizzes,
  listTodoCanvasCourses,
  readCanvasPage,
} from '../api';
import { getDatabase } from '../../database';

afterEach(() => vi.unstubAllGlobals());

describe('local course source metadata', () => {
  it('lists all active enrolled courses across pages without applying local archive filters', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 1,
              name: '当前课程',
              course_code: 'NOW',
              term: { name: '2026-2027 Fall' },
            },
          ]),
          {
            headers: {
              Link: '<https://oc.sjtu.edu.cn/api/v1/courses?page=2>; rel="next"',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 2,
              name: '仍在修读的课程',
              course_code: 'ACTIVE',
              term: { name: '2025-2026 Fall' },
            },
            { id: 3, name: '未标注学期' },
            { name: '无权访问' },
          ]),
        ),
      );
    vi.stubGlobal('fetch', fetch);
    expect(await listTodoCanvasCourses()).toEqual([
      { id: 1, name: '当前课程', code: 'NOW', term: '2026-2027 Fall' },
      { id: 2, name: '仍在修读的课程', code: 'ACTIVE', term: '2025-2026 Fall' },
      { id: 3, name: '未标注学期', code: '' },
    ]);
    expect(String(fetch.mock.calls[0]![0])).toContain('enrollment_state=active');
    expect(String(fetch.mock.calls[0]![0])).toContain('include[]=term');
    expect(String(fetch.mock.calls[1]![0])).toContain('page=2');
  });
  it('fills previously cached assignment metadata with actual versions and available rubric', async () => {
    const source = {
      id: 'assignment:7',
      courseId: 9,
      kind: 'assignment',
      title: '报告',
      html: '<p>旧描述</p>',
    };
    const run = vi.fn();
    vi.mocked(getDatabase).mockReturnValue({
      prepare: () => ({ get: () => ({ data: JSON.stringify(source) }), run }),
    } as unknown as ReturnType<typeof getDatabase>);
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 7,
          description: '<p>最新要求</p>',
          updated_at: '2026-10-28T09:00:00Z',
          due_at: null,
          submission_types: ['online_upload'],
          allowed_extensions: ['pdf'],
          rubric: [{ description: '计算', points: 10 }],
          use_rubric_for_grading: false,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await readCanvasPage('assignment:7')).toMatchObject({
      text: '<p>最新要求</p>',
      updatedAt: '2026-10-28T09:00:00Z',
      dueAt: null,
      assignmentRequirements: {
        submissionTypes: ['online_upload'],
        allowedExtensions: ['pdf'],
        rubric: [{ description: '计算', points: 10 }],
        useRubricForGrading: false,
        allowedAttempts: null,
      },
    });
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining('2026-10-28T09:00:00Z'),
      'assignment:7',
    );
  });
  it('collects all quiz pages and keeps missing deadlines explicit', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 1,
              title: '第一测',
              description: '<p>第一章</p>',
              due_at: null,
            },
          ]),
          {
            headers: {
              Link: '<https://oc.sjtu.edu.cn/api/v1/courses/9/quizzes?page=2>; rel="next"',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 2,
              title: '第二测',
              description: '第二章',
              due_at: '2026-11-01T12:00:00Z',
              assignment_id: 7,
            },
          ]),
        ),
      );
    vi.stubGlobal('fetch', fetch);
    const quizzes = await getCanvasQuizzes(9);
    expect(quizzes).toHaveLength(2);
    expect(quizzes[0]).toMatchObject({
      id: 1,
      description: '<p>第一章</p>',
      dueAt: null,
    });
    expect(quizzes[1]).toMatchObject({ id: 2, assignmentId: 7 });
    expect(String(fetch.mock.calls[1]![0])).toContain('page=2');
  });

  it('resolves a linked requirement attachment within its course and rejects wrong identity', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 88,
            display_name: '要求.pdf',
            size: 12,
            updated_at: 'v2',
            'content-type': 'application/pdf',
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 99 })));
    vi.stubGlobal('fetch', fetch);
    expect(await getCanvasAttachment(9, 88)).toMatchObject({
      id: 'file:88',
      courseId: 9,
      title: '要求.pdf',
      updatedAt: 'v2',
    });
    expect(String(fetch.mock.calls[0]![0])).toBe(
      'https://oc.sjtu.edu.cn/api/v1/courses/9/files/88',
    );
    await expect(getCanvasAttachment(9, 88)).rejects.toThrow('身份不匹配');
  });
});

it('精准更新一份原题和评分标准，保持课程全量同步时间与其他目录项', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE canvas_courses (id INTEGER PRIMARY KEY,data TEXT,items TEXT); CREATE TABLE canvas_sources (id TEXT PRIMARY KEY,course_id INTEGER,data TEXT);',
  );
  const oldItem = {
    id: 'file:9',
    courseId: 4,
    parentId: null,
    sourceId: 'file:9',
    kind: 'file',
    name: '课件',
  };
  db.prepare('INSERT INTO canvas_courses VALUES (?,?,?)').run(
    4,
    JSON.stringify({ syncedAt: 'prior', error: '文件目录失败' }),
    JSON.stringify([oldItem]),
  );
  vi.mocked(getDatabase).mockReturnValue({
    prepare: (sql: string) => db.prepare(sql),
    transaction: (work: () => void) => () => work(),
  } as unknown as ReturnType<typeof getDatabase>);
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        id: 7,
        course_id: 4,
        name: '当前题目',
        description: '<p>当前要求</p>',
        updated_at: 'now',
        allowed_extensions: ['pdf'],
        rubric: [{ description: '步骤', points: 10 }],
      }),
    ),
  );
  vi.stubGlobal('fetch', fetch);
  try {
    const source = await syncCanvasAssignment(4, 7);
    expect(source).toMatchObject({
      id: 'assignment:7',
      courseId: 4,
      html: '<p>当前要求</p>',
      updatedAt: 'now',
      assignmentRequirements: { allowedExtensions: ['pdf'] },
    });
    expect(String(fetch.mock.calls[0]![0])).toBe(
      'https://oc.sjtu.edu.cn/api/v1/courses/4/assignments/7?include[]=submission',
    );
    const course = db.prepare('SELECT data,items FROM canvas_courses WHERE id=4').get() as {
      data: string;
      items: string;
    };
    expect(JSON.parse(course.data)).toEqual({ syncedAt: 'prior', error: '文件目录失败' });
    expect(JSON.parse(course.items)).toContainEqual(oldItem);
    expect(JSON.parse(course.items)).toContainEqual(
      expect.objectContaining({ sourceId: 'assignment:7', name: '当前题目' }),
    );
  } finally {
    db.close();
  }
});
