import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Camoufox } from 'camoufox-js';

export const CME_LOGIN_URL = 'https://www.cmegroup.com/';
export const CME_SSO_LOGIN_URL = 'https://login.cmegroup.com/sso/accountstatus/showAuth.action';
export const CME_VOL2VOL_URL = 'https://www.cmegroup.com/tools-information/quikstrike/vol2vol-expected-range.html';

export class CmeSessionError extends Error {
  constructor(message: string, readonly code: 'challenge' | 'reauth_required' | 'failed' = 'failed') {
    super(message);
    this.name = 'CmeSessionError';
  }
}

export interface CmeBrowserSession {
  browser: any;
  context: any;
  page: any;
  storagePath: string;
  saveStorageState(): Promise<void>;
  close(): Promise<void>;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function cmeStoragePath(): string {
  return path.resolve(process.env.CME_STORAGE_STATE_PATH ?? 'runtime/cme-storage-state.json');
}

async function fileExists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true).catch(() => false);
}

export async function openCmeBrowser(): Promise<CmeBrowserSession> {
  const storagePath = cmeStoragePath();
  const hasStorage = await fileExists(storagePath);
  const browser = await Camoufox({
    headless: process.env.CME_HEADLESS !== 'false',
    timeout: Number(process.env.CME_BROWSER_TIMEOUT_MS ?? 90_000),
  });
  const context = typeof browser.newContext === 'function'
    ? await browser.newContext(hasStorage ? { storageState: storagePath } : {})
    : browser;
  const page = typeof context.newPage === 'function' ? await context.newPage() : await browser.newPage();

  return {
    browser,
    context,
    page,
    storagePath,
    async saveStorageState() {
      if (typeof context.storageState !== 'function') return;
      const state = await context.storageState();
      await mkdir(path.dirname(storagePath), { recursive: true });
      const temporaryPath = `${storagePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await rename(temporaryPath, storagePath);
    },
    async close() {
      await page.close?.().catch(() => undefined);
      if (page !== browser && typeof browser.close === 'function') await browser.close().catch(() => undefined);
    },
  };
}

async function pageText(page: any): Promise<string> {
  return String(await page.locator?.('body')?.innerText?.().catch(() => '') ?? '').toLowerCase();
}

export async function hasCmeChallenge(page: any): Promise<boolean> {
  const body = await pageText(page);
  const url = String(page.url?.() ?? '').toLowerCase();
  return /captcha|robot|verify|one-time|mfa|multi-factor|security code|challenge/.test(`${url} ${body}`);
}

export async function isCmeLoginPage(page: any): Promise<boolean> {
  const url = String(page.url?.() ?? '').toLowerCase();
  if (url.includes('login.cmegroup.com') || url.includes('/sso/login') || url.includes('/accountstatus/showauth')) return true;
  return Boolean(await page.locator?.('input#user, input#pwd, input[type="password"]')?.count?.().catch(() => 0));
}

async function isAuthenticated(page: any): Promise<boolean> {
  if (await isCmeLoginPage(page) || await hasCmeChallenge(page)) return false;
  const body = await pageText(page);
  return /log out|logout|my account|my profile|sign out|quikstrike/.test(body);
}

async function fillLoginForm(page: any, email: string, password: string): Promise<void> {
  await page.evaluate(({ emailValue, passwordValue }: { emailValue: string; passwordValue: string }) => {
    const doc = (globalThis as any).document as any;
    const emailSelectors = ['#user', 'input[name="email"]', 'input[name="username"]', 'input[type="email"]', '#signInName'];
    const passwordSelectors = ['input[name="password"]', 'input[type="password"]', '#password', '#pwd'];
    const emailInput = emailSelectors.map((selector) => doc.querySelector(selector)).find(Boolean) as any;
    const passwordInput = passwordSelectors.map((selector) => doc.querySelector(selector)).find(Boolean) as any;
    if (emailInput) {
      emailInput.value = emailValue;
      emailInput.dispatchEvent(new Event('input', { bubbles: true }));
      emailInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (passwordInput) {
      passwordInput.value = passwordValue;
      passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
      passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const submit = doc.querySelector('button[type="submit"], input[type="submit"], #login-button') as any;
    submit?.click();
  }, { emailValue: email, passwordValue: password });
}

async function clickCmeLoginButton(page: any): Promise<void> {
  const loginButton = page.getByRole?.('button', { name: /log in/i });
  if (loginButton && await loginButton.count().catch(() => 0)) {
    await loginButton.first().click();
    await sleep(2_000);
  }
  if (!(await isCmeLoginPage(page))) {
    await page.goto(CME_SSO_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await sleep(2_000);
  }
}

async function cmeLoginError(page: any): Promise<string | null> {
  const body = await pageText(page);
  if (/invalid username|invalid password|incorrect password|incorrect username|invalid credentials|authentication failed|account locked|unable to log in|not recognized/.test(body)) {
    return 'CME rejected the login credentials or the account is locked';
  }
  return null;
}

export async function ensureCmeAuthenticated(session: CmeBrowserSession): Promise<void> {
  const { page } = session;
  await page.goto(CME_VOL2VOL_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await sleep(5_000);
  if (await isAuthenticated(page)) {
    await session.saveStorageState();
    return;
  }
  if (await hasCmeChallenge(page)) {
    throw new CmeSessionError('CME presented a login challenge; manual completion is required', 'challenge');
  }

  const email = process.env.CME_EMAIL;
  const password = process.env.CME_PASSWORD;
  if (!email || !password) {
    throw new CmeSessionError('Saved CME session is invalid; CME_EMAIL/CME_PASSWORD are required for re-login', 'reauth_required');
  }

  await page.goto(CME_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await sleep(3_000);
  await clickCmeLoginButton(page);
  await fillLoginForm(page, email, password);
  if (!(await isCmeLoginPage(page))) {
    throw new CmeSessionError('CME login form was not found after opening the SSO page', 'failed');
  }
  const deadline = Date.now() + Number(process.env.CME_LOGIN_TIMEOUT_MS ?? 300_000);
  while (Date.now() < deadline) {
    await sleep(5_000);
    const loginError = await cmeLoginError(page);
    if (loginError) throw new CmeSessionError(loginError, 'failed');
    if (await isAuthenticated(page) && !(await isCmeLoginPage(page))) break;
    if (await hasCmeChallenge(page)) {
      throw new CmeSessionError('CME presented MFA/CAPTCHA; complete it manually and rerun auth', 'challenge');
    }
  }
  if (!(await isAuthenticated(page))) {
    throw new CmeSessionError('Automated CME login timed out', 'reauth_required');
  }
  await page.goto(CME_VOL2VOL_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await sleep(8_000);
  if (!(await isAuthenticated(page))) {
    throw new CmeSessionError('CME login completed but Vol2Vol access could not be verified', 'failed');
  }
  await session.saveStorageState();
}

export async function pageFetch<T>(page: any, url: string, init: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(async ({ fetchUrl, fetchInit }: { fetchUrl: string; fetchInit: Record<string, unknown> }) => {
    const response = await fetch(fetchUrl, fetchInit as RequestInit);
    if (!response.ok) throw new Error(`CME request failed (${response.status}): ${fetchUrl}`);
    return response.json();
  }, { fetchUrl: url, fetchInit: init });
}
