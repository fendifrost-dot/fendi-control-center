// supabase/functions/_shared/googleDriveRead.ts
// Google Drive READ operations with dual auth support:
//   1. Service account JWT auth (GOOGLE_SERVICE_ACCOUNT_JSON) — preferred
//   2. API key auth (Google_Cloud_Key) — fallback for link-shared files
// Downloads files, lists folder contents, searches for folders by name.

interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
  token_uri: string;
}

// Auth mode: "service_account" uses Bearer token, "api_key" appends key= param
type AuthMode = "service_account" | "api_key";

let resolvedAuthMode: AuthMode | null = null;
let resolvedApiKey: string | null = null;

function detectAuthMode(): AuthMode {
  if (resolvedAuthMode) return resolvedAuthMode;
  const saJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (saJson) {
    try {
      const parsed = JSON.parse(saJson);
      if (parsed.client_email && parsed.private_key) {
        resolvedAuthMode = "service_account";
        return resolvedAuthMode;
      }
    } catch { /* fall through to API key */ }
  }
  // Fallback: try API key (check multiple env var names)
  const apiKey = Deno.env.get("Google_Cloud_Key") || Deno.env.get("GOOGLE_API_KEY");
  if (apiKey) {
    resolvedApiKey = apiKey;
    resolvedAuthMode = "api_key";
    console.log("[googleDriveRead] Using API key auth (service account not configured)");
    return resolvedAuthMode;
  }
  throw new Error("No Google Drive auth configured: set GOOGLE_SERVICE_ACCOUNT_JSON or Google_Cloud_Key");
}

function base64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const bin = String.fromCharCode(...bytes);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemClean = pem
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/g, "")
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const der = Uint8Array.from(atob(pemClean), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8", der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );
}

async function createSignedJwt(creds: ServiceAccountCredentials): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: creds.token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = headerB64 + "." + payloadB64;
  const key = await importPrivateKey(creds.private_key);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key,
    new TextEncoder().encode(signingInput)
  );
  return signingInput + "." + base64url(new Uint8Array(signature));
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(creds: ServiceAccountCredentials): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60000) return cachedToken.token;
  const jwt = await createSignedJwt(creds);
  const tokenUri = creds.token_uri || "https://oauth2.googleapis.com/token";
  const resp = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + jwt,
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error("Google token exchange failed (" + resp.status + "): " + detail.slice(0, 300));
  }
  const data = await resp.json();
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

function loadCredentials(): ServiceAccountCredentials {
  const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON secret is not set");
  const parsed = JSON.parse(raw);
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key");
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    token_uri: parsed.token_uri || "https://oauth2.googleapis.com/token",
  };
}

/**
 * Make an authenticated Drive API request. Uses service account Bearer token
 * if available, otherwise falls back to API key param.
 */
async function driveApiFetch(url: string): Promise<Response> {
  const mode = detectAuthMode();
  if (mode === "service_account") {
    const creds = loadCredentials();
    const token = await getAccessToken(creds);
    return fetch(url, { headers: { Authorization: "Bearer " + token } });
  } else {
    // API key mode: append key= parameter
    const separator = url.includes("?") ? "&" : "?";
    return fetch(url + separator + "key=" + resolvedApiKey);
  }
}

const DRIVE_API = "https://www.googleapis.com/drive/v3";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
}

/** Search for folders matching a name pattern. */
export async function searchFolders(nameQuery: string): Promise<DriveFile[]> {
  const q = `name contains '${nameQuery.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const url = DRIVE_API + "/files?q=" + encodeURIComponent(q) + "&fields=files(id,name,mimeType,modifiedTime)&pageSize=20";
  const resp = await driveApiFetch(url);
  if (!resp.ok) throw new Error("Drive folder search failed: " + resp.status);
  const data = await resp.json();
  return data.files || [];
}

/** Find a specific folder by exact name within a parent folder. */
export async function findFolderInParent(parentId: string, folderName: string): Promise<string | null> {
  const q = `'${parentId}' in parents and name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const url = DRIVE_API + "/files?q=" + encodeURIComponent(q) + "&fields=files(id,name)";
  const resp = await driveApiFetch(url);
  if (!resp.ok) throw new Error("Drive search failed: " + resp.status);
  const data = await resp.json();
  return data.files?.[0]?.id || null;
}

/** List all subfolders in a parent. */
export async function listSubfolders(parentId: string): Promise<DriveFile[]> {
  const q = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const url = DRIVE_API + "/files?q=" + encodeURIComponent(q) + "&fields=files(id,name,mimeType,modifiedTime)&pageSize=100";
  const resp = await driveApiFetch(url);
  if (!resp.ok) throw new Error("Drive list subfolders failed: " + resp.status);
  const data = await resp.json();
  return data.files || [];
}

/** List all files (non-folders) in a folder. Handles pagination. */
export async function listFilesInFolder(folderId: string): Promise<DriveFile[]> {
  const allFiles: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const q = `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`;
    let url = DRIVE_API + "/files?q=" + encodeURIComponent(q) +
      "&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime)&pageSize=100";
    if (pageToken) url += "&pageToken=" + pageToken;

    const resp = await driveApiFetch(url);
    if (!resp.ok) throw new Error("Drive list files failed: " + resp.status);
    const data = await resp.json();
    allFiles.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return allFiles;
}

/** Download a file's content as base64 and raw bytes. Handles Google Docs export. */
export async function downloadFile(fileId: string, mimeType: string): Promise<{
  base64: string;
  bytes: Uint8Array;
  downloadMime: string;
}> {
  const isGoogleDoc = mimeType.startsWith("application/vnd.google-apps.");
  let url: string;
  let downloadMime: string;

  if (mimeType === "application/vnd.google-apps.document") {
    url = DRIVE_API + "/files/" + fileId + "/export?mimeType=application/pdf";
    downloadMime = "application/pdf";
  } else if (mimeType === "application/vnd.google-apps.spreadsheet") {
    url = DRIVE_API + "/files/" + fileId + "/export?mimeType=text/csv";
    downloadMime = "text/csv";
  } else if (isGoogleDoc) {
    url = DRIVE_API + "/files/" + fileId + "/export?mimeType=application/pdf";
    downloadMime = "application/pdf";
  } else {
    url = DRIVE_API + "/files/" + fileId + "?alt=media";
    downloadMime = mimeType;
  }

  const resp = await driveApiFetch(url);
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error("Drive download failed (" + resp.status + "): " + detail.slice(0, 300));
  }

  const buffer = await resp.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const base64 = btoa(String.fromCharCode(...bytes));

  return { base64, bytes, downloadMime };
}

export async function findClientTaxFolder(
  clientName: string,
  taxYear: number
): Promise<{ folderId: string; folderName: string } | null> {
  const nameUpper = clientName.toUpperCase().trim();
  const firstName = nameUpper.split(/\s+/)[0];
  const yearStr = String(taxYear);

  // Determine if we have a root folder ID (optional — works without it)
  const rawRootId = Deno.env.get("DRIVE_FOLDER_ID");
  const cleanRoot = rawRootId
    ? (rawRootId.includes("/folders/")
        ? rawRootId.split("/folders/").pop()!.split("?")[0]
        : rawRootId)
    : null;

  // Strategy 1: Try exact folder names within root (if root is set)
  if (cleanRoot) {
    // Year-specific patterns first (higher priority)
    const yearSpecificNames = [
      nameUpper + " " + yearStr + " TAXES",
      firstName + " " + yearStr + " TAXES",
      nameUpper + " TAXES " + yearStr,
      firstName + " TAXES " + yearStr,
    ];
    // General patterns last (lower priority)
    const generalNames = [
      firstName + " TAXES",
      nameUpper + " TAXES",
    ];

    // Try year-specific exact matches first
    for (const candidate of yearSpecificNames) {
      const found = await findFolderInParent(cleanRoot, candidate);
      if (found) {
        console.log("Found year-specific Drive folder: " + candidate);
        return { folderId: found, folderName: candidate };
      }
    }

    // Strategy 2: List all subfolders and fuzzy match
    try {
      const subfolders = await listSubfolders(cleanRoot);

      // Pass 1: folders matching firstName AND year (best match)
      for (const folder of subfolders) {
        const folderUpper = folder.name.toUpperCase();
        if (folderUpper.includes(firstName) && folderUpper.includes(yearStr)) {
          console.log("Fuzzy matched year-specific Drive folder: " + folder.name);
          return { folderId: folder.id, folderName: folder.name };
        }
      }

      // Pass 2: folders matching firstName+TAX but NOT year — always check for year subfolders
      for (const folder of subfolders) {
        const folderUpper = folder.name.toUpperCase();
        if (folderUpper.includes(firstName) && folderUpper.includes("TAX") && !folderUpper.includes(yearStr)) {
          // Look for year subfolder inside this general tax folder
          const yearFolder = await findFolderInParent(folder.id, yearStr);
          if (yearFolder) {
            console.log("Found year subfolder " + yearStr + " inside " + folder.name);
            return { folderId: yearFolder, folderName: folder.name + "/" + yearStr };
          }
          // Also check for year-specific subfolders like "SAM 2022 TAXES"
          try {
            const innerFolders = await listSubfolders(folder.id);
            for (const inner of innerFolders) {
              const innerUpper = inner.name.toUpperCase();
              if (innerUpper.includes(yearStr)) {
                console.log("Found year-specific subfolder: " + inner.name + " inside " + folder.name);
                return { folderId: inner.id, folderName: folder.name + "/" + inner.name };
              }
            }
          } catch (innerErr) {
            console.warn("Could not list inner subfolders: " + innerErr);
          }
          // No year subfolder found — fall back to general folder as last resort
          console.log("No year subfolder found, using general tax folder: " + folder.name);
          return { folderId: folder.id, folderName: folder.name };
        }
      }

      // Pass 3: Try exact match on general names (no year) and drill into year subfolders
      for (const candidate of generalNames) {
        const found = await findFolderInParent(cleanRoot, candidate);
        if (found) {
          const yearFolder = await findFolderInParent(found, yearStr);
          if (yearFolder) {
            console.log("Found year subfolder " + yearStr + " inside exact match " + candidate);
            return { folderId: yearFolder, folderName: candidate + "/" + yearStr };
          }
          // Check for year-named subfolders
          try {
            const innerFolders = await listSubfolders(found);
            for (const inner of innerFolders) {
              if (inner.name.toUpperCase().includes(yearStr)) {
                console.log("Found year subfolder: " + inner.name + " inside " + candidate);
                return { folderId: inner.id, folderName: candidate + "/" + inner.name };
              }
            }
          } catch (innerErr) {
            console.warn("Could not list subfolders of " + candidate + ": " + innerErr);
          }
          console.log("No year subfolder, using general folder: " + candidate);
          return { folderId: found, folderName: candidate };
        }
      }
    } catch (listErr) {
      console.warn("Could not list subfolders for fuzzy match: " + listErr);
    }
  } else {
    console.log("[findClientTaxFolder] DRIVE_FOLDER_ID not set — using global search only");
  }

  // Strategy 3: Global Drive API search (works without DRIVE_FOLDER_ID)
  const globalQueries = [
    firstName + " " + yearStr + " TAXES",
    nameUpper + " " + yearStr,
    firstName + " TAXES",
  ];

  for (const query of globalQueries) {
    const searchResults = await searchFolders(query);
    // Prefer year-specific matches first
    for (const result of searchResults) {
      const nameUp = result.name.toUpperCase();
      if (nameUp.includes(firstName) && nameUp.includes(yearStr)) {
        console.log("Found year-specific folder via global search: " + result.name);
        return { folderId: result.id, folderName: result.name };
      }
    }
    // Then check general tax folders for year subfolders
    for (const result of searchResults) {
      const nameUp = result.name.toUpperCase();
      if (nameUp.includes(firstName) && nameUp.includes("TAX") && !nameUp.includes(yearStr)) {
        const yearFolder = await findFolderInParent(result.id, yearStr);
        if (yearFolder) {
          console.log("Found year subfolder " + yearStr + " inside global match " + result.name);
          return { folderId: yearFolder, folderName: result.name + "/" + yearStr };
        }
        try {
          const innerFolders = await listSubfolders(result.id);
          for (const inner of innerFolders) {
            if (inner.name.toUpperCase().includes(yearStr)) {
              console.log("Found year subfolder: " + inner.name + " via global search in " + result.name);
              return { folderId: inner.id, folderName: result.name + "/" + inner.name };
            }
          }
        } catch (_) { /* ignore */ }
        console.log("No year subfolder, using global match: " + result.name);
        return { folderId: result.id, folderName: result.name };
      }
    }
  }

  return null;
}
