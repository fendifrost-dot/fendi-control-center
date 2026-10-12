import { COST_BASIS, COST_BOUND_USD, MAX_ANSWER_BYTES, MAX_IMAGE_BYTES, MAX_INPUT_TOKENS, MAX_REFERENCE_BYTES, MODEL, base64Bytes, bodyOf, decodeImage, generationConfig, record, requestBodyParts, sniffMime, type BodyMode, type Input } from "./contract.ts";
import { readAnswer, type StreamedAnswer } from "./answerStream.ts";

// v1beta: Google answers 404 "Model is not found ... for api version v1" for this model (live dry-run, 12 Oct 2026).
const API = "https://generativelanguage.googleapis.com/v1beta";
const GOOGLE = `${API}/models/${MODEL}`;
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
/** Sizes only, never values: which answer fields were large (e.g. thoughtSignature) and how many image parts came back. */
export function answerEvidence(answer: StreamedAnswer) {
  const largeFields: Record<string, number> = {};
  for (const o of answer.omitted) largeFields[o.path] = (largeFields[o.path] ?? 0) + o.bytes;
  const final = answer.images.find((i) => !i.thought);
  return {
    responseBytes: answer.answerBytes,
    finalImageParts: answer.images.filter((i) => !i.thought).length,
    thoughtImageParts: answer.images.filter((i) => i.thought).length,
    finalImageBase64Bytes: final?.data.length ?? 0,
    finalImageSignatureBytes: final?.signatureBytes ?? 0,
    largeFields,
  };
}
/** Timings and, where the runtime exposes it, process memory at each step: a crash still leaves the last step logged. */
export function phaseTracker() {
  const t0 = Date.now(); const phases: Record<string, { ms: number; rssMB?: number; heapMB?: number }> = {};
  const deno = (globalThis as { Deno?: { memoryUsage?: () => { rss: number; heapUsed: number; external: number } } }).Deno;
  return {
    phases,
    mark(name: string) {
      let m: { rss: number; heapUsed: number; external: number } | undefined;
      try { m = deno?.memoryUsage?.(); } catch { m = undefined; }
      phases[name] = { ms: Date.now() - t0, ...(m ? { rssMB: Math.round(m.rss / 1e5) / 10, heapMB: Math.round((m.heapUsed + m.external) / 1e5) / 10 } : {}) };
      if (deno) console.log(JSON.stringify({ gemini_phase: name, ...phases[name] }));
    },
  };
}
export function finishEvidence(payload: Record<string, unknown>) {
  const first = record(Array.isArray(payload.candidates) ? payload.candidates[0] : null);
  return { finishReason: typeof first.finishReason === "string" ? first.finishReason : null, blockReason: typeof record(payload.promptFeedback).blockReason === "string" ? record(payload.promptFeedback).blockReason as string : null };
}
export async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const size = Number(response.headers.get("content-length"));
  if (size > limit) { await response.body?.cancel(); throw new Error("response_too_large"); }
  // Declared length within the limit: one native read, no chunk list plus copy.
  if (Number.isInteger(size) && size > 0) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error("response_too_large");
    return bytes;
  }
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
/** Free models.list, so a 404 distinguishes a wrong model name from a key without access. */
async function imageModels(key: string, fetcher: typeof fetch): Promise<string[] | null> {
  try {
    const r = await fetcher(`${API}/models?pageSize=1000`, { headers: { "x-goog-api-key": key }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const models = record(JSON.parse(new TextDecoder().decode(await boundedBytes(r, 1024 * 1024)))).models;
    return (Array.isArray(models) ? models : []).map((m) => String(record(m).name ?? "")).filter((n) => /image|banana/i.test(n)).slice(0, 50);
  } catch { return null; }
}
/** Dependency injection allows contract + mocked HTTP tests without importing Deno or secrets. */
export async function run(input: Input, key: string, fetcher: typeof fetch = fetch, bodyMode: BodyMode = "stream"): Promise<Record<string, unknown>> {
  const plan = { provider: "gemini", billingAccount: "Google Gemini API", model: MODEL, costBasis: COST_BASIS, estimatedCostUsd: COST_BOUND_USD, costIsEstimate: true, costIsUpperBound: true, actualCostUsd: null, maxReferences: 14 };
  if (!key) return { ok: false, ...plan, errorCode: "PROVIDER_KEY_NOT_CONFIGURED", billed: false, ...(input.dryRun ? { dryRun: true, referencesSent: 0 } : {}) };
  if (input.dryRun) {
    // models.get is free metadata: it proves this key can see the model, not that billing will accept a generation.
    const dry = { ...plan, dryRun: true, billed: false, credentialsConfigured: true, referencesSent: 0 };
    try {
      const r = await fetcher(GOOGLE, { headers: { "x-goog-api-key": key }, redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return { ok: false, ...dry, errorCode: "model_access_failed", modelAccessVerified: false, googleError: await googleError(r, key), imageModelsVisibleToKey: await imageModels(key, fetcher) };
      const m = record(JSON.parse(new TextDecoder().decode(await boundedBytes(r, 64 * 1024))));
      return { ok: true, ...dry, modelAccessVerified: true, modelInfo: { name: m.name ?? null, version: m.version ?? null, displayName: m.displayName ?? null, inputTokenLimit: m.inputTokenLimit ?? null, outputTokenLimit: m.outputTokenLimit ?? null } };
    } catch { return { ok: false, ...dry, errorCode: "model_access_check_failed", modelAccessVerified: false }; }
  }
  let submitted = false; let usage: unknown = null; let modelVersion: unknown = null; let refused: GoogleError | null = null; let evidence: ReturnType<typeof answerEvidence> | null = null; const track = phaseTracker(); let finish = { finishReason: null as string | null, blockReason: null as string | null };
  const deadline = Date.now() + 150_000;
  const timeout = (ms: number) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("request_failed");
    return AbortSignal.timeout(Math.min(ms, remaining));
  };
  // One request, no automatic retries. A lost response is possibly billed, never $0.
  try {
    track.mark("start");
    let images: { mimeType: string; b64: Uint8Array }[] = []; let bytesTotal = 0;
    for (const ref of input.references) {
      const r = await fetcher(ref.url, { redirect: "error", signal: timeout(15_000) });
      if (!r.ok) throw new Error("reference_download_failed");
      const bytes = await boundedBytes(r, MAX_IMAGE_BYTES);
      bytesTotal += bytes.length;
      if (bytesTotal > MAX_REFERENCE_BYTES) throw new Error("references_too_large");
      const mimeType = sniffMime(bytes);
      if (!mimeType) throw new Error("reference_not_supported_image");
      images.push({ mimeType, b64: base64Bytes(bytes) });
    }
    track.mark("references_loaded");
    // Serialise once and drop the image copies: worker memory, not Google, was the limit (12 Oct 2026).
    const referencesSent = images.length;
    // Streamed bodies keep the worker's peak flat (DECISION, measured on Deno with real fetch: see handoff).
    // countTokens is free, so it also proves Google accepts a body without a declared length before any spend.
    let mode = bodyMode;
    track.mark("request_serialised");
    const headers = { "Content-Type": "application/json", "x-goog-api-key": key };
    let count = await fetcher(`${GOOGLE}:countTokens`, { method: "POST", headers, body: bodyOf(requestBodyParts(input, images, "}"), mode), redirect: "error", signal: timeout(20_000) });
    if (count.status === 411 && mode === "stream") {
      await count.body?.cancel(); mode = "blob"; // Length Required: same bytes, declared length; still free
      count = await fetcher(`${GOOGLE}:countTokens`, { method: "POST", headers, body: bodyOf(requestBodyParts(input, images, "}"), mode), redirect: "error", signal: timeout(20_000) });
    }
    track.mark(`count_sent_${mode}`);
    if (!count.ok) { refused = await googleError(count, key); throw new Error(`token_count_http_${count.status}`); }
    const counted = record(JSON.parse(new TextDecoder().decode(await boundedBytes(count, 64 * 1024))));
    if (!Number.isInteger(counted.totalTokens) || Number(counted.totalTokens) < 1 || Number(counted.totalTokens) > MAX_INPUT_TOKENS) throw new Error("input_token_gate");
    track.mark("tokens_counted");
    let generateBody: BodyInit | null = bodyOf(requestBodyParts(input, images, `,"generationConfig":${JSON.stringify(generationConfig(input))}}`), mode);
    images = [];
    const generationSignal = timeout(110_000);
    submitted = true;
    const response = await fetcher(`${GOOGLE}:generateContent`, { method: "POST", headers, body: generateBody, redirect: "error", signal: generationSignal });
    // The request has been sent: release both bodies before the (large) answer is read. Four of ten paid runs on
    // 12 Oct 2026 were killed by the worker memory limit after Google had answered.
    generateBody = null;
    track.mark("answer_headers");
    if (!response.ok) { refused = await googleError(response, key); throw new Error(`generation_http_${response.status}`); }
    // Streamed: keeps the final image's base64 and small fields only (answerStream.ts).
    const answer = await readAnswer(response, MAX_ANSWER_BYTES);
    track.mark("answer_read");
    const payload = answer.payload;
    usage = payload.usageMetadata ?? null; modelVersion = payload.modelVersion ?? null; finish = finishEvidence(payload); evidence = answerEvidence(answer);
    const final = answer.images.find((i) => !i.thought);
    if (!final) throw new Error("no_final_image");
    const image = { data: final.data, mimeType: final.mimeType as string, bytes: decodeImage(final.data, final.mimeType) };
    track.mark("image_checked");
    return { ok: true, ...plan, billingStatus: "invoice_unknown", billed: "unknown", possiblyBilled: true, submitted: true, referencesSent, countedInputTokens: counted.totalTokens, usage, modelVersion, ...finish, ...evidence, requestBodyMode: mode, phases: track.phases, images: [image] };
  } catch (e) {
    // Only our fixed codes escape; a fetch exception can contain a signed URL or key.
    const msg = e instanceof Error ? e.message : "";
    const code = /^(response_too_large|empty_response|invalid_answer_json|reference_download_failed|references_too_large|reference_not_supported_image|token_count_http_\d+|input_token_gate|generation_http_\d+|no_final_image|invalid_image_data|invalid_image_type)$/.test(msg) ? msg : "request_failed";
    return { ok: false, ...plan, errorCode: code, retryable: false, submitted, possiblyBilled: submitted, billed: submitted ? "unknown" : false, usage, modelVersion, ...finish, ...(evidence ?? {}), phases: track.phases, googleError: refused, referencesSent: submitted ? input.references.length : 0 };
  }
}
