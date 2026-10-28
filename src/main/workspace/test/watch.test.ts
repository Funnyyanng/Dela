import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebContents } from 'electron';

const state = vi.hoisted(() => ({
  root: '',
  project: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  native: false,
  watches: new Map<string, (event: 'rename' | 'change', file: string | null) => void>(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    watch: (
      path: string,
      options: { recursive: boolean; persistent: boolean },
      listener: (event: 'rename' | 'change', file: string | null) => void,
    ) => {
      if (state.native) return fs.watch(path, options, listener);
      state.watches.set(path, listener);
      return Object.assign(new EventEmitter(), { close: vi.fn() });
    },
  };
});
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(name, handler),
  },
  dialog: {},
  shell: {},
}));
vi.mock('../api', () => ({
  removeWorkspaceEntry: vi.fn(),
  prepareStorage: vi.fn(),
  entry: vi.fn(),
  createWorkspaceEntry: vi.fn(),
  updateWorkspaceEntry: vi.fn(),
  importWorkspaceFiles: vi.fn(),
  linkProjectFolder: vi.fn(),
  importRemoteProject: vi.fn(),
  projectLocation: vi.fn(),
  remoteProjectOf: vi.fn(),
  workspaceFilePath: vi.fn(),
  readWorkspaceEntry: vi.fn(),
  saveWorkspaceNote: vi.fn(),
  saveNoteImage: vi.fn(),
}));
vi.mock('../project', () => ({
  openProjectDirectory: vi.fn(),
  projectGitBranch: vi.fn(),
  projectGitBranches: vi.fn(),
  projectGitCheckout: vi.fn(),
}));
vi.mock('../../ipc', () => ({ checkWorkspaceSender: vi.fn() }));
vi.mock('../layout', () => ({ registerLayoutIpc: vi.fn() }));
vi.mock('../../documents/export', () => ({ exportOfficePdf: vi.fn() }));
vi.mock('../../resources', () => ({ openResourceFile: vi.fn() }));
vi.mock('../../remotes/api', () => ({
  remoteById: vi.fn(),
  remoteJoin: vi.fn(),
  targetOf: vi.fn(),
  withinRemoteRoot: vi.fn(),
}));
vi.mock('../../remotes/operations', () => ({
  listRemoteDirectory: vi.fn(),
  remoteFileIndex: vi.fn(),
}));
vi.mock('../../remotes/documents', () => ({ readRemoteDocument: vi.fn() }));
vi.mock('../../remotes/transfer', () => ({
  downloadRemoteFile: vi.fn(),
  openRemoteFile: vi.fn(),
  uploadLocalFile: vi.fn(),
}));
vi.mock('../../remotes/ports', () => ({
  closeRemotePort: vi.fn(),
  openRemotePort: vi.fn(),
  remotePortsState: vi.fn(),
}));
vi.mock('../../remotes/events', () => ({ notifyRemoteChange: vi.fn() }));
vi.mock('../../remotes/watch', () => ({ watchRemoteProject: vi.fn() }));
vi.mock('../local-tree', () => ({
  getLocalWorkspaceState: async () => ({
    directory: state.root,
    entries: [{ id: 'project', parentId: null, kind: 'project', path: state.project }],
  }),
  listLocalDirectory: vi.fn(),
  localEntryAncestors: vi.fn(),
  searchLocalWorkspace: vi.fn(),
}));
vi.mock('../../database', () => ({ getDatabase: vi.fn() }));
vi.mock('../../storage', () => ({ storageDirectory: () => state.root }));

import { registerWorkspaceIpc } from '../ipc';

let client: EventEmitter & { send: ReturnType<typeof vi.fn>; isDestroyed: () => boolean };
beforeEach(() => {
  state.native = false;
  state.watches.clear();
  state.root = mkdtempSync(join(tmpdir(), 'dela-watch-'));
  state.project = join(state.root, 'external-course');
  mkdirSync(join(state.root, 'workspace'));
  mkdirSync(state.project);
  writeFileSync(join(state.project, 'note.md'), 'before');
  client = Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: () => false });
});
async function startWatching() {
  registerWorkspaceIpc(vi.fn(), vi.fn());
  await state.handlers.get('workspace:get-state')!({ sender: client as unknown as WebContents });
}
afterEach(() => {
  client.emit('destroyed');
  rmSync(state.root, { recursive: true, force: true });
  state.handlers.clear();
});

it('推送外部项目的原地内容写入，不触发目录树或引用索引失效', async () => {
  await startWatching();
  const file = join(state.project, 'note.md');
  writeFileSync(file, 'first AI step');
  state.watches.get(state.project)!('change', 'note.md');
  await vi.waitFor(() =>
    expect(client.send).toHaveBeenCalledWith('workspace:file-changed', [file]),
  );
  expect(client.send.mock.calls.some(([channel]) => channel === 'workspace:changed')).toBe(false);
  client.send.mockClear();
  writeFileSync(file, 'second AI step');
  state.watches.get(state.project)!('change', 'note.md');
  await vi.waitFor(() =>
    expect(client.send).toHaveBeenCalledWith('workspace:file-changed', [file]),
  );
  expect(client.send.mock.calls.some(([channel]) => channel === 'workspace:changed')).toBe(false);
});

it('原子替换同时通知文件内容与目录树', async () => {
  await startWatching();
  const file = join(state.project, 'note.md');
  const temporary = join(state.project, 'note.tmp');
  writeFileSync(temporary, 'replacement');
  renameSync(temporary, file);
  state.watches.get(state.project)!('rename', 'note.md');
  await vi.waitFor(() =>
    expect(client.send).toHaveBeenCalledWith(
      'workspace:file-changed',
      expect.arrayContaining([file]),
    ),
  );
  expect(client.send).toHaveBeenCalledWith('workspace:changed', expect.arrayContaining([file]));
});

it('原生目录监听能够发现应用外的原地写入', async () => {
  state.native = true;
  await startWatching();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const file = join(state.project, 'note.md');
  writeFileSync(file, 'external write');
  await vi.waitFor(
    () =>
      expect(client.send).toHaveBeenCalledWith(
        'workspace:file-changed',
        expect.arrayContaining([file]),
      ),
    { timeout: 3000 },
  );
});
