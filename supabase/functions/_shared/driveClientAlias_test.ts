/**
 * Drive folder alias + closest-match hints for ingest.
 * Run: deno test supabase/functions/_shared/driveClientAlias_test.ts --allow-env
 */
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { resolveDriveIngestFilterKey, suggestClosestDriveFolderNames } from "./driveClientAlias.ts";

Deno.test("suggestClosestDriveFolderNames: ranks similar folder titles", () => {
  const sample = ["Zeus LLC", "Acme Corp", "Jabril Holdings"];
  const out = suggestClosestDriveFolderNames("Jabril", sample, 5);
  assertEquals(out.includes("Jabril Holdings"), true);
});

Deno.test("resolveDriveIngestFilterKey: alias map from env", () => {
  const key = "DRIVE_CLIENT_FOLDER_ALIASES_JSON";
  const prev = Deno.env.get(key);
  Deno.env.set(key, JSON.stringify({ jabril: "Zeus" }));
  try {
    const r = resolveDriveIngestFilterKey("Jabril");
    assertEquals(r.usedAlias, true);
    assertEquals(r.key, "zeus");
  } finally {
    if (prev === undefined) Deno.env.delete(key);
    else Deno.env.set(key, prev);
  }
});

Deno.test("resolveDriveIngestFilterKey: no alias — normalized key", () => {
  const r = resolveDriveIngestFilterKey("  Zeus  ");
  assertEquals(r.usedAlias, false);
  assertEquals(r.key, "zeus");
});
