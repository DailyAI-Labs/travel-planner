/** Shared presentation helpers: the screen and the Markdown export must agree. */

export function formatDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`;
}

export function formatDistance(meters) {
  return meters < 1000 ? `${meters} m` : `${(meters / 1000).toFixed(1)} km`;
}

export function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * When a stop is reached and left, e.g. `09:15 → 10:15`.
 *
 * A stop with no time spent there is reached and left at once, so it shows a
 * single time. Null when the plan carries no times for the stop. `separator`
 * exists for the PDF, whose built-in fonts have no arrow.
 */
export function formatStopTimes(point, separator = ' → ') {
  if (!point.arrival) return null;
  const arrival = formatTime(point.arrival);
  const departure = point.departure ? formatTime(point.departure) : arrival;
  return departure === arrival ? arrival : `${arrival}${separator}${departure}`;
}

/**
 * What happens at a stop besides arriving and leaving: the visit itself and
 * any wait for the place to open, e.g. `stay 1 h 00 min · wait 15 min for
 * opening`. Null when neither applies.
 */
export function describeStay(point, t) {
  const parts = [];
  if (point.visit_seconds > 0) {
    parts.push(t('results.stay', { duration: formatDuration(point.visit_seconds) }));
  }
  if (point.wait_seconds > 0) {
    parts.push(t('results.wait', { duration: formatDuration(point.wait_seconds) }));
  }
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Phrase a leg's vehicle note in the reader's language.
 *
 * Mirrors `describeFailure`: the backend sends a stable code, and anything it
 * does not recognise falls back to the English sentence the backend already
 * composed, which beats showing nothing.
 */
export function describeLegNote(leg, t) {
  if (!leg.note && !leg.note_code) return null;
  if (leg.note_code) {
    const phrased = t(`note.${leg.note_code}`);
    if (phrased !== `note.${leg.note_code}`) return phrased;
  }
  return leg.note;
}

/** A day whose last stop repeats its first is a loop. */
export function isLoop(waypoints) {
  if (waypoints.length < 2) return false;
  const first = waypoints[0];
  const last = waypoints[waypoints.length - 1];
  return first.lat === last.lat && first.lon === last.lon;
}
