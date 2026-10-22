// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// The extension's Marketplace icon is images/icon.png, the session-exchange.com logo (128x128 PNG).
// This script renders media/icon.png, the a4sx mark on a transparent background: the activity-bar icon.
// Renders media/icon.png (128x128) from the a4sx mark in ui/public/favicon.svg, with no image tools needed.
// Run: node scripts/make-icon.mjs. Even-odd fill over all three sub-paths, 4x4 supersampling.
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

const SIZE = 128, VIEW = 64, SS = 4;
const COLOR = [0x24, 0x58, 0xd3];
// The three sub-paths of the favicon's path, as polygons in the 64x64 viewBox.
const POLYS = [
  [[4, 4], [40, 4], [60, 24], [60, 60], [24, 60], [4, 40]],
  [[17, 17], [17, 35], [29, 47], [47, 47], [47, 29], [35, 17]],
  [[47, 29], [60, 42], [60, 54], [47, 41]],
];

function crossings(poly, x, y) {
  let n = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) n++;
  }
  return n;
}
const inside = (x, y) => POLYS.reduce((n, p) => n + crossings(p, x, y), 0) % 2 === 1;

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let py = 0; py < SIZE; py++) {
  raw[py * (SIZE * 4 + 1)] = 0; // filter: none
  for (let px = 0; px < SIZE; px++) {
    let hits = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const x = ((px + (sx + 0.5) / SS) * VIEW) / SIZE, y = ((py + (sy + 0.5) / SS) * VIEW) / SIZE;
      if (inside(x, y)) hits++;
    }
    const o = py * (SIZE * 4 + 1) + 1 + px * 4;
    raw[o] = COLOR[0]; raw[o + 1] = COLOR[1]; raw[o + 2] = COLOR[2];
    raw[o + 3] = Math.round((255 * hits) / (SS * SS));
  }
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
]);
mkdirSync(new URL("../media/", import.meta.url), { recursive: true });
writeFileSync(new URL("../media/icon.png", import.meta.url), png);
console.log(`media/icon.png: ${png.length} bytes`);
