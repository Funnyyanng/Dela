import type { Api, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';

export function kimiCacheOptions(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
): SimpleStreamOptions | undefined {
  if (
    model.api !== 'openai-completions' ||
    !options?.sessionId ||
    options.cacheRetention === 'none'
  )
    return options;
  const url = new URL(model.baseUrl);
  if (
    !['api.kimi.com', 'api.kimi.ai'].includes(url.hostname) ||
    !url.pathname.startsWith('/coding/')
  )
    return options;
  return {
    ...options,
    onPayload: async (payload, requestModel) => ({
      ...(((await options.onPayload?.(payload, requestModel)) ?? payload) as object),
      prompt_cache_key: options.sessionId,
    }),
  };
}
