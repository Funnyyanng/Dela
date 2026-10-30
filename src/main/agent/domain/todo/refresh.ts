import { z } from 'zod';
import { getTodoState, refreshTodos } from '../../../todo';
import { coverage, freshness, tool, toolError } from '../shared';

export const refreshTodosTool = tool(
  '从 Canvas 刷新作业与提交状态缓存（联网写缓存；传 courseId 只核对本课程，无参数覆盖所有有效选课，不按本地归档标记排除），仅返回统计与同步状态；作业列表用 query_assignments 分页查询。次级副作用：已知课程出现新作业时会触发系统桌面通知。不会提交作业。',
  z.object({ courseId: z.number().int().positive().optional() }).strict(),
  async ({ courseId }) => {
    const state = getTodoState();
    if (!state.connected)
      throw toolError('NOT_CONFIGURED', 'Canvas 未连接，无法刷新作业；请先在设置中连接 Canvas');
    const { items, ...result } = await refreshTodos(courseId ? { courseId } : undefined);
    const selectedCourse = result.canvasCourses?.find((course) => course.id === courseId);
    const scopedError = courseId
      ? selectedCourse?.error || (!selectedCourse?.syncedAt ? '本课程尚未核对' : null)
      : result.error;
    const scopedItems = courseId ? items.filter((item) => item.courseId === courseId) : items;
    return {
      ...result,
      scope: courseId ? { courseId, completeLibrary: false } : { completeLibrary: true },
      total: scopedItems.length,
      assignments: scopedItems.filter((item) => item.source === 'canvas').length,
      personal: scopedItems.filter((item) => item.source === 'personal').length,
      freshness: freshness(
        'cached',
        (courseId ? selectedCourse?.syncedAt : result.syncedAt) ?? undefined,
      ),
      coverage: coverage(
        courseId ? `course_${courseId}_assignments` : 'cached_assignments',
        !scopedError,
        scopedError ? [`所查范围未完整核对：${scopedError}`] : undefined,
      ),
    };
  },
);
