import type { AgentSession } from '@earendil-works/pi-coding-agent';

export async function shutdownSession(
  session: AgentSession,
  reason: 'quit' | 'reload',
): Promise<void> {
  try {
    if (session.extensionRunner.hasHandlers('session_shutdown'))
      await session.extensionRunner.emit({ type: 'session_shutdown', reason });
  } finally {
    session.dispose();
  }
}
