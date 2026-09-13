import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Atomically write a caller-supplied secret with owner-only permissions. */
export async function writeSecretFile(
  path: string,
  value: string
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomBytes(6).toString('hex')}.tmp`;

  try {
    await writeFile(tempPath, value, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

/** Delete a secret file; a missing file is not an error. */
export async function deleteSecretFile(path: string): Promise<void> {
  await rm(path, { force: true });
}
