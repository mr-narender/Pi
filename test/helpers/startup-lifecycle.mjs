import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export default function ownedStartupLifecycle(pi) {
  const trace = (data) =>
    appendFileSync(join(process.cwd(), 'startup-trace.jsonl'), JSON.stringify(data) + '\n');
  pi.on('input', (event) => {
    trace({ type: 'input', source: event.source, text: event.text });
  });
  pi.on('before_agent_start', async (event, ctx) => {
    trace({
      type: event.type,
      messageType: event.messageType,
      idle: ctx.isIdle(),
      hasPrompt: 'prompt' in event,
    });
    if (event.messageType === 'user' && event.prompt.startsWith('owned start-block')) {
      const deadline = Date.now() + 8000;
      while (!existsSync(join(process.cwd(), 'startup-release'))) {
        if (Date.now() > deadline) throw new Error('owned startup release timed out');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return { message: { customType: 'owned-setup', content: 'OWNED RUN SETUP', display: false } };
  });
  pi.registerCommand('owned-custom', {
    handler: async () => {
      pi.sendMessage(
        { customType: 'owned-pending', content: 'OWNED NEXT TURN', display: false },
        { deliverAs: 'nextTurn' }
      );
      pi.sendMessage(
        { customType: 'owned-custom', content: 'OWNED CUSTOM START', display: true },
        { triggerTurn: true }
      );
    },
  });
}
