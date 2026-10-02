import * as vscode from 'vscode';

/** User-cancellable transfer; origin changes abort the request, never acknowledge delivery. */
export async function consentedTransfer<T>(
  title: string,
  valid: () => boolean,
  transfer: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (_progress, token) => {
      const controller = new AbortController();
      const cancellation = token.onCancellationRequested(() => controller.abort());
      const timer = setInterval(() => {
        if (!valid()) controller.abort();
      }, 100);
      try {
        if (!valid() || token.isCancellationRequested) controller.abort();
        controller.signal.throwIfAborted();
        const result = await transfer(controller.signal);
        controller.signal.throwIfAborted();
        if (!valid()) throw new Error('The originating chat changed.');
        return result;
      } finally {
        clearInterval(timer);
        cancellation.dispose();
      }
    }
  );
}
