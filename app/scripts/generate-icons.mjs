import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/icons');
const dark = [16, 27, 44, 255];
const light = [243, 247, 246, 255];
const mint = [45, 214, 179, 255];

function png(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const paint = (x, y, color) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    pixels.set(color, (y * size + x) * 4);
  };
  const rect = (x1, y1, x2, y2, color) => {
    for (let y = Math.floor(y1 * size); y < Math.ceil(y2 * size); y++)
      for (let x = Math.floor(x1 * size); x < Math.ceil(x2 * size); x++) paint(x, y, color);
  };
  const line = (x1, y1, x2, y2, width, color) => {
    const steps = size * 2;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = (x1 + (x2 - x1) * t) * size;
      const y = (y1 + (y2 - y1) * t) * size;
      const radius = width * size / 2;
      for (let yy = Math.floor(y - radius); yy <= y + radius; yy++)
        for (let xx = Math.floor(x - radius); xx <= x + radius; xx++)
          if ((xx - x) ** 2 + (yy - y) ** 2 <= radius ** 2) paint(xx, yy, color);
    }
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = size * .21;
    const cx = Math.max(r, Math.min(size - r, x));
    const cy = Math.max(r, Math.min(size - r, y));
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r ** 2) paint(x, y, dark);
  }
  line(.18, .27, .5, .13, .035, light);
  line(.5, .13, .82, .27, .035, light);
  line(.19, .32, .81, .32, .035, mint);
  for (const x of [.26, .42, .58, .74]) rect(x - .025, .33, x + .025, .72, light);
  line(.19, .74, .81, .74, .035, mint);
  const bytes = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) pixels.copy(bytes, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let value = n;
    for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const chunk = (name, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(name), data]);
    let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    const tail = Buffer.alloc(4); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(bytes)), chunk('IEND', Buffer.alloc(0))]);
}

for (const size of [192, 512]) fs.writeFileSync(path.join(directory, `icon-${size}.png`), png(size));
