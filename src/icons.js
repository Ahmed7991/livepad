// PNG icons drawn at runtime. Android needs PNG (not SVG) to install the app, which is what makes share work.
const LINES = [[28, 72, 30], [28, 72, 46], [28, 56, 62]];

function crc32(b) {
  let c = -1;
  for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; }
  return ~c >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(data.length + 12), v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  v.setUint32(data.length + 8, crc32(out.subarray(4, data.length + 8)));
  return out;
}

// Full-bleed blue square: the launcher applies its own rounded mask.
// Palette PNG (0 = blue … 255 = white), so only the line pixels need computing.
export async function icon(n) {
  const raw = new Uint8Array((n + 1) * n), u = n / 100;
  for (const [x1, x2, ly] of LINES) {
    for (let y = Math.floor((ly - 1) * u); y < (ly + 9) * u; y++) {
      for (let x = Math.floor((x1 - 5) * u); x < (x2 + 5) * u; x++) {
        const px = (x + 0.5) / u, dx = px - Math.min(Math.max(px, x1), x2), dy = (y + 0.5) / u - ly - 4;
        const a = (4 - Math.sqrt(dx * dx + dy * dy)) * u + 0.5;
        if (a > 0) raw[y * (n + 1) + 1 + x] = Math.round(255 * Math.min(1, a));
      }
    }
  }
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) pal.set([37 + 218 * i / 255, 99 + 156 * i / 255, 235 + 20 * i / 255], i * 3);
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const head = new Uint8Array(13), v = new DataView(head.buffer);
  v.setUint32(0, n); v.setUint32(4, n); head[8] = 8; head[9] = 3;
  return new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("PLTE", pal), chunk("IDAT", z), chunk("IEND", new Uint8Array(0))]);
}
