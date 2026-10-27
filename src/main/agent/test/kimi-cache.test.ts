import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { LLM_DEFAULT_OUTPUT_TOKENS } from '../../../shared/llm-presets';
import { kimiCacheOptions } from '../kimi-cache';
import { MockOpenAiServer, mockFrames } from './mock-openai-server';

const root = mkdtempSync(join(tmpdir(), 'dela-kimi-cache-'));
vi.mock('electron', () => ({ app: { getPath: () => root } }));

import { openPiSession } from '../pi';

const model: Model<'openai-completions'> = {
  id: 'k3',
  name: 'k3',
  provider: 'dela',
  api: 'openai-completions',
  baseUrl: 'https://api.kimi.com/coding/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_048_576,
  maxTokens: LLM_DEFAULT_OUTPUT_TOKENS,
};

describe('Kimi Coding prompt cache routing', () => {
  it.each(['api.kimi.com', 'api.kimi.ai'])('preserves payload hooks for %s', async (host) => {
    const onPayload = vi.fn(async (payload: unknown) => ({
      ...(payload as object),
      temperature: 0.3,
    }));
    const requestModel = { ...model, baseUrl: `https://${host}/coding/v1` };
    const options = kimiCacheOptions(requestModel, { sessionId: 'session-one', onPayload });
    const payload = { messages: [{ role: 'user', content: 'hello' }], stream: true };

    expect(await options?.onPayload?.(payload, requestModel)).toEqual({
      ...payload,
      temperature: 0.3,
      prompt_cache_key: 'session-one',
    });
    expect(onPayload).toHaveBeenCalledWith(payload, requestModel);
    expect(payload).not.toHaveProperty('prompt_cache_key');
  });

  it('preserves in-place payload hooks that return undefined', async () => {
    const options = kimiCacheOptions(model, {
      sessionId: 'session-one',
      onPayload: (payload) => {
        (payload as Record<string, unknown>).temperature = 0.5;
      },
    });
    expect(await options?.onPayload?.({}, model)).toEqual({
      temperature: 0.5,
      prompt_cache_key: 'session-one',
    });
  });

  it.each([
    'https://api.openai.com/v1',
    'https://api.moonshot.cn/v1',
    'https://api.kimi.com/v1',
    'https://api.kimi.com.example.org/coding/v1',
  ])('leaves other services unchanged: %s', (baseUrl) => {
    const options = { sessionId: 'session-one' };
    expect(kimiCacheOptions({ ...model, baseUrl }, options)).toBe(options);
  });

  it('does not inject a key when caching is disabled or no session id exists', () => {
    const disabled: SimpleStreamOptions = { sessionId: 'session-one', cacheRetention: 'none' };
    const noSession = { maxTokens: 100 };
    expect(kimiCacheOptions(model, disabled)).toBe(disabled);
    expect(kimiCacheOptions(model, noSession)).toBe(noSession);
    expect(kimiCacheOptions(model, undefined)).toBeUndefined();
  });
});

let server: MockOpenAiServer;
beforeAll(async () => {
  server = await MockOpenAiServer.start();
  const fetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname !== 'api.kimi.com') return fetch(input, init);
    return fetch(new Request(`${server.baseUrl}/chat/completions`, request));
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await server?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const reply = () => ({
  kind: 'sse' as const,
  frames: [mockFrames.textDelta('done'), mockFrames.finishFrame('stop')],
});

it('reuses a session cache key across tools and resume, with distinct keys for new sessions', async () => {
  const cwd = mkdtempSync(join(root, 'cwd-'));
  const input = {
    cwd,
    provider: {
      id: 'p',
      name: 'Kimi test',
      baseUrl: model.baseUrl,
      apiKey: 'test-only',
      models: ['k3'],
      model: 'k3',
      presetId: null,
      modelConfigs: {
        k3: { effortLevels: ['high'], effort: 'high', contextWindow: 1_048_576 },
      },
    },
    appendSystemPrompt: [],
    customTools: [
      {
        name: 'echo',
        label: 'echo',
        description: 'Echo test input',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({
          content: [{ type: 'text' as const, text: 'test result' }],
          details: undefined,
        }),
      },
    ],
    shellPath: process.env.SHELL ?? 'bash',
    skillPaths: [],
    globalSkillDirs: [],
    disabledSkills: new Set<string>(),
    disabledTools: [],
  };
  const session = await openPiSession(input);
  try {
    server.enqueue({
      kind: 'sse',
      frames: [
        mockFrames.reasoningDelta('reasoning before the tool'),
        mockFrames.toolCallDelta({ index: 0, id: 'call-one', name: 'echo', arguments: '{}' }),
        mockFrames.finishFrame('tool_calls'),
      ],
    });
    server.enqueue(reply());
    await session.prompt('Use echo');
    const requests = server.requests.map(({ body }) => body as Record<string, unknown>);
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.prompt_cache_key)).toEqual([
      session.sessionId,
      session.sessionId,
    ]);
    expect(requests.every((request) => !('prompt_cache_retention' in request))).toBe(true);
    expect(requests[0]?.max_completion_tokens).toBe(LLM_DEFAULT_OUTPUT_TOKENS);
    expect(requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          reasoning_content: 'reasoning before the tool',
        }),
      ]),
    );
    const id = session.sessionId;
    const file = session.sessionFile!;
    session.dispose();

    const resumed = await openPiSession({ ...input, file });
    try {
      server.enqueue(reply());
      await resumed.prompt('Continue');
      expect(server.requests.at(-1)?.body).toMatchObject({ prompt_cache_key: id });
      const resumedMessages = (server.requests.at(-1)!.body as { messages: unknown[] }).messages;
      const previousMessages = requests[1]!.messages as unknown[];
      expect(resumedMessages.slice(0, previousMessages.length)).toEqual(previousMessages);
    } finally {
      resumed.dispose();
    }

    const other = await openPiSession({ ...input, cwd: mkdtempSync(join(root, 'cwd-')) });
    try {
      server.enqueue(reply());
      await other.prompt('Hello');
      expect(other.sessionId).not.toBe(id);
      expect(server.requests.at(-1)?.body).toMatchObject({ prompt_cache_key: other.sessionId });
    } finally {
      other.dispose();
    }
  } finally {
    session.dispose();
  }
}, 30_000);
