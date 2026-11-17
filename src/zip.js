// Gerador de ZIP sem dependências.
// Usa CompressionStream('deflate-raw'), nativo no Chrome, para comprimir.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined' || bytes.length === 0) return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    // Só vale a pena se realmente encolheu.
    return out.length < bytes.length ? out : null;
  } catch {
    return null;
  }
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function u8(...bytes) {
  return new Uint8Array(bytes);
}

function le16(n) {
  return u8(n & 0xff, (n >>> 8) & 0xff);
}

function le32(n) {
  return u8(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}

function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * @param {Array<{name: string, data: Uint8Array|string}>} entries
 * @returns {Promise<Blob>}
 */
export async function makeZip(entries) {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(new Date());
  const local = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    const nameBytes = encoder.encode(entry.name);
    const deflated = await deflateRaw(raw);
    const method = deflated ? 8 : 0;
    const body = deflated || raw;
    const crc = crc32(raw);

    // Flag 0x0800 = nomes em UTF-8.
    const header = concat([
      le32(0x04034b50), le16(20), le16(0x0800), le16(method),
      le16(time), le16(date),
      le32(crc), le32(body.length), le32(raw.length),
      le16(nameBytes.length), le16(0),
      nameBytes,
    ]);
    local.push(header, body);

    central.push(concat([
      le32(0x02014b50), le16(20), le16(20), le16(0x0800), le16(method),
      le16(time), le16(date),
      le32(crc), le32(body.length), le32(raw.length),
      le16(nameBytes.length), le16(0), le16(0),
      le16(0), le16(0), le32(0),
      le32(offset),
      nameBytes,
    ]));

    offset += header.length + body.length;
  }

  const centralBytes = concat(central);
  const eocd = concat([
    le32(0x06054b50), le16(0), le16(0),
    le16(entries.length), le16(entries.length),
    le32(centralBytes.length), le32(offset), le16(0),
  ]);

  return new Blob([concat(local), centralBytes, eocd], { type: 'application/zip' });
}
