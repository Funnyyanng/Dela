import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MockOpenAiServer, mockFrames, type ScriptedResponse } from './mock-openai-server';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));

import { loadPi, openPiSession, type OpenSessionInput } from '../pi';

let server: MockOpenAiServer;
let session: AgentSession;
let cwd: string;
let input: OpenSessionInput;
const raw = 'SYNTHETIC_CHAPTER_RAW_TEXT: 隐马尔可夫模型的状态转移矩阵。';
const artifact = '# 本章笔记\n\n详细的状态转移推导与完整示例。';

beforeEach(async () => {
  state.root ||= await mkdtemp(join(tmpdir(), 'dela-step-runtime-'));
  cwd = await mkdtemp(join(state.root, 'cwd-'));
  await writeFile(join(cwd, 'source.txt'), raw);
  server = await MockOpenAiServer.start();
  input = {
    cwd,
    provider: {
      id: 'test',
      name: 'local mock',
      baseUrl: server.baseUrl,
      apiKey: 'test-only',
      models: ['mock'],
      model: 'mock',
      presetId: null,
    },
    appendSystemPrompt: ['仅使用本测试目录中的合成资料。'],
    customTools: [],
    shellPath: process.env.SHELL ?? 'bash',
    skillPaths: [],
    globalSkillDirs: [],
    disabledSkills: new Set(),
    disabledTools: [],
  };
  session = await openPiSession(input);
});

afterEach(async () => {
  session?.dispose();
  vi.restoreAllMocks();
  await server?.close();
});

afterAll(async () => {
  await rm(state.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function call(name: string, args: object, tokens: number): ScriptedResponse {
  return {
    kind: 'sse',
    frames: [
      mockFrames.toolCallDelta({
        index: 0,
        id: `call-${name}-${tokens}`,
        name,
        arguments: JSON.stringify(args),
      }),
      mockFrames.usageFrame(tokens, tokens / 10),
      mockFrames.finishFrame('tool_calls'),
    ],
  };
}

function reply(text: string, tokens: number): ScriptedResponse {
  return {
    kind: 'sse',
    frames: [
      mockFrames.textDelta(text),
      mockFrames.usageFrame(tokens, tokens / 10),
      mockFrames.finishFrame('stop'),
    ],
  };
}

type RequestBody = {
  messages: { role: string; content: unknown; tool_calls?: unknown[] }[];
  tools: { function: { name: string } }[];
};

it.each([{ isolatedSteps: false }, { disabledTools: ['run_task_step'] }])(
  '隔离步骤选项或能力开关关闭后不向模型提供工具：%j',
  async (options) => {
    session.dispose();
    session = await openPiSession({ ...input, ...options });
    expect(session.getActiveToolNames()).not.toContain('run_task_step');
  },
);

it('真实父会话只接收子步骤摘要，子步骤读写在临时上下文中且用量完整计入', async () => {
  const { AgentSession } = await loadPi();
  const disposed: AgentSession[] = [];
  const dispose = AgentSession.prototype.dispose;
  vi.spyOn(AgentSession.prototype, 'dispose').mockImplementation(function (this: AgentSession) {
    disposed.push(this);
    dispose.call(this);
  });
  server.enqueue(
    call(
      'run_task_step',
      { task: '阅读 source.txt 并保存本章笔记', outputPath: 'chapter.md' },
      100,
    ),
  );
  server.enqueue(call('read', { path: 'source.txt' }, 200));
  server.enqueue(call('write', { path: 'chapter.md', content: artifact }, 300));
  server.enqueue(reply('已保存本章笔记。重点：状态转移与推导。', 400));
  server.enqueue(reply('本章笔记已生成，可继续下一章。', 500));

  await session.prompt('PARENT_ONLY_HISTORY：整理这一章并使用分步处理。');

  const bodies = server.requests.map(({ body }) => body as RequestBody);
  expect(bodies).toHaveLength(5);
  expect(bodies[0]?.tools.map((tool) => tool.function.name)).toContain('run_task_step');
  for (const body of bodies.slice(1, 4)) {
    expect(body.tools.map((tool) => tool.function.name)).not.toContain('run_task_step');
    expect(JSON.stringify(body.messages)).not.toContain('PARENT_ONLY_HISTORY');
  }
  expect(JSON.stringify(bodies[2]?.messages)).toContain(raw);
  expect(JSON.stringify(bodies[4]?.messages)).not.toContain(raw);
  expect(JSON.stringify(bodies[4]?.messages)).not.toContain(artifact);
  expect(JSON.stringify(bodies[4]?.messages)).toContain('已保存本章笔记');
  expect(await readFile(join(cwd, 'chapter.md'), 'utf8')).toBe(artifact);
  expect(disposed).toHaveLength(1);
  expect(disposed[0]?.sessionFile).toBeUndefined();

  expect(session.getSessionStats().tokens).toEqual({
    input: 1500,
    output: 150,
    cacheRead: 0,
    cacheWrite: 0,
    total: 1650,
  });
  const history = await readFile(session.sessionFile!, 'utf8');
  const entries = history
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(entries.filter((entry) => entry.type === 'usage')).toMatchObject([
    { kind: 'task-step', usage: { input: 900, output: 90, totalTokens: 990 } },
  ]);
  expect(history).not.toContain(raw);
  const files = await readdir(join(state.root, 'pi', 'sessions'), { recursive: true });
  expect(files.filter((file) => file.endsWith('.jsonl'))).toHaveLength(1);
});

it('停止父会话会中止正在读取后的子步骤，释放临时会话并保留已使用量', async () => {
  const { AgentSession } = await loadPi();
  const dispose = AgentSession.prototype.dispose;
  const disposed: AgentSession[] = [];
  vi.spyOn(AgentSession.prototype, 'dispose').mockImplementation(function (this: AgentSession) {
    disposed.push(this);
    dispose.call(this);
  });
  const abort = vi.spyOn(AgentSession.prototype, 'abort');
  server.enqueue(
    call(
      'run_task_step',
      { task: '阅读 source.txt 并保存本章笔记', outputPath: 'stopped.md' },
      100,
    ),
  );
  server.enqueue(call('read', { path: 'source.txt' }, 200));
  server.enqueue({
    kind: 'sse',
    frames: [{ ...mockFrames.textDelta('still working'), delayMs: 5000 }],
  });
  const childStarted = new Promise<void>((resolve) => {
    const unsubscribe = server.onRequest(() => {
      if (server.requests.length !== 3) return;
      unsubscribe();
      resolve();
    });
  });
  const run = session.prompt('整理合成资料并使用分步处理。');
  await childStarted;
  await session.abort();
  await run;

  expect(server.requests).toHaveLength(3);
  expect(disposed).toHaveLength(1);
  const child = disposed[0]!;
  expect(child.sessionFile).toBeUndefined();
  expect(abort.mock.contexts).toContain(child);
  expect(child.isStreaming).toBe(false);
  expect(session.getSessionStats().tokens.total).toBe(330);
  expect(JSON.stringify(session.messages)).not.toContain(raw);
  const history = await readFile(session.sessionFile!, 'utf8');
  expect(history).not.toContain(raw);
  expect(history).toContain('task-step');
}, 10_000);

it('临时子会话启动包扩展及MCP，完成后发退出事件并关闭包的子进程', async () => {
  session.dispose();
  const directory = join(cwd, 'package');
  await mkdir(directory);
  const log = join(cwd, 'lifecycle.log');
  const pidPath = join(cwd, 'mcp.pid');
  const serverPath = join(directory, 'server.ts');
  await writeFile(
    serverPath,
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
await import(${JSON.stringify(new URL('./echo-server.ts', import.meta.url).href)});
`,
  );
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name: 'step-lifecycle-fixture',
      type: 'module',
      pi: { extensions: ['./extension.ts'] },
    }),
  );
  await writeFile(
    join(directory, 'extension.ts'),
    `import { appendFileSync } from 'node:fs';
export default function(pi) {
  pi.registerMcpServer('step-echo', {
    command: process.execPath,
    args: [${JSON.stringify(serverPath)}],
    exposure: 'direct',
  });
  pi.on('session_start', (_event, ctx) => {
    appendFileSync(${JSON.stringify(log)}, 'start:' + ctx.mode + '\\n');
    pi.registerTool({
      name: 'started_tool', label: 'started tool', description: 'Registered during startup',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'startup ready' }], details: undefined }),
    });
  });
  pi.on('session_shutdown', (event) => {
    appendFileSync(${JSON.stringify(log)}, 'shutdown:' + event.reason + '\\n');
  });
}
`,
  );
  session = await openPiSession({ ...input, packages: [{ source: directory, themes: [] }] });
  server.enqueue(
    call(
      'run_task_step',
      { task: '调用 started_tool 并写出本章笔记', outputPath: 'package.md' },
      100,
    ),
  );
  server.enqueue(call('started_tool', {}, 200));
  server.enqueue(call('write', { path: 'package.md', content: artifact }, 300));
  server.enqueue(reply('包功能已完成本步。', 400));
  server.enqueue(reply('本章已完成。', 500));

  await session.prompt('使用独立步骤并保留包工具能力。');

  const childRequest = server.requests[1]!.body as RequestBody;
  expect(childRequest.tools.map((tool) => tool.function.name)).toContain('started_tool');
  expect(childRequest.tools.map((tool) => tool.function.name)).toEqual(
    expect.arrayContaining([expect.stringMatching(/^mcp__step_echo.*echo$/)]),
  );
  expect(JSON.stringify((server.requests[2]!.body as RequestBody).messages)).toContain(
    'startup ready',
  );
  expect(await readFile(join(cwd, 'package.md'), 'utf8')).toBe(artifact);
  expect(await readFile(log, 'utf8')).toBe('start:print\nshutdown:quit\n');
  const pid = Number(await readFile(pidPath, 'utf8'));
  await expect
    .poll(
      () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 1000 },
    )
    .toBe(false);
}, 15_000);

it('连续两章各用独立临时上下文，父只持摘要并在本地合并完整Markdown', async () => {
  const { AgentSession } = await loadPi();
  const children: AgentSession[] = [];
  const dispose = AgentSession.prototype.dispose;
  vi.spyOn(AgentSession.prototype, 'dispose').mockImplementation(function (this: AgentSession) {
    children.push(this);
    dispose.call(this);
  });
  const sourceOne = 'CHAPTER_ONE_RAW_ONLY：状态转移概率与初始状态分布。';
  const sourceTwo = 'CHAPTER_TWO_RAW_ONLY：发射概率与前向递推算法。';
  const chapterOne = '# 第一章\n\n状态转移概率：a_ij=P(S_t=j|S_(t-1)=i)。\n每行概率之和为1。\n';
  const chapterTwo =
    '\n# 第二章\n\n前向递推：alpha_t(j)=b_j(o_t) sum_i alpha_(t-1)(i)a_ij。\n初始化与终止条件均保留。\n';
  await writeFile(join(cwd, 'one.txt'), sourceOne);
  await writeFile(join(cwd, 'two.txt'), sourceTwo);
  const before: string[] = await readdir(join(state.root, 'pi', 'sessions'), {
    recursive: true,
  }).catch(() => []);

  server.enqueue(
    call('run_task_step', { task: '只阅读one.txt，写出第一章完整推导', outputPath: 'one.md' }, 100),
  );
  server.enqueue(call('read', { path: 'one.txt' }, 200));
  server.enqueue(call('write', { path: 'one.md', content: chapterOne }, 300));
  server.enqueue(reply('第一章已保存。重点：初始分布、转移矩阵及行归一化。', 400));
  server.enqueue(
    call('run_task_step', { task: '只阅读two.txt，写出第二章完整推导', outputPath: 'two.md' }, 500),
  );
  server.enqueue(call('read', { path: 'two.txt' }, 600));
  server.enqueue(call('write', { path: 'two.md', content: chapterTwo }, 700));
  server.enqueue(reply('第二章已保存。重点：发射概率、前向递推与边界条件。', 800));
  server.enqueue(call('bash', { command: 'cat one.md two.md > final.md' }, 900));
  server.enqueue(reply('两章完整笔记已经合并保存到final.md。', 1000));

  await session.prompt('依次整理两章，保留完整推导，最后只交付一个合并的Markdown文件。');

  expect(await readFile(join(cwd, 'one.md'), 'utf8')).toBe(chapterOne);
  expect(await readFile(join(cwd, 'two.md'), 'utf8')).toBe(chapterTwo);
  expect(await readFile(join(cwd, 'final.md'), 'utf8')).toBe(chapterOne + chapterTwo);
  expect(children).toHaveLength(2);
  expect(children[0]?.sessionId).not.toBe(children[1]?.sessionId);
  expect(children.every((child) => child.sessionFile === undefined)).toBe(true);

  const requests = server.requests.map(({ body }) => body as RequestBody);
  expect(requests).toHaveLength(10);
  const first = JSON.stringify(requests.slice(1, 4));
  const second = JSON.stringify(requests.slice(5, 8));
  expect(first).toContain(sourceOne);
  expect(first).not.toContain(sourceTwo);
  expect(second).toContain(sourceTwo);
  expect(second).not.toContain(sourceOne);
  const parent = JSON.stringify([requests[0], requests[4], requests[8], requests[9]]);
  for (const text of [sourceOne, sourceTwo, 'a_ij=P(S_t=j|S_(t-1)=i)', 'alpha_t(j)=b_j(o_t)'])
    expect(parent).not.toContain(text);
  expect(parent).toContain('第一章已保存');
  expect(parent).toContain('第二章已保存');
  expect(session.getSessionStats().tokens).toEqual({
    input: 5500,
    output: 550,
    cacheRead: 0,
    cacheWrite: 0,
    total: 6050,
  });
  const after = await readdir(join(state.root, 'pi', 'sessions'), { recursive: true });
  expect(after.filter((file) => file.endsWith('.jsonl') && !before.includes(file))).toHaveLength(1);
}, 15_000);

it('真实SDK在最后一条回复跨过预算时保留成果但返回未完成', async () => {
  server.enqueue(
    call(
      'run_task_step',
      {
        task: '写出本章笔记并简要返回',
        outputPath: 'budget.md',
        maxTokens: 1000,
      },
      100,
    ),
  );
  server.enqueue(call('write', { path: 'budget.md', content: artifact }, 500));
  server.enqueue(reply('本章已保存', 600));
  server.enqueue(reply('达到预算，已保存进度', 700));
  await session.prompt('在明确预算内分步处理');
  expect(await readFile(join(cwd, 'budget.md'), 'utf8')).toBe(artifact);
  const result = session.messages.find(
    (message) => message.role === 'toolResult' && message.toolName === 'run_task_step',
  );
  expect(result).toMatchObject({ isError: true });
  expect(JSON.stringify(result)).toContain('budgetExceeded');
  expect(JSON.stringify(result)).toContain('incomplete');
});

it('真实SDK在当前回复已耗尽token预算时不再执行其中的写文件工具', async () => {
  server.enqueue(
    call(
      'run_task_step',
      {
        task: '只处理本章',
        outputPath: 'over-budget.md',
        maxTokens: 1000,
      },
      100,
    ),
  );
  server.enqueue(call('write', { path: 'over-budget.md', content: '不应写入' }, 1200));
  server.enqueue(reply('本步停止，后续请缩小范围', 300));
  await session.prompt('运行单章任务');
  await expect(stat(join(cwd, 'over-budget.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.stringify(session.messages)).toContain('budgetExceeded');
});

it('真实SDK的工具预算阻止后续工具覆盖已保存的进度', async () => {
  server.enqueue(
    call(
      'run_task_step',
      {
        task: '保存进度后停止重复查找',
        outputPath: 'progress.md',
        maxToolCalls: 1,
      },
      100,
    ),
  );
  server.enqueue(call('write', { path: 'progress.md', content: '第一步已保存' }, 200));
  server.enqueue(call('write', { path: 'progress.md', content: '超额覆盖' }, 300));
  server.enqueue(reply('本步预算结束', 400));
  await session.prompt('限定工具预算');
  expect(await readFile(join(cwd, 'progress.md'), 'utf8')).toBe('第一步已保存');
  expect(JSON.stringify(session.messages)).toContain('工具调用预算');
});
