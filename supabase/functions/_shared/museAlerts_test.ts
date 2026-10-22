import { assert, assertEquals, assertRejects, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  addressPatch,
  addressedAgent,
  alertBody,
  canonicalJson,
  classifyDelivery,
  decideDelivery,
  deliverClaimed,
  dispatchDue,
  errorMessage,
  codingInboxWanted,
  eventAddresses,
  eventFromAction,
  extractBoardTags,
  fanoutAndDeliver,
  importSealKey,
  isAfterCursor,
  keyHint,
  nextAttemptIso,
  openText,
  parseCursor,
  parseRegister,
  parseUpdate,
  parseAck,
  planFanout,
  postWebhook,
  pullAlerts,
  pullOpen,
  readSealKey,
  sameAgent,
  sealText,
  subscriberFromToken,
  webhookEndpoint,
  type AlertEvent,
  type AlertStore,
  type AlertSubscriber,
  type ClaimedAlert,
} from "./museAlerts.ts";

const GROK = "11111111-1111-4111-8111-111111111111";
const CLAUDE = "22222222-2222-4222-8222-222222222222";
const CHATGPT = "33333333-3333-4333-8333-333333333333";
const ENKI = "44444444-4444-4444-8444-444444444444";
const POST = "55555555-5555-4555-8555-555555555555";

function subscriber(partial: Partial<AlertSubscriber> & Pick<AlertSubscriber, "id" | "agent_key">): AlertSubscriber {
  return {
    roles: [],
    aliases: [],
    delivery: "pull",
    enabled: true,
    ...partial,
  };
}

function event(partial: Partial<AlertEvent> = {}): AlertEvent {
  return {
    source_table: "muse_work_updates",
    source_id: POST,
    created_at: "2026-10-22T12:00:00.000Z",
    actor: "claude",
    addressed_agent: "grok-bot",
    addressed_role: "testing",
    targets: [],
    kind: "STATUS",
    message: "Please verify the cut.",
    mission_id: "66666666-6666-4666-8666-666666666666",
    improvement_id: null,
    task_id: null,
    domain_key: "muse",
    evidence_ref: null,
    ...partial,
  };
}

function keyMaterial(): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = i + 1;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

Deno.test("an agent is not alerted about its own post", () => {
  const grok = subscriber({
    id: GROK,
    agent_key: "grok-bot",
    roles: ["testing"],
    aliases: ["Grok Bot"],
    delivery: "webhook",
  });
  assertEquals(eventAddresses(grok, event({ actor: "grok-bot", addressed_role: "testing", addressed_agent: null })), false);
  assertEquals(eventAddresses(grok, event({ actor: "Grok Bot", addressed_agent: "claude", addressed_role: "testing" })), false);
  assertEquals(sameAgent(grok, "  GROK-BOT "), true);
});

Deno.test("a post reaches the named agent and every other agent in the role", () => {
  const grok = subscriber({ id: GROK, agent_key: "grok-bot", roles: ["testing"], aliases: ["Grok Bot"], delivery: "webhook" });
  const claude = subscriber({ id: CLAUDE, agent_key: "claude", roles: ["coding"], aliases: ["Claude"], delivery: "pull" });
  const chatgpt = subscriber({ id: CHATGPT, agent_key: "chatgpt", roles: ["audit", "testing"], delivery: "pull" });
  const enki = subscriber({ id: ENKI, agent_key: "enki", roles: ["execution"], aliases: ["Enki", "Muse"], delivery: "pull" });
  const posted = event({ actor: "claude" });
  const plan = planFanout(posted, [grok, claude, chatgpt, enki]);
  assertEquals(plan.webhook.map((row) => row.agent_key), ["grok-bot"]);
  assertEquals(plan.pull.slice().sort(), ["chatgpt"]);
  assertEquals(plan.webhook.length, 1);
  assert(plan.webhook[0].dedupe_key.includes(POST));
  assert(plan.webhook[0].dedupe_key.endsWith(GROK));
});

Deno.test("an unaddressed update wakes nobody", () => {
  const grok = subscriber({ id: GROK, agent_key: "grok-bot", roles: ["testing"], delivery: "webhook" });
  const plan = planFanout(event({ addressed_agent: null, addressed_role: null }), [grok]);
  assertEquals(plan.webhook, []);
  assertEquals(plan.pull, []);
});

Deno.test("address columns are omitted unless the caller set them", () => {
  assertEquals(addressPatch(null, null), {});
  assertEquals(addressPatch("grok-bot", null), { addressed_agent: "grok-bot" });
  assertEquals(addressPatch(null, "coding"), { addressed_role: "coding" });
  assertThrows(() => addressedAgent("grok bot!"), Error, "addressed_agent_rejected");
});

Deno.test("task assignment uses the executor, and a plain update without an address does not", () => {
  const task = eventFromAction("create_task", {
    id: POST,
    created_at: "2026-10-22T12:00:00.000Z",
    executor: "Grok Bot",
    assigning_agent: "claude",
    title: "Check the ending",
    objective: "Watch the cut",
    improvement_id: "66666666-6666-4666-8666-666666666666",
    domain_key: "muse",
  }, "claude");
  assertEquals(task?.addressed_agent, "Grok Bot");
  assertEquals(task?.actor, "claude");
  assertEquals(task?.kind, "TASK");
  assert(task?.message.includes("Check the ending"));

  assertEquals(eventFromAction("append_update", {
    id: POST,
    created_at: "2026-10-22T12:00:00.000Z",
    actor: "enki",
    message: "filed",
    update_type: "NOTE",
  }, "enki"), null);

  const note = eventFromAction("append_update", {
    id: POST,
    created_at: "2026-10-22T12:00:00.000Z",
    message: "for coding",
    update_type: "ASSIGNMENT",
    addressed_role: "coding",
    mission_id: "66666666-6666-4666-8666-666666666666",
  }, "enki");
  assertEquals(note?.addressed_role, "coding");
  assertEquals(note?.addressed_agent, null);
});

Deno.test("the alert body carries the reply path and no webhook material", () => {
  const body = alertBody(event(), null);
  const encoded = JSON.stringify(body);
  assertEquals(body.event, "muse.alert");
  assertEquals("outbox_id" in body, false);
  assert(encoded.includes("append_update"));
  for (const key of ["webhook_url", "webhook_key", "authorization", "bearer", "secret", "crsr_"]) {
    assertEquals(encoded.toLowerCase().includes(key), false, key);
  }
});

Deno.test("webhook endpoints are https on 443 with a public host", () => {
  assertEquals(
    webhookEndpoint("https://api2.cursor.sh/automations/webhook/abc").host,
    "api2.cursor.sh",
  );
  for (const bad of [
    "http://api2.cursor.sh/hook",
    "https://user:pass@api2.cursor.sh/hook",
    "https://localhost/hook",
    "https://127.0.0.1/hook",
    "https://10.1.1.1/hook",
    "https://169.254.169.254/latest",
    "https://192.168.1.9/hook",
    "https://api2.cursor.sh:8443/hook",
    "https://api2.cursor.sh/hook?token=secret",
    "https://metadata.google.internal/hook",
  ]) {
    assertThrows(() => webhookEndpoint(bad), Error, "webhook_url_rejected");
  }
});

Deno.test("registration accepts pull without a secret and rejects a stored key on pull", () => {
  const pull = parseRegister({ agent_key: "grok-bot", roles: ["testing"], aliases: ["Grok Bot"], delivery: "pull" });
  assertEquals(pull.webhook_url, null);
  assertEquals(pull.enabled, true);
  assertThrows(() => parseRegister({
    agent_key: "grok-bot",
    delivery: "pull",
    webhook_key: "crsr_this_key_should_not_be_kept",
  }), Error, "pull_rejects_webhook");
  const hook = parseRegister({
    agent_key: "grok-bot",
    delivery: "webhook",
    roles: ["testing"],
    webhook_url: "https://api2.cursor.sh/automations/webhook/abc",
    webhook_key: "crsr_this_is_a_long_enough_key",
  });
  assertEquals(hook.webhook_url, "https://api2.cursor.sh/automations/webhook/abc");
  assertEquals(keyHint(hook.webhook_key ?? ""), "_key");
  assertThrows(() => parseUpdate({ agent_key: "grok-bot" }), Error, "update_empty");
});

Deno.test("seal round trip keeps the url out of the stored blob", async () => {
  const key = await importSealKey(keyMaterial());
  const url = "https://api2.cursor.sh/automations/webhook/routine-1";
  const bearer = "crsr_this_is_a_long_enough_key";
  const sealedUrl = await sealText(url, key);
  const sealedKey = await sealText(bearer, key);
  assertEquals(sealedUrl.includes("api2.cursor.sh"), false);
  assertEquals(sealedKey.includes("crsr_"), false);
  assertEquals(await openText(sealedUrl, key), url);
  assertEquals(await openText(sealedKey, key), bearer);
  const other = await importSealKey(btoa("0123456789abcdef0123456789abcdef"));
  await assertRejects(() => openText(sealedKey, other), Error, "seal_corrupt");
  assertEquals(await readSealKey("  "), null);
  await assertRejects(() => readSealKey("aaaa"), Error, "seal_key_invalid");
});

Deno.test("delivery classifies auth failures as final and server errors as retry", () => {
  assertEquals(classifyDelivery(200, false).outcome, "delivered");
  assertEquals(classifyDelivery(401, false), { outcome: "fail", error_code: "http_401" });
  assertEquals(classifyDelivery(400, false).outcome, "fail");
  assertEquals(classifyDelivery(503, false).outcome, "retry");
  assertEquals(classifyDelivery(null, true).error_code, "network");
  const now = Date.parse("2026-10-22T12:00:00.000Z");
  assertEquals(decideDelivery(503, false, 1, now).status, "pending");
  assertEquals(decideDelivery(503, false, 1, now).next_attempt_at, new Date(now + 30_000).toISOString());
  assertEquals(nextAttemptIso(5, now), null);
  assertEquals(decideDelivery(503, false, 5, now).status, "failed");
  assertEquals(decideDelivery(401, false, 1, now).status, "failed");
});

Deno.test("a webhook post does not echo the bearer back to the caller", async () => {
  const bearer = "crsr_this_is_a_long_enough_key";
  let authorization = "";
  const ok = await postWebhook({
    url: "https://api2.cursor.sh/automations/webhook/abc",
    bearer,
    body: { event: "muse.alert", message: "hi" },
    fetchImpl: (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      authorization = headers.authorization;
      assertEquals(init?.redirect, "error");
      assertEquals(String(init?.body).includes(bearer), false);
      return Promise.resolve(new Response("", { status: 200 }));
    },
  });
  assertEquals(ok, { http_status: 200, transportError: false });
  assertEquals(authorization, `Bearer ${bearer}`);
  assertEquals(JSON.stringify(ok).includes(bearer), false);

  const failed = await postWebhook({
    url: "https://api2.cursor.sh/automations/webhook/abc",
    bearer,
    body: { event: "muse.alert" },
    fetchImpl: () => Promise.reject(new Error(`boom ${bearer}`)),
  });
  assertEquals(failed.transportError, true);
  assertEquals(JSON.stringify(failed).includes(bearer), false);
});

function memoryStore(subscribers: AlertSubscriber[], events: AlertEvent[]) {
  const outbox: ClaimedAlert[] = [];
  const finished: Array<{ id: string; status: string; error_code: string | null }> = [];
  const store: AlertStore = {
    listEnabledSubscribers: () => Promise.resolve(subscribers.filter((row) => row.enabled)),
    insertOutbox: (rows) => {
      const inserted = rows.map((row) => {
        const claimed: ClaimedAlert = {
          id: crypto.randomUUID(),
          subscriber_id: row.subscriber_id,
          agent_key: row.agent_key,
          attempts: 0,
          payload: row.payload,
        };
        outbox.push(claimed);
        return claimed;
      });
      return Promise.resolve(inserted);
    },
    claim: (_limit, ids) => {
      const claimed = outbox
        .filter((row) => ids === null || ids.includes(row.id))
        .map((row) => ({ ...row, attempts: row.attempts + 1 }));
      return Promise.resolve(claimed);
    },
    sealedFor: () => Promise.resolve(null),
    finish: (id, decision) => {
      finished.push({ id, status: decision.status, error_code: decision.error_code });
      return Promise.resolve();
    },
    logDelivery: () => Promise.resolve(),
    listEvents: (cursor) => Promise.resolve(
      events.filter((row) => Date.parse(row.created_at) >= Date.parse(cursor.at)),
    ),
    listAcked: () => Promise.resolve([]),
    ack: () => Promise.resolve({ acked: 0, already: 0 }),
  };
  return { store, outbox, finished };
}

Deno.test("fanout enqueues webhook subscribers, skips the actor, and does not enqueue pull", async () => {
  const subscribers = [
    subscriber({ id: GROK, agent_key: "grok-bot", roles: ["testing"], aliases: ["Grok Bot"], delivery: "webhook" }),
    subscriber({ id: CLAUDE, agent_key: "claude", roles: ["coding"], delivery: "webhook" }),
    subscriber({ id: CHATGPT, agent_key: "chatgpt", roles: ["audit"], delivery: "pull" }),
  ];
  const { store, outbox, finished } = memoryStore(subscribers, []);
  const summary = await fanoutAndDeliver({
    store,
    event: event({ actor: "claude", addressed_agent: null, addressed_role: "testing" }),
    sealKey: null,
  });
  assertEquals(summary.matched, 1);
  assertEquals(summary.pull, 0);
  assertEquals(summary.enqueued, 1);
  assertEquals(summary.pending, 1);
  assertEquals(outbox.map((row) => row.agent_key), ["grok-bot"]);
  assertEquals(finished, []);
  assertEquals(JSON.stringify(outbox).includes("crsr_"), false);
});

Deno.test("a claimed webhook is posted once and a 401 is not retried", async () => {
  const key = await importSealKey(keyMaterial());
  const url = "https://api2.cursor.sh/automations/webhook/abc";
  const bearer = "crsr_this_is_a_long_enough_key";
  const row: ClaimedAlert = {
    id: "77777777-7777-4777-8777-777777777777",
    subscriber_id: GROK,
    agent_key: "grok-bot",
    attempts: 1,
    payload: alertBody(event(), null),
  };
  const decision = await deliverClaimed({
    row,
    sealed: { url_sealed: await sealText(url, key), key_sealed: await sealText(bearer, key) },
    sealKey: key,
    nowMs: Date.parse("2026-10-22T12:00:00.000Z"),
    fetchImpl: () => Promise.resolve(new Response("", { status: 401 })),
  });
  assertEquals(decision.status, "failed");
  assertEquals(decision.error_code, "http_401");
  assertEquals(JSON.stringify(decision).includes(bearer), false);
  await assertRejects(() => dispatchDue({
    store: memoryStore([], []).store,
    sealKey: null,
    limit: 5,
  }), Error, "seal_key_missing");
});

Deno.test("pull returns posts for the caller after the cursor and skips their own", async () => {
  const grok = subscriber({ id: GROK, agent_key: "grok-bot", roles: ["testing"], aliases: ["Grok Bot"] });
  const own = event({
    source_id: "88888888-8888-4888-8888-888888888888",
    actor: "grok-bot",
    addressed_role: "testing",
    created_at: "2026-10-22T12:00:01.000Z",
  });
  const older = event({
    source_id: "99999999-9999-4999-8999-999999999999",
    created_at: "2026-10-22T11:00:00.000Z",
  });
  const newer = event({
    source_id: POST,
    actor: "claude",
    addressed_agent: "Grok Bot",
    addressed_role: null,
    created_at: "2026-10-22T12:00:02.000Z",
    message: "your turn",
  });
  const { store } = memoryStore([], [older, own, newer]);
  const page = await pullAlerts({
    store,
    subscriber: grok,
    cursor: parseCursor("2026-10-22T12:00:00.000Z", null),
    limit: 50,
  });
  assertEquals(page.data.length, 1);
  assertEquals(page.data[0].message, "your turn");
  assertEquals(page.next_cursor.id, POST);
  const fallback = subscriberFromToken("grok-bot", null);
  assertEquals(fallback.agent_key, "grok-bot");
  assertEquals(errorMessage("since_required").includes("since"), true);
});

Deno.test("a same-millisecond cursor does not repeat or skip", () => {
  const first = { created_at: "2026-10-22T12:00:00.000Z", source_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  const second = { created_at: "2026-10-22T12:00:00.000Z", source_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
  const third = { created_at: "2026-10-22T12:00:01.000Z", source_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
  const cursor = { at: first.created_at, id: first.source_id };
  assertEquals(isAfterCursor(first, cursor), false);
  assertEquals(isAfterCursor(second, cursor), true);
  assertEquals(isAfterCursor(third, cursor), true);
  assertEquals(isAfterCursor(second, { at: first.created_at, id: null }), false);
});

function roster(): AlertSubscriber[] {
  return [
    subscriber({ id: GROK, agent_key: "grok-bot", roles: ["testing"], aliases: ["Grok Bot", "Grok"], created_at: "2026-10-22T00:00:00.000Z" }),
    subscriber({ id: CLAUDE, agent_key: "claude-code", roles: ["coding"], aliases: ["Claude", "Cursor", "claude-code", "claude-code-cloud"], created_at: "2026-10-22T00:00:00.000Z" }),
    subscriber({ id: CHATGPT, agent_key: "chatgpt", roles: ["audit"], aliases: ["ChatGPT"], created_at: "2026-10-22T00:00:00.000Z" }),
    subscriber({ id: ENKI, agent_key: "enki", roles: ["execution"], aliases: ["Enki", "Muse"], created_at: "2026-10-22T00:00:00.000Z" }),
  ];
}

Deno.test("board tags name agents and ignore instagram handles and prose", () => {
  assertEquals(extractBoardTags("@Grok Bot @Enki — pack", "NOTE"), ["Grok Bot", "Enki"]);
  assertEquals(extractBoardTags("ASSIGNED TO CURSOR — Build FendiFrost.com", "ASSIGNMENT"), ["Cursor"]);
  assertEquals(extractBoardTags("For Enki / Muse: send the drafts from @fendi_frost", "ASSIGNMENT"), ["Enki", "Muse"]);
  assertEquals(extractBoardTags("For **Muse / Enki** (Control Center). Source:", "NOTE"), []);
  assertEquals(extractBoardTags("after Claude fixes its side. @leifmagnuspettersen @_gabrieltheodoro", "NOTE"), []);
  assertEquals(extractBoardTags("[NO PACK TODAY] no Instagram curators", "NOTE"), []);
  const cursor = eventFromAction("append_update", {
    id: POST,
    created_at: "2026-10-21T18:39:02.164Z",
    message: "ASSIGNED TO CURSOR — Build FendiFrost.com music sales and streaming platform.",
    update_type: "ASSIGNMENT",
    mission_id: "66666666-6666-4666-8666-666666666666",
  }, "ChatGPT");
  assertEquals(cursor?.targets, ["Cursor"]);
  assertEquals(cursor?.addressed_agent, null);
  const agents = roster();
  assertEquals(codingInboxWanted(cursor!, agents), true);
  assertEquals(eventAddresses(agents[1], cursor!), true);
  assertEquals(eventAddresses(agents[0], cursor!), false);
  const own = eventFromAction("append_update", {
    id: POST,
    created_at: "2026-10-22T16:18:20.274Z",
    message: "[FENDI DIRECTIVE] @Grok Bot @Enki\n\nClaude finds the curators.",
    update_type: "ASSIGNMENT",
  }, "claude-code");
  assertEquals(codingInboxWanted(own!, agents), false);
  assertEquals(eventAddresses(agents[0], own!), true);
  assertEquals(eventAddresses(agents[3], own!), true);
  const pack = eventFromAction("append_update", {
    id: POST,
    created_at: "2026-10-14T14:42:01.317Z",
    message: "[ASSIGNMENT] Muse IG playlist pack.\n\nFor Enki / Muse: send 22 Instagram DMs from @fendi_frost.",
    update_type: "ASSIGNMENT",
  }, "grok-bot");
  assertEquals(codingInboxWanted(pack!, agents), false);
  assertEquals(eventAddresses(agents[3], pack!), true);
  assertEquals(eventFromAction("append_update", {
    id: POST,
    created_at: "2026-10-22T12:00:00.000Z",
    message: "filed the receipt",
    update_type: "NOTE",
  }, "enki"), null);
});

Deno.test("the open queue hides acked posts and the caller's own posts", async () => {
  const agents = roster();
  const grok = agents[0];
  const acked = new Set<string>();
  const posted = event({
    actor: "claude-code",
    addressed_agent: null,
    addressed_role: null,
    targets: ["Grok Bot"],
    message: "@Grok Bot check the cut",
    created_at: "2026-10-22T12:00:00.000Z",
  });
  const own = event({
    source_id: "88888888-8888-4888-8888-888888888888",
    actor: "grok-bot",
    addressed_agent: null,
    addressed_role: "testing",
    targets: [],
    created_at: "2026-10-22T12:05:00.000Z",
  });
  const { store } = memoryStore([grok], [posted, own]);
  store.listAcked = () => Promise.resolve([...acked]);
  store.ack = (_id, items) => {
    for (const item of items) acked.add(`${item.source_table}:${item.source_id}`);
    return Promise.resolve({ acked: items.length, already: 0 });
  };
  const first = await pullOpen({ store, subscriber: grok, limit: 20 });
  assertEquals(first.data.map((row) => row.message), ["@Grok Bot check the cut"]);
  const parsed = parseAck({ source_table: "muse_work_updates", source_id: POST });
  await store.ack(grok.id, parsed);
  const second = await pullOpen({ store, subscriber: grok, limit: 20 });
  assertEquals(second.data, []);
  assertEquals(first.floor, "2026-10-22T00:00:00.000Z");
});

Deno.test("canonical json ignores key order so idempotency does not store the secret", () => {
  assertEquals(
    canonicalJson({ b: 1, a: { d: 2, c: 3 } }),
    canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
  );
  const hashedShape = canonicalJson({
    action: "register_subscriber",
    payload: { agent_key: "grok-bot", delivery: "pull" },
  });
  assertEquals(hashedShape.includes("webhook"), false);
});
