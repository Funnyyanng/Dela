import type { CanvasLocalSyncState } from '../../shared/canvas-local';
import type { LearningState } from '../../shared/learning';

export function learningSyncHistory(
  state: CanvasLocalSyncState | null,
): LearningState['syncHistory'] {
  const result = state?.lastResult;
  if (!result) return undefined;
  const unavailable: string[] = [];
  const failed: string[] = [];
  for (const message of result.failed) {
    if (/Canvas HTTP (?:403|404)\b|未发布单元|尚未可用/.test(message)) unavailable.push(message);
    else failed.push(message);
  }
  return {
    syncedAt: result.syncedAt,
    unavailable,
    conflicts: result.conflicts.map((item) => `${item.path}：${item.reason}`),
    failed,
  };
}
