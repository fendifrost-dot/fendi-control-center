import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    let limit = 10;
    try {
      const body = await req.json();
      if (typeof body.limit === "number") limit = body.limit;
    } catch { /* no body is fine */ }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: runs, error } = await supabase
      .from("workflow_runs")
      .select("id")
      .eq("status", "waiting_async")
      .order("updated_at", { ascending: true })
      .limit(limit);

    if (error) return json({ error: error.message }, 500);

    const results = { scanned: runs?.length ?? 0, resumed: 0, still_waiting: 0, errors: 0 };

    for (const run of runs ?? []) {
      try {
        const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/workflow-runner`;
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({ run_id: run.id }),
        });
        const data = await res.json();
        if (data.run?.status === "waiting_async") {
          results.still_waiting++;
        } else {
          results.resumed++;
        }
      } catch (err) {
        console.error(`[workflow-run-poller] failed to resume run=${run.id}: ${err}`);
        results.errors++;
      }
    }

    return json(results);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
