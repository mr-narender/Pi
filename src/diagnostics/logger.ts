import * as vscode from 'vscode';
import { redactText } from './redaction';
import { formatError } from './errorFormat';

export { formatError };

// Pi and its extensions write TERMINAL output (ANSI colors, OSC sequences like
// the `]777;notify;…` desktop-notification protocol, cursor controls). VS Code's
// Output console renders none of it — the escapes appear as `]777`/`[38;2;…m`
// garbage — so every log line is stripped to plain text.
// Covers: CSI (colors/cursor), OSC … BEL/ST (incl. 777), single-char escapes,
// stray BEL and carriage returns.
// eslint-disable-next-line no-control-regex
const TERMINAL_ESCAPES =
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]|\u0007|\r/g;

export function stripTerminalEscapes(text: string): string {
  return text.replace(TERMINAL_ESCAPES, '');
}

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
    const line = `${new Date().toISOString()} ${level} ${redactText(stripTerminalEscapes(message))}`;
    this.ring.push(line);
    if (this.ring.length > 200) {
      this.ring.shift();
    }
    this.output.appendLine(line);
  }
}
