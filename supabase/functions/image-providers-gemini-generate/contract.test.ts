// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
<<<<<<< HEAD
import { COST_BOUND_USD, MAX_IMAGE_BYTES, MAX_REFERENCE_BYTES, MAX_REQUEST_BYTES, MODEL, decodeImage, encode, generationConfig, outputImage, parseInput, referenceUrlAllowed, base64Bytes, bodyOf, requestBodyParts, requestContents } from "./contract.ts";
=======
import { COST_BOUND_USD, MAX_IMAGE_BYTES, MODEL, decodeImage, encode, generationConfig, outputImage, parseInput, referenceUrlAllowed, base64Bytes, bodyOf, requestBodyParts, requestContents } from "./contract.ts";
>>>>>>> origin/claude/determined-faraday-4rzanq
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
    const sent = JSON.parse(await new Response(fetcher.mock.calls[2][1].body).text());
    expect(sent.contents[0].parts[2]).toEqual({ inlineData: { mimeType: "image/png", data } });
    expect(JSON.stringify(sent)).not.toContain("?token=");
    expect(sent.generationConfig).toMatchObject({ imageConfig: { aspectRatio: "9:16", imageSize: "2K" }, candidateCount: 1 });
    expect(JSON.parse(await new Response(fetcher.mock.calls[1][1].body).text())).toEqual({ contents: sent.contents });
    expect(fetcher.mock.calls[1][1].body).toBeInstanceOf(ReadableStream);
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

describe("unit: lean request bodies (worker memory)", () => {
  it("base64Bytes is byte-identical to btoa for every length class", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 255, 256, 257, 65_535, 65_536, 65_537, 1_000_003]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 7919 + n) % 256);
      expect(new TextDecoder().decode(base64Bytes(b)), String(n)).toBe(toBase64(b));
    }
  });
  it("body pieces reassemble to exactly the JSON the old string path sent, even when the prompt imitates the marker", async () => {
    const input = parseInput({ ...raw, prompt: "Keep <IMAGE_0>. @@ref-00000000-0000-0000-0000-000000000000-0@@ and quotes \" é", references: [raw.references[0], { ...raw.references[0], label: "Second \"one\"" }] });
    const imgs = [Uint8Array.from([1, 2, 3, 4, 5]), Uint8Array.from([250, 251])].map((b) => ({ mimeType: "image/png", b64: base64Bytes(b), str: toBase64(b) }));
    const tail = `,"generationConfig":${JSON.stringify(generationConfig(input))}}`;
    const expected = `${JSON.stringify({ contents: requestContents(input, imgs.map((i) => ({ mimeType: i.mimeType, data: i.str }))) }).slice(0, -1)}${tail}`;
    for (const mode of ["bytes", "blob", "stream"] as const) {
      expect(await new Response(bodyOf(requestBodyParts(input, imgs, tail), mode)).text(), mode).toBe(expected);
    }
  });
  it("downloads a sized reference in one read, and still refuses a lying or oversized one", async () => {
    const b = new Uint8Array(1000);
    expect((await boundedBytes(new Response(b, { headers: { "Content-Length": "1000" } }), 1000)).length).toBe(1000);
    await expect(boundedBytes(new Response(b, { headers: { "Content-Length": "1001" } }), 1000)).rejects.toThrow("response_too_large");
  });
});

describe("mocked integration: request body acceptance and large answers", () => {
  it("a 411 from countTokens (free) switches to a sized body; nothing billable is sent twice", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(png)).mockResolvedValueOnce(new Response("", { status: 411 })).mockResolvedValueOnce(Response.json({ totalTokens: 1 })).mockImplementationOnce(success);
    const result = await run(parseInput(raw), "secret", fetcher);
    expect(result).toMatchObject({ ok: true, requestBodyMode: "blob" });
    expect(fetcher.mock.calls.filter(([u]) => String(u).endsWith(":generateContent"))).toHaveLength(1);
    expect(fetcher.mock.calls[3][1].body).toBeInstanceOf(Blob);
  });
  it("a runtime that throws on a streamed body falls back to a sized body during the free countTokens", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(png)).mockRejectedValueOnce(new TypeError("streams unsupported")).mockResolvedValueOnce(Response.json({ totalTokens: 1 })).mockImplementationOnce(success);
    expect(await run(parseInput(raw), "secret", fetcher)).toMatchObject({ ok: true, requestBodyMode: "blob" });
    expect(fetcher.mock.calls.filter(([u]) => String(u).endsWith(":generateContent"))).toHaveLength(1);
  });
  it("a sized-body countTokens failure stops before spending", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(png)).mockRejectedValueOnce(new TypeError("network down"));
    expect(await run(parseInput(raw), "secret", fetcher, "blob")).toMatchObject({ ok: false, errorCode: "request_failed", submitted: false, possiblyBilled: false, billed: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("if sending countTokens consumed the reference buffers, the paid request is never sent", async () => {
    // A runtime that transfers enqueued chunks would leave the next body with empty images and no error.
    const detaching = async (_u: unknown, init: RequestInit) => {
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      for (;;) { const { done, value } = await reader.read(); if (done) break; if (value.byteLength > 100) structuredClone(value, { transfer: [value.buffer] }); }
      return Response.json({ totalTokens: 1 });
    };
    const big = new Uint8Array(4096); big.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(big)).mockImplementationOnce(detaching);
    expect(await run(parseInput(raw), "secret", fetcher)).toMatchObject({ ok: false, errorCode: "request_build_failed", submitted: false, billed: false });
    expect(fetcher.mock.calls.filter(([u]) => String(u).endsWith(":generateContent"))).toHaveLength(0);
  });
  it("an ~11 MB answer with a 7 MB signature yields the image and reports field sizes only", async () => {
    const jpeg = new Uint8Array(3_000_000); jpeg.set([255, 216, 255, 224]);
    const data = encode(jpeg); const signature = "S".repeat(7_100_000);
    const answer = JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: "image/jpeg", data }, thoughtSignature: signature }] } }], usageMetadata: { promptTokenCount: 1 }, modelVersion: MODEL });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(png)).mockResolvedValueOnce(Response.json({ totalTokens: 1 })).mockResolvedValueOnce(new Response(answer));
    const result = await run(parseInput(raw), "secret", fetcher);
    expect(result).toMatchObject({ ok: true, responseBytes: answer.length, finalImageParts: 1, thoughtImageParts: 0, finalImageSignatureBytes: signature.length, images: [{ data, mimeType: "image/jpeg", bytes: 3_000_000 }] });
    expect(result.largeFields).toEqual({ "candidates[].content.parts[].thoughtSignature": signature.length });
    expect(JSON.stringify({ ...result, images: [] })).not.toContain("SSSS");
  });
  it("an answer over the byte bound fails closed as possibly billed, with no retry", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(png)).mockResolvedValueOnce(Response.json({ totalTokens: 1 })).mockResolvedValueOnce(new Response("{}", { headers: { "content-length": String(60 * 1024 * 1024) } }));
    expect(await run(parseInput(raw), "secret", fetcher)).toMatchObject({ ok: false, errorCode: "response_too_large", submitted: true, possiblyBilled: true, billed: "unknown" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("a provider timeout after submission is possibly billed and not retried", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(png)).mockResolvedValueOnce(Response.json({ totalTokens: 1 })).mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    expect(await run(parseInput(raw), "secret", fetcher)).toMatchObject({ ok: false, errorCode: "request_failed", submitted: true, possiblyBilled: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
<<<<<<< HEAD
  it("the identity portrait with two guides (13.4 MB, live 12 Oct) is sent whole; the body stays under Google's 20 MB", async () => {
    const sized = (n: number) => { const b = new Uint8Array(n); b.set([137, 80, 78, 71, 13, 10, 26, 10]); return b; };
    const three = parseInput({ ...raw, references: [raw.references[0], { ...raw.references[0], label: "Outfit" }, { ...raw.references[0], label: "Horse" }] });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(sized(7_511_334))).mockResolvedValueOnce(new Response(sized(2_841_677))).mockResolvedValueOnce(new Response(sized(3_009_321))).mockResolvedValueOnce(Response.json({ totalTokens: 3 })).mockImplementationOnce(success);
    expect(await run(three, "secret", fetcher)).toMatchObject({ ok: true, referencesSent: 3 });
    const sent = new Uint8Array(await new Response(fetcher.mock.calls[4][1].body).arrayBuffer());
    expect(sent.byteLength).toBeGreaterThan(Math.ceil(13_362_332 / 3) * 4);
    expect(sent.byteLength).toBeLessThan(MAX_REQUEST_BYTES);
  });
  it("references above the cap are refused before anything reaches Google", async () => {
    const sized = (n: number) => { const b = new Uint8Array(n); b.set([137, 80, 78, 71, 13, 10, 26, 10]); return b; };
    const two = parseInput({ ...raw, references: [raw.references[0], { ...raw.references[0], label: "Second" }] });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(sized(8 * 1024 * 1024))).mockResolvedValueOnce(new Response(sized(MAX_REFERENCE_BYTES - 8 * 1024 * 1024 + 1)));
    expect(await run(two, "secret", fetcher)).toMatchObject({ ok: false, errorCode: "references_too_large", submitted: false, billed: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("the reference cap can never produce a body over Google's 20 MB request limit", () => {
    // Worst case: every reference byte in base64, a 20,000-unit prompt and 14 labels (200) + roles (40) where each
    // UTF-16 unit escapes to 6 JSON bytes (\uXXXX), plus 4 KB of structure.
    expect(Math.ceil(MAX_REFERENCE_BYTES / 3) * 4 + 20_000 * 6 + 14 * 240 * 6 + 4096).toBeLessThan(MAX_REQUEST_BYTES);
  });
=======
>>>>>>> origin/claude/determined-faraday-4rzanq
  it("two references within limits are both sent, in order", async () => {
    const two = parseInput({ ...raw, references: [raw.references[0], { ...raw.references[0], label: "Second" }] });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(png)).mockResolvedValueOnce(new Response(png)).mockResolvedValueOnce(Response.json({ totalTokens: 2 })).mockImplementationOnce(success);
    expect(await run(two, "secret", fetcher)).toMatchObject({ ok: true, referencesSent: 2 });
    const sent = JSON.parse(await new Response(fetcher.mock.calls[3][1].body).text());
    expect(sent.contents[0].parts.map((p: Record<string, unknown>) => p.text ?? "image")).toEqual([two.prompt, "<IMAGE_0>: The rider (cast).", "image", "<IMAGE_1>: Second (cast).", "image"]);
  });
});
