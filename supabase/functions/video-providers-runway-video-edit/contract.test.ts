// deno test --allow-none video-providers-runway-video-edit/contract.test.ts
//
// Covers the decidable half of the Runway video-edit route: model/limit validation, the
// canonical pricing table, and the spend gate that stands between an AVT request and a
// billed Runway call. `index.ts` is glue over these functions.

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CENTS_PER_CREDIT,
  RUNWAY_VIDEO_EDIT_MODELS,
  buildRunwayRequest,
  checkCostAuthorization,
  estimateCostCents,
  validateVideoEditBody,
  type VideoEditBody,
} from "./contract.ts";

const VIDEO = "https://example.supabase.co/storage/v1/object/sign/project-clips/S08.mp4?token=x";
const IMG = "https://example.supabase.co/storage/v1/object/sign/project-references/ref.png?token=x";

function ok(body: unknown): VideoEditBody {
  const r = validateVideoEditBody(body);
  assert(!("error" in r), `expected valid, got: ${"error" in r ? r.error : ""}`);
  return r as VideoEditBody;
}
function err(body: unknown): string {
  const r = validateVideoEditBody(body);
  assert("error" in r, "expected a validation failure");
  return (r as { error: string }).error;
}

const aleph = (over: Record<string, unknown> = {}) => ({
  model: "aleph2",
  videoUri: VIDEO,
  promptText: "swap the jacket for the approved Look",
  inputSeconds: 4,
  avtAuthorizedMaxCents: 500,
  ...over,
});

// ---------------------------------------------------------------------------
// Model / input validation — fails closed, never truncates
// ---------------------------------------------------------------------------

Deno.test("accepts a well-formed aleph2 request", () => {
  const b = ok(aleph({ keyframes: [{ uri: IMG, seconds: 3.5 }] }));
  assertEquals(b.model, "aleph2");
  assertEquals(b.keyframes.length, 1);
  assertEquals(b.references.length, 0);
  assertEquals(b.inputSeconds, 4);
  assertEquals(b.dryRun, false);
});

Deno.test("rejects an unknown or missing model", () => {
  assertStringIncludes(err(aleph({ model: "gen4_turbo" })), "model must be one of");
  assertStringIncludes(err(aleph({ model: undefined })), "model must be one of");
  // A text-to-video model is not a video-edit model even though Runway serves both.
  assertStringIncludes(err(aleph({ model: "gen4.5" })), "model must be one of");
});

Deno.test("requires an https source video", () => {
  assertStringIncludes(err(aleph({ videoUri: undefined })), "videoUri");
  assertStringIncludes(err(aleph({ videoUri: "http://insecure/x.mp4" })), "videoUri");
  assertStringIncludes(err(aleph({ videoUri: "file:///etc/passwd" })), "videoUri");
});

Deno.test("requires a non-empty prompt and never truncates an over-long one", () => {
  assertStringIncludes(err(aleph({ promptText: "   " })), "promptText is required");
  const tooLong = "x".repeat(RUNWAY_VIDEO_EDIT_MODELS.aleph2.maxPromptChars + 1);
  const message = err(aleph({ promptText: tooLong }));
  assertStringIncludes(message, "accepts at most 1000");
  // The same prompt is fine on a model with a larger ceiling — the limit is per model.
  ok({ model: "seedance2_5", videoUri: VIDEO, promptText: tooLong, inputSeconds: 4, avtAuthorizedMaxCents: 500 });
});

Deno.test("enforces per-model keyframe and reference rules", () => {
  // aleph2 takes keyframes, not references.
  assertStringIncludes(err(aleph({ references: [{ uri: IMG }] })), "does not accept image references");
  const sixKeyframes = Array.from({ length: 6 }, () => ({ uri: IMG, seconds: 1 }));
  assertStringIncludes(err(aleph({ keyframes: sixKeyframes })), "at most 5");

  // mode_edit models take references, not keyframes.
  const omni = { model: "gemini_omni_flash_1.1", videoUri: VIDEO, promptText: "edit", inputSeconds: 4, avtAuthorizedMaxCents: 500 };
  assertStringIncludes(err({ ...omni, keyframes: [{ uri: IMG }] }), "does not accept keyframes");
  assertStringIncludes(
    err({ ...omni, references: Array.from({ length: 6 }, () => ({ uri: IMG })) }),
    "at most 5",
  );
  // Seedance documents 30 — the same request that is too big for Omni is fine here.
  ok({
    model: "seedance2_5",
    videoUri: VIDEO,
    promptText: "edit",
    inputSeconds: 4,
    avtAuthorizedMaxCents: 5000,
    references: Array.from({ length: 30 }, () => ({ uri: IMG })),
  });
  assertStringIncludes(
    err({
      model: "seedance2_5",
      videoUri: VIDEO,
      promptText: "edit",
      inputSeconds: 4,
      avtAuthorizedMaxCents: 5000,
      references: Array.from({ length: 31 }, () => ({ uri: IMG })),
    }),
    "at most 30",
  );
});

Deno.test("rejects malformed keyframes and references", () => {
  assertStringIncludes(err(aleph({ keyframes: [{ uri: "not-a-url" }] })), "must be an https URL");
  assertStringIncludes(err(aleph({ keyframes: [{ uri: IMG, seconds: -1 }] })), "seconds must be a number >= 0");
  assertStringIncludes(err(aleph({ keyframes: [{ uri: IMG, range: [1] }] })), "[number, number]");
  assertStringIncludes(err(aleph({ keyframes: ["nope"] })), "must be an object");
});

Deno.test("enforces the per-model input duration ceiling", () => {
  ok(aleph({ inputSeconds: 30 }));
  assertStringIncludes(err(aleph({ inputSeconds: 31 })), "exceeds the 30 s limit");
  // Omni's ceiling is 10 s, so a clip aleph2 accepts is rejected here.
  assertStringIncludes(
    err({ model: "gemini_omni_flash_1.1", videoUri: VIDEO, promptText: "e", inputSeconds: 11, avtAuthorizedMaxCents: 500 }),
    "exceeds the 10 s limit",
  );
  assertStringIncludes(err(aleph({ inputSeconds: 0 })), "positive number");
});

// ---------------------------------------------------------------------------
// Pricing — one canonical table
// ---------------------------------------------------------------------------

Deno.test("prices each model from the canonical table", () => {
  assertEquals(CENTS_PER_CREDIT, 1);
  // aleph2: 28 credits/s, but a 56-credit floor dominates a short clip.
  assertEquals(estimateCostCents(RUNWAY_VIDEO_EDIT_MODELS.aleph2, 1), 56);
  assertEquals(estimateCostCents(RUNWAY_VIDEO_EDIT_MODELS.aleph2, 4), 112);
  // omni: 10 credits/s, no floor.
  assertEquals(estimateCostCents(RUNWAY_VIDEO_EDIT_MODELS["gemini_omni_flash_1.1"], 4), 40);
  // seedance: 30 output + 15 input = 45 credits/s.
  assertEquals(estimateCostCents(RUNWAY_VIDEO_EDIT_MODELS.seedance2_5, 4), 180);
  // Partial seconds round up — never bill-surprise downward.
  assertEquals(estimateCostCents(RUNWAY_VIDEO_EDIT_MODELS["gemini_omni_flash_1.1"], 4.2), 50);
});

// ---------------------------------------------------------------------------
// The spend gate
// ---------------------------------------------------------------------------

Deno.test("passes when the Control Center estimate is within AVT's authorization", () => {
  const gate = checkCostAuthorization({ model: RUNWAY_VIDEO_EDIT_MODELS.aleph2, inputSeconds: 4, avtAuthorizedMaxCents: 200 });
  assert(gate.ok);
  assertEquals(gate.ccProviderEstimateCents, 112);
  assertEquals(gate.avtAuthorizedMaxCents, 200);
});

Deno.test("fails closed when the provider estimate exceeds AVT's authorization", () => {
  const gate = checkCostAuthorization({ model: RUNWAY_VIDEO_EDIT_MODELS.aleph2, inputSeconds: 4, avtAuthorizedMaxCents: 100 });
  assert(!gate.ok);
  assertStringIncludes(gate.reason, "above AVT's authorized maximum");
  // Both numbers survive into the refusal so the log can show why it was refused.
  assertEquals(gate.ccProviderEstimateCents, 112);
  assertEquals(gate.avtAuthorizedMaxCents, 100);
});

Deno.test("fails closed when AVT sent no authorization at all", () => {
  // Control Center must never invent a spend limit AVT did not grant.
  const gate = checkCostAuthorization({ model: RUNWAY_VIDEO_EDIT_MODELS.aleph2, inputSeconds: 4, avtAuthorizedMaxCents: null });
  assert(!gate.ok);
  assertStringIncludes(gate.reason, "avtAuthorizedMaxCents is required");
});

Deno.test("fails closed when the cost cannot be estimated", () => {
  const gate = checkCostAuthorization({ model: RUNWAY_VIDEO_EDIT_MODELS.aleph2, inputSeconds: null, avtAuthorizedMaxCents: 500 });
  assert(!gate.ok);
  assertStringIncludes(gate.reason, "inputSeconds is required");
  assertEquals(gate.ccProviderEstimateCents, null);
});

Deno.test("an exactly-equal estimate is authorized", () => {
  const gate = checkCostAuthorization({ model: RUNWAY_VIDEO_EDIT_MODELS.aleph2, inputSeconds: 4, avtAuthorizedMaxCents: 112 });
  assert(gate.ok);
});

// ---------------------------------------------------------------------------
// Request building — what a dry run shows is what would be sent
// ---------------------------------------------------------------------------

Deno.test("builds the aleph2 contract with keyframes and no mode field", () => {
  const body = buildRunwayRequest(ok(aleph({ keyframes: [{ uri: IMG, seconds: 3.5 }], contentModeration: { publicFigureThreshold: "low" } })));
  assertEquals(body.model, "aleph2");
  assertEquals(body.videoUri, VIDEO);
  assertEquals(body.mode, undefined);
  assertEquals((body.keyframes as unknown[]).length, 1);
  assertEquals(body.contentModeration, { publicFigureThreshold: "low" });
});

Deno.test("builds the mode_edit contract with references and duration auto, and never sends ratio or contentModeration in edit mode", () => {
  const omni = buildRunwayRequest(
    ok({ model: "gemini_omni_flash_1.1", videoUri: VIDEO, promptText: "edit", inputSeconds: 4, avtAuthorizedMaxCents: 500, references: [{ uri: IMG }], contentModeration: { publicFigureThreshold: "low" } }),
  );
  assertEquals(omni.mode, "edit");
  assertEquals(omni.duration, "auto");
  // Runway 2026-09-23: edit mode rejects `ratio` (orientation follows the input, 720p) and
  // `contentModeration` (unrecognized key) with 400 — both observed, both unbilled.
  assertEquals(omni.ratio, undefined);
  assertEquals(omni.contentModeration, undefined);
  assertEquals((omni.references as unknown[]).length, 1);

  // seedance2_5 derives its own ratio — sending one would be wrong.
  const seed = buildRunwayRequest(
    ok({ model: "seedance2_5", videoUri: VIDEO, promptText: "edit", inputSeconds: 4, avtAuthorizedMaxCents: 500 }),
  );
  assertEquals(seed.ratio, undefined);
  assertEquals(seed.mode, "edit");
});

Deno.test("omits empty keyframe and reference arrays rather than sending []", () => {
  const body = buildRunwayRequest(ok(aleph()));
  assert(!("keyframes" in body));
  assert(!("references" in body));
});

// ---------------------------------------------------------------------------
// Audit passthrough
// ---------------------------------------------------------------------------

Deno.test("carries AVT audit identifiers through validation", () => {
  const b = ok(aleph({ avt_user_id: "u1", avt_project_id: "p1", avt_shot_id: "S08", avt_prompt_id: "pr1" }));
  assertEquals(b.avt_user_id, "u1");
  assertEquals(b.avt_project_id, "p1");
  assertEquals(b.avt_shot_id, "S08");
  assertEquals(b.avt_prompt_id, "pr1");
});

Deno.test("a dry run needs neither duration nor authorization to resolve a request", () => {
  // The $0 inspection path must work before any spend decision has been made.
  const b = ok({ model: "aleph2", videoUri: VIDEO, promptText: "edit", dryRun: true });
  assertEquals(b.dryRun, true);
  assertEquals(b.inputSeconds, null);
  assertEquals(b.avtAuthorizedMaxCents, null);
  assertEquals(buildRunwayRequest(b).model, "aleph2");
});
