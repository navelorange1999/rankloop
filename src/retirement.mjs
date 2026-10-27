import { load } from 'cheerio';
import { validatePath, validRevision } from './policy.mjs';

export async function checkRetirement(path, entries, { request }) {
  let response = await request(path);
  if ([404, 410].includes(response.status)) return 'removed';
  if (response.status !== 200) return 'unavailable';
  const $ = load(response.text);
  const robots = $('meta[name="robots"]')
    .map((_, el) => $(el).attr('content') ?? '')
    .get()
    .join(',');
  // Next.js can stream a not-found page with status 200; retain this as a warning.
  if (
    /\b(noindex|none)\b/i.test(robots) &&
    !$('meta[name="rankloop-revision"]').length &&
    !$('meta[name="rankloop-fingerprint"]').length
  )
    return 'soft-404';
  const refresh = $('meta[http-equiv="refresh"]').attr('content');
  let destination = new URL(response.url);
  if (refresh) {
    const match = /^0;url=(.+)$/i.exec(refresh);
    if (!match) return 'unexpected-live';
    destination = new URL(match[1], response.url);
    if (
      destination.origin !== new URL(response.url).origin ||
      destination.search ||
      destination.hash
    )
      return 'unexpected-live';
    validatePath(destination.pathname);
  }
  const expected = entries.find((x) => x.path === destination.pathname && x.path !== path);
  if (!expected) return 'unexpected-live';
  if (refresh) response = await request(destination.pathname);
  const final = load(response.text);
  const revision = final('meta[name="rankloop-revision"]').attr('content');
  const fingerprint = final('meta[name="rankloop-fingerprint"]').attr('content');
  return response.status === 200 &&
    validRevision(revision) &&
    Date.parse(revision) >= Date.parse(expected.revision) &&
    fingerprint === expected.fingerprint
    ? 'redirected'
    : 'unexpected-live';
}
