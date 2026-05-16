/**
 * AI treatment generator.
 *
 * Given a music-video project's lyrics, artist profile, visual style, and
 * mood, drafts a director's-treatment narrative using Anthropic's Claude.
 * AVT writes the result into `video_projects.treatment_text` and renders
 * it on the project page with an "Edit" affordance.
 *
 * Reuses Control Center's existing ANTHROPIC_API_KEY secret. Same audit
 * trail (tool_execution_logs) as the video providers.
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

const SYSTEM_PROMPT = `You are an experienced music-video director helping an
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

type DraftRequest = {
  avt_user_id?: string | null;
  avt_project_id?: string | null;
  song_title?: string | null;
  lyrics?: string | null;
  artist_profile?: string | null;
  visual_style?: string | null;
  mood?: string | null;
  additional_notes?: string | null;
};

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
  const lyrics = (body.lyrics ?? "").trim();
  const visualStyle = (body.visual_style ?? "").trim();
  const mood = (body.mood ?? "").trim();
  if (!lyrics && !visualStyle && !mood) {
    return jsonError(
      "INVALID_INPUT",
      "At least one of lyrics, visual_style, or mood must be supplied.",
      400,
    );
  }

  const userPrompt = [
    `Song title: ${body.song_title || "(untitled)"}`,
    `Artist profile:\n${(body.artist_profile ?? "(none supplied)").trim()}`,
    `Visual style: ${visualStyle || "(none)"}`,
    `Mood: ${mood || "(none)"}`,
    `Additional notes: ${(body.additional_notes ?? "(none)").trim()}`,
    "",
    "Lyrics (verbatim — quote 3-5 word fragments from these in the treatment):",
    lyrics || "(none supplied)",
  ].join("\n");

  const log = await startLog({
    provider: "anthropic",
    toolName: "ai.draft_treatment",
    audit: {
      avt_user_id: body.avt_user_id ?? null,
      avt_project_id: body.avt_project_id ?? null,
    },
    modelVariant: DEFAULT_MODEL,
    promptText: userPrompt,
    extraArgs: {
      song_title: body.song_title ?? null,
      visual_style: visualStyle,
      mood,
    },
  });

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
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
          max_tokens: 1500,
          system: SYSTEM_PROMPT,
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
    const treatmentText = (content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => (c.text as string) ?? "")
      .join("\n\n")
      .trim();

    const responseEnvelope = {
      treatmentText,
      model: DEFAULT_MODEL,
      inputTokens: ((upstream.usage as Record<string, unknown> | undefined)?.input_tokens as number) ?? null,
      outputTokens: ((upstream.usage as Record<string, unknown> | undefined)?.output_tokens as number) ?? null,
      stopReason: (upstream.stop_reason as string) ?? null,
    };

    await finishLog(log.logId, "succeeded", {
      httpStatus,
      responseJson: responseEnvelope,
      startedAt: log.startedAt,
    });

    return jsonOk(responseEnvelope);
  } catch (err) {
    await finishLog(log.logId, "failed", { error: String(err), startedAt: log.startedAt });
    return jsonError("INTERNAL", String(err), 500, true);
  }
});
