import { getTodoState, saveTodo, todoSaveSchema } from '../../../todo';
import { slimTodo, tool, toolError } from '../shared';

export const saveTodoTool = tool(
  '新建或修改个人待办（本地写），仅返回保存的 item 与清单总数；列表用 query_todos 分页查询。提供 id 时更新已有条目；不能修改 Canvas 作业，不会提交作业。completed 仅在用户明确报告实际完成时控制单次事项状态，生成计划不算完成；重复事项完成请使用 record_occurrence，不能完成整个系列。priority/pinned/order 调整优先级；area/projectId/courseId 关联领域。remindAt 独立于截止时间；dueAt 为 UTC ISO 8601；calendar+color 控制是否在日历中按截止时间显示。',
  todoSaveSchema,
  (input) => {
    try {
      const existingIds = input.id ? null : new Set(getTodoState().items.map((item) => item.id));
      const { items, ...state } = saveTodo(input);
      const item = items.find((item) =>
        input.id ? item.id === input.id : !existingIds!.has(item.id),
      );
      return { ...state, total: items.length, item: slimTodo(item!) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('待办不存在')) throw toolError('NOT_FOUND', message);
      throw error;
    }
  },
);
