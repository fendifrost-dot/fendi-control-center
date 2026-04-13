import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const STAGES = [
  "load_state",
  "ingest_drive",
  "process_async_statements",
  "merge_manual_inputs",
  "compute_mileage",
  "validate",
  "generate_return",
  "finalize",
] as const;

type Stage = (typeof STAGES)[number];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function nextStage(current: Stage): Stage | null {
  const idx = STAGES.indexOf(current);
  return idx < STAGES.length - 1 ? STAGES[idx + 1] : null;
}

// --------------- stage handlers ---------------

async function handleLoadState(run: Record<string, unknown>) {
  return { locked_state: { ...(run.locked_state as object), loaded: true } };
}

async function handleIngestDrive(run: Record<string, unknown>) {
  // placeholder — will wrap ingest-tax-documents later
  return { locked_state: { ...(run.locked_state as object), drive_ingested: true } };
}

async function handleProcessAsyncStatements(run: Record<string, unknown>) {
  const jobIds = (run.statement_job_ids as string[]) ?? [];
  if (jobIds.length > 0) {
    // If there are pending async jobs, park the run
    return { status: "waiting_async" };
  }
  return { locked_state: { ...(run.locked_state as object), statements_done: true } };
}

async function handleMergeManualInputs(run: Record<string, unknown>) {
  return { locked_state: { ...(run.locked_state as object), manual_merged: true } };
}

async function handleComputeMileage(run: Record<string, unknown>) {
  return { locked_state: { ...(run.locked_state as object), mileage_computed: true } };
}

async function handleValidate(run: Record<string, unknown>) {
  return { locked_state: { ...(run.locked_state as object), validated: true } };
}

async function handleGenerateReturn(run: Record<string, unknown>) {
  // placeholder — will wrap generate-tax-documents later
  return { locked_state: { ...(run.locked_state as object), return_generated: true } };
}

async function handleFinalize(run: Record<string, unknown>) {
  return {
    status: "complete",
    result_payload: { completed_at: new Date().toISOString() },
    locked_state: { ...(run.locked_state as object), finalized: true },
  };
}

const HANDLERS: Record<Stage, (run: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
  load_state: handleLoadState,
  ingest_drive: handleIngestDrive,
  process_async_statements: handleProcessAsyncStatements,
  merge_manual_inputs: handleMergeManualInputs,
  compute_mileage: handleComputeMileage,
  validate: handleValidate,
  generate_return: handleGenerateReturn,
  finalize: handleFinalize,
};

// --------------- main ---------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { run_id } = await req.json();
    if (!run_id) {
      return new Response(JSON.stringify({ error: "run_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Fetch run
    const { data: run, error: fetchErr } = await supabase
      .from("workflow_runs")
      .select("*")
      .eq("id", run_id)
      .single();

    if (fetchErr || !run) {
      return new Response(JSON.stringify({ error: "Run not found", detail: fetchErr?.message }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (run.status === "complete" || run.status === "failed") {
      return new Response(JSON.stringify({ run, message: "Run already terminal" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const stage = run.current_stage as Stage;
    const handler = HANDLERS[stage];
    if (!handler) {
      return new Response(JSON.stringify({ error: `Unknown stage: ${stage}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Execute handler
    const patch = await handler(run);

    // Determine next stage (unless handler set a parking status)
    const next = patch.status === "waiting_async" || patch.status === "failed"
      ? stage
      : stage === "finalize"
        ? "finalize"
        : nextStage(stage) ?? "finalize";

    const update: Record<string, unknown> = {
      ...patch,
      current_stage: patch.status === "waiting_async" ? stage : next,
    };
    if (!patch.status) {
      update.status = "running";
    }

    const { data: updated, error: updateErr } = await supabase
      .from("workflow_runs")
      .update(update)
      .eq("id", run_id)
      .select("*")
      .single();

    if (updateErr) {
      return new Response(JSON.stringify({ error: "Failed to update run", detail: updateErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ run: updated }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
