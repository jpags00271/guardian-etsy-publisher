// Google Drive helper — uses a Desktop-app OAuth client + long-lived refresh token
// (service accounts are blocked by org policy, see memory: guardian-drive-oauth).
// Credentials come from env vars, NOT hardcoded, so they can be rotated in Vercel
// without a redeploy.

async function getDriveAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.DRIVE_CLIENT_ID,
      client_secret: process.env.DRIVE_CLIENT_SECRET,
      refresh_token: process.env.DRIVE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    throw new Error(`Drive token refresh failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function downloadFile(fileId, accessToken) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    throw new Error(`Drive download failed for ${fileId}: ${res.status} ${await res.text()}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function getFileMetadata(fileId, accessToken) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,parents`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    throw new Error(`Drive metadata failed for ${fileId}: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function listFolderChildren(folderId, accessToken) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType)&pageSize=100`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    throw new Error(`Drive list failed for ${folderId}: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.files || [];
}

async function readJsonFileByName(folderId, filename, accessToken) {
  const children = await listFolderChildren(folderId, accessToken);
  const match = children.find((f) => f.name === filename);
  if (!match) return null;
  const buf = await downloadFile(match.id, accessToken);
  return JSON.parse(buf.toString('utf-8'));
}

async function writeJsonFile(folderId, filename, obj, accessToken, existingFileId) {
  const content = JSON.stringify(obj, null, 2);
  const boundary = 'guardianboundary' + Date.now();
  const metadata = existingFileId
    ? { name: filename }
    : { name: filename, parents: [folderId] };
  const multipartBody =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;

  const url = existingFileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

  const res = await fetch(url, {
    method: existingFileId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: multipartBody,
  });
  if (!res.ok) {
    throw new Error(`Drive write failed for ${filename}: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

module.exports = {
  getDriveAccessToken,
  downloadFile,
  getFileMetadata,
  listFolderChildren,
  readJsonFileByName,
  writeJsonFile,
};
