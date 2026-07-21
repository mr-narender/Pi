/** Turn any thrown value into a clear one-line diagnostic (name, message, code). */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    const errno = (error as NodeJS.ErrnoException).errno;
    const parts = [error.message || error.name];
    if (code) parts.push(`code=${code}`);
    if (typeof errno === 'number') parts.push(`errno=${errno}`);
    return parts.join(' ');
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
