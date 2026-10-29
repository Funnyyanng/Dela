// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DelaApi, WorkspaceEntry } from '../../shared/api';
import type { LearningCourse, LearningState, LearningTask } from '../../shared/learning';
import { showToast } from '../app/toasts';
import { startLearning } from '../features/learning/start-learning';
import { useLearningJobs } from '../features/learning/learning-jobs';
import { useWorkspaceStore } from '../workspace/store';
import { FileLearningActions } from './FileLearningActions';
import { ProjectFileTree } from './ProjectFileTree';

vi.mock('../app/toasts', () => ({ showToast: vi.fn() }));
vi.mock('../content/chat/markdown', () => ({
  ChatMarkdown: ({ children }: { children: string }) => children,
}));
vi.mock('../features/learning/start-learning', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/learning/start-learning')>()),
  startLearning: vi.fn(),
}));

const course: LearningCourse = {
  id: 10,
  name: '密码学',
  projectId: 'project',
  directory: '/courses/crypto',
  workingDirectory: '/work/10',
  sources: [
    {
      sourceId: 'assignment:20',
      title: 'EX3',
      kind: 'assignment',
      localPath: '/courses/crypto/作业/EX3/题目.html',
      version: 'v1',
      revision: 'hash',
    },
  ],
};
const task: LearningTask = {
  id: 'task',
  courseId: 10,
  title: 'EX3',
  assignmentSourceId: 'assignment:20',
  dueAt: null,
  status: 'draft',
  requirements: [],
  deliverables: [],
  evidence: [],
  findings: [],
  checks: [],
  updatedAt: '',
  checkedAt: null,
  warnings: [],
};
const state: LearningState = {
  root: '/courses',
  syncedAt: null,
  courses: [course],
  tasks: [task],
  notes: [],
  practice: [],
  warnings: [],
};
const project: WorkspaceEntry = {
  id: 'project',
  parentId: null,
  name: 'courses',
  kind: 'project',
  sourceId: null,
  path: '/courses',
  updatedAt: '',
};
const file: WorkspaceEntry = {
  id: '/courses/crypto/作业/EX3/EX3.pdf',
  parentId: project.id,
  name: 'EX3.pdf',
  kind: 'file',
  sourceId: null,
  path: '/courses/crypto/作业/EX3/EX3.pdf',
  updatedAt: '',
};
const assignment = {
  id: 'canvas:10:20',
  source: 'canvas',
  courseId: 10,
  assignmentId: 20,
  title: 'EX3',
  status: 'pending',
};
let container: HTMLDivElement;
let root: Root;
let getState: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.clearAllMocks();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.mocked(startLearning).mockResolvedValue();
  vi.spyOn(useWorkspaceStore.getState(), 'ensureDirectory').mockResolvedValue();
  getState = vi.fn(async () => state);
  useLearningJobs.setState({ jobs: [] });
  window.dela = {
    learning: { getState },
    todo: { getState: async () => ({ items: [assignment] }) },
  } as unknown as DelaApi;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.dela;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const button = (label: string) =>
  [...container.querySelectorAll('button')].find((item) => item.textContent === label)!;
const renderActions = () =>
  act(async () => root.render(<FileLearningActions entry={file} projectId="project" />));

it('starts the selected assignment directly and keeps notes separate from its task record', async () => {
  await renderActions();
  expect(getState).not.toHaveBeenCalled();
  await act(async () => button('检查答案').click());
  expect(startLearning).toHaveBeenCalledWith(course, 'review', task, {
    paths: [file.path],
    sources: course.sources,
  });
  await act(async () => button('整理笔记').click());
  expect(startLearning).toHaveBeenLastCalledWith(course, 'notes', undefined, {
    paths: [file.path],
    sources: course.sources,
  });
});

it('blocks double clicks before state loads and allows retry after a failed launch', async () => {
  let resolve!: (value: LearningState) => void;
  getState.mockReturnValueOnce(
    new Promise<LearningState>((done) => {
      resolve = done;
    }),
  );
  vi.mocked(startLearning).mockRejectedValueOnce(new Error('模型暂时不可用'));
  await renderActions();
  await act(async () => {
    button('完成作业').click();
    button('完成作业').click();
  });
  expect(getState).toHaveBeenCalledTimes(1);
  expect(button('检查答案').disabled).toBe(true);
  await act(async () => resolve(state));
  expect(showToast).toHaveBeenCalledWith(
    expect.objectContaining({ description: '模型暂时不可用' }),
  );
  expect(button('完成作业').disabled).toBe(false);
  await act(async () => button('完成作业').click());
  expect(startLearning).toHaveBeenCalledTimes(2);
});

it('does not launch into a guessed course when the selected path has no course match', async () => {
  getState.mockResolvedValue({ ...state, courses: [] });
  await renderActions();
  await act(async () => button('整理笔记').click());
  expect(startLearning).not.toHaveBeenCalled();
  expect(showToast).toHaveBeenCalledWith(
    expect.objectContaining({ description: expect.stringContaining('对应的课程') }),
  );
});

it('uses the latest clicked assignment folder even when an earlier document remains open', async () => {
  const folder = {
    ...file,
    id: '/courses/crypto/作业/EX3',
    path: '/courses/crypto/作业/EX3',
    name: 'EX3',
    kind: 'folder' as const,
  };
  const onSelect = vi.fn();
  await act(async () =>
    root.render(
      <ProjectFileTree
        entries={[project, file, folder]}
        rootId={project.id}
        selected={file.id}
        expanded={[]}
        onExpand={() => {}}
        onSelect={onSelect}
        onAction={() => {}}
        query=""
      />,
    ),
  );
  await act(async () =>
    container.querySelector<HTMLElement>('[role="treeitem"][aria-label="EX3"]')!.click(),
  );
  expect(onSelect).toHaveBeenCalledWith(folder.id);
  expect(container.querySelector('[aria-label="所选文件的学习操作"]')?.textContent).toContain(
    '已选：EX3',
  );
  await act(async () => button('完成作业').click());
  expect(startLearning).toHaveBeenCalledWith(course, 'assignment', task, {
    paths: [folder.path],
    sources: course.sources,
    assignment,
  });
});

it('does not offer learning actions for archived, remote, unsupported or project entries', async () => {
  for (const [selected, archived] of [
    [file, true],
    [{ ...file, remoteId: 'remote' }, false],
    [{ ...file, name: 'tool.exe', path: '/courses/tool.exe' }, false],
    [project, false],
  ] as const) {
    await act(async () =>
      root.render(
        <ProjectFileTree
          entries={[project, selected]}
          rootId={project.id}
          selected={selected.id}
          expanded={[]}
          onExpand={() => {}}
          onSelect={() => {}}
          onAction={() => {}}
          query=""
          archived={archived}
        />,
      ),
    );
    expect(container.querySelector('[aria-label="所选文件的学习操作"]')).toBeNull();
  }
});

it('refuses to turn an unrelated local file into a Canvas assignment', async () => {
  getState.mockResolvedValue({ ...state, tasks: [], courses: [{ ...course, sources: [] }] });
  await renderActions();
  await act(async () => button('完成作业').click());
  expect(startLearning).not.toHaveBeenCalled();
  expect(showToast).toHaveBeenCalledWith(
    expect.objectContaining({ description: expect.stringContaining('未对应到具体的 Canvas 作业') }),
  );
});
