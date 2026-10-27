export async function confirmPublication(
  entries,
  event,
  {
    loadManifest,
    pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    delays = [0, 5000, 15000, 30000, 60000],
    guard = () => {},
  },
) {
  if (
    !['published', 'withdrawn'].includes(event?.publication.state) ||
    !['pages', 'posts'].includes(event.collection)
  )
    return entries;
  const confirmedInventory = () =>
    event.locales.every((locale) => {
      const matching = entries.filter(
        (x) =>
          x.collection === event.collection &&
          x.slug === event.publication.slug &&
          x.locale === locale,
      );
      return event.publication.state === 'withdrawn'
        ? matching.length === 0
        : matching.some(
            (x) => !event.revision || Date.parse(x.revision) >= Date.parse(event.revision),
          );
    });
  for (const delay of delays) {
    guard(delay);
    if (delay) await pause(delay);
    const confirmed = confirmedInventory();
    if (confirmed) return entries;
    entries = await loadManifest();
  }
  if (!confirmedInventory()) throw Error('Publication intent is not confirmed by public inventory');
  return entries;
}
