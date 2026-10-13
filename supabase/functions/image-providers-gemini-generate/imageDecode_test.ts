// Real-decoder tests (Deno, network for the imagescript import): deno test --allow-net --allow-read imageDecode_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";
import { MAX_DECODE_PIXELS, headerDimensions, verifyImage } from "./imageDecode.ts";

Deno.test("a real JPEG and a real PNG decode and are usable", async () => {
  const im = new Image(320, 200).fill(0x336699ff);
  const jpg = await verifyImage(await im.encodeJPEG(80)); assertEquals([jpg.usable, jpg.reason, jpg.width, jpg.height], [true, "ok", 320, 200]);
  const png = await verifyImage(await im.encode()); assertEquals([png.usable, png.reason, png.width, png.height], [true, "ok", 320, 200]);
});
Deno.test("the 512-byte fabricated JPEG (SOI + EOI) is received but NOT usable", async () => {
  const b = new Uint8Array(512); b.set([0xff, 0xd8, 0xff, 0xe0]); b.set([0xff, 0xd9], 510);
  const v = await verifyImage(b); assertEquals(v.usable, false); assertEquals(v.reason, "no_dimensions"); // no SOF: not even a header
  const sof = new Uint8Array(512); sof.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 200, 1, 64, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]); sof.set([0xff, 0xd9], 510);
  const v2 = await verifyImage(sof); assertEquals([v2.usable, v2.decoded, v2.reason, v2.width, v2.height], [false, false, "decode_failed", 320, 200]); // a header claiming 320x200 with no scan data
});
Deno.test("a truncated real JPEG is not usable", async () => {
  const full = await new Image(640, 480).fill(0xaa5533ff).encodeJPEG(70);
  const v = await verifyImage(full.subarray(0, Math.floor(full.length * 0.5))); assertEquals([v.usable, v.reason], [false, "decode_failed"]);
});
Deno.test("a header declaring more pixels than the cap is not decoded at all (bounded memory)", async () => {
  const png = new Uint8Array(4096); png.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0x75, 0x30, 0, 0, 0x75, 0x30, 8, 6, 0, 0, 0]);
  let called = false; const v = await verifyImage(png, async () => { called = true; return { width: 1, height: 1 }; });
  assertEquals([v.usable, v.decoded, v.reason, called], [false, false, "over_decode_cap", false]);
  assertEquals(30000 * 30000 > MAX_DECODE_PIXELS, true);
});
Deno.test("a decoder that reports a different size than the header is a mismatch, not usable", async () => {
  const jpg = await new Image(64, 64).fill(0x00ff00ff).encodeJPEG(80);
  const v = await verifyImage(jpg, async () => ({ width: 65, height: 64 })); assertEquals([v.usable, v.decoded, v.reason], [false, true, "dimension_mismatch"]);
});
Deno.test("headerDimensions reads PNG, JPEG and WebP and rejects other bytes", () => {
  assertEquals(headerDimensions(new Uint8Array(32)), null);
  const webp = new Uint8Array(32); webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0, 0x3f, 0x07, 0, 0xff, 0x08, 0]);
  assertEquals(headerDimensions(webp), { width: 0x0740, height: 0x08ff + 1, kind: "webp" });
});
