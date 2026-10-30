// 全局搜索对着真库跑一遍：这条用例不搭影子 schema，直接用 database.ts 建出来的表。
// 影子 schema 曾经凭空补过一个 sessions.messages 列，于是 search/index.ts 里写着不存在的列
// 也能全绿——用户点开 Ctrl+K 才会看到「no such column」。真库才能挡住这一类缺陷。
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => state.root, isPackaged: false, getAppPath: () => process.cwd() },
  ipcMain: { handle: vi.fn() },
}));
vi.mock('../../todo', () => ({ getTodoState: () => ({ items: [] }) }));

import { closeDatabase, getDatabase } from '../../database';
import { queryGlobalSearch, queryWorkspaceGlobalSearch } from '..';

beforeAll(() => {
  state.root = mkdtempSync(join(tmpdir(), 'dela-search-schema-'));
});
afterAll(() => {
  closeDatabase();
  rmSync(state.root, { recursive: true, force: true });
});

describe('global search against the real schema', () => {
  it('按标题搜到会话，正文不参与匹配', () => {
    const timestamp = '2026-09-16T12:00:00.000Z';
    getDatabase()
      .prepare(
        'INSERT INTO sessions (id, file, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('chat-1', 'sessions/chat-1.jsonl', '资料讨论', timestamp, timestamp);

    expect(queryGlobalSearch('资料讨论')).toEqual([
      expect.objectContaining({
        kind: 'chat',
        id: 'chat-1',
        title: '资料讨论',
        subtitle: '首页',
      }),
    ]);
    // 正文在 Pi 的 JSONL 会话文件里，sessions 表没有消息列。
    expect(queryGlobalSearch('散热方案').filter((item) => item.kind === 'chat')).toEqual([]);
    expect(queryGlobalSearch('').filter((item) => item.kind === 'chat')).toHaveLength(1);
  });
});

it('searches linked local成果 without exposing machine indexes or unlinked directories', async () => {
  const linked = join(state.root, 'linked-courses');
  const unlinked = join(state.root, 'unlinked-private');
  mkdirSync(join(linked, '作业'), { recursive: true });
  mkdirSync(unlinked);
  writeFileSync(join(linked, '作业', '密码学-成果.md'), 'private contents must not be searched');
  writeFileSync(join(linked, '.canvas-成果-files.json'), '{}');
  writeFileSync(join(unlinked, '成果-私人.md'), '');
  symlinkSync(unlinked, join(linked, 'external-shortcut'), 'dir');
  getDatabase()
    .prepare('INSERT INTO workspace_entries(id,name,kind,local_path,updated_at) VALUES(?,?,?,?,?)')
    .run('linked-project', '本学期', 'project', linked, 'now');
  const results = (await queryWorkspaceGlobalSearch('成果')).filter(
    (item) => item.kind === 'local-file',
  );
  expect(results).toEqual([
    expect.objectContaining({
      title: '密码学-成果.md',
      target: { page: 'local-file', entryId: join(linked, '作业', '密码学-成果.md') },
    }),
  ]);
  expect(
    (await queryWorkspaceGlobalSearch('private contents')).filter(
      (item) => item.kind === 'local-file',
    ),
  ).toEqual([]);
  expect(
    (await queryWorkspaceGlobalSearch('')).filter((item) => item.kind === 'local-file'),
  ).toEqual([]);
  const controller = new AbortController();
  controller.abort();
  expect(
    (await queryWorkspaceGlobalSearch('成果', controller.signal)).filter(
      (item) => item.kind === 'local-file',
    ),
  ).toEqual([]);
});
