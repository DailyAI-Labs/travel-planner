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
