import type { SupabaseClient } from "@supabase/supabase-js";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { DailyReportQuery, WorkFeedQuery } from "./boardFilters";
import type {
  MuseAgentQueueRow,
  MuseDailyImprovementRow,
  MuseDailyReportRow,
  MuseImprovementResultRow,
  MuseMissionRow,
  MuseVerificationQueueRow,
  MuseWorkFeedRow,
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

export function useMuseWorkFeed(filters: WorkFeedQuery): UseQueryResult<MuseWorkFeedRow[], Error> {
  return useQuery({
    queryKey: ["muse", "work-feed", filters],
    queryFn: async () => {
      let query = db.from("muse_work_feed").select("*").order("created_at", { ascending: false }).limit(500);
      if (filters.actor) query = query.eq("actor", filters.actor);
      if (filters.type) query = query.eq("update_type", filters.type);
      if (filters.domain) query = query.eq("domain_key", filters.domain);
      if (filters.task_id) query = query.eq("task_id", filters.task_id);
      if (filters.improvement_id) query = query.eq("improvement_id", filters.improvement_id);
      if (filters.mission_id) query = query.eq("mission_id", filters.mission_id);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as MuseWorkFeedRow[];
    },
    ...COMMON,
  });
}

export function useMuseDailyReports(filters: DailyReportQuery): UseQueryResult<MuseDailyReportRow[], Error> {
  return useQuery({
    queryKey: ["muse", "daily-reports", filters],
    queryFn: async () => {
      let query = db.from("muse_daily_report_board").select("*").order("created_at", { ascending: false }).limit(400);
      if (filters.actor) query = query.eq("actor", filters.actor);
      if (filters.cadence) query = query.eq("cadence", filters.cadence);
      if (filters.report_date) query = query.eq("report_date", filters.report_date);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as MuseDailyReportRow[];
    },
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
