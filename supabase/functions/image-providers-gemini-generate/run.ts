import { COST_BASIS, COST_BOUND_USD, MAX_IMAGE_BYTES, MAX_INPUT_TOKENS, MAX_REFERENCE_BYTES, MODEL, encode, generationConfig, outputImage, record, requestContents, sniffMime, type Input } from "./contract.ts";

const GOOGLE = `https://generativelanguage.googleapis.com/v1/models/${MODEL}`;
type GoogleError = { httpStatus: number; status: string | null; message: string | null; reason: string | null; consumer: string | null };
/** Google's own refusal, so billing/entitlement blocks are reported exactly. Never carries the key or a signed URL. */
export async function googleError(response: Response, key: string): Promise<GoogleError> {
  let body: Record<string, unknown> = {};
  try { body = record(record(JSON.parse(new TextDecoder().decode(await boundedBytes(response, 16 * 1024)))).error); } catch { /* non-JSON body */ }
  const details = Array.isArray(body.details) ? body.details.map(record) : [];
  const info = details.find((d) => typeof d.reason === "string") ?? {};
  const scrub = (v: unknown, n: number) => typeof v === "string" ? (key ? v.split(key).join("[redacted]") : v).replace(/https?:\/\/\S+\?\S*token=\S+/g, "[url]").slice(0, n) : null;
  return { httpStatus: response.status, status: scrub(body.status, 60), message: scrub(body.message, 500), reason: scrub(info.reason, 80), consumer: scrub(record(info.metadata).consumer, 80) };
}
export function finishEvidence(payload: Record<string, unknown>) {
  const first = record(Array.isArray(payload.candidates) ? payload.candidates[0] : null);
  return { finishReason: typeof first.finishReason === "string" ? first.finishReason : null, blockReason: typeof record(payload.promptFeedback).blockReason === "string" ? record(payload.promptFeedback).blockReason as string : null };
}
export async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const size = Number(response.headers.get("content-length"));
  if (size > limit) { await response.body?.cancel(); throw new Error("response_too_large"); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty_response");
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.length;
      if (total > limit) { await reader.cancel(); throw new Error("response_too_large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return all;
}
/** Dependency injection allows contract + mocked HTTP tests without importing Deno or secrets. */
export async function run(input: Input, key: string, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const plan = { provider: "gemini", billingAccount: "Google Gemini API", model: MODEL, costBasis: COST_BASIS, estimatedCostUsd: COST_BOUND_USD, costIsEstimate: true, costIsUpperBound: true, actualCostUsd: null, maxReferences: 14 };
  if (!key) return { ok: false, ...plan, errorCode: "PROVIDER_KEY_NOT_CONFIGURED", billed: false, ...(input.dryRun ? { dryRun: true, referencesSent: 0 } : {}) };
  if (input.dryRun) {
    // models.get is free metadata: it proves this key can see the model, not that billing will accept a generation.
    const dry = { ...plan, dryRun: true, billed: false, credentialsConfigured: true, referencesSent: 0 };
    try {
      const r = await fetcher(GOOGLE, { headers: { "x-goog-api-key": key }, redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return { ok: false, ...dry, errorCode: "model_access_failed", modelAccessVerified: false, googleError: await googleError(r, key) };
      const m = record(JSON.parse(new TextDecoder().decode(await boundedBytes(r, 64 * 1024))));
      return { ok: true, ...dry, modelAccessVerified: true, modelInfo: { name: m.name ?? null, version: m.version ?? null, displayName: m.displayName ?? null, inputTokenLimit: m.inputTokenLimit ?? null, outputTokenLimit: m.outputTokenLimit ?? null } };
    } catch { return { ok: false, ...dry, errorCode: "model_access_check_failed", modelAccessVerified: false }; }
  }
  let submitted = false; let usage: unknown = null; let modelVersion: unknown = null; let refused: GoogleError | null = null; let finish = { finishReason: null as string | null, blockReason: null as string | null };
  const deadline = Date.now() + 150_000;
  const timeout = (ms: number) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("request_failed");
    return AbortSignal.timeout(Math.min(ms, remaining));
  };
  // One request, no automatic retries. A lost response is possibly billed, never $0.
  try {
    const images: { mimeType: string; data: string }[] = []; let bytesTotal = 0;
    for (const ref of input.references) {
      const r = await fetcher(ref.url, { redirect: "error", signal: timeout(15_000) });
      if (!r.ok) throw new Error("reference_download_failed");
      const bytes = await boundedBytes(r, MAX_IMAGE_BYTES);
      bytesTotal += bytes.length;
      if (bytesTotal > MAX_REFERENCE_BYTES) throw new Error("references_too_large");
      const mimeType = sniffMime(bytes);
      if (!mimeType) throw new Error("reference_not_supported_image");
      images.push({ mimeType, data: encode(bytes) });
    }
    const contents = requestContents(input, images);
    const headers = { "Content-Type": "application/json", "x-goog-api-key": key };
    const count = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:countTokens`, { method: "POST", headers, body: JSON.stringify({ contents }), redirect: "error", signal: timeout(20_000) });
    if (!count.ok) { refused = await googleError(count, key); throw new Error(`token_count_http_${count.status}`); }
    const counted = record(JSON.parse(new TextDecoder().decode(await boundedBytes(count, 64 * 1024))));
    if (!Number.isInteger(counted.totalTokens) || Number(counted.totalTokens) < 1 || Number(counted.totalTokens) > MAX_INPUT_TOKENS) throw new Error("input_token_gate");
    const generationSignal = timeout(110_000);
    submitted = true;
    const response = await fetcher(`${GOOGLE}:generateContent`, { method: "POST", headers, body: JSON.stringify({ contents, generationConfig: generationConfig(input) }), redirect: "error", signal: generationSignal });
    if (!response.ok) { refused = await googleError(response, key); throw new Error(`generation_http_${response.status}`); }
    const payload = record(JSON.parse(new TextDecoder().decode(await boundedBytes(response, 12 * 1024 * 1024))));
    usage = payload.usageMetadata ?? null; modelVersion = payload.modelVersion ?? null; finish = finishEvidence(payload);
    const image = outputImage(payload);
    return { ok: true, ...plan, billingStatus: "invoice_unknown", billed: "unknown", possiblyBilled: true, submitted: true, referencesSent: images.length, countedInputTokens: counted.totalTokens, usage, modelVersion, ...finish, images: [image] };
  } catch (e) {
    // Only our fixed codes escape; a fetch exception can contain a signed URL or key.
    const msg = e instanceof Error ? e.message : "";
    const code = /^(response_too_large|empty_response|reference_download_failed|references_too_large|reference_not_supported_image|token_count_http_\d+|input_token_gate|generation_http_\d+|no_final_image|invalid_image_data|invalid_image_type)$/.test(msg) ? msg : "request_failed";
    return { ok: false, ...plan, errorCode: code, retryable: false, submitted, possiblyBilled: submitted, billed: submitted ? "unknown" : false, usage, modelVersion, ...finish, googleError: refused, referencesSent: submitted ? input.references.length : 0 };
  }
}
