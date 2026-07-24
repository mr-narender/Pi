import * as vscode from 'vscode';
import { getSettings } from '../config/settings';

/**
 * Inline "Ask Pi" CodeLens above functions/methods. Clicking selects the symbol
 * and offers Explain / Add tests / Fix / Refactor, routed to the chat.
 */
export class AskPiCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this.emitter.event;

  public refresh(): void {
    this.emitter.fire();
  }

  public async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    if (!getSettings().codeLensEnabled || document.uri.scheme !== 'file') {
      return [];
    }
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
      'vscode.executeDocumentSymbolProvider',
      document.uri
    );
    if (!symbols || token.isCancellationRequested) {
      return [];
    }
    const lenses: vscode.CodeLens[] = [];
    const wanted = new Set([
      vscode.SymbolKind.Function,
      vscode.SymbolKind.Method,
      vscode.SymbolKind.Constructor,
    ]);
    const visit = (nodes: vscode.DocumentSymbol[]): void => {
      for (const node of nodes) {
        if (wanted.has(node.kind)) {
          const anchor = new vscode.Range(node.selectionRange.start, node.selectionRange.start);
          lenses.push(
            new vscode.CodeLens(anchor, {
              title: '$(sparkle) Ask Pi',
              command: 'piRpcInternal.askSymbol',
              arguments: [
                {
                  uri: document.uri.toString(),
                  name: node.name,
                  range: {
                    startLine: node.range.start.line,
                    startChar: node.range.start.character,
                    endLine: node.range.end.line,
                    endChar: node.range.end.character,
                  },
                },
              ],
            })
          );
        }
        if (node.children.length > 0) {
          visit(node.children);
        }
      }
    };
    visit(symbols);
    return lenses;
  }
}

export interface AskSymbolArgs {
  uri: string;
  name?: string;
  range: { startLine: number; startChar: number; endLine: number; endChar: number };
}
