import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';

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

/**
 * Turn pasted text into a list of place names.
 *
 * Handles the shapes people actually paste — hyphens, asterisks, bullets,
 * "1.", markdown checkboxes — and drops blanks and repeats. Splitting is by
 * line, because commas belong inside place names ("Piazza San Marco,
 * Venezia"); the one exception is a single line, which cannot be a list any
 * other way.
 */
export function parsePlaceList(text) {
  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.trim());
  const items =
    nonEmpty.length === 1 && nonEmpty[0].includes(',')
      ? nonEmpty[0].split(',')
      : lines;

  const seen = new Set();
  const names = [];

  for (const raw of items) {
    const name = stripMarkers(raw);
    if (!name) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  return names;
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
  const fresh = parsed.filter((name) => !known.has(name.toLowerCase()));
  const duplicates = parsed.length - fresh.length;

  const runBatch = async () => {
    setFailures([]);
    setProgress({ done: 0, total: fresh.length });

    const failed = [];
    for (let i = 0; i < fresh.length; i += 1) {
      const name = fresh[i];
      try {
        const result = await onAdd(name);
        if (!result.ok) failed.push(name);
      } catch {
        failed.push(name);
      }
      setProgress({ done: i + 1, total: fresh.length });
    }

    setProgress(null);
    if (failed.length === 0) {
      onClose();
      return;
    }
    // Keep the dialog open with only the failures left in the box, so they can
    // be corrected and retried without retyping the ones that worked.
    setFailures(failed);
    setText(failed.join('\n'));
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
