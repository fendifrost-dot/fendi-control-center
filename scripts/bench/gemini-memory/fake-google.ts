// Separate process: serves references and a Google-shaped answer; drains request bodies like a real server.
const [shape = "sig"] = Deno.args;
const sizes = (Deno.env.get("SIZES") ?? "7511334,2841677,3009321").split(",").map(Number); // live 12 Oct reference sizes
const refs = sizes.map((n, i) => { const b = new Uint8Array(n); b.set([137,80,78,71,13,10,26,10,0,0,0,13]); for (let k = 12; k < n; k++) b[k] = (k * 7919 + i) & 255; return b; });
const img = new Uint8Array(3_136_174); img.set([255,216,255,224,0,16,74,70,73,70,0,1]); for (let k = 12; k < img.length; k++) img[k] = (k * 31) & 255;
const b64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const imgB64 = b64(img);
const final: Record<string, unknown> = { inlineData: { mimeType: "image/jpeg", data: imgB64 } };
const parts: unknown[] = [];
if (shape === "sig") final.thoughtSignature = "A".repeat(7_100_000);
if (shape === "thoughtimgs") parts.push({ thought: true, inlineData: { mimeType: "image/jpeg", data: imgB64 } }, { thought: true, inlineData: { mimeType: "image/jpeg", data: imgB64 } });
parts.push(final);
const ANSWER = new TextEncoder().encode(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { role: "model", parts } }], usageMetadata: { promptTokenCount: 2731 }, modelVersion: "gemini-nano-banana-2.1" }));
let lastBody = 0;
Deno.serve({ port: 8787, onListen() { console.log("ready"); } }, async (req) => {
  const u = new URL(req.url);
  if (u.pathname.startsWith("/ref/")) return new Response(refs[Number(u.pathname.split("/")[2])], { headers: { "content-length": String(refs[Number(u.pathname.split("/")[2])].length) } });
  const body = new Uint8Array(await req.arrayBuffer()); lastBody = body.length; JSON.parse(new TextDecoder().decode(body)); // must be valid JSON
  if (u.pathname.endsWith(":countTokens")) return Response.json({ totalTokens: 2731, receivedBytes: lastBody });
  if (u.pathname.endsWith(":generateContent")) { let off = 0; return new Response(new ReadableStream({ pull(c) { if (off >= ANSWER.length) return c.close(); c.enqueue(ANSWER.slice(off, off + 65536)); off += 65536; } })); }
  return new Response("not found", { status: 404 });
});
