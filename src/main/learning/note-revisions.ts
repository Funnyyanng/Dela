import { app } from 'electron';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { TEXT_EDIT_MAX_BYTES } from '../../shared/files';
import { getLocalCanvasSyncState } from '../canvas/local-sync';
import { textRevision, writeLocalText } from '../workspace/files';
import { toolError } from '../../shared/tool-errors';

export const learningNoteTarget = z.object({
  courseId: z.number().int().positive(),
  path: z.string().trim().min(1).max(4000),
});

export const learningNoteUpdate = learningNoteTarget.extend({
  expectedRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  edits: z
    .array(z.object({ before: z.string().min(1), after: z.string() }))
    .max(50)
    .default([]),
  createText: z.string().optional(),
  summary: z.string().trim().min(1).max(500),
});

export const learningNoteRestore = learningNoteTarget.extend({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
});

const versionsSchema = z.array(
  z.object({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    savedAt: z.string(),
    summary: z.string(),
  }),
);

function notePath(input: z.infer<typeof learningNoteTarget>) {
  const state = getLocalCanvasSyncState();
  const course = state?.courses.find((item) => item.id === input.courseId);
  if (!state || !course) throw toolError('NOT_FOUND', '课程尚未关联本地文件夹');
  const courseRoot = realpathSync(resolve(state.root, course.directory));
  const root = join(courseRoot, '学习笔记');
  const path = resolve(courseRoot, input.path);
  const rest = relative(root, path);
  if (!rest || rest.startsWith('..') || isAbsolute(rest) || extname(path).toLowerCase() !== '.md')
    throw toolError('INVALID_INPUT', '笔记更新仅支持所选课程“学习笔记”中的 Markdown 文件');
  let ancestor = existsSync(path) ? path : dirname(path);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const actual = realpathSync(ancestor);
  const expected = resolve(ancestor);
  if (actual !== expected)
    throw toolError('INVALID_INPUT', '请使用笔记文件的真实路径，避免修改链接指向的其他资料');
  return path;
}

function noteText(path: string) {
  if (!existsSync(path)) return null;
  if (!statSync(path).isFile() || statSync(path).size > TEXT_EDIT_MAX_BYTES)
    throw toolError('INVALID_INPUT', '笔记超过编辑范围，请按章节处理');
  const bytes = readFileSync(path);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw toolError('INVALID_INPUT', '笔记不是 UTF-8 文本');
  return text;
}

function historyDirectory(path: string) {
  const key = createHash('sha256').update(path).digest('hex');
  return join(app.getPath('userData'), 'learning', 'note-history', key);
}

function versions(path: string) {
  const index = join(historyDirectory(path), 'index.json');
  return existsSync(index) ? versionsSchema.parse(JSON.parse(readFileSync(index, 'utf8'))) : [];
}

function checkpoint(path: string, text: string, summary: string) {
  const root = historyDirectory(path);
  mkdirSync(root, { recursive: true });
  const revision = textRevision(text);
  const file = join(root, `${revision}.md`);
  if (!existsSync(file)) writeFileSync(file, text, { flag: 'wx' });
  const previous = versions(path);
  const next = [
    { revision, savedAt: new Date().toISOString(), summary },
    ...previous.filter((item) => item.revision !== revision),
  ].slice(0, 20);
  writeFileSync(join(root, 'index.json'), JSON.stringify(next));
  for (const item of previous)
    if (!next.some((current) => current.revision === item.revision))
      rmSync(join(root, `${item.revision}.md`), { force: true });
}

export function inspectLearningNote(raw: unknown) {
  const input = learningNoteTarget.parse(raw);
  const path = notePath(input);
  const text = noteText(path);
  return {
    path,
    exists: text !== null,
    revision: text === null ? null : textRevision(text),
    bytes: text === null ? 0 : Buffer.byteLength(text),
    versions: versions(path),
  };
}

export function updateLearningNote(raw: unknown) {
  const input = learningNoteUpdate.parse(raw);
  const path = notePath(input);
  const current = noteText(path);
  const revision = current === null ? null : textRevision(current);
  if (revision !== input.expectedRevision)
    throw toolError('VERSION_CONFLICT', '笔记已变化，原文已保留；请重新读取后只更新受影响的段落');
  let text: string;
  if (current === null) {
    if (input.createText === undefined || input.edits.length)
      throw toolError('INVALID_INPUT', '新笔记使用 createText，已有笔记使用精确段落 edits');
    text = input.createText;
  } else {
    if (input.createText !== undefined || !input.edits.length)
      throw toolError('INVALID_INPUT', '已有笔记只能精确更新段落，不接受整篇覆盖');
    const newline = current.includes('\r\n') ? '\r\n' : '\n';
    text = current;
    for (const edit of input.edits) {
      const before = edit.before.replace(/\r?\n/g, newline);
      const after = edit.after.replace(/\r?\n/g, newline);
      const index = text.indexOf(before);
      if (index < 0 || text.indexOf(before, index + 1) !== -1)
        throw toolError(
          'VERSION_CONFLICT',
          '待修改段落不存在或不唯一，笔记未修改；请缩小到明确段落',
        );
      text = text.slice(0, index) + after + text.slice(index + before.length);
    }
  }
  if (!text.trim() || Buffer.byteLength(text) > TEXT_EDIT_MAX_BYTES)
    throw toolError('INVALID_INPUT', '笔记内容为空或超过 1 MB，请按章节保存');
  if (text === current) return { path, revision, changed: false };
  mkdirSync(dirname(path), { recursive: true });
  if (current !== null) {
    checkpoint(path, current, input.summary);
    writeLocalText(path, text, input.expectedRevision!);
  } else writeFileSync(path, text, { flag: 'wx' });
  return { path, revision: textRevision(text), changed: true, undoAvailable: current !== null };
}

export function restoreLearningNote(raw: unknown) {
  const input = learningNoteRestore.parse(raw);
  const path = notePath(input);
  const current = noteText(path);
  if (current === null || textRevision(current) !== input.expectedRevision)
    throw toolError('VERSION_CONFLICT', '笔记已变化，恢复操作未执行；请重新核对当前版本');
  if (!versions(path).some((item) => item.revision === input.revision))
    throw toolError('NOT_FOUND', '未找到所选笔记版本');
  const text = readFileSync(join(historyDirectory(path), `${input.revision}.md`), 'utf8');
  checkpoint(path, current, '恢复前的笔记');
  writeLocalText(path, text, input.expectedRevision);
  return { path, revision: textRevision(text), restored: true };
}
