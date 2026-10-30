import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import Database from 'better-sqlite3';
import { cp, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import type {
  BackupCoverage,
  BackupInspection,
  BackupRestoreResult,
  BackupResult,
} from '../shared/backup';
import { builtinSkillsDirectory } from './agent/skills';
import { cacheDirectoryNames } from './cache';
import { getDatabase, SCHEMA_VERSION } from './database';
import { checkWorkspaceSender } from './ipc';
import { availablePath, storageDirectory } from './storage';
import { getProjectsState } from './projects';
import { activateUserDataProfile, previousUserDataProfile } from './backup-profile';

const databaseFiles = new Set(['dela.db', 'dela.db-wal', 'dela.db-shm', 'dela.db-journal']);
const safeRelative = z
  .string()
  .min(1)
  .refine((path) => !isAbsolute(path) && !path.split(/[\\/]/).includes('..'));
const manifestSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  sections: z.array(
    z.object({ label: z.string(), source: z.string(), path: safeRelative, included: z.boolean() }),
  ),
  files: z.array(
    z.object({
      path: safeRelative,
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
  skipped: z.array(z.string()),
});
const approvedRestores = new Set<string>();
let busy = false;

function isInside(parent: string, child: string) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
function datedName(label: string) {
  return `${label} ${new Date().toISOString().replaceAll(':', '-').slice(0, 19)}`;
}
async function sha256(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function getBackupCoverage(): BackupCoverage {
  const workspace = storageDirectory();
  return {
    currentProfile: app.getPath('userData'),
    previousProfile: previousUserDataProfile(),
    externalProjects: getProjectsState()
      .projects.filter(
        (project) =>
          project.directory && (project.remote || !isInside(workspace, project.directory)),
      )
      .map((project) => ({ name: project.name, path: project.directory!, remote: project.remote })),
  };
}

export async function exportBackupTo(
  parent: string,
  includeExternal = false,
): Promise<BackupResult> {
  const dataDirectory = app.getPath('userData');
  const workspace = storageDirectory();
  const skills = builtinSkillsDirectory();
  const external = getBackupCoverage().externalProjects;
  const actualParent = await realpath(parent);
  for (const source of [
    dataDirectory,
    workspace,
    skills,
    ...external.filter((item) => !item.remote).map((item) => item.path),
  ]) {
    if (existsSync(source) && isInside(await realpath(source), actualParent)) {
      return { status: 'failed', reason: '备份位置不能位于被备份的目录中，请另选一个位置' };
    }
  }
  const destination = availablePath(parent, datedName('Dela 备份'), true);
  const sections = [
    { label: '应用数据', source: dataDirectory, path: '应用数据', included: true },
    { label: '工作目录', source: workspace, path: '工作目录', included: existsSync(workspace) },
    { label: '技能', source: skills, path: '技能', included: existsSync(skills) },
    ...external.map((item, index) => ({
      label: `外部项目：${item.name}${item.remote ? '（远程）' : ''}`,
      source: item.path,
      path: `外部项目/${index + 1}`,
      included: includeExternal && !item.remote && existsSync(item.path),
    })),
  ];
  await mkdir(join(destination, '应用数据'), { recursive: true });
  getDatabase().exec(
    `VACUUM INTO '${join(destination, '应用数据', 'dela.db').replaceAll("'", "''")}'`,
  );
  const skipped: string[] = [];
  for (const section of sections.filter((item) => item.included)) {
    for (const entry of await readdir(section.source)) {
      if (section.path === '应用数据' && databaseFiles.has(entry)) continue;
      try {
        await cp(join(section.source, entry), join(destination, section.path, entry), {
          recursive: true,
          filter: async (source) => {
            if (section.path === '应用数据' && cacheDirectoryNames.has(basename(source)))
              return false;
            if ((await lstat(source)).isSymbolicLink()) {
              skipped.push(`${section.label}/${relative(section.source, source)}（符号链接）`);
              return false;
            }
            return true;
          },
        });
      } catch {
        skipped.push(`${section.label}/${entry}`);
      }
    }
    await mkdir(join(destination, section.path), { recursive: true });
  }
  const files: z.infer<typeof manifestSchema>['files'] = [];
  async function inventory(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await inventory(path);
      else if (entry.isFile())
        files.push({
          path: relative(destination, path),
          bytes: (await lstat(path)).size,
          sha256: await sha256(path),
        });
    }
  }
  await inventory(destination);
  await writeFile(
    join(destination, '备份清单.json'),
    JSON.stringify(
      { version: 1, createdAt: new Date().toISOString(), sections, files, skipped },
      null,
      2,
    ),
  );
  return { status: 'exported', path: destination, skipped };
}

export async function inspectBackupPath(path: string): Promise<BackupInspection> {
  const raw = await readFile(join(path, '备份清单.json'), 'utf8').catch(() => {
    throw new Error('没有找到备份清单；旧版导出可手动查看，请使用新版重新备份后恢复');
  });
  const manifest = manifestSchema.parse(JSON.parse(raw));
  const failures: string[] = [];
  const root = await realpath(path);
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (seen.has(file.path)) {
      failures.push(`清单重复：${file.path}`);
      continue;
    }
    seen.add(file.path);
    try {
      const target = join(path, file.path);
      if (
        !isInside(root, await realpath(target)) ||
        !(await lstat(target)).isFile() ||
        (await lstat(target)).size !== file.bytes ||
        (await sha256(target)) !== file.sha256
      )
        failures.push(`校验未通过：${file.path}`);
    } catch {
      failures.push(`文件不可读：${file.path}`);
    }
  }
  if (!seen.has('应用数据/dela.db')) failures.push('缺少应用数据库');
  if (!failures.length) {
    let db: Database.Database | undefined;
    try {
      db = new Database(join(path, '应用数据', 'dela.db'), { readonly: true });
      const version = db.pragma('user_version', { simple: true }) as number;
      if (version !== 0 && version !== SCHEMA_VERSION)
        failures.push(
          version > SCHEMA_VERSION
            ? '备份来自较新的数据库版本，请先升级 Dela 后再恢复'
            : '备份的数据库版本与当前 Dela 不兼容',
        );
      if (db.pragma('quick_check', { simple: true }) !== 'ok')
        failures.push('数据库完整性检查未通过');
    } catch {
      failures.push('数据库不可读');
    } finally {
      db?.close();
    }
  }
  return {
    path,
    manifestHash: createHash('sha256').update(raw).digest('hex'),
    createdAt: manifest.createdAt,
    fileCount: manifest.files.length,
    bytes: manifest.files.reduce((sum, item) => sum + item.bytes, 0),
    canRestore: !failures.length,
    warnings: [
      ...manifest.skipped.map((item) => `未备份：${item}`),
      ...manifest.sections
        .filter((item) => !item.included)
        .map((item) => `不包含 ${item.label}，恢复后仍使用原位置（可用时）`),
    ],
    failures,
    sections: manifest.sections.map(({ label, included }) => ({ label, included })),
  };
}

export async function restoreBackupTo(
  path: string,
  expectedHash: string,
  parent: string,
): Promise<BackupRestoreResult> {
  const inspection = await inspectBackupPath(path);
  if (!inspection.canRestore || inspection.manifestHash !== expectedHash)
    throw new Error('备份已变化或校验未通过，请重新预检');
  if (isInside(await realpath(path), await realpath(parent)))
    throw new Error('恢复位置不能位于备份文件夹内');
  const snapshot = await exportBackupTo(parent, false);
  if (snapshot.status !== 'exported')
    throw new Error(snapshot.status === 'failed' ? snapshot.reason : '当前数据快照未完成');
  if (snapshot.skipped.length) throw new Error('当前数据快照有未复制内容，请检查备份位置后重试');
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(path, '备份清单.json'), 'utf8')),
  );
  const destination = availablePath(parent, datedName('Dela 恢复'), true);
  await mkdir(destination);
  for (const file of manifest.files) {
    const target = join(destination, file.path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(path, file.path), target);
    if ((await sha256(target)) !== file.sha256)
      throw new Error(`恢复校验未通过：${file.path}；原始数据未改变`);
  }
  for (const section of manifest.sections.filter((item) => item.included))
    await mkdir(join(destination, section.path), { recursive: true });
  const profilePath = join(destination, '应用数据');
  const mappings = manifest.sections
    .filter((item) => item.included && isAbsolute(item.source))
    .map((item) => ({
      ...item,
      target:
        item.path === '技能' ? join(profilePath, 'restored-skills') : join(destination, item.path),
    }))
    .sort((a, b) => b.source.length - a.source.length);
  const pattern = new RegExp(
    `(?:${mappings.map((item) => item.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=$|[/\\\\"'\\r\\n])`,
    'g',
  );
  const remap = (value: string) =>
    value.replace(pattern, (source) => mappings.find((item) => item.source === source)!.target);
  const db = new Database(join(profilePath, 'dela.db'));
  try {
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'",
        )
        .all() as { name: string }[];
      for (const { name } of tables) {
        const quoted = `"${name.replaceAll('"', '""')}"`;
        const columns = db.prepare(`PRAGMA table_info(${quoted})`).all() as {
          name: string;
          type: string;
        }[];
        const textColumns = columns.filter((column) => /TEXT|VARCHAR/i.test(column.type));
        if (!textColumns.length) continue;
        const rows = db.prepare(`SELECT rowid AS _restore_rowid, * FROM ${quoted}`).all() as Record<
          string,
          unknown
        >[];
        for (const row of rows) {
          for (const column of textColumns) {
            const value = row[column.name];
            if (typeof value !== 'string') continue;
            const next = remap(value);
            if (next !== value)
              db.prepare(
                `UPDATE ${quoted} SET "${column.name.replaceAll('"', '""')}"=? WHERE rowid=?`,
              ).run(next, row._restore_rowid);
          }
        }
      }
      if (existsSync(join(destination, '工作目录')))
        db.prepare(
          "INSERT INTO workspace_settings(key,value) VALUES ('directory',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).run(join(destination, '工作目录'));
    })();
    if (db.pragma('quick_check', { simple: true }) !== 'ok')
      throw new Error('恢复后的数据库校验失败');
  } finally {
    db.close();
  }
  const sessions = join(profilePath, 'pi', 'sessions');
  if (existsSync(sessions)) {
    for (const name of await readdir(sessions)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = join(sessions, name);
      await writeFile(file, remap(await readFile(file, 'utf8')));
    }
  }
  if (existsSync(join(destination, '技能')))
    await cp(join(destination, '技能'), join(profilePath, 'restored-skills'), { recursive: true });
  await writeFile(
    join(profilePath, 'restore-info.json'),
    JSON.stringify({ previousProfile: app.getPath('userData'), snapshot: snapshot.path }, null, 2),
  );
  approvedRestores.add(profilePath);
  return {
    path: destination,
    profilePath,
    previousSnapshot: snapshot.path,
    warnings: inspection.warnings,
  };
}

async function chooseDirectory(window: BrowserWindow | null, title: string) {
  const options = {
    title,
    properties: ['openDirectory', 'createDirectory'],
  } satisfies Electron.OpenDialogOptions;
  const picked = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  return picked.canceled ? null : (picked.filePaths[0] ?? null);
}
export async function exportUserData(
  window: BrowserWindow | null,
  options?: { includeExternal?: boolean },
): Promise<BackupResult> {
  const parent = await chooseDirectory(window, '选择备份保存位置');
  return parent ? exportBackupTo(parent, options?.includeExternal) : { status: 'cancelled' };
}
async function exclusively<T>(operation: () => Promise<T>): Promise<T> {
  if (busy) throw new Error('另一项备份操作正在进行，请等待完成');
  busy = true;
  try {
    return await operation();
  } finally {
    busy = false;
  }
}
export function registerBackupIpc() {
  ipcMain.handle('backup:export', (event, options) => {
    checkWorkspaceSender(event);
    const input = z.object({ includeExternal: z.boolean().optional() }).optional().parse(options);
    return exclusively(() => exportUserData(BrowserWindow.fromWebContents(event.sender), input));
  });
  ipcMain.handle('backup:coverage', (event) => {
    checkWorkspaceSender(event);
    return getBackupCoverage();
  });
  ipcMain.handle('backup:inspect', (event) => {
    checkWorkspaceSender(event);
    return exclusively(async () => {
      const path = await chooseDirectory(
        BrowserWindow.fromWebContents(event.sender),
        '选择包含备份清单的文件夹',
      );
      return path ? inspectBackupPath(path) : null;
    });
  });
  ipcMain.handle('backup:restore', (event, path, hash) => {
    checkWorkspaceSender(event);
    z.string().min(1).parse(path);
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(hash);
    return exclusively(async () => {
      const parent = await chooseDirectory(
        BrowserWindow.fromWebContents(event.sender),
        '选择恢复到的新位置',
      );
      return parent ? restoreBackupTo(path, hash, parent) : null;
    });
  });
  ipcMain.handle('backup:activate', (event, path) => {
    checkWorkspaceSender(event);
    if (!approvedRestores.has(path)) throw new Error('请先预检并恢复到新位置，再启用');
    activateUserDataProfile(path);
  });
  ipcMain.handle('backup:return-to-previous', (event) => {
    checkWorkspaceSender(event);
    const previous = previousUserDataProfile();
    if (!previous) throw new Error('没有可返回的数据目录');
    activateUserDataProfile(previous);
  });
}
