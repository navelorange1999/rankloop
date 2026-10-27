import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateEvent,
  validatePath,
  isPublicAddress,
  targetEntries,
  validateManifest,
  retiredPaths,
  inventoryDifferences,
} from '../src/policy.mjs';
import { analyzeHtml, scanTarget } from '../src/scan.mjs';
import { confirmPublication } from '../src/discovery.mjs';
import { checkRetirement } from '../src/retirement.mjs';

const old = '2026-01-01T00:00:00.000Z';
const current = '2026-01-02T00:00:00.000Z';
const html = (revision) =>
  `<html lang="en"><head><title>Fixture title</title><meta name="description" content="Description"><link rel="canonical" href="https://chankay.com/"><meta name="rankloop-revision" content="${revision}"></head><body><main><h1>Title</h1><p>Useful text</p></main></body></html>`;

test('rejects unsafe paths, events and network addresses', () => {
  for (const path of [
    '//evil.test',
    '/../admin',
    '/%2e%2e/admin',
    '/_preview/x',
    '/api/private',
    '/x?secret=1',
    '/a\\b',
  ])
    assert.throws(() => validatePath(path));
  for (const ip of [
    '127.0.0.1',
    '10.1.1.1',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
    '100.64.0.1',
  ])
    assert.equal(isPublicAddress(ip), false);
  for (const ip of ['8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true);
  assert.throws(() => validateEvent({ collection: 'pages', slugs: ['/'] }));
  assert.throws(() =>
    validateEvent({
      schemaVersion: 1,
      collection: 'pages',
      slugs: ['$(anything)'],
      locales: ['en'],
      eventId: 'a'.repeat(64),
    }),
  );
});

test('incremental selection is scoped, while shared changes fan out', () => {
  const entries = [
    { path: '/', collection: 'pages', slug: '/', locale: 'en', revision: current },
    { path: '/about', collection: 'pages', slug: 'about', locale: 'en', revision: current },
  ];
  const event = validateEvent({
    schemaVersion: 1,
    collection: 'pages',
    slugs: ['/'],
    locales: ['en'],
    revision: old,
    eventId: 'a'.repeat(64),
    publication: { state: 'published', slug: '/' },
  });
  assert.deepEqual(targetEntries(entries, event), [entries[0]]);
  assert.equal(targetEntries(entries, { ...event, collection: 'site-config' }).length, 2);
});

test('stale HTML retries and is never audited as the expected live revision', async () => {
  let calls = 0;
  const response = () => ({
    status: 200,
    text: html(++calls === 1 ? old : current),
    url: 'https://chankay.com/',
    headers: {},
  });
  const result = await scanTarget(
    { path: '/', revision: current },
    {
      request: response,
      pause: async () => {},
      delays: [0, 0],
      canonicalOrigin: 'https://chankay.com',
    },
  );
  assert.equal(calls, 2);
  assert.equal(result.versionStatus, 'matched');
  assert.equal(result.attempts.length, 2);
  const stale = await scanTarget(
    { path: '/', revision: current },
    {
      request: () => ({ status: 200, text: html(old), headers: {}, url: 'https://chankay.com/' }),
      pause: async () => {},
      delays: [0, 0],
      canonicalOrigin: 'https://chankay.com',
    },
  );
  assert.equal(stale.versionStatus, 'stale');
  assert.equal(
    stale.findings.some((x) => x.code === 'version-unconfirmed'),
    true,
  );
});

test('a newer rendered version is explicitly marked superseded', async () => {
  const result = await scanTarget(
    { path: '/', revision: old },
    {
      request: () => ({
        status: 200,
        text: html(current),
        headers: {},
        url: 'https://chankay.com/',
      }),
      pause: async () => {},
      delays: [0],
      canonicalOrigin: 'https://chankay.com',
    },
  );
  assert.equal(result.versionStatus, 'superseded');
});

test('HTML analysis separates deterministic SEO failures from GEO readiness signals', () => {
  const result = analyzeHtml(html(current), 'https://chankay.com/', {});
  assert.equal(
    result.findings.some((x) => x.severity === 'error'),
    false,
  );
  assert.equal(result.signals.structuredDataCount, 0);
  assert.equal(result.signals.h1Count, 1);
  const broken = analyzeHtml(
    '<html><head><meta name="robots" content="noindex"></head><body>text</body></html>',
    'https://chankay.com/',
    {},
  );
  assert.equal(
    broken.findings.some((x) => x.code === 'noindex'),
    true,
  );
  assert.equal(
    broken.findings.some((x) => x.code === 'missing-title'),
    true,
  );
});

test('network failures are retried, while redirects and 404 do not pass as live pages', async () => {
  let calls = 0;
  const result = await scanTarget(
    { path: '/', revision: current },
    {
      request: () => {
        if (++calls === 1) throw Error('network');
        return { status: 200, text: html(current), headers: {}, url: 'https://chankay.com/' };
      },
      pause: async () => {},
      delays: [0, 0],
      canonicalOrigin: 'https://chankay.com',
    },
  );
  assert.equal(result.versionStatus, 'matched');
  assert.equal(calls, 2);
});

test('stale dependency fingerprints fail even when the content timestamp matches', async () => {
  const result = await scanTarget(
    { path: '/', revision: current, fingerprint: 'a'.repeat(64) },
    {
      request: () => ({
        status: 200,
        text: html(current),
        headers: {},
        url: 'https://chankay.com/',
      }),
      pause: async () => {},
      delays: [0, 0],
      canonicalOrigin: 'https://chankay.com',
    },
  );
  assert.equal(result.versionStatus, 'stale');
});

test('a refresh can confirm a newer public fingerprint without mislabeling an older version', async () => {
  const result = await scanTarget(
    { path: '/', revision: old, fingerprint: 'a'.repeat(64) },
    {
      request: () => ({
        status: 200,
        text: html(current).replace(
          '</head>',
          `<meta name="rankloop-fingerprint" content="${'b'.repeat(64)}"></head>`,
        ),
        headers: {},
        url: 'https://chankay.com/',
      }),
      refreshTarget: async () => ({ path: '/', revision: current, fingerprint: 'b'.repeat(64) }),
      pause: async () => {},
      delays: [0],
      canonicalOrigin: 'https://chankay.com',
    },
  );
  assert.equal(result.versionStatus, 'superseded');
});

test('removed and moved slugs produce bounded retirement checks', () => {
  assert.deepEqual(
    retiredPaths([{ path: '/trading/new' }], {
      collection: 'posts',
      locales: ['en'],
      slugs: ['new', 'old'],
    }),
    ['/technical/new', '/posts/new', '/technical/old', '/trading/old', '/posts/old'],
  );
});

test('empty or malformed manifests fail closed', () => {
  assert.throws(() => validateManifest({ schemaVersion: 1, entries: [] }));
  assert.throws(() =>
    validateManifest({
      schemaVersion: 1,
      entries: [{ path: '/', collection: 'pages', locale: 'en', revision: current, slug: '/' }],
    }),
  );
});

test('rate limiting honors a bounded Retry-After before retry', async () => {
  let calls = 0;
  const pauses = [];
  const result = await scanTarget(
    { path: '/', revision: current },
    {
      request: () =>
        ++calls === 1
          ? { status: 429, text: '', headers: { 'retry-after': '2' } }
          : { status: 200, text: html(current), headers: {} },
      pause: async (ms) => pauses.push(ms),
      delays: [0, 0],
    },
  );
  assert.equal(result.versionStatus, 'matched');
  assert.deepEqual(pauses, [2000]);
});

test('a publication absent from fresh inventory cannot be accepted as a retired URL', async () => {
  const event = {
    collection: 'pages',
    locales: ['en'],
    revision: current,
    publication: { state: 'published', slug: 'new' },
  };
  await assert.rejects(
    confirmPublication([], event, {
      loadManifest: async () => [],
      pause: async () => {},
      delays: [0, 0],
    }),
    /not confirmed/,
  );
  const fresh = [{ collection: 'pages', slug: 'new', locale: 'en', revision: current }];
  assert.deepEqual(
    await confirmPublication([], event, {
      loadManifest: async () => fresh,
      pause: async () => {},
      delays: [0, 0],
    }),
    fresh,
  );
});

test('category changes check old section and legacy paths', () => {
  assert.deepEqual(
    retiredPaths([{ path: '/trading/article', collection: 'posts', slug: 'article' }], {
      collection: 'categories',
      locales: ['en'],
      slugs: ['technical'],
    }),
    ['/technical/article', '/posts/article'],
  );
});

test('deadline failure escapes retry handling before any further request', async () => {
  let calls = 0;
  await assert.rejects(
    scanTarget(
      { path: '/', revision: current },
      {
        request: () => {
          calls++;
          throw Error('network');
        },
        guard: () => {
          throw Error('budget');
        },
        delays: [0, 0],
      },
    ),
    /budget/,
  );
  assert.equal(calls, 0);
});

test('withdrawal waits until the public inventory no longer lists the article', async () => {
  const event = {
    collection: 'posts',
    locales: ['en'],
    publication: { state: 'withdrawn', slug: 'old' },
  };
  const entries = [{ collection: 'posts', slug: 'old', locale: 'en', revision: old }];
  await assert.rejects(
    confirmPublication(entries, event, {
      loadManifest: async () => entries,
      pause: async () => {},
      delays: [0, 0],
    }),
    /not confirmed/,
  );
  assert.deepEqual(
    await confirmPublication(entries, event, {
      loadManifest: async () => [],
      pause: async () => {},
      delays: [0, 0],
    }),
    [],
  );
});

test('streamed Next.js not-found responses remain visible as soft 404 warnings', async () => {
  assert.equal(
    await checkRetirement('/old', [], {
      request: async () => ({
        status: 200,
        url: 'https://chankay.com/old',
        text: '<meta name="robots" content="index"><meta name="robots" content="noindex"><h1>Not found</h1>',
      }),
    }),
    'soft-404',
  );
});

test('streamed redirects only pass after confirming a live destination fingerprint', async () => {
  const fingerprint = 'a'.repeat(64);
  let calls = 0;
  assert.equal(
    await checkRetirement(
      '/posts/new',
      [{ path: '/technical/new', revision: current, fingerprint }],
      {
        request: async (path) =>
          ++calls === 1
            ? {
                status: 200,
                url: 'https://chankay.com/posts/new',
                text: '<meta http-equiv="refresh" content="0;url=/technical/new">',
              }
            : {
                status: 200,
                url: 'https://chankay.com' + path,
                text: html(current).replace(
                  '</head>',
                  `<meta name="rankloop-fingerprint" content="${fingerprint}"></head>`,
                ),
              },
      },
    ),
    'redirected',
  );
  assert.equal(calls, 2);
});

test('Retry-After never gets bypassed when the remaining time cannot honor it', async () => {
  let calls = 0;
  await assert.rejects(
    scanTarget(
      { path: '/', revision: current },
      {
        request: () => {
          calls++;
          return { status: 429, text: '', headers: { 'retry-after': '60' } };
        },
        guard: (delay) => {
          if (delay > 30000) throw Error('Scan time budget exceeded');
        },
        pause: async () => {},
        delays: [0, 0],
      },
    ),
    /budget/,
  );
  assert.equal(calls, 1);
});

test('inventory comparison detects both missing and orphan sitemap URLs', () => {
  assert.deepEqual(inventoryDifferences([{ path: '/' }, { path: '/new' }], ['/', '/old']), {
    missing: ['/new'],
    extra: ['/old'],
  });
});
