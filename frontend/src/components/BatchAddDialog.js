import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { parseDuration } from './duration';

// Leading list markers, stripped repeatedly so that combinations like
// "1) - Colosseo" come out clean.
const MARKERS = [
  /^\s*[-*•‣▪–—·>]+\s*/,          // - * • ‣ ▪ – — · >
  /^\s*\[[ xX✓]?\]\s*/,           // [ ] [x] [] markdown checkboxes
  /^\s*\(?\s*\d+\s*[).\]:]\s*/,   // 1. 2) (3) 4] 5:
  // "1 - Colosseo". The space after the dash is required, so that names like
  // "9-11 Memorial" keep their number.
  /^\s*\d+\s*[-–—]\s+/,
  /^\s*#+\s*\d*\s*[).:]?\s*/,     // # Colosseo, #1 Colosseo
];

function stripMarkers(line) {
  let out = line;
  let changed = true;
  while (changed) {
    changed = false;
    for (const marker of MARKERS) {
      const next = out.replace(marker, '');
      if (next !== out) {
        out = next;
        changed = true;
      }
    }
  }
  return out.trim();
}

// "9", "9:30", "09.30": an hour of the day, optionally with minutes.
const CLOCK = String.raw`(\d{1,2})(?:[:.](\d{2}))?`;
// "9-19", "9:00 – 19:30", "10:00-" (opens only), "-18:00" (closes only).
const HOURS = new RegExp(String.raw`^(?:${CLOCK})?\s*[-–—]\s*(?:${CLOCK})?$`);

/** "9", "30" becomes "09:30"; 24:00 becomes 23:59, the last a time box holds. */
function clock(hours, minutes = '0') {
  const h = Number(hours);
  const m = Number(minutes);
  if (h > 24 || m > 59 || (h === 24 && m > 0)) return null;
  if (h === 24) return '23:59';
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Read one "| ..." field as opening hours, or null if it is not shaped like
 * them. Returns `{ error: true }` for hours that are shaped right but cannot
 * be: a 25th hour, or closing no later than opening.
 */
function parseHours(field) {
  const match = field.match(HOURS);
  if (!match || (!match[1] && !match[3])) return null;
  const opens = match[1] ? clock(match[1], match[2]) : '';
  const closes = match[3] ? clock(match[3], match[4]) : '';
  if (opens === null || closes === null) return { error: true };
  if (opens && closes && closes <= opens) return { error: true };
  return { opens, closes };
}

/**
 * Read the "| ..." fields after a name: a stay, opening hours, or both.
 *
 * Told apart by shape rather than position, so "Pantheon | 9-19" works as well
 * as "Pantheon | 1h | 9-19". Anything unreadable, or the same kind given
 * twice, marks the whole entry as an error instead of being guessed at.
 */
function parseDetails(fields) {
  const details = {};
  for (const field of fields) {
    if (!field) continue;
    const hours = parseHours(field);
    if (hours) {
      if (hours.error || 'opens' in details) return { error: true };
      details.opens = hours.opens;
      details.closes = hours.closes;
      continue;
    }
    const minutes = parseDuration(field);
    if (minutes === null || 'visitMinutes' in details) return { error: true };
    details.visitMinutes = minutes;
  }
  return details;
}

/**
 * Turn pasted text into a list of places, each with its optional details.
 *
 * Handles the shapes people actually paste — hyphens, asterisks, bullets,
 * "1.", markdown checkboxes — and drops blanks and repeats. Splitting is by
 * line, because commas belong inside place names ("Piazza San Marco,
 * Venezia"); the one exception is a single line, which cannot be a list any
 * other way.
 *
 * A line may carry a stay and opening hours after pipes:
 * "Colosseo | 1h30 | 9:00-19:00". Each entry is `{ name, raw, details }`,
 * where `raw` is the line as pasted and `details` holds whichever of
 * `visitMinutes`, `opens` and `closes` were given — or `error: true` when a
 * field could not be read, so the line can be handed back for correcting.
 */
export function parsePlaceList(text) {
  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.trim());
  const items =
    nonEmpty.length === 1 && nonEmpty[0].includes(',')
      ? nonEmpty[0].split(',')
      : lines;

  const seen = new Set();
  const entries = [];

  for (const raw of items) {
    const [first, ...fields] = raw.split('|').map((part) => part.trim());
    const name = stripMarkers(first);
    if (!name) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ name, raw: raw.trim(), details: parseDetails(fields) });
  }

  return entries;
}

function BatchAddDialog({ onAdd, onClose, existingNames }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [progress, setProgress] = useState(null);
  const [failures, setFailures] = useState([]);
  const textareaRef = useRef(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const running = progress !== null;

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !running) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, running]);

  const parsed = parsePlaceList(text);
  const known = new Set(existingNames.map((name) => name.toLowerCase()));
  const unseen = parsed.filter((entry) => !known.has(entry.name.toLowerCase()));
  const unreadable = unseen.filter((entry) => entry.details.error);
  const fresh = unseen.filter((entry) => !entry.details.error);
  const duplicates = parsed.length - unseen.length;

  const runBatch = async () => {
    setFailures([]);
    setProgress({ done: 0, total: fresh.length });

    const failed = [];
    for (let i = 0; i < fresh.length; i += 1) {
      const entry = fresh[i];
      try {
        const result = await onAdd(entry.name, entry.details);
        if (!result.ok) failed.push(entry);
      } catch {
        failed.push(entry);
      }
      setProgress({ done: i + 1, total: fresh.length });
    }

    setProgress(null);
    const leftover = [...failed, ...unreadable];
    if (leftover.length === 0) {
      onClose();
      return;
    }
    // Keep the dialog open with only what did not make it left in the box,
    // exactly as pasted, so it can be corrected and retried without retyping
    // the ones that worked.
    setFailures(failed);
    setText(leftover.map((entry) => entry.raw).join('\n'));
  };

  return (
    <div className="modal-backdrop" onMouseDown={running ? undefined : onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h3 id="batch-title">{t('batch.title')}</h3>
        <p className="modal-help">{t('batch.help')}</p>

        <textarea
          ref={textareaRef}
          className="batch-input"
          rows={9}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={t('batch.placeholder')}
          aria-label={t('batch.title')}
          disabled={running}
        />

        <p className="batch-count">
          {fresh.length > 0
            ? t('batch.detected', { count: fresh.length })
            : t('batch.detectedNone')}
          {duplicates > 0 && ` · ${t('batch.duplicates', { count: duplicates })}`}
        </p>

        {unreadable.length > 0 && (
          <p className="add-error">
            {t('batch.unreadable', {
              names: unreadable.map((entry) => entry.name).join(', '),
            })}
          </p>
        )}

        {failures.length > 0 && (
          <p className="add-error" role="alert">
            {t('batch.someFailed', { count: failures.length })}
          </p>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={running}>
            {t('batch.cancel')}
          </button>
          <button
            type="button"
            className="primary-inline"
            onClick={runBatch}
            disabled={running || fresh.length === 0}
          >
            {running
              ? t('batch.adding', { done: progress.done, total: progress.total })
              : t('batch.add', { count: fresh.length })}
          </button>
        </div>
      </div>
    </div>
  );
}

export default BatchAddDialog;
