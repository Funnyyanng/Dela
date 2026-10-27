import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type {
  ShuiyuanPost,
  ShuiyuanSiteStructure,
  ShuiyuanSourceRef,
  ShuiyuanTopicDetail,
  ShuiyuanTopicSummary,
} from '../../../../../shared/shuiyuan';
import type { WorkspaceEntry } from '../../../../../shared/workspace';
import { shuiyuanTools } from '../index';

vi.mock('../../../../shuiyuan/api', () => ({
  getShuiyuanState: vi.fn(),
  listShuiyuanTopics: vi.fn(),
  getShuiyuanSiteStructure: vi.fn(),
  getShuiyuanTopic: vi.fn(),
  loadShuiyuanPosts: vi.fn(),
  addShuiyuanSourceRef: vi.fn(),
  shuiyuanTopicUrl: vi.fn((id: number) => `https://shuiyuan.sjtu.edu.cn/t/topic/${id}`),
}));
vi.mock('../../../../workspace/api', () => ({ createWorkspaceEntry: vi.fn() }));

import {
  addShuiyuanSourceRef,
  getShuiyuanSiteStructure,
  getShuiyuanState,
  getShuiyuanTopic,
  listShuiyuanTopics,
  loadShuiyuanPosts,
} from '../../../../shuiyuan/api';
import { createWorkspaceEntry } from '../../../../workspace/api';

const state = vi.mocked(getShuiyuanState);
const listTopics = vi.mocked(listShuiyuanTopics);
const siteStructure = vi.mocked(getShuiyuanSiteStructure);
const getTopic = vi.mocked(getShuiyuanTopic);
const loadPosts = vi.mocked(loadShuiyuanPosts);
const addSourceRef = vi.mocked(addShuiyuanSourceRef);
const createEntry = vi.mocked(createWorkspaceEntry);

function summary(id: number, title: string): ShuiyuanTopicSummary {
  return {
    id,
    title,
    excerpt: `摘要 ${id}`,
    categoryId: 4,
    tags: ['校园'],
    postsCount: 12,
    views: 100,
    likeCount: 3,
    createdAt: '2026-09-01T08:00:00.000Z',
    lastPostedAt: '2026-09-20T08:00:00.000Z',
    pinned: false,
    closed: false,
    bookmarked: false,
    archetype: 'regular',
    lastPosterUsername: 'bob',
    authorUsername: 'alice',
    authorAvatarTemplate: '/avatar.png',
  };
}

function post(id: number, postNumber: number): ShuiyuanPost {
  return {
    id,
    postNumber,
    username: 'alice',
    name: null,
    avatarTemplate: null,
    createdAt: '2026-09-01T08:00:00.000Z',
    cooked: `<p>第 ${postNumber} 楼</p>`,
    replyToPostNumber: null,
    likeCount: 1,
    liked: false,
    yours: false,
  };
}

function topic(
  posts: readonly ShuiyuanPost[],
  stream = posts.map((post) => post.id),
): ShuiyuanTopicDetail {
  return {
    id: 42,
    title: '分页长帖',
    categoryId: 4,
    tags: [],
    postsCount: stream.length,
    likeCount: 5,
    views: 1000,
    createdAt: '2026-09-01T08:00:00.000Z',
    lastPostedAt: null,
    closed: false,
    archetype: 'regular',
    bookmarked: false,
    stream,
    posts,
  };
}

let bindingSequence = 0;

beforeEach(() => {
  vi.clearAllMocks();
  state.mockReturnValue({
    connected: true,
    username: 'alice',
    boundAt: new Date(Date.UTC(2026, 0, 1) + ++bindingSequence * 1000).toISOString(),
  });
});

describe('search_shuiyuan_topics', () => {
  it('returns cursor pagination without a fabricated total', async () => {
    listTopics.mockResolvedValue({
      topics: [summary(1, '选课攻略'), summary(2, '宿舍网络')],
      moreUrl: '/search.json?q=%E9%80%89%E8%AF%BE&page=2',
    });
    const result = (await shuiyuanTools.search_shuiyuan_topics.execute({ query: '选课' })) as {
      items: { ref: unknown }[];
      nextCursor: string | null;
      freshness: unknown;
      total?: unknown;
    };
    expect(listTopics).toHaveBeenCalledWith({ kind: 'search', query: '选课' }, undefined);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]!.ref).toEqual({ type: 'shuiyuan-topic', id: 1 });
    expect(result.nextCursor).toBe('/search.json?q=%E9%80%89%E8%AF%BE&page=2');
    expect(result.freshness).toEqual({ kind: 'realtime' });
    expect(result).not.toHaveProperty('total');
  });

  it('passes the opaque nextCursor back for the next page', async () => {
    listTopics.mockResolvedValue({ topics: [], moreUrl: null });
    await shuiyuanTools.search_shuiyuan_topics.execute({
      query: '选课',
      nextCursor: '/search.json?q=x&page=3',
    });
    expect(listTopics).toHaveBeenCalledWith(
      { kind: 'search', query: '选课' },
      '/search.json?q=x&page=3',
    );
  });

  it('maps unbound and rate limited failures to contract error codes', async () => {
    state.mockReturnValue({ connected: false, username: null, boundAt: null });
    await expect(
      shuiyuanTools.search_shuiyuan_topics.execute({ query: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });

    state.mockReturnValue({
      connected: true,
      username: 'alice',
      boundAt: '2026-01-01T00:00:00.000Z',
    });
    listTopics.mockRejectedValue(new Error('请求过于频繁，已触发水源限流，请稍后再试'));
    await expect(
      shuiyuanTools.search_shuiyuan_topics.execute({ query: 'x' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('list_shuiyuan_topics', () => {
  it('builds the category feed and paginates by cursor', async () => {
    listTopics.mockResolvedValue({
      topics: [summary(9, '分类帖')],
      moreUrl: '/c/dev/4.json?page=2',
    });
    const result = (await shuiyuanTools.list_shuiyuan_topics.execute({
      kind: 'category',
      categoryId: 4,
    })) as { nextCursor: string | null };
    expect(listTopics).toHaveBeenCalledWith({ kind: 'category', categoryId: 4 }, undefined);
    expect(result.nextCursor).toBe('/c/dev/4.json?page=2');

    await shuiyuanTools.list_shuiyuan_topics.execute({
      kind: 'tag',
      tag: '精品',
      nextCursor: '/tag/x.json?page=2',
    });
    expect(listTopics).toHaveBeenLastCalledWith({ kind: 'tag', tag: '精品' }, '/tag/x.json?page=2');
  });

  it('rejects feed inputs missing their required discriminator fields', () => {
    // 校验失败在 schema.parse 阶段同步抛出（registry 映射为 INVALID_INPUT）。
    expect(() => shuiyuanTools.list_shuiyuan_topics.execute({ kind: 'category' })).toThrow(
      'categoryId',
    );
    expect(() => shuiyuanTools.list_shuiyuan_topics.execute({ kind: 'tag' })).toThrow('tag');
    expect(() => shuiyuanTools.list_shuiyuan_topics.execute({ kind: 'latest', tag: 'x' })).toThrow(
      '仅在 kind=tag',
    );
  });
});

describe('list_shuiyuan_categories', () => {
  it('returns the category tree and tags for feed construction', async () => {
    const structure: ShuiyuanSiteStructure = {
      categories: [
        { id: 4, name: '开发调优', slug: 'dev', color: '808281', parentId: null, topicCount: 120 },
        {
          id: 5,
          name: '前端',
          slug: 'fe',
          color: '25AAE2',
          parentId: 4,
          topicCount: 30,
        },
      ],
      tags: [{ name: '精品', topicCount: 99 }],
      customEmoji: [{ name: 'sjtu', url: 'https://x/1.png' }],
    };
    siteStructure.mockResolvedValue(structure);
    const result = (await shuiyuanTools.list_shuiyuan_categories.execute({})) as {
      categories: unknown[];
      tags: unknown[];
    };
    expect(result.categories).toEqual([
      { id: 4, name: '开发调优', slug: 'dev', parentId: null, topicCount: 120 },
      { id: 5, name: '前端', slug: 'fe', parentId: 4, topicCount: 30 },
    ]);
    expect(result.tags).toEqual([{ name: '精品', topicCount: 99 }]);
  });
});

describe('read_shuiyuan_topic → read_shuiyuan_posts continuation chain', () => {
  it('keeps initial reads live, marks cached continuations and propagates service failures', async () => {
    const long = { ...post(10, 1), cooked: '正文'.repeat(1000) };
    getTopic.mockResolvedValue(topic([long]));
    const first = (await shuiyuanTools.read_shuiyuan_topic.execute({
      topicId: 42,
      limit: 100,
    })) as {
      nextCursor: unknown;
      freshness: unknown;
    };
    expect(first.freshness).toEqual({ kind: 'realtime' });
    expect(await shuiyuanTools.read_shuiyuan_topic.execute(first.nextCursor)).toMatchObject({
      freshness: { kind: 'cached' },
    });
    expect(getTopic).toHaveBeenCalledOnce();
    expect(loadPosts).not.toHaveBeenCalled();
    await shuiyuanTools.read_shuiyuan_topic.execute({ topicId: 42, limit: 100 });
    expect(getTopic).toHaveBeenCalledTimes(2);
    getTopic.mockRejectedValueOnce(new Error('无法连接水源社区，请检查网络后重试'));
    await expect(shuiyuanTools.read_shuiyuan_topic.execute({ topicId: 42 })).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });

  it('rejects an expired cursor without serving stale content or fetching under the old position', async () => {
    getTopic.mockResolvedValue(topic([{ ...post(10, 1), cooked: '正文'.repeat(1000) }]));
    const first = (await shuiyuanTools.read_shuiyuan_topic.execute({
      topicId: 42,
      limit: 100,
    })) as { nextCursor: unknown };
    const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60 * 1000 + 1);
    try {
      await expect(
        shuiyuanTools.read_shuiyuan_topic.execute(first.nextCursor),
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: expect.stringContaining('快照已过期'),
      });
      expect(getTopic).toHaveBeenCalledOnce();
      await shuiyuanTools.read_shuiyuan_topic.execute({ topicId: 42, limit: 100 });
      expect(getTopic).toHaveBeenCalledTimes(2);
    } finally {
      time.mockRestore();
    }
  });

  it.each(['bob', 'alice'])(
    'does not reuse a continuation after rebinding as %s',
    async (username) => {
      loadPosts.mockResolvedValue([{ ...post(10, 1), cooked: '正文'.repeat(1000) }]);
      const first = (await shuiyuanTools.read_shuiyuan_posts.execute({
        topicId: 42,
        postIds: [10],
        limit: 100,
      })) as { nextCursor: unknown };
      state.mockReturnValue({
        connected: true,
        username,
        boundAt: '2026-02-01T00:00:00.000Z',
      });
      await expect(
        shuiyuanTools.read_shuiyuan_posts.execute(first.nextCursor),
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: expect.stringContaining('账号已切换'),
      });
      expect(loadPosts).toHaveBeenCalledOnce();
      await shuiyuanTools.read_shuiyuan_posts.execute({ topicId: 42, postIds: [10], limit: 100 });
      expect(loadPosts).toHaveBeenCalledTimes(2);
    },
  );

  it('evicts old floor bodies after a hundred cached entries while preserving cursor reads', async () => {
    const all = Array.from({ length: 110 }, (_, index) => post(100 + index, index + 1));
    getTopic.mockResolvedValue(
      topic(
        all.slice(0, 20),
        all.map((post) => post.id),
      ),
    );
    loadPosts.mockImplementation(async (_topicId, ids) => {
      const selected = z.array(z.number().int().positive()).parse(ids);
      return all.filter((post) => selected.includes(post.id));
    });
    let result = (await shuiyuanTools.read_shuiyuan_topic.execute({ topicId: 42 })) as {
      nextCursor: { snapshotId: string } | null;
    };
    const snapshotId = result.nextCursor!.snapshotId;
    let pages = 0;
    while (result.nextCursor) {
      result = (await shuiyuanTools.read_shuiyuan_topic.execute(
        result.nextCursor,
      )) as typeof result;
      expect(++pages).toBeLessThan(10);
    }
    const previous = loadPosts.mock.calls.length;
    await shuiyuanTools.read_shuiyuan_topic.execute({ topicId: 42, postOffset: 0, snapshotId });
    expect(getTopic).toHaveBeenCalledOnce();
    expect(loadPosts).toHaveBeenCalledTimes(previous + 1);
    expect(loadPosts).toHaveBeenLastCalledWith(
      42,
      all.slice(10, 20).map((post) => post.id),
    );
  });

  it('keeps oversized floor bodies out of the snapshot without preventing subsequent character reads', async () => {
    const long = { ...post(10, 1), cooked: 'x'.repeat(4 * 1024 * 1024 + 1) };
    getTopic.mockResolvedValue(topic([long]));
    loadPosts.mockResolvedValue([long]);
    const first = (await shuiyuanTools.read_shuiyuan_topic.execute({
      topicId: 42,
      limit: 100,
    })) as { nextCursor: unknown };
    expect(loadPosts).not.toHaveBeenCalled();
    const second = (await shuiyuanTools.read_shuiyuan_topic.execute(first.nextCursor)) as {
      posts: { cooked: string; offset: number }[];
      nextCursor: unknown;
    };
    expect(second.posts[0]).toMatchObject({ offset: 100, cooked: 'x'.repeat(100) });
    expect(second.nextCursor).not.toBeNull();
    expect(getTopic).toHaveBeenCalledOnce();
    expect(loadPosts).toHaveBeenCalledOnce();
  });

  it('keeps ten thousand stream ids out of one response without hiding the continuation', async () => {
    const stream = Array.from({ length: 10000 }, (_, index) => 100 + index);
    getTopic.mockResolvedValue(topic([{ ...post(100, 1), cooked: '长楼'.repeat(10000) }], stream));
    loadPosts.mockResolvedValue([]);
    const result = (await shuiyuanTools.read_shuiyuan_topic.execute({
      topicId: 42,
      limit: 100,
    })) as {
      stream: number[];
      streamTotal: number;
      nextStreamOffset: number;
      posts: { cooked: string }[];
      nextCursor: unknown;
    };
    expect(result.stream).toEqual(stream.slice(0, 50));
    expect(result.streamTotal).toBe(10000);
    expect(result.nextStreamOffset).toBe(50);
    expect(result.posts[0]!.cooked).toHaveLength(100);
    expect(result.nextCursor).toEqual({
      topicId: 42,
      postOffset: 0,
      offset: 100,
      limit: 100,
      snapshotId: expect.any(String),
    });
    expect(JSON.stringify(result).length).toBeLessThan(4000);
  });

  it('follows the topic cursor through long HTML and later floors without losing or duplicating characters', async () => {
    const all = Array.from({ length: 63 }, (_, index) => ({
      ...post(100 + index, index + 1),
      cooked:
        index === 0 || index === 24
          ? `<p>${'中文😀&amp;'.repeat(900)}</p>`
          : `<p>完整第${index + 1}楼</p>`,
    }));
    getTopic.mockResolvedValue(
      topic(
        all.slice(0, 20),
        all.map((post) => post.id),
      ),
    );
    loadPosts.mockImplementation(async (_topicId, ids) => {
      const selected = z.array(z.number().int().positive()).parse(ids);
      return all.filter((post) => selected.includes(post.id)).toReversed();
    });
    const collected = new Map<number, string>();
    let input: unknown = { topicId: 42, limit: 800 };
    let pages = 0;
    while (input) {
      const result = (await shuiyuanTools.read_shuiyuan_topic.execute(input)) as {
        posts: {
          id: number;
          cooked: string;
          offset: number;
          totalCharacters: number;
          nextOffset: number | null;
        }[];
        nextCursor: unknown;
      };
      expect(result.posts.reduce((sum, post) => sum + post.cooked.length, 0)).toBeLessThanOrEqual(
        800,
      );
      for (const post of result.posts) {
        const previous = collected.get(post.id) ?? '';
        expect(post.offset).toBe(previous.length);
        collected.set(post.id, previous + post.cooked);
        if (post.nextOffset === null)
          expect(collected.get(post.id)).toHaveLength(post.totalCharacters);
      }
      input = result.nextCursor;
      expect(++pages).toBeLessThan(100);
    }
    expect(pages).toBeGreaterThan(4);
    expect([...collected]).toEqual(all.map((post) => [post.id, post.cooked]));
    expect(getTopic).toHaveBeenCalledOnce();
    expect(loadPosts.mock.calls.length).toBeLessThan(pages);
  });

  it('follows explicit post cursors in requested order, reports missing ids and preserves empty floors', async () => {
    const all = [
      { ...post(10, 1), cooked: '正文甲'.repeat(900) },
      { ...post(11, 2), cooked: '' },
      { ...post(12, 3), cooked: '<p>末楼</p>'.repeat(80) },
    ];
    loadPosts.mockImplementation(async (_topicId, ids) => {
      const selected = z.array(z.number().int().positive()).parse(ids);
      return all.filter((post) => selected.includes(post.id)).toReversed();
    });
    const collected = new Map<number, string>();
    let input: unknown = { topicId: 42, postIds: [10, 11, 99, 12], limit: 300 };
    let pages = 0;
    const missing = new Set<number>();
    while (input) {
      const result = (await shuiyuanTools.read_shuiyuan_posts.execute(input)) as {
        posts: { id: number; cooked: string; offset: number }[];
        missingPostIds?: number[];
        nextCursor: unknown;
      };
      expect(result.posts.reduce((sum, post) => sum + post.cooked.length, 0)).toBeLessThanOrEqual(
        300,
      );
      for (const post of result.posts) {
        expect(post.offset).toBe((collected.get(post.id) ?? '').length);
        collected.set(post.id, (collected.get(post.id) ?? '') + post.cooked);
      }
      for (const id of result.missingPostIds ?? []) missing.add(id);
      input = result.nextCursor;
      expect(++pages).toBeLessThan(30);
    }
    expect([...collected]).toEqual(all.map((post) => [post.id, post.cooked]));
    expect([...missing]).toEqual([99]);
    expect(loadPosts).toHaveBeenCalledOnce();
  });

  it('bounds the stream and exposes the next chunk of unread post ids', async () => {
    const detail: ShuiyuanTopicDetail = {
      id: 42,
      title: '长帖',
      categoryId: 4,
      tags: [],
      postsCount: 60,
      likeCount: 5,
      views: 1000,
      createdAt: '2026-09-01T08:00:00.000Z',
      lastPostedAt: '2026-09-20T08:00:00.000Z',
      closed: false,
      archetype: 'regular',
      bookmarked: false,
      stream: Array.from({ length: 60 }, (_, index) => 100 + index),
      posts: Array.from({ length: 20 }, (_, index) => post(100 + index, index + 1)),
    };
    getTopic.mockResolvedValue(detail);
    const result = (await shuiyuanTools.read_shuiyuan_topic.execute({ topicId: 42 })) as {
      stream: number[];
      posts: { id: number; cooked: string }[];
      continuation: { nextPostIds: number[]; remainingCount: number };
      streamTotal: number;
      nextStreamOffset: number | null;
      nextCursor: unknown;
      url: string;
    };
    expect(getTopic).toHaveBeenCalledWith(42, undefined);
    expect(result.stream).toHaveLength(50);
    expect(result.streamTotal).toBe(60);
    expect(result.nextStreamOffset).toBe(50);
    expect(result.posts).toHaveLength(20);
    expect(result.posts[0]!.cooked).toBe('<p>第 1 楼</p>');
    expect(result.continuation.nextPostIds).toEqual(Array.from({ length: 40 }, (_, i) => 120 + i));
    expect(result.continuation.remainingCount).toBe(40);
    expect(result.nextCursor).toEqual({
      topicId: 42,
      postOffset: 20,
      offset: 0,
      limit: 6000,
      snapshotId: expect.any(String),
    });
    expect(result.url).toBe('https://shuiyuan.sjtu.edu.cn/t/topic/42');
  });

  it('reads the next posts by id and reports ids the server dropped', async () => {
    loadPosts.mockResolvedValue([post(120, 21)]);
    const result = (await shuiyuanTools.read_shuiyuan_posts.execute({
      topicId: 42,
      postIds: [120, 999],
    })) as { posts: { id: number }[]; missingPostIds: number[] };
    expect(loadPosts).toHaveBeenCalledWith(42, [120, 999]);
    expect(result.posts.map((item) => item.id)).toEqual([120]);
    expect(result.missingPostIds).toEqual([999]);
  });

  it('returns null continuation when every floor is already loaded', async () => {
    getTopic.mockResolvedValue({
      id: 43,
      title: '短帖',
      categoryId: null,
      tags: [],
      postsCount: 2,
      likeCount: null,
      views: null,
      createdAt: '',
      lastPostedAt: null,
      closed: false,
      archetype: 'regular',
      bookmarked: false,
      stream: [7, 8],
      posts: [post(7, 1), post(8, 2)],
    });
    const result = (await shuiyuanTools.read_shuiyuan_topic.execute({ topicId: 43 })) as {
      continuation: null;
    };
    expect(result.continuation).toBeNull();
  });
});

describe('link_shuiyuan_topic', () => {
  const sourceRef: ShuiyuanSourceRef = {
    topicId: 42,
    title: '长帖',
    url: 'https://shuiyuan.sjtu.edu.cn/t/topic/42',
    excerpt: '摘要',
    categoryName: '开发调优',
    author: 'alice',
    postsCount: 60,
    addedAt: '2026-09-29T00:00:00.000Z',
  };

  it('writes the source ref row and a workspace source entry', async () => {
    addSourceRef.mockResolvedValue(sourceRef);
    const entry = {
      id: '6f4b2d2a-1111-4222-8333-444455556666',
      parentId: null,
      name: '长帖',
      kind: 'source',
      sourceId: 'shuiyuan-topic:42',
      noteId: null,
      updatedAt: '2026-09-29T00:00:00.000Z',
    } as WorkspaceEntry;
    createEntry.mockReturnValue(entry);
    const result = await shuiyuanTools.link_shuiyuan_topic.execute({
      topicId: 42,
      parentId: '0e2f6f5e-1234-4abc-8ef0-1234567890ab',
    });
    expect(addSourceRef).toHaveBeenCalledWith(42);
    expect(createEntry).toHaveBeenCalledWith({
      parentId: '0e2f6f5e-1234-4abc-8ef0-1234567890ab',
      name: '长帖',
      kind: 'source',
      sourceId: 'shuiyuan-topic:42',
    });
    expect(result).toMatchObject({
      ref: { type: 'shuiyuan-topic', id: 42 },
      workspaceRef: { type: 'workspace', id: entry.id },
    });
  });

  it('maps a failed workspace entry to NOT_FOUND', async () => {
    addSourceRef.mockResolvedValue(sourceRef);
    createEntry.mockImplementation(() => {
      throw new Error('目标不是文件夹或项目');
    });
    await expect(
      shuiyuanTools.link_shuiyuan_topic.execute({
        topicId: 42,
        parentId: '0e2f6f5e-1234-4abc-8ef0-1234567890ab',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
