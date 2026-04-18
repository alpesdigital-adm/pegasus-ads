import { getWorkspaceSetting, setWorkspaceSetting } from "./workspace";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "https://pegasus.alpesd.com.br/api/auth/google/callback";

interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

interface GoogleDriveFile {
  id: string;
  name: string;
  mimeType: string;
}

interface GoogleDriveFolder extends GoogleDriveFile {
  mimeType: "application/vnd.google-apps.folder";
}

/**
 * Generate the Google OAuth2 authorization URL
 */
export function generateAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/script.projects",
    ].join(" "),
    access_type: "offline",
    prompt: "consent",
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForToken(code: string): Promise<GoogleTokens> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`Failed to exchange code for token: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Refresh an access token using refresh token
 */
export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`Failed to refresh access token: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Get a valid access token for a workspace, refreshing if necessary.
 * Reads from workspace_settings — no fallback to global settings.
 */
export async function getValidAccessToken(workspaceId: string): Promise<string> {
  const tokenJson = await getWorkspaceSetting(workspaceId, "google_tokens");
  if (!tokenJson) {
    throw new Error("No Google tokens found for this workspace. Please connect to Google Drive first.");
  }

  const tokens = JSON.parse(tokenJson) as GoogleTokens;
  const expiresAtStr = await getWorkspaceSetting(workspaceId, "google_token_expires");
  const expiresAt = parseInt(expiresAtStr || "0");

  // If token is expired or about to expire, refresh it
  if (Date.now() >= expiresAt - 60000) {
    if (!tokens.refresh_token) {
      throw new Error("No refresh token available. Please reconnect to Google Drive.");
    }

    const newTokens = await refreshAccessToken(tokens.refresh_token);
    tokens.access_token = newTokens.access_token;
    if (newTokens.expires_in) {
      tokens.expires_in = newTokens.expires_in;
    }

    // Update in workspace settings
    await saveTokens(workspaceId, tokens);
  }

  return tokens.access_token;
}

/**
 * Save tokens to workspace_settings
 */
export async function saveTokens(workspaceId: string, tokens: GoogleTokens): Promise<void> {
  await setWorkspaceSetting(workspaceId, "google_tokens", JSON.stringify(tokens));

  const expiresIn = tokens.expires_in || 3600;
  const expiresAt = Date.now() + expiresIn * 1000;
  await setWorkspaceSetting(workspaceId, "google_token_expires", expiresAt.toString());
}

/**
 * Get the selected Google Drive folder ID for a workspace
 */
export async function getSelectedFolderId(workspaceId: string): Promise<string | null> {
  return getWorkspaceSetting(workspaceId, "google_drive_folder_id");
}

/**
 * Save the selected Google Drive folder ID for a workspace
 */
export async function setSelectedFolderId(workspaceId: string, folderId: string): Promise<void> {
  await setWorkspaceSetting(workspaceId, "google_drive_folder_id", folderId);
}

/**
 * List root-level locations: My Drive + Shared Drives
 */
export async function listRoots(workspaceId: string): Promise<{ id: string; name: string; type: "my_drive" | "shared_drive" }[]> {
  const accessToken = await getValidAccessToken(workspaceId);
  const roots: { id: string; name: string; type: "my_drive" | "shared_drive" }[] = [];

  // My Drive
  roots.push({ id: "root", name: "Meu Drive", type: "my_drive" });

  // Shared Drives
  const response = await fetch(
    "https://www.googleapis.com/drive/v3/drives?pageSize=100&fields=drives(id,name)",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (response.ok) {
    const data = (await response.json()) as { drives: { id: string; name: string }[] };
    for (const drive of data.drives || []) {
      roots.push({ id: drive.id, name: drive.name, type: "shared_drive" });
    }
  }

  return roots;
}

/**
 * List child folders inside a given parent folder
 */
export async function listFoldersInParent(workspaceId: string, parentId: string, driveId?: string): Promise<GoogleDriveFolder[]> {
  const accessToken = await getValidAccessToken(workspaceId);

  const params = new URLSearchParams({
    q: `mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
    spaces: "drive",
    pageSize: "100",
    fields: "files(id,name,mimeType)",
    includeItemsFromAllDrives: "true",
    supportsAllDrives: "true",
    orderBy: "name",
  });

  // If browsing inside a Shared Drive, must specify corpora=drive and driveId
  if (driveId) {
    params.set("corpora", "drive");
    params.set("driveId", driveId);
  }

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) {
    const errText = await response.text();
    console.error("[Drive] listFoldersInParent error:", response.status, errText);
    return [];
  }

  const data = (await response.json()) as { files: GoogleDriveFolder[] };
  return data.files || [];
}

/**
 * Legacy: list all folders flat
 */
export async function listFolders(workspaceId: string): Promise<GoogleDriveFolder[]> {
  const roots = await listRoots(workspaceId);
  const allFolders: GoogleDriveFolder[] = [];

  for (const root of roots) {
    if (root.type === "shared_drive") {
      allFolders.push({ id: root.id, name: root.name, mimeType: "application/vnd.google-apps.folder" });
    }
    const children = await listFoldersInParent(workspaceId, root.id, root.type === "shared_drive" ? root.id : undefined);
    allFolders.push(...children);
  }

  return allFolders;
}

/**
 * Upload a file to Google Drive using multipart upload
 */
export async function uploadToGoogleDrive(
  workspaceId: string,
  fileName: string,
  fileBuffer: Buffer,
  mimeType: string,
  folderId?: string
): Promise<string> {
  const accessToken = await getValidAccessToken(workspaceId);

  // Determine folder - use provided or get from workspace settings
  let targetFolderId: string | undefined = folderId;
  if (!targetFolderId) {
    const selectedId = await getSelectedFolderId(workspaceId);
    targetFolderId = selectedId || undefined;
  }

  // Create multipart body
  const boundary = "===============" + Math.random().toString().substring(2) + "==";
  const metadata = {
    name: fileName,
    mimeType,
    ...(targetFolderId && { parents: [targetFolderId] }),
  };

  const metadataString = JSON.stringify(metadata);
  const header = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataString}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const footer = `\r\n--${boundary}--`;

  const body = Buffer.concat([Buffer.from(header), fileBuffer, Buffer.from(footer)]);

  const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary="${boundary}"`,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload to Google Drive: ${response.statusText}`);
  }

  const data = (await response.json()) as { id: string };
  return data.id;
}

/**
 * Check if Google Drive is connected for a workspace
 */
export async function isConnected(workspaceId: string): Promise<boolean> {
  const tokenJson = await getWorkspaceSetting(workspaceId, "google_tokens");
  return tokenJson !== null;
}

/**
 * Get connection status with folder info for a workspace
 */
export async function getConnectionStatus(workspaceId: string): Promise<{
  connected: boolean;
  folder_id?: string;
  folder_name?: string;
}> {
  const connected = await isConnected(workspaceId);
  if (!connected) {
    return { connected: false };
  }

  const folderId = await getSelectedFolderId(workspaceId);
  if (!folderId) {
    return { connected: true };
  }

  const accessToken = await getValidAccessToken(workspaceId);
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}?fields=name&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (response.ok) {
    const data = (await response.json()) as { name: string };
    return {
      connected: true,
      folder_id: folderId,
      folder_name: data.name,
    };
  }

  return { connected: true, folder_id: folderId };
}

// ── File listing & download ──

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  imageMediaMetadata?: { width: number; height: number };
}

/**
 * List image files in a Google Drive folder.
 */
export async function listFilesInFolder(
  workspaceId: string,
  folderId: string,
  driveId?: string
): Promise<DriveFile[]> {
  const accessToken = await getValidAccessToken(workspaceId);

  const q = `'${folderId}' in parents and trashed=false and (mimeType='image/png' or mimeType='image/jpeg' or mimeType='image/jpg')`;
  const params = new URLSearchParams({
    q,
    spaces: "drive",
    pageSize: "200",
    fields: "files(id,name,mimeType,size,imageMediaMetadata(width,height))",
    includeItemsFromAllDrives: "true",
    supportsAllDrives: "true",
    orderBy: "name",
  });

  if (driveId) {
    params.set("corpora", "drive");
    params.set("driveId", driveId);
  }

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Drive listFilesInFolder failed: ${response.status} ${errText}`);
  }

  const data = (await response.json()) as { files: DriveFile[] };
  return data.files || [];
}

/**
 * Download a file from Google Drive as Buffer.
 */
export async function downloadFile(workspaceId: string, fileId: string): Promise<Buffer> {
  const accessToken = await getValidAccessToken(workspaceId);

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) {
    throw new Error(`Drive download failed for ${fileId}: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Clear all Google Drive settings for a workspace
 */
export async function disconnect(workspaceId: string): Promise<void> {
  await setWorkspaceSetting(workspaceId, "google_tokens", "");
  await setWorkspaceSetting(workspaceId, "google_token_expires", "");
  await setWorkspaceSetting(workspaceId, "google_drive_folder_id", "");
}
