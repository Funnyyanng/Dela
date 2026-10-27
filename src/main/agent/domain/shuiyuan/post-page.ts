import { z } from 'zod';
import type { ShuiyuanPost } from '../../../../shared/shuiyuan';
import { slimPost } from './helpers';

export const postCharacterLimit = z.number().int().min(1).max(12000).default(6000);
export const POST_CHUNK = 50;

export function pagePosts(posts: readonly ShuiyuanPost[], offset: number, limit: number) {
  const items: Array<
    ReturnType<typeof slimPost> & {
      offset: number;
      totalCharacters: number;
      nextOffset: number | null;
    }
  > = [];
  let remaining = limit;
  for (let index = 0; index < posts.length; index++) {
    const post = posts[index]!;
    const start = index === 0 ? Math.min(offset, post.cooked.length) : 0;
    const cooked = post.cooked.slice(start, start + remaining);
    const nextOffset = start + cooked.length < post.cooked.length ? start + cooked.length : null;
    items.push({
      ...slimPost(post),
      cooked,
      offset: start,
      totalCharacters: post.cooked.length,
      nextOffset,
    });
    remaining -= cooked.length;
    if (nextOffset !== null) return { posts: items, nextIndex: index, nextOffset };
    if (remaining === 0) return { posts: items, nextIndex: index + 1, nextOffset: 0 };
  }
  return { posts: items, nextIndex: posts.length, nextOffset: 0 };
}
