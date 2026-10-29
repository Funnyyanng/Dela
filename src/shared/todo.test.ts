import { describe, expect, it } from 'vitest';
import { canvasAssignmentRequirements, canvasTodoStatus, todoCompleted } from './todo';

it('preserves explicit Canvas requirements and leaves missing fields unknown', () => {
  const rubric = [
    { id: 'criterion1', description: '论证', points: 0, ratings: [], custom_field: 'value' },
  ];
  expect(
    canvasAssignmentRequirements({
      submission_types: ['online_upload'],
      allowed_extensions: [],
      allowed_attempts: -1,
      points_possible: 0,
      rubric,
      rubric_settings: { free_form_criterion_comments: true },
      use_rubric_for_grading: false,
      peer_reviews: false,
      locked_for_user: false,
    }),
  ).toEqual({
    submissionTypes: ['online_upload'],
    allowedExtensions: [],
    allowedAttempts: -1,
    pointsPossible: 0,
    gradingType: null,
    rubric,
    rubricSettings: { free_form_criterion_comments: true },
    useRubricForGrading: false,
    peerReviews: false,
    unlockAt: null,
    lockAt: null,
    lockedForUser: false,
  });
  expect(canvasAssignmentRequirements({})).toMatchObject({
    submissionTypes: null,
    allowedExtensions: null,
    rubric: null,
    rubricSettings: null,
  });
});

describe('Canvas 作业完成事实', () => {
  it('缺少提交数据不猜测未完成', () => {
    expect(canvasTodoStatus({})).toBe('unknown');
    expect(todoCompleted('unknown')).toBe(false);
  });
  it('有成绩或零分不等于已提交', () => {
    expect(
      canvasTodoStatus({ submission: { workflow_state: 'graded', score: 0, submitted_at: null } }),
    ).toBe('pending');
  });
  it('已提交、待批阅与已批改分别展示', () => {
    expect(canvasTodoStatus({ submission: { workflow_state: 'submitted' } })).toBe('submitted');
    expect(canvasTodoStatus({ submission: { workflow_state: 'pending_review' } })).toBe(
      'submitted',
    );
    expect(
      canvasTodoStatus({
        submission: { workflow_state: 'graded', submitted_at: '2026-09-21T00:00:00Z' },
      }),
    ).toBe('graded');
  });
  it('教师要求重交时不能继续显示完成', () => {
    const status = canvasTodoStatus({
      submission: { redo_request: true, submitted_at: '2026-09-21T00:00:00Z' },
    });
    expect(status).toBe('resubmit');
    expect(todoCompleted(status)).toBe(false);
  });
  it('豁免与线下作业独立展示', () => {
    expect(canvasTodoStatus({ submission: { excused: true } })).toBe('excused');
    expect(
      canvasTodoStatus({
        submission_types: ['on_paper'],
        submission: { workflow_state: 'unsubmitted' },
      }),
    ).toBe('offline');
  });
});
