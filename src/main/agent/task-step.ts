import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentSession, SessionStats, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import type { OpenSessionInput } from './pi';
import { shutdownSession } from './session-lifecycle';

const stepInput = z.object({
  task: z.string().trim().min(1).max(12_000),
  outputPath: z.string().trim().min(1).max(4000),
});

export function taskStepTool(
  input: OpenSessionInput,
  open: (input: OpenSessionInput) => Promise<AgentSession>,
  recordUsage: (stats: SessionStats) => void,
): ToolDefinition {
  return {
    name: 'run_task_step',
    label: '分步处理',
    description:
      '在独立临时上下文中完成一个明确范围的本机子任务，将详细结果写入 outputPath，只返回简短摘要与文件位置，然后释放该步原文。适合逐章笔记、分份资料处理；简单问答直接处理。task 必须明确资料路径、章节/页码范围、目标与约束，不要粘贴大段原文。子任务不能再分派子任务。',
    parameters: z.toJSONSchema(stepInput) as ToolDefinition['parameters'],
    executionMode: 'sequential',
    async execute(_id, params, signal, onUpdate) {
      const { task, outputPath } = stepInput.parse(params);
      const path = resolve(input.cwd, outputPath);
      signal?.throwIfAborted();
      const previous = await stat(path, { bigint: true }).catch(() => null);
      signal?.throwIfAborted();
      const child = await open({
        ...input,
        file: undefined,
        transient: true,
        appendSystemPrompt: [
          ...input.appendSystemPrompt,
          '你负责一个有明确范围的独立步骤，不继承主会话历史。只处理分配的资料范围，不主动扩展到其他章节或无关文件。详细结果必须先写入指定文件，再返回不超过500字的重点、完成范围及待核对事项。不要在最后回复中复制原文或完整产物。',
        ],
      });
      const abort = () => void child.abort();
      const unsubscribe = child.subscribe((event) => {
        if (event.type === 'tool_execution_start')
          onUpdate?.({
            content: [{ type: 'text', text: `正在分步处理：${event.toolName}` }],
            details: { outputPath: path },
          });
      });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        signal?.throwIfAborted();
        await child.prompt(`本步任务：\n${task}\n\n详细结果保存到：${path}`);
        signal?.throwIfAborted();
        const answer = [...child.messages]
          .reverse()
          .find((message) => message.role === 'assistant');
        if (!answer || answer.stopReason !== 'stop')
          throw new Error(answer?.errorMessage ?? '本步尚未完成，请检查已保存的部分结果后继续');
        const artifact = await stat(path, { bigint: true }).catch(() => null);
        if (!artifact?.isFile() || artifact.size === 0n)
          throw new Error('本步未保存有效结果文件，不能标记为完成');
        if (
          previous &&
          artifact.dev === previous.dev &&
          artifact.ino === previous.ino &&
          artifact.size === previous.size &&
          artifact.mtimeNs === previous.mtimeNs &&
          artifact.ctimeNs === previous.ctimeNs
        )
          throw new Error('本步未更新已有结果文件，不能标记为完成');
        const summary = answer.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n');
        const result = {
          status: 'completed',
          outputPath: path,
          bytes: Number(artifact.size),
          summary: summary.slice(0, 2000),
          ...(summary.length > 2000 ? { summaryTruncated: true } : {}),
        };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      } catch (error) {
        const result = {
          status: signal?.aborted ? 'cancelled' : 'incomplete',
          outputPath: path,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: result,
          isError: true,
        };
      } finally {
        signal?.removeEventListener('abort', abort);
        unsubscribe();
        const stats = child.getSessionStats();
        try {
          await shutdownSession(child, 'quit');
        } finally {
          recordUsage(stats);
        }
      }
    },
  };
}
