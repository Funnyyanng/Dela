import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSession, SessionStats } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { OpenSessionInput } from '../pi';
import { taskStepTool } from '../task-step';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dela-task-step-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fixture(
  options: { answer?: string; stopReason?: string; prompt?: () => Promise<void> } = {},
) {
  const stats = {
    tokens: { input: 1000, output: 300, cacheRead: 9000, cacheWrite: 0, total: 10_300 },
    cost: 0,
  } as SessionStats;
  const child = {
    messages: [
      { role: 'toolResult', content: [{ type: 'text', text: '本章原文'.repeat(10_000) }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: options.answer ?? '已保存本章笔记。重点：隐马尔可夫模型。' },
        ],
        stopReason: options.stopReason ?? 'stop',
      },
    ],
    prompt: vi.fn(options.prompt ?? (() => writeFile(join(root, 'chapter.md'), '# 本章完整笔记'))),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    extensionRunner: { hasHandlers: () => true, emit: vi.fn(async () => {}) },
    getSessionStats: () => stats,
  };
  const input = {
    cwd: root,
    file: '/parent-history.jsonl',
    appendSystemPrompt: ['用户约束：保持详细推导'],
  } as OpenSessionInput;
  const open = vi.fn(async (_input: OpenSessionInput) => child as unknown as AgentSession);
  const record = vi.fn();
  const tool = taskStepTool(input, open, record);
  const run = (signal?: AbortSignal) =>
    tool.execute(
      'step',
      { task: '只整理第2章，课件位于 /course/hmm.pdf', outputPath: 'chapter.md' },
      signal,
      undefined,
      {} as never,
    );
  return { child, open, record, stats, run };
}

it('每步使用不继承父历史的临时会话，保存完整成果，只向父返回短摘要', async () => {
  const { child, open, record, stats, run } = fixture();
  const result = await run();
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ file: undefined, transient: true, cwd: root }),
  );
  expect(open.mock.calls[0]?.[0].appendSystemPrompt).toContain('用户约束：保持详细推导');
  const content = result.content.map((block) => ('text' in block ? block.text : '')).join('');
  expect(JSON.parse(content)).toMatchObject({
    status: 'completed',
    outputPath: join(root, 'chapter.md'),
  });
  expect(content).not.toContain('本章原文');
  expect(await readFile(join(root, 'chapter.md'), 'utf8')).toBe('# 本章完整笔记');
  expect(child.dispose).toHaveBeenCalledOnce();
  expect(child.extensionRunner.emit).toHaveBeenCalledWith({
    type: 'session_shutdown',
    reason: 'quit',
  });
  expect(record).toHaveBeenCalledWith(stats);
});

it('未写出文件时不把口头完成声明当作成功', async () => {
  const { child, run } = fixture({ prompt: async () => {} });
  const result = await run();
  expect(result.isError).toBe(true);
  expect(result.content).toMatchObject([{ text: expect.stringContaining('未保存有效结果文件') }]);
  expect(child.dispose).toHaveBeenCalledOnce();
});

it('已有产物在本步未更新时不把旧文件误判为完成', async () => {
  await writeFile(join(root, 'chapter.md'), '# 上次未完成的旧笔记');
  const { child, run, record } = fixture({ prompt: async () => {} });
  const result = await run();
  expect(result.isError).toBe(true);
  expect(result.content).toMatchObject([{ text: expect.stringContaining('未更新已有结果文件') }]);
  expect(await readFile(join(root, 'chapter.md'), 'utf8')).toBe('# 上次未完成的旧笔记');
  expect(child.dispose).toHaveBeenCalledOnce();
  expect(record).toHaveBeenCalledOnce();
});

it('输出达到长度限制时保留部分文件并明确本步未完成', async () => {
  const { run, record } = fixture({ stopReason: 'length' });
  const result = await run();
  expect(result.isError).toBe(true);
  expect(result.content).toMatchObject([{ text: expect.stringContaining('incomplete') }]);
  expect(await readFile(join(root, 'chapter.md'), 'utf8')).toBe('# 本章完整笔记');
  expect(record).toHaveBeenCalledOnce();
});

it('停止会传播到子任务，释放实例并记录已经消耗的用量', async () => {
  const controller = new AbortController();
  const { child, run, record } = fixture({
    prompt: async () => {
      await writeFile(join(root, 'chapter.md'), '部分笔记');
      controller.abort();
    },
  });
  const result = await run(controller.signal);
  expect(result.isError).toBe(true);
  expect(result.content).toMatchObject([{ text: expect.stringContaining('cancelled') }]);
  expect(child.abort).toHaveBeenCalledOnce();
  expect(child.dispose).toHaveBeenCalledOnce();
  expect(child.extensionRunner.emit).toHaveBeenCalledWith({
    type: 'session_shutdown',
    reason: 'quit',
  });
  expect(record).toHaveBeenCalledOnce();
});

it('已停止的请求不创建新的子任务', async () => {
  const { open, run } = fixture();
  await expect(run(AbortSignal.abort())).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
});

it('模型请求失败时仍清理临时上下文并记录用量', async () => {
  const { child, run, record } = fixture({
    prompt: async () => {
      throw new Error('模型服务暂不可用');
    },
  });
  const result = await run();
  expect(result.isError).toBe(true);
  expect(result.content).toMatchObject([{ text: expect.stringContaining('模型服务暂不可用') }]);
  expect(child.dispose).toHaveBeenCalledOnce();
  expect(record).toHaveBeenCalledOnce();
});

it('子任务回复过长也不会把整份产物重新塞回父上下文', async () => {
  const { run } = fixture({ answer: '详细输出'.repeat(5000) });
  const result = await run();
  const text = result.content[0];
  expect(text?.type).toBe('text');
  if (text?.type !== 'text') throw new Error('missing text');
  const data = JSON.parse(text.text);
  expect(data.summary).toHaveLength(2000);
  expect(data.summaryTruncated).toBe(true);
  expect(data.status).toBe('completed');
});
