export interface CanvasQuizSummary {
  id: number;
  title: string;
  description: string;
  dueAt: string | null;
  url: string;
  assignmentId?: number;
  updatedAt?: string | null;
}

export interface CanvasLocalSyncResult {
  root: string;
  projectId: string;
  added: number;
  updated: number;
  unchanged: number;
  adopted: number;
  conflicts: { path: string; reason: string; incomingPath?: string }[];
  failed: string[];
  syncedAt: string;
}

export interface CanvasLocalSyncState {
  root: string;
  projectId: string;
  courseIds: number[];
  courses: { id: number; name: string; directory: string }[];
  syncedAt: string | null;
  lastResult: CanvasLocalSyncResult | null;
}
