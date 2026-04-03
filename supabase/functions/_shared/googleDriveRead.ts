// supabase/functions/_shared/googleDriveRead.ts
// Google Drive READ operations with dual auth support:
// 1. Service account JWT auth (GOOGLE_SERVICE_ACCOUNT_JSON) â preferred
// 2. API key auth (Google_Cloud_Key) â fallback for link-shared files
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
  const apiKey =
    Deno.env.get("Google_Cloud_Key") || Deno.env.get("GOOGLE_API_KEY");
  if (apiKey) {
    resolvedApiKey = apiKey;
    resolvedAuthMode = "api_key";
    console.log(
      "[googleDriveRead] Using API key auth (service account not configured)"
    );
    return resolvedAuthMode;
  }

  throw new Error(
    "No Google Drive auth configured: set GOOGLE_SERVICE_ACCOUNT_JSON or Google_Cloud_Key"
  );
}

function base64url(input: string | Uint8Array): string {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  const bin = String.fromCharCode(...bytes);
  return btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemClean = pem
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/g, "")
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const der = Uint8Array.from(atob(pemClean), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function createSignedJwt(
  creds: ServiceAccountCredentials
): Promise<string> {
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
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );

  return signingInput + "." + base64url(new Uint8Array(signature));
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(
  creds: ServiceAccountCredentials
): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60000)
    return cachedToken.token;

  const jwt = await createSignedJwt(creds);
  const tokenUri = creds.token_uri || "https://oauth2.googleapis.com/token";
  const resp = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" +
      jwt,
  });

  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(
      "Google token exchange failed (" +
        resp.status +
        "): " +
        detail.slice(0, 300)
    );
  }
  const data = await resp.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
  return cachedToken.token;
}

function loadCredentials(): ServiceAccountCredentials {
  const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON secret is not set");
  const parsed = JSON.parse(raw);
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key"
    );
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    token_uri: parsed.token_uri || "https://oauth2.googleapis.com/token",
  };
}

async function driveApiFetch(url: string): Promise<Response> {
  const mode = detectAuthMode();
  if (mode === "service_account") {
    const creds = loadCredentials();
    const token = await getAccessToken(creds);
    return fetch(url, { headers: { Authorization: "Bearer " + token } });
  } else {
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

export async function searchFolders(nameQuery: string): Promise<DriveFile[]> {
  const q = `name contains '${nameQuery.replace(/'/g,"\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const url = DRIVE_API + "/files?q=" + encodeURIComponent(q) + "&fields=files(id,name,mimeType,modifiedTime)&pageSize=20&supportsAllDrives=true&includeItemsFromAllDrives=true";
  const resp = await driveApiFetch(url);
  if (!resp.ok) throw new Error("Drive folder search failed: " + resp.status);
  const data = await resp.json();
  return data.files || [];
}

export async function findFolderInParent(parentId: string, folderName: string): Promise<string | null> {
  const q = `'${parentId}' in parents and name = '${folderName.replace(/'/g,"\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const url = DRIVE_API + "/files?q=" + encodeURIComponent(q) + "&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true";
  const resp = await driveApiFetch(url);
  if (!resp.ok) throw new Error("Drive search failed: " + resp.status);
  const data = await resp.json();
  return data.files?.[0]?.id || null;
}

export async function listSubfolders(parentId: string): Promise<DriveFile[]> {
  const q = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const url = DRIVE_API + "/files?q=" + encodeURIComponent(q) + "&fields=files(id,name,mimeType,modifiedTime)&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true";
  const resp = await driveApiFetch(url);
  if (!resp.ok) throw new Error("Drive list subfolders failed: " + resp.status);
  const data = await resp.json();
  return data.files || [];
}

export async function listFilesInFolder(folderId: string): Promise<DriveFile[]> {
  const allFiles: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const q = `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`;
    let url = DRIVE_API + "/files?q=" + encodeURIComponent(q) + "&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime)&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true";
    if (pageToken) url += "&pageToken=" + pageToken;
    const resp = await driveApiFetch(url);
    if (!resp.ok) throw new Error("Drive list files failed: " + resp.status);
    const data = await resp.json();
    allFiles.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return allFiles;
}

export async function downloadFile(fileId: string, mimeType: string): Promise<{ base64: string; bytes: Uint8Array; downloadMime: string }> {
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
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    parts.push(String.fromCharCode.apply(null, Array.from(chunk)));
  }
  const base64 = btoa(parts.join(''));
  return { base64, bytes, downloadMime };
}

export async function findClientTaxFolder(clientName: string, taxYear: number): Promise<{ folderId: string; folderName: string } | null> {
  const nameUpper = clientName.toUpperCase().trim();
  const firstName = nameUpper.split(/\s+/)[0];
  const yearStr = String(taxYear);

  const rootFolderIdRaw = Deno.env.get("DRIVE_FOLDER_ID");
  const cleanRoot = rootFolderIdRaw
    ? rootFolderIdRaw.includes("/folders/")
      ? rootFolderIdRaw.split("/folders/").pop()!.split("?")[0]
      : rootFolderIdRaw
    : null;

  if (cleanRoot) {
    const candidateNames = [
      nameUpper + " " + yearStr + " TAXES",
      firstName + " " + yearStr + " TAXES",
      nameUpper + " TAXES " + yearStr,
      firstName + " TAXES " + yearStr,
      firstName + " TAXES",
      nameUpper + " TAXES",
    ];
    for (const candidate of candidateNames) {
      const found = await findFolderInParent(cleanRoot, candidate);
      if (found) {
        console.log("Found exact Drive folder: " + candidate);
        return { folderId: found, folderName: candidate };
      }
    }
    try {
      const subfolders = await listSubfolders(cleanRoot);
      for (const folder of subfolders) {
        const fu = folder.name.toUpperCase();
        if (fu.includes(firstName) && fu.includes(yearStr)) {
          console.log("Fuzzy matched Drive folder: " + folder.name);
          return { folderId: folder.id, folderName: folder.name };
        }
      }
      for (const folder of subfolders) {
        const fu = folder.name.toUpperCase();
        if (fu.includes(firstName) && fu.includes("TAX")) {
          const yf = await findFolderInParent(folder.id, yearStr);
          if (yf) {
            console.log("Found year subfolder inside " + folder.name);
            return { folderId: yf, folderName: folder.name + "/" + yearStr };
          }
          console.log("Using general tax folder: " + folder.name);
          return { folderId: folder.id, folderName: folder.name };
        }
      }
    } catch (e) { console.warn("Could not list subfolders: " + e); }
  } else {
    console.log("[googleDriveRead] DRIVE_FOLDER_ID not set - using global search");
  }

  const searchPatterns = [
    firstName + " " + yearStr + " TAXES",
    nameUpper + " " + yearStr + " TAXES",
    firstName + " " + yearStr,
    firstName + " TAXES",
  ];
  for (const pattern of searchPatterns) {
    try {
      const results = await searchFolders(pattern);
      for (const r of results) {
        const nu = r.name.toUpperCase();
        if ((nu.includes("TAX") && nu.includes(firstName)) || (nu.includes(yearStr) && nu.includes(firstName))) {
          console.log("Found folder via global search: " + r.name);
          return { folderId: r.id, folderName: r.name };
        }
      }
    } catch (e) { console.warn("Global search failed for '" + pattern + "': " + e); }
  }
  return null;
}
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

/**
 * Find a client's tax folder using fuzzy matching.
 * Tries multiple naming patterns: "SAM 2024 TAXES", "SAM TAXES", etc.
 * Returns the folder ID or null.
 */
export async function findClientTaxFolder(
  clientName: string,
  taxYear: number
): Promise<{ folderId: string; folderName: string } | null> {
  const rootFolderId = Deno.env.get("DRIVE_FOLDER_ID");
  if (!rootFolderId) throw new Error("DRIVE_FOLDER_ID is not set");
  const cleanRoot = rootFolderId.includes("/folders/")
    ? rootFolderId.split("/folders/").pop()!.split("?")[0]
    : rootFolderId;

  const nameUpper = clientName.toUpperCase().trim();
  const firstName = nameUpper.split(/\s+/)[0];
  const yearStr = String(taxYear);

  // Strategy 1: Try exact folder names
  const candidateNames = [
    nameUpper + " " + yearStr + " TAXES",
    firstName + " " + yearStr + " TAXES",
    nameUpper + " TAXES " + yearStr,
    firstName + " TAXES " + yearStr,
    firstName + " TAXES",
    nameUpper + " TAXES",
  ];

  for (const candidate of candidateNames) {
    const found = await findFolderInParent(cleanRoot, candidate);
    if (found) {
      console.log("Found exact Drive folder: " + candidate);
      return { folderId: found, folderName: candidate };
    }
  }

  // Strategy 2: List all subfolders and fuzzy match
  try {
    const subfolders = await listSubfolders(cleanRoot);
    for (const folder of subfolders) {
      const folderUpper = folder.name.toUpperCase();
      // Match folders containing both the first name and the year
      if (folderUpper.includes(firstName) && folderUpper.includes(yearStr)) {
        console.log("Fuzzy matched Drive folder: " + folder.name);
        return { folderId: folder.id, folderName: folder.name };
      }
    }
    // Also try folders containing first name and "TAX" without year (scan inside for year subfolder)
    for (const folder of subfolders) {
      const folderUpper = folder.name.toUpperCase();
      if (folderUpper.includes(firstName) && folderUpper.includes("TAX")) {
        // Check for year subfolder inside
        const yearFolder = await findFolderInParent(folder.id, yearStr);
        if (yearFolder) {
          console.log("Found year subfolder inside " + folder.name);
          return { folderId: yearFolder, folderName: folder.name + "/" + yearStr };
        }
        // If no year subfolder, use the main folder (files for all years)
        console.log("Using general tax folder: " + folder.name);
        return { folderId: folder.id, folderName: folder.name };
      }
    }
  } catch (listErr) {
    console.warn("Could not list subfolders for fuzzy match: " + listErr);
  }

  // Strategy 3: Global search
  const searchResults = await searchFolders(firstName + " " + yearStr);
  for (const result of searchResults) {
    const nameUp = result.name.toUpperCase();
    if (nameUp.includes("TAX") || nameUp.includes(yearStr)) {
      console.log("Found folder via global search: " + result.name);
      return { folderId: result.id, folderName: result.name };
    }
  }

  return null;
}
