export interface BugFile {
  name: 'report.json' | 'diagnostics.json' | 'session.jsonl';
  data: string;
  contentType: string;
}
const crc32 = (bytes: Buffer) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
/** Small stored ZIP, fixed names; no filesystem traversal/compression dependencies. */
export function bugZip(files: BugFile[]): Buffer {
  if (files.length > 3 || new Set(files.map((f) => f.name)).size !== files.length)
    throw new Error('Invalid archive entries.');
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    if (!['report.json', 'diagnostics.json', 'session.jsonl'].includes(file.name))
      throw new Error('Invalid archive entry.');
    const name = Buffer.from(file.name),
      bytes = Buffer.from(file.data),
      crc = crc32(bytes);
    if (offset + bytes.length > 10 * 1024 * 1024) throw new Error('Bug archive exceeds 10 MiB.');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50);
    index.writeUInt16LE(20, 4);
    index.writeUInt16LE(20, 6);
    index.writeUInt32LE(crc, 16);
    index.writeUInt32LE(bytes.length, 20);
    index.writeUInt32LE(bytes.length, 24);
    index.writeUInt16LE(name.length, 28);
    index.writeUInt32LE(offset, 42);
    local.push(header, name, bytes);
    central.push(index, name);
    offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
