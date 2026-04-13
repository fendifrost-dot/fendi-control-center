// supabase/functions/_shared/googleDriveUpload.ts
// Google Drive integration for tax document uploads

function base64UrlEncode(data: Uint8Array): string {
  const binString = Array.from(data, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binString).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function textToBase64Url(text: string): string {
  return base64UrlEncode(new TextEncoder().encode(text));
}

async function importRsaKey(pem: string): Promise<CryptoKey> {
  const pemContents = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function createSignedJwt(
  serviceAccount: { client_email: string; private_key: string },
  scopes: string[]
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccount.client_email,
    scope: scopes.join(" "),
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const encodedHeader = textToBase64Url(JSON.stringify(header));
  const encodedPayload = textToBase64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await importRsaKey(serviceAccount.private_key);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );

  const encodedSignature = base64UrlEncode(new Uint8Array(signature));
  return `${signingInput}.${encodedSignature}`;
}

export async function getAccessToken(): Promise<string> {
  const serviceAccountJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!serviceAccountJson) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON environment variable is not set");
  }
  const serviceAccount = JSON.parse(serviceAccountJson);

  const jwt = await createSignedJwt(serviceAccount, [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/drive.file",
  ]);

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get access token: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return data.access_token;
}

export async function searchDriveFolder(
  accessToken: string,
  folderName: string,
  parentId?: string
): Promise<string | null> {
  let query = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) {
    query += ` and '${parentId}' in parents`;
  }

  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    console.error(`Drive search failed: ${response.status} ${await response.text()}`);
    return null;
  }

  const data = await response.json();
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

export async function createDriveFolder(
  accessToken: string,
  folderName: string,
  parentId?: string
): Promise<string> {
  const metadata: Record<string, unknown> = {
    name: folderName,
    mimeType: "application/vnd.google-apps.folder",
  };
  if (parentId) {
    metadata.parents = [parentId];
  }

  const response = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(metadata),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create folder '${folderName}': ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return data.id;
}

export async function uploadFileToDrive(
  accessToken: string,
  fileName: string,
  fileContent: Uint8Array,
  mimeType: string,
  folderId: string
): Promise<{ id: string; name: string; webViewLink?: string }> {
  const metadata = {
    name: fileName,
    parents: [folderId],
  };

  const boundary = "-------boundary" + Date.now();
  const metadataStr = JSON.stringify(metadata);

  // Build multipart body
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];

  const metaPart = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataStr}\r\n`
  );
  const filePart = encoder.encode(
    `--${boundary}\r\nContent-Type: ${mimeType}\r\nContent-Transfer-Encoding: binary\r\n\r\n`
  );
  const endPart = encoder.encode(`\r\n--${boundary}--`);

  // Combine all parts
  const totalLength = metaPart.length + filePart.length + fileContent.length + endPart.length;
  const body = new Uint8Array(totalLength);
  let offset = 0;
  body.set(metaPart, offset); offset += metaPart.length;
  body.set(filePart, offset); offset += filePart.length;
  body.set(fileContent, offset); offset += fileContent.length;
  body.set(endPart, offset);

  const response = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to upload file '${fileName}': ${response.status} ${errorText}`);
  }

  return await response.json();
}

/** Resolve client tax folder (by token). Used by Drive helpers and overload below. */
export async function getOrCreateClientTaxFolderWithToken(
  accessToken: string,
  clientName: string,
  year: number | string,
): Promise<string> {
  const name = clientName.toUpperCase().trim();
  const yr = String(year);

  // 1. Search for "{NAME} {YEAR} TAXES" (exact match - user's naming convention)
  const exactFolderName = `${name} ${yr} TAXES`;
  console.log(`Searching for folder: "${exactFolderName}"`);
  const exactId = await searchDriveFolder(accessToken, exactFolderName);
  if (exactId) {
    console.log(`Found exact folder: "${exactFolderName}" (${exactId})`);
    return exactId;
  }

  // 2. Search for "{NAME} TAXES" as a parent folder, then look for year subfolder
  const parentFolderName = `${name} TAXES`;
  console.log(`Searching for parent folder: "${parentFolderName}"`);
  const parentId = await searchDriveFolder(accessToken, parentFolderName);
  if (parentId) {
    console.log(`Found parent folder: "${parentFolderName}" (${parentId})`);
    // Check if year subfolder exists inside
    const yearSubId = await searchDriveFolder(accessToken, yr, parentId);
    if (yearSubId) {
      console.log(`Found year subfolder: "${yr}" inside "${parentFolderName}" (${yearSubId})`);
      return yearSubId;
    }
    // Create year subfolder inside parent
    console.log(`Creating year subfolder "${yr}" inside "${parentFolderName}"`);
    const newSubId = await createDriveFolder(accessToken, yr, parentId);
    console.log(`Created year subfolder (${newSubId})`);
    return newSubId;
  }

  // 3. Create new "{NAME} {YEAR} TAXES" folder at root
  console.log(`Creating new folder: "${exactFolderName}"`);
  const newFolderId = await createDriveFolder(accessToken, exactFolderName);
  console.log(`Created folder: "${exactFolderName}" (${newFolderId})`);
  return newFolderId;
}

/** 3-arg: existing callers (accessToken, clientName, year) → folder id. */
export async function getOrCreateClientTaxFolder(
  accessToken: string,
  clientName: string,
  year: number | string,
): Promise<string>;

/** 2-arg: Control Hub fill-tax-forms bundle — obtains token, returns id + folder URL. */
export async function getOrCreateClientTaxFolder(
  clientName: string,
  year: number | string,
): Promise<{ folderId: string; folderUrl: string }>;

export async function getOrCreateClientTaxFolder(
  arg1: string,
  arg2: string | number,
  arg3?: number | string,
): Promise<string | { folderId: string; folderUrl: string }> {
  if (arg3 !== undefined) {
    return getOrCreateClientTaxFolderWithToken(arg1, String(arg2), arg3);
  }
  const accessToken = await getAccessToken();
  const folderId = await getOrCreateClientTaxFolderWithToken(accessToken, arg1, arg2);
  return {
    folderId,
    folderUrl: `https://drive.google.com/drive/folders/${folderId}`,
  };
}

/** Control Hub fill-tax-forms: upload PDF bytes into a folder (gets token internally). */
export async function uploadToDrive(
  folderId: string,
  fileName: string,
  fileContent: Uint8Array,
): Promise<{ fileId: string; webViewLink?: string }> {
  const accessToken = await getAccessToken();
  const r = await uploadFileToDrive(accessToken, fileName, fileContent, "application/pdf", folderId);
  return { fileId: r.id, webViewLink: r.webViewLink };
}

/** OAuth access token from a raw service-account JSON string (same scopes as getAccessToken). */
export async function getDriveAccessTokenFromJson(serviceAccountJson: string): Promise<string> {
  const serviceAccount = JSON.parse(serviceAccountJson);
  const jwt = await createSignedJwt(serviceAccount, [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/drive.file",
  ]);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get access token: ${response.status} ${errorText}`);
  }
  const data = await response.json();
  return data.access_token as string;
}

/** Ensure a subfolder for the tax year exists under the client’s Drive folder. */
export async function ensureClientTaxReturnsYearFolder(
  accessToken: string,
  clientFolderId: string,
  taxYear: number,
): Promise<string> {
  const yr = String(taxYear);
  const existing = await searchDriveFolder(accessToken, yr, clientFolderId);
  if (existing) return existing;
  return await createDriveFolder(accessToken, yr, clientFolderId);
}

export function driveFilePreviewUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

/** Upload a PDF or replace an existing file with the same name in the folder. */
export async function upsertPdfInDriveFolder(
  accessToken: string,
  folderId: string,
  fileName: string,
  fileContent: Uint8Array,
): Promise<string> {
  const safeName = fileName.replace(/'/g, "\\'");
  const q =
    `name='${safeName}' and '${folderId}' in parents and mimeType!='application/vnd.google-apps.folder' and trashed=false`;
  const listUrl = `https://www.googleapis.com/drive/v3/files?q=${
    encodeURIComponent(q)
  }&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const listResp = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (listResp.ok) {
    const listData = await listResp.json();
    const id = listData.files?.[0]?.id as string | undefined;
    if (id) {
      const patchResp = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media&supportsAllDrives=true`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/pdf",
          },
          body: fileContent,
        },
      );
      if (!patchResp.ok) {
        const msg = await patchResp.text();
        throw new Error(`Drive PDF update failed: ${patchResp.status} ${msg}`);
      }
      return id;
    }
  }
  const created = await uploadFileToDrive(accessToken, fileName, fileContent, "application/pdf", folderId);
  return created.id;
}
