import React, { useState } from 'react';
import { useI18n } from '../i18n';
import BatchAddDialog from './BatchAddDialog';
import { formatDuration, parseDuration } from './duration';

// Ids need only be unique within a session, and crypto.randomUUID is missing
// outside secure contexts — such as serving this app over plain HTTP on a LAN.
let idCounter = 0;
export const nextPlaceId = () => `place-${++idCounter}`;

/**
 * How long to spend at one place.
 *
 * Holds the raw text while it is being typed and only commits on blur or
 * Enter, so a half-finished "1h3" is never parsed as something the traveller
 * did not mean. Unparseable text stays on screen to be corrected in place.
 */
function VisitTimeInput({ minutes, onCommit, disabled, ariaLabel }) {
  const [text, setText] = useState(() => formatDuration(minutes));
  const [invalid, setInvalid] = useState(false);

  const commit = () => {
    const parsed = parseDuration(text);
    if (parsed === null && text.trim()) {
      setInvalid(true);
      return;
    }
    const next = parsed ?? 0;
    setInvalid(false);
    setText(formatDuration(next));
    onCommit(next);
  };

  return (
    <input
      type="text"
      className={`visit-time${invalid ? ' visit-time-invalid' : ''}`}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        setInvalid(false);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        // Inside the planning form, so Enter must not submit the plan.
        if (event.key !== 'Enter') return;
        event.preventDefault();
        commit();
      }}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-invalid={invalid ? 'true' : undefined}
      placeholder="0m"
    />
  );
}

/** Closing no later than opening; "HH:MM" strings compare correctly as text. */
export function hoursInvalid(place) {
  return Boolean(place.opens && place.closes && place.closes <= place.opens);
}

/**
 * Collects the places to visit, one at a time, showing what the geocoder
 * matched each one to.
 *
 * The resolved name is the whole point: "Musei Vaticani" quietly matching a
 * metro station is obvious here and invisible in a finished itinerary.
 */
function PlaceList({ places, onChange, onAdd, disabled, needsArea }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);
  const [batchOpen, setBatchOpen] = useState(false);

  const addPlace = async () => {
    const name = draft.trim();
    if (!name || needsArea || adding) return;

    setAdding(true);
    setAddError(null);
    try {
      const result = await onAdd(name);
      // The draft stays put when the name did not resolve, so the spelling can
      // be corrected on the spot.
      if (result.ok) setDraft('');
      else setAddError(result.error || t('place.notFound'));
    } catch (err) {
      setAddError(err.message);
    } finally {
      setAdding(false);
    }
  };

  // This control lives inside the planning form, so it cannot be a form of its
  // own: Enter has to add a place rather than submit the plan.
  const handleKeyDown = (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addPlace();
  };

  const removePlace = (id) => {
    onChange(places.filter((place) => place.id !== id));
  };

  // One stray click would otherwise wipe a list that took a while to build.
  const clearPlaces = () => {
    if (window.confirm(t('form.clearPlacesConfirm', { count: places.length }))) {
      onChange([]);
    }
  };

  const setHours = (id, field, value) => {
    onChange(
      places.map((place) => (place.id === id ? { ...place, [field]: value } : place))
    );
  };

  const setVisitMinutes = (id, minutes) => {
    onChange(
      places.map((place) =>
        place.id === id ? { ...place, visitMinutes: minutes } : place
      )
    );
  };

  const movePlace = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= places.length) return;
    const next = [...places];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className="place-list">
      <div className="place-add">
        <input
          type="text"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setAddError(null);
          }}
          onKeyDown={handleKeyDown}
          placeholder={t('form.addPlace')}
          aria-label={t('form.places')}
          disabled={disabled || needsArea || adding}
          aria-invalid={addError ? 'true' : undefined}
        />
        <button
          type="button"
          onClick={addPlace}
          disabled={disabled || needsArea || adding || !draft.trim()}
        >
          {adding ? t('place.resolving') : t('form.add')}
        </button>
      </div>

      <div className="place-list-actions">
        <button
          type="button"
          className="link-button"
          onClick={() => setBatchOpen(true)}
          disabled={disabled || needsArea || adding}
        >
          {t('form.addBatch')}
        </button>
        {places.length > 0 && (
          <button
            type="button"
            className="link-button link-button-danger"
            onClick={clearPlaces}
            disabled={disabled || adding}
          >
            {t('form.clearPlaces')}
          </button>
        )}
      </div>

      {batchOpen && (
        <BatchAddDialog
          onAdd={onAdd}
          onClose={() => setBatchOpen(false)}
          existingNames={places.map((place) => place.name)}
        />
      )}

      {addError && (
        <p className="add-error" role="alert">
          {t('place.addFailed', { name: draft.trim() })}
        </p>
      )}

      {needsArea && <p className="empty-hint">{t('form.cityFirst')}</p>}

      {places.length === 0 ? (
        !needsArea && <p className="empty-hint">{t('form.placesEmpty')}</p>
      ) : (
        <ul className="place-items">
          {places.map((place, index) => {
            const pending = !place.resolved && !place.error;
            return (
              <li key={place.id} className={place.error ? 'place-failed' : undefined}>
                <span className="place-index">{index + 1}</span>
                <span className="place-name">
                  {place.name}
                  {pending && (
                    <small className="place-status">{t('place.resolving')}</small>
                  )}
                  {place.resolved && (
                    <small className="place-status place-resolved">
                      {place.resolved.name}
                    </small>
                  )}
                  {place.error && (
                    <small className="place-status place-error">
                      {t('place.notFound')}
                    </small>
                  )}
                </span>
                <VisitTimeInput
                  minutes={place.visitMinutes ?? 0}
                  onCommit={(minutes) => setVisitMinutes(place.id, minutes)}
                  disabled={disabled}
                  ariaLabel={t('form.visitTime', { name: place.name })}
                />
                <span className="place-hours">
                  <span className="place-hours-label">{t('form.hours')}</span>
                  <input
                    type="time"
                    value={place.opens ?? ''}
                    onChange={(event) => setHours(place.id, 'opens', event.target.value)}
                    disabled={disabled}
                    aria-label={t('form.opensAt', { name: place.name })}
                  />
                  –
                  <input
                    type="time"
                    className={
                      hoursInvalid(place) ? 'visit-time-invalid' : undefined
                    }
                    value={place.closes ?? ''}
                    onChange={(event) => setHours(place.id, 'closes', event.target.value)}
                    disabled={disabled}
                    aria-label={t('form.closesAt', { name: place.name })}
                    aria-invalid={hoursInvalid(place) ? 'true' : undefined}
                  />
                </span>
                <span className="place-actions">
                  <button
                    type="button"
                    onClick={() => movePlace(index, -1)}
                    disabled={disabled || index === 0}
                    aria-label={t('form.moveUp', { name: place.name })}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => movePlace(index, 1)}
                    disabled={disabled || index === places.length - 1}
                    aria-label={t('form.moveDown', { name: place.name })}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => removePlace(place.id)}
                    disabled={disabled}
                    aria-label={t('form.remove', { name: place.name })}
                  >
                    ✕
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default PlaceList;
