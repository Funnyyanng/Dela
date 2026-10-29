// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LearningCourse, LearningState } from '../../../shared/learning';
import { LearningView } from './LearningView';
import { learningPrompt } from './learning-prompt';
import { PracticeReview } from './PracticeReview';

const { openChat, openProject, openDocument, putChat, refresh, toast } = vi.hoisted(() => ({
  openChat: vi.fn(() => true),
  openProject: vi.fn(() => true),
  openDocument: vi.fn(() => true),
  putChat: vi.fn(),
  refresh: vi.fn(async () => {}),
  toast: vi.fn(),
}));
vi.mock('../../navigation/view', () => ({
  useNavigationStore: { getState: () => ({ openChat, openProject, openDocument }) },
}));
vi.mock('../../sessions/store', () => ({
  useSessions: { getState: () => ({ putChat, refresh }) },
}));
vi.mock('../../app/toasts', () => ({ showToast: toast }));

const courses: LearningCourse[] = [
  {
    id: 1,
    name: '随机过程',
    projectId: 'project-one',
    directory: '/semester/随机过程',
    workingDirectory: '/internal/work/1',
    sources: [
      {
        sourceId: 'source-one',
        title: '第一讲',
        kind: 'file',
        version: 'v1',
        revision: 'hash1',
        localPath: '/semester/随机过程/课件/第一讲.pdf',
      },
    ],
  },
  {
    id: 2,
    name: '数理统计',
    projectId: 'project-two',
    directory: '/semester/数理统计',
    workingDirectory: '/internal/work/2',
    sources: [],
  },
];
const state: LearningState = {
  root: '/semester',
  syncedAt: null,
  courses,
  tasks: [],
  notes: [],
  warnings: [],
  practice: [
    {
      id: 'card-one',
      courseId: 1,
      prompt: '独立事件的定义是什么？',
      answer: '参考解答：交集概率等于概率的乘积。',
      sourceIds: ['source-one'],
      dueAt: '2026-01-01T00:00:00.000Z',
      intervalDays: 1,
      successfulAttempts: 0,
      attempts: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
};
let root: Root;
let host: HTMLDivElement;
const createSession = vi.fn();
const ask = vi.fn();
const submit = vi.fn();
const getState = vi.fn();

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  createSession.mockResolvedValue({
    sessionId: 'session-one',
    configured: true,
    projectId: 'project-two',
    messages: [],
  });
  ask.mockResolvedValue({
    sessionId: 'session-one',
    configured: true,
    projectId: 'project-two',
    messages: [],
  });
  getState.mockResolvedValue(state);
  submit.mockResolvedValue({ ...state, practice: [] });
  window.dela = {
    learning: { getState, submitPracticeAttempt: submit },
    session: { create: createSession, ask },
  } as unknown as typeof window.dela;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete window.dela;
  vi.unstubAllGlobals();
});

function button(label: string) {
  const buttons = [...host.querySelectorAll('button')];
  const value =
    buttons.find((item) => item.textContent === label) ??
    buttons.find((item) => item.textContent?.includes(label));
  if (!value) throw new Error(`没有按钮：${label}`);
  return value;
}

async function write(selector: string, value: string) {
  await act(async () => {
    const field = host.querySelector<HTMLTextAreaElement>(selector)!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      field,
      value,
    );
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('keeps answers hidden until the user writes an attempt, then saves the actual response and error cause', async () => {
  await act(async () => root.render(<LearningView />));
  expect(ask).not.toHaveBeenCalled();
  await act(async () => button('练习').click());
  expect(host.textContent).not.toContain('交集概率等于');
  expect(button('查看参考答案').disabled).toBe(true);
  await write('textarea', '我把独立和互斥混淆了');
  await act(async () => button('查看参考答案').click());
  expect(host.textContent).toContain('交集概率等于');
  expect(host.querySelector('textarea')!.disabled).toBe(true);
  await act(async () => button('还需再练').click());
  expect(button('记录作答').disabled).toBe(true);
  await write('[id="cause-card-one"]', '没有区分交集为零和概率乘积');
  await act(async () => button('记录作答').click());
  expect(submit).toHaveBeenCalledWith({
    cardId: 'card-one',
    expectedUpdatedAt: state.practice[0]!.updatedAt,
    response: '我把独立和互斥混淆了',
    outcome: 'again',
    errorCause: '没有区分交集为零和概率乘积',
  });
  expect(host.textContent).toContain('还没有练习题');
});

it('retains the attempted answer and selected result when saving fails', async () => {
  const save = vi.fn().mockRejectedValue(new Error('记录未保存，请重试'));
  await act(async () => root.render(<PracticeReview card={state.practice[0]!} onSubmit={save} />));
  await write('textarea', 'P(A∩B)=P(A)P(B)');
  await act(async () => button('查看参考答案').click());
  await act(async () => button('独立完成').click());
  await act(async () => button('记录作答').click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('记录未保存');
  expect(host.querySelector('textarea')!.value).toBe('P(A∩B)=P(A)P(B)');
  expect(button('独立完成').getAttribute('aria-pressed')).toBe('true');
  expect(button('记录作答').disabled).toBe(false);
});

it('resets the attempt and hides the answer when the same card changes', async () => {
  const save = vi.fn();
  const card = state.practice[0]!;
  await act(async () => root.render(<PracticeReview card={card} onSubmit={save} />));
  await write('textarea', '对旧题的回答');
  await act(async () => button('查看参考答案').click());
  await act(async () => button('独立完成').click());
  await act(async () =>
    root.render(
      <PracticeReview
        card={{ ...card, prompt: '互斥事件的定义是什么？', answer: '新答案：交集为空。' }}
        onSubmit={save}
      />,
    ),
  );
  expect(host.textContent).toContain('互斥事件的定义');
  expect(host.textContent).not.toContain('新答案');
  expect(host.querySelector('textarea')!.value).toBe('');
  expect(host.querySelector('textarea')!.disabled).toBe(false);
  expect(button('查看参考答案').disabled).toBe(true);
  expect(save).not.toHaveBeenCalled();
});

it('keeps global sync warnings collapsed while course actions remain available', async () => {
  const warnings = Array.from({ length: 20 }, (_, index) => `其他课程同步提示 ${index + 1}`);
  getState.mockResolvedValue({ ...state, warnings });
  await act(async () => root.render(<LearningView />));
  const details = host.querySelector('details')!;
  expect(details.open).toBe(false);
  expect(details.querySelector('summary')!.textContent).toContain('上次资料同步有 20 项提示');
  expect(details.textContent).toContain(warnings[19]);
  for (const label of ['完成作业', '整理笔记', '带我学习']) {
    expect(button(label).disabled).toBe(false);
    expect(button(label).closest('details')).toBeNull();
  }
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  expect(details.open).toBe(true);
  expect(details.textContent).toContain(warnings[0]);
});

it('starts only the selected course workflow after an explicit action', async () => {
  await act(async () => root.render(<LearningView />));
  await act(async () => {
    const picker = host.querySelector('select')!;
    picker.value = '2';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(createSession).not.toHaveBeenCalled();
  await act(async () => button('整理笔记').click());
  expect(createSession).toHaveBeenCalledWith('project-two', 'library');
  expect(openChat).toHaveBeenCalledWith('session-one', 'project-two');
  const input = ask.mock.calls[0]![1];
  expect(input.text).toContain('/skill:learning-workflow');
  expect(input.text).toContain('数理统计（Canvas course_id=2）');
  expect(input.text).toContain('/semester/数理统计');
  expect(input.text).not.toContain('随机过程');
  expect(input.attachments).toEqual([]);
});

it('remembers the last course without starting a workflow automatically', async () => {
  localStorage.setItem('learning:last-course', '2');
  await act(async () => root.render(<LearningView />));
  expect(host.querySelector('select')!.value).toBe('2');
  expect(createSession).not.toHaveBeenCalled();
  expect(ask).not.toHaveBeenCalled();
});

it('shows a readable failure without sending when course chat creation fails', async () => {
  createSession.mockRejectedValue(new Error('项目目录不存在'));
  await act(async () => root.render(<LearningView />));
  await act(async () => button('完成作业').click());
  expect(ask).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('项目目录不存在');
  expect(button('完成作业').disabled).toBe(false);
});

it('shows stale note warnings and opens the canonical note through the existing file navigation', async () => {
  getState.mockResolvedValue({
    ...state,
    notes: [
      {
        id: 'note-one',
        courseId: 1,
        title: '第一章笔记',
        path: '/semester/随机过程/笔记.md',
        revision: 'abc',
        coveredSources: [{ sourceId: 'source-one', version: 'v1' }],
        updatedAt: '2026-10-29T00:00:00.000Z',
        warnings: ['来源已更新，请重新核对笔记'],
      },
    ],
  });
  await act(async () => root.render(<LearningView />));
  await act(async () => button('笔记').click());
  expect(host.textContent).toContain('来源已更新，请重新核对笔记');
  await act(async () => button('打开笔记').click());
  expect(openProject).toHaveBeenCalledWith('project-one');
  expect(openDocument).toHaveBeenCalledWith('/semester/随机过程/笔记.md', { keep: true });
});

it('builds an assignment request with original requirements and evidence checks', () => {
  const prompt = learningPrompt(courses[0]!, 'assignment');
  expect(prompt).toContain('原始作业说明');
  expect(prompt).toContain('检查证据');
  expect(prompt).toContain('query_learning_sources');
  expect(prompt).toContain('不要提交到 Canvas');
});

it('surfaces newly added lecture material separately from already covered notes', async () => {
  getState.mockResolvedValue({
    ...state,
    courses: [
      {
        ...courses[0]!,
        sources: [
          ...courses[0]!.sources,
          {
            ...courses[0]!.sources[0]!,
            sourceId: 'chapter-five',
            title: '第五章',
            localPath: '/semester/随机过程/课件/第五章.pdf',
          },
        ],
      },
    ],
    notes: [
      {
        id: 'note-one',
        courseId: 1,
        title: '已有笔记',
        path: '/semester/随机过程/学习笔记/笔记.md',
        revision: 'abc',
        coveredSources: [{ sourceId: 'source-one', version: 'v1' }],
        updatedAt: '2026-10-29T00:00:00.000Z',
        warnings: [],
      },
    ],
  });
  await act(async () => root.render(<LearningView />));
  await act(async () => button('笔记').click());
  expect(host.textContent).toContain('尚未纳入笔记的资料 · 1 份');
  expect(host.textContent).toContain('第五章');
  expect(host.textContent).not.toContain('第一讲');
  expect(host.textContent).not.toContain('来源有变化');
  const pending = host.querySelector(
    'section[aria-label="课程笔记"] details',
  ) as HTMLDetailsElement;
  expect(pending.open).toBe(false);
  await act(async () => {
    pending.open = true;
    pending.dispatchEvent(new Event('toggle'));
  });
  await act(async () => button('第五章').click());
  expect(openDocument).toHaveBeenCalledWith('/semester/随机过程/课件/第五章.pdf', { keep: true });
});
