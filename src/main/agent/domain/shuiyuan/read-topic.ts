import { z } from 'zod';
import { shuiyuanTopicUrl } from '../../../shuiyuan/api';
import { coverage, freshness, offset, tool } from '../shared';
import { requireShuiyuanBound } from './helpers';
import { pagePosts, POST_CHUNK, postCharacterLimit } from './post-page';
import { readPostsSnapshot, readTopicSnapshot, snapshotIdSchema } from './read-cache';

export const readShuiyuanTopicTool = tool(
  '读取水源主题详情与分段正文（只读联网）。stream 最多 50 个楼层 id，streamTotal 给出总数；上游缺完整索引时为 null，coverage 标明仅含已加载楼层。正文总计默认 6000 字符；postOffset 是楼层 id 流位置，offset 是该楼字符位置。nextCursor 非空时把其字段原样传回本命令继续读取；也可按 continuation.nextPostIds 调用 read_shuiyuan_posts。postNumber 可从某楼附近开始。',
  z
    .object({
      topicId: z.number().int().positive(),
      postNumber: z.number().int().positive().optional(),
      postOffset: z.number().int().nonnegative().optional(),
      offset,
      limit: postCharacterLimit,
      snapshotId: snapshotIdSchema,
    })
    .strict(),
  async ({ topicId, postNumber, postOffset, offset, limit, snapshotId }) => {
    requireShuiyuanBound();
    const source = await readTopicSnapshot(topicId, postNumber, snapshotId);
    const detail = source.detail;
    const start = postOffset ?? Math.max(0, detail.stream.indexOf(detail.posts[0]?.id ?? -1));
    const selected = detail.stream.slice(start, start + (offset > 0 ? 1 : 20));
    const byId = new Map(detail.posts.map((post) => [post.id, post]));
    const needed = selected.filter((id) => !byId.has(id));
    const loaded = needed.length
      ? await readPostsSnapshot(topicId, needed, source.snapshotId, false)
      : { posts: [], snapshotId: source.snapshotId, cached: true };
    for (const post of loaded.posts) byId.set(post.id, post);
    const missingPostIds = selected.filter((id) => !byId.has(id));
    const ordered = selected.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    const result = pagePosts(ordered, ordered[0]?.id === selected[0] ? offset : 0, limit);
    const nextPost = ordered[result.nextIndex];
    const nextPostOffset = nextPost
      ? start + selected.indexOf(nextPost.id)
      : start + selected.length;
    const remaining = detail.stream.slice(nextPostOffset);
    return {
      ref: { type: 'shuiyuan-topic', id: topicId },
      url: shuiyuanTopicUrl(topicId),
      title: detail.title,
      categoryId: detail.categoryId,
      tags: detail.tags,
      postsCount: detail.postsCount,
      views: detail.views,
      likeCount: detail.likeCount,
      createdAt: detail.createdAt,
      lastPostedAt: detail.lastPostedAt,
      closed: detail.closed,
      archetype: detail.archetype,
      stream: detail.stream.slice(start, start + POST_CHUNK),
      streamOffset: start,
      streamTotal: source.streamComplete ? detail.stream.length : null,
      nextStreamOffset: start + POST_CHUNK < detail.stream.length ? start + POST_CHUNK : null,
      posts: result.posts,
      ...(missingPostIds.length ? { missingPostIds } : {}),
      ...(!source.streamComplete
        ? {
            coverage: coverage('loaded_posts_without_full_stream', false, [
              '上游未返回完整楼层索引，仅能确认当前已加载楼层；nextCursor=null 不代表全帖已读。',
            ]),
          }
        : {}),
      nextCursor: remaining.length
        ? {
            topicId,
            postOffset: nextPostOffset,
            offset: result.nextOffset,
            limit,
            ...(loaded.snapshotId ? { snapshotId: loaded.snapshotId } : {}),
          }
        : null,
      continuation:
        remaining.length > 0
          ? {
              nextPostIds: remaining.slice(0, POST_CHUNK),
              offset: result.nextOffset,
              remainingCount: remaining.length,
              ...(loaded.snapshotId ? { snapshotId: loaded.snapshotId } : {}),
            }
          : null,
      freshness: freshness(source.cached && loaded.cached ? 'cached' : 'realtime'),
    };
  },
);
