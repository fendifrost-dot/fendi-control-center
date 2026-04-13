import type { SupabaseClient } from "@supabase/supabase-js";

const BUCKET = "tax-source-documents";

/** Recursively list file paths under prefix, then remove in batches. */
export async function removeClientTaxSourceFiles(
  supabase: SupabaseClient,
  clientId: string,
): Promise<void> {
  const storage = supabase.storage.from(BUCKET);
  const filePaths: string[] = [];

  async function walk(dir: string): Promise<void> {
    const { data, error } = await storage.list(dir, { limit: 1000 });
    if (error || !data?.length) return;
    for (const item of data) {
      const rel = dir ? `${dir}/${item.name}` : item.name;
      if (item.metadata && Object.keys(item.metadata).length > 0) {
        filePaths.push(rel);
      } else {
        await walk(rel);
      }
    }
  }

  await walk(clientId);
  const batch = 100;
  for (let i = 0; i < filePaths.length; i += batch) {
    const slice = filePaths.slice(i, i + batch);
    const { error } = await storage.remove(slice);
    if (error) throw error;
  }
}
