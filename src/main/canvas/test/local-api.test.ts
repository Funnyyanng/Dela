import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../credentials', () => ({ loadCanvasToken: () => 'fixture-token' }));

import { getCanvasAttachment, getCanvasQuizzes } from '../api';

afterEach(() => vi.unstubAllGlobals());

describe('local course source metadata', () => {
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
