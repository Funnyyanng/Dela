import { z } from 'zod';
import { getTodoState, refreshTodos } from '../../../todo';
import { coverage, freshness, tool, toolError } from '../shared';

export const refreshTodosTool = tool(
  '从 Canvas 刷新作业与提交状态缓存（联网写缓存；覆盖在读未归档课程），仅返回统计与同步状态；作业列表用 query_assignments 分页查询。次级副作用：已知课程出现新作业时会触发系统桌面通知。不会提交作业。',
  z.object({}).strict(),
  async () => {
    const state = getTodoState();
    if (!state.connected)
      throw toolError('NOT_CONFIGURED', 'Canvas 未连接，无法刷新作业；请先在设置中连接 Canvas');
    const { items, ...result } = await refreshTodos();
    return {
      ...result,
      total: items.length,
      assignments: items.filter((item) => item.source === 'canvas').length,
      personal: items.filter((item) => item.source === 'personal').length,
      freshness: freshness('cached', result.syncedAt ?? undefined),
      coverage: coverage(
        'cached_assignments',
        !result.error,
        result.error ? [`部分课程同步失败：${result.error}`] : undefined,
      ),
    };
  },
);
