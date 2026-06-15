import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const BEEBLE_API_BASE = "https://api.beeble.ai/v1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const beebleKey = Deno.env.get("BEEBLE_API_KEY") ?? "";
  if (!beebleKey) {
    return json(500, { error: "BEEBLE_API_KEY missing" });
  }

  let jobId: string | null = null;

  // Accept job_id from POST body or GET query param
  if (req.method === "POST") {
    try {
      const body = await req.json();
      jobId = body.job_id;
    } catch {
      // ignore
    }
  }
  if (!jobId) {
    const url = new URL(req.url);
    jobId = url.searchParams.get("job_id");
  }

  if (!jobId) {
    return json(400, { error: "job_id required (POST body or ?job_id query param)" });
  }

  try {
    const statusUrl = `${BEEBLE_API_BASE}/switchx/generations/${jobId}`;
    const resp = await fetch(statusUrl, {
      headers: { "x-api-key": beebleKey },
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return json(resp.status, {
        error: `beeble_status_${resp.status}`,
        detail: errText,
      });
    }

    const status = await resp.json();
    return json(200, status);
  } catch (err: any) {
    return json(502, {
      error: "fetch_failed",
      detail: String(err?.message ?? err),
    });
  }
});
