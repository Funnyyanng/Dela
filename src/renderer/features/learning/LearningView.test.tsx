// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  LearningCourse,
  LearningSource,
  LearningState,
  LearningTask,
} from '../../../shared/learning';
import { LearningView } from './LearningView';
import { learningPrompt } from './learning-prompt';
import { PracticeReview } from './PracticeReview';
import { useLearningJobs } from './learning-jobs';

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
vi.mock('./CanvasAssignments', () => ({
  CanvasAssignments: ({ state, reload }: { state: LearningState | null; reload: number }) => (
    <section aria-label="选择作业" data-reload={reload} data-task-count={state?.tasks.length ?? 0}>
      所有课程的 Canvas 未提交作业
    </section>
  ),
}));
vi.mock('./LearningJobProgress', () => ({ LearningJobProgress: () => null }));

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
const enqueue = vi.fn();
const ask = vi.fn();
const submit = vi.fn();
const getState = vi.fn();

beforeEach(() => {
  useLearningJobs.setState({ jobs: [] });
  localStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  enqueue.mockResolvedValue({ id: 'accepted-job' });
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
    jobs: {
      enqueue,
      getState: async () => ({ jobs: useLearningJobs.getState().jobs }),
      onUpdate: () => () => {},
    },
    session: { create: createSession, ask, onRunEvent: () => () => {} },
  } as unknown as typeof window.dela;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

it.each(['completed', 'failed', 'stopped'] as const)(
  'refreshes saved learning records after a job is %s without refreshing Canvas',
  async (status) => {
    useLearningJobs.getState().add({
      id: 'background-job',
      domain: 'learning',
      stage: '正在处理',
      question: null,
      usage: null,
      sourceVersions: [],
      createdAt: 1,
      updatedAt: 1,
      order: 1,
      awaitingResume: false,
      projectId: 'project-one',
      courseId: 1,
      courseName: '随机过程',
      title: '作业1',
      action: 'assignment',
      status: 'running',
      sessionId: 'session-one',
      error: null,
      result: '',
      files: [],
      startedAt: 1,
      finishedAt: null,
    });
    await act(async () => root.render(<LearningView />));
    expect(getState).toHaveBeenCalledTimes(1);
    await act(async () =>
      useLearningJobs.getState().update('background-job', { result: '正在复核' }),
    );
    expect(getState).toHaveBeenCalledTimes(1);
    const task: LearningTask = {
      id: 'new-task',
      courseId: 1,
      title: '刚保存的作业成果',
      assignmentSourceId: 'assignment:1',
      dueAt: null,
      status: 'draft',
      requirements: [],
      deliverables: [],
      evidence: [],
      findings: [],
      checks: [],
      updatedAt: '2026-10-29T00:00:00Z',
      checkedAt: null,
      warnings: [],
    };
    getState.mockResolvedValue({ ...state, tasks: [task] });
    await act(async () =>
      useLearningJobs.getState().update('background-job', { status, finishedAt: 2 }),
    );
    expect(getState).toHaveBeenCalledTimes(2);
    expect(host.querySelector('section[aria-label="本地作业记录"]')?.textContent).toContain(
      '刚保存的作业成果',
    );
    const assignmentPicker = host.querySelector('section[aria-label="选择作业"]')!;
    expect(assignmentPicker.getAttribute('data-task-count')).toBe('1');
    expect(assignmentPicker.getAttribute('data-reload')).toBe('0');
  },
);

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

it('keeps past cross-course sync events neutral and collapsed while course actions remain available', async () => {
  const unavailable = Array.from({ length: 18 }, (_, index) => `其他课程未开放项目 ${index + 1}`);
  getState.mockResolvedValue({
    ...state,
    syncHistory: {
      syncedAt: '2026-10-28T08:52:00.000Z',
      unavailable,
      conflicts: ['其他课程上次同步有版本冲突'],
      failed: ['其他课程上次请求超时'],
    },
  });
  await act(async () => root.render(<LearningView />));
  const details = host.querySelector('details')!;
  expect(details.open).toBe(false);
  expect(details.querySelector('summary')!.textContent).toContain('上次同步记录');
  expect(details.querySelector('summary')!.textContent).toContain('10/28');
  expect(details.querySelector('summary')!.textContent).toContain('20 项');
  expect(details.className).not.toContain('orange');
  expect(details.textContent).toContain('不代表当前课程缺少这些资料');
  expect(details.textContent).toContain('当时无法获取 · 18 项');
  expect(details.textContent).toContain('版本冲突 · 1 项');
  expect(details.textContent).toContain('其他失败 · 1 项');
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.textContent).not.toContain('本课程有');
  for (const label of ['完成作业', '整理笔记', '带我学习']) {
    expect(button(label).disabled).toBe(false);
    expect(button(label).closest('details')).toBeNull();
  }
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  expect(details.open).toBe(true);
  expect(details.textContent).toContain(unavailable[0]);
});

it('shows current general problems separately from sync history', async () => {
  getState.mockResolvedValue({ ...state, warnings: ['本地课程目录无法读取'] });
  await act(async () => root.render(<LearningView />));
  const details = host.querySelector('details')!;
  expect(details.open).toBe(false);
  expect(details.querySelector('summary')!.textContent).toBe('学习资料有 1 项提示');
  expect(details.querySelector('[role="status"]')!.textContent).toContain('本地课程目录无法读取');
  expect(host.textContent).not.toContain('上次同步记录');
});

it('lists Canvas, WeChat and local references without treating provenance notices as warnings', async () => {
  const sources = [
    {
      ...courses[0]!.sources[0]!,
      provenance: '已与 Canvas 下载记录匹配',
      notice: '本地文件与下载版本一致',
    },
    {
      ...courses[0]!.sources[0]!,
      sourceId: 'wechat-one',
      title: '老师补充材料.pdf',
      localPath: '/semester/随机过程/课件/老师补充材料.pdf',
      origin: 'wechat' as const,
      provenance: '文件下载来源为微信',
      notice: '保留本地参考资料，不参与 Canvas 版本同步',
    },
    {
      ...courses[0]!.sources[0]!,
      sourceId: 'local-one',
      title: '参考教材.pdf',
      localPath: '/semester/随机过程/课件/参考教材.pdf',
      origin: 'local' as const,
      provenance: '本地课件目录中的参考资料',
    },
  ];
  getState.mockResolvedValue({ ...state, courses: [{ ...courses[0]!, sources }] });
  await act(async () => root.render(<LearningView />));
  const details = host.querySelector('details')!;
  expect(details.open).toBe(false);
  expect(details.querySelector('summary')!.textContent).toBe(
    '资料来源 · Canvas 1 / 微信 1 / 本地参考 1',
  );
  expect(details.className).not.toContain('orange');
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.textContent).not.toContain('待核对');
  expect(host.textContent).not.toContain('需要处理');
  expect(details.textContent).toContain('学习笔记与作业成果独立管理');
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  expect(details.textContent).toContain('文件下载来源为微信');
  expect(details.textContent).toContain('本地文件与下载版本一致');
  await act(async () => button('老师补充材料.pdf').click());
  expect(openDocument).toHaveBeenCalledWith('/semester/随机过程/课件/老师补充材料.pdf', {
    keep: true,
  });
  await act(async () => button('参考教材.pdf').click());
  expect(openDocument).toHaveBeenCalledWith('/semester/随机过程/课件/参考教材.pdf', { keep: true });
});

it('counts only actual file problems in the course warning summary', async () => {
  getState.mockResolvedValue({
    ...state,
    courses: [
      {
        ...courses[0]!,
        sources: [
          { ...courses[0]!.sources[0]!, notice: '已核对，与 Canvas 下载版本一致' },
          {
            ...courses[0]!.sources[0]!,
            sourceId: 'missing-one',
            title: '第二讲',
            warning: '本地文件缺失',
          },
        ],
      },
    ],
  });
  await act(async () => root.render(<LearningView />));
  const details = host.querySelector('details')!;
  expect(details.open).toBe(false);
  expect(details.querySelector('summary')!.textContent).toBe('本课程有 1 份资料需要处理');
  expect(details.querySelector('[role="status"]')!.textContent).toBe('第二讲：本地文件缺失');
  expect(details.textContent).not.toContain('已核对');
});

it('starts only the selected course workflow after an explicit action', async () => {
  await act(async () => root.render(<LearningView />));
  await act(async () => {
    const picker = host.querySelector('select')!;
    picker.value = '2';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(createSession).not.toHaveBeenCalled();
  await act(async () => button('带我学习').click());
  expect(openChat).not.toHaveBeenCalled();
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      domain: 'learning',
      projectId: 'project-two',
      courseId: 2,
      action: 'study',
      title: '数理统计',
    }),
  );
});

it('remembers the last course without starting a workflow automatically', async () => {
  localStorage.setItem('learning:last-course', '2');
  await act(async () => root.render(<LearningView />));
  expect(host.querySelector('select')!.value).toBe('2');
  expect(createSession).not.toHaveBeenCalled();
  expect(ask).not.toHaveBeenCalled();
});

it('shows a readable failure without sending when course chat creation fails', async () => {
  enqueue.mockRejectedValueOnce(new Error('项目目录不存在'));
  await act(async () => root.render(<LearningView />));
  await act(async () => button('带我学习').click());
  expect(ask).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('项目目录不存在');
  expect(button('带我学习').disabled).toBe(false);
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
  expect(host.querySelector('section[aria-label="课程笔记"] details')!.textContent).not.toContain(
    '第一讲',
  );
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

const assignment: LearningSource = {
  sourceId: 'assignment:433923',
  title: 'EX3. 分组加密算法',
  kind: 'assignment',
  version: 'assignment-version-1',
  revision: 'assignment-hash',
  localPath: '/semester/随机过程/作业/EX3/Canvas作业说明.html',
};

it('opens the global Canvas assignment picker without starting a course-wide task', async () => {
  await act(async () => root.render(<LearningView />));
  await act(async () => button('笔记').click());
  await act(async () => button('完成作业').click());
  expect(createSession).not.toHaveBeenCalled();
  expect(host.querySelector('section[aria-label="选择作业"]')!.textContent).toContain(
    '所有课程的 Canvas 未提交作业',
  );
});

it('starts notes with exactly the selected materials and their source versions', async () => {
  const second = {
    ...courses[0]!.sources[0]!,
    sourceId: 'source-two',
    title: '第二讲',
    version: 'v2',
    localPath: '/semester/随机过程/课件/第二讲.pdf',
  };
  const unselected = { ...second, sourceId: 'source-three', title: '第三讲' };
  getState.mockResolvedValue({
    ...state,
    courses: [
      {
        ...courses[0]!,
        sources: [
          ...courses[0]!.sources,
          second,
          unselected,
          assignment,
          { ...assignment, kind: 'quiz', sourceId: 'quiz:1:1', title: '随堂测验' },
        ],
      },
    ],
  });
  await act(async () => root.render(<LearningView />));
  await act(async () => button('整理笔记').click());
  expect(createSession).not.toHaveBeenCalled();
  expect(button('整理所选笔记').disabled).toBe(true);
  const picker = host.querySelector('section[aria-label="选择笔记资料"]')!;
  expect(picker.textContent).not.toContain(assignment.title);
  expect(picker.textContent).not.toContain('随堂测验');
  await act(async () =>
    host.querySelector<HTMLInputElement>('[aria-label="选择资料：第一讲"]')!.click(),
  );
  await act(async () =>
    host.querySelector<HTMLInputElement>('[aria-label="选择资料：第二讲"]')!.click(),
  );
  expect(host.textContent).toContain('已选 2 份资料');
  await act(async () => button('整理所选笔记').click());
  const input = enqueue.mock.calls[0]![0];
  expect(input).toMatchObject({
    courseId: 1,
    action: 'notes',
    sourceIds: ['source-one', second.sourceId],
  });
  expect(input.sourceIds).not.toContain(unselected.sourceId);
  expect(input.sourceIds).not.toContain(assignment.sourceId);
});

it('clears material selection when changing courses, including when switching back', async () => {
  const secondCourse = {
    ...courses[1]!,
    sources: [
      {
        ...courses[0]!.sources[0]!,
        sourceId: 'statistics-one',
        title: '统计课件',
        localPath: '/semester/数理统计/课件.pdf',
      },
    ],
  };
  getState.mockResolvedValue({ ...state, courses: [courses[0]!, secondCourse] });
  await act(async () => root.render(<LearningView />));
  await act(async () => button('整理笔记').click());
  await act(async () =>
    host.querySelector<HTMLInputElement>('[aria-label="选择资料：第一讲"]')!.click(),
  );
  expect(button('整理所选笔记').disabled).toBe(false);
  await act(async () => {
    const picker = host.querySelector('select')!;
    picker.value = '2';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(host.textContent).toContain('已选 0 份资料');
  expect(button('整理所选笔记').disabled).toBe(true);
  expect(host.querySelector('section[aria-label="选择笔记资料"]')!.textContent).not.toContain(
    '第一讲',
  );
  await act(async () => {
    const picker = host.querySelector('select')!;
    picker.value = '1';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(host.querySelector<HTMLInputElement>('[aria-label="选择资料：第一讲"]')!.checked).toBe(
    false,
  );
  expect(ask).not.toHaveBeenCalled();
});
