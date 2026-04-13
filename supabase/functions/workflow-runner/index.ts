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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface LockedState {
  client_name?: string;
  client_id?: string;
  tax_year?: number;
  statement_job_ids?: string[];
  [key: string]: unknown;
}

function validateLockedState(ls: unknown): ls is LockedState & { client_name: string; tax_year: number } {
  if (!ls || typeof ls !== "object") return false;
  const s = ls as Record<string, unknown>;
  return typeof s.client_name === "string" && s.client_name.length > 0 &&
    typeof s.tax_year === "number" && s.tax_year > 2000;
}

// --------------- helpers ---------------

async function callEdgeFunction(name: string, body: unknown): Promise<{ data: unknown; error: string | null }> {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/${name}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    return { data, error: `${name} returned ${res.status}: ${text.slice(0, 500)}` };
  }
  return { data, error: null };
}

// --------------- stage handlers ---------------

const TERMINAL_CHUNK_STATUSES = new Set([
  "completed", "partial_success", "chunk_processing_failed", "dead_letter",
]);
const PENDING_CHUNK_STATUSES = new Set([
  "requires_async_processing", "processing_chunked", "queued",
]);

type Run = Record<string, unknown>;

async function handleLoadState(run: Run) {
  const ls = run.locked_state as LockedState;
  return { locked_state: { ...ls, loaded: true } };
}

async function handleIngestDrive(run: Run) {
  const ls = run.locked_state as LockedState & { client_name: string; tax_year: number };
  const { data, error } = await callEdgeFunction("ingest-tax-documents", {
    client_name: ls.client_name,
    tax_year: ls.tax_year,
    mode: "aggregate",
  });
  if (error) throw new Error(error);
  return {
    locked_state: { ...ls, drive_ingested: true },
    result_payload: { ...(run.result_payload as object ?? {}), ingest: data },
  };
}

async function handleProcessAsyncStatements(run: Run, supabase: ReturnType<typeof createClient>) {
  const ls = run.locked_state as LockedState & { client_name: string; tax_year: number };

  // Resolve statement jobs from DB
  let query = supabase
    .from("statement_chunk_jobs")
    .select("id, status")
    .eq("tax_year", ls.tax_year);

  if (ls.client_id) {
    query = query.eq("client_id", ls.client_id);
  }

  const { data: jobs } = await query;
  const jobIds = (jobs ?? []).map((j: { id: string }) => j.id);

  // Also include any already-tracked IDs
  const existingIds = ls.statement_job_ids ?? [];
  const allIds = [...new Set([...jobIds, ...existingIds])];

  if (allIds.length === 0) {
    return { locked_state: { ...ls, statements_done: true, statement_job_ids: [] } };
  }

  // Check statuses
  const { data: currentJobs } = await supabase
    .from("statement_chunk_jobs")
    .select("id, status")
    .in("id", allIds);

  const pending = (currentJobs ?? []).filter((j: { status: string }) =>
    PENDING_CHUNK_STATUSES.has(j.status)
  );

  if (pending.length > 0) {
    // Try to dispatch any that need external processing
    await callEdgeFunction("statement-external-dispatch", {}).catch(() => {});

    return {
      status: "waiting_async",
      locked_state: { ...ls, statement_job_ids: allIds },
    };
  }

  // All terminal
  return {
    locked_state: { ...ls, statements_done: true, statement_job_ids: allIds },
  };
}

async function handleMergeManualInputs(run: Run) {
  const ls = run.locked_state as LockedState;
  return { locked_state: { ...ls, manual_merged: true } };
}

async function handleComputeMileage(run: Run) {
  const ls = run.locked_state as LockedState;
  return { locked_state: { ...ls, mileage_computed: true } };
}

async function handleValidate(run: Run) {
  const ls = run.locked_state as LockedState;
  return { locked_state: { ...ls, validated: true } };
}

async function handleGenerateReturn(run: Run) {
  const ls = run.locked_state as LockedState & { client_name: string; tax_year: number };
  const { data, error } = await callEdgeFunction("generate-tax-documents", {
    client_name: ls.client_name,
    tax_years: [ls.tax_year],
    command: `Generate ${ls.tax_year} tax return for ${ls.client_name}`,
  });
  if (error) throw new Error(error);
  return {
    locked_state: { ...ls, return_generated: true },
    result_payload: { ...(run.result_payload as object ?? {}), generated: data },
  };
}

async function handleFinalize(run: Run) {
  const ls = run.locked_state as LockedState & { client_name: string; tax_year: number };
  const rp = (run.result_payload ?? {}) as Record<string, unknown>;
  const generated = rp.generated as Record<string, unknown> | undefined;

  // Try to extract from generated.results[tax_year]
  let yearResult: Record<string, unknown> | null = null;
  if (generated) {
    const results = generated.results as Record<string, unknown> | undefined;
    if (results && results[String(ls.tax_year)]) {
      yearResult = results[String(ls.tax_year)] as Record<string, unknown>;
    }
    // Also try top-level if results not nested
    if (!yearResult && generated.json_summary) {
      yearResult = generated as Record<string, unknown>;
    }
  }

  const jsonSummary = yearResult?.json_summary as Record<string, unknown> | undefined;

  return {
    status: "completed",
    result_payload: {
      ...rp,
      income_summary: jsonSummary?.income_summary ?? jsonSummary?.total_income ?? {},
      expense_summary: jsonSummary?.expense_summary ?? jsonSummary?.deductions ?? {},
      mileage_calculation: jsonSummary?.mileage_calculation ?? {},
      missing_items: jsonSummary?.missing_items ?? [],
      readiness_status: yearResult?.filing_recommendation ?? {},
      completed_at: new Date().toISOString(),
    },
    locked_state: { ...ls, finalized: true },
  };
}

type HandlerFn = (run: Run, supabase: ReturnType<typeof createClient>) => Promise<Record<string, unknown>>;

const HANDLERS: Record<Stage, HandlerFn> = {
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
    if (!run_id) return json({ error: "run_id required" }, 400);

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
      return json({ error: "Run not found", detail: fetchErr?.message }, 404);
    }

    if (run.status === "completed" || run.status === "failed") {
      return json({ run, message: "Run already terminal" });
    }

    // Enforce locked_state validity
    if (!validateLockedState(run.locked_state)) {
      const { data: failed } = await supabase
        .from("workflow_runs")
        .update({
          status: "failed",
          error: { message: "invalid locked_state", stage: run.current_stage },
        })
        .eq("id", run_id)
        .select("*")
        .single();
      return json({ error: "invalid locked_state", run: failed }, 400);
    }

    const stage = run.current_stage as Stage;
    const handler = HANDLERS[stage];
    if (!handler) {
      return json({ error: `Unknown stage: ${stage}` }, 400);
    }

    // Execute handler
    let patch: Record<string, unknown>;
    try {
      patch = await handler(run, supabase);
    } catch (stageErr) {
      const errMsg = String(stageErr).slice(0, 2000);
      console.error(`[workflow-runner] stage=${stage} run=${run_id} error: ${errMsg}`);
      const { data: failed } = await supabase
        .from("workflow_runs")
        .update({
          status: "failed",
          error: { message: errMsg, stage },
        })
        .eq("id", run_id)
        .select("*")
        .single();
      return json({ error: errMsg, stage, run: failed }, 500);
    }

    // Determine next stage (unless handler set a parking status)
    const isParked = patch.status === "waiting_async" || patch.status === "failed";
    const next = isParked
      ? stage
      : stage === "finalize"
        ? "finalize"
        : nextStage(stage) ?? "finalize";

    const update: Record<string, unknown> = {
      ...patch,
      current_stage: isParked ? stage : next,
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
      return json({ error: "Failed to update run", detail: updateErr.message }, 500);
    }

    return json({ run: updated });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
