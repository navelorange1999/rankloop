import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { validRevision } from './policy.mjs';

export function analyzeHtml(html, url, headers) {
  const $ = load(html);
  const findings = [];
  const add = (code, severity = 'error') => findings.push({ code, severity });
  const title = $('title').text().trim();
  const description = $('meta[name="description"]').attr('content')?.trim();
  const canonicals = $('link[rel="canonical"]');
  if (!title) add('missing-title');
  if (!description) add('missing-description');
  if (canonicals.length !== 1) add('canonical-count');
  else {
    try {
      if (
        new URL(canonicals.attr('href'), url).toString().replace(/\/$/, '') !==
        url.replace(/\/$/, '')
      )
        add('canonical-mismatch');
    } catch {
      add('invalid-canonical');
    }
  }
  const robots = [
    $('meta[name="robots"],meta[name="googlebot"]')
      .map((_, el) => $(el).attr('content') ?? '')
      .get()
      .join(','),
    headers['x-robots-tag'],
  ]
    .filter(Boolean)
    .join(',')
    .toLowerCase();
  if (/\b(noindex|none)\b/.test(robots)) add('noindex');
  if (!$('html').attr('lang')) add('missing-language');
  const h1Count = $('h1').length;
  if (h1Count !== 1) add('h1-count', 'warning');
  const structured = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      structured.push(JSON.parse($(el).text()));
    } catch {
      add('invalid-structured-data');
    }
  });
  if (!structured.length) add('missing-structured-data', 'warning');
  const imageAltMissing = $('img:not([alt])').length;
  if (imageAltMissing) add('missing-image-alt', 'warning');
  $('script,style,nav,footer,header').remove();
  const content = ($('main').text() || $('body').text()).replace(/\s+/g, ' ').trim();
  if (content.length < 40) add('thin-server-content', 'warning');
  return {
    findings,
    signals: {
      h1Count,
      structuredDataCount: structured.length,
      imageAltMissing,
      contentCharacters: content.length,
      contentHash: createHash('sha256').update(content).digest('hex'),
      titleCharacters: title.length,
      descriptionCharacters: description?.length ?? 0,
      revision: $('meta[name="rankloop-revision"]').attr('content') ?? null,
    },
  };
}

export async function scanTarget(
  target,
  {
    request,
    pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    delays = [0, 5000, 15000, 30000, 60000, 120000],
    canonicalOrigin = 'https://chankay.com',
    refreshTarget,
    guard = () => {},
  },
) {
  const attempts = [];
  let last;
  let versionStatus = 'unconfirmed';
  let expected = target;
  for (const delay of delays) {
    guard(delay);
    if (delay) await pause(delay);
    let retryWait = 0;
    try {
      last = await request(target.path);
      const revision = load(last.text)('meta[name="rankloop-revision"]').attr('content');
      const fingerprint = load(last.text)('meta[name="rankloop-fingerprint"]').attr('content');
      attempts.push({
        status: last.status,
        revision: validRevision(revision) ? revision : null,
        fingerprint: /^[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : null,
        observedAt: new Date().toISOString(),
      });
      if (expected.fingerprint && fingerprint !== expected.fingerprint && refreshTarget) {
        const fresh = await refreshTarget(target.path);
        if (fresh && Date.parse(fresh.revision) >= Date.parse(target.revision)) expected = fresh;
      }
      if (
        last.status === 200 &&
        validRevision(revision) &&
        (!target.revision || Date.parse(revision) >= Date.parse(target.revision)) &&
        (!expected.fingerprint || fingerprint === expected.fingerprint)
      ) {
        versionStatus = !target.revision
          ? 'observed'
          : revision === target.revision
            ? 'matched'
            : 'superseded';
        break;
      }
      versionStatus = last.status === 200 ? 'stale' : 'unavailable';
      if (last.status === 429 || last.status === 503) {
        const value = last.headers['retry-after'];
        const wait = /^\d+$/.test(value ?? '')
          ? Number(value) * 1000
          : Date.parse(value) - Date.now();
        if (wait > 120000) break;
        if (wait > 0) retryWait = wait;
      }
    } catch {
      attempts.push({ error: 'request-failed', observedAt: new Date().toISOString() });
    }
    if (retryWait > 0) {
      guard(retryWait);
      await pause(retryWait);
    }
  }
  const report = {
    path: target.path,
    expectedRevision: target.revision ?? null,
    expectedFingerprint: expected.fingerprint ?? null,
    versionStatus,
    attempts,
    findings: [],
  };
  if (!['matched', 'superseded', 'observed'].includes(versionStatus)) {
    report.findings.push({ code: 'version-unconfirmed', severity: 'error' });
    return report;
  }
  const analysis = analyzeHtml(
    last.text,
    new URL(target.path, canonicalOrigin).toString(),
    last.headers,
  );
  return { ...report, ...analysis, httpStatus: last.status, redirects: last.redirects ?? 0 };
}
