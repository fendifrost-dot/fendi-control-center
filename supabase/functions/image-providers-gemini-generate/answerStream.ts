// Streaming reader for Google generateContent answers.
//
// Why: a single 2K image comes back inside an ~11 MB JSON answer (12 Oct 2026: 11,299,168 bytes for a 3.1 MB
// JPEG). Buffering, decoding and JSON.parse-ing the whole answer kept ~4 copies of it alive, and the edge worker
// (256 MB limit) was killed after Google had already billed. This reader walks the bytes once and keeps only what
// the route needs: small fields, and the base64 of non-thought image parts. Every other string longer than
// SMALL_STRING (e.g. the opaque thoughtSignature Google attaches to image parts) is counted, never retained.
// Interim "thought" images are dropped as soon as their part closes. Nothing here is ever sent back to Google.

export const SMALL_STRING = 64 * 1024;
const PART = "candidates[].content.parts[]";
const IMAGE_DATA = new Set([`${PART}.inlineData.data`, `${PART}.inline_data.data`]);
const SIGNATURE = `${PART}.thoughtSignature`;

type Frame = { kind: "obj" | "arr"; value: Record<string, unknown> | unknown[]; key: string | null; data?: string; signatureBytes?: number; thoughtImage?: boolean };
export type OmittedField = { path: string; bytes: number };
export type AnswerImage = { data: string; mimeType: unknown; thought: boolean; signatureBytes: number };
export type StreamedAnswer = { payload: Record<string, unknown>; images: AnswerImage[]; omitted: OmittedField[]; answerBytes: number };

const QUOTE = 0x22, BACKSLASH = 0x5c, COMMA = 0x2c, COLON = 0x3a;
const OPEN_OBJ = 0x7b, CLOSE_OBJ = 0x7d, OPEN_ARR = 0x5b, CLOSE_ARR = 0x5d;
const isWs = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
const bad = () => new Error("invalid_answer_json");

/** Incremental JSON reader: feed() chunks in order, then finish(). Throws "invalid_answer_json" on malformed input. */
export class AnswerReader {
  private stack: Frame[] = [];
  private root: unknown = undefined;
  private done = false;
  // What the next significant byte may be.
  private want: "value" | "key" | "colon" | "next" = "value";
  private emptyOk = false; // directly after "{" or "[": the container may close immediately
  private tok: "none" | "string" | "scalar" = "none";
  private isKey = false;
  private escaped = false;
  private raw: Uint8Array[] = [];
  private rawLen = 0;
  private keep = true;
  private imagePieces: string[] | null = null; // image base64, decoded as it streams (one copy)
  private imageDecoder = new TextDecoder("utf-8");
  private bytes = 0;
  private decoder = new TextDecoder("utf-8", { fatal: true });
  readonly omitted: OmittedField[] = [];
  readonly images: AnswerImage[] = [];

  get answerBytes(): number { return this.bytes; }

  feed(chunk: Uint8Array): void {
    this.bytes += chunk.length;
    let i = 0;
    while (i < chunk.length) {
      if (this.tok === "string") { i = this.readString(chunk, i); continue; }
      const b = chunk[i];
      if (this.tok === "scalar") {
        if (b === COMMA || b === CLOSE_OBJ || b === CLOSE_ARR || isWs(b)) { this.endScalar(); continue; }
        this.push(chunk.subarray(i, i + 1)); i++; continue;
      }
      if (isWs(b)) { i++; continue; }
      if (this.done) throw bad();
      const top = this.stack.at(-1);
      if (this.want === "colon") { if (b !== COLON) throw bad(); this.want = "value"; i++; continue; }
      if (this.want === "next") {
        if (b === COMMA && top) { this.want = top.kind === "obj" ? "key" : "value"; this.emptyOk = false; i++; continue; }
        if ((b === CLOSE_OBJ && top?.kind === "obj") || (b === CLOSE_ARR && top?.kind === "arr")) { this.close(); i++; continue; }
        throw bad();
      }
      if (this.emptyOk && ((b === CLOSE_OBJ && top?.kind === "obj") || (b === CLOSE_ARR && top?.kind === "arr"))) { this.close(); i++; continue; }
      this.emptyOk = false;
      if (this.want === "key") { if (b !== QUOTE) throw bad(); this.startString(true); i++; continue; }
      // want === "value"
      if (b === OPEN_OBJ || b === OPEN_ARR) { this.open(b === OPEN_OBJ ? "obj" : "arr"); i++; continue; }
      if (b === QUOTE) { this.startString(false); i++; continue; }
      if (b === 0x2d || (b >= 0x30 && b <= 0x39) || b === 0x74 || b === 0x66 || b === 0x6e) { this.tok = "scalar"; this.raw = []; this.rawLen = 0; this.keep = true; this.isKey = false; continue; }
      throw bad();
    }
  }

  finish(): StreamedAnswer {
    if (this.tok === "scalar") this.endScalar();
    if (!this.done || this.tok !== "none" || this.stack.length) throw bad();
    const payload = this.root;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw bad();
    return { payload: payload as Record<string, unknown>, images: this.images, omitted: this.omitted, answerBytes: this.bytes };
  }

  /** JSON path of the value being read, array indexes collapsed: candidates[].content.parts[].inlineData.data */
  private path(): string {
    let p = "";
    for (const f of this.stack) {
      if (f.kind === "arr") p += "[]";
      else if (f.key !== null) p += (p ? "." : "") + f.key;
    }
    return p;
  }

  private startString(isKey: boolean): void {
    this.tok = "string"; this.isKey = isKey; this.escaped = false; this.raw = [new Uint8Array([QUOTE])]; this.rawLen = 1; this.keep = true;
    this.imagePieces = null;
    if (!isKey && IMAGE_DATA.has(this.path())) {
      // An interim thought image whose flag was already read is counted, never kept.
      const part = this.stack[this.stack.length - 2];
      if ((part?.value as Record<string, unknown>)?.thought === true) this.keep = false;
      else { this.imagePieces = []; this.raw = []; this.rawLen = 1; }
    }
  }

  private readString(chunk: Uint8Array, start: number): number {
    let i = start;
    while (i < chunk.length) {
      if (this.escaped) { this.escaped = false; i++; continue; }
      // Jump natively to the next quote or backslash: base64 and signatures are long runs of neither.
      const q = chunk.indexOf(QUOTE, i), s = chunk.indexOf(BACKSLASH, i);
      const next = q === -1 ? s : s === -1 ? q : Math.min(q, s);
      if (next === -1) break;
      if (chunk[next] === BACKSLASH) { this.escaped = true; i = next + 1; continue; }
      this.push(chunk.subarray(start, next + 1));
      this.endString();
      return next + 1;
    }
    this.push(chunk.subarray(start, chunk.length));
    return chunk.length;
  }

  private push(slice: Uint8Array): void {
    this.rawLen += slice.length;
    if (!this.keep) return;
    if (this.imagePieces) { this.pushImage(slice); return; }
    if (!this.isKey && this.rawLen > SMALL_STRING && !IMAGE_DATA.has(this.path())) { this.keep = false; this.raw = []; return; }
    this.raw.push(slice.slice());
  }

  /** Base64 is ASCII; the only escape JSON may use inside it is "\/". Anything else is not image data. */
  private pushImage(slice: Uint8Array): void {
    // Base64 is ASCII, so streaming UTF-8 decoding is exact (a non-ASCII byte fails validation later).
    this.imagePieces!.push(this.imageDecoder.decode(slice, { stream: true }));
  }

  private imageValue(): string {
    this.imagePieces!.push(this.imageDecoder.decode());
    let v = this.imagePieces!.join("");
    this.imagePieces = null;
    v = v.slice(0, -1); // closing quote
    if (v.includes("\\")) {
      if (/\\[^/]/.test(v)) throw bad();
      v = v.replace(/\\\//g, "/");
    }
    return v;
  }

  private text(): string {
    const all = new Uint8Array(this.rawLen); let o = 0;
    for (const r of this.raw) { all.set(r, o); o += r.length; }
    this.raw = [];
    try { return this.decoder.decode(all); } catch { throw bad(); }
  }

  private parsed(): unknown {
    try { return JSON.parse(this.text()); } catch { throw bad(); }
  }

  private endString(): void {
    this.tok = "none";
    if (this.isKey) { this.stack.at(-1)!.key = this.parsed() as string; this.want = "colon"; return; }
    const path = this.path();
    const part = this.stack.at(-1)?.kind === "obj" && path === SIGNATURE ? this.stack.at(-1) : undefined;
    if (!this.keep) {
      const bytes = this.rawLen - 2;
      if (IMAGE_DATA.has(path)) { this.stack[this.stack.length - 2].thoughtImage = true; this.assign(null); return; }
      this.omitted.push({ path, bytes });
      if (part) part.signatureBytes = bytes;
      this.assign(null);
      return;
    }
    if (this.imagePieces) {
      // Held on the part frame until the part closes and its "thought" flag is known.
      this.stack[this.stack.length - 2].data = this.imageValue();
      this.assign(null);
      return;
    }
    const value = this.parsed() as string;
    if (part) { part.signatureBytes = value.length; this.assign(null); return; } // opaque: never kept, never logged
    this.assign(value);
  }

  private endScalar(): void { this.tok = "none"; this.assign(this.parsed()); }

  private open(kind: "obj" | "arr"): void {
    this.stack.push({ kind, value: kind === "obj" ? {} : [], key: null });
    this.want = kind === "obj" ? "key" : "value";
    this.emptyOk = true;
  }

  private close(): void {
    const f = this.stack.pop()!;
    this.emptyOk = false;
    if (f.kind === "obj" && this.path() === PART && (f.data !== undefined || f.thoughtImage)) {
      const part = f.value as Record<string, unknown>;
      const blob = (part.inlineData ?? part.inline_data) as Record<string, unknown> | undefined;
      const thought = part.thought === true;
      // Only the first final image is used; later ones are counted, not held.
      const keep = !thought && !this.images.some((i) => !i.thought && i.data !== "");
      this.images.push({ data: keep ? (f.data ?? "") : "", mimeType: blob?.mimeType ?? blob?.mime_type, thought, signatureBytes: f.signatureBytes ?? 0 });
    }
    this.assign(f.value);
  }

  private assign(value: unknown): void {
    const top = this.stack.at(-1);
    if (!top) { this.root = value; this.done = true; return; }
    if (top.kind === "arr") (top.value as unknown[]).push(value);
    else (top.value as Record<string, unknown>)[top.key!] = value;
    this.want = "next";
  }
}

/** Read a fetch Response body through AnswerReader, refusing answers above `limit` bytes. */
export async function readAnswer(response: Response, limit: number): Promise<StreamedAnswer> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > limit) { await response.body?.cancel(); throw new Error("response_too_large"); }
  const body = response.body?.getReader();
  if (!body) throw new Error("empty_response");
  const reader = new AnswerReader();
  try {
    while (true) {
      const { done, value } = await body.read();
      if (done) break;
      if (reader.answerBytes + value.length > limit) { await body.cancel(); throw new Error("response_too_large"); }
      reader.feed(value);
    }
  } catch (e) {
    await body.cancel().catch(() => {}); // don't leave the rest of the answer open
    throw e;
  } finally { body.releaseLock(); }
  return reader.finish();
}
