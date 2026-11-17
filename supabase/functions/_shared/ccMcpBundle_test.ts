import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../", import.meta.url);
const ENTRY = new URL("../control-center-mcp/index.ts", import.meta.url);

function allowed(url: URL): boolean {
  const path = url.pathname;
  return path.includes("/supabase/functions/control-center-mcp/")
    || path.includes("/supabase/functions/_shared/");
}

function relativeSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const pattern = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) specs.push(match[1]);
  return specs;
}

async function walk(entry: URL): Promise<string[]> {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const url = pending.pop()!;
    const key = url.pathname;
    if (seen.has(key)) continue;
    seen.add(key);
    const source = await Deno.readTextFile(url);
    for (const spec of relativeSpecifiers(source)) {
      if (!spec.startsWith(".")) continue;
      const next = new URL(spec, url);
      pending.push(next);
    }
  }
  return [...seen];
}

Deno.test("control-center-mcp imports stay inside its folder and _shared", async () => {
  const files = await walk(ENTRY);
  assert(files.some((path) => path.endsWith("/_shared/museExecutiveContract.ts")));
  assert(files.some((path) => path.endsWith("/_shared/museWorkboardContract.ts")));
  const escaped = files.filter((path) => !allowed(new URL(`file://${path}`)));
  assertEquals(escaped, []);
  for (const path of files) {
    assert(!path.includes("/muse-executive/"), path);
    assert(!path.includes("/muse-workboard/"), path);
    assert(!path.includes("/muse-alerts/"), path);
  }
  assert(files.length > 5);
  // The walker starts inside the functions tree.
  assert(ENTRY.pathname.startsWith(new URL(".", ROOT).pathname));
});

Deno.test("claude subscriber migration matches the chatgpt pull row and avoids the Claude alias", async () => {
  const sql = await Deno.readTextFile(new URL(
    "../../migrations/20261117180000_muse_alert_claude_pull_subscriber.sql",
    import.meta.url,
  ));
  assert(sql.includes("'claude'"));
  assert(sql.includes("array['audit']"));
  assert(sql.includes("array['claude']"));
  assert(sql.includes("'pull'"));
  assert(sql.includes("on conflict (agent_key) do nothing"));
  const values = sql.split("\n").find((line) => line.trim().startsWith("values "));
  assert(values);
  assert(!values.includes("Claude"));
  assert(!values.includes("webhook"));
});
