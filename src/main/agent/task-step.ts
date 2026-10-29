import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentSession, SessionStats, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import type { OpenSessionInput } from './pi';
import { shutdownSession } from './session-lifecycle';

const stepInput = z.object({
  task: z.string().trim().min(1).max(12_000),
  outputPath: z.string().trim().min(1).max(4000),
  maxToolCalls: z.number().int().min(1).max(200).default(40),
  maxTokens: z.number().int().min(1000).max(2_000_000).default(250_000),
  timeoutSeconds: z.number().int().min(10).max(1800).default(600),
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
    parameters: z.toJSONSchema(stepInput, { io: 'input' }) as ToolDefinition['parameters'],
    executionMode: 'sequential',
    async execute(_id, params, signal, onUpdate) {
      const { task, outputPath, maxToolCalls, maxTokens, timeoutSeconds } = stepInput.parse(params);
      const started = Date.now();
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
          `你负责一个有明确范围的独立步骤，不继承主会话历史。只处理分配的资料范围，不主动扩展到其他章节或无关文件。本步预算：最多${maxToolCalls}次工具调用、累计${maxTokens} token、${timeoutSeconds}秒；预算包括缓存读取，不等于当前上下文长度。接近预算先保存进度、缺口与可继续的位置，不缩减用户要求的质量或假称完成。详细结果必须先写入指定文件，再返回不超过500字的重点、完成范围及待核对事项。不要在最后回复中复制原文或完整产物。`,
        ],
      });
      const abort = () => void child.abort();
      let toolCalls = 0;
      let observedTokens = 0;
      let budgetExceeded: string | undefined;
      const stopForBudget = (reason: string) => {
        if (budgetExceeded) return;
        budgetExceeded = reason;
        abort();
      };
      const timer = setTimeout(
        () =>
          stopForBudget(`本步已达到${timeoutSeconds}秒时间预算，请依据已保存进度调整范围后继续`),
        timeoutSeconds * 1000,
      );
      const unsubscribe = child.subscribe((event) => {
        if (event.type === 'tool_execution_start') {
          toolCalls++;
          if (toolCalls > maxToolCalls)
            stopForBudget(`本步已达到${maxToolCalls}次工具调用预算，停止继续查找`);
          onUpdate?.({
            content: [{ type: 'text', text: `正在分步处理：${event.toolName}` }],
            details: { outputPath: path },
          });
        }
        if (event.type === 'message_end') {
          const usage =
            event.message.role === 'assistant' || event.message.role === 'toolResult'
              ? event.message.usage
              : undefined;
          observedTokens = Math.max(
            observedTokens,
            child.getSessionStats().tokens.total + (usage?.totalTokens ?? 0),
          );
          if (observedTokens >= maxTokens)
            stopForBudget(`本步已达到${maxTokens} token预算，请复用已有成果并缩小后续范围`);
        }
      });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        signal?.throwIfAborted();
        await child.prompt(`本步任务：\n${task}\n\n详细结果保存到：${path}`);
        signal?.throwIfAborted();
        if (child.getSessionStats().tokens.total >= maxTokens)
          stopForBudget(`本步已达到${maxTokens} token预算，请复用已有成果并缩小后续范围`);
        if (budgetExceeded) throw new Error(budgetExceeded);
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
          reviewStatus: 'not_reviewed',
          usage: {
            tokens: child.getSessionStats().tokens.total,
            toolCalls,
            elapsedMs: Date.now() - started,
          },
          summary: summary.slice(0, 2000),
          ...(summary.length > 2000 ? { summaryTruncated: true } : {}),
        };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      } catch (error) {
        const result = {
          status: signal?.aborted ? 'cancelled' : 'incomplete',
          outputPath: path,
          error: (budgetExceeded ?? (error instanceof Error ? error.message : String(error))).slice(
            0,
            1000,
          ),
          ...(budgetExceeded ? { budgetExceeded: true } : {}),
          usage: {
            tokens: child.getSessionStats().tokens.total,
            toolCalls,
            elapsedMs: Date.now() - started,
          },
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: result,
          isError: true,
        };
      } finally {
        clearTimeout(timer);
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
