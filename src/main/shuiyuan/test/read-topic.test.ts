import { afterEach, expect, it, vi } from 'vitest';
import { readShuiyuanTopicTool } from '../../agent/domain/shuiyuan/read-topic';

vi.mock('../../credentials', () => ({
  loadShuiyuanCredential: () => ({
    key: 'synthetic-key',
    clientId: 'synthetic-client',
    username: 'fixture',
    boundAt: '2026-01-01T00:00:00.000Z',
  }),
  saveShuiyuanCredential: vi.fn(),
  clearShuiyuanCredential: vi.fn(),
}));
vi.mock('../../campus', () => ({ getCampusSession: vi.fn(), createCampusLoginWindow: vi.fn() }));
vi.mock('../../database', () => ({ getDatabase: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

it.each([{}, { stream: null }, { stream: [] }])(
  'preserves loaded body and unknown coverage through real API parsing when the stream is %j',
  async (stream) => {
    const posts = [
      { id: 100, post_number: 1, username: 'fixture', cooked: `<p>${'首楼正文'.repeat(700)}</p>` },
      { id: 101, post_number: 2, username: 'fixture', cooked: '<p>第二楼完整正文</p>' },
    ];
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 42,
            title: '缺完整索引的主题',
            posts_count: 8,
            post_stream: { posts, ...stream },
          }),
        ),
    );
    vi.stubGlobal('fetch', fetch);
    const collected = new Map<number, string>();
    let input: unknown = { topicId: 42, limit: 300 };
    let pages = 0;
    while (input) {
      const result = (await readShuiyuanTopicTool.execute(input)) as {
        posts: { id: number; cooked: string; offset: number }[];
        coverage: { scope: string; complete: boolean; warnings: string[] };
        streamTotal: number | null;
        nextCursor: unknown;
      };
      expect(result.coverage).toMatchObject({
        scope: 'loaded_posts_without_full_stream',
        complete: false,
      });
      expect(result.coverage.warnings[0]).toContain('不代表全帖已读');
      expect(result.streamTotal).toBeNull();
      for (const post of result.posts) {
        const previous = collected.get(post.id) ?? '';
        expect(post.offset).toBe(previous.length);
        collected.set(post.id, previous + post.cooked);
      }
      input = result.nextCursor;
      expect(++pages).toBeLessThan(20);
    }
    expect([...collected]).toEqual(posts.map((post) => [post.id, post.cooked]));
    expect(fetch).toHaveBeenCalledOnce();
  },
);
