import { z } from 'zod';
import { freshness, offset, tool } from '../shared';
import { requireShuiyuanBound } from './helpers';
import { pagePosts, POST_CHUNK, postCharacterLimit } from './post-page';
import { readPostsSnapshot, snapshotIdSchema } from './read-cache';

export const readShuiyuanPostsTool = tool(
  '按楼层 post id 续读水源主题（只读联网，每次至多 50 个 id）。postIds 取自 read_shuiyuan_topic 的 stream 或 continuation.nextPostIds。正文总计默认 6000 字符；offset 是首个楼层的字符位置。nextCursor 非空时把其字段原样传回本命令，直至读完；缺失楼层在 missingPostIds 报告。',
  z
    .object({
      topicId: z.number().int().positive(),
      postIds: z.array(z.number().int().positive()).min(1).max(POST_CHUNK),
      offset,
      limit: postCharacterLimit,
      snapshotId: snapshotIdSchema,
    })
    .strict(),
  async ({ topicId, postIds, offset, limit, snapshotId }) => {
    requireShuiyuanBound();
    const requested = [...new Set(postIds)];
    const selected = offset > 0 ? requested.slice(0, 1) : requested;
    const source = await readPostsSnapshot(topicId, selected, snapshotId);
    const posts = source.posts;
    const byId = new Map(posts.map((post) => [post.id, post]));
    const missingPostIds = selected.filter((id) => !byId.has(id));
    const ordered = selected.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    const result = pagePosts(ordered, ordered[0]?.id === selected[0] ? offset : 0, limit);
    const pending = [
      ...ordered.slice(result.nextIndex).map((post) => post.id),
      ...requested.slice(selected.length),
    ];
    return {
      topicId,
      posts: result.posts,
      nextCursor: pending.length
        ? {
            topicId,
            postIds: pending,
            offset: result.nextOffset,
            limit,
            ...(source.snapshotId ? { snapshotId: source.snapshotId } : {}),
          }
        : null,
      ...(missingPostIds.length ? { missingPostIds } : {}),
      freshness: freshness(source.cached ? 'cached' : 'realtime'),
    };
  },
);
