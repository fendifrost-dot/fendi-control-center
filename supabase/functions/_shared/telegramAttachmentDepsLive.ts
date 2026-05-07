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
}

export function buildLiveAttachmentDeps(cfg: LiveDepsConfig): AttachmentHandlerDeps {
  const { botToken, supabase } = cfg;
  const pendingEventsTable = cfg.pendingEventsTable ?? "pending_guardian_events";

  const drive = buildLiveDriveAdapter();

  return {
    resolveTelegramFileUrl: async (fileId) => resolveTelegramFileUrlLive(botToken, fileId),
    downloadFile: async (url) => downloadFileLive(url),
    resolveClient: async (rawName) => resolveClientLive(rawName),
    drive,
    queuePendingGuardianEvent: async (event) =>
      queuePendingGuardianEventLive(supabase, pendingEventsTable, event),
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
