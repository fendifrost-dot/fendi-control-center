/**
 * Read access to the Muse views.
 *
 * Reuses the existing Control Hub Supabase client and session — Muse adds no new
 * auth path and no new credential. Reads are plain selects against the curated
 * `muse_*` views, which the operator role may read and `anon` may not.
 *
 * This module is read-only by design. Any future write or action must go through
 * the existing Control Hub execution mechanisms, not through here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type {
  MuseBriefRow,
  MuseConflictRow,
  MuseDecisionRow,
  MuseImprovementRow,
  MuseKpiRow,
  MuseOpenLoopRow,
  MusePortfolioRow,
  MuseSourceAuthorityRow,
  MuseSystemHealthRow,
} from "./types";

/**
 * The Muse views are absent from the Lovable-generated `Database` type (that
 * file is regenerated and would lose them), so reads go through an untyped
 * handle and are cast to the hand-written row types in ./types.
 */
const museDb = supabase as unknown as SupabaseClient;

/** Closed list of readable views — mirrors the edge function's allowlist. */
export const MUSE_VIEWS = {
  brief: "muse_executive_brief",
  portfolio: "muse_portfolio_map",
  openLoops: "muse_open_loops_live",
  decisions: "muse_decisions_required",
  kpis: "muse_kpi_summary",
  systems: "muse_system_health",
  sources: "muse_source_authority_state",
  conflicts: "muse_source_conflicts_open",
  improvements: "muse_improvement_ledger",
} as const;

interface ReadOptions {
  orderBy?: string;
  ascending?: boolean;
  limit?: number;
}

async function readView<T>(view: string, options: ReadOptions = {}): Promise<T[]> {
  let query = museDb.from(view).select("*");
  if (options.orderBy) {
    query = query.order(options.orderBy, { ascending: options.ascending ?? true, nullsFirst: false });
  }
  if (options.limit) query = query.limit(options.limit);

  const { data, error } = await query;
  // Surfaced to the caller so the UI can distinguish "not deployed yet" from
  // "nothing to report" — see isMissingSchemaError.
  if (error) throw error;
  return (data ?? []) as T[];
}

/** 60s of staleness is plenty for an executive view and keeps reads cheap. */
const COMMON = { staleTime: 60_000, retry: 1 } as const;

export function useMuseBrief(): UseQueryResult<MuseBriefRow[], Error> {
  return useQuery({
    queryKey: ["muse", "brief"],
    queryFn: () => readView<MuseBriefRow>(MUSE_VIEWS.brief, { orderBy: "rank" }),
    ...COMMON,
  });
}

export function useMusePortfolio(): UseQueryResult<MusePortfolioRow[], Error> {
  return useQuery({
    queryKey: ["muse", "portfolio"],
    queryFn: () => readView<MusePortfolioRow>(MUSE_VIEWS.portfolio, { orderBy: "sort_order" }),
    ...COMMON,
  });
}

export function useMuseOpenLoops(): UseQueryResult<MuseOpenLoopRow[], Error> {
  return useQuery({
    queryKey: ["muse", "open-loops"],
    queryFn: () => readView<MuseOpenLoopRow>(MUSE_VIEWS.openLoops, { orderBy: "priority" }),
    ...COMMON,
  });
}

export function useMuseDecisions(): UseQueryResult<MuseDecisionRow[], Error> {
  return useQuery({
    queryKey: ["muse", "decisions"],
    queryFn: () =>
      readView<MuseDecisionRow>(MUSE_VIEWS.decisions, { orderBy: "decision_required_by" }),
    ...COMMON,
  });
}

export function useMuseSystems(): UseQueryResult<MuseSystemHealthRow[], Error> {
  return useQuery({
    queryKey: ["muse", "systems"],
    queryFn: () => readView<MuseSystemHealthRow>(MUSE_VIEWS.systems, { orderBy: "sort_order" }),
    ...COMMON,
  });
}

export function useMuseSources(): UseQueryResult<MuseSourceAuthorityRow[], Error> {
  return useQuery({
    queryKey: ["muse", "sources"],
    queryFn: () => readView<MuseSourceAuthorityRow>(MUSE_VIEWS.sources, { orderBy: "domain_key" }),
    ...COMMON,
  });
}

export function useMuseConflicts(): UseQueryResult<MuseConflictRow[], Error> {
  return useQuery({
    queryKey: ["muse", "conflicts"],
    queryFn: () =>
      readView<MuseConflictRow>(MUSE_VIEWS.conflicts, { orderBy: "detected_at", ascending: false }),
    ...COMMON,
  });
}

export function useMuseImprovements(): UseQueryResult<MuseImprovementRow[], Error> {
  return useQuery({
    queryKey: ["muse", "improvements"],
    queryFn: () => readView<MuseImprovementRow>(MUSE_VIEWS.improvements, { orderBy: "review_at" }),
    ...COMMON,
  });
}

export function useMuseKpis(): UseQueryResult<MuseKpiRow[], Error> {
  return useQuery({
    queryKey: ["muse", "kpis"],
    queryFn: () => readView<MuseKpiRow>(MUSE_VIEWS.kpis, { orderBy: "sort_order" }),
    ...COMMON,
  });
}
