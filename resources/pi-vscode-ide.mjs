// Loaded only by the GUI launch arguments; never installed into native Pi settings.
export default function (pi) {
  pi.registerCommand('vscode-ide', {
    description: 'Show read-only editor tools and their limits',
    async handler(_args, ctx) {
      ctx.ui.notify(
        'Editor tools: diagnostics, document symbols, definitions and references. Read-only and scoped to this chat folder; queries never open tabs. Provider availability depends on the document and installed language service; an empty query cannot confirm availability. Registration does not grant permission: active Pi policy and tool selection still apply. Click returned locations to open a file.',
        'info'
      );
    },
  });
  for (const operation of ['diagnostics', 'document_symbols', 'definitions', 'references']) {
    const positional = operation === 'definitions' || operation === 'references';
    pi.registerTool({
      name: `vscode_${operation}`,
      label: `Editor ${operation.replaceAll('_', ' ')}`,
      description: `${operation.replaceAll('_', ' ')} from VS Code language services. Read-only; paths are relative to this chat's folder. Locations use 1-based lines and characters. Empty results do not confirm that a language provider is available. Never opens editor tabs.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Existing file inside this chat folder.' },
          ...(positional
            ? {
                line: { type: 'integer', minimum: 1 },
                character: { type: 'integer', minimum: 1 },
              }
            : {}),
        },
        required:
          operation === 'diagnostics' ? [] : positional ? ['path', 'line', 'character'] : ['path'],
        additionalProperties: false,
      },
      async execute(_id, args, signal, _update, ctx) {
        let result;
        if (!ctx.hasUI || signal?.aborted) {
          result = {
            vscodeIde: 1,
            operation,
            status: signal?.aborted ? 'cancelled' : 'unavailable',
            locations: [],
            message: 'Editor tools unavailable outside the attached GUI.',
          };
        } else {
          const response = await ctx.ui.input(
            'pi-vscode-ide-v1',
            JSON.stringify({ operation, ...args }),
            { signal, timeout: 12000 }
          );
          try {
            result = JSON.parse(response);
            if (result?.vscodeIde !== 1 || result.operation !== operation)
              throw new Error('Invalid editor response');
          } catch {
            result = {
              vscodeIde: 1,
              operation,
              status: signal?.aborted ? 'cancelled' : 'unavailable',
              locations: [],
              message:
                'Editor query did not return a usable result. Continue with native project tools.',
            };
          }
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: result,
          isError: !['ok', 'empty'].includes(result.status),
        };
      },
    });
  }
}
