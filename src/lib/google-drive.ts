import { getDb } from "./db";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "https://pegasus-ads.vercel.app/api/auth/google/callback";

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
    scope: "https://www.googleapis.com/auth/drive",
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
 * Get a valid access token, refreshing if necessary
 */
export async function getValidAccessToken(): Promise<string> {
  const db = getDb();

  const tokenData = await db.execute({
    sql: "SELECT value FROM settings WHERE key = 'google_tokens'",
  });

  if (tokenData.rows.length === 0) {
    throw new Error("No Google tokens found. Please connect to Google Drive first.");
  }

  const tokens = JSON.parse(tokenData.rows[0].value as string) as GoogleTokens;
  const expiresAt = parseInt(
    ((await db.execute({ sql: "SELECT value FROM settings WHERE key = 'google_token_expires'" })).rows[0]?.value as string) || "0"
  );

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

    // Update in DB
    await saveTokens(tokens);
  }

  return tokens.access_token;
}

/**
 * Save tokens to the database
 */
export async function saveTokens(tokens: GoogleTokens): Promise<void> {
  const db = getDb();

  // First try to update, then insert if not exists
  const existing = await db.execute({
    sql: "SELECT key FROM settings WHERE key = ?",
    args: ["google_tokens"],
  });

  if (existing.rows.length > 0) {
    await db.execute({
      sql: "UPDATE settings SET value = ?, updated_at = NOW() WHERE key = ?",
      args: [JSON.stringify(tokens), "google_tokens"],
    });
  } else {
    await db.execute({
      sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, NOW())",
      args: ["google_tokens", JSON.stringify(tokens)],
    });
  }

  // Save expiration time
  const expiresIn = tokens.expires_in || 3600;
  const expiresAt = Date.now() + expiresIn * 1000;

  const existsExpires = await db.execute({
    sql: "SELECT key FROM settings WHERE key = ?",
    args: ["google_token_expires"],
  });

  if (existsExpires.rows.length > 0) {
    await db.execute({
      sql: "UPDATE settings SET value = ?, updated_at = NOW() WHERE key = ?",
      args: [expiresAt.toString(), "google_token_expires"],
    });
  } else {
    await db.execute({
      sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, NOW())",
      args: ["google_token_expires", expiresAt.toString()],
    });
  }
}

/**
 * Get the selected Google Drive folder ID
 */
export async function getSelectedFolderId(): Promise<string | null> {
  const db = getDb();

  const result = await db.execute({
    sql: "SELECT value FROM settings WHERE key = 'google_drive_folder_id'",
  });

  return result.rows.length > 0 ? (result.rows[0].value as string) : null;
}

/**
 * Save the selected Google Drive folder ID
 */
export async function setSelectedFolderId(folderId: string): Promise<void> {
  const db = getDb();

  const existing = await db.execute({
    sql: "SELECT key FROM settings WHERE key = ?",
    args: ["google_drive_folder_id"],
  });

  if (existing.rows.length > 0) {
    await db.execute({
      sql: "UPDATE settings SET value = ?, updated_at = NOW() WHERE key = ?",
      args: [folderId, "google_drive_folder_id"],
    });
  } else {
    await db.execute({
      sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, NOW())",
      args: ["google_drive_folder_id", folderId],
    });
  }
}

/**
 * List Shared Drives the user has access to
 */
async function listSharedDrives(accessToken: string): Promise<{ id: string; name: string }[]> {
  const response = await fetch(
    "https://www.googleapis.com/drive/v3/drives?pageSize=100&fields=drives(id,name)",
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!response.ok) return [];

  const data = (await response.json()) as { drives: { id: string; name: string }[] };
  return data.drives || [];
}

/**
 * List folders in Google Drive (including Shared Drives)
 */
export async function listFolders(): Promise<GoogleDriveFolder[]> {
  const accessToken = await getValidAccessToken();

  const allFolders: GoogleDriveFolder[] = [];

  // Check token scope
  const tokenInfoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
  if (tokenInfoRes.ok) {
    const tokenInfo = await tokenInfoRes.json();
    console.log("[Drive] Token scope:", tokenInfo.scope);
  }

  // 1. List folders from My Drive
  const myDriveResponse = await fetch(
    "https://www.googleapis.com/drive/v3/files?q=mimeType='application/vnd.google-apps.folder'&spaces=drive&pageSize=100&fields=files(id,name,mimeType)&includeItemsFromAllDrives=true&supportsAllDrives=true",
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (myDriveResponse.ok) {
    const data = (await myDriveResponse.json()) as { files: GoogleDriveFolder[] };
    console.log("[Drive] My Drive folders:", data.files?.length || 0);
    allFolders.push(...(data.files || []));
  } else {
    const errText = await myDriveResponse.text();
    console.error("[Drive] My Drive error:", myDriveResponse.status, errText);
  }

  // 2. List Shared Drives themselves (they act as root folders)
  const sharedDrives = await listSharedDrives(accessToken);
  console.log("[Drive] Shared Drives found:", sharedDrives.length, sharedDrives.map(d => d.name));
  for (const drive of sharedDrives) {
    allFolders.push({
      id: drive.id,
      name: `📁 ${drive.name} (Drive Compartilhado)`,
      mimeType: "application/vnd.google-apps.folder",
    });

    // 3. List top-level folders inside each Shared Drive
    const sharedResponse = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=mimeType='application/vnd.google-apps.folder' and '${drive.id}' in parents&spaces=drive&pageSize=100&fields=files(id,name,mimeType)&includeItemsFromAllDrives=true&supportsAllDrives=true&corpora=drive&driveId=${drive.id}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    if (sharedResponse.ok) {
      const sharedData = (await sharedResponse.json()) as { files: GoogleDriveFolder[] };
      for (const folder of sharedData.files || []) {
        folder.name = `  └ ${folder.name}`;
        allFolders.push(folder);
      }
    }
  }

  return allFolders;
}

/**
 * Upload a file to Google Drive using multipart upload
 */
export async function uploadToGoogleDrive(
  fileName: string,
  fileBuffer: Buffer,
  mimeType: string,
  folderId?: string
): Promise<string> {
  const accessToken = await getValidAccessToken();

  // Determine folder - use provided or get from settings
  let targetFolderId: string | undefined = folderId;
  if (!targetFolderId) {
    const selectedId = await getSelectedFolderId();
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
 * Check if Google Drive is connected
 */
export async function isConnected(): Promise<boolean> {
  const db = getDb();

  const result = await db.execute({
    sql: "SELECT value FROM settings WHERE key = 'google_tokens'",
  });

  return result.rows.length > 0;
}

/**
 * Get connection status with folder info
 */
export async function getConnectionStatus(): Promise<{
  connected: boolean;
  folder_id?: string;
  folder_name?: string;
}> {
  const db = getDb();

  const connected = await isConnected();
  if (!connected) {
    return { connected: false };
  }

  const folderId = await getSelectedFolderId();
  if (!folderId) {
    return { connected: true };
  }

  const accessToken = await getValidAccessToken();
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

/**
 * Clear all Google Drive settings
 */
export async function disconnect(): Promise<void> {
  const db = getDb();

  await db.execute({
    sql: "DELETE FROM settings WHERE key IN ('google_tokens', 'google_token_expires', 'google_drive_folder_id')",
  });
}
