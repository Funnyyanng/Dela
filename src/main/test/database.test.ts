import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
import { closeDatabase, getDatabase } from '../database';

function freshRoot(): string {
  state.root = mkdtempSync(join(tmpdir(), 'dela-db-'));
  return state.root;
}

afterEach(() => {
  closeDatabase();
  rmSync(state.root, { recursive: true, force: true });
});

describe('current database format', () => {
  it('creates and reopens the current database without losing data', () => {
    freshRoot();
    const db = getDatabase();
    expect(db.pragma('user_version', { simple: true })).toBe(6);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.prepare('INSERT INTO workspace_settings VALUES (?, ?)').run('test', 'value');
    closeDatabase();
    expect(
      getDatabase().prepare("SELECT value FROM workspace_settings WHERE key='test'").get(),
    ).toEqual({ value: 'value' });
  });

  it.each([1, 5, 7])('rejects unsupported version %i without clearing its data', (version) => {
    const root = freshRoot();
    const db = new Database(join(root, 'dela.db'));
    db.exec('CREATE TABLE sample (value TEXT)');
    db.exec("INSERT INTO sample VALUES ('keep')");
    db.pragma(`user_version = ${version}`);
    db.close();
    expect(() => getDatabase()).toThrow('数据库格式不受支持');
    const stored = new Database(join(root, 'dela.db'));
    expect(stored.prepare('SELECT value FROM sample').get()).toEqual({ value: 'keep' });
    stored.close();
  });
});

it('upgrades the original v6 notification CHECK without losing messages or read state', () => {
  const root = freshRoot();
  const old = new Database(join(root, 'dela.db'));
  old.exec(`CREATE TABLE notifications (
   id TEXT PRIMARY KEY,
   source TEXT NOT NULL CHECK(source IN ('mail', 'shuiyuan')),
   account_key TEXT NOT NULL,
   title TEXT NOT NULL,
   body TEXT NOT NULL DEFAULT '',
   created_at TEXT NOT NULL,
   read_at TEXT,
   source_unread INTEGER NOT NULL DEFAULT 1,
   href TEXT NOT NULL
 );
 CREATE INDEX idx_notifications_account_source_created ON notifications(account_key,source,created_at DESC);
 CREATE TABLE workspace_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 INSERT INTO workspace_settings VALUES ('personal-context','keep');
 PRAGMA user_version=6;`);
  old
    .prepare('INSERT INTO notifications VALUES (?,?,?,?,?,?,?,?,?)')
    .run(
      'mail:1',
      'mail',
      'student',
      '邮件',
      '正文',
      '2026-10-01',
      '2026-10-02',
      0,
      JSON.stringify({ kind: 'mail', messageId: 1 }),
    );
  old
    .prepare('INSERT INTO notifications VALUES (?,?,?,?,?,?,?,?,?)')
    .run(
      'shuiyuan:1',
      'shuiyuan',
      'student',
      '帖子',
      '内容',
      '2026-10-03',
      null,
      1,
      JSON.stringify({ kind: 'shuiyuan', topicId: 1 }),
    );
  const before = old.prepare('SELECT * FROM notifications ORDER BY id').all();
  old.close();
  const migrated = getDatabase();
  expect(migrated.pragma('user_version', { simple: true })).toBe(6);
  expect(migrated.prepare('SELECT * FROM notifications ORDER BY id').all()).toEqual(before);
  expect(
    migrated.prepare("SELECT value FROM workspace_settings WHERE key='personal-context'").get(),
  ).toEqual({ value: 'keep' });
  for (const source of ['jobs', 'life'])
    migrated
      .prepare('INSERT INTO notifications VALUES (?,?,?,?,?,?,?,?,?)')
      .run(
        source,
        source,
        'local',
        '任务提示',
        '',
        '2026-10-04',
        null,
        1,
        JSON.stringify({ kind: source === 'jobs' ? 'job' : 'life', jobId: 'job' }),
      );
  expect(
    migrated
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_notifications_account_source_created'",
      )
      .get(),
  ).toBeDefined();
  expect(migrated.pragma('quick_check', { simple: true })).toBe('ok');
  closeDatabase();
  const reopened = getDatabase();
  expect(
    reopened
      .prepare('SELECT * FROM notifications WHERE id IN (?,?) ORDER BY id')
      .all('mail:1', 'shuiyuan:1'),
  ).toEqual(before);
  expect(reopened.prepare('SELECT COUNT(*) AS count FROM notifications').get()).toEqual({
    count: 4,
  });
});
