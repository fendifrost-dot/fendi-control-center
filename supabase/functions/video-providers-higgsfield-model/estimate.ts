/**
 * Higgsfield catalogue proxy: the cost ESTIMATE arithmetic and the Seedance 2.5 list prices.
 *
 * `index.ts` is glue (auth, env, fetch, logging). The estimate is decidable without I/O, so it
 * lives here and is tested directly (the same split `video-providers-runway-video-edit/contract.ts` uses).
 * Nothing in this file touches the request body sent to the provider: these numbers only feed
 * `costEstimateCents` on the response. The organisation balance is authoritative.
 */

/** `resolution` value → cents per billed second. */
export type RateTable = Record<string, number>;

// Seedance 2.5 list prices (ByteDance via Higgsfield), read on 27 Nov 2026 from
//   https://open.higgsfield.ai/models/bytedance/seedance-2.5/video-edit/playground
//   https://open.higgsfield.ai/models/bytedance/seedance-2.5/reference-to-video/playground
// USD per second of video: with a video in the request 480p $0.1387 · 720p $0.3264 · 1080p $0.7858;
// images or audio only 480p $0.1177 · 720p $0.2647 · 1080p $0.6518.
// The source or reference video's own seconds are NOT billed in addition.
/** Video edit, and reference-to-video WITH at least one video reference. */
export const SEEDANCE_25_CENTS_WITH_VIDEO: RateTable = { "480p": 13.87, "720p": 32.64, "1080p": 78.58 };
/** Reference-to-video with image and/or audio references only (no video reference). */
export const SEEDANCE_25_CENTS_NO_VIDEO: RateTable = { "480p": 11.77, "720p": 26.47, "1080p": 65.18 };

/** The part of a catalogue ModelSpec the estimate reads. */
export type EstimateSpec = {
  mode: "text_to_video" | "image_to_video" | "video_to_video" | "reference_to_video" | "image_edit";
  centsPerSecond: number;
  resolutions?: RateTable;
  resolutionsNoVideo?: RateTable;
  centsPerImage?: RateTable;
};

/**
 * Cents per billed second (per image for image_edit) for one request.
 * `referenceVideoCount` matters only to a reference-to-video model that carries `resolutionsNoVideo`:
 * with no video reference that cheaper table applies; every other model ignores it.
 */
export function estimateRateCents(spec: EstimateSpec, resolution: string | undefined, referenceVideoCount = 0): number {
  if (spec.mode === "image_edit" && spec.centsPerImage && resolution) return spec.centsPerImage[resolution];
  if ((spec.mode === "video_to_video" || spec.mode === "reference_to_video") && spec.resolutions && resolution) {
    if (spec.mode === "reference_to_video" && spec.resolutionsNoVideo && referenceVideoCount === 0) return spec.resolutionsNoVideo[resolution];
    return spec.resolutions[resolution];
  }
  return spec.centsPerSecond;
}

/** `costEstimateCents`: the rate × the billed seconds (1 for an image), rounded to a whole cent. */
export function estimateCostCents(spec: EstimateSpec, resolution: string | undefined, billedSeconds: number, referenceVideoCount = 0): number {
  return Math.round(estimateRateCents(spec, resolution, referenceVideoCount) * billedSeconds);
}
