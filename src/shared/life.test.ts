import { expect, it } from 'vitest';
import { recurrenceMatches, shanghaiDate, weeklyLifeReview, todoOccurrences } from './life';
import { rankTodos } from './todo';
it('expands weekly weekdays and monthly short months with end boundary', () => {
  expect(
    recurrenceMatches(
      { frequency: 'weekly', startDate: '2026-10-01', weekdays: [5] },
      '2026-10-30',
    ),
  ).toBe(true);
  expect(
    recurrenceMatches(
      { frequency: 'weekly', startDate: '2026-10-01', weekdays: [5] },
      '2026-10-31',
    ),
  ).toBe(false);
  expect(
    recurrenceMatches(
      { frequency: 'monthly', startDate: '2026-01-31', monthDay: 31 },
      '2026-02-28',
    ),
  ).toBe(true);
  expect(
    recurrenceMatches(
      { frequency: 'daily', startDate: '2026-01-01', endDate: '2026-01-02' },
      '2026-01-03',
    ),
  ).toBe(false);
});
it('uses Shanghai dates and ranks pins before overdue without scheduling time', () => {
  expect(shanghaiDate('2026-10-29T17:00:00Z')).toBe('2026-10-30');
  const base = {
    source: 'personal' as const,
    title: '事项',
    notes: '',
    createdAt: '2026-10-01T00:00:00Z',
    readAt: null,
    status: 'pending' as const,
    dueAt: null,
  };
  const ranked = rankTodos(
    [
      { ...base, id: 'overdue', dueAt: '2026-10-28T00:00:00Z' },
      { ...base, id: 'pin', pinned: true },
      { ...base, id: 'done', status: 'completed' },
    ],
    new Date('2026-10-30T00:00:00Z'),
  );
  expect(ranked.map((row) => row.item.id)).toEqual(['pin', 'overdue']);
  expect(ranked[0]?.reason).toBe('已置顶');
  expect(ranked[0]?.item.dueAt).toBeNull();
});

it('weekly averages exclude missing days and combine actual sleep segments', () => {
  const review = weeklyLifeReview(
    {
      startDate: '2026-10-24',
      endDate: '2026-10-30',
      habits: [],
      habitLogs: [],
      occurrences: [],
      sleepLogs: [
        { id: 'a', startAt: '2026-10-28T15:00:00Z', endAt: '2026-10-28T23:00:00Z', note: '' },
        { id: 'b', startAt: '2026-10-29T16:00:00Z', endAt: '2026-10-29T22:00:00Z', note: '' },
      ],
    },
    '2026-10-30',
  );
  expect(review.sleep).toEqual({ recordedDays: 2, unknownDays: 5, averageHours: 7 });
});
it('finds a moved occurrence by its new date while retaining its original identity', () => {
  const todo = {
    id: 'x',
    source: 'personal' as const,
    title: '阅读',
    notes: '',
    status: 'pending' as const,
    dueAt: null,
    createdAt: 'now',
    readAt: null,
    recurrence: { frequency: 'daily' as const, startDate: '2026-10-01' },
  };
  const result = todoOccurrences([todo], '2026-11-01', '2026-11-01', [
    { todoId: 'x', date: '2026-10-30', dueAt: '2026-11-01T13:00:00Z' },
  ]);
  expect(
    result.some((item) => item.id === 'x:2026-10-30' && item.dueAt === '2026-11-01T13:00:00Z'),
  ).toBe(true);
});

it('honors explicit manual ordering while keeping pins first', () => {
  const base = {
    title: '待办',
    source: 'personal' as const,
    status: 'pending' as const,
    notes: '',
    dueAt: null,
    createdAt: 'now',
    readAt: null,
  };
  expect(
    rankTodos(
      [
        { ...base, id: 'overdue', dueAt: '2026-10-01T00:00:00Z' },
        { ...base, id: 'manual', order: -1 },
        { ...base, id: 'pin', pinned: true },
      ],
      new Date('2026-10-30'),
    ).map(({ item }) => item.id),
  ).toEqual(['pin', 'manual', 'overdue']);
});
