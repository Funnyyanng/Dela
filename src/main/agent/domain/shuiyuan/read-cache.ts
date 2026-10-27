import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ShuiyuanPost, ShuiyuanTopicDetail } from '../../../../shared/shuiyuan';
import { getShuiyuanState, getShuiyuanTopic, loadShuiyuanPosts } from '../../../shuiyuan/api';
import { toolError } from '../shared';
import { withShuiyuanErrors } from './helpers';

const TTL_MS = 5 * 60 * 1000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_POSTS = 100;
export const snapshotIdSchema = z.string().uuid().optional();

type Snapshot = {
  id: string;
  scope: string;
  topicId: number;
  expiresAt: number;
  detail?: ShuiyuanTopicDetail;
  streamComplete: boolean;
  posts: Map<number, ShuiyuanPost | null>;
  bytes: number;
};

let snapshot: Snapshot | null = null;

function accountScope() {
  const state = getShuiyuanState();
  return state.connected ? JSON.stringify([state.username, state.boundAt]) : null;
}

function current(id: string, topicId: number): Snapshot {
  if (snapshot && (snapshot.expiresAt <= Date.now() || snapshot.scope !== accountScope()))
    snapshot = null;
  if (!snapshot || snapshot.id !== id || snapshot.topicId !== topicId)
    throw toolError(
      'NOT_FOUND',
      '水源续读快照已过期、被新读取替换或账号已切换，请重新读取主题或楼层',
    );
  return snapshot;
}

function createSnapshot(topicId: number, scope: string, detail?: ShuiyuanTopicDetail) {
  const metadata = detail ? { ...detail, posts: [] } : undefined;
  const bytes = metadata ? Buffer.byteLength(JSON.stringify(metadata)) : 0;
  snapshot =
    bytes <= MAX_BYTES
      ? {
          id: randomUUID(),
          scope,
          topicId,
          expiresAt: Date.now() + TTL_MS,
          detail: metadata,
          streamComplete: true,
          posts: new Map(),
          bytes,
        }
      : null;
  return snapshot;
}

function remember(cache: Snapshot, ids: readonly number[], posts: readonly ShuiyuanPost[]) {
  const byId = new Map(posts.map((post) => [post.id, post]));
  for (const id of [...ids].reverse()) {
    const post = byId.get(id) ?? null;
    const size = post ? Buffer.byteLength(JSON.stringify(post)) : 0;
    if (size > MAX_BYTES) continue;
    const old = cache.posts.get(id);
    if (old) cache.bytes -= Buffer.byteLength(JSON.stringify(old));
    cache.posts.delete(id);
    while (cache.posts.size && (cache.posts.size >= MAX_POSTS || cache.bytes + size > MAX_BYTES)) {
      const [oldId, oldPost] = cache.posts.entries().next().value!;
      cache.posts.delete(oldId);
      if (oldPost) cache.bytes -= Buffer.byteLength(JSON.stringify(oldPost));
    }
    if (cache.bytes + size <= MAX_BYTES) {
      cache.posts.set(id, post);
      cache.bytes += size;
    }
  }
}

export async function readTopicSnapshot(topicId: number, postNumber?: number, snapshotId?: string) {
  if (snapshotId) {
    const cache = current(snapshotId, topicId);
    if (!cache.detail)
      throw toolError('INVALID_INPUT', '请用 read_shuiyuan_posts 继续此楼层快照，或重新读取主题');
    return {
      detail: cache.detail,
      snapshotId: cache.id,
      cached: true,
      streamComplete: cache.streamComplete,
    };
  }
  const scope = accountScope();
  const detail = await withShuiyuanErrors(() => getShuiyuanTopic(topicId, postNumber));
  if (!scope || scope !== accountScope())
    throw toolError('AUTH_EXPIRED', '水源账号已变化，请重新读取');
  const streamComplete =
    detail.stream.length > 0 || (detail.postsCount === 0 && detail.posts.length === 0);
  const indexed = detail.stream.length
    ? detail
    : { ...detail, stream: detail.posts.map((post) => post.id) };
  const cache = createSnapshot(topicId, scope, indexed);
  if (cache) cache.streamComplete = streamComplete;
  if (cache)
    remember(
      cache,
      detail.posts.map((post) => post.id),
      detail.posts,
    );
  return { detail: indexed, snapshotId: cache?.id, cached: false, streamComplete };
}

export async function readPostsSnapshot(
  topicId: number,
  ids: readonly number[],
  snapshotId?: string,
  create = true,
) {
  let cache = snapshotId ? current(snapshotId, topicId) : null;
  const scope = accountScope();
  const missing = cache ? ids.filter((id) => !cache!.posts.has(id)) : [...ids];
  const fetched = missing.length
    ? await withShuiyuanErrors(() => loadShuiyuanPosts(topicId, missing))
    : [];
  if (!scope || scope !== accountScope())
    throw toolError('AUTH_EXPIRED', '水源账号已变化，请重新读取');
  const posts = ids.flatMap((id) => {
    const post = cache?.posts.get(id) ?? fetched.find((post) => post.id === id);
    return post ? [post] : [];
  });
  if (!cache && create) cache = createSnapshot(topicId, scope);
  if (cache) remember(cache, ids, posts);
  return { posts, snapshotId: cache?.id, cached: missing.length === 0 };
}
