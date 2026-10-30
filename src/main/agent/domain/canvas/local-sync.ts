import { z } from 'zod';
import {
  getLocalCanvasSyncState,
  localSyncOptionsSchema,
  syncLocalCanvas,
} from '../../../canvas/local-sync';
import { tool, toolError } from '../shared';
import { requireCanvasConfigured, withCanvasErrors } from './helpers';

export const localCanvasStatusTool = tool(
  '读取已关联的本地课程根目录、课程映射和上次增量同步概况。只读本地，不联网、不读取课件正文。未关联时先让用户在资料页 Canvas 操作中选择“同步本地课程”。',
  z.object({}).strict(),
  () => {
    const state = getLocalCanvasSyncState();
    if (!state) return { configured: false };
    const last = state.lastResult;
    return {
      configured: true,
      root: state.root,
      projectId: state.projectId,
      courses: state.courses,
      syncedAt: state.syncedAt,
      lastResult: last
        ? {
            scope: last.scope,
            added: last.added,
            updated: last.updated,
            unchanged: last.unchanged,
            adopted: last.adopted,
            conflicts: last.conflicts.length,
            failed: last.failed.length,
          }
        : null,
    };
  },
);

export const syncLocalCanvasTool = tool(
  '按 courseId 限定一门课程，assignmentIds 限定原题与附件；无参数时更新全部已关联课程。将已关联课程的 Canvas 新资料、作业说明及题目附件、测试安排增量同步到本地课程目录。仅在用户要求更新时联网执行；保护本地修改、笔记与作业成果。返回计数与最多20项需处理问题，不返回资料全文。',
  localSyncOptionsSchema,
  async (options) => {
    requireCanvasConfigured();
    if (!getLocalCanvasSyncState())
      throw toolError('NOT_CONFIGURED', '请先在资料页的 Canvas 操作中配置“同步本地课程”');
    const result = await withCanvasErrors(() => syncLocalCanvas(options));
    return {
      root: result.root,
      projectId: result.projectId,
      syncedAt: result.syncedAt,
      scope: result.scope,
      added: result.added,
      updated: result.updated,
      unchanged: result.unchanged,
      adopted: result.adopted,
      conflictCount: result.conflicts.length,
      conflicts: result.conflicts.slice(0, 20),
      failedCount: result.failed.length,
      failed: result.failed.slice(0, 20),
      complete: !result.failed.length && !result.conflicts.length,
      details: result.scope?.completeLibrary
        ? '完整结果可在“同步本地课程”面板查看。'
        : '本次仅核对指定范围；其他课程与根目录总览未更新。',
    };
  },
);
