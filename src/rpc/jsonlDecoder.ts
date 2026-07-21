export interface JsonlDecoderOptions {
  maxRecordBytes: number;
  maxBufferBytes: number;
}

export class JsonlProtocolError extends Error {}

export class JsonlDecoder {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly records: string[] = [];
  private buffer = new Uint8Array(0);

  public constructor(private readonly options: JsonlDecoderOptions) {}

  public push(chunk: Uint8Array): string[] {
    this.append(chunk);
    this.split(false);
    // Bound only the UNPARSED residual (an incomplete trailing record). A large
    // burst of complete, newline-delimited records — e.g. a full session replay
    // on resume — is split out above and must NOT trip this limit. Checking the
    // transient combined buffer here was the cause of "Pending stdout buffer
    // exceeded limit" when resuming sessions.
    if (this.buffer.length > this.options.maxBufferBytes) {
      throw new JsonlProtocolError('Pending stdout buffer exceeded limit');
    }
    return this.drainRecords();
  }

  public end(): string[] {
    this.split(true);
    return this.drainRecords();
  }

  private append(chunk: Uint8Array): void {
    const next = new Uint8Array(this.buffer.length + chunk.length);
    next.set(this.buffer, 0);
    next.set(chunk, this.buffer.length);
    this.buffer = next;
  }

  private split(final: boolean): void {
    let start = 0;
    for (let index = 0; index < this.buffer.length; index += 1) {
      if (this.buffer[index] === 0x0a) {
        this.decodeRecord(this.buffer.subarray(start, index));
        start = index + 1;
      }
    }
    if (start > 0) {
      this.buffer = this.buffer.subarray(start);
    }
    if (final && this.buffer.length > 0) {
      this.decodeRecord(this.buffer);
      this.buffer = new Uint8Array(0);
    }
  }

  private decodeRecord(bytes: Uint8Array): void {
    if (bytes.length === 0) {
      throw new JsonlProtocolError('Blank JSONL record');
    }
    const trimmed = bytes[bytes.length - 1] === 0x0d ? bytes.subarray(0, bytes.length - 1) : bytes;
    if (trimmed.length === 0) {
      throw new JsonlProtocolError('Blank JSONL record');
    }
    if (trimmed.length > this.options.maxRecordBytes) {
      throw new JsonlProtocolError('JSONL record exceeded limit');
    }
    let decoded: string;
    try {
      decoded = this.decoder.decode(trimmed);
    } catch (error) {
      throw new JsonlProtocolError(`Malformed UTF-8 JSONL record: ${String(error)}`);
    }
    if (decoded.length === 0) {
      throw new JsonlProtocolError('Blank JSONL record');
    }
    this.records.push(decoded);
  }

  private drainRecords(): string[] {
    const drained = [...this.records];
    this.records.length = 0;
    return drained;
  }
}
