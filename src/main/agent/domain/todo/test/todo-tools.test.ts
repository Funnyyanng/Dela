import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TodoItem, TodoState } from '../../../../../shared/api';
import { todoTools } from '../index';
import { canvasAssignmentRequirements } from '../../../../../shared/todo';

vi.mock('../../../../todo', async () => {
  const { z } = await import('zod');
  return {
    getTodoState: vi.fn(),
    refreshTodos: vi.fn(),
    saveTodo: vi.fn(),
    removeTodo: vi.fn(),
    // 与业务 todoSaveSchema 同形（校验本身属业务层职责，这里用可放行的等价 schema）。
    todoSaveSchema: z.object({
      id: z.string().optional(),
      title: z.string(),
      notes: z.string().optional(),
      dueAt: z.string().nullable().optional(),
      completed: z.boolean().optional(),
      calendar: z.boolean().optional(),
      color: z.string().optional(),
    }),
  };
});

import { getTodoState, refreshTodos, removeTodo, saveTodo } from '../../../../todo';

const state = vi.mocked(getTodoState);
const refresh = vi.mocked(refreshTodos);
const save = vi.mocked(saveTodo);
const remove = vi.mocked(removeTodo);

function todoItem(overrides: Partial<TodoItem>): TodoItem {
  return {
    id: '0d7d21f5-8d5a-4f97-9c7f-2f5dfc1a1b2a',
    source: 'personal',
    title: '写周报',
    notes: '',
    dueAt: null,
    status: 'pending',
    readAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function todoState(overrides: Partial<TodoState> = {}): TodoState {
  return {
    items: [
      todoItem({
        id: '0d7d21f5-8d5a-4f97-9c7f-2f5dfc1a1b2a',
        title: '写周报',
        status: 'pending',
      }),
      todoItem({
        id: 'canvas:owner:1:2',
        source: 'canvas',
        title: '作业一',
        courseId: 1,
        courseName: '操作系统',
        dueAt: '2026-10-01T16:00:00.000Z',
        status: 'submitted',
        description: '<p>作业描述 HTML</p>',
      }),
    ],
    connected: true,
    syncing: false,
    syncedAt: '2026-09-28T00:00:00.000Z',
    error: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.mockReturnValue(todoState());
});

describe('query_todos', () => {
  it('returns the unified list without assignment descriptions', () => {
    const result = todoTools.query_todos.execute({}) as {
      items: { id: string; description?: unknown }[];
      total: number;
      freshness: unknown;
      coverage: unknown;
    };
    expect(result.total).toBe(2);
    expect(result.items.every((item) => item.description === undefined)).toBe(true);
    expect(result.freshness).toEqual({ kind: 'cached', syncedAt: '2026-09-28T00:00:00.000Z' });
    expect(result.coverage).toEqual({
      scope: 'personal_todos_and_cached_assignments',
      complete: true,
    });
  });

  it('filters by keyword and completion status across both sources', () => {
    const result = todoTools.query_todos.execute({ query: '作业' }) as { total: number };
    expect(result.total).toBe(1);
    const completed = todoTools.query_todos.execute({ query: '', completed: true }) as {
      total: number;
    };
    expect(completed.total).toBe(1); // submitted 算已完成
    const open = todoTools.query_todos.execute({ query: '', completed: false }) as {
      total: number;
    };
    expect(open.total).toBe(1); // pending；unknown/offline 两不算
  });

  it('keeps personal todos visible with a coverage warning when Canvas is not connected', () => {
    state.mockReturnValue(todoState({ connected: false, items: [todoState().items[0]!] }));
    const result = todoTools.query_todos.execute({}) as {
      items: unknown[];
      coverage: { complete: boolean; warnings: string[] };
    };
    expect(result.items).toHaveLength(1);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.warnings[0]).toContain('Canvas 未连接');
  });
});

describe('query_assignments', () => {
  it('returns rubric details only for the requested assignment when explicitly included', () => {
    const requirements = canvasAssignmentRequirements({
      submission_types: ['online_upload'],
      rubric: [{ description: '论证', points: 10 }],
    });
    const assignment = todoItem({
      source: 'canvas',
      courseId: 1,
      assignmentId: 2,
      assignmentRequirements: requirements,
    });
    state.mockReturnValue(todoState({ items: [assignment, { ...assignment, assignmentId: 3 }] }));
    expect(todoTools.query_assignments.execute({})).toMatchObject({
      items: [{ assignmentId: 2 }, { assignmentId: 3 }],
    });
    expect(JSON.stringify(todoTools.query_assignments.execute({}))).not.toContain('rubric');
    expect(
      todoTools.query_assignments.execute({ assignmentId: 2, includeRequirements: true }),
    ).toMatchObject({
      total: 1,
      items: [{ assignmentId: 2, assignmentRequirements: requirements }],
    });
    state.mockReturnValue(todoState());
    expect(todoTools.query_assignments.execute({ includeRequirements: true })).toMatchObject({
      items: [{ assignmentRequirements: null }],
    });
  });
  it('filters canvas assignments by course and due range', () => {
    const result = todoTools.query_assignments.execute({
      courseId: 1,
      startAt: '2026-10-01T00:00:00.000Z',
      endAt: '2026-10-02T00:00:00.000Z',
    }) as { items: { id: string }[]; coverage: unknown; freshness: unknown };
    expect(result.items.map((item) => item.id)).toEqual(['canvas:owner:1:2']);
    expect(result.coverage).toEqual({ scope: 'cached_assignments', complete: true });
    const missed = todoTools.query_assignments.execute({
      startAt: '2026-11-01T00:00:00.000Z',
      endAt: '2026-11-02T00:00:00.000Z',
    }) as { total: number };
    expect(missed.total).toBe(0);
  });
});

describe('save_todo', () => {
  it('passes color and completion through and returns only the complete saved item', () => {
    const input = { title: '复习', completed: true, color: 'sage' };
    const target = todoItem({ id: 'new', title: input.title, status: 'completed', color: 'sage' });
    save.mockReturnValue(todoState({ items: [...todoState().items, target] }));
    const result = todoTools.save_todo.execute(input) as {
      item: TodoItem;
      total: number;
    };
    expect(save).toHaveBeenCalledWith(input);
    expect(result.item).toEqual(target);
    expect(result.total).toBe(3);
    expect(result).not.toHaveProperty('items');
  });

  it('does not repeat unrelated long notes when saving, deleting or refreshing a large list', async () => {
    const items = Array.from({ length: 500 }, (_, i) =>
      todoItem({ id: `old-${i}`, title: '复习', notes: 'unrelated'.repeat(1000) }),
    );
    const target = todoItem({
      id: 'new',
      title: '复习',
      notes: '完整保存的备注',
      dueAt: '2026-10-01T00:00:00.000Z',
      calendar: true,
      color: 'sage',
      status: 'completed',
    });
    state.mockReturnValue(todoState({ items }));
    save.mockReturnValue(todoState({ items: [...items, target] }));
    const created = todoTools.save_todo.execute({ title: target.title, notes: target.notes }) as {
      item: TodoItem;
    };
    expect(created.item).toEqual(target);
    expect(created).not.toHaveProperty('items');
    expect(JSON.stringify(created)).not.toContain('unrelated');
    state.mockReturnValue(todoState({ items: [...items, target] }));
    const updated = { ...target, notes: '修改后的完整备注' };
    save.mockReturnValue(todoState({ items: [...items, updated] }));
    expect(
      todoTools.save_todo.execute({ id: target.id, title: target.title, notes: updated.notes }),
    ).toMatchObject({ item: updated, total: 501 });
    remove.mockReturnValue(todoState({ items }));
    const removed = todoTools.remove_todo.execute({ id: target.id });
    expect(removed).toMatchObject({ removedId: target.id, removed: true, total: 500 });
    expect(removed).not.toHaveProperty('items');
    refresh.mockResolvedValue(todoState({ items }));
    const refreshed = await todoTools.refresh_todos.execute({});
    expect(refreshed).toMatchObject({ total: 500, personal: 500, assignments: 0 });
    expect(refreshed).not.toHaveProperty('items');
    expect(JSON.stringify(refreshed)).not.toContain('unrelated');
    const page = todoTools.query_todos.execute({ offset: 499, limit: 2 });
    expect(page).toMatchObject({ items: [items[499], target], nextOffset: null, total: 501 });
  });

  it('maps a missing target id to NOT_FOUND', () => {
    save.mockImplementation(() => {
      throw new Error('待办不存在，Canvas 作业的完成状态只能通过同步更新');
    });
    let caught: unknown;
    try {
      todoTools.save_todo.execute({ id: 'missing', title: 'x' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('remove_todo', () => {
  it('removes a personal todo after the existence precheck', () => {
    remove.mockReturnValue(todoState({ items: [] }));
    const result = todoTools.remove_todo.execute({
      id: '0d7d21f5-8d5a-4f97-9c7f-2f5dfc1a1b2a',
    }) as {
      removedId: string;
    };
    expect(remove).toHaveBeenCalledWith('0d7d21f5-8d5a-4f97-9c7f-2f5dfc1a1b2a');
    expect(result.removedId).toBe('0d7d21f5-8d5a-4f97-9c7f-2f5dfc1a1b2a');
  });

  it('refuses canvas assignments and unknown ids', () => {
    let caught: unknown;
    try {
      todoTools.remove_todo.execute({ id: 'canvas:owner:1:2' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'OPERATION_FAILED' });
    expect(remove).not.toHaveBeenCalled();

    caught = undefined;
    try {
      todoTools.remove_todo.execute({ id: 'nope' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'NOT_FOUND' });
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('refresh_todos', () => {
  it('refreshes the assignment cache and surfaces per-course errors', async () => {
    refresh.mockResolvedValue(todoState({ error: '数据结构：无法连接 Canvas，请检查网络后重试' }));
    const result = (await todoTools.refresh_todos.execute({})) as {
      coverage: { complete: boolean; warnings: string[] };
    };
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.warnings[0]).toContain('数据结构');
  });

  it('reports NOT_CONFIGURED without a canvas connection', async () => {
    state.mockReturnValue(todoState({ connected: false }));
    await expect(todoTools.refresh_todos.execute({})).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});
