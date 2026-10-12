// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { COST_BOUND_USD, MAX_IMAGE_BYTES, MODEL, decodeImage, encode, generationConfig, outputImage, parseInput, referenceUrlAllowed } from "./contract.ts";
import { boundedBytes, run } from "./run.ts";

const user = "00000000-0000-4000-8000-000000000001";
const project = "00000000-0000-4000-8000-000000000002";
const job = "00000000-0000-4000-8000-000000000003";
const prefix = "https://qoyxgnkvjukovkrvdaiq.supabase.co/storage/v1/object/sign";
const url = `${prefix}/prop-refs/${user}/rider.png?token=private`;
const raw = { model: MODEL, n: 1, prompt: "New scene. Keep <IMAGE_0> as the same person.", resolution: "2k", aspectRatio: "9:16", maxCostUsd: .15, avt_user_id: user, avt_project_id: project, jobRowId: job, references: [{ url, role: "cast", label: "The rider" }] };
// Header fixture only: these tests exercise transport, not image fidelity/decoding.
const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0,1]);
const data = encode(png);
// Node/Deno-agnostic base64 reference (Buffer is unavailable under Deno's type check).
const toBase64 = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const success = () => Response.json({ candidates: [{ content: { parts: [{ thought: true, inlineData: { mimeType: "image/png", data: "bad" } }, { inlineData: { mimeType: "image/png", data } }] } }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 1680 }, modelVersion: "observed-provider-version" });

describe("unit: Gemini route contract", () => {
  it("requires a fixed model, bounded spend and one candidate", () => {
    expect(parseInput(raw).model).toBe(MODEL);
    for (const change of [{ model: "latest" }, { n: 2 }, { maxCostUsd: .01 }, { maxCostUsd: NaN }, { maxCostUsd: "1" }, { resolution: "4k" }, { dryRun: "true" }, { jobRowId: undefined }, { prompt: "" }, { aspectRatio: "invented" }]) expect(() => parseInput({ ...raw, ...change })).toThrow();
    expect(() => parseInput({ ...raw, jobRowId: undefined, dryRun: true })).not.toThrow();
    expect(COST_BOUND_USD).toBeCloseTo(.147456);
  });
  it("allows only the fixed AVT host, owner prefix and project folders", () => {
    expect(referenceUrlAllowed(url, user, project)).toBe(true);
    expect(referenceUrlAllowed(`${prefix}/project-references/${user}/${project}/worlds/1.png?token=x`, user, project)).toBe(true);
    for (const bad of [url.replace(user, project), url.replace(".co/", ".co.evil/"), url.replace("https:", "http:"), url.replace("prop-refs", "private"), url.replace("rider.png", "../victim.png"), url.replace("rider.png", "%2e%2e/victim.png"), url.replace("rider.png", "%252e%252e/victim.png"), url.replace("rider.png", "x%2fy.png"), url.replace("?token=private", ""), `${prefix}/project-references/${user}/${job}/x.png?token=x`]) expect(referenceUrlAllowed(bad, user, project), bad).toBe(false);
  });
  it("refuses over-cap references before any fetch", () => {
    expect(() => parseInput({ ...raw, references: Array(15).fill(raw.references[0]) })).toThrow("reference_limit");
    expect(() => parseInput({ ...raw, references: [{ ...raw.references[0], url: "https://example.com/a.png" }] })).toThrow("reference_forbidden");
  });
  it("keeps output configuration explicit and validates MIME against bytes", () => {
    expect(generationConfig(parseInput(raw))).toMatchObject({ maxOutputTokens: 4096, candidateCount: 1, imageConfig: { aspectRatio: "9:16", imageSize: "2K" }, thinkingConfig: { thinkingLevel: "MEDIUM" } });
    expect(generationConfig(parseInput(raw))).not.toHaveProperty("responseFormat");
    expect(decodeImage(data, "image/png")).toBe(png.length);
    for (const n of [0, 1, 2, 3, 24569, 24570, 24571, 50001]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 7919) % 256);
      expect(encode(b)).toBe(toBase64(b));
    }
    expect(() => decodeImage(data, "image/jpeg")).toThrow();
    expect(() => outputImage({ candidates: [{ content: { parts: [{ thought: true, inlineData: { data, mimeType: "image/png" } }] } }] })).toThrow("no_final_image");
  });
});

describe("mocked integration: Google transport, no live provider", () => {
  it("dry-run checks free model metadata only: no references, countTokens or generation", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ name: `models/${MODEL}`, version: "2.1", outputTokenLimit: 32768 }));
    const result = await run(parseInput({ ...raw, dryRun: true }), "configured", fetcher);
    expect(result).toMatchObject({ ok: true, billed: false, referencesSent: 0, actualCostUsd: null, modelAccessVerified: true, modelInfo: { version: "2.1" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}`);
    expect(fetcher.mock.calls[0][1].method).toBeUndefined();
  });
  it("dry-run reports Google's exact refusal without the key", async () => {
    const denial = { error: { code: 403, status: "PERMISSION_DENIED", message: "Billing is not enabled (key=configured)", details: [{ reason: "BILLING_DISABLED", metadata: { consumer: "projects/123" } }] } };
    const result = await run(parseInput({ ...raw, dryRun: true }), "configured", vi.fn().mockResolvedValueOnce(Response.json(denial, { status: 403 })).mockResolvedValueOnce(Response.json({ models: [{ name: "models/gemini-3.1-flash-image" }, { name: "models/gemini-2.5-pro" }] })));
    expect(result).toMatchObject({ imageModelsVisibleToKey: ["models/gemini-3.1-flash-image"], ok: false, billed: false, modelAccessVerified: false, errorCode: "model_access_failed", googleError: { httpStatus: 403, status: "PERMISSION_DENIED", reason: "BILLING_DISABLED", consumer: "projects/123" } });
    expect(JSON.stringify(result)).not.toContain("configured)");
  });
  it("a refused generation carries Google's error and is never retried", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(png)).mockResolvedValueOnce(Response.json({ totalTokens: 1 })).mockResolvedValueOnce(Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Your prepayment credits are depleted." } }, { status: 429 }));
    expect(await run(parseInput(raw), "secret", fetcher)).toMatchObject({ ok: false, errorCode: "generation_http_429", googleError: { httpStatus: 429, status: "RESOURCE_EXHAUSTED", message: "Your prepayment credits are depleted." }, possiblyBilled: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("missing key stops before reference download", async () => {
    const fetcher = vi.fn();
    expect(await run(parseInput(raw), "", fetcher)).toMatchObject({ ok: false, billed: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("sends reference bytes in order, only to Google, and skips thought images", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(png)).mockResolvedValueOnce(Response.json({ totalTokens: 120 })).mockImplementationOnce(success);
    const result = await run(parseInput(raw), "secret", fetcher);
    expect(result).toMatchObject({ ok: true, model: MODEL, modelVersion: "observed-provider-version", actualCostUsd: null, referencesSent: 1, usage: { promptTokenCount: 120 }, finalImageParts: 1, thoughtImageParts: 1, images: [{ data, mimeType: "image/png" }] });
    expect(result.responseBytes).toBeGreaterThan(0);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "error" });
    expect(fetcher.mock.calls[0][1].headers).toBeUndefined();
    expect(fetcher.mock.calls[1][0]).toContain("/v1beta/models/");
    expect(fetcher.mock.calls[2][0]).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`);
    const text = (b: unknown) => typeof b === "string" ? b : new TextDecoder().decode(b as Uint8Array);
    const sent = JSON.parse(text(fetcher.mock.calls[2][1].body));
    expect(sent.contents[0].parts[2]).toEqual({ inlineData: { mimeType: "image/png", data } });
    expect(JSON.stringify(sent)).not.toContain("?token=");
    expect(sent.generationConfig).toMatchObject({ imageConfig: { aspectRatio: "9:16", imageSize: "2K" }, candidateCount: 1 });
    expect(JSON.parse(text(fetcher.mock.calls[1][1].body))).toEqual({ contents: sent.contents });
  });
  it("fails closed when countTokens is unavailable or over budget", async () => {
    for (const counted of [Response.json({ totalTokens: 20_000 }), Response.json({}), new Response("error", { status: 404 })]) {
      const fetcher = vi.fn().mockResolvedValueOnce(new Response(png)).mockResolvedValueOnce(counted);
      expect(await run(parseInput(raw), "secret", fetcher)).toMatchObject({ ok: false, billed: false, submitted: false });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });
  it("never retries ambiguous generation failures or leaks key/URL", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(png)).mockResolvedValueOnce(Response.json({ totalTokens: 1 })).mockRejectedValueOnce(new Error(`secret ${url}`));
    const result = await run(parseInput(raw), "secret", fetcher);
    expect(result).toMatchObject({ ok: false, errorCode: "request_failed", possiblyBilled: true, billed: "unknown", retryable: false, actualCostUsd: null });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("retains usage on a safety refusal/no-image answer and does not retry", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(png)).mockResolvedValueOnce(Response.json({ totalTokens: 1 })).mockResolvedValueOnce(Response.json({ usageMetadata: { promptTokenCount: 1 }, candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }] }));
    expect(await run(parseInput(raw), "secret", fetcher)).toMatchObject({ ok: false, errorCode: "no_final_image", finishReason: "MAX_TOKENS", usage: { promptTokenCount: 1 }, possiblyBilled: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("enforces streamed byte limits even without Content-Length", async () => {
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(9)); c.enqueue(new Uint8Array(9)); c.close(); } }));
    await expect(boundedBytes(response, 12)).rejects.toThrow("response_too_large");
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(png, { headers: { "Content-Length": String(MAX_IMAGE_BYTES + 1) } }));
    expect(await run(parseInput(raw), "secret", fetcher)).toMatchObject({ ok: false, billed: false, errorCode: "response_too_large" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
