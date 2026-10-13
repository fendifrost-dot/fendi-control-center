// Real decode validation for the final image, with bounded memory.
//
// decodeImage (contract.ts) only inspects base64, magic bytes, size and trailer: a 512-byte file made of a JPEG SOI
// and EOI marker passes it (reproduced 13 Oct 2026). This module decodes the pixels for real. The decoder expands to
// RGBA (4 bytes a pixel, measured +67 MB RSS for a 1856x2304 result and +144 MB for 4096x4096 on Deno 2.9), so the
// dimensions are read from the header first and anything above MAX_DECODE_PIXELS is NOT decoded: it is reported as
// received but unverified rather than risking the 256 MB worker. The image bytes are always returned to the caller
// whatever this says: they may have been paid for. The caller distinguishes "received and stored" from "decoded and
// usable" by `usable`.

// Measured on Deno 2.9.7 / imagescript 1.3.0 (independent review, 13 Oct): a 1856x2304 result costs +94-96 MB RSS to
// decode, a 2990x2990 one +134 MB (JPEG) to +200 MB (16-bit PNG). Budget ~22 bytes a pixel, not 4. A 2K result is
// 4.3 MP; 5 MP keeps a worst case near +110 MB on top of the retained base64 and the byte copy.
export const MAX_DECODE_PIXELS = 5_000_000;

// `usable` means: decodes with the decoder this worker ships, to the size the header declares. It does NOT prove the
// picture is complete (a JPEG with fewer scanlines than its header decodes padded; trailing junk after EOI is ignored;
// an APNG decodes as its first frame). Those are quality questions for the reviewer, not integrity failures.
export type DecodeVerdict = {
  usable: boolean;
  decoded: boolean;
  width: number | null;
  height: number | null;
  reason: "ok" | "no_dimensions" | "over_decode_cap" | "decode_failed" | "dimension_mismatch" | "zero_dimension" | "unsupported_format" | "unsupported_bit_depth";
  error?: string;
  ms: number;
};

/** Width/height from the first bytes of a PNG, JPEG or WebP without decoding; null when the header is not one of those. */
export function headerDimensions(b: Uint8Array): { width: number; height: number; kind: "png" | "jpeg" | "webp"; bitDepth?: number } | null {
  const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const u16 = (i: number) => (b[i] << 8) | b[i + 1];
  const u24le = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && String.fromCharCode(b[12], b[13], b[14], b[15]) === "IHDR") {
    return { width: u32(16), height: u32(20), kind: "png", bitDepth: b[24] };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { i += 2; continue; }
      const len = u16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: u16(i + 5), width: u16(i + 7), kind: "jpeg" };
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  if (b.length >= 30 && String.fromCharCode(b[0], b[1], b[2], b[3]) === "RIFF" && String.fromCharCode(b[8], b[9], b[10], b[11]) === "WEBP") {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === "VP8X") return { width: u24le(24) + 1, height: u24le(27) + 1, kind: "webp" };
    if (chunk === "VP8L") return { width: (b[21] | ((b[22] & 0x3f) << 8)) + 1, height: ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)) + 1, kind: "webp" };
    if (chunk === "VP8 ") return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff, kind: "webp" };
  }
  return null;
}

/** The pixel decoder, injectable so unit tests (vitest, no network) can stub it; the default lazily imports imagescript. */
export type PixelDecoder = (bytes: Uint8Array) => Promise<{ width: number; height: number }>;

let real: PixelDecoder | null = null;
export const defaultPixelDecoder: PixelDecoder = async (bytes) => {
  if (!real) {
    const mod = await import("https://deno.land/x/imagescript@1.3.0/mod.ts");
    real = async (b) => { const im = await mod.decode(b); if (!(im instanceof mod.Image)) throw new Error("not a still image"); return { width: im.width, height: im.height }; };
  }
  return real(bytes);
};

/** Verifies the bytes decode to an image whose pixel size matches the header, within the memory cap. Never throws. */
export async function verifyImage(bytes: Uint8Array, decoder: PixelDecoder = defaultPixelDecoder): Promise<DecodeVerdict> {
  const t0 = performance.now(); const ms = () => Math.round(performance.now() - t0);
  const dims = headerDimensions(bytes);
  if (!dims) return { usable: false, decoded: false, width: null, height: null, reason: "no_dimensions", ms: ms() };
  if (dims.width === 0 || dims.height === 0) return { usable: false, decoded: false, width: dims.width, height: dims.height, reason: "zero_dimension", ms: ms() };
  if (dims.width * dims.height > MAX_DECODE_PIXELS) return { usable: false, decoded: false, width: dims.width, height: dims.height, reason: "over_decode_cap", ms: ms() };
  // imagescript 1.3.0 has no WebP decoder (review, 13 Oct): say so instead of reporting a decode failure.
  if (dims.kind === "webp") return { usable: false, decoded: false, width: dims.width, height: dims.height, reason: "unsupported_format", error: "webp: no decoder in this worker", ms: ms() };
  // 16-bit PNG decodes to twice the memory for the same pixel count (+200 MB measured at 9 MP); not worth the worker.
  if (dims.kind === "png" && (dims.bitDepth ?? 8) > 8) return { usable: false, decoded: false, width: dims.width, height: dims.height, reason: "unsupported_bit_depth", error: `png bit depth ${dims.bitDepth}`, ms: ms() };
  try {
    const got = await decoder(bytes);
    if (got.width !== dims.width || got.height !== dims.height) return { usable: false, decoded: true, width: got.width, height: got.height, reason: "dimension_mismatch", error: `header ${dims.width}x${dims.height}`, ms: ms() };
    return { usable: true, decoded: true, width: got.width, height: got.height, reason: "ok", ms: ms() };
  } catch (e) {
    return { usable: false, decoded: false, width: dims.width, height: dims.height, reason: "decode_failed", error: String(e instanceof Error ? e.message : e).slice(0, 120), ms: ms() };
  }
}
