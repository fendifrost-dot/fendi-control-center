/**
 * Fairway Fixer (Credit Guardian) edge functions — shared fetch.
 * Project: fairway-fixer-18 (Supabase ref gflvvzkiuleeochqcdeb).
 * Default function: cross-project-api (the same project also deploys a control-center-api
 * *alias* that resolves to the same handler — do not confuse with Compass's control-center-api).
 * Set CREDIT_GUARDIAN_FUNCTION to override.
 *
 * DO NOT route Credit Compass traffic through this helper. Credit Compass is a SEPARATE
 * Supabase project (fendi-fight-plan, ref imjnqwcrgpqrouiiazam) with a different action
 * vocabulary. Use `./creditCompass.ts` for Compass.
 *
 * Also distinct from: CC Tax (taxgenerator) — yet another Supabase project.
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
