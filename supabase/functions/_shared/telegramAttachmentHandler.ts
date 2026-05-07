/**
 * Telegram attachment intake — Phase 1 orchestrator (intake-streamlining-plan).
 *
 * Given a Telegram update that contains a photo or document plus a caption:
 *   1. Parse the caption (`<client> | <bureau> | <round?>`).
 *   2. Resolve the client against the Credit Guardian roster.
 *   3. Pick the canonical `<NAME> CREDIT/responses/` folder on Drive.
 *   4. Upload the attachment with the conventional filename, idempotent by name.
 *   5. Queue a structured event in `pending_guardian_events` (Guardian write API
 *      doesn't exist yet — roadmap A4 — this stub becomes the inbox the future
 *      API drains).
 *   6. Return the operator-facing reply text. (Caller dispatches it; this module
 *      stays I/O-narrow so the unit tests don't need a Telegram client.)
 *
 * I/O is fully injected via the `Deps` interface so handler tests can run with
 * pure in-memory fakes.
 */

import {
  clarificationMessageForFailure,
  parseAttachmentCaption,
  type ParsedAttachmentCaption,
} from "./telegramAttachmentCaption.ts";
import {
  buildResponseFileName,
  candidateClientFolderNames,
  extensionForMimeType,
  isoDateUTC,
  pickCanonicalCreditFolder,
  resolveResponsesFolder,
  type DriveFolderRef,
  type DriveSearchClient,
} from "./telegramAttachmentDriveTarget.ts";

/** Subset of the Telegram update shape this handler reads. */
export interface TelegramAttachmentUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    caption?: string;
    photo?: Array<{ file_id: string; file_unique_id: string; file_size?: number }>;
    document?: {
      file_id: string;
      file_unique_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
  };
}

export interface ResolvedAttachmentSource {
  fileId: string;
  fileUniqueId: string;
  /** Original file name (document only); photos are unnamed. */
  originalFileName?: string;
  mimeType?: string;
  /** "photo" or "document" — recorded on the queued event for later auditing. */
  source: "photo" | "document";
}

export interface DownloadedAttachment {
  bytes: Uint8Array;
  mimeType?: string;
  fileNameHint?: string;
}

export interface ClientResolution {
  /** Canonical client name (Credit Guardian display name). */
  matchedName: string;
  /** Credit Guardian client UUID, if known. */
  cgClientId: string | null;
  /** True when the resolver wants a clarification reply rather than a write. */
  needsVerification: boolean;
  /** Operator-facing message when verification is needed. */
  clarification?: string;
}

export interface DriveUploadResult {
  fileId: string;
  webViewLink?: string;
  /** True when the upload was a no-op because a same-named file already existed. */
  alreadyExisted: boolean;
}

export interface PendingGuardianEventInput {
  correlationId: string;
  client: string;
  cgClientId: string | null;
  bureau: string;
  bureauCanonical: string;
  round: number | null;
  eventType: "responses_received";
  driveFileId: string;
  drivePath: string;
  driveFileName: string;
  source: "photo" | "document";
  fileUniqueId: string;
  receivedAt: string;
  ocrText: null;
}

export interface AttachmentHandlerDeps {
  /** Resolve a Telegram file_id to its downloadable URL (uses Bot API getFile). */
  resolveTelegramFileUrl(fileId: string): Promise<string>;
  /** Download bytes from the resolved Telegram URL. */
  downloadFile(url: string): Promise<DownloadedAttachment>;
  /** Resolve the operator-supplied client name against the CG roster. */
  resolveClient(rawName: string): Promise<ClientResolution>;
  /** Drive operations (folder search + upload). */
  drive: DriveSearchClient & {
    /**
     * Upsert by name inside the folder: if a file with `fileName` already exists,
     * return its id with `alreadyExisted=true`; otherwise upload `bytes` and
     * return the new id.
     */
    upsertFile(args: {
      folderId: string;
      fileName: string;
      bytes: Uint8Array;
      mimeType: string;
    }): Promise<DriveUploadResult>;
  };
  /** Append the structured event to `pending_guardian_events` (or analogous). */
  queuePendingGuardianEvent(event: PendingGuardianEventInput): Promise<void>;
  /** Optional clock injection for deterministic filename in tests. */
  now?: () => Date;
  logger?: {
    info: (msg: string, ctx?: Record<string, unknown>) => void;
    warn: (msg: string, ctx?: Record<string, unknown>) => void;
    error: (msg: string, ctx?: Record<string, unknown>) => void;
  };
}

export type AttachmentHandlerOutcome =
  | { kind: "no_attachment" }
  | { kind: "clarify_caption"; reply: string; correlationId: string }
  | { kind: "clarify_client"; reply: string; correlationId: string }
  | { kind: "drive_unconfigured"; reply: string; correlationId: string; cause: string }
  | { kind: "error"; reply: string; correlationId: string; cause: string }
  | {
    kind: "logged";
    reply: string;
    correlationId: string;
    drivePath: string;
    driveFileName: string;
    driveFileId: string;
    alreadyExisted: boolean;
    parsed: ParsedAttachmentCaption;
    matchedClient: string;
  };

/** Detect a photo or document on the update; null otherwise. */
export function extractAttachmentSource(
  update: TelegramAttachmentUpdate,
): ResolvedAttachmentSource | null {
  const m = update.message;
  if (!m) return null;
  if (m.document?.file_id) {
    return {
      fileId: m.document.file_id,
      fileUniqueId: m.document.file_unique_id,
      originalFileName: m.document.file_name,
      mimeType: m.document.mime_type,
      source: "document",
    };
  }
  if (m.photo && m.photo.length > 0) {
    // Telegram returns multiple sizes — the last entry is the largest.
    const largest = m.photo[m.photo.length - 1];
    return {
      fileId: largest.file_id,
      fileUniqueId: largest.file_unique_id,
      mimeType: "image/jpeg",
      source: "photo",
    };
  }
  return null;
}

export async function handleTelegramAttachment(
  update: TelegramAttachmentUpdate,
  deps: AttachmentHandlerDeps,
): Promise<AttachmentHandlerOutcome> {
  const correlationId = `tg_${update.update_id}`;
  const log = deps.logger ?? {
    info: (m, c) => console.log(`[attachment] ${m}`, c ?? {}),
    warn: (m, c) => console.warn(`[attachment] ${m}`, c ?? {}),
    error: (m, c) => console.error(`[attachment] ${m}`, c ?? {}),
  };

  const attachment = extractAttachmentSource(update);
  if (!attachment) return { kind: "no_attachment" };

  const captionRaw = update.message?.caption;
  const parsed = parseAttachmentCaption(captionRaw);
  if (!parsed.ok) {
    const reply = clarificationMessageForFailure(parsed.reason, parsed.raw);
    log.info("caption parse failed", { correlationId, reason: parsed.reason });
    return { kind: "clarify_caption", reply, correlationId };
  }

  let resolution: ClientResolution;
  try {
    resolution = await deps.resolveClient(parsed.value.client);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    log.error("client resolution threw", { correlationId, cause });
    return {
      kind: "error",
      reply: `📎 I hit an error checking the client roster (${cause}). Please retry.`,
      correlationId,
      cause,
    };
  }

  if (resolution.needsVerification || !resolution.matchedName) {
    const reply = resolution.clarification ??
      `📎 I couldn't match "${parsed.value.client}" to a client. Please confirm the spelling.`;
    log.info("client needs clarification", { correlationId, raw: parsed.value.client });
    return { kind: "clarify_client", reply, correlationId };
  }

  let target;
  try {
    target = await resolveResponsesFolder(deps.drive, resolution.matchedName, log);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    log.error("drive folder resolution failed", { correlationId, cause });
    return {
      kind: "drive_unconfigured",
      reply:
        `📎 ${cause}\n\nFor "${resolution.matchedName}", expected one of: ` +
        candidateClientFolderNames(resolution.matchedName).join(", "),
      correlationId,
      cause,
    };
  }

  let downloadedBytes: Uint8Array;
  let downloadedMime: string | undefined;
  let downloadedNameHint: string | undefined;
  try {
    const url = await deps.resolveTelegramFileUrl(attachment.fileId);
    const dl = await deps.downloadFile(url);
    downloadedBytes = dl.bytes;
    downloadedMime = dl.mimeType ?? attachment.mimeType;
    downloadedNameHint = dl.fileNameHint ?? attachment.originalFileName;
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    log.error("download failed", { correlationId, cause });
    return {
      kind: "error",
      reply: `📎 Couldn't download the attachment from Telegram (${cause}). Please retry.`,
      correlationId,
      cause,
    };
  }

  const isoDate = isoDateUTC(deps.now ? deps.now() : new Date());
  const ext = pickExtension(attachment, downloadedMime, downloadedNameHint);
  const fileName = buildResponseFileName({
    isoDate,
    bureauCanonical: parsed.value.bureauCanonical,
    shortTag: parsed.value.shortTag,
    extension: ext,
  });
  const uploadMime = downloadedMime || attachment.mimeType || "application/octet-stream";

  let upload: DriveUploadResult;
  try {
    upload = await deps.drive.upsertFile({
      folderId: target.responsesFolderId,
      fileName,
      bytes: downloadedBytes,
      mimeType: uploadMime,
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    log.error("drive upload failed", { correlationId, cause, fileName });
    return {
      kind: "error",
      reply: `📎 Drive upload failed (${cause}). The attachment was NOT saved.`,
      correlationId,
      cause,
    };
  }

  const event: PendingGuardianEventInput = {
    correlationId,
    client: resolution.matchedName,
    cgClientId: resolution.cgClientId,
    bureau: parsed.value.bureau,
    bureauCanonical: parsed.value.bureauCanonical,
    round: parsed.value.round,
    eventType: "responses_received",
    driveFileId: upload.fileId,
    drivePath: target.drivePath,
    driveFileName: fileName,
    source: attachment.source,
    fileUniqueId: attachment.fileUniqueId,
    receivedAt: new Date().toISOString(),
    ocrText: null,
  };

  try {
    await deps.queuePendingGuardianEvent(event);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    log.error("queue pending_guardian_events failed", { correlationId, cause });
    return {
      kind: "error",
      reply:
        `📎 Saved to Drive (${target.drivePath}${fileName}), but failed to queue the Guardian event (${cause}). ` +
        `The Drive copy is safe.`,
      correlationId,
      cause,
    };
  }

  const roundDisplay = parsed.value.round != null ? ` / Round ${parsed.value.round}` : "";
  const dupeNote = upload.alreadyExisted ? " _(already on Drive — no duplicate created)_" : "";
  const reply =
    `📎 Logged for *${resolution.matchedName}* / ${parsed.value.bureau}${roundDisplay} — saved to ` +
    `\`${target.drivePath}${fileName}\`.${dupeNote}\n` +
    `Guardian event queued (pending API).`;

  log.info("attachment logged", {
    correlationId,
    client: resolution.matchedName,
    bureau: parsed.value.bureauCanonical,
    drivePath: target.drivePath + fileName,
    alreadyExisted: upload.alreadyExisted,
  });

  return {
    kind: "logged",
    reply,
    correlationId,
    drivePath: target.drivePath,
    driveFileName: fileName,
    driveFileId: upload.fileId,
    alreadyExisted: upload.alreadyExisted,
    parsed: parsed.value,
    matchedClient: resolution.matchedName,
  };
}

function pickExtension(
  attachment: ResolvedAttachmentSource,
  downloadedMime: string | undefined,
  downloadedNameHint: string | undefined,
): string {
  const nameSource = attachment.originalFileName ?? downloadedNameHint;
  if (nameSource) {
    const dot = nameSource.lastIndexOf(".");
    if (dot >= 0 && dot < nameSource.length - 1) {
      const candidate = nameSource.slice(dot + 1).toLowerCase();
      if (/^[a-z0-9]{1,8}$/.test(candidate)) return candidate;
    }
  }
  return extensionForMimeType(downloadedMime ?? attachment.mimeType);
}

// Re-export the picker so tests of the higher-level handler can build folder
// pick fixtures without importing two modules.
export { pickCanonicalCreditFolder, type DriveFolderRef };
