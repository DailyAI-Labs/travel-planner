/** Compact durations: what people type into a small box, and what we show back. */

export const DEFAULT_VISIT_MINUTES = 60;

// Bare number, "1h30", "1h", "45m", "1:30", "1.5h", and the comma decimal an
// Italian keyboard produces. Anything else is rejected rather than guessed at.
const HOURS_AND_MINUTES = /^(\d+)\s*[h:]\s*(\d{1,2})\s*m?$/i;
const HOURS_ONLY = /^(\d+(?:[.,]\d+)?)\s*h$/i;
const MINUTES_ONLY = /^(\d+)\s*(?:m|min|')?$/i;

/**
 * Parse a typed duration into whole minutes.
 *
 * Returns null for anything unrecognised so the caller can keep the raw text
 * on screen and let the correction happen in place, rather than silently
 * turning a typo into a number.
 */
export function parseDuration(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;

  const both = trimmed.match(HOURS_AND_MINUTES);
  if (both) {
    const minutes = Number(both[2]);
    return minutes > 59 ? null : Number(both[1]) * 60 + minutes;
  }

  const hours = trimmed.match(HOURS_ONLY);
  if (hours) return Math.round(Number(hours[1].replace(',', '.')) * 60);

  const minutes = trimmed.match(MINUTES_ONLY);
  if (minutes) return Number(minutes[1]);

  return null;
}

/** 90 becomes "1h 30m"; 120 becomes "2h"; 0 becomes "" so the box reads empty. */
export function formatDuration(minutes) {
  if (!minutes) return '';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}
