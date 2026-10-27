import { isIP } from 'node:net';

export const COLLECTIONS = ['pages', 'posts', 'categories', 'series', 'media', 'site-config'];
export const LOCALES = ['en', 'zh-CN'];

export function validatePath(path) {
  if (
    typeof path !== 'string' ||
    path.length > 1024 ||
    !/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/.test(path) ||
    path.split('/').some((x) => ['_preview', 'api', '_next'].includes(x))
  )
    throw Error('Unsafe public path');
  return path;
}

export function validateEvent(event) {
  if (
    !event ||
    event.schemaVersion !== 1 ||
    !COLLECTIONS.includes(event.collection) ||
    !/^[a-f0-9]{64}$/.test(event.eventId) ||
    !Array.isArray(event.slugs) ||
    event.slugs.length > 20 ||
    !Array.isArray(event.locales) ||
    event.locales.length === 0 ||
    event.locales.length > 2 ||
    !event.locales.every((x) => LOCALES.includes(x))
  )
    throw Error('Invalid publication event');
  for (const slug of event.slugs) validatePath(slug === '/' ? '/' : `/${slug}`);
  if (event.revision && !validRevision(event.revision)) throw Error('Invalid publication revision');
  if (!['published', 'withdrawn', 'reconcile'].includes(event.publication?.state))
    throw Error('Invalid publication intent');
  if (event.publication.state !== 'reconcile') {
    validatePath(event.publication.slug === '/' ? '/' : `/${event.publication.slug}`);
    if (!event.slugs.includes(event.publication.slug)) throw Error('Publication slug not selected');
  }
  const publication = {
    state: event.publication.state,
    ...(event.publication.state !== 'reconcile' ? { slug: event.publication.slug } : {}),
  };
  return {
    schemaVersion: 1,
    collection: event.collection,
    slugs: [...new Set(event.slugs)],
    locales: [...new Set(event.locales)],
    eventId: event.eventId,
    publication,
    ...(event.revision ? { revision: event.revision } : {}),
  };
}

export function validRevision(value) {
  return (
    typeof value === 'string' &&
    value.length === 24 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function validateManifest(data) {
  if (
    data?.schemaVersion !== 1 ||
    !Array.isArray(data.entries) ||
    data.entries.length === 0 ||
    data.entries.length > 4000
  )
    throw Error('Invalid or empty public inventory');
  const seen = new Set();
  for (const entry of data.entries) {
    validatePath(entry.path);
    if (
      !['pages', 'posts'].includes(entry.collection) ||
      !LOCALES.includes(entry.locale) ||
      !validRevision(entry.revision) ||
      !/^[a-f0-9]{64}$/.test(entry.fingerprint) ||
      typeof entry.slug !== 'string'
    )
      throw Error('Invalid public inventory entry');
    validatePath(entry.slug === '/' ? '/' : `/${entry.slug}`);
    if (seen.has(entry.path)) throw Error('Duplicate public route');
    seen.add(entry.path);
  }
  return data.entries;
}

export function targetEntries(entries, event) {
  if (!event) return entries;
  return entries.filter(
    (entry) =>
      event.locales.includes(entry.locale) &&
      (!['pages', 'posts'].includes(event.collection) ||
        (entry.collection === event.collection && event.slugs.includes(entry.slug))),
  );
}

export function inventoryDifferences(entries, paths) {
  const live = new Set(entries.map((x) => x.path));
  const advertised = new Set(paths);
  return {
    missing: [...live].filter((path) => !advertised.has(path)),
    extra: [...advertised].filter((path) => !live.has(path)),
  };
}

export function retiredPaths(entries, event) {
  if (!event || !['pages', 'posts', 'categories'].includes(event.collection)) return [];
  const live = new Set(entries.map((x) => x.path));
  const paths = [];
  const slugs =
    event.collection === 'categories'
      ? [...new Set(entries.filter((x) => x.collection === 'posts').map((x) => x.slug))]
      : event.slugs;
  for (const locale of event.locales)
    for (const slug of slugs) {
      const prefix = locale === 'en' ? '' : '/zh-CN';
      const candidates =
        event.collection === 'pages'
          ? [slug === '/' ? prefix || '/' : `${prefix}/${slug}`]
          : [`${prefix}/technical/${slug}`, `${prefix}/trading/${slug}`, `${prefix}/posts/${slug}`];
      for (const path of candidates) if (!live.has(path)) paths.push(validatePath(path));
    }
  return [...new Set(paths)];
}

export function isPublicAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(ip) !== 6 || !/^[23]/i.test(ip)) return false;
  const first = Number.parseInt(ip.split(':')[0], 16),
    second = Number.parseInt(ip.split(':')[1] || '0', 16);
  return (
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) &&
    first !== 0x2002 &&
    !(first === 0x3fff && second < 0x1000)
  );
}
