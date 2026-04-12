/**
 * External Control Hub tool URLs. Set in `.env` (Vite prefix required).
 * Leave unset to show the tool in the menu as “configure URL” (disabled link).
 */
export const hubExternalUrls = {
  artistHub: (import.meta.env.VITE_HUB_ARTIST_HUB_URL as string | undefined)?.trim() || "",
  creditCompass: (import.meta.env.VITE_HUB_CREDIT_COMPASS_URL as string | undefined)?.trim() || "",
  creditGuardian: (import.meta.env.VITE_HUB_CREDIT_GUARDIAN_URL as string | undefined)?.trim() || "",
  autoHub: (import.meta.env.VITE_HUB_AUTO_HUB_URL as string | undefined)?.trim() || "",
  modestStreetwear: (import.meta.env.VITE_HUB_MODEST_STREETWEAR_URL as string | undefined)?.trim() || "",
} as const;

export type HubExternalUrlKey = keyof typeof hubExternalUrls;

/** Display names for `.env` — matches `hubExternalUrls` keys */
export const hubExternalEnvVarName: Record<HubExternalUrlKey, string> = {
  artistHub: "VITE_HUB_ARTIST_HUB_URL",
  creditCompass: "VITE_HUB_CREDIT_COMPASS_URL",
  creditGuardian: "VITE_HUB_CREDIT_GUARDIAN_URL",
  autoHub: "VITE_HUB_AUTO_HUB_URL",
  modestStreetwear: "VITE_HUB_MODEST_STREETWEAR_URL",
};
