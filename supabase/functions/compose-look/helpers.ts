// Pure helpers extracted from the compose-look edge function so they can be
// unit tested without Deno HTTP server boot.

export type ResolvedFeatureLite = {
  label: string;
  feature_type?: string;
};

// ---------------------------------------------------------------------------
// constantTimeEqual — constant-time string compare for the shared secret
// ---------------------------------------------------------------------------
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// sniffMime — magic-byte image MIME detection
// ---------------------------------------------------------------------------
export function sniffMime(buf: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------
export function buildBasePhotoPrompt(trigger: string, base: string, styling: string | undefined): string {
  const triggerClause = trigger ? `${trigger}, ` : "";
  const stylingClause = styling ? `, ${styling}` : "";
  return `${triggerClause}photorealistic portrait, neutral expression, studio lighting, flexible pose, full body visible, clean background, ${base}${stylingClause}`;
}

/** Taller FLUX-LoRA canvas for segmented inpaint — room for head-to-toe SAM-3 masks. */
export const SEGMENTED_INPAINT_FLUX_IMAGE_SIZE = {
  width: 832,
  height: 1216,
} as const;

const SEGMENTED_INPAINT_FULL_BODY_SUFFIX =
  "Full body shot, head to toe visible, feet visible at the bottom of the frame, standing pose facing camera or three-quarter angle. Do NOT crop above the knees. Do NOT render as a portrait or upper-body shot. The entire subject from head to feet must be in frame.";

/** Stage-1 prompt for lora_segmented_inpaint only.
 *
 * IMPORTANT: this intentionally IGNORES the full base prompt's identity preamble.
 * The base prompt's skin descriptions historically biased FLUX toward shirtless
 * renders, leaving SAM-3 nothing to mask. Instead, Stage 1 here produces a clean
 * fully-clothed body in placeholder neutral garments; the per-garment FLUX-fill
 * stages then inpaint the actual wardrobe references over those placeholders,
 * and the seedream accessories polish handles glasses + identity touch-ups at
 * the end. (Tattoo enumeration has been removed from the upstream preamble in
 * the proxy — see compose-look-proxy/helpers.ts.)
 */
export function buildSegmentedInpaintStage1Prompt(
  trigger: string,
  _base: string,
  _styling: string | undefined,
): string {
  const triggerClause = trigger ? `${trigger}, ` : "";
  return `${triggerClause}photorealistic full-body photograph of an adult man wearing a fully-zipped dark zip-up bomber jacket. The jacket is clearly visible covering the entire torso, sleeves down to the wrist, hem at the hip. Under the jacket is a plain white crew-neck t-shirt. Pants are dark blue denim jeans. Casual sneakers. Front-facing the camera with face clearly visible, standing pose with arms relaxed at the sides, clean light gray studio background, soft natural lighting, fully clothed, head to toe visible, feet visible at the bottom of the frame. The jacket must be visible — do not omit it. ${SEGMENTED_INPAINT_FULL_BODY_SUFFIX}`;
}

export function buildComposePrompt(
  base: string,
  styling: string | undefined,
  wardrobe: ResolvedFeatureLite[],
  jewelry: ResolvedFeatureLite[],
  hasLocation: boolean,
): string {
  const wardrobeNames = wardrobe
    .map((w) => w.label)
    .filter(Boolean)
    .join(", ");
  const jewelryNames = jewelry
    .map((j) => j.label)
    .filter(Boolean)
    .join(", ");
  const stylingClause = styling ? ` Styling: ${styling}.` : "";
  const wardrobeClause = wardrobeNames
    ? ` Dress him in the exact outfit shown in the wardrobe reference images: ${wardrobeNames}.`
    : "";
  const jewelryClause = jewelryNames ? ` Apply the jewelry shown in the reference images: ${jewelryNames}.` : "";
  const locationClause = hasLocation ? " Place him in the location shown in the location reference image." : "";
  return `Take the man in image 1 and ${
    hasLocation ? "place him in the location" : "compose a new portrait"
  } with photorealistic detail, preserving his identity, face, body shape, and skin exactly.${wardrobeClause}${jewelryClause}${locationClause}${stylingClause} ${base}`;
}

export function defaultLookName(wardrobe: ResolvedFeatureLite[]): string {
  const labels = wardrobe.map((w) => w.label).filter(Boolean);
  if (labels.length === 0) return "Untitled look";
  return labels.slice(0, 2).join(" + ");
}

// ---------------------------------------------------------------------------
// Pipeline decision (factored out so tests don't have to mock the artist)
// ---------------------------------------------------------------------------
export type PipelineMode =
  | "auto"
  | "lora_seedream"
  | "seedream_only"
  | "kontext_multi"
  | "lora_idm_vton"
  | "lora_segmented_inpaint";

/** Stage 2 / Seedream text; falls back for older proxies that only sent basePrompt. */
export function resolveComposePrompt(recipe: { basePrompt: string; composePrompt?: string | null }): string {
  const compose = recipe.composePrompt?.trim();
  return compose && compose.length >= 4 ? compose : recipe.basePrompt;
}

// VTON chain: pants → shirt → jacket so outerwear overlays last.
const WARDROBE_VTON_ORDER: Record<string, number> = {
  wardrobe_bottom: 0,
  wardrobe_top: 1,
  wardrobe_outerwear: 2,
};

export function sortGarmentsForVtonChain<T extends { feature_type: string }>(garments: T[]): T[] {
  return [...garments].sort(
    (a, b) => (WARDROBE_VTON_ORDER[a.feature_type] ?? 99) - (WARDROBE_VTON_ORDER[b.feature_type] ?? 99),
  );
}

export function decidePipeline(requested: PipelineMode, hasLora: boolean): Exclude<PipelineMode, "auto"> {
  // Auto follows the proven pipeline: segmented inpaint preserved identity in
  // every approved look (May 2026 bake-off); lora_seedream's Seedream re-render
  // destroys likeness and is now opt-in only.
  if (requested === "auto") return hasLora ? "lora_segmented_inpaint" : "seedream_only";
  if (requested === "lora_seedream" && !hasLora) return "seedream_only";
  // lora_idm_vton requires a LoRA for the Stage 1 base photo; without one,
  // there's no canonical human image for VTON to overlay. Fall back to
  // seedream_only same as lora_seedream does.
  if (requested === "lora_idm_vton" && !hasLora) return "seedream_only";
  if (requested === "lora_segmented_inpaint" && !hasLora) return "seedream_only";
  return requested;
}
