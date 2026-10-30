import { BrowserWindow, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { z } from 'zod';
import { progressSchema } from './schema';
export { progressSchema } from './schema';
import { getDatabase } from '../database';
import { checkWorkspaceSender } from '../ipc';
import { projectDirectory } from '../workspace/api';
import { workspacePathAffected } from '../../shared/workspace';
import { getLearningState, refreshLearningSources } from '../learning';
import { refreshTodos } from '../todo';
import { syncLocalCanvas } from '../canvas/local-sync';
import { contextFor } from '../context';
import { learningPrompt, type LearningAction } from '../../shared/learning-prompt';
import type { ExecutionJob, JobInput, JobState } from '../../shared/jobs';
import {
  askSession,
  cancelRun,
  locateSessionFile,
  markManagedSession,
  newSession,
  openSession,
  subscribeRunEvents,
} from '../agent/session';

const inputSchema = z
  .object({
    domain: z.enum(['learning', 'project']),
    projectId: z.string().uuid(),
    title: z.string().trim().min(1).max(500),
    action: z.string().min(1).max(100),
    objectKey: z.string().max(2000).optional(),
    prompt: z.string().max(30000).optional(),
    courseId: z.number().int().positive().optional(),
    targetId: z.string().max(200).optional(),
    sourceIds: z.array(z.string().max(512)).max(200).optional(),
    paths: z.array(z.string().max(32767)).max(200).optional(),
    assignmentId: z.number().int().positive().optional(),
  })
  .strict();
interface StoredJob extends ExecutionJob {
  input: JobInput;
  key: string;
  response?: string;
}
let activeId: string | null = null;
let stopping = false;
let initialized = false;
let callbacks: { onChange?: (state: JobState) => void; onTerminal?: (job: ExecutionJob) => void } =
  {};

function schema() {
  getDatabase().exec(
    'CREATE TABLE IF NOT EXISTS execution_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
  );
}
function all(): StoredJob[] {
  schema();
  return (getDatabase().prepare('SELECT data FROM execution_jobs').all() as { data: string }[])
    .map((row) => JSON.parse(row.data) as StoredJob)
    .sort((a, b) => a.order - b.order);
}
function read(id: string): StoredJob {
  const job = all().find((job) => job.id === id);
  if (!job) throw new Error('任务不存在');
  return job;
}
function save(job: StoredJob) {
  getDatabase()
    .prepare('INSERT OR REPLACE INTO execution_jobs (id,data) VALUES (?,?)')
    .run(job.id, JSON.stringify(job));
}
function publicJob({
  input: _input,
  key: _key,
  response: _response,
  ...job
}: StoredJob): ExecutionJob {
  return job;
}
export function getJobState(): JobState {
  return { jobs: all().map(publicJob) };
}
function publish() {
  const state = getJobState();
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    const url = window.webContents.getURL();
    if (
      url.startsWith('http://127.0.0.1:5173/') ||
      (url.startsWith('file:') && /\/renderer\/index\.html(?:\?|$)/.test(url))
    )
      window.webContents.send('jobs:state', state);
  }
  try {
    callbacks.onChange?.(state);
  } catch (error) {
    console.error('Task status notification failed', error);
  }
  return state;
}
function update(id: string, patch: Partial<StoredJob>) {
  const job = { ...read(id), ...patch, updatedAt: Date.now() };
  save(job);
  publish();
  return job;
}
function notifyTerminal(job: StoredJob) {
  if (['completed', 'failed', 'needs_input'].includes(job.status)) {
    try {
      callbacks.onTerminal?.(publicJob(job));
    } catch (error) {
      console.error('Task completion notification failed', error);
    }
  }
}
function finish(id: string, patch: Partial<StoredJob>) {
  const job = update(id, { ...patch, finishedAt: Date.now() });
  notifyTerminal(job);
}
export function initializeJobs(hooks: typeof callbacks = {}) {
  if (initialized) {
    callbacks = hooks;
    return;
  }
  initialized = true;
  stopping = false;
  callbacks = hooks;
  for (const job of all()) {
    if (job.status === 'running')
      save({
        ...job,
        status: 'interrupted',
        stage: '应用已退出，等待检查进度后继续',
        awaitingResume: true,
        finishedAt: Date.now(),
        updatedAt: Date.now(),
      });
    else if (job.status === 'queued') save({ ...job, awaitingResume: true });
    else notifyTerminal(job);
  }
  publish();
}
export function shutdownJobs() {
  stopping = true;
  if (!initialized) return;
  for (const job of all()) {
    if (job.status === 'queued') save({ ...job, awaitingResume: true, updatedAt: Date.now() });
  }
  if (activeId) {
    const job = update(activeId, {
      status: 'interrupted',
      stage: '已保存进度，重新打开后可继续',
      awaitingResume: true,
      finishedAt: Date.now(),
    });
    if (job.sessionId) cancelRun(job.sessionId);
  }
  publish();
}
export function cancelJobsShutdown() {
  stopping = false;
}
export function enqueueJob(raw: unknown): ExecutionJob {
  const input = inputSchema.parse(raw);
  const outputDirectory = projectDirectory(input.projectId);
  if (input.domain === 'project' && !input.prompt?.trim()) throw new Error('项目任务缺少具体要求');
  if (
    input.domain === 'learning' &&
    (!input.courseId || !['assignment', 'notes', 'review', 'study'].includes(input.action))
  )
    throw new Error('学习任务缺少课程或操作');
  const identity = input.assignmentId
    ? `assignment:${input.assignmentId}`
    : input.objectKey ||
      JSON.stringify([
        input.domain === 'project' ? input.prompt : undefined,
        input.targetId,
        [...(input.sourceIds ?? [])].sort(),
        [...(input.paths ?? [])].sort(),
      ]);
  const key = JSON.stringify([
    input.projectId,
    input.domain,
    input.courseId,
    input.action,
    identity,
  ]);
  const previous = all().find(
    (job) =>
      job.key === key && ['queued', 'running', 'needs_input', 'interrupted'].includes(job.status),
  );
  if (previous) return publicJob(previous);
  const now = Date.now();
  const job: StoredJob = {
    id: randomUUID(),
    input,
    key,
    domain: input.domain,
    projectId: input.projectId,
    courseId: input.courseId,
    title: input.title,
    action: input.action,
    status: 'queued',
    stage: '等待处理',
    sessionId: null,
    result: '',
    error: null,
    question: null,
    files: [],
    usage: null,
    sourceVersions: [],
    outputDirectory,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
    order: Math.max(0, ...all().map((job) => job.order)) + 1,
    awaitingResume: false,
  };
  save(job);
  publish();
  void drain();
  return publicJob(job);
}
export function cancelJob(raw: unknown) {
  const id = z.string().uuid().parse(raw),
    job = read(id);
  if (!['queued', 'running', 'needs_input', 'interrupted'].includes(job.status))
    return getJobState();
  update(id, {
    status: 'stopped',
    stage: '已停止，已有文件保留',
    finishedAt: Date.now(),
    awaitingResume: false,
  });
  if (activeId === id && job.sessionId) cancelRun(job.sessionId);
  return publish();
}
export function resumeJob(raw: unknown, answer?: unknown) {
  const id = z.string().uuid().parse(raw),
    job = read(id);
  if (activeId === id) throw new Error('正在结束当前处理，请稍后再继续');
  if (!['queued', 'failed', 'stopped', 'interrupted', 'needs_input'].includes(job.status))
    throw new Error('此任务无需恢复');
  const response = z.string().trim().max(10000).optional().parse(answer);
  if (job.status === 'needs_input' && !response) throw new Error('请先补充所需信息');
  update(id, {
    status: 'queued',
    stage: '等待检查已有进度并继续',
    response,
    error: null,
    question: null,
    finishedAt: null,
    awaitingResume: false,
  });
  void drain();
  return getJobState();
}
export function reorderJobs(raw: unknown) {
  const ids = z.array(z.string().uuid()).parse(raw),
    jobs = all().filter((job) => job.status === 'queued');
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== jobs.length ||
    jobs.some((job) => !ids.includes(job.id))
  )
    throw new Error('队列已变化，请刷新后重试');
  const orders = jobs.map((job) => job.order).sort((a, b) => a - b);
  ids.forEach((id, index) => save({ ...read(id), order: orders[index]!, updatedAt: Date.now() }));
  return publish();
}
async function drain() {
  if (activeId || stopping) return;
  const job = all().find((job) => job.status === 'queued' && !job.awaitingResume);
  if (!job) return;
  activeId = job.id;
  try {
    await run(job.id);
  } catch (error) {
    if (!stopping && !['stopped', 'interrupted'].includes(read(job.id).status))
      finish(job.id, {
        status: 'failed',
        stage: '处理遇到问题',
        error: error instanceof Error ? error.message : String(error),
      });
  } finally {
    activeId = null;
    if (!stopping) void drain();
  }
}
async function run(id: string) {
  let job = update(id, { status: 'running', stage: '核对任务与已有进度', startedAt: Date.now() });
  let prompt = job.input.prompt ?? '';
  if (job.domain === 'learning') {
    await refreshLearningSources(job.courseId);
    let state = getLearningState();
    const initialCourse = state.courses.find(
      (course) => course.id === job.courseId && course.projectId === job.projectId,
    );
    if (!initialCourse) throw new Error('课程尚未关联本地项目，请先同步课程资料');
    let course = initialCourse;
    for (const path of job.input.paths ?? [])
      if (!workspacePathAffected(path, course.directory)) throw new Error('所选文件不属于这门课');
    const selection: Parameters<typeof learningPrompt>[3] = { paths: job.input.paths };
    if (job.action === 'assignment') {
      if (!job.input.assignmentId) throw new Error('请选择具体的 Canvas 未提交作业');
      const todos = await refreshTodos({ courseId: course.id }),
        coverage = todos.canvasCourses?.find((item) => item.id === course.id);
      if (
        !todos.connected ||
        (todos.canvasCourses
          ? !coverage?.syncedAt || coverage.error
          : todos.error || !todos.syncedAt)
      )
        throw new Error(coverage?.error || todos.error || '无法确认当前课程的提交状态');
      const assignment = todos.items.find(
        (item) =>
          item.source === 'canvas' &&
          item.courseId === course.id &&
          item.assignmentId === job.input.assignmentId,
      );
      if (!assignment) throw new Error('Canvas 中未找到该作业，请刷新列表');
      if (['submitted', 'graded', 'excused'].includes(assignment.status)) {
        finish(id, {
          status: 'skipped',
          stage: '已跳过',
          result: 'Canvas 已显示提交、批改或豁免，本次不再处理。',
        });
        return;
      }
      if (!['pending', 'resubmit'].includes(assignment.status))
        throw new Error('提交状态尚未确认，未开始处理');
      selection.assignment = assignment;
      update(id, { stage: '核对原题与附件版本' });
      const synced = await syncLocalCanvas({
        courseId: course.id,
        assignmentIds: [job.input.assignmentId],
      });
      if (synced.failed.length)
        throw new Error(`本次作业资料未能完整更新：${synced.failed.join('；')}`);
      await refreshLearningSources(course.id);
      state = getLearningState();
      const refreshed = state.courses.find(
        (item) => item.id === job.courseId && item.projectId === job.projectId,
      );
      if (!refreshed) throw new Error('课程关联已变化，请重新选择作业');
      course = refreshed;
    }
    const sources = course.sources.filter(
      (source) =>
        job.input.sourceIds?.includes(source.sourceId) ||
        source.sourceId === `assignment:${job.input.assignmentId}` ||
        (source.localPath &&
          job.input.paths?.some((path) => workspacePathAffected(source.localPath!, path))),
    );
    const missingSourceIds = (job.input.sourceIds ?? []).filter(
      (sourceId) => !sources.some((source) => source.sourceId === sourceId),
    );
    if (missingSourceIds.length)
      throw new Error('所选资料已移除或关联发生变化，请在课程页面重新选择，未扩大处理范围');
    selection.sources = sources;
    const target = [...state.tasks, ...state.notes].find(
      (item) => item.id === job.input.targetId && item.courseId === course.id,
    );
    prompt = [
      learningPrompt(course, job.action as LearningAction, target, selection),
      contextFor({ courseId: course.id, personal: false }),
    ]
      .filter(Boolean)
      .join('\n\n');
    job = update(id, {
      courseName: course.name,
      outputDirectory: course.directory,
      sourceVersions: sources.map(({ sourceId, version }) => ({ sourceId, version })),
    });
  }
  if (stopping || ['stopped', 'interrupted'].includes(read(id).status)) return;
  const chat = job.sessionId ? openSession(job.sessionId) : newSession(job.projectId, 'library');
  if (!chat.sessionId || !chat.configured) throw new Error('请先配置可用模型，再恢复任务');
  const sessionId = chat.sessionId;
  if (chat.running) throw new Error('关联对话仍在处理，请等待它结束后恢复');
  markManagedSession(sessionId);
  update(id, { sessionId, stage: '正在处理' });
  const instructions = `任务中心 jobId=${id}。阶段变化时调用 report_job_progress，提供 stage 和简短 summary。需要关键信息时调用该工具设置 question，说明缺什么，然后结束本轮等待用户补充。完成后用该工具登记实际存在的成果 files（path 和 title），再给出简洁结果；生成内容不等于已复核或已提交。`;
  const resume = job.sessionId
    ? `这是同一任务的继续处理。先检查已经生成的文件和前轮进度，保护用户修改，避免重复工作。\n${job.response ? `用户补充：${job.response}` : ''}\n当前任务与来源：\n`
    : '';
  let terminal = 'completed';
  const off = subscribeRunEvents((event) => {
    if (event.sessionId !== sessionId) return;
    if (['failed', 'stopped', 'interrupted'].includes(event.status)) terminal = event.status;
    try {
      if (
        event.status === 'running' &&
        event.activeTool &&
        !stopping &&
        read(id).status === 'running'
      )
        update(id, { stage: '正在读取、生成或核验资料' });
    } catch (error) {
      console.error('Task progress could not be saved', error);
    }
  });
  try {
    const next = await askSession(sessionId, {
      text: [resume, prompt, instructions].filter(Boolean).join('\n\n'),
      attachments: [],
      context: [],
    });
    if (stopping || ['stopped', 'interrupted'].includes(read(id).status)) return;
    const reply = next.messages.findLast((message) => message.role === 'assistant');
    const patch = { result: reply?.content ?? '', usage: next.contextUsage ?? null };
    if (terminal === 'failed') {
      finish(id, {
        ...patch,
        status: 'failed',
        error: reply?.content || '模型处理失败',
        stage: '处理失败',
      });
      return;
    }
    if (
      terminal === 'stopped' ||
      terminal === 'interrupted' ||
      reply?.stopped ||
      reply?.interrupted
    ) {
      finish(id, { ...patch, status: 'stopped', stage: '已停止' });
      return;
    }
    const current = read(id);
    if (current.question) {
      finish(id, { ...patch, status: 'needs_input', stage: '需要你补充' });
      return;
    }
    let files = current.files;
    if (job.domain === 'learning') {
      const state = getLearningState();
      const sourceIds = new Set(job.input.sourceIds ?? []);
      for (const source of state.courses.find((course) => course.id === job.courseId)?.sources ??
        [])
        if (
          source.localPath &&
          job.input.paths?.some((path) => workspacePathAffected(source.localPath!, path))
        )
          sourceIds.add(source.sourceId);
      const found =
        job.action === 'notes'
          ? state.notes
              .filter(
                (note) =>
                  note.courseId === job.courseId &&
                  (note.id === job.input.targetId ||
                    note.coveredSources.some((source) => sourceIds.has(source.sourceId))),
              )
              .map((note) => ({ path: note.path, title: basename(note.path) }))
          : state.tasks
              .filter(
                (task) =>
                  task.courseId === job.courseId &&
                  (task.id === job.input.targetId ||
                    task.assignmentSourceId === `assignment:${job.input.assignmentId}` ||
                    (task.assignmentSourceId && sourceIds.has(task.assignmentSourceId))),
              )
              .flatMap((task) =>
                task.deliverables.map((file) => ({ path: file.path, title: basename(file.path) })),
              );
      files = [...new Map([...files, ...found].map((file) => [file.path, file])).values()];
    }
    files = files.flatMap((file) => {
      try {
        return [{ ...file, path: locateSessionFile(sessionId, file.path) }];
      } catch {
        return [];
      }
    });
    finish(id, {
      ...patch,
      files,
      status: 'completed',
      stage: '本轮处理结束',
      response: undefined,
    });
  } finally {
    off();
    markManagedSession(sessionId, false);
  }
}
export function reportJobProgress(raw: unknown) {
  const value = progressSchema.parse(raw),
    job = read(value.jobId);
  if (activeId !== job.id || job.status !== 'running')
    throw new Error('只有当前运行任务能更新进度');
  const files = value.files?.map((file) => ({
    path: locateSessionFile(job.sessionId!, file.path),
    title: file.title,
  }));
  update(job.id, {
    stage: value.stage,
    ...(value.summary ? { result: value.summary } : {}),
    ...(value.question ? { question: value.question } : {}),
    ...(files ? { files } : {}),
  });
  return { saved: true };
}
export function registerJobsIpc() {
  const handlers = {
    'get-state': getJobState,
    enqueue: enqueueJob,
    cancel: cancelJob,
    resume: resumeJob,
    reorder: reorderJobs,
  };
  for (const [name, fn] of Object.entries(handlers))
    ipcMain.handle(`jobs:${name}`, (event, ...args) => {
      checkWorkspaceSender(event);
      return (fn as (...args: unknown[]) => unknown)(...args);
    });
}
