import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export async function canonicalizeSessionPath(cwd: string, sessionPath: string): Promise<string> {
  const candidate = isAbsolute(sessionPath) ? sessionPath : resolve(cwd, sessionPath);
  return realpath(candidate);
}
