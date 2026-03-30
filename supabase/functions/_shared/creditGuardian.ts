const CREDIT_GUARDIAN_URL = Deno.env.get("CREDIT_GUARDIAN_URL")!;
const CREDIT_GUARDIAN_KEY = Deno.env.get("CREDIT_GUARDIAN_KEY")!;

export async function fetchCreditGuardian(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${CREDIT_GUARDIAN_URL}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CREDIT_GUARDIAN_KEY,
    },
    body: JSON.stringify(body),
  });
}
