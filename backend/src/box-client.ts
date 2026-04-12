import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

// box-node-sdk uses a CommonJS default export; use require to avoid ESM issues.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const BoxSDK = require('box-node-sdk');

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
 * Create a Box service-account client from a pre-configured JWT JSON file.
 * @param configKey  Filename stem (without .json) inside CONFIG_DIR.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createBoxClient(configKey: string): any {
  const configPath = path.join(CONFIG_DIR, `${configKey}.json`);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Box config file not found: ${configPath}`);
  }

  let jwtConfig: unknown;
  try {
    jwtConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    throw new Error(`Failed to parse Box config: ${configPath}`);
  }

  const sdk = BoxSDK.getPreconfiguredInstance(jwtConfig);
  return sdk.getAppAuthClient('enterprise');
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

/**
 * Upload a PDF buffer to a Box folder.
 * @returns The Box file ID of the uploaded file.
 */
export async function uploadFileToBox(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  folderId: string,
  filename: string,
  buffer: Buffer,
): Promise<string> {
  const stream = Readable.from(buffer);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await client.files.uploadFile(folderId, filename, stream);
  const fileId: string = result?.entries?.[0]?.id;
  if (!fileId) throw new Error('Box uploadFile did not return a file ID');
  return fileId;
}

/**
 * Download a file from Box by its file ID.
 * @returns Object with the file buffer and the original filename.
 */
export async function downloadFileFromBox(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  fileId: string,
): Promise<{ buffer: Buffer; filename: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const info: any = await client.files.get(fileId, { fields: 'name' });
  const filename: string = info?.name ?? `file-${fileId}`;

  const stream: Readable = await client.files.getReadStream(fileId);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  fileId: string,
  newFolderId: string,
): Promise<void> {
  await client.files.update(fileId, { parent: { id: newFolderId } });
}

// ---------------------------------------------------------------------------
// Metadata operations
// ---------------------------------------------------------------------------

/**
 * Apply an enterprise metadata template to an uploaded Box file.
 * Uses the `enterprise` scope; the SDK resolves the full enterprise scope URI.
 */
export async function applyMetadataToFile(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  fileId: string,
  templateKey: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await client.metadata.createOnFile(
    fileId,
    client.metadata.scopes.ENTERPRISE,
    templateKey,
    metadata,
  );
}
