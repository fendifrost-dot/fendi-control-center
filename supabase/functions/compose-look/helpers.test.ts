// deno test --allow-none compose-look/helpers.test.ts
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildBasePhotoPrompt,
  buildComposePrompt,
  buildSegmentedInpaintStage1Prompt,
  constantTimeEqual,
  decidePipeline,
  defaultLookName,
  sniffMime,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// constantTimeEqual
// ---------------------------------------------------------------------------
Deno.test("constantTimeEqual — equal strings", () => {
  assert(constantTimeEqual("abc123", "abc123"));
});

Deno.test("constantTimeEqual — differing strings", () => {
  assert(!constantTimeEqual("abc123", "abc124"));
});

Deno.test("constantTimeEqual — different lengths return false fast", () => {
  assert(!constantTimeEqual("short", "much-longer-string"));
});

Deno.test("constantTimeEqual — empty strings are equal", () => {
  assert(constantTimeEqual("", ""));
});

// ---------------------------------------------------------------------------
// sniffMime — magic-byte detection
// ---------------------------------------------------------------------------
Deno.test("sniffMime — JPEG", () => {
  const buf = new Uint8Array(16);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  assertEquals(sniffMime(buf), "image/jpeg");
});

Deno.test("sniffMime — PNG", () => {
  const buf = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x00,
  ]);
  assertEquals(sniffMime(buf), "image/png");
});

Deno.test("sniffMime — WEBP", () => {
  const buf = new Uint8Array(16);
  // "RIFF" header
  buf[0] = 0x52; buf[1] = 0x49; buf[2] = 0x46; buf[3] = 0x46;
  // sizes at 4..8 don't matter
  // "WEBP" tag
  buf[8] = 0x57; buf[9] = 0x45; buf[10] = 0x42; buf[11] = 0x50;
  assertEquals(sniffMime(buf), "image/webp");
});

Deno.test("sniffMime — too short returns null", () => {
  assertEquals(sniffMime(new Uint8Array([1, 2, 3])), null);
});

Deno.test("sniffMime — unknown bytes return null", () => {
  const buf = new Uint8Array(16);
  for (let i = 0; i < 16; i++) buf[i] = 0x55;
  assertEquals(sniffMime(buf), null);
});

// ---------------------------------------------------------------------------
// buildBasePhotoPrompt
// ---------------------------------------------------------------------------
Deno.test("buildBasePhotoPrompt — includes trigger word and base prompt", () => {
  const p = buildBasePhotoPrompt("FENDIFROST", "chrome luxe streetwear", "shirt tucked");
  assertStringIncludes(p, "FENDIFROST");
  assertStringIncludes(p, "chrome luxe streetwear");
  assertStringIncludes(p, "shirt tucked");
  assertStringIncludes(p, "photorealistic portrait");
});

Deno.test("buildBasePhotoPrompt — omits empty trigger", () => {
  const p = buildBasePhotoPrompt("", "chrome luxe", undefined);
  // should not start with ", " from an empty trigger
  assert(!p.startsWith(", "));
  assertStringIncludes(p, "chrome luxe");
});

Deno.test("buildSegmentedInpaintStage1Prompt — requires head-to-toe framing", () => {
  const p = buildSegmentedInpaintStage1Prompt("FENDI", "editorial", undefined);
  assertStringIncludes(p, "head to toe visible");
  assertStringIncludes(p, "Do NOT crop above the knees");
  assertStringIncludes(p, "editorial");
});

// ---------------------------------------------------------------------------
// buildComposePrompt
// ---------------------------------------------------------------------------
Deno.test("buildComposePrompt — names wardrobe + jewelry", () => {
  const p = buildComposePrompt(
    "moody studio light",
    "shirt tucked",
    [
      { label: "YSL pinstripe jacket", feature_type: "wardrobe_outerwear" },
      { label: "white poplin shirt", feature_type: "wardrobe_top" },
    ],
    [{ label: "Cuban chain", feature_type: "jewelry" }],
    false,
  );
  assertStringIncludes(p, "image 1");
  assertStringIncludes(p, "YSL pinstripe jacket");
  assertStringIncludes(p, "white poplin shirt");
  assertStringIncludes(p, "Cuban chain");
  assertStringIncludes(p, "shirt tucked");
});

Deno.test("buildComposePrompt — mentions location when present", () => {
  const p = buildComposePrompt(
    "golden hour",
    undefined,
    [{ label: "denim jacket" }],
    [],
    true,
  );
  assertStringIncludes(p, "location");
});

Deno.test("buildComposePrompt — handles no wardrobe gracefully", () => {
  const p = buildComposePrompt("just a portrait", undefined, [], [], false);
  // No wardrobe clause when empty
  assert(!p.includes("Dress him"));
  assertStringIncludes(p, "preserving his identity");
});

// ---------------------------------------------------------------------------
// defaultLookName
// ---------------------------------------------------------------------------
Deno.test("defaultLookName — joins first two wardrobe labels", () => {
  assertEquals(
    defaultLookName([
      { label: "YSL jacket" },
      { label: "white shirt" },
      { label: "denim jeans" },
    ]),
    "YSL jacket + white shirt",
  );
});

Deno.test("defaultLookName — single wardrobe item", () => {
  assertEquals(defaultLookName([{ label: "Chrome Hearts hoodie" }]), "Chrome Hearts hoodie");
});

Deno.test("defaultLookName — empty wardrobe returns placeholder", () => {
  assertEquals(defaultLookName([]), "Untitled look");
});

// ---------------------------------------------------------------------------
// decidePipeline
// ---------------------------------------------------------------------------
Deno.test("decidePipeline — auto with LoRA picks lora_seedream", () => {
  assertEquals(decidePipeline("auto", true), "lora_seedream");
});
Deno.test("decidePipeline — auto without LoRA picks seedream_only", () => {
  assertEquals(decidePipeline("auto", false), "seedream_only");
});
Deno.test("decidePipeline — explicit lora_seedream downgrades when no LoRA", () => {
  assertEquals(decidePipeline("lora_seedream", false), "seedream_only");
});
Deno.test("decidePipeline — explicit kontext_multi is honoured", () => {
  assertEquals(decidePipeline("kontext_multi", true), "kontext_multi");
});
Deno.test("decidePipeline — explicit seedream_only is honoured", () => {
  assertEquals(decidePipeline("seedream_only", true), "seedream_only");
});
Deno.test("decidePipeline — explicit lora_idm_vton with LoRA is honoured", () => {
  assertEquals(decidePipeline("lora_idm_vton", true), "lora_idm_vton");
});
Deno.test("decidePipeline — explicit lora_idm_vton downgrades when no LoRA", () => {
  assertEquals(decidePipeline("lora_idm_vton", false), "seedream_only");
});
Deno.test("decidePipeline — explicit lora_segmented_inpaint with LoRA is honoured", () => {
  assertEquals(decidePipeline("lora_segmented_inpaint", true), "lora_segmented_inpaint");
});
Deno.test("decidePipeline — explicit lora_segmented_inpaint downgrades when no LoRA", () => {
  assertEquals(decidePipeline("lora_segmented_inpaint", false), "seedream_only");
});
