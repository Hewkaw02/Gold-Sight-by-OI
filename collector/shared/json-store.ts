import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    if (await readFile(filePath, 'utf8') === text) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, text, 'utf8');
  let lastError: unknown;
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rename(tempPath, filePath);
        return;
      } catch (error) {
        lastError = error;
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(code ?? '')) throw error;
        await new Promise((resolve) => setTimeout(resolve, 75 * (attempt + 1)));
      }
    }
  } finally {
    await rm(tempPath, { force: true });
  }
  throw lastError;
}

export function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function mergeByKey<T>(existing: T[], incoming: T[], keyOf: (value: T) => string): T[] {
  const values = new Map(existing.map((value) => [keyOf(value), value]));
  for (const value of incoming) values.set(keyOf(value), value);
  return [...values.values()];
}
