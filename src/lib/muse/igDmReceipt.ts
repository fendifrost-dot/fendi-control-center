/** Prefix written by muse-workboard when FanFuel Hub refuses a manual IG DM receipt. */
export const IG_DM_RECEIPT_REFUSED_PREFIX = "IG_DM_RECEIPT_REFUSED";

/** 403 and 409 are the hub refusals the board has to show. Other statuses are not. */
export function igDmReceiptHubStatus(text: string | null | undefined): 403 | 409 | null {
  if (!text) return null;
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(IG_DM_RECEIPT_REFUSED_PREFIX)) return null;
  const line = trimmed.split("\n").find((row) => row.startsWith("hub_status:"));
  if (line === "hub_status: 403") return 403;
  if (line === "hub_status: 409") return 409;
  return null;
}
