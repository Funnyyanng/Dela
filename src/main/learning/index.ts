import { app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type {
  LearningCourse,
  LearningNote,
  LearningPracticeCard,
  LearningState,
  LearningTask,
} from '../../shared/learning';
import { toolError } from '../../shared/tool-errors';
import { getDatabase } from '../database';
import { getSource } from '../canvas/api';
import { getLocalCanvasSyncState } from '../canvas/local-sync';
import {
  findLocalCanvasBindingPath,
  localCanvasHash,
  localCanvasPath,
  localCanvasSignature,
  readLocalCanvasBindings,
  saveLocalCanvasBindings,
} from '../canvas/local-bindings';

const id = z.string().trim().min(1).max(200);
const title = z.string().trim().min(1).max(300);
const pathSchema = z.string().trim().min(1).max(4000);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const courseId = z.number().int().positive();
const sourceVersion = z.object({ sourceId: id, version: z.string().min(1).max(512) }).strict();
const artifactSchema = z
  .object({
    id,
    path: pathSchema,
    revision: revision.nullable().default(null),
    description: z.string().max(2000).default(''),
  })
  .strict();
const requirementSchema = z
  .object({
    id,
    text: title,
    status: z.enum(['open', 'met']),
    deliverableIds: z.array(id).max(30).default([]),
    evidenceIds: z.array(id).max(30).default([]),
  })
  .strict();
const findingSchema = z
  .object({ id, text: z.string().trim().min(1).max(2000), status: z.enum(['open', 'closed']) })
  .strict();
const checkSchema = z
  .object({
    kind: z.enum(['requirements', 'sources', 'calculations']),
    status: z.enum(['passed', 'not_applicable']),
    description: z.string().trim().min(1).max(2000),
  })
  .strict();

export const saveLearningTaskSchema = z
  .object({
    id: z.string().uuid().optional(),
    courseId,
    title,
    assignmentSourceId: id.optional(),
    assignmentSourceVersion: z.string().min(1).max(512).optional(),
    dueAt: z.string().datetime().nullable().default(null),
    status: z.enum(['draft', 'checked']).default('draft'),
    requirements: z.array(requirementSchema).min(1).max(100),
    deliverables: z.array(artifactSchema).max(100).default([]),
    evidence: z.array(artifactSchema).max(100).default([]),
    findings: z.array(findingSchema).max(100).default([]),
    checks: z.array(checkSchema).max(3).default([]),
  })
  .strict();
export const saveLearningNoteSchema = z
  .object({
    courseId,
    title,
    path: pathSchema,
    coveredSources: z.array(sourceVersion).min(1).max(200),
  })
  .strict();
export const saveLearningPracticeSchema = z
  .object({
    id: z.string().uuid().optional(),
    courseId,
    prompt: z.string().trim().min(1).max(5000),
    answer: z.string().trim().min(1).max(10000),
    sourceIds: z.array(id).min(1).max(30),
  })
  .strict();
export const practiceAttemptSchema = z
  .object({
    cardId: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime().optional(),
    response: z.string().trim().min(1).max(10000),
    outcome: z.enum(['again', 'hard', 'good']),
    errorCause: z.string().max(2000).default(''),
  })
  .strict();
export const inspectLearningFilesSchema = z
  .object({ courseId, paths: z.array(pathSchema).min(1).max(20) })
  .strict();

const storedTaskSchema = saveLearningTaskSchema.extend({
  id: z.string().uuid(),
  root: z.string(),
  updatedAt: z.string(),
  checkedAt: z.string().nullable(),
  signatures: z.record(z.string(), z.string()),
  assignmentSourceVersion: z.string().nullable().default(null),
});
const storedNoteSchema = saveLearningNoteSchema.extend({
  id: z.string().uuid(),
  root: z.string(),
  revision,
  signature: z.string(),
  updatedAt: z.string(),
});
const attemptSchema = practiceAttemptSchema
  .omit({ cardId: true, expectedUpdatedAt: true })
  .extend({ id: z.string().uuid(), createdAt: z.string() });
const storedPracticeSchema = saveLearningPracticeSchema.extend({
  id: z.string().uuid(),
  root: z.string(),
  dueAt: z.string(),
  intervalDays: z.number(),
  successfulAttempts: z.number(),
  attempts: z.array(attemptSchema),
  updatedAt: z.string(),
});
type StoredTask = z.infer<typeof storedTaskSchema>;
type StoredNote = z.infer<typeof storedNoteSchema>;
type StoredPractice = z.infer<typeof storedPracticeSchema>;

function records<T extends z.ZodType>(kind: string, schema: T): z.output<T>[] {
  const root = getLocalCanvasSyncState()?.root;
  const rows = getDatabase()
    .prepare('SELECT value FROM workspace_settings WHERE key LIKE ?')
    .all(`learning:${kind}:%`) as { value: string }[];
  return rows
    .map((row) => schema.parse(JSON.parse(row.value)))
    .filter((item) => (item as { root: string }).root === root);
}

function persist(kind: string, value: { id: string }) {
  getDatabase()
    .prepare('INSERT OR REPLACE INTO workspace_settings VALUES (?, ?)')
    .run(`learning:${kind}:${value.id}`, JSON.stringify(value));
}

export function getLearningCourses(): LearningCourse[] {
  const state = getLocalCanvasSyncState();
  if (!state) return [];
  const bindings = readLocalCanvasBindings(state.root);
  const rootKey = createHash('sha256').update(state.root).digest('hex').slice(0, 16);
  return state.courses.map((course) => {
    const workingDirectory = join(
      app.getPath('userData'),
      'learning',
      'work',
      rootKey,
      String(course.id),
    );
    mkdirSync(workingDirectory, { recursive: true });
    const result: LearningCourse = {
      id: course.id,
      name: course.name,
      projectId: state.projectId,
      directory: localCanvasPath(state.root, course.directory),
      workingDirectory,
      sources: [],
    };
    for (const binding of Object.values(bindings)) {
      const isQuiz = binding.sourceId.startsWith(`quiz:${course.id}:`);
      let source: ReturnType<typeof getSource> | undefined;
      if (!isQuiz) {
        try {
          source = getSource(binding.sourceId);
        } catch {}
      }
      const localRelative = relative(result.directory, resolve(state.root, binding.path));
      const retainedHere =
        localRelative &&
        localRelative !== '..' &&
        !localRelative.startsWith(`..${sep}`) &&
        !isAbsolute(localRelative);
      if (source ? source.courseId !== course.id : !isQuiz && !retainedHere) continue;
      let localPath: string | null = null;
      let warning = !source && !isQuiz ? '来源不在当前 Canvas 缓存中，请核对保留的本地文件' : '';
      try {
        localPath = findLocalCanvasBindingPath(state.root, binding);
        if (!localPath) warning = '本地来源文件缺失';
        else if (!binding.signature) warning = '本地来源完整性尚未核对，登记覆盖时将核对所选来源';
        else if (localCanvasSignature(localPath) !== binding.signature)
          warning = '本地来源文件已变化，请重新核对来源版本';
      } catch (error) {
        warning = error instanceof Error ? error.message : String(error);
      }
      const upstreamChanged =
        source?.updatedAt &&
        binding.version !== source.updatedAt &&
        !(binding.mime === 'text/html' && binding.version.startsWith(`${source.updatedAt}:`));
      if (binding.incoming || upstreamChanged)
        warning = '来源已有新版本，请核对 Canvas 同步冲突或重新同步';
      result.sources.push({
        sourceId: binding.sourceId,
        title: source?.title ?? basename(binding.path),
        kind:
          source?.kind ??
          (isQuiz ? 'quiz' : binding.sourceId.startsWith('assignment:') ? 'assignment' : 'file'),
        localPath,
        version: binding.version,
        revision: binding.hash,
        ...(warning ? { warning } : {}),
      });
    }
    return result;
  });
}

function currentCourse(value: number): { course: LearningCourse; root: string } {
  const state = getLocalCanvasSyncState();
  const course = getLearningCourses().find((item) => item.id === value);
  if (!state || !course) throw toolError('NOT_FOUND', '课程尚未关联本地文件夹');
  return { course, root: state.root };
}

function signature(path: string): string {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile()) throw toolError('INVALID_INPUT', `需要文件路径：${path}`);
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function learningFilePath(
  course: LearningCourse,
  path: string,
  allowWorkingDirectory = false,
): string {
  const target = resolve(course.directory, path);
  const rel = relative(course.workingDirectory, target);
  if (
    allowWorkingDirectory &&
    rel &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  )
    return localCanvasPath(course.workingDirectory, target);
  return localCanvasPath(course.directory, target);
}

function taskWarnings(task: StoredTask, courses: LearningCourse[]): string[] {
  const warnings: string[] = [];
  if (task.assignmentSourceId) {
    const source = courses
      .find((course) => course.id === task.courseId)
      ?.sources.find((item) => item.sourceId === task.assignmentSourceId);
    if (
      !source ||
      source.warning ||
      !task.assignmentSourceVersion ||
      source.version !== task.assignmentSourceVersion
    )
      warnings.push('作业来源已变化或不可用，需重新核对要求');
  }
  if (task.requirements.some((item) => item.status !== 'met')) warnings.push('仍有未满足的要求');
  if (task.findings.some((item) => item.status === 'open')) warnings.push('仍有未关闭的审阅问题');
  for (const kind of ['requirements', 'sources', 'calculations'] as const) {
    const check = task.checks.find((item) => item.kind === kind);
    if (!check || (kind !== 'calculations' && check.status !== 'passed'))
      warnings.push(`尚未明确复核：${kind}`);
  }
  for (const requirement of task.requirements) {
    if (!requirement.deliverableIds.length || !requirement.evidenceIds.length)
      warnings.push(`要求“${requirement.text}”尚未关联成果和证据`);
  }
  if (!task.deliverables.length) warnings.push('尚未登记成果');
  for (const artifact of [...task.deliverables, ...task.evidence]) {
    if (!artifact.revision) warnings.push(`尚未核对文件版本：${artifact.path}`);
    try {
      if (signature(artifact.path) !== task.signatures[artifact.id])
        warnings.push(`文件已变化，需重新核对：${artifact.path}`);
    } catch {
      warnings.push(`文件不可用：${artifact.path}`);
    }
  }
  return [...new Set(warnings)];
}

function taskView(task: StoredTask, courses: LearningCourse[]): LearningTask {
  const { root: _root, signatures: _signatures, ...item } = task;
  const warnings = taskWarnings(task, courses);
  return {
    ...item,
    status: item.status === 'checked' && warnings.length ? 'draft' : item.status,
    warnings,
  };
}

function noteView(note: StoredNote, courses: LearningCourse[]): LearningNote {
  const { root: _root, signature: savedSignature, ...item } = note;
  const sources = courses.find((course) => course.id === note.courseId)?.sources ?? [];
  const warnings: string[] = [];
  try {
    if (signature(note.path) !== savedSignature)
      warnings.push('笔记文件已修改，覆盖登记需重新核对');
  } catch {
    warnings.push('笔记文件不可用');
  }
  for (const covered of note.coveredSources) {
    const source = sources.find((candidate) => candidate.sourceId === covered.sourceId);
    if (!source) warnings.push(`覆盖来源已不在当前课程映射中：${covered.sourceId}`);
    else if (source.version !== covered.version || source.warning)
      warnings.push(`来源有变化或不可用：${source.title}`);
  }
  return { ...item, warnings };
}

function practiceView(card: StoredPractice): LearningPracticeCard {
  const { root: _root, ...item } = card;
  return item;
}

export function queryLearningRecords(
  kind: 'tasks' | 'notes' | 'practice',
  course?: number,
  courses = getLearningCourses(),
) {
  const mapped = new Set(courses.map((item) => item.id));
  if (kind === 'tasks')
    return records('task', storedTaskSchema)
      .filter((item) => mapped.has(item.courseId) && (!course || item.courseId === course))
      .map((item) => taskView(item, courses));
  if (kind === 'notes')
    return records('note', storedNoteSchema)
      .filter((item) => mapped.has(item.courseId) && (!course || item.courseId === course))
      .map((item) => noteView(item, courses));
  return records('practice', storedPracticeSchema)
    .filter((item) => mapped.has(item.courseId) && (!course || item.courseId === course))
    .map(practiceView);
}

export function getLearningState(): LearningState {
  const state = getLocalCanvasSyncState();
  const courses = getLearningCourses();
  const tasks = queryLearningRecords('tasks', undefined, courses) as LearningTask[];
  const notes = queryLearningRecords('notes', undefined, courses) as LearningNote[];
  const practice = queryLearningRecords('practice', undefined, courses) as LearningPracticeCard[];
  const warnings = state
    ? [
        ...(state.lastResult?.failed ?? []),
        ...(state.lastResult?.conflicts.map((item) => `${item.path}：${item.reason}`) ?? []),
      ]
    : ['请先在 Canvas 关联本地课程文件夹'];
  if (tasks.length > 200 || notes.length > 200 || practice.length > 200)
    warnings.push('学习中心显示每类前 200 条，完整记录可通过学习命令分页查询');
  return {
    root: state?.root ?? null,
    syncedAt: state?.syncedAt ?? null,
    courses,
    tasks: tasks.sort((a, b) => (a.dueAt ?? 'z').localeCompare(b.dueAt ?? 'z')).slice(0, 200),
    notes: notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 200),
    practice: practice.sort((a, b) => a.dueAt.localeCompare(b.dueAt)).slice(0, 200),
    warnings,
  };
}

export function getLearningOverview(selectedCourseId?: number) {
  const state = getLocalCanvasSyncState();
  const tasks = records('task', storedTaskSchema);
  const notes = records('note', storedNoteSchema);
  const practice = records('practice', storedPracticeSchema);
  return {
    root: state?.root ?? null,
    syncedAt: state?.syncedAt ?? null,
    warnings: state
      ? [
          ...(state.lastResult?.failed ?? []),
          ...(state.lastResult?.conflicts.map((item) => `${item.path}：${item.reason}`) ?? []),
        ]
      : ['请先在 Canvas 关联本地课程文件夹'],
    courses: getLearningCourses()
      .filter((course) => selectedCourseId === undefined || course.id === selectedCourseId)
      .map(({ sources, ...course }) => ({
        ...course,
        sourceCount: sources.length,
        tasks: tasks.filter((item) => item.courseId === course.id).length,
        notes: notes.filter((item) => item.courseId === course.id).length,
        practice: practice.filter((item) => item.courseId === course.id).length,
      })),
  };
}

export async function inspectLearningFiles(input: unknown) {
  const value = inspectLearningFilesSchema.parse(input);
  const { course } = currentCourse(value.courseId);
  return Promise.all(
    value.paths.map(async (path) => {
      const target = learningFilePath(course, path, true);
      const before = signature(target);
      const revision = await localCanvasHash(target);
      if (signature(target) !== before)
        throw toolError('VERSION_CONFLICT', '文件正在变化，请重试核对');
      return { path: target, revision, bytes: statSync(target).size };
    }),
  );
}

async function verifyLearningSources(root: string, course: LearningCourse, sourceIds: string[]) {
  const bindings = readLocalCanvasBindings(root);
  const verified: string[] = [];
  for (const sourceId of new Set(sourceIds)) {
    if (!course.sources.some((source) => source.sourceId === sourceId))
      throw toolError('NOT_FOUND', `来源不在当前课程映射中：${sourceId}`);
    const binding = Object.values(bindings).find((item) => item.sourceId === sourceId);
    const path = binding && findLocalCanvasBindingPath(root, binding);
    if (!binding || !path) throw toolError('VERSION_CONFLICT', `本地来源文件不可用：${sourceId}`);
    const before = signature(path);
    if (binding.signature === before) continue;
    if ((await localCanvasHash(path)) !== binding.hash || signature(path) !== before)
      throw toolError('VERSION_CONFLICT', `本地来源内容与同步版本不一致：${sourceId}`);
    binding.signature = before;
    verified.push(sourceId);
  }
  if (!verified.length) return;
  const current = readLocalCanvasBindings(root);
  for (const sourceId of verified) {
    const original = Object.values(bindings).find((item) => item.sourceId === sourceId)!;
    const binding = Object.values(current).find((item) => item.sourceId === sourceId);
    if (
      !binding ||
      binding.version !== original.version ||
      binding.hash !== original.hash ||
      binding.path !== original.path
    )
      throw toolError('VERSION_CONFLICT', `核对期间来源已同步，请重试：${sourceId}`);
    binding.signature = original.signature;
  }
  saveLocalCanvasBindings(root, current);
}

export async function saveLearningTask(input: unknown): Promise<LearningTask> {
  const value = saveLearningTaskSchema.parse(input);
  const { course, root } = currentCourse(value.courseId);
  const old = value.id
    ? records('task', storedTaskSchema).find(
        (item) => item.id === value.id && item.courseId === value.courseId,
      )
    : undefined;
  if (value.id && !old) throw toolError('NOT_FOUND', '学习任务记录不存在');
  if (value.assignmentSourceVersion && !value.assignmentSourceId)
    throw toolError('INVALID_INPUT', '登记已审阅来源版本时必须提供作业来源');
  if (
    value.assignmentSourceId &&
    !course.sources.some((source) => source.sourceId === value.assignmentSourceId)
  )
    throw toolError('INVALID_INPUT', '作业来源不在当前课程映射中');
  const assignmentSource = course.sources.find(
    (source) => source.sourceId === value.assignmentSourceId,
  );
  const reviewedVersion =
    value.assignmentSourceVersion ??
    (old?.assignmentSourceId === value.assignmentSourceId
      ? old?.assignmentSourceVersion
      : undefined);
  if (
    value.assignmentSourceId &&
    value.status === 'checked' &&
    (!reviewedVersion || reviewedVersion !== assignmentSource?.version)
  )
    throw toolError(
      'VERSION_CONFLICT',
      '作业来源版本与已审阅版本不一致，请重新核对要求并提供 assignmentSourceVersion',
    );
  if (value.assignmentSourceId && value.status === 'checked')
    await verifyLearningSources(root, course, [value.assignmentSourceId]);
  const identifiers = [
    ...value.requirements.map((item) => item.id),
    ...value.deliverables.map((item) => item.id),
    ...value.evidence.map((item) => item.id),
    ...value.findings.map((item) => item.id),
  ];
  if (new Set(identifiers).size !== identifiers.length)
    throw toolError('INVALID_INPUT', '要求、成果、证据与问题的 id 必须各自唯一');
  if (new Set(value.checks.map((item) => item.kind)).size !== value.checks.length)
    throw toolError('INVALID_INPUT', '每类复核只能登记一次');
  for (const requirement of value.requirements) {
    if (
      requirement.deliverableIds.some(
        (key) => !value.deliverables.some((item) => item.id === key),
      ) ||
      requirement.evidenceIds.some((key) => !value.evidence.some((item) => item.id === key))
    )
      throw toolError('INVALID_INPUT', `要求引用了不存在的成果或证据：${requirement.text}`);
  }
  const signatures: Record<string, string> = {};
  for (const artifact of [...value.deliverables, ...value.evidence]) {
    artifact.path = learningFilePath(course, artifact.path, value.evidence.includes(artifact));
    if (!existsSync(artifact.path)) continue;
    const before = signature(artifact.path);
    if (artifact.revision && (await localCanvasHash(artifact.path)) !== artifact.revision)
      throw toolError('VERSION_CONFLICT', `文件版本已变化：${artifact.path}`);
    if (signature(artifact.path) !== before)
      throw toolError('VERSION_CONFLICT', `核对期间文件已变化：${artifact.path}`);
    signatures[artifact.id] = before;
  }
  const now = new Date().toISOString();
  const task: StoredTask = {
    ...value,
    id: old?.id ?? randomUUID(),
    root,
    updatedAt: now,
    checkedAt: value.status === 'checked' ? now : null,
    signatures,
    assignmentSourceVersion: value.assignmentSourceId
      ? (reviewedVersion ?? assignmentSource!.version)
      : null,
  };
  const currentCourses = getLearningCourses();
  const warnings = taskWarnings(task, currentCourses);
  if (value.status === 'checked') {
    if (value.evidence.some((item) => !item.description.trim()))
      warnings.push('证据必须说明定位方式或验证结果');
    if (warnings.length)
      throw toolError('INVALID_INPUT', `尚不能标记为已核对：${warnings.join('；')}`);
  }
  persist('task', task);
  return taskView(task, currentCourses);
}

export async function saveLearningNote(input: unknown): Promise<LearningNote> {
  const value = saveLearningNoteSchema.parse(input);
  const { course, root } = currentCourse(value.courseId);
  const path = localCanvasPath(
    join(course.directory, '学习笔记'),
    resolve(course.directory, value.path),
  );
  if (extname(path).toLowerCase() !== '.md')
    throw toolError('INVALID_INPUT', '规范笔记须为课程“学习笔记”中的 Markdown 文件');
  await verifyLearningSources(
    root,
    course,
    value.coveredSources.map((item) => item.sourceId),
  );
  const verifiedCourse = currentCourse(value.courseId).course;
  for (const covered of value.coveredSources) {
    const source = verifiedCourse.sources.find((item) => item.sourceId === covered.sourceId);
    if (!source || source.version !== covered.version || source.warning)
      throw toolError('VERSION_CONFLICT', `来源版本尚未核对：${covered.sourceId}`);
  }
  const before = signature(path);
  const revision = await localCanvasHash(path);
  if (signature(path) !== before) throw toolError('VERSION_CONFLICT', '登记期间笔记发生变化');
  const old = records('note', storedNoteSchema).find(
    (item) => item.courseId === value.courseId && item.path === path,
  );
  const note: StoredNote = {
    ...value,
    id: old?.id ?? randomUUID(),
    path,
    root,
    revision,
    signature: before,
    updatedAt: new Date().toISOString(),
  };
  persist('note', note);
  return noteView(note, [verifiedCourse]);
}

export function saveLearningPractice(input: unknown): LearningPracticeCard {
  const value = saveLearningPracticeSchema.parse(input);
  const { course, root } = currentCourse(value.courseId);
  if (
    value.sourceIds.some((sourceId) => !course.sources.some((item) => item.sourceId === sourceId))
  )
    throw toolError('INVALID_INPUT', '练习来源不在当前课程映射中');
  const old = value.id
    ? records('practice', storedPracticeSchema).find(
        (item) => item.id === value.id && item.courseId === value.courseId,
      )
    : undefined;
  if (value.id && !old) throw toolError('NOT_FOUND', '练习卡不存在');
  const now = new Date(Math.max(Date.now(), old ? Date.parse(old.updatedAt) + 1 : 0)).toISOString();
  const changed = old && (old.prompt !== value.prompt || old.answer !== value.answer);
  const card: StoredPractice = {
    ...value,
    id: old?.id ?? randomUUID(),
    root,
    dueAt: changed ? now : (old?.dueAt ?? now),
    intervalDays: changed ? 0 : (old?.intervalDays ?? 0),
    successfulAttempts: changed ? 0 : (old?.successfulAttempts ?? 0),
    attempts: old?.attempts ?? [],
    updatedAt: now,
  };
  persist('practice', card);
  return practiceView(card);
}

export function submitLearningPracticeAttempt(input: unknown): LearningPracticeCard {
  const value = practiceAttemptSchema.parse(input);
  const card = records('practice', storedPracticeSchema).find((item) => item.id === value.cardId);
  if (!card) throw toolError('NOT_FOUND', '练习卡不存在');
  if (value.expectedUpdatedAt && value.expectedUpdatedAt !== card.updatedAt)
    throw toolError('VERSION_CONFLICT', '练习题已更新，请重新打开题目后作答');
  currentCourse(card.courseId);
  const now = new Date();
  card.successfulAttempts = value.outcome === 'good' ? card.successfulAttempts + 1 : 0;
  card.intervalDays =
    value.outcome === 'again'
      ? 0
      : value.outcome === 'hard'
        ? 1
        : Math.min(30, card.intervalDays < 1 ? 1 : card.intervalDays * 2 + 1);
  card.dueAt = new Date(
    now.valueOf() + (value.outcome === 'again' ? 10 * 60_000 : card.intervalDays * 86_400_000),
  ).toISOString();
  card.updatedAt = new Date(Math.max(now.valueOf(), Date.parse(card.updatedAt) + 1)).toISOString();
  const { cardId: _cardId, expectedUpdatedAt: _expectedUpdatedAt, ...attempt } = value;
  card.attempts.push({ ...attempt, id: randomUUID(), createdAt: card.updatedAt });
  persist('practice', card);
  return practiceView(card);
}
