import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function createTestDirectory(prefix: string): Promise<string> {
  const parent = join(tmpdir(), 'pi-extension');
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, prefix));
}
