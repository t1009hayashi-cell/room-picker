/**
 * PWA用アイコンPNGを生成する。外部依存を増やさないため、zlib だけで PNG を組み立てる。
 * 図案: 楽天レッドの角丸背景 + 白いカレンダー（ROOM投稿の予定管理という機能を表す）。
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'docs', 'icons');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const RED = [0xbf, 0x00, 0x00, 0xff];
const WHITE = [0xff, 0xff, 0xff, 0xff];
const GRAY = [0xc8, 0xcd, 0xd6, 0xff];

function build(size) {
  const buf = Buffer.alloc(size * size * 4);
  const u = (v) => Math.round(v * size);
  const radius = u(0.19);

  const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };

  const set = (i, color) => {
    buf[i] = color[0];
    buf[i + 1] = color[1];
    buf[i + 2] = color[2];
    buf[i + 3] = color[3];
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      if (!inRoundRect(x, y, 0, 0, size - 1, size - 1, radius)) {
        set(i, [0, 0, 0, 0]);
        continue;
      }
      set(i, RED);

      // カレンダー本体（白いカード）
      const cal = inRoundRect(x, y, u(0.17), u(0.21), u(0.83), u(0.83), u(0.06));
      if (!cal) continue;
      set(i, WHITE);

      // ヘッダ帯（カードの内側に赤で乗せる）
      if (y <= u(0.37)) {
        set(i, RED);
        // バインダーの穴を白抜きで表現する
        if (
          (x >= u(0.32) && x <= u(0.38) && y >= u(0.26) && y <= u(0.33)) ||
          (x >= u(0.62) && x <= u(0.68) && y >= u(0.26) && y <= u(0.33))
        ) {
          set(i, WHITE);
        }
        continue;
      }

      // 日付ドット（3列×2行）。1つだけ赤にして「投稿予定日」を表す
      for (let row = 0; row < 2; row += 1) {
        for (let col = 0; col < 3; col += 1) {
          const cx = u(0.3 + col * 0.2);
          const cy = u(0.51 + row * 0.17);
          const r = u(0.052);
          if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
            set(i, row === 0 && col === 1 ? RED : GRAY);
          }
        }
      }
    }
  }
  return png(size, size, buf);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [192, 512]) {
  const file = path.join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, build(size));
  process.stdout.write(`${file}\n`);
}
