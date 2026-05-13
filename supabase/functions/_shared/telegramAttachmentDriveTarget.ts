/**
 * Resolve the canonical "<CLIENT> CREDIT/responses/" Drive target for an
 * inbound bureau response attachment (Phase 1 intake-streamlining).
 *
 * Honors pipeline-standards Rule 3 (folder canonicality):
 *   - List ALL matching CREDIT folders for the client.
 *   - If multiple match, pick the one with the most recent `modifiedTime` and
 *     log a warning that names the duplicates (so the operator can sweep them).
 *
 * Pure-input variants of `pickCanonicalCreditFolder` and `buildResponseFileName`
 * keep this testable without any live Drive calls.
 */

export interface DriveFolderRef {
  id: string;
  name: string;
  modifiedTime?: string;
}

export interface CanonicalFolderPick {
  chosen: DriveFolderRef;
  duplicates: DriveFolderRef[];
}

export interface DriveSearchClient {
  /** Returns folders whose `name` matches `nameFilter` exactly (case-sensitive). */
  searchFolders(nameFilter: string): Promise<DriveFolderRef[]>;
  /** Returns child folders inside `parentId` whose `name` matches (case-sensitive). */
  searchChildFolders(parentId: string, nameFilter: string): Promise<DriveFolderRef[]>;
  createFolder(name: string, parentId: string): Promise<DriveFolderRef>;
}

export interface ResponsesFolderResolution {
  clientFolder: CanonicalFolderPick;
  responsesFolderId: string;
  responsesFolderName: string;
  /** Human-readable Drive path used in the operator confirmation reply. */
  drivePath: string;
}

/**
 * Pick the canonical match from a candidate list.
 * - 1 match → that one.
 * - >1 match → most-recently-modified (ISO timestamp string sort, descending).
 *   Ties broken by alphabetical name to keep the choice deterministic in tests.
 * - 0 matches → null.
 */
export function pickCanonicalCreditFolder(candidates: DriveFolderRef[]): CanonicalFolderPick | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    return { chosen: candidates[0], duplicates: [] };
  }
  const sorted = [...candidates].sort((a, b) => {
    const ta = a.modifiedTime ?? "";
    const tb = b.modifiedTime ?? "";
    if (tb !== ta) return tb.localeCompare(ta);
    return a.name.localeCompare(b.name);
  });
  return { chosen: sorted[0], duplicates: sorted.slice(1) };
}

/** Build the canonical response filename per the streamlining-plan convention. */
export function buildResponseFileName(opts: {
  isoDate: string;
  bureauCanonical: string;
  shortTag: string;
  extension: string;
}): string {
  const ext = opts.extension.replace(/^\./, "").toLowerCase();
  return `${opts.isoDate}-${opts.bureauCanonical}-${opts.shortTag}.${ext}`;
}

/** Today's date in YYYY-MM-DD (UTC) — extracted so tests can inject a fixed clock. */
export function isoDateUTC(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Candidate folder names to search for, in priority order, given a CG-resolved
 * client display name. Always uppercase.
 *
 * For names with 3+ tokens, also tries a first+last combination so middle
 * names (e.g. "Linda Latrice McCoy") still match folders named after the
 * first and last token only (e.g. "LINDA MCCOY CREDIT"). The Set dedupes
 * the first+last permutation when it collapses to <NAME> for 2-token names.
 *
 * Examples:
 *   "Sam Higgins"          →  ["SAM HIGGINS CREDIT", "SAM CREDIT"]
 *   "John Smith"           →  ["JOHN SMITH CREDIT", "JOHN CREDIT"] (collapsed, no third permutation)
 *   "Linda Latrice McCoy"  →  ["LINDA LATRICE MCCOY CREDIT", "LINDA CREDIT", "LINDA MCCOY CREDIT"]
 *   "Sam"                  →  ["SAM CREDIT"]
 */
export function candidateClientFolderNames(canonicalClientName: string): string[] {
  const cleaned = canonicalClientName.trim().toUpperCase();
  if (!cleaned) return [];
  const tokens = cleaned.split(/\s+/);
  const candidates = new Set<string>();
  candidates.add(`${cleaned} CREDIT`);
  if (tokens.length > 1) {
    candidates.add(`${tokens[0]} CREDIT`);
  }
  if (tokens.length > 2) {
    candidates.add(`${tokens[0]} ${tokens[tokens.length - 1]} CREDIT`);
  }
  return [...candidates];
}

/**
 * Locate (or create) the `<CLIENT> CREDIT/responses/` subfolder on Drive,
 * honoring Rule 3 (canonicality) when multiple matches exist.
 *
 * If no matching CREDIT folder exists at all, throws — Phase 1 won't
 * silently mint a new client folder.
 */
export async function resolveResponsesFolder(
  drive: DriveSearchClient,
  canonicalClientName: string,
  logger: { warn: (msg: string, ctx?: Record<string, unknown>) => void } = {
    warn: (msg, ctx) => console.warn(`[attachment-drive] ${msg}`, ctx ?? {}),
  },
): Promise<ResponsesFolderResolution> {
  const candidateNames = candidateClientFolderNames(canonicalClientName);
  const allMatches: DriveFolderRef[] = [];
  for (const name of candidateNames) {
    const found = await drive.searchFolders(name);
    allMatches.push(...found);
  }

  const dedup = new Map<string, DriveFolderRef>();
  for (const f of allMatches) dedup.set(f.id, f);
  const unique = [...dedup.values()];

  const pick = pickCanonicalCreditFolder(unique);
  if (!pick) {
    throw new Error(
      `No <NAME> CREDIT folder found on Drive for "${canonicalClientName}". ` +
        `Searched: ${candidateNames.join(", ")}. ` +
        `Phase 1 won't auto-create client folders — please create one in Drive first.`,
    );
  }

  if (pick.duplicates.length > 0) {
    logger.warn(
      `multiple CREDIT folders matched "${canonicalClientName}" — using most recently modified. ` +
        `Per pipeline-standards Rule 3, archive the duplicates.`,
      {
        chosen: { id: pick.chosen.id, name: pick.chosen.name, modifiedTime: pick.chosen.modifiedTime },
        duplicates: pick.duplicates.map((d) => ({
          id: d.id,
          name: d.name,
          modifiedTime: d.modifiedTime,
        })),
      },
    );
  }

  // Look for an existing `responses` subfolder, case-insensitive (test 3 saw both
  // `RESPONSES` and `responses` co-existing — pick the most-recently-modified).
  const candidatesLower = await drive.searchChildFolders(pick.chosen.id, "responses");
  const candidatesUpper = await drive.searchChildFolders(pick.chosen.id, "RESPONSES");
  const subDedup = new Map<string, DriveFolderRef>();
  for (const f of [...candidatesLower, ...candidatesUpper]) subDedup.set(f.id, f);
  const subPick = pickCanonicalCreditFolder([...subDedup.values()]);

  let responsesFolder: DriveFolderRef;
  if (subPick) {
    if (subPick.duplicates.length > 0) {
      logger.warn(`multiple "responses" subfolders inside "${pick.chosen.name}" — using most recently modified.`, {
        chosen: { id: subPick.chosen.id, name: subPick.chosen.name },
        duplicates: subPick.duplicates.map((d) => ({ id: d.id, name: d.name })),
      });
    }
    responsesFolder = subPick.chosen;
  } else {
    responsesFolder = await drive.createFolder("responses", pick.chosen.id);
  }

  return {
    clientFolder: pick,
    responsesFolderId: responsesFolder.id,
    responsesFolderName: responsesFolder.name,
    drivePath: `${pick.chosen.name}/${responsesFolder.name}/`,
  };
}

/**
 * Common Telegram-attachment MIME → file extension map. Everything else falls
 * back to a `bin` extension so the upload never fails purely on MIME parsing.
 */
export function extensionForMimeType(mime: string | undefined, fallback = "bin"): string {
  if (!mime) return fallback;
  const m = mime.toLowerCase().trim();
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/webp": "webp",
    "image/gif": "gif",
    "application/pdf": "pdf",
    "text/plain": "txt",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  };
  if (map[m]) return map[m];
  // E.g. "image/x-something" → "x-something" → strip prefixes
  const slash = m.indexOf("/");
  if (slash > 0) {
    const tail = m
      .slice(slash + 1)
      .replace(/^x-/, "")
      .split(";")[0];
    if (/^[a-z0-9]+$/.test(tail) && tail.length <= 8) return tail;
  }
  return fallback;
}
