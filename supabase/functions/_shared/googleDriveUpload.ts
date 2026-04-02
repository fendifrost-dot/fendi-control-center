// supabase/functions/_shared/googleDriveUpload.ts
// Google Drive upload using service account JWT auth.

interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
  token_uri: string;
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
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

async function createSignedJwt(creds: ServiceAccountCredentials): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/drive",
    aud: creds.token_uri || "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  };
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = headerB64 + "." + payloadB64;
  const key = await importPrivateKey(creds.private_key);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
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
  if (!resp.ok) { const detail = await resp.text(); throw new Error("Google token exchange failed (" + resp.status + "): " + detail.slice(0, 300)); }
  const data = await resp.json();
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

function loadCredentials(): ServiceAccountCredentials {
  const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON secret is not set");
  const parsed = JSON.parse(raw);
  if (!parsed.client_email || !parsed.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key");
  return { client_email: parsed.client_email, private_key: parsed.private_key, token_uri: parsed.token_uri || "https://oauth2.googleapis.com/token" };
}

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

export async function findFolder(parentId: string, folderName: string): Promise<string | null> {
  const creds = loadCredentials();
  const token = await getAccessToken(creds);
  const q = "'" + parentId + "' in parents and name = '" + folderName + "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
  const url = DRIVE_API + "/files?q=" + encodeURIComponent(q) + "&fields=files(id,name)";
  const resp = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  if (!resp.ok) throw new Error("Drive search failed: " + resp.status);
  const data = await resp.json();
  return data.files?.[0]?.id || null;
}

export async function createDriveFolder(parentFolderId: string, folderName: string): Promise<string> {
  const creds = loadCredentials();
  const token = await getAccessToken(creds);
  const existing = await findFolder(parentFolderId, folderName);
  if (existing) return existing;
  const resp = await fetch(DRIVE_API + "/files", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ name: folderName, mimeType: "application/vnd.google-apps.folder", parents: [parentFolderId] }),
  });
  if (!resp.ok) { const detail = await resp.text(); throw new Error("Failed to create Drive folder (" + resp.status + "): " + detail.slice(0, 300)); }
  const data = await resp.json();
  return data.id;
}

export async function uploadToDrive(
  folderId: string, fileName: string, fileBytes: Uint8Array, mimeType = "application/pdf"
): Promise<{ fileId: string; webViewLink: string }> {
  const creds = loadCredentials();
  const token = await getAccessToken(creds);
  const metadata = JSON.stringify({ name: fileName, parents: [folderId] });
  const boundary = "----FormBoundary" + Date.now();
  const bodyParts = [
    "--" + boundary + "\r\n",
    "Content-Type: application/json; charset=UTF-8\r\n\r\n",
    metadata,
    "\r\n--" + boundary + "\r\n",
    "Content-Type: " + mimeType + "\r\n",
    "Content-Transfer-Encoding: binary\r\n\r\n",
  ].join("");
  const bodyEnd = "\r\n--" + boundary + "--";
  const enc = new TextEncoder();
  const bodyStart = enc.encode(bodyParts);
  const bodyEndBytes = enc.encode(bodyEnd);
  const fullBody = new Uint8Array(bodyStart.length + fileBytes.length + bodyEndBytes.length);
  fullBody.set(bodyStart, 0);
  fullBody.set(fileBytes, bodyStart.length);
  fullBody.set(bodyEndBytes, bodyStart.length + fileBytes.length);
  const resp = await fetch(
    UPLOAD_API + "/files?uploadType=multipart&fields=id,webViewLink",
    { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "multipart/related; boundary=" + boundary }, body: fullBody }
  );
  if (!resp.ok) { const detail = await resp.text(); throw new Error("Drive upload failed (" + resp.status + "): " + detail.slice(0, 300)); }
  const data = await resp.json();
  return { fileId: data.id, webViewLink: data.webViewLink || "https://drive.google.com/file/d/" + data.id + "/view" };
}

export async function getOrCreateClientTaxFolder(
  clientName: string, year: number
): Promise<{ folderId: string; folderUrl: string }> {
  const rootFolderId = Deno.env.get("DRIVE_FOLDER_ID");
  if (!rootFolderId) throw new Error("DRIVE_FOLDER_ID is not set");
  const cleanRoot = rootFolderId.includes("/folders/")
    ? rootFolderId.split("/folders/").pop()!.split("?")[0]
    : rootFolderId;
  const taxReturnsFolder = await createDriveFolder(cleanRoot, "Tax Returns");
  const clientFolder = await createDriveFolder(taxReturnsFolder, clientName);
  const yearFolder = await createDriveFolder(clientFolder, String(year));
  return { folderId: yearFolder, folderUrl: "https://drive.google.com/drive/folders/" + yearFolder };
}
