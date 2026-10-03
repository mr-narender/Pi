import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
export default function ownedCompactVeto(pi) {
  pi.on('session_before_compact', (event) => {
    appendFileSync(
      join(process.cwd(), 'compact-veto-trace.jsonl'),
      JSON.stringify({
        type: event.type,
        reason: event.reason,
        instructions: event.customInstructions,
        cancel: true,
      }) + '\n'
    );
    return { cancel: true };
  });
}
