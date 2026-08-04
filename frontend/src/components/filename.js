/** Naming for exported files: both exporters must agree on it. */

/** `Rome` on 2026-08-04 becomes `itinerary-rome-2026-08-04.md`. */
export function itineraryFilename(area, extension, now = new Date()) {
  // Decompose first so "Zürich" slugs to "zurich" rather than "z-rich".
  const slug = (area || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  // Local parts, not toISOString: east of UTC that stamps yesterday's date
  // on anything exported after midnight.
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  const stem = slug ? `itinerary-${slug}-${date}` : `itinerary-${date}`;
  return `${stem}.${extension}`;
}
