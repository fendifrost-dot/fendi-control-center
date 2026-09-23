/**
 * Runway video_to_video — canonical model contracts, pricing and request validation.
 *
 * WHY THIS FILE EXISTS SEPARATELY
 * ------------------------------
 * `index.ts` is glue (auth, env, fetch, logging). Everything decidable without I/O lives
 * here so it can be tested directly — the same split `compose-look/helpers.ts` uses.
 *
 * SCOPE
 * -----
 * This is the ONE canonical definition of Runway video-edit model limits and credit rates
 * inside Control Center. `video-providers-runway-generate` keeps its own
 * RUNWAY_CENTS_PER_SECOND_BY_MODEL for text/image-to-video and is not touched: those are
 * different models on different endpoints. Do not copy these rates into another CC
 * function — import them from here.
 *
 * COST AUTHORITY (see docs/control_center_provider_proxy.md)
 * ---------------------------------------------------------
 * Two numbers, two owners, never merged into one ambiguous "costEstimate":
 *
 *   avtAuthorizedMaxCents  — AVT's spend authorization for this operation. AVT owns
 *                            project/user budget; Control Center never invents it.
 *   ccProviderEstimateCents — Control Center's INDEPENDENT estimate of what Runway will
 *                            charge, from the table below.
 *
 * If the Control Center estimate exceeds AVT's authorization, the call fails closed and
 * no provider request is made. Both values are logged.
 */

/** How the input video and the edit instruction are passed. */
export type RunwayVideoEditContract = "aleph2" | "mode_edit";

export type RunwayVideoEditModel = {
  contract: RunwayVideoEditContract;
  /** Image references accepted. 0 = none (aleph2 takes timed keyframes instead). */
  maxReferences: number;
  /** Timed keyframes accepted. */
  maxKeyframes: number;
  maxInputSeconds: number;
  maxPromptChars: number;
  creditsPerOutputSecond: number;
  /** Some models bill the input too. */
  creditsPerInputSecond: number;
  minCredits: number;
  /** Fixed ratio the contract needs, where the model requires one. */
  ratio?: string;
  source: string;
};

/**
 * 1 Runway credit = $0.01 = 1 cent, so credits and cents are numerically equal here.
 * Kept explicit rather than implied, so a future price change has one place to land.
 */
export const CENTS_PER_CREDIT = 1;

/** Runway models that EDIT an existing video. docs.dev.runwayml.com OpenAPI, read 2026-09-23. */
export const RUNWAY_VIDEO_EDIT_MODELS: Record<string, RunwayVideoEditModel> = {
  aleph2: {
    contract: "aleph2",
    maxReferences: 0,
    maxKeyframes: 5,
    maxInputSeconds: 30,
    maxPromptChars: 1000,
    creditsPerOutputSecond: 28,
    creditsPerInputSecond: 0,
    minCredits: 56,
    source:
      "Aleph 2.0: 'Edit one frame and Aleph 2.0 modifies the rest of your video to match'; keyframes are edited frames of THIS video at timestamps (≤ 5); input ≤ 30 s; 28 credits/s with a 56-credit minimum (pricing page 2026-09-23)",
  },
  "gemini_omni_flash_1.1": {
    contract: "mode_edit",
    maxReferences: 5,
    maxKeyframes: 0,
    maxInputSeconds: 10,
    maxPromptChars: 4000,
    creditsPerOutputSecond: 10,
    creditsPerInputSecond: 0,
    minCredits: 0,
    source:
      "video_to_video mode=edit with ≤ 5 image references; input ≤ 10 s; 10 credits/s (pricing page lists t2v/i2v; edit assumed the same until a real invoice proves otherwise). Runway 2026-09-23 (unbilled 400): in edit mode `ratio` is rejected — output orientation follows the input video and resolution is 720p; and `contentModeration` is rejected as an unrecognized key",
  },
  seedance2_5: {
    contract: "mode_edit",
    maxReferences: 30,
    maxKeyframes: 0,
    maxInputSeconds: 10,
    maxPromptChars: 15000,
    creditsPerOutputSecond: 30,
    creditsPerInputSecond: 15,
    minCredits: 0,
    source:
      "Seedance 2.5 video_to_video mode=edit (duration auto) with ≤ 30 image references; 720p: 30 credits/s output + 15 credits/s input = 45 credits/s",
  },
};

export type Keyframe = {
  uri: string;
  seconds?: number;
  at?: string;
  range?: [number, number];
};

export type VideoEditBody = {
  model: string;
  videoUri: string;
  promptText: string;
  keyframes: Keyframe[];
  references: Array<{ uri: string }>;
  ratio?: string;
  contentModeration?: { publicFigureThreshold: "auto" | "low" };
  /** Required for any billed call: without it no cost can be estimated, so none is authorized. */
  inputSeconds: number | null;
  /** AVT's spend authorization, in cents. Required for any billed call. */
  avtAuthorizedMaxCents: number | null;
  dryRun: boolean;
  avt_user_id?: string | null;
  avt_project_id?: string | null;
  avt_shot_id?: string | null;
  avt_prompt_id?: string | null;
};

export type ValidationFailure = { error: string };

function isHttpsUri(v: unknown): v is string {
  return typeof v === "string" && /^https:\/\/\S+$/i.test(v);
}

/**
 * Validate an AVT video-edit request.
 *
 * Fails closed on anything unsupported and NEVER truncates: a silently shortened prompt or
 * a dropped reference would produce a billed render that is not what the caller asked for,
 * which is worse than a rejected request.
 */
export function validateVideoEditBody(body: unknown): VideoEditBody | ValidationFailure {
  if (!body || typeof body !== "object") return { error: "Request body must be a JSON object" };
  const b = body as Record<string, unknown>;

  const modelId = typeof b.model === "string" ? b.model : "";
  const model = RUNWAY_VIDEO_EDIT_MODELS[modelId];
  if (!model) {
    return {
      error: `model must be one of ${Object.keys(RUNWAY_VIDEO_EDIT_MODELS).join(", ")}`,
    };
  }

  if (!isHttpsUri(b.videoUri)) return { error: "videoUri is required and must be an https URL" };

  if (typeof b.promptText !== "string" || b.promptText.trim().length === 0) {
    return { error: "promptText is required and must be a non-empty string" };
  }
  if (b.promptText.length > model.maxPromptChars) {
    return {
      error: `promptText is ${b.promptText.length} characters; ${modelId} accepts at most ${model.maxPromptChars}`,
    };
  }

  // -- keyframes (aleph2 only) --------------------------------------------
  const rawKeyframes = Array.isArray(b.keyframes) ? b.keyframes : [];
  if (rawKeyframes.length > 0 && model.maxKeyframes === 0) {
    return { error: `${modelId} does not accept keyframes` };
  }
  if (rawKeyframes.length > model.maxKeyframes) {
    return {
      error: `${rawKeyframes.length} keyframes supplied; ${modelId} accepts at most ${model.maxKeyframes}`,
    };
  }
  const keyframes: Keyframe[] = [];
  for (const [i, raw] of rawKeyframes.entries()) {
    if (!raw || typeof raw !== "object") return { error: `keyframes[${i}] must be an object` };
    const k = raw as Record<string, unknown>;
    if (!isHttpsUri(k.uri)) return { error: `keyframes[${i}].uri must be an https URL` };
    const kf: Keyframe = { uri: k.uri };
    if (k.seconds !== undefined) {
      if (typeof k.seconds !== "number" || !Number.isFinite(k.seconds) || k.seconds < 0) {
        return { error: `keyframes[${i}].seconds must be a number >= 0` };
      }
      kf.seconds = k.seconds;
    }
    if (k.at !== undefined) {
      if (typeof k.at !== "string" || !k.at) return { error: `keyframes[${i}].at must be a string` };
      kf.at = k.at;
    }
    if (k.range !== undefined) {
      const r = k.range;
      if (!Array.isArray(r) || r.length !== 2 || r.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
        return { error: `keyframes[${i}].range must be [number, number]` };
      }
      kf.range = [r[0] as number, r[1] as number];
    }
    keyframes.push(kf);
  }

  // -- references (mode_edit models) ---------------------------------------
  const rawReferences = Array.isArray(b.references) ? b.references : [];
  if (rawReferences.length > 0 && model.maxReferences === 0) {
    return { error: `${modelId} does not accept image references` };
  }
  if (rawReferences.length > model.maxReferences) {
    return {
      error: `${rawReferences.length} references supplied; ${modelId} accepts at most ${model.maxReferences}`,
    };
  }
  const references: Array<{ uri: string }> = [];
  for (const [i, raw] of rawReferences.entries()) {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (!isHttpsUri(r.uri)) return { error: `references[${i}].uri must be an https URL` };
    references.push({ uri: r.uri });
  }

  // -- duration ------------------------------------------------------------
  let inputSeconds: number | null = null;
  if (b.inputSeconds !== undefined && b.inputSeconds !== null) {
    if (typeof b.inputSeconds !== "number" || !Number.isFinite(b.inputSeconds) || b.inputSeconds <= 0) {
      return { error: "inputSeconds must be a positive number" };
    }
    if (b.inputSeconds > model.maxInputSeconds) {
      return {
        error: `inputSeconds ${b.inputSeconds} exceeds the ${model.maxInputSeconds} s limit for ${modelId}`,
      };
    }
    inputSeconds = b.inputSeconds;
  }

  // -- AVT spend authorization --------------------------------------------
  let avtAuthorizedMaxCents: number | null = null;
  if (b.avtAuthorizedMaxCents !== undefined && b.avtAuthorizedMaxCents !== null) {
    if (
      typeof b.avtAuthorizedMaxCents !== "number" ||
      !Number.isFinite(b.avtAuthorizedMaxCents) ||
      b.avtAuthorizedMaxCents < 0
    ) {
      return { error: "avtAuthorizedMaxCents must be a number >= 0" };
    }
    avtAuthorizedMaxCents = b.avtAuthorizedMaxCents;
  }

  const contentModeration =
    b.contentModeration && typeof b.contentModeration === "object"
      ? (b.contentModeration as { publicFigureThreshold: "auto" | "low" })
      : undefined;

  return {
    model: modelId,
    videoUri: b.videoUri,
    promptText: b.promptText,
    keyframes,
    references,
    ratio: typeof b.ratio === "string" && b.ratio ? b.ratio : undefined,
    contentModeration,
    inputSeconds,
    avtAuthorizedMaxCents,
    dryRun: b.dryRun === true,
    avt_user_id: typeof b.avt_user_id === "string" ? b.avt_user_id : null,
    avt_project_id: typeof b.avt_project_id === "string" ? b.avt_project_id : null,
    avt_shot_id: typeof b.avt_shot_id === "string" ? b.avt_shot_id : null,
    avt_prompt_id: typeof b.avt_prompt_id === "string" ? b.avt_prompt_id : null,
  };
}

/**
 * Control Center's INDEPENDENT estimate of what Runway will charge, in cents.
 * Not AVT's number, and not derived from it — that is the point of having two.
 */
export function estimateCostCents(model: RunwayVideoEditModel, inputSeconds: number): number {
  const credits = Math.max(
    model.minCredits,
    Math.ceil(inputSeconds) * (model.creditsPerOutputSecond + model.creditsPerInputSecond),
  );
  return credits * CENTS_PER_CREDIT;
}

export type CostGate =
  | { ok: true; ccProviderEstimateCents: number; avtAuthorizedMaxCents: number }
  | { ok: false; reason: string; ccProviderEstimateCents: number | null; avtAuthorizedMaxCents: number | null };

/**
 * The spend gate. Fails closed in three ways, all of which mean "do not call the provider":
 * no AVT authorization, no basis for an estimate, or an estimate above what AVT authorized.
 *
 * Missing inputs are refusals rather than defaults on purpose: a default here would be
 * Control Center inventing permission to spend money that AVT never granted.
 */
export function checkCostAuthorization(params: {
  model: RunwayVideoEditModel;
  inputSeconds: number | null;
  avtAuthorizedMaxCents: number | null;
}): CostGate {
  const { model, inputSeconds, avtAuthorizedMaxCents } = params;
  if (avtAuthorizedMaxCents === null) {
    return {
      ok: false,
      reason: "avtAuthorizedMaxCents is required for a billed call — Control Center does not assume a spend limit",
      ccProviderEstimateCents: inputSeconds === null ? null : estimateCostCents(model, inputSeconds),
      avtAuthorizedMaxCents: null,
    };
  }
  if (inputSeconds === null) {
    return {
      ok: false,
      reason: "inputSeconds is required for a billed call — without it the provider cost cannot be estimated",
      ccProviderEstimateCents: null,
      avtAuthorizedMaxCents,
    };
  }
  const ccProviderEstimateCents = estimateCostCents(model, inputSeconds);
  if (ccProviderEstimateCents > avtAuthorizedMaxCents) {
    return {
      ok: false,
      reason: `Control Center estimates ${ccProviderEstimateCents} cents for ${inputSeconds}s, above AVT's authorized maximum of ${avtAuthorizedMaxCents} cents`,
      ccProviderEstimateCents,
      avtAuthorizedMaxCents,
    };
  }
  return { ok: true, ccProviderEstimateCents, avtAuthorizedMaxCents };
}

/** Build the exact Runway request body. Pure, so a dry run can show precisely what would be sent. */
export function buildRunwayRequest(body: VideoEditBody): Record<string, unknown> {
  const model = RUNWAY_VIDEO_EDIT_MODELS[body.model];
  if (model.contract === "aleph2") {
    return {
      model: body.model,
      videoUri: body.videoUri,
      promptText: body.promptText,
      ...(body.keyframes.length ? { keyframes: body.keyframes } : {}),
      ...(body.contentModeration ? { contentModeration: body.contentModeration } : {}),
    };
  }
  return {
    model: body.model,
    videoUri: body.videoUri,
    mode: "edit",
    promptText: body.promptText,
    duration: "auto",
    ...(body.references.length ? { references: body.references } : {}),
    // Edit mode takes neither `ratio` (orientation follows the input; 720p) nor
    // `contentModeration` — Runway answers 400 to both (observed 2026-09-23, unbilled).
    // A model that documents a ratio for edit mode can opt back in via `model.ratio`.
    ...(model.ratio ? { ratio: body.ratio ?? model.ratio } : {}),
  };
}
