/**
 * Run: deno test supabase/functions/_shared/telegramAttachmentDriveTarget_test.ts --allow-env
 */
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.168.0/testing/asserts.ts";
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

Deno.test("pickCanonicalCreditFolder: empty → null", () => {
  assertEquals(pickCanonicalCreditFolder([]), null);
});

Deno.test("pickCanonicalCreditFolder: single match returns that folder, no dupes", () => {
  const r = pickCanonicalCreditFolder([
    { id: "a", name: "SAM CREDIT", modifiedTime: "2026-01-01T00:00:00Z" },
  ]);
  assertEquals(r?.chosen.id, "a");
  assertEquals(r?.duplicates.length, 0);
});

Deno.test("pickCanonicalCreditFolder: multiple → most recently modified wins, others as dupes", () => {
  const r = pickCanonicalCreditFolder([
    { id: "old", name: "SAM CREDIT", modifiedTime: "2025-01-01T00:00:00Z" },
    { id: "new", name: "SAM CREDIT", modifiedTime: "2026-04-01T00:00:00Z" },
    { id: "mid", name: "SAM CREDIT", modifiedTime: "2025-08-01T00:00:00Z" },
  ]);
  assertEquals(r?.chosen.id, "new");
  assertEquals(r?.duplicates.map((d) => d.id), ["mid", "old"]);
});

Deno.test("pickCanonicalCreditFolder: deterministic alphabetical tiebreak when modifiedTime equal", () => {
  const r = pickCanonicalCreditFolder([
    { id: "1", name: "SAM CREDIT b", modifiedTime: "2026-01-01T00:00:00Z" },
    { id: "2", name: "SAM CREDIT a", modifiedTime: "2026-01-01T00:00:00Z" },
  ]);
  assertEquals(r?.chosen.id, "2");
});

Deno.test("buildResponseFileName: full pattern with round", () => {
  const f = buildResponseFileName({
    isoDate: "2026-05-02",
    bureauCanonical: "equifax",
    shortTag: "r2-response",
    extension: "jpg",
  });
  assertEquals(f, "2026-05-02-equifax-r2-response.jpg");
});

Deno.test("buildResponseFileName: strips leading dot from extension and lowercases", () => {
  const f = buildResponseFileName({
    isoDate: "2026-05-02",
    bureauCanonical: "innovis",
    shortTag: "response",
    extension: ".PDF",
  });
  assertEquals(f, "2026-05-02-innovis-response.pdf");
});

Deno.test("isoDateUTC: returns YYYY-MM-DD", () => {
  const d = new Date(Date.UTC(2026, 4, 2, 13, 30));
  assertEquals(isoDateUTC(d), "2026-05-02");
});

Deno.test("candidateClientFolderNames: single-token name → just one variant", () => {
  assertEquals(candidateClientFolderNames("Sam"), ["SAM CREDIT"]);
});

Deno.test("candidateClientFolderNames: multi-token → full + first-token variants", () => {
  assertEquals(candidateClientFolderNames("Tara Wright"), [
    "TARA WRIGHT CREDIT",
    "TARA CREDIT",
  ]);
});

Deno.test("candidateClientFolderNames: empty → empty list", () => {
  assertEquals(candidateClientFolderNames("   "), []);
});

Deno.test("extensionForMimeType: known mime types", () => {
  assertEquals(extensionForMimeType("image/jpeg"), "jpg");
  assertEquals(extensionForMimeType("application/pdf"), "pdf");
  assertEquals(extensionForMimeType("image/png"), "png");
});

Deno.test("extensionForMimeType: unknown mime → fallback", () => {
  assertEquals(extensionForMimeType("application/x-weird"), "weird");
  assertEquals(extensionForMimeType(undefined), "bin");
});

// ── resolveResponsesFolder integration ───────────────────────────────────────

interface FakeDriveState {
  folders: Array<{ id: string; name: string; parentId?: string; modifiedTime?: string }>;
  createdNames: string[];
}

function makeFakeDrive(state: FakeDriveState): DriveSearchClient {
  return {
    async searchFolders(name: string) {
      return state.folders
        .filter((f) => !f.parentId && f.name === name)
        .map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
    },
    async searchChildFolders(parentId: string, name: string) {
      return state.folders
        .filter((f) => f.parentId === parentId && f.name === name)
        .map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
    },
    async createFolder(name: string, parentId: string) {
      const id = `gen-${state.folders.length + 1}`;
      state.folders.push({ id, name, parentId });
      state.createdNames.push(name);
      return { id, name };
    },
  };
}

Deno.test("resolveResponsesFolder: single match + existing responses subfolder", async () => {
  const state: FakeDriveState = {
    folders: [
      { id: "client-1", name: "SAM CREDIT", modifiedTime: "2026-04-01T00:00:00Z" },
      { id: "resp-1", name: "responses", parentId: "client-1" },
    ],
    createdNames: [],
  };
  const drive = makeFakeDrive(state);
  const r = await resolveResponsesFolder(drive, "Sam");
  assertEquals(r.responsesFolderId, "resp-1");
  assertEquals(r.drivePath, "SAM CREDIT/responses/");
  assertEquals(r.clientFolder.duplicates.length, 0);
  assertEquals(state.createdNames, []);
});

Deno.test("resolveResponsesFolder: full-name client matches longer folder", async () => {
  const state: FakeDriveState = {
    folders: [
      { id: "client-tw", name: "TARA WRIGHT CREDIT", modifiedTime: "2026-04-01T00:00:00Z" },
      { id: "resp-tw", name: "responses", parentId: "client-tw" },
    ],
    createdNames: [],
  };
  const drive = makeFakeDrive(state);
  const r = await resolveResponsesFolder(drive, "Tara Wright");
  assertEquals(r.clientFolder.chosen.name, "TARA WRIGHT CREDIT");
  assertEquals(r.responsesFolderId, "resp-tw");
});

Deno.test("resolveResponsesFolder: full-name falls back to first-token folder", async () => {
  const state: FakeDriveState = {
    folders: [
      { id: "client-tara", name: "TARA CREDIT", modifiedTime: "2026-04-01T00:00:00Z" },
      { id: "resp-tara", name: "responses", parentId: "client-tara" },
    ],
    createdNames: [],
  };
  const drive = makeFakeDrive(state);
  const r = await resolveResponsesFolder(drive, "Tara Wright");
  assertEquals(r.clientFolder.chosen.id, "client-tara");
  assertEquals(r.drivePath, "TARA CREDIT/responses/");
});

Deno.test("resolveResponsesFolder: creates `responses` subfolder when missing", async () => {
  const state: FakeDriveState = {
    folders: [{ id: "client-1", name: "SAM CREDIT" }],
    createdNames: [],
  };
  const drive = makeFakeDrive(state);
  const r = await resolveResponsesFolder(drive, "Sam");
  assertEquals(state.createdNames, ["responses"]);
  assertEquals(r.responsesFolderName, "responses");
});

Deno.test("resolveResponsesFolder: multiple client matches → uses most recently modified, warns", async () => {
  const warnings: string[] = [];
  const state: FakeDriveState = {
    folders: [
      { id: "old", name: "SAM CREDIT", modifiedTime: "2025-01-01T00:00:00Z" },
      { id: "new", name: "SAM CREDIT", modifiedTime: "2026-04-01T00:00:00Z" },
      { id: "resp-new", name: "responses", parentId: "new" },
    ],
    createdNames: [],
  };
  const drive = makeFakeDrive(state);
  const r = await resolveResponsesFolder(drive, "Sam", {
    warn: (m) => warnings.push(m),
  });
  assertEquals(r.clientFolder.chosen.id, "new");
  assertEquals(r.clientFolder.duplicates.length, 1);
  assertEquals(r.clientFolder.duplicates[0].id, "old");
  assert(warnings.some((w) => w.includes("multiple CREDIT folders")), "expected warning logged");
});

Deno.test("resolveResponsesFolder: dedup when both casings of subfolder exist (Test 3 pattern)", async () => {
  const warnings: string[] = [];
  const state: FakeDriveState = {
    folders: [
      { id: "client-1", name: "TARA WRIGHT CREDIT" },
      { id: "resp-lower", name: "responses", parentId: "client-1", modifiedTime: "2026-04-01T00:00:00Z" },
      { id: "resp-upper", name: "RESPONSES", parentId: "client-1", modifiedTime: "2025-04-01T00:00:00Z" },
    ],
    createdNames: [],
  };
  const drive = makeFakeDrive(state);
  const r = await resolveResponsesFolder(drive, "Tara Wright", { warn: (m) => warnings.push(m) });
  assertEquals(r.responsesFolderId, "resp-lower");
  assert(warnings.some((w) => w.includes("multiple \"responses\" subfolders")));
});

Deno.test("resolveResponsesFolder: throws when no CREDIT folder exists", async () => {
  const drive = makeFakeDrive({ folders: [], createdNames: [] });
  await assertRejects(
    () => resolveResponsesFolder(drive, "Ghost"),
    Error,
    "No <NAME> CREDIT folder",
  );
});
