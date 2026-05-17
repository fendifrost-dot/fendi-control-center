/**
 * research-provider-docs
 *
 * Uses Anthropic Claude with WebSearch to look up the current state of a
 * given video-generation provider's API docs and prompt guidance. Returns
 * structured JSON the AVT UI can render, and also UPDATES the AVT-side
 * provider_capabilities row (last_verified_at + notes refresh) so the
 * compiler sees the latest data on its next read.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  corsHeaders,
  checkProxyAuth,
  jsonError,
  jsonOk,
} from "../_shared/video-providers/proxy.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-6";

const ALLOWED_PROVIDERS = new Set([
  "runway", "veo", "pika", "fal", "grok", "higgsfield",
]);

const AVT_SUPABASE_URL = "https://qoyxgnkvjukovkrvdaiq.supabase.co";

type ResearchResult = {
  provider: string;
  summary: string;
  latest_models: string[];
  best_practice_prompt_format: string;
  recent_changes: string[];
  suggested_prompt_adjustments: string[];
  sources: { title: string; url: string }[];
  last_verified_at: string;
};

function buildPrompt(provider: string): string {
  return [
    `You are auditing the public API and prompt guidance for the "${provider}" AI video generation provider.`,
    `Use the web_search tool to look up the latest first-party documentation. Prefer the provider's own docs (e.g. docs.runwayml.com, ai.google.dev for Veo, docs.x.ai for Grok, fal.ai/models for Fal, pika.art/docs for Pika, higgsfield.ai/docs for Higgsfield).`,
    ``,
    `Return STRICT JSON (no markdown, no commentary) with this shape:`,
    `{`,
    `  "summary": "<2-3 sentences on current state of the API>",`,
    `  "latest_models": ["model-id-1", "model-id-2"],`,
    `  "best_practice_prompt_format": "<concise description of how to phrase prompts for best output>",`,
    `  "recent_changes": ["<change 1>", "<change 2>"],`,
    `  "suggested_prompt_adjustments": ["<actionable tip 1>", "<actionable tip 2>"],`,
    `  "sources": [{"title": "<page title>", "url": "<full url>"}]`,
    `}`,
    ``,
    `Keep arrays to 3-7 items each. Today's date is ${new Date().toISOString().slice(0, 10)}.`,
  ].join("\n");
}

async function callAnthropic(provider: string, apiKey: string): Promise<ResearchResult> {
  const resp = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      tools: [
        { type: "web_search_20250305", name: "web_search", max_uses: 4 },
      ],
      messages: [{ role: "user", content: buildPrompt(provider) }],
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Anthropic ${resp.status}: ${text.slice(0, 400)}`);
  }
  const data = await resp.json();
  let text = "";
  for (const block of data.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") text += block.text;
  }
  const cleaned = text.replace(/```json\s*|\s*```/g, "").trim();
  let parsed: Partial<ResearchResult>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Anthropic returned non-JSON: " + cleaned.slice(0, 200));
    parsed = JSON.parse(m[0]);
  }
  return {
    provider,
    summary: parsed.summary ?? "",
    latest_models: parsed.latest_models ?? [],
    best_practice_prompt_format: parsed.best_practice_prompt_format ?? "",
    recent_changes: parsed.recent_changes ?? [],
    suggested_prompt_adjustments: parsed.suggested_prompt_adjustments ?? [],
    sources: parsed.sources ?? [],
    last_verified_at: new Date().toISOString(),
  };
}

async function writeCapabilityRefresh(provider: string, result: ResearchResult): Promise<void> {
  const avtServiceKey = Deno.env.get("AVT_SERVICE_ROLE_KEY")?.trim();
  if (!avtServiceKey) {
    console.warn("AVT_SERVICE_ROLE_KEY not set; skipping capability refresh.");
    return;
  }
  const avt = createClient(AVT_SUPABASE_URL, avtServiceKey);
  const noteFragment = `Research auto-updated ${result.last_verified_at}. Sources: ${result.sources.map((s) => s.url).join(", ")}.`;
  const { error } = await avt
    .from("provider_capabilities")
    .update({
      notes: noteFragment,
      last_verified_at: result.last_verified_at,
    })
    .eq("provider", provider);
  if (error) console.warn("capability refresh failed:", error.message);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("INVALID_INPUT", "Method must be POST.", 405);

  const auth = checkProxyAuth(req);
  if (!auth.ok) return auth.response;

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY")?.trim();
  if (!apiKey) {
    return jsonError(
      "PROVIDER_KEY_NOT_CONFIGURED",
      "ANTHROPIC_API_KEY is not configured in Control Center.",
      503,
    );
  }

  let body: { provider?: string };
  try { body = await req.json(); } catch {
    return jsonError("INVALID_INPUT", "Body is not valid JSON.", 400);
  }
  const provider = String(body.provider ?? "");
  if (!ALLOWED_PROVIDERS.has(provider)) {
    return jsonError("INVALID_INPUT", `Unknown provider: ${provider}`, 400);
  }

  try {
    const result = await callAnthropic(provider, apiKey);
    await writeCapabilityRefresh(provider, result);
    return jsonOk({ result });
  } catch (err) {
    return jsonError("INTERNAL", String(err), 500, true);
  }
});
