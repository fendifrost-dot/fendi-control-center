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
export function sniffMime(
  buf: Uint8Array,
): "image/png" | "image/jpeg" | "image/webp" | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------
export function buildBasePhotoPrompt(
  trigger: string,
  base: string,
  styling: string | undefined,
): string {
  const triggerClause = trigger ? `${trigger}, ` : "";
  const stylingClause = styling ? `, ${styling}` : "";
  return `${triggerClause}photorealistic portrait, neutral expression, studio lighting, flexible pose, full body visible, clean background, ${base}${stylingClause}`;
}

export function buildComposePrompt(
  base: string,
  styling: string | undefined,
  wardrobe: ResolvedFeatureLite[],
  jewelry: ResolvedFeatureLite[],
  hasLocation: boolean,
): string {
  const wardrobeNames = wardrobe.map((w) => w.label).filter(Boolean).join(", ");
  const jewelryNames = jewelry.map((j) => j.label).filter(Boolean).join(", ");
  const stylingClause = styling ? ` Styling: ${styling}.` : "";
  const wardrobeClause = wardrobeNames
    ? ` Dress him in the exact outfit shown in the wardrobe reference images: ${wardrobeNames}.`
    : "";
  const jewelryClause = jewelryNames
    ? ` Apply the jewelry shown in the reference images: ${jewelryNames}.`
    : "";
  const locationClause = hasLocation
    ? " Place him in the location shown in the location reference image."
    : "";
  return (
    `Take the man in image 1 and ${
      hasLocation ? "place him in the location" : "compose a new portrait"
    } with photorealistic detail, preserving his identity, face, body shape, skin and tattoos exactly.${wardrobeClause}${jewelryClause}${locationClause}${stylingClause} ${base}`
  );
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
  | "kontext_multi";

export function decidePipeline(
  requested: PipelineMode,
  hasLora: boolean,
): Exclude<PipelineMode, "auto"> {
  if (requested === "auto") return hasLora ? "lora_seedream" : "seedream_only";
  if (requested === "lora_seedream" && !hasLora) return "seedream_only";
  return requested;
}
