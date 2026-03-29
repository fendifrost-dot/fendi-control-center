/**
 * Fairway Fixer (Credit Guardian) edge functions — shared fetch.
 * Default function name: cross-project-api (same project also deploys control-center-api alias).
 * Set CREDIT_GUARDIAN_FUNCTION to override.
 *
 * Not to be confused with: Credit Compass (fendi-fight-plan) or CC Tax (taxgenerator) — those
 * are different Supabase projects; they also use a function named control-center-api with Bearer auth.
 */
export function getCreditGuardianUrl(): string {
  return Deno.env.get("CREDIT_GUARDIAN_URL") || "https://gflvvzkiuleeochqcdeb.supabase.co";
}

export function getCreditGuardianFunctionName(): string {
  return Deno.env.get("CREDIT_GUARDIAN_FUNCTION") || "cross-project-api";
}

export function getCreditGuardianKey(): string {
  const k = Deno.env.get("CREDIT_GUARDIAN_KEY");
  if (!k) throw new Error("CREDIT_GUARDIAN_KEY is not set");
  return k;
}

/** POST JSON body; authenticates with x-api-key only (matches Fairway cross-project-api). */
export async function fetchCreditGuardian(body: Record<string, unknown>): Promise<Response> {
  const url = `${getCreditGuardianUrl()}/functions/v1/${getCreditGuardianFunctionName()}`;
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": getCreditGuardianKey(),
    },
    body: JSON.stringify(body),
  });
}
