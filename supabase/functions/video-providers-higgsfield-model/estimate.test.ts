// deno test --allow-none video-providers-higgsfield-model/estimate.test.ts
//
// Covers the cost-estimate arithmetic of the Higgsfield catalogue proxy: the Seedance 2.5 list
// prices (read 27 Nov 2026 from open.higgsfield.ai), the with-video / no-video split on
// reference-to-video, and that every other mode is priced exactly as before. `index.ts` is glue
// over these functions; no network, no provider call.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  SEEDANCE_25_CENTS_NO_VIDEO,
  SEEDANCE_25_CENTS_WITH_VIDEO,
  estimateCostCents,
  estimateRateCents,
  type EstimateSpec,
} from "./estimate.ts";

// The same shapes index.ts gives these variants in its MODELS table.
const seedanceEdit: EstimateSpec = { mode: "video_to_video", centsPerSecond: 32.64, resolutions: SEEDANCE_25_CENTS_WITH_VIDEO, minBilledSeconds: 4 };
const seedanceReference: EstimateSpec = { mode: "reference_to_video", centsPerSecond: 32.64, resolutions: SEEDANCE_25_CENTS_WITH_VIDEO, resolutionsNoVideo: SEEDANCE_25_CENTS_NO_VIDEO };
const genjutsu: EstimateSpec = { mode: "video_to_video", centsPerSecond: 68.1, resolutions: { "480p": 31.8, "720p": 68.1, "1080p": 163.2 } };
const kling: EstimateSpec = { mode: "text_to_video", centsPerSecond: 7 };
const grokImage: EstimateSpec = { mode: "image_edit", centsPerSecond: 0, centsPerImage: { "1k": 7, "2k": 14 } };

Deno.test("Seedance 2.5 tables are the published rates, in cents per second", () => {
  assertEquals(SEEDANCE_25_CENTS_WITH_VIDEO, { "480p": 13.87, "720p": 32.64, "1080p": 78.58 });
  assertEquals(SEEDANCE_25_CENTS_NO_VIDEO, { "480p": 11.77, "720p": 26.47, "1080p": 65.18 });
  // the same resolution names in both, so validation (which reads the keys of `resolutions`) is unchanged
  assertEquals(Object.keys(SEEDANCE_25_CENTS_NO_VIDEO), Object.keys(SEEDANCE_25_CENTS_WITH_VIDEO));
});

Deno.test("Seedance 2.5 video edit: the with-video rate per source second", () => {
  assertEquals(estimateCostCents(seedanceEdit, "480p", 4, 1), 55);     // 4 × 13.87 = 55.48
  assertEquals(estimateCostCents(seedanceEdit, "720p", 4, 1), 131);    // 4 × 32.64 = 130.56
  assertEquals(estimateCostCents(seedanceEdit, "1080p", 4, 1), 314);   // 4 × 78.58 = 314.32
  assertEquals(estimateCostCents(seedanceEdit, "720p", 30, 1), 979);   // 30 × 32.64 = 979.2
});

Deno.test("Seedance 2.5 video edit: the reference-video count never changes its rate", () => {
  // index.ts passes refVideos.length; an edit has no no-video table, so 0 and 1 price the same
  assertEquals(estimateCostCents(seedanceEdit, "480p", 4, 0), 55);
  assertEquals(estimateRateCents(seedanceEdit, "720p"), 32.64);
});

Deno.test("Seedance 2.5 video edit: never estimated below the provider's 4 billed seconds", () => {
  // index.ts hands over pickDuration's value: 1 when the caller omits `duration`, else the declared length rounded up
  assertEquals(estimateCostCents(seedanceEdit, "480p", 1, 1), 55);     // floored to 4 × 13.87 = 55.48
  assertEquals(estimateCostCents(seedanceEdit, "720p", 1, 1), 131);    // floored to 4 × 32.64 = 130.56
  assertEquals(estimateCostCents(seedanceEdit, "480p", 3, 1), 55);
  assertEquals(estimateCostCents(seedanceEdit, "480p", 4, 1), 55);     // at the floor: unchanged
  assertEquals(estimateCostCents(seedanceEdit, "480p", 6, 1), 83);     // above the floor: 6 × 13.87 = 83.22, unchanged
  assertEquals(estimateCostCents(seedanceEdit, "720p", 6, 1), 196);    // 6 × 32.64 = 195.84
});

Deno.test("the 4-second floor belongs to the edit only: Genjutsu and Seedance reference keep their seconds", () => {
  assertEquals(estimateCostCents(genjutsu, "480p", 1, 1), 32);             // 1 × 31.8, no floor
  assertEquals(estimateCostCents(genjutsu, "720p", 1, 1), 68);             // 1 × 68.1
  assertEquals(estimateCostCents(genjutsu, "720p", 3, 1), 204);            // 3 × 68.1 = 204.3
  assertEquals(estimateCostCents(seedanceReference, "720p", 1, 1), 33);    // the function floors nothing here (index.ts clamps 4–30 itself)
  assertEquals(estimateCostCents(seedanceReference, "720p", 1, 0), 26);    // 1 × 26.47
  assertEquals(estimateCostCents(seedanceReference, "720p", 4, 1), 131);
  assertEquals(estimateCostCents(seedanceReference, "720p", 4, 0), 106);
  assertEquals(estimateCostCents(kling, undefined, 1, 0), 7);
  assertEquals(estimateCostCents(grokImage, "2k", 1, 0), 14);
});

Deno.test("Seedance 2.5 reference-to-video: with a video reference, the with-video rate", () => {
  assertEquals(estimateCostCents(seedanceReference, "480p", 4, 1), 55);
  assertEquals(estimateCostCents(seedanceReference, "720p", 4, 1), 131);    // 4 × 32.64 = 130.56
  assertEquals(estimateCostCents(seedanceReference, "1080p", 4, 1), 314);
  assertEquals(estimateCostCents(seedanceReference, "720p", 4, 10), 131);   // more reference videos, the same rate
});

Deno.test("Seedance 2.5 reference-to-video: images or audio only, the no-video rate", () => {
  assertEquals(estimateCostCents(seedanceReference, "480p", 4, 0), 47);     // 4 × 11.77 = 47.08
  assertEquals(estimateCostCents(seedanceReference, "720p", 4, 0), 106);    // 4 × 26.47 = 105.88
  assertEquals(estimateCostCents(seedanceReference, "1080p", 4, 0), 261);   // 4 × 65.18 = 260.72
  assertEquals(estimateCostCents(seedanceReference, "720p", 4), 106);       // count omitted = no video reference
});

Deno.test("reference videos' own seconds are not added: the estimate is rate × output seconds", () => {
  // a 5 s output with ten reference videos is still 5 billed seconds
  assertEquals(estimateCostCents(seedanceReference, "720p", 5, 10), Math.round(32.64 * 5));
  assertEquals(estimateCostCents(seedanceReference, "720p", 5, 10), 163);
});

Deno.test("other models are priced exactly as before", () => {
  assertEquals(estimateCostCents(genjutsu, "480p", 4, 1), 127);      // 4 × 31.8 = 127.2
  assertEquals(estimateCostCents(genjutsu, "720p", 5, 1), 341);      // 5 × 68.1 = 340.5 → 341 (float: 340.5 rounds up)
  assertEquals(estimateCostCents(genjutsu, "720p", 5, 0), 341);      // no no-video table: the count is ignored
  assertEquals(estimateCostCents(kling, undefined, 5, 0), 35);       // flat cents per second
  assertEquals(estimateCostCents(kling, undefined, 10, 0), 70);
  assertEquals(estimateCostCents(grokImage, "1k", 1, 0), 7);         // per image by tier
  assertEquals(estimateCostCents(grokImage, "2k", 1, 0), 14);
});

Deno.test("a model with no table for its mode falls back to centsPerSecond", () => {
  assertEquals(estimateRateCents({ mode: "video_to_video", centsPerSecond: 9 }, "720p", 1), 9);
  assertEquals(estimateRateCents({ mode: "reference_to_video", centsPerSecond: 9 }, undefined, 0), 9);
});
