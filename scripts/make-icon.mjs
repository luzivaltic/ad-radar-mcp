#!/usr/bin/env node
/**
 * Renders the Ad Radar icon without any image dependency: draws a radar sweep
 * at 4x and box-downsamples it, then encodes a PNG by hand (zlib + CRC32).
 *
 *   node scripts/make-icon.mjs
 *   -> assets/icon-512.png
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 512;
const SS = 4; // supersampling factor
const W = SIZE * SS;

const BG = [11, 16, 32];
const RING = [45, 212, 191];
const SWEEP = [45, 212, 191];
const DOT = [250, 204, 21];

function hexToRgb([r, g, b], alpha) {
  return [r, g, b, alpha];
}

function blend(dst, src, alpha) {
  const a = Math.max(0, Math.min(1, alpha));
  for (let i = 0; i < 3; i += 1) dst[i] = dst[i] * (1 - a) + src[i] * a;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Points of interest (angle in radians, radius fraction) — "ads" on the radar.
const blips = [
  { a: Math.PI * 0.18, r: 0.52 },
  { a: Math.PI * 0.62, r: 0.74 },
  { a: Math.PI * 0.86, r: 0.38 },
  { a: Math.PI * 1.24, r: 0.63 },
  { a: Math.PI * 1.58, r: 0.84 },
];

function render() {
  const buf = Buffer.alloc(W * W * 4);
  const cx = W / 2;
  const cy = W / 2;
  const maxR = W * 0.44;
  const sweepFrom = -Math.PI * 0.62;
  const sweepTo = -Math.PI * 0.18;

  for (let y = 0; y < W; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);

      let rgb = hexToRgb(BG, 1).slice(0, 3);

      // Radar face: subtle radial lift inside the rings.
      if (dist < maxR) {
        const lift = 0.06 * (1 - dist / maxR);
        rgb = rgb.map((v) => v + 255 * lift * 0.12);
      }

      // Concentric rings (widths are in display pixels, so scale by SS).
      for (const frac of [0.34, 0.62, 0.9]) {
        const ringR = maxR * frac;
        const d = Math.abs(dist - ringR);
        blend(rgb, RING, 0.85 * (1 - smoothstep(1.2 * SS, 3.0 * SS, d)));
      }

      // Sweep wedge with a fading trail.
      if (dist < maxR && angle >= sweepFrom && angle <= sweepTo) {
        const t = (angle - sweepFrom) / (sweepTo - sweepFrom);
        blend(rgb, SWEEP, 0.55 * Math.pow(t, 1.2));
      }

      // Leading edge of the sweep.
      if (dist < maxR) {
        const edgeDist = Math.abs(angle - sweepTo) * Math.min(dist, maxR - 1);
        blend(rgb, SWEEP, 0.9 * (1 - smoothstep(1.0 * SS, 3.0 * SS, edgeDist)));
      }

      // Radar blips.
      for (const b of blips) {
        const bx = cx + Math.cos(b.a) * maxR * b.r;
        const by = cy + Math.sin(b.a) * maxR * b.r;
        const d = Math.hypot(x - bx, y - by);
        blend(rgb, DOT, 1 - smoothstep(3.0 * SS, 6.5 * SS, d));
      }

      // Center hub.
      const hub = 1 - smoothstep(5 * SS, 7 * SS, dist);
      blend(rgb, RING, hub);

      const i = (y * W + x) * 4;
      buf[i] = Math.round(rgb[0]);
      buf[i + 1] = Math.round(rgb[1]);
      buf[i + 2] = Math.round(rgb[2]);
      buf[i + 3] = 255;
    }
  }

  // Box downsample to 512.
  const out = Buffer.alloc(SIZE * SIZE * 4);
  const n = SS * SS;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          r += buf[i];
          g += buf[i + 1];
          b += buf[i + 2];
        }
      }
      const o = (y * SIZE + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "assets", "icon-512.png");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, encodePng(render(), SIZE, SIZE));
console.log(`wrote ${outPath}`);
