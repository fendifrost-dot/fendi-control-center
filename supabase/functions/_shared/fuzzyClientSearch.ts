/**
 * Fuzzy Client Search Utility
 * Provides intelligent client name resolution across all workflows.
 * Searches clients table, Drive folders, and aliases with fuzzy matching.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export interface ClientMatch {
  id: string;
  name: string;
  source: "clients_table" | "drive_folder" | "alias";
  confidence: number;
  metadata?: Record<string, unknown>;
}

export interface FuzzySearchResult {
  exactMatch: ClientMatch | null;
  fuzzyMatches: ClientMatch[];
  needsVerification: boolean;
  verificationMessage?: string;
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
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[al.length][bl.length];
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
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
      if (tt.includes(qt) || qt.includes(tt)) { matched++; break; }
      if (similarity(qt, tt) > 0.75) { matched += 0.7; break; }
    }
  }
  return qTokens.length > 0 ? (matched / qTokens.length) * 0.7 : 0;
}

export async function fuzzyClientSearch(
  searchQuery: string,
  options: {
    searchClientsTable?: boolean;
    searchDriveFolders?: boolean;
    searchAliases?: boolean;
    minConfidence?: number;
    maxResults?: number;
  } = {}
): Promise<FuzzySearchResult> {
  const {
    searchClientsTable = true,
    searchDriveFolders = true,
    searchAliases = true,
    minConfidence = 0.4,
    maxResults = 5,
  } = options;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const allMatches: ClientMatch[] = [];
  const query = searchQuery.trim();
  if (!query) return { exactMatch: null, fuzzyMatches: [], needsVerification: false };

  // Source 1: Clients table
  if (searchClientsTable) {
    try {
      // Contains match with wildcards (e.g. '%Sam Higgins%')
      const { data: exactData } = await supabase
        .from("clients").select("id, name, email, phone")
        .ilike("name", `%${query}%`).limit(5);
      if (exactData?.length) {
        // Check for true exact match first
        const trueExact = exactData.find((r: any) => r.name.toLowerCase().trim() === query.toLowerCase().trim());
        if (trueExact) {
          allMatches.push({
            id: trueExact.id, name: trueExact.name,
            source: "clients_table", confidence: 1.0,
            metadata: { email: trueExact.email, phone: trueExact.phone },
          });
        } else {
          // Add contains matches with high confidence
          for (const row of exactData) {
            allMatches.push({
              id: row.id, name: row.name,
              source: "clients_table", confidence: 0.9,
              metadata: { email: row.email, phone: row.phone },
            });
          }
        }
      }
      // First-name prefix fallback
      if (!exactData?.length) {
        const firstName = query.split(/[\s\-_]+/)[0];
        if (firstName && firstName.length >= 2) {
          const { data: prefixData } = await supabase
            .from("clients").select("id, name, email, phone")
            .ilike("name", `${firstName}%`).limit(5);
          if (prefixData) {
            for (const row of prefixData) {
              if (allMatches.some((m) => m.id === row.id)) continue;
              allMatches.push({
                id: row.id, name: row.name,
                source: "clients_table", confidence: 0.75,
                metadata: { email: row.email, phone: row.phone },
              });
            }
          }
        }
      }
      // tax_returns.client_name fallback
      if (!allMatches.length) {
        const { data: trData } = await supabase
          .from("tax_returns").select("client_id, client_name")
          .ilike("client_name", `%${query}%`).limit(5);
        if (trData) {
          const seen = new Set<string>();
          for (const row of trData) {
            if (!row.client_id || seen.has(row.client_id)) continue;
            seen.add(row.client_id);
            const score = tokenMatch(query, row.client_name || "");
            allMatches.push({
              id: row.client_id, name: row.client_name || query,
              source: "clients_table", confidence: Math.max(score, 0.6),
              metadata: { from_tax_returns: true },
            });
          }
        }
      }
      const tokens = query.split(/[\s\-_]+/).filter(Boolean);
      for (const token of tokens) {
        if (token.length < 2) continue;
        const { data: fuzzyData } = await supabase
          .from("clients").select("id, name, email, phone")
          .ilike("name", `%${token}%`).limit(10);
        if (fuzzyData) {
          for (const row of fuzzyData) {
            if (allMatches.some((m) => m.id === row.id)) continue;
            const score = Math.max(tokenMatch(query, row.name), similarity(query, row.name));
            if (score >= minConfidence) {
              allMatches.push({
                id: row.id, name: row.name, source: "clients_table",
                confidence: score, metadata: { email: row.email },
              });
            }
          }
        }
      }
    } catch (err) { console.error("[FUZZY] Clients table error:", err); }
  }

  // Source 2: Aliases table
  if (searchAliases) {
    try {
      const { data: aliasData } = await supabase
        .from("client_aliases").select("client_id, alias, client_name")
        .or(`alias.ilike.%${query}%,client_name.ilike.%${query}%`).limit(10);
      if (aliasData) {
        for (const row of aliasData) {
          if (allMatches.some((m) => m.id === row.client_id)) continue;
          const score = Math.max(tokenMatch(query, row.alias), tokenMatch(query, row.client_name || ""));
          if (score >= minConfidence) {
            allMatches.push({
              id: row.client_id, name: row.client_name || row.alias,
              source: "alias", confidence: Math.min(score + 0.1, 1.0),
              metadata: { alias: row.alias },
            });
          }
        }
      }
    } catch { console.log("[FUZZY] client_aliases table not found, skipping"); }
  }

  // Source 3: Drive folders from documents table
  if (searchDriveFolders) {
    try {
      const tokens = query.split(/[\s\-_]+/).filter(Boolean);
      for (const token of tokens) {
        if (token.length < 2) continue;
        const { data: folderData } = await supabase
          .from("documents").select("source_folder, client_id")
          .ilike("source_folder", `%${token}%`).limit(10);
        if (folderData) {
          const seen = new Set<string>();
          for (const row of folderData) {
            const key = row.source_folder || "";
            if (seen.has(key)) continue;
            seen.add(key);
            const score = tokenMatch(query, key);
            if (score >= minConfidence) {
              allMatches.push({
                id: row.client_id || key, name: key,
                source: "drive_folder", confidence: score,
                metadata: { folder: key },
              });
            }
          }
        }
      }
    } catch (err) { console.error("[FUZZY] Drive folder error:", err); }
  }

  // Deduplicate and rank
  const deduped = new Map<string, ClientMatch>();
  for (const m of allMatches) {
    const existing = deduped.get(m.id);
    if (!existing || m.confidence > existing.confidence) deduped.set(m.id, m);
  }
  const ranked = Array.from(deduped.values())
    .sort((a, b) => b.confidence - a.confidence).slice(0, maxResults);

  const top = ranked[0] || null;

  // High confidence single match
  if (top && top.confidence >= 0.85 && ranked.length <= 1) {
    return { exactMatch: top, fuzzyMatches: ranked, needsVerification: false };
  }

  // Close competing matches - ask for verification
  if (top && top.confidence >= 0.7 && ranked.length > 1 &&
      ranked[1].confidence >= top.confidence - 0.15) {
    const opts = ranked.slice(0, 4)
      .map((m, i) => `${i + 1}. ${m.name} (${m.source.replace("_", " ")})`).join("\n");
    return {
      exactMatch: null, fuzzyMatches: ranked, needsVerification: true,
      verificationMessage: `I found multiple possible matches for "${searchQuery}":\n\n${opts}\n\nReply with the number of the correct match, or type the exact name.`,
    };
  }

  // Single decent match
  if (top && top.confidence >= 0.5) {
    return { exactMatch: top, fuzzyMatches: ranked, needsVerification: false };
  }

  // Low confidence - verify
  if (ranked.length > 0) {
    const opts = ranked.map((m, i) => `${i + 1}. ${m.name} (${m.source.replace("_", " ")})`).join("\n");
    return {
      exactMatch: null, fuzzyMatches: ranked, needsVerification: true,
      verificationMessage: `I'm not sure who "${searchQuery}" refers to. Did you mean:\n\n${opts}\n\nReply with the number or type the full name.`,
    };
  }

  return {
    exactMatch: null, fuzzyMatches: [], needsVerification: true,
    verificationMessage: `I couldn't find any client matching "${searchQuery}" in the database or Drive folders. Could you provide the full name or check the folder name?`,
  };
}

export async function resolveClientName(searchQuery: string): Promise<{
  clientId: string | null;
  clientName: string | null;
  needsVerification: boolean;
  verificationMessage?: string;
  allMatches: ClientMatch[];
}> {
  const result = await fuzzyClientSearch(searchQuery);
  if (result.exactMatch && !result.needsVerification) {
    return {
      clientId: result.exactMatch.id, clientName: result.exactMatch.name,
      needsVerification: false, allMatches: result.fuzzyMatches,
    };
  }
  return {
    clientId: null, clientName: null,
    needsVerification: result.needsVerification,
    verificationMessage: result.verificationMessage,
    allMatches: result.fuzzyMatches,
  };
}
