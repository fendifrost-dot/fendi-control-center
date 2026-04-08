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
