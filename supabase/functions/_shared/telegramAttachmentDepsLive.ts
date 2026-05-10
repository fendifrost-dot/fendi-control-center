/**
 * Live deps adapter for the Telegram attachment handler.
 *
 * Built as a separate file so the handler unit tests can stay pure (no Drive,
 * no Supabase, no Telegram). The `telegram-webhook` entry point composes this
 * adapter once per request.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createDriveFolder,
  getAccessToken,
  searchDriveFolder,
  uploadFileToDrive,
} from "./googleDriveUpload.ts";
import { resolveUnifiedClientFromName } from "./unifiedClientResolution.ts";
import type {
  AttachmentHandlerDeps,
  ClientResolution,
  DownloadedAttachment,
  DriveUploadResult,
  PendingGuardianEventInput,
} from "./telegramAttachmentHandler.ts";
import type { DriveFolderRef } from "./telegramAttachmentDriveTarget.ts";

export interface LiveDepsConfig {
  botToken: string;
  supabase: SupabaseClient;
  /** Override the table name — useful if the operator names it differently in Lovable. */
  pendingEventsTable?: string;
  /**
   * Telegram chat_id of the operator. Required to wire `deleteSourceMessage`,
   * which auto-deletes the operator's source message after a successful Drive
   * upload + queue insert (PII-on-Telegram mitigation, plan §"Risks worth naming").
   *
   * Behavior is controlled by the `TELEGRAM_AUTO_DELETE_AFTER_INGEST` env var
   * (default ON; set to "0", "false", or "off" to disable without redeploying).
   */
  chatId?: string;
  /** Test seam — override env-var lookup. Defaults to `Deno.env.get`. */
  envGet?: (name: string) => string | undefined;
}

export function buildLiveAttachmentDeps(cfg: LiveDepsConfig): AttachmentHandlerDeps {
  const { botToken, supabase } = cfg;
  const pendingEventsTable = cfg.pendingEventsTable ?? "pending_guardian_events";
  const envGet = cfg.envGet ?? ((n) => Deno.env.get(n));

  const drive = buildLiveDriveAdapter();
  const deleteSourceMessage = buildDeleteSourceMessage(botToken, cfg.chatId, envGet);

  const deps: AttachmentHandlerDeps = {
    resolveTelegramFileUrl: async (fileId) => resolveTelegramFileUrlLive(botToken, fileId),
    downloadFile: async (url) => downloadFileLive(url),
    resolveClient: async (rawName) => resolveClientLive(rawName),
    drive,
    queuePendingGuardianEvent: async (event) =>
      queuePendingGuardianEventLive(supabase, pendingEventsTable, event),
  };
  if (deleteSourceMessage) deps.deleteSourceMessage = deleteSourceMessage;
  return deps;
}

/**
 * Auto-delete is OFF when chat_id missing or env flag is "0"/"false"/"off"/"no".
 * Otherwise returns a closure that POSTs to Telegram `deleteMessage`. The
 * handler treats any throw as non-fatal (logs a warning, keeps the source
 * message visible, doesn't change the operator-facing reply).
 */
function buildDeleteSourceMessage(
  botToken: string,
  chatId: string | undefined,
  envGet: (name: string) => string | undefined,
): ((messageId: number) => Promise<void>) | undefined {
  if (!chatId) return undefined;
  const flag = (envGet("TELEGRAM_AUTO_DELETE_AFTER_INGEST") ?? "").trim().toLowerCase();
  const disabled = flag === "0" || flag === "false" || flag === "off" || flag === "no";
  if (disabled) return undefined;
  return async (messageId: number) => {
    const url = `https://api.telegram.org/bot${botToken}/deleteMessage`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
    if (!resp.ok) {
      throw new Error(`telegram deleteMessage ${resp.status}: ${await resp.text()}`);
    }
    const body = await resp.json() as { ok: boolean; description?: string };
    if (!body.ok) {
      throw new Error(`telegram deleteMessage not ok: ${body.description ?? "unknown"}`);
    }
  };
}

async function resolveTelegramFileUrlLive(botToken: string, fileId: string): Promise<string> {
  const url = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`telegram getFile ${resp.status}: ${await resp.text()}`);
  }
  const body = await resp.json() as { ok: boolean; result?: { file_path?: string } };
  if (!body.ok || !body.result?.file_path) {
    throw new Error(`telegram getFile returned no file_path: ${JSON.stringify(body)}`);
  }
  return `https://api.telegram.org/file/bot${botToken}/${body.result.file_path}`;
}

async function downloadFileLive(url: string): Promise<DownloadedAttachment> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`download ${resp.status}: ${await resp.text()}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  const mime = resp.headers.get("content-type") ?? undefined;
  return { bytes: buf, mimeType: mime };
}

async function resolveClientLive(rawName: string): Promise<ClientResolution> {
  const r = await resolveUnifiedClientFromName(rawName);
  return {
    matchedName: r.matchedName ?? "",
    cgClientId: r.clientId,
    needsVerification: r.needsVerification,
    clarification: r.message,
  };
}

function buildLiveDriveAdapter(): AttachmentHandlerDeps["drive"] {
  return {
    async searchFolders(name: string): Promise<DriveFolderRef[]> {
      const token = await getAccessToken();
      return await searchDriveFoldersWithMeta(token, name, undefined);
    },
    async searchChildFolders(parentId: string, name: string): Promise<DriveFolderRef[]> {
      const token = await getAccessToken();
      return await searchDriveFoldersWithMeta(token, name, parentId);
    },
    async createFolder(name: string, parentId: string): Promise<DriveFolderRef> {
      const token = await getAccessToken();
      const id = await createDriveFolder(token, name, parentId);
      return { id, name };
    },
    async upsertFile(args): Promise<DriveUploadResult> {
      const token = await getAccessToken();
      const existing = await findFileByNameInFolder(token, args.folderId, args.fileName);
      if (existing) return { fileId: existing, alreadyExisted: true };
      const created = await uploadFileToDrive(
        token,
        args.fileName,
        args.bytes,
        args.mimeType,
        args.folderId,
      );
      return { fileId: created.id, webViewLink: created.webViewLink, alreadyExisted: false };
    },
  };
}

/**
 * List ALL folder matches for a name (not just the first), with modifiedTime —
 * required for pipeline-standards Rule 3 canonicality picks.
 *
 * The shared `searchDriveFolder` returns only the first match; we need the full
 * list so the resolver can pick the most recently modified.
 */
async function searchDriveFoldersWithMeta(
  accessToken: string,
  folderName: string,
  parentId: string | undefined,
): Promise<DriveFolderRef[]> {
  const safeName = folderName.replace(/'/g, "\\'");
  let query = `name='${safeName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) query += ` and '${parentId}' in parents`;
  const url =
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}` +
    `&fields=files(id,name,modifiedTime)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=20`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) {
    console.error(`[attachment-deps-live] folder search failed: ${resp.status} ${await resp.text()}`);
    return [];
  }
  const data = await resp.json() as { files?: Array<{ id: string; name: string; modifiedTime?: string }> };
  return (data.files ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    modifiedTime: f.modifiedTime,
  }));
}

async function findFileByNameInFolder(
  accessToken: string,
  folderId: string,
  fileName: string,
): Promise<string | null> {
  const safeName = fileName.replace(/'/g, "\\'");
  const q =
    `name='${safeName}' and '${folderId}' in parents and ` +
    `mimeType!='application/vnd.google-apps.folder' and trashed=false`;
  const url =
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}` +
    `&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) return null;
  const data = await resp.json() as { files?: Array<{ id: string }> };
  return data.files?.[0]?.id ?? null;
}

async function queuePendingGuardianEventLive(
  supabase: SupabaseClient,
  table: string,
  event: PendingGuardianEventInput,
): Promise<void> {
  const row = {
    correlation_id: event.correlationId,
    client_name: event.client,
    cg_client_id: event.cgClientId,
    bureau: event.bureau,
    bureau_canonical: event.bureauCanonical,
    round: event.round,
    event_type: event.eventType,
    drive_file_id: event.driveFileId,
    drive_path: event.drivePath,
    drive_file_name: event.driveFileName,
    source: event.source,
    file_unique_id: event.fileUniqueId,
    received_at: event.receivedAt,
    ocr_text: event.ocrText,
    status: "pending",
  };
  const { error } = await supabase.from(table).insert(row);
  if (error) {
    // Unique-violation on (correlation_id, file_unique_id) is treated as a
    // benign duplicate — Telegram retried delivery, the event is already queued.
    if (error.code === "23505") return;
    throw new Error(`pending_guardian_events insert failed: ${error.message}`);
  }
}
