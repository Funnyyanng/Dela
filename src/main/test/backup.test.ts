import { DatabaseSync } from 'node:sqlite';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  paths: {} as Record<string, string>,
  skills: '',
  projects: [] as unknown[],
  relaunch: vi.fn(),
  quit: vi.fn(),
}));
vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => state.paths[key],
    setPath: (key: string, value: string) => {
      state.paths[key] = value;
    },
    relaunch: state.relaunch,
    quit: state.quit,
  },
  BrowserWindow: {},
  dialog: {},
  ipcMain: {},
}));
vi.mock('better-sqlite3', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  return {
    default: class {
      db: DatabaseSync;
      constructor(path: string, options?: { readonly?: boolean }) {
        this.db = new DatabaseSync(path, { readOnly: options?.readonly });
      }
      prepare(sql: string) {
        return this.db.prepare(sql);
      }
      exec(sql: string) {
        return this.db.exec(sql);
      }
      pragma(sql: string, options?: { simple?: boolean }) {
        const rows = this.db.prepare(`PRAGMA ${sql}`).all();
        return options?.simple ? Object.values(rows[0] ?? {})[0] : rows;
      }
      transaction(fn: () => void) {
        return () => {
          this.db.exec('BEGIN');
          try {
            fn();
            this.db.exec('COMMIT');
          } catch (cause) {
            this.db.exec('ROLLBACK');
            throw cause;
          }
        };
      }
      close() {
        this.db.close();
      }
    },
  };
});
vi.mock('../database', () => ({ getDatabase: vi.fn(), SCHEMA_VERSION: 6 }));
vi.mock('../agent/skills', () => ({ builtinSkillsDirectory: () => state.skills }));
vi.mock('../cache', () => ({ cacheDirectoryNames: new Set(['Cache']) }));
vi.mock('../projects', () => ({ getProjectsState: () => ({ projects: state.projects }) }));
import { getDatabase } from '../database';
import { exportBackupTo, getBackupCoverage, inspectBackupPath, restoreBackupTo } from '../backup';
import {
  initializeUserDataProfile,
  activateUserDataProfile,
  previousUserDataProfile,
} from '../backup-profile';
let root: string;
let db: DatabaseSync;
let workspace: string;
let external: string;
let target: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dela-backup-'));
  state.paths = { userData: join(root, 'profile'), appData: root };
  workspace = join(root, 'workspace');
  external = join(root, '课程');
  target = join(root, 'exports');
  state.skills = join(root, 'skills');
  for (const path of [state.paths.userData!, workspace, external, target, state.skills])
    mkdirSync(path);
  mkdirSync(join(state.paths.userData!, 'pi', 'sessions'), { recursive: true });
  writeFileSync(join(workspace, '笔记.md'), '原笔记');
  writeFileSync(join(external, '答案.md'), '独立课程答案');
  writeFileSync(join(state.skills, 'SKILL.md'), '用户技能');
  writeFileSync(
    join(state.paths.userData!, 'pi', 'sessions', 'one.jsonl'),
    JSON.stringify({ cwd: external }),
  );
  db = new DatabaseSync(join(state.paths.userData!, 'dela.db'));
  db.exec(
    'CREATE TABLE workspace_settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE workspace_entries(id TEXT PRIMARY KEY,path TEXT); CREATE TABLE records(id TEXT PRIMARY KEY,data TEXT)',
  );
  db.prepare('INSERT INTO workspace_settings VALUES (?,?)').run('directory', workspace);
  db.prepare('INSERT INTO workspace_settings VALUES (?,?)').run(
    'skills-disabled-paths',
    JSON.stringify([join(state.skills, 'SKILL.md')]),
  );
  db.prepare('INSERT INTO workspace_entries VALUES (?,?)').run('course-project', external);
  db.prepare('INSERT INTO records VALUES (?,?)').run(
    'answer',
    JSON.stringify({ path: join(external, '答案.md'), status: 'needs_review' }),
  );
  vi.mocked(getDatabase).mockReturnValue(db as unknown as ReturnType<typeof getDatabase>);
  state.projects = [
    { name: '课程', directory: external, remote: false },
    { name: '服务器', directory: '/srv/project', remote: true },
  ];
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

it('exports an honest manifest and restores a complete profile to a new location without touching source data', async () => {
  expect(getBackupCoverage().externalProjects).toHaveLength(2);
  const backup = await exportBackupTo(target, true);
  expect(backup.status).toBe('exported');
  if (backup.status !== 'exported') return;
  expect(backup.skipped).toEqual([]);
  const inspection = await inspectBackupPath(backup.path);
  expect(inspection.canRestore).toBe(true);
  expect(inspection.sections).toContainEqual({ label: '外部项目：课程', included: true });
  expect(inspection.sections).toContainEqual({
    label: '外部项目：服务器（远程）',
    included: false,
  });
  writeFileSync(join(workspace, '笔记.md'), '恢复前的新笔记');
  const restored = await restoreBackupTo(backup.path, inspection.manifestHash, target);
  expect(existsSync(join(restored.previousSnapshot, '备份清单.json'))).toBe(true);
  expect(readFileSync(join(workspace, '笔记.md'), 'utf8')).toBe('恢复前的新笔记');
  expect(readFileSync(join(external, '答案.md'), 'utf8')).toBe('独立课程答案');
  expect(readFileSync(join(restored.path, '工作目录', '笔记.md'), 'utf8')).toBe('原笔记');
  const restoredDb = new DatabaseSync(join(restored.profilePath, 'dela.db'));
  const coursePath = (
    restoredDb.prepare('SELECT path FROM workspace_entries').get() as { path: string }
  ).path;
  expect(coursePath).toBe(join(restored.path, '外部项目', '1'));
  expect(readFileSync(join(coursePath, '答案.md'), 'utf8')).toBe('独立课程答案');
  expect(
    JSON.parse((restoredDb.prepare('SELECT data FROM records').get() as { data: string }).data),
  ).toEqual({ path: join(coursePath, '答案.md'), status: 'needs_review' });
  expect(
    restoredDb.prepare("SELECT value FROM workspace_settings WHERE key='directory'").get()?.value,
  ).toBe(join(restored.path, '工作目录'));
  expect(
    JSON.parse(
      restoredDb
        .prepare("SELECT value FROM workspace_settings WHERE key='skills-disabled-paths'")
        .get()!.value as string,
    ),
  ).toEqual([join(restored.profilePath, 'restored-skills', 'SKILL.md')]);
  restoredDb.close();
  expect(
    JSON.parse(readFileSync(join(restored.profilePath, 'pi', 'sessions', 'one.jsonl'), 'utf8')).cwd,
  ).toBe(coursePath);
  expect(readFileSync(join(restored.profilePath, 'restored-skills', 'SKILL.md'), 'utf8')).toBe(
    '用户技能',
  );
  const previous = state.paths.userData;
  activateUserDataProfile(restored.profilePath);
  expect(state.relaunch).toHaveBeenCalledOnce();
  initializeUserDataProfile();
  expect(state.paths.userData).toBe(restored.profilePath);
  expect(previousUserDataProfile()).toBe(previous);
});

it('excludes external folders by default and preserves their original links during restore', async () => {
  const backup = await exportBackupTo(target);
  if (backup.status !== 'exported') throw new Error('export failed');
  const inspection = await inspectBackupPath(backup.path);
  expect(inspection.sections).toContainEqual({ label: '外部项目：课程', included: false });
  const restored = await restoreBackupTo(backup.path, inspection.manifestHash, target);
  const restoredDb = new DatabaseSync(join(restored.profilePath, 'dela.db'));
  expect(restoredDb.prepare('SELECT path FROM workspace_entries').get()?.path).toBe(external);
  restoredDb.close();
  expect(restored.warnings.some((item) => item.includes('课程'))).toBe(true);
});

it('rejects changed files and nested destinations before restoration, keeping live data intact', async () => {
  expect((await exportBackupTo(external)).status).toBe('failed');
  const backup = await exportBackupTo(target);
  if (backup.status !== 'exported') throw new Error('export failed');
  const inspection = await inspectBackupPath(backup.path);
  writeFileSync(join(backup.path, '工作目录', '笔记.md'), '被修改');
  expect((await inspectBackupPath(backup.path)).canRestore).toBe(false);
  await expect(restoreBackupTo(backup.path, inspection.manifestHash, target)).rejects.toThrow(
    '校验未通过',
  );
  expect(readFileSync(join(workspace, '笔记.md'), 'utf8')).toBe('原笔记');
});

it('preserves paths of adjacent directories sharing the same name prefix', async () => {
  const adjacent = `${external}-其他`;
  db.prepare('INSERT INTO records VALUES (?,?)').run(
    'adjacent',
    JSON.stringify({ path: join(adjacent, '答案.md') }),
  );
  const backup = await exportBackupTo(target, true);
  if (backup.status !== 'exported') throw new Error('export failed');
  const inspection = await inspectBackupPath(backup.path);
  const restored = await restoreBackupTo(backup.path, inspection.manifestHash, target);
  const restoredDb = new DatabaseSync(join(restored.profilePath, 'dela.db'));
  expect(
    JSON.parse(
      (restoredDb.prepare("SELECT data FROM records WHERE id='adjacent'").get() as { data: string })
        .data,
    ).path,
  ).toBe(join(adjacent, '答案.md'));
  restoredDb.close();
});

it('rejects a backup database from a newer incompatible app before restoration', async () => {
  db.exec('PRAGMA user_version=999');
  const backup = await exportBackupTo(target);
  if (backup.status !== 'exported') throw new Error('export failed');
  const inspection = await inspectBackupPath(backup.path);
  expect(inspection.canRestore).toBe(false);
  expect(inspection.failures.join(' ')).toContain('较新的数据库版本');
  await expect(restoreBackupTo(backup.path, inspection.manifestHash, target)).rejects.toThrow(
    '校验未通过',
  );
});

it.skipIf(!process.env.DELA_BACKUP_SAMPLE)(
  'roundtrips a copied real course result and project README while preserving the originals',
  async () => {
    const sample = process.env.DELA_BACKUP_SAMPLE!;
    const courseOriginal = readFileSync(sample);
    const readmeOriginal = readFileSync(join(process.cwd(), 'README.md'));
    copyFileSync(sample, join(external, 'EX4.md'));
    writeFileSync(join(workspace, 'README.md'), readmeOriginal);
    const backup = await exportBackupTo(target, true);
    if (backup.status !== 'exported') throw new Error('export failed');
    const inspection = await inspectBackupPath(backup.path);
    const restored = await restoreBackupTo(backup.path, inspection.manifestHash, target);
    expect(readFileSync(join(restored.path, '外部项目', '1', 'EX4.md'))).toEqual(courseOriginal);
    expect(readFileSync(join(restored.path, '工作目录', 'README.md'))).toEqual(readmeOriginal);
    expect(readFileSync(sample)).toEqual(courseOriginal);
    expect(readFileSync(join(process.cwd(), 'README.md'))).toEqual(readmeOriginal);
  },
);
