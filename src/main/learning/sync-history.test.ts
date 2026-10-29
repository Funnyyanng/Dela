import { expect, it } from 'vitest';
import type { CanvasLocalSyncState } from '../../shared/canvas-local';
import { learningSyncHistory } from './sync-history';

it('keeps dated sync history separate from current file health without losing failures', () => {
  const state: CanvasLocalSyncState = {
    root: '/semester',
    projectId: 'project',
    courseIds: [1],
    courses: [{ id: 1, name: '课程', directory: '课程' }],
    syncedAt: '2026-10-29T01:00:00Z',
    lastResult: {
      root: '/semester',
      projectId: 'project',
      added: 0,
      updated: 0,
      unchanged: 3,
      adopted: 0,
      syncedAt: '2026-10-28T01:00:00Z',
      failed: [
        '课程/测试：Canvas HTTP 404：内容不可用',
        '课程/附件.pdf：此文件是未发布单元的一部分，尚未可用。',
        '其他课程/资料.pdf：网络连接失败',
      ],
      conflicts: [{ path: '/semester/课程/资料.pdf', reason: '已保留两份' }],
    },
  };
  expect(learningSyncHistory(state)).toEqual({
    syncedAt: '2026-10-28T01:00:00Z',
    unavailable: state.lastResult!.failed.slice(0, 2),
    failed: [state.lastResult!.failed[2]],
    conflicts: ['/semester/课程/资料.pdf：已保留两份'],
  });
  expect(learningSyncHistory(null)).toBeUndefined();
  expect(learningSyncHistory({ ...state, lastResult: null })).toBeUndefined();
});
