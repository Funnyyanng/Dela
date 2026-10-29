import type { CalendarEventColor } from './timetable';

export type TodoStatus =
  'pending' | 'completed' | 'submitted' | 'graded' | 'excused' | 'resubmit' | 'offline' | 'unknown';
export interface CanvasAssignmentRequirements {
  submissionTypes: string[] | null;
  allowedExtensions: string[] | null;
  allowedAttempts: number | null;
  pointsPossible: number | null;
  gradingType: string | null;
  rubric: Record<string, unknown>[] | null;
  rubricSettings: Record<string, unknown> | null;
  useRubricForGrading: boolean | null;
  peerReviews: boolean | null;
  unlockAt: string | null;
  lockAt: string | null;
  lockedForUser: boolean | null;
}

export function canvasAssignmentRequirements(
  assignment: Record<string, unknown>,
): CanvasAssignmentRequirements {
  const strings = (value: unknown): string[] | null =>
    Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  return {
    submissionTypes: strings(assignment.submission_types),
    allowedExtensions: strings(assignment.allowed_extensions),
    allowedAttempts:
      typeof assignment.allowed_attempts === 'number' ? assignment.allowed_attempts : null,
    pointsPossible:
      typeof assignment.points_possible === 'number' ? assignment.points_possible : null,
    gradingType: typeof assignment.grading_type === 'string' ? assignment.grading_type : null,
    rubric:
      Array.isArray(assignment.rubric) && assignment.rubric.every(record)
        ? assignment.rubric
        : null,
    rubricSettings: record(assignment.rubric_settings) ? assignment.rubric_settings : null,
    useRubricForGrading:
      typeof assignment.use_rubric_for_grading === 'boolean'
        ? assignment.use_rubric_for_grading
        : null,
    peerReviews: typeof assignment.peer_reviews === 'boolean' ? assignment.peer_reviews : null,
    unlockAt: typeof assignment.unlock_at === 'string' ? assignment.unlock_at : null,
    lockAt: typeof assignment.lock_at === 'string' ? assignment.lock_at : null,
    lockedForUser:
      typeof assignment.locked_for_user === 'boolean' ? assignment.locked_for_user : null,
  };
}

export interface TodoItem {
  id: string;
  source: 'personal' | 'canvas';
  title: string;
  notes: string;
  dueAt: string | null;
  status: TodoStatus;
  readAt: string | null;
  createdAt: string;
  /** 仅个人待办：开启后在日历（周/月视图）中按截止时间显示。 */
  calendar?: boolean;
  /** 仅个人待办：写入日历时的候选色；未选时渲染回退石墨色。 */
  color?: CalendarEventColor;
  courseId?: number;
  /** Canvas 课程代码；月历与课表共用它生成稳定的课程颜色。 */
  courseCode?: string;
  courseName?: string;
  assignmentId?: number;
  url?: string;
  /** 仅 Canvas 作业：作业描述原始 HTML，随作业同步缓存，renderer 经沙箱 iframe 渲染。 */
  description?: string;
  assignmentRequirements?: CanvasAssignmentRequirements;
  submittedAt?: string | null;
  syncedAt?: string;
}
export interface TodoState {
  items: TodoItem[];
  connected: boolean;
  syncing: boolean;
  syncedAt: string | null;
  error: string | null;
}
export interface TodoSaveInput {
  id?: string;
  title: string;
  notes?: string;
  dueAt?: string | null;
  completed?: boolean;
  calendar?: boolean;
  color?: CalendarEventColor;
}
export interface TodoApi {
  getState(): Promise<TodoState>;
  refresh(): Promise<TodoState>;
  save(input: TodoSaveInput): Promise<TodoState>;
  remove(id: string): Promise<TodoState>;
  markRead(id: string): Promise<TodoState>;
  onUpdate(listener: (state: TodoState) => void): () => void;
}

export const todoStatusLabels: Record<TodoStatus, string> = {
  pending: '未完成',
  completed: '已完成',
  submitted: '已提交',
  graded: '已批改',
  excused: '已豁免',
  resubmit: '需重新提交',
  offline: '线下 / 无需在线提交',
  unknown: '待同步确认',
};

export function todoCompleted(status: TodoStatus): boolean {
  return ['completed', 'submitted', 'graded', 'excused'].includes(status);
}

/** 仅按 Canvas 明确返回的提交事实判定；成绩（包括零分）本身不代表完成。 */
export function canvasTodoStatus(assignment: Record<string, unknown>): TodoStatus {
  const sub = assignment.submission as Record<string, unknown> | null | undefined;
  if (!sub || typeof sub !== 'object') return 'unknown';
  if (sub.excused === true) return 'excused';
  if (sub.redo_request === true) return 'resubmit';
  if (
    sub.submitted_at ||
    sub.workflow_state === 'submitted' ||
    sub.workflow_state === 'pending_review'
  ) {
    return sub.workflow_state === 'graded' ? 'graded' : 'submitted';
  }
  const types = assignment.submission_types;
  if (
    Array.isArray(types) &&
    types.every((type) => type === 'on_paper' || type === 'none') &&
    types.length
  ) {
    return sub.workflow_state === 'graded' && sub.missing !== true ? 'graded' : 'offline';
  }
  if (
    sub.workflow_state === 'unsubmitted' ||
    sub.missing === true ||
    sub.workflow_state === 'graded'
  )
    return 'pending';
  return 'unknown';
}
