import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { SessionSlot } from '../src/domain/types.js';

type SchedulerClock = {
  dateKey: string;
  weekday: string;
  hour: number;
  minute: number;
};

type OiSchedule = {
  hour: number;
  minute: number;
  slot: SessionSlot;
};

const root = process.cwd();
const timezone = process.env.SCHEDULER_TIMEZONE ?? process.env.CME_TIMEZONE ?? 'America/Chicago';
const runtimeRoot = path.resolve(process.env.SCHEDULER_RUNTIME_ROOT ?? 'runtime');
const heartbeatPath = path.join(runtimeRoot, 'scheduler', 'heartbeat.json');
const tickMs = Math.max(5, Number(process.env.SCHEDULER_TICK_SECONDS ?? 30)) * 1000;
const priceIntervalMs = Math.max(1, Number(process.env.SCHEDULER_PRICE_INTERVAL_MINUTES ?? 15)) * 60_000;
const runPriceOnStart = (process.env.SCHEDULER_RUN_PRICE_ON_START ?? 'true') === 'true';
const runOiOnStart = (process.env.SCHEDULER_RUN_OI_ON_START ?? 'true') === 'true';
const startupOiSlot = (process.env.SCHEDULER_STARTUP_OI_SLOT ?? 'close') as SessionSlot;
const priceRetries = Math.max(1, Number(process.env.SCHEDULER_PRICE_RETRIES ?? 2));
const retryDelayMs = Math.max(5, Number(process.env.SCHEDULER_RETRY_DELAY_SECONDS ?? 20)) * 1000;
const weekdays = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

let stopping = false;
let activeRun: Promise<void> | null = null;
let lastPriceCompletedAt = runPriceOnStart ? 0 : Date.now();
let lastOiKey = '';

function log(message: string) {
  console.log(`[scheduler] ${new Date().toISOString()} ${message}`);
}

function schedulerClock(now = new Date()): SchedulerClock {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now).map(({ type, value }) => [type, value])) as Record<string, string>;
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function parseOiSchedule(): OiSchedule[] {
  const configured = process.env.SCHEDULER_OI_SCHEDULE ?? '07:50:open,09:55:mid,12:20:close';
  return configured.split(',').flatMap((entry) => {
    const match = /^(\d{1,2}):(\d{2}):(open|mid|close)$/.exec(entry.trim());
    if (!match) {
      log(`Ignoring invalid OI schedule entry: ${entry}`);
      return [];
    }
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) {
      log(`Ignoring out-of-range OI schedule entry: ${entry}`);
      return [];
    }
    return [{ hour, minute, slot: match[3] as SessionSlot }];
  });
}

type CollectorSummary = {
  priceError?: string | null;
  oiError?: string | null;
};

function runCommand(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      process.stdout.write(`[collector] ${chunk}`);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      process.stderr.write(`[collector] ${chunk}`);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`npm ${args.join(' ')} exited with ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

function parseCollectorSummary(stdout: string): CollectorSummary | null {
  const starts = [...stdout.matchAll(/\{\s*"state"\s*:/g)].map((match) => match.index ?? -1).filter((index) => index >= 0);
  const start = starts.at(-1);
  if (start === undefined) return null;
  try {
    return JSON.parse(stdout.slice(start)) as CollectorSummary;
  } catch {
    return null;
  }
}

function collectorError(summary: CollectorSummary | null, key: 'priceError' | 'oiError') {
  return summary?.[key] ? `${key} reported by collector` : null;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function writeHeartbeat(state: 'idle' | 'running' | 'error', detail: string | null = null) {
  await mkdir(path.dirname(heartbeatPath), { recursive: true });
  await writeFile(heartbeatPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    state,
    detail,
    timezone,
    priceIntervalMinutes: priceIntervalMs / 60_000,
    oiSchedule: parseOiSchedule(),
  }, null, 2));
}

async function runPrice() {
  log('Starting scheduled price refresh');
  await writeHeartbeat('running', 'price');
  let lastError = 'price collector failed';
  for (let attempt = 1; attempt <= priceRetries; attempt += 1) {
    try {
      const summary = parseCollectorSummary(await runCommand(['run', 'collector:run'], { RUN_LIVE_OI: 'false' }));
      const reportedError = collectorError(summary, 'priceError');
      if (reportedError) throw new Error(reportedError);
      lastPriceCompletedAt = Date.now();
      await writeHeartbeat('idle');
      log(`Scheduled price refresh completed (attempt ${attempt}/${priceRetries})`);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < priceRetries) {
        log(`Scheduled price refresh failed on attempt ${attempt}/${priceRetries}; retrying in ${retryDelayMs / 1000}s`);
        await delay(retryDelayMs);
      }
    }
  }
  lastPriceCompletedAt = Date.now();
  await writeHeartbeat('error', lastError);
  log(`Scheduled price refresh failed after ${priceRetries} attempts: ${lastError}`);
}

async function runOi(slot: SessionSlot) {
  log(`Starting scheduled OI refresh (${slot})`);
  await writeHeartbeat('running', `oi:${slot}`);
  try {
    await runCommand(['run', 'auth:cme'], {
      CME_HEADLESS: 'true',
      CME_LOGIN_HEADLESS: 'true',
    });
  } catch (error) {
    log(`CME re-auth check failed; collector will still attempt the saved session: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const summary = parseCollectorSummary(await runCommand(['run', 'collector:run'], {
      RUN_LIVE_OI: 'true',
      OI_SESSION_SLOTS: slot,
    }));
    const reportedOiError = collectorError(summary, 'oiError');
    if (reportedOiError) throw new Error(reportedOiError);
    if (summary?.priceError) log('OI refresh succeeded, but its accompanying price refresh timed out; price will retry on the next scheduler cycle');
    await writeHeartbeat('idle');
    log(`Scheduled OI refresh completed (${slot})`);
  } catch (error) {
    await writeHeartbeat('error', error instanceof Error ? error.message : String(error));
    log(`Scheduled OI refresh failed (${slot}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function tick(oiSchedule: OiSchedule[]) {
  if (stopping) return;
  if (activeRun) {
    await writeHeartbeat('running', 'collector');
    return;
  }
  const clock = schedulerClock();
  if (!weekdays.has(clock.weekday)) {
    await writeHeartbeat('idle', 'weekend');
    return;
  }

  const oiMatch = oiSchedule.find(({ hour, minute }) => hour === clock.hour && minute === clock.minute);
  if (oiMatch) {
    const key = `${clock.dateKey}:${oiMatch.slot}`;
    if (key !== lastOiKey) {
      lastOiKey = key;
      activeRun = runOi(oiMatch.slot).finally(() => { activeRun = null; });
      return;
    }
  }

  if (Date.now() - lastPriceCompletedAt >= priceIntervalMs) {
    activeRun = runPrice().finally(() => { activeRun = null; });
  }
}

async function main() {
  const oiSchedule = parseOiSchedule();
  log(`Started in ${timezone}; price every ${priceIntervalMs / 60_000} minutes; OI slots: ${oiSchedule.map(({ hour, minute, slot }) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}=${slot}`).join(', ') || 'none'}`);
  await writeHeartbeat('idle', 'started');
  const startupClock = schedulerClock();
  if (runOiOnStart && weekdays.has(startupClock.weekday)) {
    lastOiKey = `${startupClock.dateKey}:startup:${startupOiSlot}`;
    activeRun = runOi(startupOiSlot).finally(() => { activeRun = null; });
  }
  const timer = setInterval(() => {
    void tick(oiSchedule).catch((error) => log(`Scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`));
  }, tickMs);
  await tick(oiSchedule);

  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    log('Stopping');
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

void main().catch((error) => {
  console.error(`[scheduler] Fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
