/**
 * Run: deno test supabase/functions/_shared/telegramAttachmentHandler_test.ts --allow-env
 */
import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  extractAttachmentSource,
  handleTelegramAttachment,
  type AttachmentHandlerDeps,
  type ClientResolution,
  type DriveUploadResult,
  type PendingGuardianEventInput,
  type TelegramAttachmentUpdate,
} from "./telegramAttachmentHandler.ts";

interface FakeUploadCall {
  folderId: string;
  fileName: string;
  bytes: Uint8Array;
  mimeType: string;
}

interface FakeDeps extends AttachmentHandlerDeps {
  uploads: FakeUploadCall[];
  queued: PendingGuardianEventInput[];
  warnings: string[];
  deleteCalls: number[];
}

function makeFakeDeps(opts: {
  resolveClient?: (raw: string) => Promise<ClientResolution>;
  driveFolders?: Array<{ id: string; name: string; parentId?: string; modifiedTime?: string }>;
  existingFiles?: Set<string>; // "folderId|fileName"
  resolveTelegramFileUrl?: (id: string) => Promise<string>;
  downloadFile?: (url: string) => Promise<{ bytes: Uint8Array; mimeType?: string }>;
  queueErr?: Error;
  uploadErr?: Error;
  now?: () => Date;
  /** Set to "wired-success" / "wired-fail" / undefined to mirror env-flag scenarios. */
  deleteMode?: "wired-success" | "wired-fail" | "not-wired";
}): FakeDeps {
  const folders = [...(opts.driveFolders ?? [])];
  const existing = new Set<string>(opts.existingFiles ?? []);
  const uploads: FakeUploadCall[] = [];
  const queued: PendingGuardianEventInput[] = [];
  const warnings: string[] = [];
  const deleteCalls: number[] = [];

  const resolveClient = opts.resolveClient ??
    (async (raw: string): Promise<ClientResolution> => ({
      matchedName: raw,
      cgClientId: "cg-default",
      needsVerification: false,
    }));

  const drive = {
    async searchFolders(name: string) {
      return folders
        .filter((f) => !f.parentId && f.name === name)
        .map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
    },
    async searchChildFolders(parentId: string, name: string) {
      return folders
        .filter((f) => f.parentId === parentId && f.name === name)
        .map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
    },
    async createFolder(name: string, parentId: string) {
      const id = `gen-${folders.length + 1}`;
      folders.push({ id, name, parentId });
      return { id, name };
    },
    async upsertFile(args: {
      folderId: string;
      fileName: string;
      bytes: Uint8Array;
      mimeType: string;
    }): Promise<DriveUploadResult> {
      if (opts.uploadErr) throw opts.uploadErr;
      uploads.push(args);
      const key = `${args.folderId}|${args.fileName}`;
      if (existing.has(key)) {
        return { fileId: `existing-${args.fileName}`, alreadyExisted: true };
      }
      existing.add(key);
      return { fileId: `new-${args.fileName}`, alreadyExisted: false };
    },
  };

  let deleteSourceMessage: ((id: number) => Promise<void>) | undefined;
  switch (opts.deleteMode ?? "not-wired") {
    case "wired-success":
      deleteSourceMessage = async (id) => {
        deleteCalls.push(id);
      };
      break;
    case "wired-fail":
      deleteSourceMessage = async (id) => {
        deleteCalls.push(id);
        throw new Error("forbidden: bot lacks delete permission");
      };
      break;
    case "not-wired":
      deleteSourceMessage = undefined;
      break;
  }

  return {
    resolveTelegramFileUrl: opts.resolveTelegramFileUrl ??
      (async (id) => `https://api.telegram.org/file/bot/${id}`),
    downloadFile: opts.downloadFile ??
      (async (_url) => ({ bytes: new Uint8Array([1, 2, 3, 4]), mimeType: "image/jpeg" })),
    resolveClient,
    drive,
    queuePendingGuardianEvent: async (event) => {
      if (opts.queueErr) throw opts.queueErr;
      queued.push(event);
    },
    deleteSourceMessage,
    now: opts.now ?? (() => new Date(Date.UTC(2026, 4, 2, 12))),
    logger: {
      info: () => {},
      warn: (m) => warnings.push(m),
      error: () => {},
    },
    uploads,
    queued,
    warnings,
    deleteCalls,
  };
}

function basePhotoUpdate(caption: string): TelegramAttachmentUpdate {
  return {
    update_id: 999001,
    message: {
      message_id: 100,
      caption,
      photo: [
        { file_id: "fid-small", file_unique_id: "fuid-1", file_size: 1024 },
        { file_id: "fid-large", file_unique_id: "fuid-1", file_size: 8192 },
      ],
    },
  };
}

function baseDocUpdate(caption: string): TelegramAttachmentUpdate {
  return {
    update_id: 999002,
    message: {
      message_id: 101,
      caption,
      document: {
        file_id: "doc-fid",
        file_unique_id: "doc-fuid",
        file_name: "scan.pdf",
        mime_type: "application/pdf",
      },
    },
  };
}

// ── Source detection ─────────────────────────────────────────────────────────

Deno.test("extractAttachmentSource: photo picks the largest size", () => {
  const s = extractAttachmentSource(basePhotoUpdate("anything"));
  assertEquals(s?.fileId, "fid-large");
  assertEquals(s?.source, "photo");
});

Deno.test("extractAttachmentSource: document carries through filename + mime", () => {
  const s = extractAttachmentSource(baseDocUpdate("anything"));
  assertEquals(s?.fileId, "doc-fid");
  assertEquals(s?.originalFileName, "scan.pdf");
  assertEquals(s?.mimeType, "application/pdf");
});

Deno.test("extractAttachmentSource: text-only message returns null", () => {
  const s = extractAttachmentSource({ update_id: 1, message: { message_id: 1 } });
  assertEquals(s, null);
});

// ── Happy path ───────────────────────────────────────────────────────────────

Deno.test("handleTelegramAttachment: photo + caption → uploads + queues event + reply text", async () => {
  const deps = makeFakeDeps({
    driveFolders: [
      { id: "client-sam", name: "SAM CREDIT", modifiedTime: "2026-04-01T00:00:00Z" },
      { id: "resp-sam", name: "responses", parentId: "client-sam" },
    ],
  });
  const out = await handleTelegramAttachment(basePhotoUpdate("Sam | Equifax | Round 2 response"), deps);
  if (out.kind !== "logged") throw new Error(`expected logged, got ${out.kind}`);
  assertEquals(deps.uploads.length, 1);
  assertEquals(deps.uploads[0].folderId, "resp-sam");
  assertEquals(deps.uploads[0].fileName, "2026-05-02-equifax-r2-response.jpg");
  assertEquals(deps.queued.length, 1);
  assertEquals(deps.queued[0].correlationId, "tg_999001");
  assertEquals(deps.queued[0].client, "Sam");
  assertEquals(deps.queued[0].bureauCanonical, "equifax");
  assertEquals(deps.queued[0].round, 2);
  assertEquals(deps.queued[0].eventType, "responses_received");
  assertEquals(deps.queued[0].ocrText, null);
  assertEquals(deps.queued[0].driveFileId, "new-2026-05-02-equifax-r2-response.jpg");
  assert(out.reply.includes("SAM CREDIT/responses/"));
  assert(out.reply.includes("Guardian event queued"));
});

Deno.test("handleTelegramAttachment: PDF document keeps original .pdf extension", async () => {
  const deps = makeFakeDeps({
    driveFolders: [
      { id: "client-tara", name: "TARA WRIGHT CREDIT" },
      { id: "resp-tara", name: "responses", parentId: "client-tara" },
    ],
    resolveClient: async (raw) => ({
      matchedName: "Tara Wright",
      cgClientId: "cg-tara",
      needsVerification: false,
    }),
    downloadFile: async () => ({ bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), mimeType: "application/pdf" }),
  });
  const out = await handleTelegramAttachment(baseDocUpdate("Tara | LexisNexis | Round 1 response"), deps);
  if (out.kind !== "logged") throw new Error(`expected logged, got ${out.kind}`);
  assertEquals(deps.uploads[0].fileName, "2026-05-02-lexisnexis-r1-response.pdf");
  assertEquals(deps.uploads[0].mimeType, "application/pdf");
  assertEquals(deps.queued[0].source, "document");
});

Deno.test("handleTelegramAttachment: caption without round → 'response' tag, round=null", async () => {
  const deps = makeFakeDeps({
    driveFolders: [
      { id: "c", name: "SAM CREDIT" },
      { id: "r", name: "responses", parentId: "c" },
    ],
  });
  const out = await handleTelegramAttachment(basePhotoUpdate("Sam | Innovis"), deps);
  if (out.kind !== "logged") throw new Error("expected logged");
  assertEquals(deps.queued[0].round, null);
  assertEquals(deps.uploads[0].fileName, "2026-05-02-innovis-response.jpg");
});

// ── Idempotency ──────────────────────────────────────────────────────────────

Deno.test("handleTelegramAttachment: same attachment twice → second upsert reports alreadyExisted", async () => {
  const deps = makeFakeDeps({
    driveFolders: [
      { id: "c", name: "SAM CREDIT" },
      { id: "r", name: "responses", parentId: "c" },
    ],
    existingFiles: new Set(["r|2026-05-02-equifax-r2-response.jpg"]),
  });
  const out1 = await handleTelegramAttachment(basePhotoUpdate("Sam | Equifax | Round 2 response"), deps);
  if (out1.kind !== "logged") throw new Error("expected logged");
  assertEquals(out1.alreadyExisted, true);
  // The queued event still records the existing fileId — Guardian inbox can de-dupe.
  assertEquals(deps.queued[0].driveFileId, "existing-2026-05-02-equifax-r2-response.jpg");
  assert(out1.reply.includes("already on Drive"));
});

// ── Caption parse failures ──────────────────────────────────────────────────

Deno.test("handleTelegramAttachment: missing caption → clarify, no upload, no queue", async () => {
  const deps = makeFakeDeps({
    driveFolders: [{ id: "c", name: "SAM CREDIT" }],
  });
  const update = basePhotoUpdate("");
  delete update.message!.caption;
  const out = await handleTelegramAttachment(update, deps);
  assertEquals(out.kind, "clarify_caption");
  assertEquals(deps.uploads.length, 0);
  assertEquals(deps.queued.length, 0);
});

Deno.test("handleTelegramAttachment: unparseable caption → clarify, no upload", async () => {
  const deps = makeFakeDeps({
    driveFolders: [{ id: "c", name: "SAM CREDIT" }],
  });
  const out = await handleTelegramAttachment(basePhotoUpdate("just one segment"), deps);
  assertEquals(out.kind, "clarify_caption");
  if (out.kind === "clarify_caption") {
    assert(out.reply.includes("client and bureau"));
  }
});

Deno.test("handleTelegramAttachment: unknown bureau → clarify, no upload", async () => {
  const deps = makeFakeDeps({
    driveFolders: [{ id: "c", name: "SAM CREDIT" }],
  });
  const out = await handleTelegramAttachment(basePhotoUpdate("Sam | NotABureau | Round 1"), deps);
  assertEquals(out.kind, "clarify_caption");
});

// ── Client resolution failures ───────────────────────────────────────────────

Deno.test("handleTelegramAttachment: roster mismatch (needsVerification) → clarify_client, no upload", async () => {
  const deps = makeFakeDeps({
    driveFolders: [{ id: "c", name: "SAM CREDIT" }],
    resolveClient: async (raw) => ({
      matchedName: "",
      cgClientId: null,
      needsVerification: true,
      clarification: `I see "Samantha" and "Samuel" — which one for "${raw}"?`,
    }),
  });
  const out = await handleTelegramAttachment(basePhotoUpdate("Sam | Equifax | Round 2 response"), deps);
  assertEquals(out.kind, "clarify_client");
  if (out.kind === "clarify_client") {
    assert(out.reply.includes("Samantha"));
  }
  assertEquals(deps.uploads.length, 0);
});

// ── Drive folder errors ──────────────────────────────────────────────────────

Deno.test("handleTelegramAttachment: no CREDIT folder for client → drive_unconfigured reply", async () => {
  const deps = makeFakeDeps({ driveFolders: [] });
  const out = await handleTelegramAttachment(basePhotoUpdate("Ghost | Equifax | Round 1"), deps);
  assertEquals(out.kind, "drive_unconfigured");
  if (out.kind === "drive_unconfigured") {
    assert(out.reply.includes("CREDIT"));
  }
  assertEquals(deps.uploads.length, 0);
  assertEquals(deps.queued.length, 0);
});

// ── Upload + queue errors propagate as `error` outcome ───────────────────────

Deno.test("handleTelegramAttachment: drive upload throws → error outcome, no queue", async () => {
  const deps = makeFakeDeps({
    driveFolders: [
      { id: "c", name: "SAM CREDIT" },
      { id: "r", name: "responses", parentId: "c" },
    ],
    uploadErr: new Error("403 quota exceeded"),
  });
  const out = await handleTelegramAttachment(basePhotoUpdate("Sam | Equifax | Round 2 response"), deps);
  assertEquals(out.kind, "error");
  assertEquals(deps.queued.length, 0);
});

Deno.test("handleTelegramAttachment: queue throws → error outcome but Drive copy preserved", async () => {
  const deps = makeFakeDeps({
    driveFolders: [
      { id: "c", name: "SAM CREDIT" },
      { id: "r", name: "responses", parentId: "c" },
    ],
    queueErr: new Error("supabase 5xx"),
  });
  const out = await handleTelegramAttachment(basePhotoUpdate("Sam | Equifax | Round 2 response"), deps);
  assertEquals(out.kind, "error");
  if (out.kind === "error") {
    assert(out.reply.includes("Drive copy is safe"));
    assert(out.reply.includes("supabase 5xx"));
  }
  // Drive upload still happened.
  assertEquals(deps.uploads.length, 1);
});

// ── Correlation ID propagation ───────────────────────────────────────────────

Deno.test("handleTelegramAttachment: correlation_id is tg_<update_id>", async () => {
  const deps = makeFakeDeps({
    driveFolders: [
      { id: "c", name: "SAM CREDIT" },
      { id: "r", name: "responses", parentId: "c" },
    ],
  });
  const update = basePhotoUpdate("Sam | Equifax | Round 1 response");
  update.update_id = 555_123;
  const out = await handleTelegramAttachment(update, deps);
  if (out.kind !== "logged") throw new Error("expected logged");
  assertEquals(out.correlationId, "tg_555123");
  assertEquals(deps.queued[0].correlationId, "tg_555123");
});

// ── No attachment → no_attachment ────────────────────────────────────────────

Deno.test("handleTelegramAttachment: text-only update returns no_attachment, no side effects", async () => {
  const deps = makeFakeDeps({
    driveFolders: [{ id: "c", name: "SAM CREDIT" }],
  });
  const out = await handleTelegramAttachment(
    { update_id: 1, message: { message_id: 1 } },
    deps,
  );
  assertEquals(out.kind, "no_attachment");
  assertEquals(deps.uploads.length, 0);
  assertEquals(deps.queued.length, 0);
});

// ── Source-message auto-delete (operator decision: yes, only on confirmed success) ──

Deno.test("handleTelegramAttachment: success path → calls deleteSourceMessage with message_id", async () => {
  const deps = makeFakeDeps({
    driveFolders: [
      { id: "c", name: "SAM CREDIT" },
      { id: "r", name: "responses", parentId: "c" },
    ],
    deleteMode: "wired-success",
  });
  const out = await handleTelegramAttachment(basePhotoUpdate("Sam | Equifax | Round 2 response"), deps);
  if (out.kind !== "logged") throw new Error(`expected logged, got ${out.kind}`);
  assertEquals(out.sourceMessageDisposition, "deleted");
  assertEquals(deps.deleteCalls, [100]); // basePhotoUpdate's message_id
});

Deno.test("handleTelegramAttachment: deleteSourceMessage failure is non-fatal — outcome stays logged, disposition records the failure, warning logged", async () => {
  const deps = makeFakeDeps({
    driveFolders: [
      { id: "c", name: "SAM CREDIT" },
      { id: "r", name: "responses", parentId: "c" },
    ],
    deleteMode: "wired-fail",
  });
  const out = await handleTelegramAttachment(basePhotoUpdate("Sam | Equifax | Round 2 response"), deps);
  if (out.kind !== "logged") throw new Error(`expected logged, got ${out.kind}`);
  assertEquals(out.sourceMessageDisposition, "delete_failed");
  assertEquals(deps.deleteCalls, [100]);
  assertEquals(deps.uploads.length, 1);
  assertEquals(deps.queued.length, 1);
  assert(deps.warnings.some((w) => w.includes("source message delete failed")));
  // Operator-facing reply unchanged — the failure is invisible to them.
  assert(out.reply.includes("Logged for"));
  assert(!out.reply.includes("delete"));
});

Deno.test("handleTelegramAttachment: drive upload failure → does NOT call deleteSourceMessage", async () => {
  const deps = makeFakeDeps({
    driveFolders: [
      { id: "c", name: "SAM CREDIT" },
      { id: "r", name: "responses", parentId: "c" },
    ],
    uploadErr: new Error("403 quota exceeded"),
    deleteMode: "wired-success",
  });
  const out = await handleTelegramAttachment(basePhotoUpdate("Sam | Equifax | Round 2 response"), deps);
  assertEquals(out.kind, "error");
  assertEquals(deps.deleteCalls, []);
});

Deno.test("handleTelegramAttachment: queue insert failure → does NOT call deleteSourceMessage (operator can retry)", async () => {
  const deps = makeFakeDeps({
    driveFolders: [
      { id: "c", name: "SAM CREDIT" },
      { id: "r", name: "responses", parentId: "c" },
    ],
    queueErr: new Error("supabase 5xx"),
    deleteMode: "wired-success",
  });
  const out = await handleTelegramAttachment(basePhotoUpdate("Sam | Equifax | Round 2 response"), deps);
  assertEquals(out.kind, "error");
  assertEquals(deps.deleteCalls, []);
});

Deno.test("handleTelegramAttachment: deleteSourceMessage dep omitted (env flag off) → disposition='kept', no calls", async () => {
  const deps = makeFakeDeps({
    driveFolders: [
      { id: "c", name: "SAM CREDIT" },
      { id: "r", name: "responses", parentId: "c" },
    ],
    deleteMode: "not-wired",
  });
  const out = await handleTelegramAttachment(basePhotoUpdate("Sam | Equifax | Round 2 response"), deps);
  if (out.kind !== "logged") throw new Error("expected logged");
  assertEquals(out.sourceMessageDisposition, "kept");
  assertEquals(deps.deleteCalls, []);
});
