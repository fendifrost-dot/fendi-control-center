/**
 * Drive folder name classification helpers.
 * Used by drive-sync and ingest-drive-clients to separate tax vs credit workspaces.
 */

const TAX_RE = /\bTAXES?\b/i;
const CREDIT_RE = /\bCREDIT\b/i;

/** Returns true when a folder name contains BOTH tax and credit keywords — skip until renamed. */
export function isAmbiguousCreditTaxFolderName(name: string): boolean {
  return TAX_RE.test(name) && CREDIT_RE.test(name);
}

/** Returns true when the folder name looks like a tax workspace (contains "TAX" or "TAXES"). */
export function isTaxWorkspaceFolderName(name: string): boolean {
  return TAX_RE.test(name);
}

/** Returns true when the folder name looks like a credit workspace (contains "CREDIT"). */
export function isCreditWorkspaceFolderName(name: string): boolean {
  return CREDIT_RE.test(name);
}

/**
 * When the configured Drive root is *only* the credit workspace (every subfolder is a client),
 * subfolder names are often just the person's name (e.g. "Zeus", "Jabril") — they do NOT
 * contain the word "CREDIT". In that case pass dedicatedCreditRoot=true so we still ingest.
 * Mixed tax+credit roots should keep dedicatedCreditRoot=false and use "Name CREDIT" subfolders.
 */
export function shouldIngestCreditSubfolder(
  name: string,
  opts: { dedicatedCreditRoot: boolean },
): boolean {
  if (isAmbiguousCreditTaxFolderName(name)) return false;
  if (opts.dedicatedCreditRoot) {
    return !isTaxWorkspaceFolderName(name);
  }
  return isCreditWorkspaceFolderName(name);
}
