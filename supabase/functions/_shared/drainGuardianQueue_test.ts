import {
  assert,
  assertEquals,
  assertObjectMatch,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  backoffSeconds,
  buildGuardianRequestBody,
  decideOutcome,
  decideOutcomeForException,
  type DrainDeps,
  type DrainLogger,
  MAX_RETRIES,
  type PendingGuardianEventRow,
  processRow,
  runDrainTick,
  signHubRequest,
} from "./drainGuardianQueue.ts";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makeRow(over: Partial<PendingGuardianEventRow> = {}): PendingGuardianEventRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    correlation_id: "tg_12345",
    source: "photo",
    file_unique_id: "AgADfileuniq",
    client_name: "Sam",
    cg_client_id: "22222222-2222-2222-2222-222222222222",
    event_type: "responses_received",
    bureau: "Equifax",
    bureau_canonical: "equifax",
    round: 2,
    drive_file_id: "drive_abc",
    drive_file_name: "2026-05-07-equifax-letter.pdf",
    drive_path: "SAM CREDIT/responses/",
    ocr_text: null,
    retry_count: 0,
    ...over,
  };
}

function captureLogger(): { log: DrainLogger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: {
      info: (m) => lines.push(`INFO ${m}`),
      warn: (m) => lines.push(`WARN ${m}`),
      error: (m) => lines.push(`ERROR ${m}`),
    },
  };
}

interface FakeDepsState {
  updates: Array<{ id: string; patch: Record<string, unknown> }>;
  posts: Array<{ body: string; signatureHex: string }>;
  rows: PendingGuardianEventRow[];
  responseQueue: Array<{ status: number; body: string } | Error>;
}

function makeDeps(opts: {
  rows?: PendingGuardianEventRow[];
  responses?: Array<{ status: number; body: string } | Error>;
  secret?: string;
  now?: Date;
  logger?: DrainLogger;
}): { deps: DrainDeps; state: FakeDepsState } {
  const state: FakeDepsState = {
    updates: [],
    posts: [],
    rows: opts.rows ?? [],
    responseQueue: opts.responses ?? [],
  };
  const fixedNow = opts.now ?? new Date("2026-05-07T15:00:00.000Z");
  const deps: DrainDeps = {
    claimRows: async (limit, _now) => {
      const taken = state.rows.slice(0, limit);
      state.rows = state.rows.slice(limit);
      return taken;
    },
    postToGuardian: async (body, signatureHex) => {
      state.posts.push({ body, signatureHex });
      const next = state.responseQueue.shift();
      if (!next) throw new Error("no response queued in test fake");
      if (next instanceof Error) throw next;
      return next;
    },
    updateRow: async (id, patch) => {
      state.updates.push({ id, patch: patch as Record<string, unknown> });
    },
    signatureSecret: opts.secret ?? "test-secret",
    now: () => fixedNow,
    logger: opts.logger,
  };
  return { deps, state };
}

// ----------------------------------------------------------------------------
// HMAC signing
// ----------------------------------------------------------------------------

Deno.test("signHubRequest: known input produces the expected hex digest", async () => {
  // Reference value computed independently with `openssl dgst -sha256 -hmac`.
  const secret = "the-secret";
  const body = '{"correlation_id":"tg_1","event_type":"responses_received","summary":"hello"}';
  const sig = await signHubRequest(body, secret);
  assertEquals(
    sig,
    "fa17e2fbeefb91850d1448713820e5b6622a8031d6a85d312ab41eb0d180f75f",
  );
});

Deno.test("signHubRequest: deterministic — same inputs produce same digest", async () => {
  const a = await signHubRequest("hello", "k");
  const b = await signHubRequest("hello", "k");
  assertEquals(a, b);
  assertEquals(a.length, 64);
});

Deno.test("signHubRequest: different secret produces different digest", async () => {
  const a = await signHubRequest("hello", "k1");
  const b = await signHubRequest("hello", "k2");
  assert(a !== b);
});

// ----------------------------------------------------------------------------
// backoffSeconds
// ----------------------------------------------------------------------------

Deno.test("backoffSeconds: schedule is exponential and clamped to 8 minutes", () => {
  assertEquals(backoffSeconds(1), 30);
  assertEquals(backoffSeconds(2), 60);
  assertEquals(backoffSeconds(3), 120);
  assertEquals(backoffSeconds(4), 240);
  assertEquals(backoffSeconds(5), 480);
  // Anything beyond 5 stays at the cap (we won't actually retry past 5, but
  // pure function should still cap rather than blow up).
  assertEquals(backoffSeconds(6), 480);
  assertEquals(backoffSeconds(99), 480);
  // Defensive: zero/negative returns the floor.
  assertEquals(backoffSeconds(0), 30);
  assertEquals(backoffSeconds(-3), 30);
});

// ----------------------------------------------------------------------------
// buildGuardianRequestBody
// ----------------------------------------------------------------------------

Deno.test("buildGuardianRequestBody: full row → all fields populated, drive_path joined", () => {
  const body = buildGuardianRequestBody(makeRow({ ocr_text: "VERIFIED" }));
  assertEquals(body.correlation_id, "tg_12345");
  assertEquals(body.client_id, "22222222-2222-2222-2222-222222222222");
  assertEquals(body.client_name_hint, "Sam");
  assertEquals(body.bureau, "equifax");
  assertEquals(body.round, 2);
  assertEquals(body.event_type, "responses_received");
  assertEquals(body.drive_path, "SAM CREDIT/responses/2026-05-07-equifax-letter.pdf");
  assertEquals(body.drive_url, "https://drive.google.com/file/d/drive_abc/view");
  assertEquals(body.mime_type, "application/pdf");
  assertEquals(body.ocr_text, "VERIFIED");
  assert(body.summary.length > 0);
});

Deno.test("buildGuardianRequestBody: missing cg_client_id and round → fields omitted", () => {
  const body = buildGuardianRequestBody(makeRow({ cg_client_id: null, round: null }));
  assertEquals(body.client_id, undefined);
  assertEquals(body.round, undefined);
  // Hint still sent so Guardian can fuzzy-match.
  assertEquals(body.client_name_hint, "Sam");
});

Deno.test("buildGuardianRequestBody: empty ocr_text is omitted, not sent as ''", () => {
  const body = buildGuardianRequestBody(makeRow({ ocr_text: "" }));
  assertEquals(body.ocr_text, undefined);
});

Deno.test("buildGuardianRequestBody: image extensions map to image mime types", () => {
  const png = buildGuardianRequestBody(makeRow({ drive_file_name: "x.png" }));
  assertEquals(png.mime_type, "image/png");
  const jpg = buildGuardianRequestBody(makeRow({ drive_file_name: "x.jpg" }));
  assertEquals(jpg.mime_type, "image/jpeg");
  const heic = buildGuardianRequestBody(makeRow({ drive_file_name: "x.HEIC" }));
  assertEquals(heic.mime_type, "image/heic");
});

// ----------------------------------------------------------------------------
// decideOutcome — status transitions
// ----------------------------------------------------------------------------

const NOW = new Date("2026-05-07T15:00:00.000Z");

Deno.test("decideOutcome: 200 with event_id → completed (not idempotent)", () => {
  const out = decideOutcome(
    makeRow(),
    {
      status: 200,
      body: JSON.stringify({ resolved: true, event_id: "evt_1", attachment_id: "att_1" }),
    },
    NOW,
  );
  assertEquals(out.kind, "completed");
  if (out.kind === "completed") {
    assertEquals(out.guardian_event_id, "evt_1");
    assertEquals(out.idempotent, false);
  }
});

Deno.test("decideOutcome: 200 with idempotent:true → completed, idempotent flag set", () => {
  const out = decideOutcome(
    makeRow(),
    {
      status: 200,
      body: JSON.stringify({ event_id: "evt_1", idempotent: true }),
    },
    NOW,
  );
  if (out.kind !== "completed") throw new Error(`expected completed, got ${out.kind}`);
  assertEquals(out.idempotent, true);
  assertEquals(out.guardian_event_id, "evt_1");
});

Deno.test("decideOutcome: 200 with malformed JSON body → still completed (event_id null)", () => {
  const out = decideOutcome(makeRow(), { status: 200, body: "not json" }, NOW);
  if (out.kind !== "completed") throw new Error("expected completed");
  assertEquals(out.guardian_event_id, null);
  assertEquals(out.idempotent, false);
});

Deno.test("decideOutcome: 422 → needs_operator with candidates", () => {
  const out = decideOutcome(
    makeRow(),
    {
      status: 422,
      body: JSON.stringify({
        resolved: false,
        candidates: [{ id: "c1", legal_name: "Sam Smith" }, { id: "c2", legal_name: "Sam Jones" }],
      }),
    },
    NOW,
  );
  assertEquals(out.kind, "needs_operator");
  if (out.kind === "needs_operator") {
    const cands = out.candidates as Array<{ id: string; legal_name: string }>;
    assertEquals(cands.length, 2);
    assertEquals(cands[0].id, "c1");
  }
});

Deno.test("decideOutcome: 400 → failed (no retry)", () => {
  const out = decideOutcome(
    makeRow(),
    { status: 400, body: JSON.stringify({ error: "unknown bureau" }) },
    NOW,
  );
  assertEquals(out.kind, "failed");
  if (out.kind === "failed") {
    assert(out.error_message.includes("400"));
    assert(out.error_message.includes("unknown bureau"));
  }
});

Deno.test("decideOutcome: 401 → auth_failed (no retry, even on first attempt)", () => {
  const out = decideOutcome(
    makeRow({ retry_count: 0 }),
    { status: 401, body: "bad signature" },
    NOW,
  );
  assertEquals(out.kind, "auth_failed");
});

Deno.test("decideOutcome: 500 with retry_count=0 → retry_queued at +30s", () => {
  const out = decideOutcome(
    makeRow({ retry_count: 0 }),
    { status: 500, body: "db down" },
    NOW,
  );
  assertEquals(out.kind, "retry_queued");
  if (out.kind === "retry_queued") {
    assertEquals(out.retry_count, 1);
    assertEquals(
      out.next_retry_at,
      new Date(NOW.getTime() + 30 * 1000).toISOString(),
    );
  }
});

Deno.test("decideOutcome: 500 with retry_count=4 → retry_queued at +480s (cap)", () => {
  const out = decideOutcome(
    makeRow({ retry_count: 4 }),
    { status: 500, body: "still down" },
    NOW,
  );
  if (out.kind !== "retry_queued") throw new Error("expected retry_queued");
  assertEquals(out.retry_count, 5);
  assertEquals(
    out.next_retry_at,
    new Date(NOW.getTime() + 480 * 1000).toISOString(),
  );
});

Deno.test("decideOutcome: 500 with retry_count=5 → failed (cap exceeded)", () => {
  const out = decideOutcome(
    makeRow({ retry_count: MAX_RETRIES }),
    { status: 500, body: "still down" },
    NOW,
  );
  assertEquals(out.kind, "failed");
  if (out.kind === "failed") {
    assert(out.error_message.includes("retry_exhausted"));
  }
});

Deno.test("decideOutcome: 429 (rate-limited) is treated as transient → retry", () => {
  const out = decideOutcome(
    makeRow(),
    { status: 429, body: "slow down" },
    NOW,
  );
  assertEquals(out.kind, "retry_queued");
});

Deno.test("decideOutcomeForException: network error retries until cap", () => {
  const out = decideOutcomeForException(makeRow({ retry_count: 0 }), new Error("ECONNRESET"), NOW);
  assertEquals(out.kind, "retry_queued");
  if (out.kind === "retry_queued") {
    assertEquals(out.retry_count, 1);
    assert(out.error_message.includes("network"));
  }
});

Deno.test("decideOutcomeForException: at cap → failed", () => {
  const out = decideOutcomeForException(
    makeRow({ retry_count: MAX_RETRIES }),
    new Error("ECONNRESET"),
    NOW,
  );
  assertEquals(out.kind, "failed");
});

// ----------------------------------------------------------------------------
// processRow — verifies the right patch hits updateRow for each branch
// ----------------------------------------------------------------------------

Deno.test("processRow: 200 → updateRow with status=completed and event_id, clears retry fields", async () => {
  const { deps, state } = makeDeps({
    responses: [{ status: 200, body: JSON.stringify({ event_id: "evt_a" }) }],
  });
  const out = await processRow(makeRow(), deps);
  assertEquals(out.kind, "completed");
  assertEquals(state.updates.length, 1);
  assertObjectMatch(state.updates[0].patch, {
    status: "completed",
    guardian_event_id: "evt_a",
    next_retry_at: null,
    error_message: null,
  });
  assert(typeof state.updates[0].patch.delivered_at === "string");
});

Deno.test("processRow: signs body with HUB_SIGNATURE_SECRET — 64-hex sig sent on the request", async () => {
  const { deps, state } = makeDeps({
    secret: "shared-secret",
    responses: [{ status: 200, body: "{}" }],
  });
  await processRow(makeRow(), deps);
  assertEquals(state.posts.length, 1);
  assertEquals(state.posts[0].signatureHex.length, 64);
  // The signature should match a fresh sign of the exact body that went on the wire.
  const expected = await signHubRequest(state.posts[0].body, "shared-secret");
  assertEquals(state.posts[0].signatureHex, expected);
});

Deno.test("processRow: 422 → status=needs_operator, candidates stored on row", async () => {
  const { deps, state } = makeDeps({
    responses: [{
      status: 422,
      body: JSON.stringify({ candidates: [{ id: "c1", legal_name: "Sam Smith" }] }),
    }],
  });
  await processRow(makeRow(), deps);
  assertEquals(state.updates[0].patch.status, "needs_operator");
  const cands = state.updates[0].patch.clarification_needed as Array<{ id: string }>;
  assertEquals(cands[0].id, "c1");
});

Deno.test("processRow: 400 → status=failed, error_message stored", async () => {
  const { deps, state } = makeDeps({
    responses: [{ status: 400, body: '{"error":"bad bureau"}' }],
  });
  await processRow(makeRow(), deps);
  assertEquals(state.updates[0].patch.status, "failed");
  assert(String(state.updates[0].patch.error_message).includes("bad bureau"));
});

Deno.test("processRow: 401 → status=auth_failed and ERROR-level log fires", async () => {
  const cap = captureLogger();
  const { deps, state } = makeDeps({
    responses: [{ status: 401, body: "signature mismatch" }],
    logger: cap.log,
  });
  await processRow(makeRow(), deps);
  assertEquals(state.updates[0].patch.status, "auth_failed");
  const errLine = cap.lines.find((l) => l.startsWith("ERROR"));
  if (!errLine) throw new Error("expected an ERROR log line for auth_failed");
  assert(errLine.includes("HUB_SIGNATURE_SECRET"));
});

Deno.test("processRow: 500 → status stays pending, retry_count incremented, next_retry_at set", async () => {
  const { deps, state } = makeDeps({
    responses: [{ status: 500, body: "boom" }],
  });
  await processRow(makeRow({ retry_count: 1 }), deps);
  assertEquals(state.updates[0].patch.status, "pending");
  assertEquals(state.updates[0].patch.retry_count, 2);
  assert(typeof state.updates[0].patch.next_retry_at === "string");
});

Deno.test("processRow: thrown network error → retry_queued (no crash)", async () => {
  const { deps, state } = makeDeps({
    responses: [new Error("fetch failed")],
  });
  const out = await processRow(makeRow(), deps);
  assertEquals(out.kind, "retry_queued");
  assertEquals(state.updates[0].patch.status, "pending");
});

// ----------------------------------------------------------------------------
// Idempotency
// ----------------------------------------------------------------------------

Deno.test("idempotency: same correlation_id processed twice → both completed, only one terminal row", async () => {
  // Simulate the same row appearing twice across two ticks (e.g. a retry that
  // succeeded between claim and update on the first tick). Guardian dedupes
  // by correlation_id and returns idempotent:true on the second call. The
  // worker should mark both updates `completed` — the queue ends up clean.
  const row = makeRow();
  const { deps: deps1, state: s1 } = makeDeps({
    responses: [{ status: 200, body: JSON.stringify({ event_id: "evt_idem" }) }],
  });
  await processRow(row, deps1);

  const { deps: deps2, state: s2 } = makeDeps({
    responses: [{
      status: 200,
      body: JSON.stringify({ event_id: "evt_idem", idempotent: true }),
    }],
  });
  await processRow(row, deps2);

  assertEquals(s1.updates[0].patch.status, "completed");
  assertEquals(s2.updates[0].patch.status, "completed");
  // Same Guardian event id on both — that's the contract.
  assertEquals(s1.updates[0].patch.guardian_event_id, "evt_idem");
  assertEquals(s2.updates[0].patch.guardian_event_id, "evt_idem");
});

// ----------------------------------------------------------------------------
// runDrainTick — orchestrator + counters + observability
// ----------------------------------------------------------------------------

Deno.test("runDrainTick: zero rows → counters all zero, logs start+end", async () => {
  const cap = captureLogger();
  const { deps } = makeDeps({ rows: [], responses: [], logger: cap.log });
  const result = await runDrainTick(deps);
  assertEquals(result, {
    scanned: 0,
    completed: 0,
    needs_operator: 0,
    failed: 0,
    auth_failed: 0,
    retry_queued: 0,
    unexpected_errors: 0,
  });
  assert(cap.lines.some((l) => l.includes("tick start")));
  assert(cap.lines.some((l) => l.includes("scanned=0")));
});

Deno.test("runDrainTick: mixed batch → per-outcome counters", async () => {
  const cap = captureLogger();
  const rows = [
    makeRow({ id: "r1", correlation_id: "tg_1" }),
    makeRow({ id: "r2", correlation_id: "tg_2" }),
    makeRow({ id: "r3", correlation_id: "tg_3" }),
    makeRow({ id: "r4", correlation_id: "tg_4" }),
    makeRow({ id: "r5", correlation_id: "tg_5", retry_count: 0 }),
  ];
  const responses = [
    { status: 200, body: JSON.stringify({ event_id: "e1" }) },
    {
      status: 422,
      body: JSON.stringify({ candidates: [{ id: "c1", legal_name: "X" }] }),
    },
    { status: 400, body: '{"error":"bad"}' },
    { status: 401, body: "no" },
    { status: 503, body: "transient" },
  ];
  const { deps, state } = makeDeps({ rows, responses, logger: cap.log });
  const result = await runDrainTick(deps);
  assertEquals(result.scanned, 5);
  assertEquals(result.completed, 1);
  assertEquals(result.needs_operator, 1);
  assertEquals(result.failed, 1);
  assertEquals(result.auth_failed, 1);
  assertEquals(result.retry_queued, 1);
  assertEquals(state.updates.length, 5);
  // End-of-tick summary log carries every counter — operators rely on this for grepping.
  const endLine = cap.lines.find((l) => l.includes("tick end") && l.includes("scanned=5"));
  if (!endLine) throw new Error("expected tick end summary log");
  assert(endLine.includes("completed=1"));
  assert(endLine.includes("needs_operator=1"));
  assert(endLine.includes("failed=1"));
  assert(endLine.includes("auth_failed=1"));
  assert(endLine.includes("retry_queued=1"));
});

Deno.test("runDrainTick: claimRows throws → tick re-throws and logs ERROR", async () => {
  const cap = captureLogger();
  const deps: DrainDeps = {
    claimRows: async () => {
      throw new Error("RPC failed");
    },
    postToGuardian: async () => ({ status: 200, body: "{}" }),
    updateRow: async () => {},
    signatureSecret: "k",
    now: () => NOW,
    logger: cap.log,
  };
  let threw = false;
  try {
    await runDrainTick(deps);
  } catch (e) {
    threw = true;
    assert((e as Error).message.includes("RPC failed"));
  }
  assert(threw, "runDrainTick should re-throw claim failures");
  assert(cap.lines.some((l) => l.startsWith("ERROR") && l.includes("claimRows failed")));
});

Deno.test("runDrainTick: per-row updateRow failure increments unexpected_errors but doesn't abort batch", async () => {
  const rows = [makeRow({ id: "r1" }), makeRow({ id: "r2" })];
  const cap = captureLogger();
  let calls = 0;
  const deps: DrainDeps = {
    claimRows: async () => rows,
    postToGuardian: async () => ({ status: 200, body: JSON.stringify({ event_id: "e" }) }),
    updateRow: async (id) => {
      calls++;
      if (id === "r1") throw new Error("DB write failed");
    },
    signatureSecret: "k",
    now: () => NOW,
    logger: cap.log,
  };
  const result = await runDrainTick(deps);
  assertEquals(result.scanned, 2);
  assertEquals(result.completed, 1);
  assertEquals(result.unexpected_errors, 1);
  assertEquals(calls, 2);
});

// ----------------------------------------------------------------------------
// Integration-style: mocks the Guardian endpoint with a fetch handler
// ----------------------------------------------------------------------------

Deno.test("integration: full tick over a mocked Guardian endpoint with HMAC verification", async () => {
  // Simulates running the worker against a real-shaped Guardian endpoint.
  // We hand-roll a fetch handler that:
  //   * verifies the x-hub-signature matches HMAC-SHA256(body, secret)
  //   * returns 200 for the first correlation_id, 200+idempotent for a repeat,
  //     422 for an unresolved client (caption "Ambiguous"),
  //     401 if the signature is missing.
  const SECRET = "integration-secret";
  const seenCorrelations = new Set<string>();

  const guardianFetch = async (
    body: string,
    sigHex: string,
  ): Promise<{ status: number; body: string }> => {
    if (!sigHex) return { status: 401, body: "missing signature" };
    const expected = await signHubRequest(body, SECRET);
    if (sigHex !== expected) return { status: 401, body: "bad signature" };
    let payload: { correlation_id?: string; client_name_hint?: string } = {};
    try {
      payload = JSON.parse(body);
    } catch {
      return { status: 400, body: "bad json" };
    }
    if (payload.client_name_hint === "Ambiguous") {
      return {
        status: 422,
        body: JSON.stringify({
          resolved: false,
          candidates: [{ id: "ca", legal_name: "Ambig A" }, { id: "cb", legal_name: "Ambig B" }],
        }),
      };
    }
    const corr = payload.correlation_id ?? "";
    const idempotent = seenCorrelations.has(corr);
    seenCorrelations.add(corr);
    return {
      status: 200,
      body: JSON.stringify({
        resolved: true,
        event_id: `evt_${corr}`,
        attachment_id: `att_${corr}`,
        correlation_id: corr,
        idempotent,
      }),
    };
  };

  const rows: PendingGuardianEventRow[] = [
    makeRow({ id: "r1", correlation_id: "tg_int_1" }),
    makeRow({ id: "r2", correlation_id: "tg_int_2", client_name: "Ambiguous" }),
    // Same correlation_id as r1 — Guardian should return idempotent:true.
    makeRow({ id: "r3", correlation_id: "tg_int_1" }),
  ];

  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const deps: DrainDeps = {
    claimRows: async (limit) => rows.slice(0, limit),
    postToGuardian: guardianFetch,
    updateRow: async (id, patch) => {
      updates.push({ id, patch: patch as Record<string, unknown> });
    },
    signatureSecret: SECRET,
    now: () => NOW,
  };

  const result = await runDrainTick(deps);
  assertEquals(result.scanned, 3);
  assertEquals(result.completed, 2);
  assertEquals(result.needs_operator, 1);
  assertEquals(result.failed, 0);
  assertEquals(result.auth_failed, 0);

  const r1 = updates.find((u) => u.id === "r1")!;
  const r2 = updates.find((u) => u.id === "r2")!;
  const r3 = updates.find((u) => u.id === "r3")!;
  assertEquals(r1.patch.status, "completed");
  assertEquals(r1.patch.guardian_event_id, "evt_tg_int_1");
  assertEquals(r2.patch.status, "needs_operator");
  assertEquals(
    (r2.patch.clarification_needed as Array<{ id: string }>)[0].id,
    "ca",
  );
  // The third row hits the idempotent path on Guardian's side and still
  // ends up `completed` — that's the documented behaviour the worker must honour.
  assertEquals(r3.patch.status, "completed");
  assertEquals(r3.patch.guardian_event_id, "evt_tg_int_1");
});
