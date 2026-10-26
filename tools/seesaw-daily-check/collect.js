#!/usr/bin/env node
/*
 * Seesaw family-account collector.
 *
 * Signs into https://app.seesaw.me with the family credentials in
 * SEESAW_EMAIL / SEESAW_PASSWORD, walks the sections a parent sees
 * (home feed, notifications, inbox/messages, announcements, journal,
 * calendar/events) and writes everything it can see into an output
 * folder for a later summarisation step:
 *
 *   <out>/run.log              what happened, blocked hosts, errors
 *   <out>/manifest.json        index of everything captured
 *   <out>/pages/<name>.txt     visible text of each section
 *   <out>/pages/<name>.aria.txt accessibility tree of each section
 *   <out>/pages/<name>.png     full-page screenshot of each section
 *   <out>/api/NNN-<slug>.json  every JSON response the app fetched
 *   <out>/state.json           browser storage state (re-usable login)
 *
 * Usage:  node collect.js <output-dir>
 *
 * Exit codes:
 *   0  collected something
 *   1  SEESAW_EMAIL / SEESAW_PASSWORD not set
 *   2  login page did not accept the credentials
 *   3  app.seesaw.me could not be reached (network policy / outage)
 *   4  unexpected error (see run.log)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const EMAIL = process.env.SEESAW_EMAIL;
const PASSWORD = process.env.SEESAW_PASSWORD;
const OUT = path.resolve(process.argv[2] || 'seesaw-out');
const APP = 'https://app.seesaw.me';
const LOGIN_URL = `${APP}/#/login`;
const NAV_TIMEOUT = 45_000;
const SETTLE_MS = 4_000;
const TOTAL_BUDGET_MS = 6 * 60_000;

// Sections to look for after login. Each entry is tried in order:
// first any URL hashes, then any nav element whose text matches.
const SECTIONS = [
  { name: 'home', hashes: ['#/'], labels: [] },
  { name: 'notifications', hashes: ['#/notifications'], labels: [/^notifications?$/i, /^activity$/i] },
  { name: 'inbox', hashes: ['#/inbox', '#/messages'], labels: [/^inbox$/i, /^messages?$/i] },
  { name: 'announcements', hashes: ['#/announcements'], labels: [/^announcements?$/i] },
  { name: 'journal', hashes: ['#/journal'], labels: [/^journal$/i, /^feed$/i] },
  { name: 'activities', hashes: ['#/activities'], labels: [/^activities$/i, /^assignments?$/i] },
  { name: 'calendar', hashes: ['#/calendar', '#/events'], labels: [/^calendar$/i, /^events?$/i] },
];

const started = Date.now();
const blockedHosts = new Set();
let apiCounter = 0;
let logStream;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  if (logStream) logStream.write(line + '\n');
}

function slug(s) {
  return s.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80).toLowerCase() || 'x';
}

function timeLeft() {
  return TOTAL_BUDGET_MS - (Date.now() - started);
}

async function settle(page) {
  try {
    await page.waitForLoadState('networkidle', { timeout: 15_000 });
  } catch {
    /* SPA keeps polling; fine */
  }
  await page.waitForTimeout(SETTLE_MS);
}

async function scrollToBottom(page, rounds = 6) {
  let last = -1;
  for (let i = 0; i < rounds; i++) {
    const h = await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      return document.body.scrollHeight;
    });
    await page.waitForTimeout(1200);
    if (h === last) break;
    last = h;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function capture(page, name, manifest) {
  const base = path.join(OUT, 'pages', name);
  const entry = { name, url: page.url(), title: await page.title().catch(() => '') };
  try {
    await scrollToBottom(page);
    const text = await page.locator('body').innerText({ timeout: 10_000 });
    fs.writeFileSync(`${base}.txt`, text);
    entry.text = `${base}.txt`;
    entry.textChars = text.length;
  } catch (e) {
    entry.textError = String(e.message || e);
  }
  try {
    const aria = await page.locator('body').ariaSnapshot({ timeout: 10_000 });
    fs.writeFileSync(`${base}.aria.txt`, aria);
    entry.aria = `${base}.aria.txt`;
  } catch (e) {
    entry.ariaError = String(e.message || e);
  }
  try {
    await page.screenshot({ path: `${base}.png`, fullPage: true, timeout: 20_000 });
    entry.screenshot = `${base}.png`;
  } catch (e) {
    entry.screenshotError = String(e.message || e);
  }
  manifest.pages.push(entry);
  log(`captured ${name} (${entry.textChars || 0} chars) at ${entry.url}`);
}

function wireNetworkCapture(page) {
  page.on('requestfailed', (req) => {
    try {
      blockedHosts.add(new URL(req.url()).host);
    } catch {
      /* ignore */
    }
  });
  page.on('response', async (res) => {
    try {
      const ct = (res.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('json')) return;
      const url = new URL(res.url());
      if (!url.host.endsWith('seesaw.me')) return;
      const body = await res.text();
      if (!body || body.length < 2) return;
      apiCounter += 1;
      const file = path.join(OUT, 'api', `${String(apiCounter).padStart(3, '0')}-${slug(url.pathname)}.json`);
      fs.writeFileSync(file, body);
    } catch {
      /* response body gone or not text; ignore */
    }
  });
}

async function firstVisible(page, locators) {
  for (const loc of locators) {
    try {
      const l = loc.first();
      if (await l.isVisible({ timeout: 1500 })) return l;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function login(page) {
  log(`opening ${LOGIN_URL}`);
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await settle(page);

  // Seesaw's login page asks which kind of user you are.
  const familyBtn = await firstVisible(page, [
    page.getByRole('button', { name: /family/i }),
    page.getByRole('link', { name: /family/i }),
    page.getByText(/i'?m a family member/i),
    page.getByText(/^family$/i),
  ]);
  if (familyBtn) {
    log('selecting family login');
    await familyBtn.click().catch(() => {});
    await page.waitForTimeout(1500);
  }

  // Some tenants add an "sign in with email" step before the form.
  const emailOption = await firstVisible(page, [
    page.getByRole('button', { name: /sign in with email|continue with email|use email/i }),
    page.getByText(/sign in with email|continue with email/i),
  ]);
  if (emailOption) {
    await emailOption.click().catch(() => {});
    await page.waitForTimeout(1500);
  }

  const emailField = await firstVisible(page, [
    page.locator('input[type="email"]'),
    page.locator('input[name="email"]'),
    page.getByPlaceholder(/email/i),
    page.getByLabel(/email/i),
  ]);
  const passField = await firstVisible(page, [page.locator('input[type="password"]')]);
  if (!emailField || !passField) {
    await capture(page, 'login-page', { pages: [] }).catch(() => {});
    throw Object.assign(new Error('could not find email/password fields on the login page'), { code: 2 });
  }

  await emailField.fill(EMAIL);
  await passField.fill(PASSWORD);
  const submit = await firstVisible(page, [
    page.getByRole('button', { name: /sign in|log in|login|continue/i }),
    page.locator('button[type="submit"]'),
  ]);
  if (submit) await submit.click();
  else await passField.press('Enter');

  // Logged in == password field gone and we are off the login hash.
  try {
    await page.waitForFunction(
      () => !document.querySelector('input[type="password"]') && !location.hash.includes('login'),
      null,
      { timeout: 30_000 },
    );
  } catch {
    const errText = await page
      .locator('body')
      .innerText()
      .then((t) => t.split('\n').filter((l) => /incorrect|invalid|wrong|try again|not found|error/i.test(l)).slice(0, 5).join(' | '))
      .catch(() => '');
    await capture(page, 'login-failed', { pages: [] }).catch(() => {});
    throw Object.assign(new Error(`login did not complete${errText ? `: ${errText}` : ''}`), { code: 2 });
  }
  await settle(page);
  log(`logged in, now at ${page.url()}`);
}

async function openSection(page, section) {
  for (const hash of section.hashes) {
    if (hash === '#/') continue;
    try {
      await page.goto(`${APP}/${hash}`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await settle(page);
      const stillLogin = await page.locator('input[type="password"]').isVisible().catch(() => false);
      const text = await page.locator('body').innerText().catch(() => '');
      // A dead route in the SPA tends to bounce home or render an empty shell.
      if (!stillLogin && text.trim().length > 200 && !/page not found|404/i.test(text)) return `hash ${hash}`;
    } catch {
      /* try next */
    }
  }
  for (const label of section.labels) {
    const el = await firstVisible(page, [
      page.getByRole('link', { name: label }),
      page.getByRole('button', { name: label }),
      page.getByRole('tab', { name: label }),
      page.getByText(label),
    ]);
    if (el) {
      try {
        await el.click({ timeout: 5000 });
        await settle(page);
        return `nav "${label}"`;
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

async function main() {
  fs.mkdirSync(path.join(OUT, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'api'), { recursive: true });
  logStream = fs.createWriteStream(path.join(OUT, 'run.log'), { flags: 'a' });
  const manifest = { startedAt: new Date(started).toISOString(), pages: [], sections: {}, apiFiles: 0, blockedHosts: [] };

  if (!EMAIL || !PASSWORD) {
    log('SEESAW_EMAIL and/or SEESAW_PASSWORD are not set');
    return 1;
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: process.env.SEESAW_TZ || 'Asia/Dubai',
  });
  const page = await context.newPage();
  wireNetworkCapture(page);

  try {
    try {
      await login(page);
    } catch (e) {
      if (e.code) throw e;
      const msg = String(e.message || e);
      if (/ERR_TUNNEL|ERR_PROXY|403|net::ERR|Timeout.*goto|ERR_NAME_NOT_RESOLVED/i.test(msg)) {
        log(`could not reach ${APP}: ${msg}`);
        throw Object.assign(new Error(`network: ${msg}`), { code: 3 });
      }
      throw e;
    }

    await capture(page, 'home', manifest);
    manifest.sections.home = 'after login';

    for (const section of SECTIONS) {
      if (section.name === 'home') continue;
      if (timeLeft() < 30_000) {
        log('time budget exhausted, stopping section walk');
        break;
      }
      const how = await openSection(page, section);
      if (!how) {
        manifest.sections[section.name] = null;
        log(`section ${section.name}: not found`);
        continue;
      }
      manifest.sections[section.name] = how;
      await capture(page, section.name, manifest);
      // Open the first few unread-looking items in the inbox so their bodies get fetched.
      if (section.name === 'inbox' || section.name === 'announcements') {
        const items = page.getByRole('listitem');
        const n = Math.min(await items.count().catch(() => 0), 8);
        for (let i = 0; i < n; i++) {
          try {
            await items.nth(i).click({ timeout: 3000 });
            await page.waitForTimeout(1500);
            await capture(page, `${section.name}-item-${i + 1}`, manifest);
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
            await page.waitForTimeout(1000);
          } catch {
            /* ignore and move on */
          }
        }
      }
    }

    await context.storageState({ path: path.join(OUT, 'state.json') }).catch(() => {});
    return 0;
  } finally {
    manifest.apiFiles = apiCounter;
    manifest.blockedHosts = [...blockedHosts];
    manifest.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
    if (blockedHosts.size) log(`requests failed for hosts: ${[...blockedHosts].join(', ')}`);
    await browser.close().catch(() => {});
  }
}

main()
  .then((code) => {
    log(`done with exit code ${code}`);
    process.exit(code);
  })
  .catch((e) => {
    log(`error: ${e.stack || e}`);
    process.exit(e.code || 4);
  });
