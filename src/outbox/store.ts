import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import type { AcceptedSendSnapshot } from '../webview/composer';
import type { JsonObject } from '../rpc/protocol';
import type { OutboxAction, OutboxRow, OutboxSnapshot } from './types';

const MAX_SESSION_BYTES = 32 * 1024 * 1024;
const MAX_STORAGE_BYTES = 64 * 1024 * 1024;
const MAX_TEXT = 160000;
interface StoredItem extends OutboxRow {
  submissionId?: string;
  payload?: AcceptedSendSnapshot;
}
interface RecordData {
  schema: 1;
  key: string;
  items: StoredItem[];
}
const editable = (item: StoredItem) =>
  ['queued', 'held', 'editing', 'paused'].includes(item.status);
const clone = <T>(value: T): T => structuredClone(value);
const validRow = (item: StoredItem) =>
  item &&
  typeof item.id === 'string' &&
  item.id.length <= 100 &&
  Number.isSafeInteger(item.revision) &&
  typeof item.text === 'string' &&
  item.text.length <= MAX_TEXT &&
  ['queued', 'held', 'editing', 'paused', 'sending', 'unknown', 'accepted'].includes(item.status) &&
  Array.isArray(item.files) &&
  item.files.length <= 100 &&
  item.files.every(
    (file) =>
      file &&
      typeof file.name === 'string' &&
      file.name.length <= 4096 &&
      ['file', 'image'].includes(file.kind)
  );
const project = (item: StoredItem): OutboxRow => ({
  id: item.id,
  revision: item.revision,
  status: item.status,
  text: item.status === 'editing' ? item.text : item.text.slice(0, 1000),
  files: clone(item.files),
});

/** Extension-host storage only. Native queues are never cleared or reconstructed. */
export class OutboxStore {
  private readonly records = new Map<string, RecordData>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly owners = new Map<string, Server>();
  private closed = false;

  public constructor(private readonly directory: string) {}

  public pathFor(key: string): string {
    return join(this.directory, `${createHash('sha256').update(key).digest('hex')}.json`);
  }

  /** Kernel-owned locks: process death releases ownership without stale-file takeover. */
  private async bind(key: string): Promise<Server> {
    const server = createServer((socket) => socket.destroy());
    const port =
      10240 +
      (createHash('sha256')
        .update(this.directory)
        .update('\0')
        .update(key)
        .digest()
        .readUInt32BE() %
        50000);
    await new Promise<void>((resolve, reject) => {
      const failed = () => {
        server.close();
        reject(
          new Error(
            'Outbox ownership is unavailable. Another VS Code window or local service may own it. Nothing was sent.'
          )
        );
      };
      server.once('error', failed);
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        server.removeListener('error', failed);
        server.on('error', () => {});
        server.unref();
        resolve();
      });
    });
    return server;
  }

  private async own(key: string): Promise<void> {
    if (this.closed) throw new Error('Outbox is closed.');
    if (this.owners.has(key)) return;
    const owner = await this.bind(`chat:${key}`);
    this.owners.set(key, owner);
    this.records.delete(key); // A different live window may have owned the record in between.
  }

  private async release(key: string): Promise<void> {
    const server = this.owners.get(key);
    if (!server) return;
    this.owners.delete(key);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  public async dispose(): Promise<void> {
    await this.serial(async () => {
      try {
        for (const key of this.owners.keys()) {
          const next = clone(await this.read(key));
          for (const item of next.items) {
            if (item.status === 'sending') item.status = 'unknown';
            else if (editable(item)) item.status = 'paused';
            else continue;
            item.revision++;
          }
          await this.write(next);
          this.records.set(key, next);
        }
      } finally {
        this.closed = true;
        for (const key of [...this.owners.keys()]) await this.release(key);
      }
    });
  }

  public suspend(key: string): Promise<void> {
    return this.serial(async () => {
      if (!this.owners.has(key)) return;
      try {
        const next = clone(await this.read(key));
        for (const item of next.items) {
          if (item.status === 'sending') item.status = 'unknown';
          else if (editable(item)) item.status = 'paused';
          else continue;
          item.revision++;
        }
        await this.write(next);
      } finally {
        this.records.delete(key);
        await this.release(key);
      }
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(operation, operation);
    this.tail = pending.catch(() => {});
    return pending;
  }

  private async read(key: string): Promise<RecordData> {
    const cached = this.records.get(key);
    if (cached) return cached;
    let data: RecordData = { schema: 1, key, items: [] };
    try {
      const info = await lstat(this.pathFor(key));
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SESSION_BYTES)
        throw new Error('Invalid outbox file');
      data = JSON.parse(await readFile(this.pathFor(key), 'utf8')) as RecordData;
      if (
        data.schema !== 1 ||
        data.key !== key ||
        !Array.isArray(data.items) ||
        data.items.length > 12
      )
        throw new Error('Invalid outbox data');
      for (const item of data.items) {
        if (!validRow(item)) throw new Error('Invalid outbox item');
        if (item.status !== 'accepted') this.validatePayload(item.payload);
        // Loading after process restart never resumes delivery implicitly.
        if (item.status === 'sending') item.status = 'unknown';
        else if (editable(item)) item.status = 'paused';
        item.revision++;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Outbox data is unavailable. Nothing was sent.');
    }
    if (data.items.length) await this.write(data);
    this.records.set(key, data);
    return data;
  }

  private validatePayload(
    payload: AcceptedSendSnapshot | undefined
  ): asserts payload is AcceptedSendSnapshot {
    if (
      !payload ||
      typeof payload.draft !== 'string' ||
      payload.draft.length > MAX_TEXT ||
      typeof payload.rpcMessage !== 'string' ||
      payload.rpcMessage.length > MAX_TEXT + 40000 ||
      !Array.isArray(payload.rpcImages) ||
      payload.rpcImages.length > 20 ||
      !Array.isArray(payload.contextItems) ||
      !Array.isArray(payload.imageItems) ||
      payload.rpcImages.some(
        (image) =>
          image.type !== 'image' ||
          typeof image.data !== 'string' ||
          typeof image.mimeType !== 'string' ||
          image.data.length > 20 * 1024 * 1024
      )
    )
      throw new Error('This message is too large or incomplete for Outbox. Your draft was kept.');
  }

  private async write(record: RecordData): Promise<void> {
    const quota = await this.bind('storage-write');
    try {
      await this.writeOwned(record);
    } finally {
      await new Promise<void>((resolve) => quota.close(() => resolve()));
    }
  }

  private async writeOwned(record: RecordData): Promise<void> {
    if (record.items.every((item) => item.status === 'accepted')) {
      await rm(this.pathFor(record.key), { force: true });
      return;
    }
    const bytes = Buffer.from(JSON.stringify(record));
    if (bytes.length > MAX_SESSION_BYTES) throw new Error('Outbox is full. Your draft was kept.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error('Outbox storage unavailable.');
    const files = (await readdir(this.directory)).filter((name) =>
      /^[a-f0-9]{64}\.json$/.test(name)
    );
    const exists = files.includes(this.pathFor(record.key).split(/[\\/]/).pop()!);
    if (files.length >= 128 && !exists) throw new Error('Outbox storage is full.');
    let total = bytes.length;
    for (const file of files) {
      if (join(this.directory, file) === this.pathFor(record.key)) continue;
      const info = await lstat(join(this.directory, file));
      if (info.isFile()) total += info.size;
    }
    const payloadBytes = (data: RecordData | undefined) =>
      Buffer.byteLength(JSON.stringify(data?.items.map((item) => item.payload) ?? []));
    if (
      total > MAX_STORAGE_BYTES &&
      (!exists || payloadBytes(record) > payloadBytes(this.records.get(record.key)))
    )
      throw new Error('Outbox storage is full. Your draft was kept.');
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.pathFor(record.key));
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  private async change<T>(key: string, mutate: (record: RecordData) => T): Promise<T> {
    await this.own(key);
    const next = clone(await this.read(key));
    const result = mutate(next);
    await this.write(next);
    this.records.set(key, next);
    if (next.items.every((item) => item.status === 'accepted')) await this.release(key);
    return clone(result);
  }

  public snapshot(key: string): Promise<OutboxSnapshot> {
    return this.serial(async () => {
      try {
        if (!this.owners.has(key)) {
          try {
            await lstat(this.pathFor(key));
            await this.own(key);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            return { key, items: [] };
          }
        }
        return { key, items: (await this.read(key)).items.map(project) };
      } catch (error) {
        // A different window may show the same canonical session, but cannot mutate its outbox.
        try {
          const info = await lstat(this.pathFor(key));
          if (info.isFile() && !info.isSymbolicLink() && info.size <= MAX_SESSION_BYTES) {
            const data = JSON.parse(await readFile(this.pathFor(key), 'utf8')) as RecordData;
            if (
              data.schema === 1 &&
              data.key === key &&
              Array.isArray(data.items) &&
              data.items.length <= 12 &&
              data.items.every(validRow)
            )
              return {
                key,
                items: data.items.map(project),
                readOnly: true,
                notice:
                  'Outbox ownership is unavailable here. Use the owning VS Code window; nothing will be sent from this window.',
              };
          }
        } catch {
          /* No unvalidated payload or path details cross the UI boundary. */
        }
        return {
          key,
          items: [],
          readOnly: true,
          notice:
            error instanceof Error ? error.message : 'Outbox is unavailable. Nothing was sent.',
        };
      }
    });
  }

  public enqueue(
    key: string,
    payload: AcceptedSendSnapshot,
    submissionId?: string
  ): Promise<OutboxRow> {
    const frozen = clone(payload);
    this.validatePayload(frozen);
    return this.serial(() =>
      this.change(key, (record) => {
        const existing =
          submissionId && record.items.find((item) => item.submissionId === submissionId);
        if (existing) return project(existing);
        if (record.items.filter((item) => item.status !== 'accepted').length >= 8)
          throw new Error('Outbox is full. Your draft was kept.');
        record.items = record.items
          .filter((item) => item.status !== 'accepted')
          .concat(record.items.filter((item) => item.status === 'accepted').slice(-3));
        const item: StoredItem = {
          id: randomUUID(),
          revision: 1,
          status: 'queued',
          text: frozen.draft,
          files: [
            ...frozen.contextItems.map((file) => ({
              name: file.workspaceRelativePath,
              kind: 'file' as const,
            })),
            ...frozen.imageItems.map((file) => ({ name: file.name, kind: 'image' as const })),
          ],
          submissionId,
          payload: frozen,
        };
        if (!validRow(item))
          throw new Error(
            'This message has too many or invalid attachments for Outbox. Your draft was kept.'
          );
        record.items.push(item);
        return project(item);
      })
    );
  }

  public payload(key: string, id: string): Promise<AcceptedSendSnapshot> {
    return this.serial(async () => {
      await this.own(key);
      const item = (await this.read(key)).items.find((row) => row.id === id);
      if (!item?.payload) throw new Error('This message was already handed to Pi.');
      return clone(item.payload);
    });
  }

  public next(key: string): Promise<OutboxRow | undefined> {
    return this.serial(async () => {
      await this.own(key);
      const first = (await this.read(key)).items.find((row) => row.status !== 'accepted');
      return first?.status === 'queued' ? project(first) : undefined;
    });
  }

  public action(
    key: string,
    id: string,
    revision: number,
    action: Exclude<OutboxAction, 'steer'>,
    text?: string
  ): Promise<OutboxRow | undefined> {
    return this.serial(() =>
      this.change(key, (record) => {
        const item = record.items.find((row) => row.id === id);
        if (!item || item.revision !== revision)
          throw new Error('This outbox item changed. Review its current state.');
        if (action === 'discard' && item.status === 'unknown') {
          record.items = record.items.filter((row) => row !== item);
          for (const pending of record.items)
            if (editable(pending)) {
              pending.status = 'paused';
              pending.revision++;
            }
          return undefined;
        }
        if (action === 'discard')
          throw new Error('Only an uncertain delivery copy can be discarded.');
        if (!editable(item)) throw new Error('Sending or received messages cannot be changed.');
        if (action === 'remove') {
          record.items = record.items.filter((row) => row !== item);
          return undefined;
        }
        if (action === 'save') {
          if (
            item.status !== 'editing' ||
            typeof text !== 'string' ||
            text.length > MAX_TEXT ||
            (!text.trim() && !item.files.length)
          )
            throw new Error('Enter a message, or cancel and remove it.');
          item.text = text;
          item.payload!.draft = text;
          const envelope = item.payload!.serializedContextEnvelope;
          item.payload!.rpcMessage = envelope ? (text ? `${text}\n\n${envelope}` : envelope) : text;
          this.validatePayload(item.payload);
        }
        item.status = action === 'edit' ? 'editing' : action === 'resume' ? 'queued' : 'held';
        item.revision++;
        return project(item);
      })
    );
  }

  public pause(key: string): Promise<void> {
    return this.serial(() =>
      this.change(key, (record) => {
        for (const item of record.items) {
          if (item.status === 'sending') item.status = 'unknown';
          else if (editable(item)) item.status = 'paused';
          else continue;
          item.revision++;
        }
      })
    );
  }

  public async dispatch(
    key: string,
    id: string,
    revision: number,
    send: (payload: AcceptedSendSnapshot) => Promise<JsonObject | undefined>,
    valid: () => boolean
  ): Promise<JsonObject | undefined> {
    const token = await this.serial(() =>
      this.change(key, (record) => {
        const item = record.items.find((row) => row.id === id);
        if (
          !valid() ||
          !item ||
          item.revision !== revision ||
          !['queued', 'held', 'paused'].includes(item.status) ||
          record.items.some((row) => row.status === 'sending')
        )
          throw new Error('This outbox item changed or another handoff is in progress.');
        item.status = 'sending';
        item.revision++;
        return { revision: item.revision, payload: item.payload! };
      })
    );
    let attempted = false;
    try {
      if (!valid()) throw new Error('Chat changed before handoff.');
      attempted = true;
      const acknowledgement = await send(token.payload);
      if (
        !acknowledgement ||
        typeof acknowledgement.disposition !== 'string' ||
        !['started', 'queued', 'handled'].includes(acknowledgement.disposition)
      )
        throw new Error('Native handoff acknowledgement is missing.');
      if (this.closed || !this.owners.has(key)) return acknowledgement;
      await this.serial(() =>
        this.change(key, (record) => {
          const item = record.items.find((row) => row.id === id);
          if (!item || item.revision !== token.revision || item.status !== 'sending') return;
          item.status = valid() ? 'accepted' : 'unknown';
          item.revision++;
          if (item.status === 'accepted') delete item.payload;
        })
      );
      return acknowledgement;
    } catch (error) {
      if (!this.closed && this.owners.has(key))
        await this.serial(() =>
          this.change(key, (record) => {
            const item = record.items.find((row) => row.id === id);
            if (item?.status === 'sending') {
              item.status =
                !attempted ||
                (error as { outboxNotDispatched?: boolean }).outboxNotDispatched === true
                  ? 'paused'
                  : 'unknown';
              item.revision++;
            }
          })
        );
      throw new Error(
        !attempted || (error as { outboxNotDispatched?: boolean }).outboxNotDispatched === true
          ? 'Outbox is paused. Review this chat before choosing Send.'
          : 'Delivery could not be confirmed. Check the chat; this message will not be resent automatically.'
      );
    }
  }
}
