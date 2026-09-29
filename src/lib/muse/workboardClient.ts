import type { SupabaseClient } from "@supabase/supabase-js";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type {
  MuseAgentQueueRow,
  MuseDailyImprovementRow,
  MuseImprovementResultRow,
  MuseMissionRow,
  MuseVerificationQueueRow,
} from "./workboardTypes";

const db = supabase as unknown as SupabaseClient;
const COMMON = { staleTime: 60_000, retry: 1 } as const;

async function read<T>(view: string, orderBy?: string, ascending = true): Promise<T[]> {
  let query = db.from(view).select("*");
  if (orderBy) query = query.order(orderBy, { ascending, nullsFirst: false });
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as T[];
}

export function useMuseMissions(): UseQueryResult<MuseMissionRow[], Error> {
  return useQuery({
    queryKey: ["muse", "missions"],
    queryFn: () => read<MuseMissionRow>("muse_mission_board", "priority"),
    ...COMMON,
  });
}

export function useMuseDailyImprovements(): UseQueryResult<MuseDailyImprovementRow[], Error> {
  return useQuery({
    queryKey: ["muse", "daily-improvements"],
    queryFn: () => read<MuseDailyImprovementRow>("muse_daily_improvement_board", "improvement_date", false),
    ...COMMON,
  });
}

export function useMuseAgentQueue(): UseQueryResult<MuseAgentQueueRow[], Error> {
  return useQuery({
    queryKey: ["muse", "agent-queue"],
    queryFn: () => read<MuseAgentQueueRow>("muse_agent_queue", "priority"),
    ...COMMON,
  });
}

export function useMuseVerificationQueue(): UseQueryResult<MuseVerificationQueueRow[], Error> {
  return useQuery({
    queryKey: ["muse", "verification-queue"],
    queryFn: () => read<MuseVerificationQueueRow>("muse_verification_queue", "claimed_completed_at"),
    ...COMMON,
  });
}

export function useMuseImprovementResults(): UseQueryResult<MuseImprovementResultRow[], Error> {
  return useQuery({
    queryKey: ["muse", "improvement-results"],
    queryFn: () => read<MuseImprovementResultRow>("muse_improvement_results", "latest_measurement_at", false),
    ...COMMON,
  });
}
