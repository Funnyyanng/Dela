import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { getDatabase } from '../database';
import type { StoredSource } from './api';

const incomingSchema = z.object({
  version: z.string(),
  path: z.string(),
  hash: z.string(),
});
export const localBindingSchema = z.object({
  sourceId: z.string(),
  version: z.string(),
  path: z.string(),
  hash: z.string(),
  mime: z.string(),
  scanRoot: z.string(),
  ino: z.number(),
  dev: z.number(),
  incoming: incomingSchema.optional(),
});
export type LocalCanvasBinding = z.infer<typeof localBindingSchema>;

export function readLocalCanvasBindings(root: string): Record<string, LocalCanvasBinding> {
  const row = getDatabase()
    .prepare('SELECT value FROM workspace_settings WHERE key=?')
    .get(`canvas-local-bindings:${root}`) as { value: string } | undefined;
  return row ? z.record(z.string(), localBindingSchema).parse(JSON.parse(row.value)) : {};
}

export function saveLocalCanvasBindings(
  root: string,
  bindings: Record<string, LocalCanvasBinding>,
) {
  getDatabase()
    .prepare('INSERT OR REPLACE INTO workspace_settings VALUES (?, ?)')
    .run(`canvas-local-bindings:${root}`, JSON.stringify(bindings));
}

export function localCanvasPath(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('本地 Canvas 路径必须在所选课程目录内');
  let current = root;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    const stats = lstatSync(current, { throwIfNoEntry: false });
    if (!stats) continue;
    if (stats.isSymbolicLink()) throw new Error('本地 Canvas 路径不能经过符号链接');
    const actual = relative(root, realpathSync(current));
    if (actual === '..' || actual.startsWith(`..${sep}`) || isAbsolute(actual))
      throw new Error('本地 Canvas 路径超出所选课程目录');
  }
  return target;
}

const hashes = new Map<string, { identity: string; hash: string }>();
export async function localCanvasHash(path: string): Promise<string> {
  const stats = statSync(path, { bigint: true });
  const identity = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
  const cached = hashes.get(path);
  if (cached?.identity === identity) return cached.hash;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const digest = hash.digest('hex');
  if (hashes.size >= 256) hashes.delete(hashes.keys().next().value!);
  hashes.set(path, { identity, hash: digest });
  return digest;
}

export function findLocalCanvasBindingPath(
  root: string,
  binding: LocalCanvasBinding,
): string | null {
  const path = localCanvasPath(root, binding.path);
  if (existsSync(path)) return statSync(path).isFile() ? path : null;
  const pending = [localCanvasPath(root, binding.scanRoot)];
  while (pending.length) {
    const directory = pending.pop()!;
    if (!existsSync(directory)) continue;
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.isSymbolicLink() || item.name === '学习笔记') continue;
      const candidate = join(directory, item.name);
      if (item.isDirectory()) pending.push(candidate);
      else if (item.isFile()) {
        const stats = statSync(candidate);
        if (stats.ino === binding.ino && stats.dev === binding.dev) return candidate;
      }
    }
  }
  return null;
}

export async function boundCanvasFile(
  source: StoredSource,
): Promise<{ path: string; mime: string } | null> {
  if (!source.updatedAt) return null;
  const row = getDatabase()
    .prepare("SELECT value FROM workspace_settings WHERE key='canvas-local-sync'")
    .get() as { value: string } | undefined;
  if (!row) return null;
  const { root } = z.object({ root: z.string() }).parse(JSON.parse(row.value));
  const bindings = readLocalCanvasBindings(root);
  for (const binding of Object.values(bindings)) {
    if (binding.sourceId !== source.id) continue;
    if (binding.incoming?.version === source.updatedAt) {
      const incoming = localCanvasPath(root, binding.incoming.path);
      if (existsSync(incoming) && (await localCanvasHash(incoming)) === binding.incoming.hash)
        return { path: incoming, mime: binding.mime };
    }
    if (binding.version !== source.updatedAt) continue;
    const path = findLocalCanvasBindingPath(root, binding);
    if (path && (await localCanvasHash(path)) === binding.hash) return { path, mime: binding.mime };
  }
  return null;
}
