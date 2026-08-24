import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CmeSessionError, ensureCmeAuthenticated, openCmeBrowser } from '../collector/cme/cme-browser.js';

const statusPath = path.resolve(process.env.GOLD_SIGHT_DATA_ROOT ?? 'public/data', 'status', 'latest.json');

async function writeAuthStatus(state: 'ok' | 'reauth_required' | 'challenge' | 'failed', message: string) {
  let current: Record<string, unknown> = {};
  try { current = JSON.parse(await readFile(statusPath, 'utf8')) as Record<string, unknown>; } catch { /* first run */ }
  await mkdir(path.dirname(statusPath), { recursive: true });
  const next = {
    ...current,
    auth: { state, checkedAt: new Date().toISOString(), message },
    stale: state !== 'ok' || current.stale === true,
    state: state === 'ok' && current.state !== 'error' ? current.state ?? 'partial' : 'stale',
  };
  const temporaryPath = `${statusPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, statusPath);
}

async function main() {
  const session = await openCmeBrowser();
  try {
    await ensureCmeAuthenticated(session);
    await writeAuthStatus('ok', 'CME session is valid and Vol2Vol access was verified');
  } catch (error) {
    const code = error instanceof CmeSessionError ? error.code : 'failed';
    const state = code === 'challenge' ? 'challenge' : code === 'reauth_required' ? 'reauth_required' : 'failed';
    await writeAuthStatus(state, error instanceof Error ? error.message : String(error));
    process.exitCode = code === 'challenge' || code === 'reauth_required' ? 10 : 1;
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = process.exitCode || 1;
});

