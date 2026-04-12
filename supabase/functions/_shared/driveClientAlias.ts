/**
 * Drive ingest client name normalization + alias map (DRIVE_CLIENT_FOLDER_ALIASES_JSON).
 * Used by ingest-drive-clients and telegram deterministic routing.
 */

export function parseDriveClientAliasesFromEnv(): Record<string, string> {
  const raw = Deno.env.get("DRIVE_CLIENT_FOLDER_ALIASES_JSON");
  if (!raw) return {};
  try {
    const map = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
      if (typeof v === "string" && v.trim()) out[k.toLowerCase().trim()] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

/** Resolve chat/display name → Drive folder filter key (alias-aware). */
export function resolveDriveIngestFilterKey(
  requested: string | undefined,
): { key: string | undefined; usedAlias: boolean } {
  if (!requested) return { key: undefined, usedAlias: false };
  let key = requested.toLowerCase().trim();
  const map = parseDriveClientAliasesFromEnv();
  const mapped = map[key];
  if (mapped) {
    return { key: mapped.toLowerCase().trim(), usedAlias: true };
  }
  return { key, usedAlias: false };
}

/** Simple closest-folder hints when direct substring match fails (operator diagnostics). */
export function suggestClosestDriveFolderNames(requested: string, folderNames: string[], max = 5): string[] {
  const r = requested.toLowerCase().trim();
  if (!r || folderNames.length === 0) return [];
  const scored = folderNames.map((name) => {
    const n = name.toLowerCase();
    let score = 0;
    if (n.includes(r) || r.includes(n)) score += 10;
    const ra = r.replace(/\s+/g, "");
    const na = n.replace(/\s+/g, "");
    if (na.includes(ra) || ra.includes(na)) score += 5;
    let common = 0;
    for (let i = 0; i < Math.min(r.length, n.length); i++) {
      if (r[i] === n[i]) common++;
      else break;
    }
    score += common;
    return { name, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.name);
}
