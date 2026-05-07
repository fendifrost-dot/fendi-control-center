/**
 * Caption parser for Telegram attachment intake (Phase 1 of intake-streamlining-plan).
 *
 * Operator caption shape: `<client> | <bureau> | <round?>`
 * Tolerant of `|`, `/`, `-` separators and case variation.
 *
 * Phase 1 requires an explicit caption — OCR-based identification is Phase 2.
 * If the parse fails the handler must ask the operator to clarify rather than guess.
 *
 * Roster matching is intentionally NOT done here so this module stays pure and
 * trivially testable. Resolve the parsed `client` against the CG roster at the
 * call site (use `resolveUnifiedClientFromName` from unifiedClientResolution.ts).
 */

export interface ParsedAttachmentCaption {
  client: string;
  bureau: string;
  bureauCanonical: BureauCanonical;
  round: number | null;
  roundLabel: string;
  /** Filename-safe descriptor: `r2-response` or `response` when no round. */
  shortTag: string;
}

export type CaptionParseResult =
  | { ok: true; value: ParsedAttachmentCaption }
  | { ok: false; reason: CaptionParseFailure; raw: string };

export type CaptionParseFailure =
  | "empty_caption"
  | "too_few_segments"
  | "missing_client"
  | "missing_bureau"
  | "unknown_bureau";

/**
 * Canonical bureau slugs used in the Drive filename and the queued event payload.
 * Lower-case and hyphen-free so they paste cleanly into filenames.
 */
export type BureauCanonical =
  | "equifax"
  | "experian"
  | "transunion"
  | "innovis"
  | "lexisnexis"
  | "corelogic"
  | "sagestream"
  | "chexsystems"
  | "ars"
  | "other";

const BUREAU_ALIASES: Record<string, BureauCanonical> = {
  equifax: "equifax",
  eq: "equifax",
  experian: "experian",
  ex: "experian",
  transunion: "transunion",
  tu: "transunion",
  "trans union": "transunion",
  innovis: "innovis",
  lexisnexis: "lexisnexis",
  "lexis nexis": "lexisnexis",
  ln: "lexisnexis",
  corelogic: "corelogic",
  "core logic": "corelogic",
  cl: "corelogic",
  sagestream: "sagestream",
  "sage stream": "sagestream",
  ss: "sagestream",
  chexsystems: "chexsystems",
  chex: "chexsystems",
  ars: "ars",
};

const SEPARATOR_RE = /\s*[|/\-–—]\s*/;

/** Pure parse — returns structured data or a structured failure with reason. */
export function parseAttachmentCaption(rawCaption: unknown): CaptionParseResult {
  if (typeof rawCaption !== "string") {
    return { ok: false, reason: "empty_caption", raw: "" };
  }
  const raw = rawCaption.trim();
  if (!raw) return { ok: false, reason: "empty_caption", raw };

  const segments = raw.split(SEPARATOR_RE).map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) {
    return { ok: false, reason: "too_few_segments", raw };
  }

  const [clientRaw, bureauRaw, ...rest] = segments;
  const client = clientRaw.trim();
  if (!client) return { ok: false, reason: "missing_client", raw };

  const bureauInput = (bureauRaw ?? "").trim();
  if (!bureauInput) return { ok: false, reason: "missing_bureau", raw };

  const bureauCanonical = canonicalizeBureau(bureauInput);
  if (bureauCanonical === null) {
    return { ok: false, reason: "unknown_bureau", raw };
  }

  const roundField = rest.join(" ").trim();
  const round = extractRoundNumber(roundField);
  const roundLabel = roundField || (round != null ? `Round ${round}` : "");
  const shortTag = round != null ? `r${round}-response` : "response";

  return {
    ok: true,
    value: {
      client,
      bureau: prettyBureauLabel(bureauCanonical),
      bureauCanonical,
      round,
      roundLabel,
      shortTag,
    },
  };
}

/** Operator-facing clarification text for a parse failure. Stable so tests can assert on it. */
export function clarificationMessageForFailure(failure: CaptionParseFailure, raw: string): string {
  const example = "Example: `Sam | Equifax | Round 2 response`";
  switch (failure) {
    case "empty_caption":
      return `📎 I got an attachment but no caption to route it. Please add a caption. ${example}`;
    case "too_few_segments":
      return `📎 I couldn't parse the caption "${raw}". I need at least client and bureau, separated by | or / or -. ${example}`;
    case "missing_client":
      return `📎 The caption "${raw}" is missing the client name. ${example}`;
    case "missing_bureau":
      return `📎 The caption "${raw}" is missing the bureau. ${example}`;
    case "unknown_bureau":
      return `📎 I don't recognize the bureau in "${raw}". Try Equifax, Experian, TransUnion, Innovis, LexisNexis, CoreLogic, SageStream, ChexSystems, or ARS.`;
  }
}

function canonicalizeBureau(input: string): BureauCanonical | null {
  const key = input.toLowerCase().trim().replace(/[._]+/g, " ").replace(/\s+/g, " ");
  if (BUREAU_ALIASES[key]) return BUREAU_ALIASES[key];

  const noSpaces = key.replace(/\s+/g, "");
  if (BUREAU_ALIASES[noSpaces]) return BUREAU_ALIASES[noSpaces];

  for (const [alias, canonical] of Object.entries(BUREAU_ALIASES)) {
    if (key === alias) return canonical;
    if (key.startsWith(alias + " ") || key.endsWith(" " + alias)) return canonical;
  }
  return null;
}

function prettyBureauLabel(canonical: BureauCanonical): string {
  const map: Record<BureauCanonical, string> = {
    equifax: "Equifax",
    experian: "Experian",
    transunion: "TransUnion",
    innovis: "Innovis",
    lexisnexis: "LexisNexis",
    corelogic: "CoreLogic",
    sagestream: "SageStream",
    chexsystems: "ChexSystems",
    ars: "ARS",
    other: "Other",
  };
  return map[canonical];
}

function extractRoundNumber(s: string): number | null {
  if (!s) return null;
  const m = s.match(/(?:^|\b)(?:r(?:ound)?\.?\s*)(\d{1,2})\b/i);
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }
  const stripped = s.match(/^\s*(\d{1,2})\b/);
  if (stripped) {
    const n = Number(stripped[1]);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
