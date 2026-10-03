import { constants } from 'node:fs';
import { open, lstat, realpath, mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateImport } from './import-validation.mjs';

export function createImportCommands(getRuntime) {
  let staged;
  const discard = async () => {
    const previous = staged;
    staged = undefined;
    if (previous) await rm(previous.directory, { recursive: true, force: true });
  };
  const source = async (path) => {
    if (typeof path !== 'string' || !path || path.includes('\0') || !path.endsWith('.jsonl'))
      throw new Error('IMPORT_INVALID_PATH');
    const canonical = await realpath(path);
    if (canonical !== resolve(path)) throw new Error('IMPORT_SYMLINK_PATH');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024)
      throw new Error('IMPORT_INVALID_PATH');
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (stat.dev !== info.dev || stat.ino !== info.ino || stat.size !== info.size)
        throw new Error('IMPORT_SOURCE_CHANGED');
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesRead) throw new Error('IMPORT_SOURCE_CHANGED');
        offset += result.bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
        throw new Error('IMPORT_SOURCE_CHANGED');
      return bytes;
    } finally {
      await handle.close();
    }
  };
  return {
    async prepare(path) {
      await discard();
      const runtime = getRuntime();
      if (
        !runtime.session.sessionManager.isPersisted() ||
        !runtime.session.sessionManager.getSessionDir()
      )
        throw new Error('IMPORT_REQUIRES_PERSISTED_SESSION');
      path = resolve(runtime.cwd, path);
      const bytes = await source(path),
        preview = validateImport(bytes);
      const parent = await realpath(runtime.services.agentDir);
      const directory = await mkdtemp(join(parent, '.gui-import-'));
      await chmod(directory, 0o700);
      const file = join(directory, `import-${randomUUID()}.jsonl`);
      try {
        await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      staged = { path, bytes, directory, file, nonce: randomUUID() };
      return { ...preview, nonce: staged.nonce, source: path, destinationCwd: runtime.cwd };
    },
    async run(nonce) {
      const current = staged;
      if (!current || nonce !== current.nonce) throw new Error('IMPORT_STALE');
      try {
        if (
          !(await source(current.path)).equals(current.bytes) ||
          !(await readFile(current.file)).equals(current.bytes) ||
          (await realpath(dirname(current.file))) !== current.directory
        )
          throw new Error('IMPORT_SOURCE_CHANGED');
        validateImport(current.bytes);
        // Same admitted cwd/services profile, never implicitly load a different imported project.
        return await getRuntime().importFromJsonl(current.file, getRuntime().cwd);
      } catch (error) {
        throw new Error(
          ['ENOENT', 'EACCES', 'EPERM', 'ERR_ACCESS_DENIED'].includes(error?.code)
            ? `IMPORT_${error.code}`
            : error?.name === 'TypeError'
              ? 'IMPORT_TYPE_ERROR'
              : 'IMPORT_OPERATION_FAILED'
        );
      } finally {
        await discard();
      }
    },
    discard,
  };
}
