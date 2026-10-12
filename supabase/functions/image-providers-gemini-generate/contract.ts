// Direct Google billing. Never substitute a Runway/Higgsfield alias for this model.
// Sources and limits: docs/HANDOFF_GEMINI_STILLS.md (11 Oct 2026).
export const MODEL = "gemini-nano-banana-2.1";
export const MAX_REFERENCES = 14;
export const MAX_INPUT_TOKENS = 16_384;
export const MAX_OUTPUT_TOKENS = 4_096;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_REFERENCE_BYTES = 12 * 1024 * 1024;
// Conservative list-rate ceiling, NOT an invoice: all output tokens priced at the
// highest modality rate, including thinking. countTokens must succeed before spend.
export const COST_BOUND_USD = (MAX_INPUT_TOKENS * 1.5 + MAX_OUTPUT_TOKENS * 30) / 1e6;
export const COST_BASIS = "Google list rates 2026-10-11; input <=16384 at $1.50/M, all output <=4096 at $30/M; invoice unknown";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASPECTS = new Set(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]);
const BUCKETS = new Set(["project-references", "project-clips", "artist-assets", "wardrobe-refs", "prop-refs"]);
export type Input = {
  model: typeof MODEL; prompt: string; n: 1; resolution: "1k" | "2k";
  aspectRatio: string; maxCostUsd: number; dryRun: boolean;
  avt_user_id: string; avt_project_id: string; jobRowId: string;
  references: { url: string; label: string; role: string }[];
};
export function record(x: unknown): Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : {};
}
export function referenceUrlAllowed(raw: string, user: string, project: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.host !== "qoyxgnkvjukovkrvdaiq.supabase.co" || u.username || u.password || u.hash || !u.searchParams.get("token")) return false;
    // Reject encoded separators and traversal before URL canonicalisation can erase them.
    if (/%(?:2e|2f|5c|25)/i.test(raw) || /\/\.\.?\//.test(raw) || raw.includes("\\")) return false;
    const parts = decodeURIComponent(u.pathname).split("/");
    if (parts.slice(0, 5).join("/") !== "/storage/v1/object/sign" || parts.some((p, i) => i > 0 && (!p || p === "." || p === ".."))) return false;
    const [, , , , , bucket, owner, folder] = parts;
    if (!BUCKETS.has(bucket) || owner !== user) return false;
    if ((bucket === "project-references" || bucket === "project-clips") && folder !== project) return false;
    return /\.(png|jpe?g|webp)$/i.test(parts.at(-1) ?? "");
  } catch { return false; }
}
export function parseInput(raw: unknown): Input {
  const b = record(raw);
  if (b.model !== MODEL) throw new Error("unsupported_model");
  if (typeof b.prompt !== "string" || !b.prompt.trim() || b.prompt.length > 20_000) throw new Error("invalid_prompt");
  if (b.n !== undefined && b.n !== 1) throw new Error("one_candidate_per_request");
  if (b.resolution !== "1k" && b.resolution !== "2k") throw new Error("invalid_resolution");
  if (typeof b.aspectRatio !== "string" || !ASPECTS.has(b.aspectRatio)) throw new Error("invalid_aspect_ratio");
  if (typeof b.maxCostUsd !== "number" || !Number.isFinite(b.maxCostUsd) || b.maxCostUsd < COST_BOUND_USD) throw new Error("cost_gate");
  if (b.dryRun !== undefined && typeof b.dryRun !== "boolean") throw new Error("invalid_dry_run");
  if (typeof b.avt_user_id !== "string" || !UUID.test(b.avt_user_id) || typeof b.avt_project_id !== "string" || !UUID.test(b.avt_project_id)) throw new Error("owner_required");
  if (b.dryRun !== true && (typeof b.jobRowId !== "string" || !UUID.test(b.jobRowId))) throw new Error("job_required");
  const refs = b.references ?? [];
  if (!Array.isArray(refs) || refs.length > MAX_REFERENCES) throw new Error("reference_limit");
  const references = refs.map((r) => {
    const ref = record(r);
    if (typeof ref.url !== "string" || !referenceUrlAllowed(ref.url, b.avt_user_id as string, b.avt_project_id as string)) throw new Error("reference_forbidden");
    if (typeof ref.label !== "string" || ref.label.length > 200 || typeof ref.role !== "string" || ref.role.length > 40) throw new Error("invalid_reference_label");
    return { url: ref.url, label: ref.label, role: ref.role };
  });
  return { model: MODEL, prompt: b.prompt, n: 1, resolution: b.resolution, aspectRatio: b.aspectRatio, maxCostUsd: b.maxCostUsd, dryRun: b.dryRun === true, avt_user_id: b.avt_user_id, avt_project_id: b.avt_project_id, jobRowId: typeof b.jobRowId === "string" ? b.jobRowId : "", references };
}
export function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if ([137,80,78,71,13,10,26,10].every((n, i) => bytes[i] === n)) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}
export function encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
export function decodeImage(data: unknown, mime: unknown): Uint8Array {
  if (typeof data !== "string" || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("invalid_image_data");
  const s = atob(data); const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0));
  if (bytes.length > MAX_IMAGE_BYTES || !sniffMime(bytes) || sniffMime(bytes) !== mime) throw new Error("invalid_image_type");
  return bytes;
}
export function requestContents(input: Input, images: { mimeType: string; data: string }[]) {
  return [{ role: "user", parts: [
    { text: input.prompt },
    ...images.flatMap((image, i) => [
      { text: `<IMAGE_${i}>: ${input.references[i].label} (${input.references[i].role}).` },
      { inlineData: image },
    ]),
  ] }];
}
export function generationConfig(input: Input) {
  // v1beta schema (discovery, 12 Oct 2026): responseFormat.image takes enums (ASPECT_RATIO_FOUR_BY_FIVE…) and
  // rejected "4:5"/"2K" with 400; imageConfig takes these strings. thinkingLevel is the enum MEDIUM.
  return { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: input.aspectRatio, imageSize: input.resolution.toUpperCase() }, thinkingConfig: { thinkingLevel: "MEDIUM", includeThoughts: false }, maxOutputTokens: MAX_OUTPUT_TOKENS, candidateCount: 1 };
}
export function outputImage(payload: unknown): { data: string; mimeType: string; bytes: number } {
  const p = record(payload); const candidates = Array.isArray(p.candidates) ? p.candidates : [];
  for (const c of candidates) {
    const parts = record(record(c).content).parts;
    for (const raw of Array.isArray(parts) ? parts : []) {
      const part = record(raw);
      if (part.thought === true) continue;
      const image = record(part.inlineData ?? part.inline_data);
      if (!image.data) continue;
      const mimeType = image.mimeType ?? image.mime_type;
      const bytes = decodeImage(image.data, mimeType);
      return { data: image.data as string, mimeType: mimeType as string, bytes: bytes.length };
    }
  }
  throw new Error("no_final_image");
}
