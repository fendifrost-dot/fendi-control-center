#!/usr/bin/env node
/**
 * Live verification for the Muse executive layer.
 *
 * Proves, against the deployed system rather than against source code:
 *   1. the schema/views exist
 *   2. the endpoint is deployed and authenticates
 *   3. read behaviour works
 *   4. WRITE ATTEMPTS ARE REJECTED
 *   5. sample executive queries return usable payloads
 *   6. unknown/stale data is represented honestly
 *   7. anon (public) cannot read the Muse layer
 *   8. no credential-shaped values appear in any payload
 *
 * Usage:
 *   MUSE_API_TOKEN=<token> node scripts/muse/verify-muse-live.mjs
 *
 * Reads VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY from .env when not in
 * the environment. Never prints a token or key.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function loadEnvFile() {
  const out = {};
  try {
    for (const line of readFileSync(resolve(repoRoot, ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* .env is optional */
  }
  return out;
}

const fileEnv = loadEnvFile();
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? fileEnv.VITE_SUPABASE_URL;
const ANON_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  fileEnv.VITE_SUPABASE_PUBLISHABLE_KEY;
const MUSE_TOKEN = process.env.MUSE_API_TOKEN ?? "";

if (!SUPABASE_URL || !ANON_KEY) {
  console.error("Missing Supabase URL / publishable key. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.");
  process.exit(2);
}

const FN = `${SUPABASE_URL}/functions/v1/muse-executive`;
const REST = `${SUPABASE_URL}/rest/v1`;

const results = [];
const record = (name, state, detail) => {
  results.push({ name, state, detail });
  const mark = state === "PASS" ? "PASS" : state === "FAIL" ? "FAIL" : "SKIP";
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
};

const VIEWS = [
  "muse_executive_brief",
  "muse_portfolio_map",
  "muse_open_loops_live",
  "muse_decisions_required",
  "muse_kpi_summary",
  "muse_system_health",
  "muse_source_authority_state",
  "muse_source_conflicts_open",
  "muse_improvement_ledger",
];

/** Credential-shaped values must never appear in a Muse payload. */
function scanForSecrets(text) {
  const hits = [];
  if (/"(service_role|anon)_key"\s*:\s*"[^"]{20,}/i.test(text)) hits.push("key field");
  if (/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./.test(text)) hits.push("JWT");
  if (MUSE_TOKEN && text.includes(MUSE_TOKEN)) hits.push("muse token echoed");
  if (/sk-[A-Za-z0-9]{20,}/.test(text)) hits.push("provider key");
  return hits;
}

async function main() {
  console.log(`Muse live verification against ${SUPABASE_URL}\n`);

  // ---- 1. Schema present? (asked as the anon role, so a 200 here would itself
  //         be a security failure; we only use it to tell "missing" from "denied")
  console.log("== 1. schema + public exposure ==");
  let schemaApplied = null;
  for (const view of VIEWS) {
    const res = await fetch(`${REST}/${view}?select=*&limit=1`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    });
    const body = await res.text();

    if (res.status === 200) {
      record(`anon cannot read ${view}`, "FAIL", `HTTP 200 — the Muse layer is publicly readable`);
      schemaApplied = true;
      continue;
    }
    // 404/PGRST205 = view absent. 401/403/42501 = present but protected.
    const missing = res.status === 404 || /PGRST205|does not exist|schema cache/i.test(body);
    if (missing) {
      if (schemaApplied === null) schemaApplied = false;
      record(`${view} exists`, "FAIL", "not found — migration not applied to this database");
    } else {
      schemaApplied = true;
      record(`anon blocked from ${view}`, "PASS", `HTTP ${res.status}`);
    }
  }

  // ---- 2. Endpoint deployed + auth enforced
  console.log("\n== 2. endpoint + authentication ==");
  let endpointLive = false;
  try {
    const res = await fetch(`${FN}/executive/brief`);
    endpointLive = res.status !== 404;
    if (res.status === 401) {
      record("unauthenticated read rejected", "PASS", "HTTP 401");
    } else if (res.status === 404) {
      record("muse-executive deployed", "FAIL", "HTTP 404 — function not redeployed in Lovable yet");
    } else {
      record("unauthenticated read rejected", "FAIL", `expected 401, got ${res.status}`);
    }
  } catch (e) {
    record("muse-executive reachable", "FAIL", e.message);
  }

  if (endpointLive) {
    const res = await fetch(`${FN}/executive/brief`, {
      headers: { Authorization: "Bearer obviously-not-a-real-token" },
    });
    record(
      "invalid token rejected",
      res.status === 401 ? "PASS" : "FAIL",
      `HTTP ${res.status}`,
    );

    // A Supabase key must not work as a Muse credential.
    const asAnon = await fetch(`${FN}/executive/brief`, {
      headers: { Authorization: `Bearer ${ANON_KEY}` },
    });
    record(
      "Supabase key rejected as a Muse token",
      asAnon.status === 401 ? "PASS" : "FAIL",
      `HTTP ${asAnon.status}`,
    );
  }

  // ---- 3/4. Read-only enforcement — the critical security property
  console.log("\n== 3. read-only enforcement ==");
  if (!endpointLive) {
    record("write attempts rejected", "SKIP", "endpoint not deployed");
  } else {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await fetch(`${FN}/executive/brief`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(MUSE_TOKEN ? { Authorization: `Bearer ${MUSE_TOKEN}` } : {}),
        },
        body: JSON.stringify({ title: "muse write probe" }),
      });
      record(
        `${method} rejected`,
        res.status === 405 ? "PASS" : "FAIL",
        `HTTP ${res.status}${res.status === 405 ? "" : " — expected 405"}`,
      );
    }

    // PostgREST must also refuse a direct write, even with the operator key.
    const direct = await fetch(`${REST}/muse_open_loops`, {
      method: "POST",
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ domain_key: "ai_technical_systems", title: "anon write probe" }),
    });
    record(
      "anon cannot write muse_open_loops",
      direct.status >= 400 ? "PASS" : "FAIL",
      `HTTP ${direct.status}`,
    );
  }

  // ---- 5/6. Sample executive queries + honesty of unknown data
  console.log("\n== 4. sample executive queries ==");
  if (!endpointLive || !MUSE_TOKEN) {
    record("executive resources return data", "SKIP", MUSE_TOKEN ? "endpoint not deployed" : "MUSE_API_TOKEN not set");
  } else {
    const auth = { Authorization: `Bearer ${MUSE_TOKEN}` };

    const index = await fetch(FN, { headers: auth });
    record("index lists the contract", index.status === 200 ? "PASS" : "FAIL", `HTTP ${index.status}`);

    const unknown = await fetch(`${FN}/executive/definitely-not-a-resource`, { headers: auth });
    record(
      "unknown resource rejected (no dynamic table access)",
      unknown.status === 404 ? "PASS" : "FAIL",
      `HTTP ${unknown.status}`,
    );

    const injection = await fetch(`${FN}/executive/portfolio?domain=x%2Cor(1.eq.1)`, { headers: auth });
    record(
      "filter injection rejected",
      injection.status === 400 ? "PASS" : "FAIL",
      `HTTP ${injection.status}`,
    );

    let sawHonestStatus = false;
    for (const resource of ["brief", "portfolio", "open-loops", "systems", "sources", "kpis", "improvements"]) {
      const res = await fetch(`${FN}/executive/${resource}`, { headers: auth });
      const text = await res.text();

      if (res.status !== 200) {
        record(`GET /executive/${resource}`, "FAIL", `HTTP ${res.status}`);
        continue;
      }

      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        record(`GET /executive/${resource}`, "FAIL", "response was not JSON");
        continue;
      }

      const required = ["resource", "generated_at", "authoritative_source", "status", "confidence", "row_count", "data"];
      const missing = required.filter((k) => !(k in payload));
      if (missing.length > 0) {
        record(`GET /executive/${resource}`, "FAIL", `envelope missing ${missing.join(", ")}`);
        continue;
      }

      const secrets = scanForSecrets(text);
      if (secrets.length > 0) {
        record(`GET /executive/${resource}`, "FAIL", `payload contained ${secrets.join(", ")}`);
        continue;
      }

      if (payload.status !== "KNOWN") sawHonestStatus = true;
      // Honest representation of unreachable sources.
      const unreachable = (payload.data ?? []).filter((r) =>
        ["SOURCE_EXISTS_ACCESS_NEEDED", "AVAILABLE_NOT_CONNECTED", "NOT_MEASURED", "UNKNOWN"].includes(r.data_status),
      ).length;

      record(
        `GET /executive/${resource}`,
        "PASS",
        `${payload.row_count} rows · status ${payload.status} · ${unreachable} rows flagged unreachable/unmeasured`,
      );
    }

    record(
      "unknown data represented honestly",
      sawHonestStatus ? "PASS" : "FAIL",
      sawHonestStatus
        ? "at least one resource reported a non-KNOWN status"
        : "every resource claimed KNOWN — suspicious while sources are unconnected",
    );
  }

  // ---- Summary
  const failed = results.filter((r) => r.state === "FAIL");
  const skipped = results.filter((r) => r.state === "SKIP");
  console.log(`\n${"-".repeat(64)}`);
  console.log(`passed ${results.length - failed.length - skipped.length} · failed ${failed.length} · skipped ${skipped.length}`);

  if (schemaApplied === false) {
    console.log("\nNEXT STEP: apply supabase/migrations/20260925120000_muse_executive_layer.sql");
    console.log("in the Lovable SQL editor for project wkzwcfmvnwolgrdpnygc, then re-run this script.");
  }
  if (!endpointLive) {
    console.log("\nNEXT STEP: redeploy the `muse-executive` edge function from Lovable (Edge Functions -> redeploy).");
  }
  if (failed.length > 0) {
    console.log("\nFAILURES:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail ?? ""}`);
    process.exit(1);
  }
  console.log("\nMUSE LIVE VERIFICATION PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
