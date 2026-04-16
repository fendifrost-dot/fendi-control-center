/**
 * Single resolver for Credit Guardian + Control Hub client identity (name → CG client id).
 * Used by analyze-credit-strategy and any edge function that must match Compass / Guardian / Hub consistently.
 */

import { fetchCreditGuardian } from "./creditGuardian.ts";
import { fuzzyClientSearch } from "./fuzzyClientSearch.ts";

export interface UnifiedClientResolution {
  clientId: string | null;
  needsVerification: boolean;
  message?: string;
  matchedName?: string;
}

function levenshtein(a: string, b: string): number {
  const al = a.toLowerCase(), bl = b.toLowerCase();
  const matrix: number[][] = [];
  for (let i = 0; i <= al.length; i++) matrix[i] = [i];
  for (let j = 0; j <= bl.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= al.length; i++) {
    for (let j = 1; j <= bl.length; j++) {
      const cost = al[i - 1] === bl[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[al.length][bl.length];
}

function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/** Credit Guardian API returns `legal_name` / `preferred_name` (see fairway `get_clients`), not always `name`. */
export function cgDisplayName(c: Record<string, unknown>): string {
  const n = c.name ?? c.legal_name ?? c.preferred_name;
  return typeof n === "string" ? n : "";
}

/** Strip trailing folder-style dates e.g. "Jabril 04.10" → "Jabril" for matching. */
export function normalizeCreditClientName(raw: string): string {
  let s = raw.trim();
  s = s.replace(/\s+\d{1,2}\.\d{1,2}(?:\.\d{2,4})?\s*$/i, "").trim();
  s = s.replace(/\s+\d{4}-\d{2}-\d{2}\s*$/i, "").trim();
  return s;
}

function tokenMatch(query: string, target: string): number {
  const q = query.toLowerCase().trim();
  const t = target.toLowerCase().trim();
  if (q === t) return 1.0;
  if (t.includes(q)) return 0.85;
  if (q.includes(t)) return 0.75;
  const qTokens = q.split(/[\s\-_]+/).filter(Boolean);
  const tTokens = t.split(/[\s\-_]+/).filter(Boolean);
  let matched = 0;
  for (const qt of qTokens) {
    for (const tt of tTokens) {
      if (tt.includes(qt) || qt.includes(tt)) {
        matched++;
        break;
      }
      if (nameSimilarity(qt, tt) > 0.75) {
        matched += 0.7;
        break;
      }
    }
  }
  return qTokens.length > 0 ? (matched / qTokens.length) * 0.7 : 0;
}

/**
 * Resolve a human-entered client name to a Credit Guardian client id (and Hub id when present in fuzzy search).
 */
export async function resolveUnifiedClientFromName(clientName: string): Promise<UnifiedClientResolution> {
  const normalizedName = normalizeCreditClientName(clientName);
  const namesToMatch = [...new Set([normalizedName, clientName.trim()].filter((n) => n.length >= 2))];

  try {
    const resp = await fetchCreditGuardian({ action: "get_clients" });
    if (resp.ok) {
      const payload = await resp.json();
      const rows = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : []);

      for (const queryName of namesToMatch) {
        const exact = rows.find((c: Record<string, unknown>) =>
          cgDisplayName(c).toLowerCase() === queryName.toLowerCase()
        );
        if (exact && typeof (exact as { id?: string }).id === "string") {
          return { clientId: (exact as { id: string }).id, needsVerification: false, matchedName: cgDisplayName(exact) };
        }

        const substring = rows.find((c: Record<string, unknown>) => {
          const name = cgDisplayName(c).toLowerCase();
          const query = queryName.toLowerCase();
          return name.includes(query) || query.includes(name);
        });
        if (substring && typeof (substring as { id?: string }).id === "string") {
          return {
            clientId: (substring as { id: string }).id,
            needsVerification: false,
            matchedName: cgDisplayName(substring),
          };
        }

        const scored = rows
          .map((c: Record<string, unknown>) => ({
            id: c.id as string,
            name: cgDisplayName(c),
            score: Math.max(
              tokenMatch(queryName, cgDisplayName(c)),
              nameSimilarity(queryName, cgDisplayName(c)),
            ),
          }))
          .filter((c: { id: string; name: string; score: number }) => c.name && c.score >= 0.5)
          .sort((a: { score: number }, b: { score: number }) => b.score - a.score);

        if (scored.length > 0 && scored[0].score >= 0.7) {
          const queryTokens = queryName.toLowerCase().split(/[\s\-_,.']+/).filter((t: string) => t.length > 1);
          const matchTokens = scored[0].name.toLowerCase().split(/[\s\-_,.']+/).filter((t: string) => t.length > 1);
          const hasTokenOverlap = queryTokens.some((qt: string) =>
            matchTokens.some((mt: string) =>
              mt.includes(qt) || qt.includes(mt) || nameSimilarity(qt, mt) > 0.8
            )
          );
          if (hasTokenOverlap) {
            return { clientId: scored[0].id, needsVerification: false, matchedName: scored[0].name };
          }
        }

        if (scored.length > 0) {
          const opts = scored.slice(0, 4).map((c: { name: string }, i: number) => `${i + 1}. ${c.name}`).join("\n");
          return {
            clientId: null,
            needsVerification: true,
            message:
              `I found some possible matches for "${clientName}":\n\n${opts}\n\nCould you confirm which one, or let me know if the file might be listed under a different name?`,
          };
        }
      }
    }
  } catch (err) {
    console.error("[unifiedClientResolution] CG client lookup error:", err);
  }

  try {
    const localResult = await fuzzyClientSearch(normalizedName.length >= 2 ? normalizedName : clientName);
    if (localResult.exactMatch && !localResult.needsVerification) {
      return {
        clientId: localResult.exactMatch.id,
        needsVerification: false,
        matchedName: localResult.exactMatch.name,
      };
    }
    if (localResult.fuzzyMatches.length > 0) {
      const opts = localResult.fuzzyMatches.slice(0, 4)
        .map((m, i) => `${i + 1}. ${m.name} (${m.source.replace("_", " ")})`).join("\n");
      return {
        clientId: null,
        needsVerification: true,
        message:
          `I found some possible matches for "${clientName}":\n\n${opts}\n\nCould you confirm which one? Or if none of these are right, the file might be listed under a different name (like a nickname or legal name).`,
      };
    }
  } catch (err) {
    console.error("[unifiedClientResolution] Local fuzzy search error:", err);
  }

  return {
    clientId: null,
    needsVerification: true,
    message:
      `I couldn't find a client matching "${clientName}" in our system. Could the file be listed under a different name? Sometimes files are stored under a nickname, legal name, or folder name that's different from what you used.`,
  };
}
