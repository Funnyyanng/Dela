import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../credentials', () => ({ loadCanvasToken: () => 'fixture-token' }));
vi.mock('../../database', () => ({ getDatabase: vi.fn() }));

import { getCanvasAttachment, getCanvasQuizzes, readCanvasPage } from '../api';
import { getDatabase } from '../../database';

afterEach(() => vi.unstubAllGlobals());

describe('local course source metadata', () => {
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
          JSON.stringify([{ id: 1, title: '第一测', description: '<p>第一章</p>', due_at: null }]),
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
    expect(quizzes[0]).toMatchObject({ id: 1, description: '<p>第一章</p>', dueAt: null });
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
