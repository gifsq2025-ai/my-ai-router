// Generates the extension icons. Pure Node, no dependencies:
//   node tools/make-icons.mjs
// Writes a rounded dark square with a light play triangle into icons/icon{16,48,128}.png.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, pixelAt) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y, size);
      const offset = rowStart + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Rounded-square badge, play triangle, small subtitle bar.
function pixelAt(x, y, size) {
  const u = x / size;
  const v = y / size;
  const radius = 0.22;
  const corner =
    (u < radius && v < radius && (u - radius) ** 2 + (v - radius) ** 2 > radius ** 2) ||
    (u > 1 - radius && v < radius && (u - (1 - radius)) ** 2 + (v - radius) ** 2 > radius ** 2) ||
    (u < radius && v > 1 - radius && (u - radius) ** 2 + (v - (1 - radius)) ** 2 > radius ** 2) ||
    (u > 1 - radius && v > 1 - radius && (u - (1 - radius)) ** 2 + (v - (1 - radius)) ** 2 > radius ** 2);
  if (corner) return [0, 0, 0, 0];

  // Play triangle centred slightly left of middle.
  const cx = 0.46;
  const cy = 0.45;
  const half = 0.2;
  const dx = u - (cx - half * 0.6);
  const dy = Math.abs(v - cy);
  const inTriangle = dx >= 0 && dx <= half * 1.6 && dy <= half * (1 - dx / (half * 1.6));
  if (inTriangle) return [255, 255, 255, 255];

  // Caption bar under the triangle.
  if (v > 0.74 && v < 0.82 && u > 0.28 && u < 0.72) return [232, 234, 237, 220];

  const shade = 0.16 + 0.1 * (1 - v);
  return [Math.round(79 * shade * 3.4), Math.round(140 * shade * 3.2), Math.round(255 * shade * 2.1), 255];
}

for (const size of [16, 48, 128]) {
  const file = join(outDir, `icon${size}.png`);
  writeFileSync(file, png(size, pixelAt));
  console.log(`wrote ${file}`);
}
