export interface MuseMissionRow {
  id: string;
  domain_key: string;
  domain_name: string;
  title: string;
  objective: string;
  business_outcome: string | null;
  owner: string;
  executive_sponsor: string;
  priority: "P0" | "P1" | "P2" | "P3";
  status: "PROPOSED" | "ACTIVE" | "PAUSED" | "COMPLETE" | "CANCELLED";
  metric: string | null;
  baseline: string | null;
  target: string | null;
  started_at: string | null;
  review_at: string | null;
  dependencies: unknown[];
  source_ref: string | null;
  created_by: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  active_improvements: number;
  active_tasks: number;
  blocked_tasks: number;
  as_of: string;
}

export interface MuseDailyImprovementRow {
  id: string;
  domain_key: string;
  domain_name: string;
  improvement_date: string | null;
  function_name: string | null;
  observation: string | null;
  problem: string;
  intervention: string;
  hypothesis: string | null;
  baseline: string | null;
  metric: string;
  expected_impact: string | null;
  expected_result: string | null;
  actual_result: string | null;
  confidence: "HIGH" | "MEDIUM" | "LOW" | null;
  risk: string | null;
  reversible: boolean | null;
  priority: "P0" | "P1" | "P2" | "P3" | null;
  owner: string;
  recommended_executor: string | null;
  selected_by: string | null;
  mission_id: string | null;
  mission_title: string | null;
  definition_of_done: string | null;
  verification_requirement: string | null;
  owner_attention: "NONE" | "INFORM" | "APPROVAL" | "DECISION" | "DIRECT_INVOLVEMENT" | null;
  observe_only_reason: string | null;
  started_at: string | null;
  review_at: string | null;
  status: "PROPOSED" | "RUNNING" | "MEASURED" | "CLOSED";
  verdict: "PENDING" | "KEEP" | "REVISE" | "REVERSE";
  verification_state: "CLAIMED" | "ARTIFACT_VERIFIED" | "SYSTEM_VERIFIED" | "LIVE_VERIFIED";
  source_ref: string | null;
  notes: string | null;
  created_at: string;
  task_count: number;
  tasks_complete: number;
  tasks_blocked: number;
  measurement_count: number;
  review_due: boolean;
  as_of: string;
}

export interface MuseAgentQueueRow {
  id: string;
  improvement_id: string;
  domain_key: string;
  domain_name: string;
  improvement: string;
  title: string;
  executor: string;
  assigning_agent: string;
  objective: string | null;
  instructions: string | null;
  expected_artifact: string | null;
  definition_of_done: string | null;
  priority: "P0" | "P1" | "P2" | "P3";
  state: "ASSIGNED" | "IN_PROGRESS" | "WAITING" | "BLOCKED" | "IMPLEMENTED" | "VERIFICATION" | "COMPLETE" | "CANCELLED";
  blocker: string | null;
  due_at: string | null;
  claimed_completed_at: string | null;
  verification_state: "CLAIMED" | "ARTIFACT_VERIFIED" | "SYSTEM_VERIFIED" | "LIVE_VERIFIED";
  evidence: unknown[];
  source_ref: string | null;
  created_at: string;
  updated_at: string;
  overdue: boolean;
  as_of: string;
}

export interface MuseVerificationQueueRow {
  task_id: string;
  improvement_id: string;
  domain_key: string;
  domain_name: string;
  title: string;
  claimant: string;
  verification_state: "CLAIMED" | "ARTIFACT_VERIFIED" | "SYSTEM_VERIFIED" | "LIVE_VERIFIED";
  claimed_completed_at: string | null;
  expected_artifact: string | null;
  definition_of_done: string | null;
  evidence: unknown[];
  source_ref: string | null;
  verification_requirement: string | null;
  as_of: string;
}

export interface MuseWorkFeedRow {
  id: string;
  domain_key: string | null;
  domain_name: string | null;
  mission_id: string | null;
  improvement_id: string | null;
  task_id: string | null;
  actor: string | null;
  update_type: string | null;
  message: string | null;
  evidence_ref: string | null;
  created_at: string | null;
  as_of: string | null;
}

export type DailyReportCadence = "START_OF_DAY" | "END_OF_DAY";

export interface MuseDailyReportRow {
  id: string;
  report_date: string;
  cadence: DailyReportCadence;
  actor: string;
  message: string;
  sections: Record<string, string> | null;
  evidence_ref: string | null;
  created_at: string;
  as_of: string | null;
}

export interface MuseImprovementResultRow {
  improvement_id: string;
  domain_key: string;
  domain_name: string;
  intervention: string;
  metric: string;
  baseline: string | null;
  actual_result: string | null;
  verdict: "PENDING" | "KEEP" | "REVISE" | "REVERSE";
  status: "PROPOSED" | "RUNNING" | "MEASURED" | "CLOSED";
  verification_state: "CLAIMED" | "ARTIFACT_VERIFIED" | "SYSTEM_VERIFIED" | "LIVE_VERIFIED";
  started_at: string | null;
  review_at: string | null;
  latest_measurement_at: string | null;
  latest_measurement_type: string | null;
  latest_value: string | null;
  latest_delta: string | null;
  recorded_financial_impact: number;
  recorded_time_saved_minutes: number;
  measurement_count: number;
  as_of: string;
}
