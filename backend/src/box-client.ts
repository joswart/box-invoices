import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { BoxClient, BoxJwtAuth, JwtConfig } from 'box-node-sdk';

/**
 * Directory where Box JWT config JSON files are stored.
 * Override with BOX_CONFIG_DIR environment variable.
 * Inside Docker the volume is mounted at /app/config.
 */
const CONFIG_DIR = process.env.BOX_CONFIG_DIR ?? path.join(process.cwd(), 'config');

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Create a Box client from a pre-configured JWT JSON file.
 *
 * @param configKey  Filename stem (without .json) inside CONFIG_DIR.
 * @param asUserId   Optional Box user ID.  When supplied the client acts as
 *                   that user via the `as-user` header (requires "All
 *                   Enterprise Users" app access level in the Developer
 *                   Console).  Omit to use the enterprise service account.
 */
export function createBoxClient(configKey: string, asUserId?: string): BoxClient {
  const configPath = path.join(CONFIG_DIR, `${configKey}.json`);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Box config file not found: ${configPath}`);
  }

  let configJson: string;
  try {
    configJson = fs.readFileSync(configPath, 'utf-8');
  } catch {
    throw new Error(`Failed to read Box config: ${configPath}`);
  }

  const jwtConfig = JwtConfig.fromConfigJsonString(configJson);
  const auth = new BoxJwtAuth({ config: jwtConfig });
  console.log(`[box-client] subjectType=${auth.subjectType} subjectId=${auth.subjectId}`);
  const client = new BoxClient({ auth });

  if (asUserId) {
    return client.withExtraHeaders({ 'as-user': asUserId });
  }
  return client;
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

/**
 * Upload a PDF buffer to a Box folder.
 * @returns The Box file ID of the uploaded file.
 */
export async function uploadFileToBox(
  client: BoxClient,
  folderId: string,
  filename: string,
  buffer: Buffer,
): Promise<string> {
  const stream = Readable.from(buffer);
  const result = await client.uploads.uploadFile({
    attributes: { name: filename, parent: { id: folderId } },
    file: stream,
  });
  const fileId = result?.entries?.[0]?.id;
  if (!fileId) throw new Error('Box uploadFile did not return a file ID');
  return fileId;
}

/**
 * Download a file from Box by its file ID.
 * @returns Object with the file buffer and the original filename.
 */
export async function downloadFileFromBox(
  client: BoxClient,
  fileId: string,
): Promise<{ buffer: Buffer; filename: string }> {
  const info = await client.files.getFileById(fileId, {
    queryParams: { fields: ['name'] },
  });
  const filename: string = info?.name ?? `file-${fileId}`;

  const stream = await client.downloads.downloadFile(fileId);
  if (!stream) throw new Error(`Box downloadFile returned no stream for file ${fileId}`);

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return { buffer: Buffer.concat(chunks), filename };
}

/**
 * Move a Box file to a different parent folder.
 */
export async function moveFileInBox(
  client: BoxClient,
  fileId: string,
  newFolderId: string,
): Promise<void> {
  await client.files.updateFileById(fileId, {
    requestBody: { parent: { id: newFolderId } },
  });
}

// ---------------------------------------------------------------------------
// Metadata operations
// ---------------------------------------------------------------------------

/**
 * Apply an enterprise metadata template to an uploaded Box file.
 */
export async function applyMetadataToFile(
  client: BoxClient,
  fileId: string,
  templateKey: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await client.fileMetadata.createFileMetadataById(
    fileId,
    'enterprise',
    templateKey,
    metadata,
  );
}
