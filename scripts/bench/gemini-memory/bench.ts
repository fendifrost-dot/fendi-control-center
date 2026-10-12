// Memory benchmark for image-providers-gemini-generate: runs `run()` from a materialised copy of the function against
// the fake Google in fake-google.ts and reports SAMPLED memory (at the function's own phase marks) and PEAK memory
// (polled every 5 ms for the whole run; the true peak may fall between polls, so it is a lower bound on the real peak).
// Usage: deno run -A bench.ts <implDir> <refs:1|2|3> <mode:stream|blob|bytes>   (see run.sh)
import { parseInput } from "./impl/contract.ts"; // re-pointed by run.sh via the symlink `impl`
import { run } from "./impl/run.ts";
const [refsArg = "1", mode = "stream"] = Deno.args;
const user = "00000000-0000-4000-8000-000000000001", project = "00000000-0000-4000-8000-000000000002";
const base = `https://qoyxgnkvjukovkrvdaiq.supabase.co/storage/v1/object/sign/prop-refs/${user}`;
const n = Number(refsArg);
const input = parseInput({ model: "gemini-nano-banana-2.1", n: 1, prompt: "p", resolution: "2k", aspectRatio: "4:5", maxCostUsd: 0.28, avt_user_id: user, avt_project_id: project, jobRowId: "00000000-0000-4000-8000-000000000003", references: Array.from({ length: n }, (_, i) => ({ url: `${base}/${i}.png?token=x`, label: "w", role: "cast" })) });
const local = (u: string | URL | Request, init?: RequestInit) => { const s = String(u instanceof Request ? u.url : u); const url = s.includes("storage/v1") ? `http://127.0.0.1:8787/ref/${s.match(/\/(\d+)\.png/)?.[1] ?? 0}` : `http://127.0.0.1:8787${new URL(s).pathname}`; return fetch(url, init); };
// deno-lint-ignore no-explicit-any
const gc = (globalThis as any).gc as (() => void) | undefined; gc?.();
const m0 = Deno.memoryUsage(); const mb = (b: number) => Math.round(b / 1048576 * 10) / 10;
let peakRss = m0.rss, peakHeap = m0.heapUsed + m0.external;
const poll = setInterval(() => { const m = Deno.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakHeap = Math.max(peakHeap, m.heapUsed + m.external); }, 5);
const t0 = performance.now();
const result = await run(input, "k", local as typeof fetch, mode as "stream" | "blob" | "bytes");
clearInterval(poll);
const m = Deno.memoryUsage(); peakRss = Math.max(peakRss, m.rss);
// deno-lint-ignore no-explicit-any
const phases = (result as any).phases ?? null;
console.log(JSON.stringify({ refs: n, mode, ok: result.ok, err: result.ok ? null : result.errorCode, ms: Math.round(performance.now() - t0), baseRssMB: mb(m0.rss), peakRssAboveBaseMB: mb(peakRss - m0.rss), peakHeapExtAboveBaseMB: mb(peakHeap - (m0.heapUsed + m0.external)), sampledPhases: phases }));
