import * as vscode from 'vscode';
import { redactText } from './redaction';
import { formatError } from './errorFormat';

export { formatError };

export class DiagnosticsLogger {
  public readonly output = vscode.window.createOutputChannel('Pi');
  private readonly ring: string[] = [];

  public dispose(): void {
    this.output.dispose();
  }

  public info(message: string): void {
    this.push('INFO', message);
  }

  public warn(message: string): void {
    this.push('WARN', message);
  }

  public error(message: string, error?: unknown): void {
    this.push('ERROR', error ? `${message} — ${formatError(error)}` : message);
  }

  /** Reveal the Pi output channel so the user can read the log. */
  public show(): void {
    this.output.show(true);
  }

  public health(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      generatedAt: new Date().toISOString(),
      recentLogLines: [...this.ring],
      ...extra,
    };
  }

  private push(level: string, message: string): void {
    const line = `${new Date().toISOString()} ${level} ${redactText(message)}`;
    this.ring.push(line);
    if (this.ring.length > 200) {
      this.ring.shift();
    }
    this.output.appendLine(line);
  }
}
