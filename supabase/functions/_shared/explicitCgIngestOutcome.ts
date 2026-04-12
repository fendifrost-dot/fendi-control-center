/**
 * Deterministic classification + operator-facing copy for explicit Credit Guardian ingest tool results.
 * No LLM — used when explicitCreditGuardianIngest is true.
 */
import { suggestClosestDriveFolderNames } from "./driveClientAlias.ts";

export type CreditGuardianFinalOutcome =
  | "executed_success"
  | "executed_zero_match"
  | "executed_tool_error"
  | "blocked_unimplemented"
  | "blocked_bad_extraction"
  | "blocked_invalid_command"
  | "executed_partial_match";

export interface ExplicitIngestResolved {
  final_outcome: CreditGuardianFinalOutcome;
  operatorMessage: string;
  ingest_result_count: number | null;
  has_alias_suggestions: boolean;
}

/** From Telegram drive_ingest branch: operator text vs resolved Drive filter key. */
export interface ExplicitIngestAliasContext {
  operatorRequestedName: string;
  resolvedFolderKey: string;
  usedAlias: boolean;
}

function formatAliasLine(ctx: ExplicitIngestAliasContext | undefined, requestedLabel: string): string[] {
  const req = ctx?.operatorRequestedName?.trim() || requestedLabel;
  const key = ctx?.resolvedFolderKey?.trim() || requestedLabel;
  const lines = [
    `*Operator request (name):* ${req}`,
    `*Drive filter / resolved key:* ${key}`,
  ];
  if (ctx) {
    lines.push(`*Alias mapping applied:* ${ctx.usedAlias ? `yes (request → \`${key}\`)` : "no"}`);
  }
  return lines;
}

function notableDiagnosticsLines(parsed: Record<string, unknown>): string[] {
  const diag = parsed.ingest_diagnostics as Record<string, unknown> | undefined;
  if (!diag) return [];
  const out: string[] = ["*Notable diagnostics:*"];
  const id = diag.drive_folder_id_suffix;
  if (typeof id === "string") out.push(`- Drive root id (suffix): \`${id}\``);
  if (typeof diag.dedicated_credit_root === "boolean") {
    out.push(`- Dedicated credit root: \`${diag.dedicated_credit_root}\``);
  }
  if (typeof diag.subfolders_total === "number") out.push(`- Subfolders under root: ${diag.subfolders_total}`);
  if (diag.filter_client_name != null) out.push(`- Filter client name: \`${String(diag.filter_client_name)}\``);
  if (typeof diag.skipped_by_client_name_filter === "number" && diag.skipped_by_client_name_filter > 0) {
    out.push(`- Skipped by name filter: ${diag.skipped_by_client_name_filter}`);
  }
  if (typeof diag.skipped_not_credit_rule === "number" && diag.skipped_not_credit_rule > 0) {
    out.push(`- Skipped (not credit rule): ${diag.skipped_not_credit_rule}`);
  }
  return out.length > 1 ? out : [];
}

function clientFolderLines(parsed: Record<string, unknown>): string[] {
  const clients = parsed.clients;
  if (!Array.isArray(clients) || clients.length === 0) return [];
  const lines = ["*Matched Drive folders:*"];
  for (const c of clients.slice(0, 8)) {
    const row = c as Record<string, unknown>;
    const name = typeof row.client === "string" ? row.client : "?";
    const fp = row.files_processed;
    const ee = row.events_extracted;
    const ep = row.events_pushed;
    const errc = Array.isArray(row.errors) ? (row.errors as unknown[]).length : 0;
    lines.push(
      `- *${name}* — files: ${fp ?? "—"}, events ex/push: ${ee ?? "—"}/${ep ?? "—"}${errc ? `, row errors: ${errc}` : ""}`,
    );
  }
  return lines;
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

/** Tool threw, HTTP error JSON, non-JSON body, or guardrail block string. */
export function resolveExplicitIngestStructuredOutcome(
  rawToolOutput: string,
  requestedLabel: string,
  aliasContext?: ExplicitIngestAliasContext,
): ExplicitIngestResolved {
  const raw = rawToolOutput ?? "";
  if (
    /Tool 'ingest_drive_clients' is not allowed for workflow/i.test(raw) ||
    /Tool 'ingest_drive_clients' is not in the tool registry/i.test(raw)
  ) {
    return {
      final_outcome: "blocked_invalid_command",
      operatorMessage: [
        "*Credit Guardian ingest — command blocked*",
        "",
        truncate(raw, 3500),
        "",
        "_If this was unexpected, check workflow tool allowlists and registry._",
      ].join("\n"),
      ingest_result_count: null,
      has_alias_suggestions: false,
    };
  }
  if (/\bError executing ingest_drive_clients\s*:/i.test(raw)) {
    const errLine = raw.replace(/^[\s\u274c\u2757\u26d4]+/u, "").trim();
    return {
      final_outcome: "executed_tool_error",
      operatorMessage: [
        "*Credit Guardian ingest — tool execution failed*",
        "",
        `*Requested filter:* ${requestedLabel}`,
        "",
        "```",
        truncate(errLine, 2800),
        "```",
      ].join("\n"),
      ingest_result_count: null,
      has_alias_suggestions: false,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {
      final_outcome: "executed_tool_error",
      operatorMessage: [
        "*Credit Guardian ingest — malformed response*",
        "",
        "The ingest function did not return valid JSON.",
        "",
        "```",
        truncate(raw, 2000),
        "```",
      ].join("\n"),
      ingest_result_count: null,
      has_alias_suggestions: false,
    };
  }

  if (typeof parsed.error === "string" && parsed.error.length > 0) {
    return {
      final_outcome: "executed_tool_error",
      operatorMessage: [
        "*Credit Guardian ingest — server error*",
        "",
        "```",
        truncate(parsed.error, 2800),
        "```",
      ].join("\n"),
      ingest_result_count: null,
      has_alias_suggestions: false,
    };
  }

  const totalRaw = parsed.total_clients;
  const total = typeof totalRaw === "number" && !Number.isNaN(totalRaw) ? totalRaw : null;
  if (total === null) {
    return {
      final_outcome: "executed_partial_match",
      operatorMessage: [
        "*Credit Guardian ingest — incomplete response*",
        "",
        "Expected numeric `total_clients` in the ingest JSON payload.",
        "",
        "```json",
        truncate(JSON.stringify(parsed, null, 2), 2500),
        "```",
      ].join("\n"),
      ingest_result_count: null,
      has_alias_suggestions: false,
    };
  }

  const hint = typeof parsed.hint === "string" ? parsed.hint : "";
  const diag = parsed.ingest_diagnostics as Record<string, unknown> | undefined;
  const sample = Array.isArray(diag?.folder_names_sample) ? (diag!.folder_names_sample as string[]) : [];
  const suggestions = suggestClosestDriveFolderNames(requestedLabel, sample, 5);
  const hasAliasSuggestions = suggestions.length > 0;

  if (total === 0) {
    const lines = [
      "*Credit Guardian — Drive ingest (zero matching work)*",
      "",
      ...formatAliasLine(aliasContext, requestedLabel),
      "",
      `*Client folders processed:* ${total}`,
    ];
    if (hint) lines.push("", `*Hint:* ${hint}`);
    if (hasAliasSuggestions) {
      lines.push("", "*Similar folder names (check spelling / set `DRIVE_CLIENT_FOLDER_ALIASES_JSON`):*");
      suggestions.forEach((s) => lines.push(`- ${s}`));
    } else if (sample.length) {
      lines.push("", "*Sample folders under Drive root:*");
      sample.slice(0, 10).forEach((s) => lines.push(`- ${s}`));
    }
    lines.push(
      "",
      "*Check:* `DRIVE_FOLDER_ID`, `Google_Cloud_Key`, `DRIVE_CREDIT_ROOT_IS_DEDICATED` (for Zeus/Jabril-style names), and that `client_name` matches the Drive folder or an alias.",
    );
    return {
      final_outcome: "executed_zero_match",
      operatorMessage: lines.join("\n"),
      ingest_result_count: 0,
      has_alias_suggestions: hasAliasSuggestions,
    };
  }

  const totalErrors = typeof parsed.total_errors === "number" ? parsed.total_errors : 0;
  const pushed = typeof parsed.total_events_pushed === "number" ? parsed.total_events_pushed : 0;
  const extracted = typeof parsed.total_events_extracted === "number" ? parsed.total_events_extracted : 0;

  if (totalErrors > 0 || (extracted > 0 && pushed < extracted)) {
    const filesProc = typeof parsed.total_files_processed === "number" ? parsed.total_files_processed : null;
    const partialLines = [
      "*Credit Guardian ingest — completed with issues*",
      "",
      ...formatAliasLine(aliasContext, requestedLabel),
      "",
      `*Client folders processed:* ${total}`,
    ];
    if (filesProc !== null) partialLines.push(`*Files processed (total):* ${filesProc}`);
    partialLines.push(
      `*Events extracted / pushed:* ${extracted} / ${pushed}`,
      `*Warnings/errors (aggregate):* ${totalErrors}`,
      "",
      hint ? `*Hint:* ${hint}` : "_Review per-client entries below if needed._",
    );
    const nd = notableDiagnosticsLines(parsed);
    if (nd.length) partialLines.push("", ...nd);
    const cl = clientFolderLines(parsed);
    if (cl.length) partialLines.push("", ...cl);
    return {
      final_outcome: "executed_partial_match",
      operatorMessage: partialLines.join("\n"),
      ingest_result_count: total,
      has_alias_suggestions: false,
    };
  }

  const filesProcessed = typeof parsed.total_files_processed === "number" ? parsed.total_files_processed : null;
  const successLines = [
    "*Credit Guardian ingest — success*",
    "",
    ...formatAliasLine(aliasContext, requestedLabel),
    "",
    `*Client folders imported:* ${total}`,
  ];
  if (filesProcessed !== null) successLines.push(`*Files processed (total):* ${filesProcessed}`);
  successLines.push(
    `*Events extracted:* ${extracted}`,
    `*Events pushed to Credit Guardian:* ${pushed}`,
    `*Warnings/errors (aggregate):* ${totalErrors}`,
  );
  if (hint) successLines.push("", `*Note:* ${hint}`);
  const ndOk = notableDiagnosticsLines(parsed);
  if (ndOk.length) successLines.push("", ...ndOk);
  const clOk = clientFolderLines(parsed);
  if (clOk.length) successLines.push("", ...clOk);

  return {
    final_outcome: "executed_success",
    operatorMessage: successLines.join("\n"),
    ingest_result_count: total,
    has_alias_suggestions: false,
  };
}
