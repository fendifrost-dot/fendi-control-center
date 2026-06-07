/**
 * AI treatment generator.
 *
 * Three modes (request.mode):
 *  - "prose" (default, backward-compatible): drafts a one-page director's
 *    treatment narrative. Response: { treatmentText, model, ... }.
 *  - "suggest_concepts": proposes 3 concept directions from song context.
 *    Response: { concepts: [{title, logline, visual_world, why_it_fits}], ... }.
 *  - "full_treatment": fills a client-computed, beat-aligned clip grid with
 *    scene/camera/wardrobe direction + per-clip asset dependencies.
 *    Response: { treatment: { concept, narrative, sections, clips }, ... }.
 *
 * The clip grid is computed deterministically in AVT (bar-snapped 3-5s
 * clips from song analysis) — the model never does timing math, it only
 * fills creative fields and echoes each clip's `key`.
 *
 * Reuses Control Center's ANTHROPIC_API_KEY secret. Same audit trail
 * (tool_execution_logs) as the video providers.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  corsHeaders,
  checkProxyAuth,
  jsonError,
  jsonOk,
  startLog,
  finishLog,
} from "../_shared/video-providers/proxy.ts";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-20250514";

const PROSE_SYSTEM_PROMPT = `You are an experienced music-video director helping an
independent artist draft a treatment for one of their songs. Your output
is the body of a one-page treatment document. It must:

- Open with a one-sentence elevator pitch (the "concept").
- Then 3-5 short paragraphs covering: visual world / mood, character &
  wardrobe, key recurring images / motifs, narrative arc tied to the
  song's structure, and a closing image.
- Use direct, evocative present-tense language.
- Reference specific lyric beats by quoting 3-5 word fragments from the
  supplied lyrics, in quotes. Do NOT invent lyrics the artist did not
  supply.
- Honour the artist profile, visual style, and mood supplied. If the
  user provided constraints (locked reference, era, location), respect them.

Do not output a title, headings, scene numbers, shot lists, or any
markdown. Pure prose paragraphs separated by blank lines. Aim for ~350
words.`;

const CONCEPTS_SYSTEM_PROMPT = `You are an experienced director pitching treatment
concepts for an independent artist. You may be pitching for a music video,
a commercial, or short-form social content — the brief says which.

Given the brief (song analysis, lyrics, mood, style, artist profile),
propose exactly 3 distinct concept directions. Make them genuinely
different from each other (e.g. one performance-forward, one narrative,
one stylized/surreal). Each must be achievable with AI video generation
plus the artist's reference looks — favour strong recurring visual motifs
and consistent wardrobe over complex multi-actor dialogue scenes.

Respond with ONLY a JSON object, no markdown fences, no commentary:
{
  "concepts": [
    {
      "title": "2-5 word concept name",
      "logline": "one-sentence elevator pitch",
      "visual_world": "2-3 sentences: palette, locations, lighting, motifs",
      "why_it_fits": "1-2 sentences tying it to the song's energy/lyrics or the brief"
    }
  ]
}`;

const FULL_SYSTEM_PROMPT = `You are an experienced director turning an approved
concept into a production-ready, clip-by-clip treatment. The cut points
are already locked to the music's beat grid — you are given a list of
clips with fixed start/end times, song section, and an energy label.
You do NOT change timing. You fill in the creative direction.

Rules:
- Echo each clip's "key" exactly. Provide direction for EVERY clip in the grid.
- Maintain one coherent visual world from the concept across all clips.
  Build recurring motifs; escalate intensity with energy; "drop" clips get
  the boldest imagery (whips, strobes, hero shots, VFX accents).
- Vary shot_type across: performance, b_roll, narrative, vfx, transition,
  lyric_visual. High-energy sections lean performance/vfx; low-energy lean
  b_roll/narrative. Keep roughly 40-60% performance for music videos.
- scene_description: 1-2 tight sentences, present tense, concrete and
  generation-friendly (subject, action, setting). No camera language here.
- camera_direction: lens/movement language (e.g. "35mm push-in, low angle").
- lighting: short phrase. wardrobe: reference a supplied look by its exact
  name when one fits, else describe. environment: short phrase.
- recommended_tool: one of runway, veo, grok, higgsfield, pika, fal, manual.
  Use image-to-video-friendly tools (runway, fal, pika) for clips that
  depend on a generated still.
- lyric_ref: a 3-6 word verbatim fragment from the supplied lyrics that
  this clip sits under, or null. Never invent lyrics.
- dependencies: list prep assets that must be generated BEFORE this clip
  can be made. Use kind "look_composite" (artist composited into a named
  look), "faceswap_still" (artist's face swapped onto a model/reference
  image first), "reference_image" (a still that must be generated as the
  image-to-video source), or "other". Include a short "note" and, when it
  references a look, the exact look name in "look". Most simple clips have
  no dependencies — only add them when the concept genuinely requires a
  pre-built asset (e.g. wearing a branded look the artist doesn't own).
- priority: "hero" for 3-6 signature clips (drops/hooks), "high" for hook
  clips, else "normal".

Respond with ONLY a JSON object, no markdown fences, no commentary:
{
  "concept": "one-sentence restatement of the concept",
  "narrative": "3-5 sentences: the arc of the video across its sections",
  "sections": [ { "name": "...", "intent": "1 sentence creative intent" } ],
  "clips": [
    {
      "key": "echoed from input",
      "shot_type": "performance|b_roll|narrative|vfx|transition|lyric_visual",
      "scene_description": "...",
      "camera_direction": "...",
      "lighting": "...",
      "wardrobe": "...",
      "environment": "...",
      "recommended_tool": "runway|veo|grok|higgsfield|pika|fal|manual",
      "lyric_ref": "verbatim fragment or null",
      "priority": "normal|high|hero",
      "dependencies": [ { "kind": "look_composite|faceswap_still|reference_image|other", "look": "exact look name or null", "note": "..." } ]
    }
  ]
}`;

type ClipGridItem = {
  key?: string;
  start?: number;
  end?: number;
  section?: string;
  energy?: string;
};

type DraftRequest = {
  mode?: "prose" | "suggest_concepts" | "full_treatment" | null;
  avt_user_id?: string | null;
  avt_project_id?: string | null;
  project_type?: string | null; // music_video | commercial | social
  song_title?: string | null;
  lyrics?: string | null;
  artist_profile?: string | null;
  visual_style?: string | null;
  mood?: string | null;
  additional_notes?: string | null;
  concept?: string | null;
  analysis?: Record<string, unknown> | null;
  clip_grid?: ClipGridItem[] | null;
  looks?: Array<{ name?: string; description?: string }> | null;
};

/** Strip code fences / commentary and parse the first JSON object found. */
function extractJson(raw: string): Record<string, unknown> | null {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function buildContextBlock(body: DraftRequest): string {
  const looks = (body.looks ?? [])
    .filter((l) => (l?.name ?? "").trim())
    .map((l) => `- ${l.name}${l.description ? `: ${l.description}` : ""}`)
    .join("\n");
  const analysis = body.analysis
    ? JSON.stringify(body.analysis)
    : "(no song analysis)";
  return [
    `Project type: ${body.project_type || "music_video"}`,
    `Song title: ${body.song_title || "(untitled)"}`,
    `Artist profile:\n${(body.artist_profile ?? "(none supplied)").trim()}`,
    `Visual style: ${(body.visual_style ?? "").trim() || "(none)"}`,
    `Mood: ${(body.mood ?? "").trim() || "(none)"}`,
    `Additional notes: ${(body.additional_notes ?? "(none)").trim()}`,
    `Available looks (use exact names in wardrobe/dependencies):\n${looks || "(none)"}`,
    `Song analysis summary: ${analysis}`,
    "",
    "Lyrics (verbatim — only quote fragments that appear here):",
    (body.lyrics ?? "").trim() || "(none supplied)",
  ].join("\n");
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
      false,
    );
  }

  let body: DraftRequest;
  try {
    body = (await req.json()) as DraftRequest;
  } catch {
    return jsonError("INVALID_INPUT", "Request body is not valid JSON.", 400);
  }

  const mode = body.mode === "suggest_concepts" || body.mode === "full_treatment"
    ? body.mode
    : "prose";
  const lyrics = (body.lyrics ?? "").trim();
  const visualStyle = (body.visual_style ?? "").trim();
  const mood = (body.mood ?? "").trim();

  if (mode === "prose" && !lyrics && !visualStyle && !mood) {
    return jsonError(
      "INVALID_INPUT",
      "At least one of lyrics, visual_style, or mood must be supplied.",
      400,
    );
  }
  if (mode === "full_treatment") {
    if (!(body.concept ?? "").trim()) {
      return jsonError("INVALID_INPUT", "full_treatment requires a concept.", 400);
    }
    const grid = body.clip_grid ?? [];
    if (!Array.isArray(grid) || grid.length === 0) {
      return jsonError("INVALID_INPUT", "full_treatment requires a non-empty clip_grid.", 400);
    }
    if (grid.length > 120) {
      return jsonError("INVALID_INPUT", "clip_grid is too large (max 120 clips).", 400);
    }
  }

  // ---- Build per-mode prompt ----------------------------------------------
  let systemPrompt = PROSE_SYSTEM_PROMPT;
  let userPrompt: string;
  let maxTokens = 1500;

  if (mode === "prose") {
    userPrompt = [
      `Song title: ${body.song_title || "(untitled)"}`,
      `Artist profile:\n${(body.artist_profile ?? "(none supplied)").trim()}`,
      `Visual style: ${visualStyle || "(none)"}`,
      `Mood: ${mood || "(none)"}`,
      `Additional notes: ${(body.additional_notes ?? "(none)").trim()}`,
      "",
      "Lyrics (verbatim — quote 3-5 word fragments from these in the treatment):",
      lyrics || "(none supplied)",
    ].join("\n");
  } else if (mode === "suggest_concepts") {
    systemPrompt = CONCEPTS_SYSTEM_PROMPT;
    maxTokens = 1800;
    userPrompt = buildContextBlock(body);
  } else {
    systemPrompt = FULL_SYSTEM_PROMPT;
    const grid = (body.clip_grid ?? []).map((c) => ({
      key: String(c.key ?? ""),
      start: Number(c.start ?? 0),
      end: Number(c.end ?? 0),
      section: String(c.section ?? ""),
      energy: String(c.energy ?? "mid"),
    }));
    maxTokens = Math.min(2000 + grid.length * 160, 16000);
    userPrompt = [
      buildContextBlock(body),
      "",
      `APPROVED CONCEPT:\n${(body.concept ?? "").trim()}`,
      "",
      `CLIP GRID (timing is locked — fill creative fields for every clip, echo keys exactly):`,
      JSON.stringify(grid),
    ].join("\n");
  }

  const log = await startLog({
    provider: "anthropic",
    toolName: `ai.draft_treatment.${mode}`,
    audit: {
      avt_user_id: body.avt_user_id ?? null,
      avt_project_id: body.avt_project_id ?? null,
    },
    modelVariant: DEFAULT_MODEL,
    promptText: userPrompt.slice(0, 4000),
    extraArgs: {
      mode,
      song_title: body.song_title ?? null,
      visual_style: visualStyle,
      mood,
      clip_count: body.clip_grid?.length ?? null,
    },
  });

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000);
    let httpStatus = 0;
    let upstream: Record<string, unknown> = {};
    try {
      const resp = await fetch(ANTHROPIC_URL, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });
      httpStatus = resp.status;
      const text = await resp.text();
      try { upstream = text ? JSON.parse(text) : {}; } catch { upstream = { raw: text }; }
      if (!resp.ok) {
        await finishLog(log.logId, "failed", {
          httpStatus,
          error: ((upstream.error as Record<string, unknown> | undefined)?.message as string) ?? text.slice(0, 500),
          startedAt: log.startedAt,
        });
        return jsonError(
          httpStatus === 401 || httpStatus === 403 ? "UNAUTHORISED" : "PROVIDER_API_ERROR",
          `Anthropic returned ${httpStatus}`,
          httpStatus >= 400 && httpStatus < 600 ? httpStatus : 502,
          httpStatus === 429 || (httpStatus >= 500 && httpStatus < 600),
        );
      }
    } finally {
      clearTimeout(timer);
    }

    // Extract the text from Anthropic's content blocks.
    const content = upstream.content as Array<Record<string, unknown>> | undefined;
    const rawText = (content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => (c.text as string) ?? "")
      .join("\n\n")
      .trim();

    const usage = upstream.usage as Record<string, unknown> | undefined;
    const base = {
      model: DEFAULT_MODEL,
      inputTokens: (usage?.input_tokens as number) ?? null,
      outputTokens: (usage?.output_tokens as number) ?? null,
      stopReason: (upstream.stop_reason as string) ?? null,
    };

    let responseEnvelope: Record<string, unknown>;
    if (mode === "prose") {
      responseEnvelope = { treatmentText: rawText, ...base };
    } else {
      const parsed = extractJson(rawText);
      if (!parsed) {
        await finishLog(log.logId, "failed", {
          httpStatus,
          error: `Model did not return parseable JSON (${rawText.slice(0, 200)})`,
          startedAt: log.startedAt,
        });
        return jsonError("PROVIDER_API_ERROR", "Model did not return valid JSON — try again.", 502, true);
      }
      if (mode === "suggest_concepts") {
        responseEnvelope = { concepts: parsed.concepts ?? [], ...base };
      } else {
        responseEnvelope = { treatment: parsed, ...base };
      }
    }

    await finishLog(log.logId, "succeeded", {
      httpStatus,
      responseJson: { mode, ...base },
      startedAt: log.startedAt,
    });

    return jsonOk(responseEnvelope);
  } catch (err) {
    await finishLog(log.logId, "failed", { error: String(err), startedAt: log.startedAt });
    return jsonError("INTERNAL", String(err), 500, true);
  }
});
