import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../../credentials', () => ({ loadCanvasToken: () => 'fixture-token' }));
vi.mock('../../database', () => ({
  getDatabase: () => ({ prepare: () => ({ get: () => undefined, all: () => [], run: () => {} }) }),
}));
import { cachedFile } from '../api';

afterEach(() => {
  vi.unstubAllGlobals();
  if (state.root) rmSync(state.root, { recursive: true, force: true });
});

it('reports an unpublished file without attempting its download URL', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'dela-download-'));
  const fetch = vi.fn().mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        locked_for_user: true,
        lock_explanation: '此文件是未发布单元的一部分，尚未可用。',
      }),
    ),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(
    cachedFile({
      id: 'file:8',
      courseId: 9,
      title: '未开放.pdf',
      kind: 'file',
      fileId: 8,
      updatedAt: 'v1',
    }),
  ).rejects.toThrow('未发布单元');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(['https://oc.sjtu.edu.cn/files/7/content', 'https://s3.jcloud.sjtu.edu.cn/content'])(
  'retains authentication only for a same-origin download redirect: %s',
  async (target) => {
    state.root = mkdtempSync(join(tmpdir(), 'dela-download-'));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: 'https://oc.sjtu.edu.cn/files/7/download', size: 5 })),
      )
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: target } }))
      .mockResolvedValueOnce(new Response('hello'));
    vi.stubGlobal('fetch', fetch);
    const file = await cachedFile({
      id: 'file:7',
      courseId: 9,
      title: '要求.txt',
      kind: 'file',
      fileId: 7,
      updatedAt: 'v1',
    });
    expect(readFileSync(file.path, 'utf8')).toBe('hello');
    expect(new Headers(fetch.mock.calls[1]![1]?.headers).get('Authorization')).toBe(
      'Bearer fixture-token',
    );
    expect(new Headers(fetch.mock.calls[2]![1]?.headers).get('Authorization')).toBe(
      target.startsWith('https://oc.sjtu.edu.cn/') ? 'Bearer fixture-token' : null,
    );
  },
);
