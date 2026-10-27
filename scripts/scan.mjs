import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { load } from 'cheerio';
import robotsParser from 'robots-parser';
import { createRequester } from '../src/http.mjs';
import {
  validateEvent,
  validateManifest,
  validatePath,
  targetEntries,
  retiredPaths,
  inventoryDifferences,
} from '../src/policy.mjs';
import { scanTarget, analyzeHtml } from '../src/scan.mjs';
import { confirmPublication } from '../src/discovery.mjs';
import { checkRetirement } from '../src/retirement.mjs';

const { values } = parseArgs({
  options: {
    fixture: { type: 'boolean', default: false },
    baseline: { type: 'boolean', default: false },
  },
});
const origin = values.fixture ? 'http://127.0.0.1:3000' : 'https://chankay.com';
const canonicalOrigin = 'https://chankay.com';
const transport = createRequester({ fixture: values.fixture });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  origin,
  mode: values.baseline ? 'baseline' : 'published',
  eventId: null,
  results: [],
  retired: [],
  errors: [],
};
let lastRequest = 0;
let interval = values.fixture ? 0 : 500;
const deadline = Date.now() + 20 * 60 * 1000;
function guard(delay = 0) {
  if (Date.now() + delay + 20000 > deadline) throw Error('Scan time budget exceeded');
}
async function request(path) {
  guard();
  const wait = interval - (Date.now() - lastRequest);
  if (wait > 0) await pause(wait);
  lastRequest = Date.now();
  return transport(path);
}
async function reliable(path) {
  for (const delay of [0, 5000, 15000]) {
    guard(delay);
    if (delay) await pause(delay);
    try {
      const response = await request(path);
      if (response.status === 200) return response;
    } catch {
      /* Bounded retry; no response bodies in logs. */
    }
  }
  throw Error('Public discovery unavailable');
}
async function persist() {
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/scan.json', JSON.stringify(report, null, 2));
}

async function discoverSitemap() {
  const xml = load((await reliable('/sitemap.xml')).text, { xmlMode: true });
  const paths = xml('url > loc')
    .map((_, el) => {
      const url = new URL(xml(el).text());
      if (url.origin !== canonicalOrigin) throw Error('Off-origin sitemap entry');
      return validatePath(url.pathname.replace(/\/$/, '') || '/');
    })
    .get();
  if (!paths.length || paths.length > 4000) throw Error('Invalid sitemap inventory');
  return paths;
}

try {
  let event;
  if (process.env.GITHUB_EVENT_PATH && process.env.GITHUB_EVENT_NAME === 'repository_dispatch') {
    const raw = await readFile(process.env.GITHUB_EVENT_PATH, 'utf8');
    if (raw.length > 65536) throw Error('Event exceeds budget');
    const envelope = JSON.parse(raw);
    if (envelope.action !== 'cms-publication') throw Error('Unexpected event type');
    event = validateEvent(envelope.client_payload);
    report.eventId = event.eventId;
    report.event = event;
  }
  const robotsResponse = await request('/robots.txt');
  if (robotsResponse.status !== 200 && robotsResponse.status !== 404)
    throw Error('Robots rules unavailable');
  const robots = robotsParser(
    `${origin}/robots.txt`,
    robotsResponse.status === 404 ? '' : robotsResponse.text,
  );
  interval = Math.max(interval, (robots.getCrawlDelay('Rankloop') ?? 0) * 1000);
  if (interval > 60000) throw Error('Crawl delay exceeds run budget');
  if (robots.isAllowed(`${origin}/sitemap.xml`, 'Rankloop') === false)
    throw Error('Sitemap disallowed by robots');
  let sitemapPaths = await discoverSitemap();
  let entries;
  if (values.baseline) {
    entries = sitemapPaths.map((path) => ({ path }));
    report.errors.push({ code: 'baseline-without-version-contract', severity: 'info' });
  } else {
    if (robots.isAllowed(`${origin}/api/seo/manifest`, 'Rankloop') === false)
      throw Error('Manifest disallowed by robots');
    const manifest = await reliable('/api/seo/manifest');
    entries = validateManifest(JSON.parse(manifest.text));
    entries = await confirmPublication(entries, event, {
      guard,
      delays: values.fixture ? [0, 20] : undefined,
      loadManifest: async () =>
        validateManifest(JSON.parse((await reliable('/api/seo/manifest')).text)),
    });
    for (const delay of values.fixture ? [0, 20] : [5000, 15000, 30000]) {
      const differences = inventoryDifferences(entries, sitemapPaths);
      if (!differences.missing.length && !differences.extra.length) break;
      guard(delay);
      if (delay) await pause(delay);
      sitemapPaths = await discoverSitemap();
    }
    for (const path of inventoryDifferences(entries, sitemapPaths).extra)
      report.errors.push({ code: 'orphan-sitemap-entry', severity: 'error', path });
  }
  const targets = targetEntries(entries, event).map((entry) => ({
    ...entry,
    revision:
      event?.revision &&
      entry.collection === event.collection &&
      Date.parse(event.revision) > Date.parse(entry.revision)
        ? event.revision
        : entry.revision,
  }));
  if (targets.length > 200)
    throw Error('Page budget exceeded; split the inventory before increasing the limit');
  if (!event && !targets.length) throw Error('Empty scan');
  for (const entry of targets) {
    guard();
    if (robots.isAllowed(new URL(entry.path, origin).toString(), 'Rankloop') === false) {
      report.results.push({
        path: entry.path,
        versionStatus: 'blocked',
        findings: [{ code: 'robots-blocked', severity: 'error' }],
      });
      await persist();
      continue;
    }
    let result;
    if (values.baseline) {
      const response = await reliable(entry.path);
      result = {
        path: entry.path,
        versionStatus: 'unverified-baseline',
        httpStatus: response.status,
        ...analyzeHtml(
          response.text,
          new URL(entry.path, canonicalOrigin).toString(),
          response.headers,
        ),
      };
    } else
      result = await scanTarget(entry, {
        request,
        guard,
        canonicalOrigin,
        delays: values.fixture ? [0, 20] : undefined,
        refreshTarget: async (path) =>
          validateManifest(JSON.parse((await reliable('/api/seo/manifest')).text)).find(
            (x) => x.path === path,
          ),
      });
    if (!sitemapPaths.includes(entry.path))
      result.findings.push({ code: 'missing-from-sitemap', severity: 'error' });
    if (robots.isAllowed(new URL(entry.path, origin).toString(), 'Googlebot') === false)
      result.findings.push({ code: 'googlebot-blocked', severity: 'error' });
    report.results.push(result);
    await persist();
  }
  const retired = [
    ...new Set([
      ...retiredPaths(entries, event),
      ...(!values.baseline
        ? sitemapPaths.filter((path) => !entries.some((x) => x.path === path))
        : []),
    ]),
  ];
  if (retired.length > 200) throw Error('Retirement budget exceeded');
  for (const path of retired) {
    guard();
    if (robots.isAllowed(new URL(path, origin).toString(), 'Rankloop') === false) {
      report.retired.push({ path, status: 'blocked', severity: 'error' });
      continue;
    }
    let status = 'unexpected-live';
    for (const delay of values.fixture ? [0, 20] : [0, 5000, 15000, 30000, 60000]) {
      guard(delay);
      if (delay) await pause(delay);
      try {
        status = await checkRetirement(path, entries, { request });
        if (['removed', 'redirected', 'soft-404'].includes(status)) break;
      } catch {
        status = 'request-failed';
      }
    }
    report.retired.push({
      path,
      status,
      severity: ['removed', 'redirected'].includes(status)
        ? 'info'
        : status === 'soft-404'
          ? 'warning'
          : 'error',
    });
    await persist();
  }
} catch (error) {
  const reasons = [
    'Public discovery unavailable',
    'Page budget exceeded; split the inventory before increasing the limit',
    'Scan time budget exceeded',
    'Retirement budget exceeded',
    'Publication intent is not confirmed by public inventory',
    'Invalid or empty public inventory',
    'Invalid publication event',
    'Invalid publication intent',
    'Invalid sitemap inventory',
    'Off-origin sitemap entry',
    'Unsafe public path',
  ];
  report.errors.push({
    code: 'scan-incomplete',
    severity: 'error',
    reason: reasons.includes(error.message)
      ? error.message
      : 'Discovery, policy or response validation failed',
  });
} finally {
  report.finishedAt = new Date().toISOString();
  report.errorCount =
    report.errors.filter((x) => x.severity === 'error').length +
    report.results.flatMap((x) => x.findings).filter((x) => x.severity === 'error').length +
    report.retired.filter((x) => x.severity === 'error').length;
  await persist();
  const summary = `Rankloop: ${report.results.length} pages, ${report.retired.length} retired routes, ${report.errorCount} errors.\n\nMode: ${report.mode}. Results: scan.json in the run artifact.\n`;
  await writeFile('artifacts/summary.md', summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary.trim());
  process.exitCode = report.errorCount ? 1 : 0;
}
