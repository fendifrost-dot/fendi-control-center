import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";


const BOT_TOKEN = Deno.env.get("FendiAIbot")!;
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_KEY = Deno.env.get("Frost_Gemini")!;
const GROK_KEY = Deno.env.get("Frost_Grok")!;


const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const SYSTEM_IDENTITY = "Fendi Control Center AI";
// ─── Implemented workflow keys → handler names (deterministic routing) ───
const IMPLEMENTED_WORKFLOW_KEYS = new Set([
  "ping", "system_status", "resend_failed", "list_workflows", "help",
    "model_switch", "document_approval", "document_rejection",
    "failed_job_management", "drive_sync", "client_overview",
    "file_browsing", "connected_project_stats", "error_explanation",
    "active_jobs_summary", "document_ingestion_processing",
    "drive_ingest", "free_agent",
    "find_playlist_opportunities", "get_pitch_report", "send_playlist_pitch", "update_pitch_status"
]);


// ─── Workflow registry fetch ────────────────────────────────────
interface WorkflowEntry {
  key: string; name: string; description: string;
  trigger_phrases: string[]; tools: string[];
}


function _normalizeText(s: string): string {
  return (s ?? "").trim().toLowerCase();
}


function _matchWorkflows(input: string, workflows: WorkflowEntry[]): { matches: WorkflowEntry[]; chosen?: WorkflowEntry } {
  const norm = _normalizeText(input);
  if (!norm) return { matches: [] }
