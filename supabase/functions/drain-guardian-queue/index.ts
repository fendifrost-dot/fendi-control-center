/**
 * Edge function: drain-guardian-queue
 *
 * Pulls pending rows from `pending_guardian_events` (PR #10) and POSTs each
 * to Credit Guardian's `ingest-hub-event` (roadmap A4). All meaningful logic
 * lives in `_shared/drainGuardianQueue.ts` so the function is testable
 * without spinning up Deno.serve.
 *
 * Scheduling
 * ----------
 * The function is invoked on a 1-minute pg_cron schedule via Supabase
 * (`select cron.schedule('drain-guardian-queue', '* * * * *', $$ ... $$)`),
 * the same pattern the Hub uses for `telegram-outbox-flush`. It also accepts
 * an authenticated POST so the operator can trigger it manually from the
 * Lovable shell when needed.
 *
 * Required env vars (document also in PR description):
 *   HUB_SIGNATURE_SECRET     — shared HMAC secret with Guardian
 *   GUARDIAN_INGEST_URL      — full URL to Guardian's ingest-hub-event function
 *   SUPABASE_URL             — already set on the Hub project
 *   SUPABASE_SERVICE_ROLE_KEY — already set on the Hub project
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  DRAIN_BATCH_DEFAULT,
  type DrainDeps,
  type PendingGuardianEventRow,
  runDrainTick,
} from "../_shared/drainGuardianQueue.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
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
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const GUARDIAN_INGEST_URL = Deno.env.get("GUARDIAN_INGEST_URL");
    const HUB_SIGNATURE_SECRET = Deno.env.get("HUB_SIGNATURE_SECRET");

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json({ error: "missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" }, 500);
    }
    if (!GUARDIAN_INGEST_URL) {
      return json({ error: "missing GUARDIAN_INGEST_URL" }, 500);
    }
    if (!HUB_SIGNATURE_SECRET) {
      return json({ error: "missing HUB_SIGNATURE_SECRET" }, 500);
    }

    let limit = DRAIN_BATCH_DEFAULT;
    try {
      const body = await req.json();
      if (typeof body?.limit === "number" && body.limit > 0) {
        limit = Math.min(body.limit, 50);
      }
    } catch {
      /* no body / not JSON — use default */
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const deps: DrainDeps = {
      claimRows: async (n, now) => {
        const { data, error } = await supabase.rpc(
          "claim_pending_guardian_events",
          { p_limit: n, p_now: now.toISOString() },
        );
        if (error) {
          throw new Error(`claim_pending_guardian_events RPC: ${error.message}`);
        }
        return (data ?? []) as PendingGuardianEventRow[];
      },
      postToGuardian: async (body, signatureHex) => {
        const resp = await fetch(GUARDIAN_INGEST_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-hub-signature": signatureHex,
          },
          body,
        });
        const text = await resp.text();
        return { status: resp.status, body: text };
      },
      updateRow: async (id, patch) => {
        const { error } = await supabase
          .from("pending_guardian_events")
          .update(patch)
          .eq("id", id);
        if (error) {
          throw new Error(`update pending_guardian_events ${id}: ${error.message}`);
        }
      },
      signatureSecret: HUB_SIGNATURE_SECRET,
      now: () => new Date(),
    };

    const result = await runDrainTick(deps, limit);
    return json(result);
  } catch (err) {
    console.error(
      `[drain-guardian-queue] tick failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
