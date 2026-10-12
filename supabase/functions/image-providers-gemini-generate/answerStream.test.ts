// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AnswerReader, SMALL_STRING, readAnswer } from "./answerStream.ts";

const enc = new TextEncoder();
function readIn(text: string, cut: (n: number) => number[]) {
  const bytes = enc.encode(text); const r = new AnswerReader(); let at = 0;
  for (const size of cut(bytes.length)) { r.feed(bytes.subarray(at, at + size)); at += size; }
  r.feed(bytes.subarray(at));
  return r.finish();
}
const whole = (n: number) => [n];
const ones = (n: number) => Array(n).fill(1);
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const randomCuts = (n: number) => { const out: number[] = []; let left = n; while (left > 0) { const s = Math.min(left, 1 + Math.floor(rnd() * 97)); out.push(s); left -= s; } return out; };
function randomValue(depth: number): unknown {
  const k = Math.floor(rnd() * (depth > 3 ? 5 : 7));
  if (k === 0) return Math.floor(rnd() * 1e6) * (rnd() < .5 ? -1 : 1) / (rnd() < .5 ? 1 : 1000);
  if (k === 1) return rnd() < .5;
  if (k === 2) return null;
  if (k === 3) return ["", "plain", "quote\" and \\ backslash", "tab\tnew\nline", "unicode é 漢字 🙂", "slash/\u0001"][Math.floor(rnd() * 6)];
  if (k === 4) return rnd() < .3 ? 1e21 : -0.5e-7;
  if (k === 5) return Array.from({ length: Math.floor(rnd() * 4) }, () => randomValue(depth + 1));
  return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 4) }, (_, i) => [`k${i}${rnd() < .2 ? "\"é" : ""}`, randomValue(depth + 1)]));
}

describe("unit: AnswerReader matches JSON.parse for ordinary answers", () => {
  it("random documents, whole, byte-by-byte and random chunking", () => {
    for (let n = 0; n < 300; n++) {
      const doc = { v: randomValue(0), list: [randomValue(1), {}, [], [[]], { a: {} }], s: " spaced " };
      const text = n % 2 ? JSON.stringify(doc) : JSON.stringify(doc, null, 2);
      for (const cut of [whole, ones, randomCuts]) expect(readIn(text, cut).payload, text).toEqual(JSON.parse(text));
    }
  });
  it("multibyte characters split across chunks are decoded once, correctly", () => {
    const text = JSON.stringify({ name: "漢字🙂é".repeat(50) });
    expect(readIn(text, ones).payload).toEqual(JSON.parse(text));
  });
  it("rejects malformed answers instead of guessing", () => {
    for (const text of ['{"a":1', '{"a" 1}', '{"a":1}}', '{"a":1,}', '[1,2]', '{"a":tru}', '{"a":"x}', '{,}', '{"a":1} x', '"str"', ""]) {
      expect(() => readIn(text, whole), text).toThrow("invalid_answer_json");
    }
  });
});

describe("unit: AnswerReader keeps the image, drops the bulk", () => {
  const image = "/9j/" + "QUJD".repeat(40_000);            // 160 KB base64, JPEG signature
  const signature = "c2ln".repeat(500_000);                  // 2 MB opaque signature
  const answer = (parts: unknown[]) => JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2731, candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1680 }] }, modelVersion: "gemini-nano-banana-2.1" });

  it("captures the final image, records the signature's size only, and preserves small fields", () => {
    const text = answer([{ text: "Here you go." }, { inlineData: { mimeType: "image/jpeg", data: image }, thoughtSignature: signature }]);
    for (const cut of [whole, randomCuts]) {
      const r = readIn(text, cut);
      expect(r.images).toEqual([{ data: image, mimeType: "image/jpeg", thought: false, signatureBytes: signature.length }]);
      expect(r.omitted).toEqual([{ path: "candidates[].content.parts[].thoughtSignature", bytes: signature.length }]);
      expect(r.payload).toMatchObject({ modelVersion: "gemini-nano-banana-2.1", usageMetadata: { promptTokenCount: 2731 }, candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Here you go." }, { inlineData: { mimeType: "image/jpeg", data: null }, thoughtSignature: null }] } }] });
      expect(JSON.stringify(r.payload)).not.toContain("c2lnc2ln");
      expect(r.answerBytes).toBe(enc.encode(text).length);
    }
  });
  it("small signatures are never kept either", () => {
    const r = readIn(answer([{ inlineData: { mimeType: "image/jpeg", data: image }, thoughtSignature: "short-sig" }]), whole);
    expect(r.images[0].signatureBytes).toBe(9);
    expect(JSON.stringify(r.payload)).not.toContain("short-sig");
  });
  it("decodes JSON escapes inside image data (\\/ is legal JSON)", () => {
    const escaped = JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: "PLACEHOLDER" } }] } }] }).replace("PLACEHOLDER", image.replace(/\//g, "\\/"));
    expect(readIn(escaped, randomCuts).images[0].data).toBe(image);
  });
  it("drops interim thought images and picks the final one, whatever the field order", () => {
    const text = answer([
      { thought: true, inlineData: { mimeType: "image/jpeg", data: image } },
      { inlineData: { mimeType: "image/jpeg", data: image }, thought: true },
      { thoughtSignature: signature, inline_data: { mime_type: "image/png", data: "iVBORw0KGgo" + "AAAA".repeat(20_000) } },
    ]);
    const r = readIn(text, randomCuts);
    expect(r.images.map((i) => [i.thought, i.data.length, i.mimeType])).toEqual([[true, 0, "image/jpeg"], [true, 0, "image/jpeg"], [false, 11 + 80_000, "image/png"]]);
    expect(r.images[2].signatureBytes).toBe(signature.length);
  });
  it("only the first final image's data is held; later ones are counted", () => {
    const r = readIn(answer([{ inlineData: { mimeType: "image/jpeg", data: image } }, { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo" } }]), randomCuts);
    expect(r.images.map((i) => [i.thought, i.data.length, i.mimeType])).toEqual([[false, image.length, "image/jpeg"], [false, 0, "image/png"]]);
  });
  it("a large non-image string anywhere is counted, not kept", () => {
    const big = "x".repeat(SMALL_STRING + 1);
    const r = readIn(JSON.stringify({ candidates: [{ content: { parts: [{ text: big }] } }], promptFeedback: { note: big } }), randomCuts);
    expect(r.omitted).toEqual([{ path: "candidates[].content.parts[].text", bytes: big.length }, { path: "promptFeedback.note", bytes: big.length }]);
    expect(r.images).toEqual([]);
  });
});

describe("mocked integration: readAnswer bounds", () => {
  const stream = (text: string, chunk = 4096, headers: Record<string, string> = {}) => {
    const bytes = enc.encode(text); let o = 0;
    return new Response(new ReadableStream({ pull(c) { if (o >= bytes.length) return c.close(); c.enqueue(bytes.slice(o, o + chunk)); o += chunk; } }), { headers });
  };
  it("reads a streamed answer", async () => {
    expect((await readAnswer(stream('{"a":[1,{"b":"c"}]}', 3), 1000)).payload).toEqual({ a: [1, { b: "c" }] });
  });
  it("refuses an oversized answer by declared length or by bytes read", async () => {
    await expect(readAnswer(stream("{}", 10, { "content-length": "5000" }), 1000)).rejects.toThrow("response_too_large");
    await expect(readAnswer(stream(JSON.stringify({ a: "y".repeat(5000) })), 1000)).rejects.toThrow("response_too_large");
  });
  it("a truncated answer is an error, not an empty success", async () => {
    await expect(readAnswer(stream('{"candidates":[{"content":'), 1000)).rejects.toThrow("invalid_answer_json");
  });
  it("a malformed answer cancels the rest of the body", async () => {
    let cancelled = false;
    const body = new ReadableStream({ pull(c) { c.enqueue(enc.encode('{"a":1} x')); }, cancel() { cancelled = true; } });
    await expect(readAnswer(new Response(body), 1_000_000)).rejects.toThrow("invalid_answer_json");
    expect(cancelled).toBe(true);
  });
});
