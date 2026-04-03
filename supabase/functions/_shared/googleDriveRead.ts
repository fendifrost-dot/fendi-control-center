import { getAccessToken } from './googleDriveUpload.ts';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

export async function findClientTaxFolder(accessToken: string, clientName: string, year: number): Promise<string | null> {
  const patterns = [
    `${clientName.toUpperCase()} ${year} TAXES`,
    `${clientName.toUpperCase()} TAXES`,
    `${clientName.split(' ')[0].toUpperCase()} ${year} TAXES`,
    `${clientName.split(' ')[0].toUpperCase()} TAXES`,
  ];
  for (const name of patterns) {
    const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const res = await fetch(`${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await res.json();
    if (data.files?.length > 0) return data.files[0].id;
  }
  return null;
}

export async function listDriveFolder(accessToken: string, folderId: string): Promise<Array<{id: string, name: string, mimeType: string, size?: string}>> {
  const q = `'${folderId}' in parents and trashed=false`;
  const res = await fetch(`${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size)&pageSize=100`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await res.json();
  return data.files || [];
}

export async function downloadDriveFile(accessToken: string, fileId: string, mimeType: string): Promise<ArrayBuffer> {
  const isGoogleDoc = mimeType.startsWith('application/vnd.google-apps.');
  let url: string;
  if (isGoogleDoc) {
    url = `${DRIVE_API}/files/${fileId}/export?mimeType=application/pdf`;
  } else {
    url = `${DRIVE_API}/files/${fileId}?alt=media`;
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  return res.arrayBuffer();
}
