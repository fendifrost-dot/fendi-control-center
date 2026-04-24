/**
 * Credit Compass (fendi-fight-plan) edge functions — shared fetch.
 *
 * IMPORTANT: Credit Compass is a DIFFERENT Supabase project from Credit Guardian.
 *   Compass  = https://imjnqwcrgpqrouiiazam.supabase.co   (repo: fendi-fight-plan,  function: control-center-api)
 *   Guardian = https://gflvvzkiuleeochqcdeb.supabase.co   (repo: fairway-fixer-18,  function: cross-project-api + control-center-api alias)
 *
 * Do NOT route Compass traffic through fetchCreditGuardian — the two backends have different
 * action vocabularies. Compass speaks: create_assessment, get_assessments, get_assessment_detail,
 * get_report, generate_report. Guardian speaks: get_clients, get_client_detail, get_documents,
 * save_bureau_response, get_dispute_stats, import_timeline_events, etc. A Compass action sent
 * to Guardian will silently do the wrong thing or 404.
 *
 * Env vars (set in Hub deployment):
 *   CREDIT_COMPASS_URL       (default: https://imjnqwcrgpqrouiiazam.supabase.co)
 *   CREDIT_COMPASS_FUNCTION  (default: control-center-api)
 *   CREDIT_COMPASS_KEY       (required — value mirrors FANFUEL_HUB_KEY on the downstream)
 */
export function getCreditCompassUrl(): string {
  return Deno.env.get("CREDIT_COMPASS_URL") || "https://imjnqwcrgpqrouiiazam.supabase.co";
}

export function getCreditCompassFunctionName(): string {
  return Deno.env.get("CREDIT_COMPASS_FUNCTION") || "control-center-api";
}

export function getCreditCompassKey(): string {
  const k = Deno.env.get("CREDIT_COMPASS_KEY");
  if (!k) throw new Error("CREDIT_COMPASS_KEY is not set");
  return k;
}

/**
 * POST JSON body; authenticates with x-api-key (Compass control-center-api).
 * Falls back to Authorization: Bearer on 401/403 in case the downstream
 * is configured for Supabase anon/service auth instead of the custom header.
 */
export async function fetchCreditCompass(
  body: Record<string, unknown>,
  opts: { correlationId?: string } = {},
): Promise<Response> {
  const url = `${getCreditCompassUrl()}/functions/v1/${getCreditCompassFunctionName()}`;
  const key = getCreditCompassKey();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": key,
  };
  if (opts.correlationId) headers["x-correlation-id"] = opts.correlationId;

  let resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (resp.status === 401 || resp.status === 403) {
    console.log(
      JSON.stringify({
        event: "credit_compass_auth_fallback",
        correlation_id: opts.correlationId,
        status: resp.status,
        note: "x-api-key auth failed; retrying with Authorization: Bearer",
      }),
    );
    const bearerHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    };
    if (opts.correlationId) bearerHeaders["x-correlation-id"] = opts.correlationId;
    resp = await fetch(url, { method: "POST", headers: bearerHeaders, body: JSON.stringify(body) });
  }
  return resp;
}

/**
 * Map a Hub-tool action to Compass's native action vocabulary.
 * Returns null if the tool-action has no direct Compass equivalent (caller should handle).
 */
export function mapToolActionToCompassAction(toolAction: string): string | null {
  switch (toolAction) {
    // Direct 1:1 maps — Compass speaks these natively.
    case "create_assessment":
    case "get_assessments":
    case "get_assessment_detail":
    case "get_report":
    case "generate_report":
      return toolAction;

    // Hub-legacy aliases → Compass equivalents.
    case "get_clients":
      return "get_assessments";
    case "get_client_detail":
    case "get_assessment":
      return "get_assessment_detail";

    // Compass project hosts generate-dispute-letter / generate-specialty-freeze-letter as
    // separate edge functions, not actions on control-center-api. These need a different
    // fetch path — return null so caller routes them explicitly.
    case "get_dispute_letters":
    case "generate_dispute_letters":
      return null;

    default:
      return null;
  }
}
