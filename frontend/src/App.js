import React, { useCallback, useEffect, useState } from 'react';
import './App.css';
import { checkHealth, fetchItinerary, geocodePlace, submitItinerary } from './api';
import { LANGUAGES, useI18n } from './i18n';
import PlaceList, { nextPlaceId } from './components/PlaceList';
import RouteMap from './components/RouteMap';
import Itinerary from './components/Itinerary';

const POLL_INTERVAL_MS = 2000;
const MAX_DAYS = 14;

// One way of getting around per trip. Stretches the chosen mode cannot cover
// are flagged rather than silently switched to another mode.
const TRAVEL_MODES = ['walking', 'bicycle', 'driving'];
const MODE_ICON = { walking: '🚶', bicycle: '🚲', driving: '🚗' };

/** `datetime-local` wants local wall-clock time, not UTC. */
function defaultStartTime() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}


const TOO_FAR_KEY = {
  walking: 'error.tooFarWalking',
  bicycle: 'error.tooFarBicycle',
  driving: 'error.tooFarDriving',
};

/**
 * Phrase a failed plan in the reader's language.
 *
 * The backend sends a stable code plus the facts for the failures worth
 * rewording; anything else falls back to the English message it already
 * composed, which beats showing nothing.
 */
function describeFailure(plan, t) {
  if (plan.error_code === 'too_far_for_mode' && plan.error_params) {
    const key = TOO_FAR_KEY[plan.error_params.mode] || TOO_FAR_KEY.driving;
    return t(key, plan.error_params);
  }
  return plan.error || t('results.failed');
}

function App() {
  const { language, setLanguage, t } = useI18n();

  const [places, setPlaces] = useState([]);
  const [area, setArea] = useState('');
  // The city is committed explicitly. Everything else is resolved against it,
  // so it must not drift under the places already added by a stray keystroke.
  const [committedArea, setCommittedArea] = useState('');
  const [days, setDays] = useState(1);
  // One entry per day; each holds the place id to start from and end at.
  const [dayPoints, setDayPoints] = useState([{ startId: '', endId: '' }]);
  const [mode, setMode] = useState('walking');
  const [maxWalking, setMaxWalking] = useState(1000);
  const [maxCycling, setMaxCycling] = useState(5000);
  const [startTime, setStartTime] = useState(defaultStartTime);

  const [code, setCode] = useState(null);
  const [polling, setPolling] = useState(false);
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [backendUp, setBackendUp] = useState(null);

  const trimmedArea = area.trim();
  const areaLocked = committedArea !== '' && committedArea === trimmedArea;

  const commitArea = () => {
    if (!trimmedArea) return;
    setCommittedArea(trimmedArea);
  };

  useEffect(() => {
    checkHealth().then(
      () => setBackendUp(true),
      () => setBackendUp(false)
    );
  }, []);

  const updatePlace = useCallback((id, patch) => {
    setPlaces((current) =>
      current.map((place) => (place.id === id ? { ...place, ...patch } : place))
    );
  }, []);

  /**
   * Resolve a place before it joins the list.
   *
   * A name that resolves to nothing never becomes a list entry: the caller
   * gets the error and the user can correct the spelling straight away.
   */
  const addPlace = async (name) => {
    const result = await geocodePlace(name, committedArea);
    if (!result.found) return { ok: false, error: result.error };

    setPlaces((current) => [
      ...current,
      {
        id: nextPlaceId(),
        name,
        resolvedFor: committedArea,
        resolved: result.place,
        error: null,
      },
    ]);
    return { ok: true };
  };

  // Committing a different city invalidates every resolved place, so re-check
  // them one at a time — which also stays inside the geocoder's 1 req/s budget.
  useEffect(() => {
    if (!committedArea) return undefined;
    const stale = places.find((place) => place.resolvedFor !== committedArea);
    if (!stale) return undefined;

    let cancelled = false;
    geocodePlace(stale.name, committedArea).then(
      (result) => {
        if (cancelled) return;
        updatePlace(stale.id, {
          resolvedFor: committedArea,
          resolved: result.found ? result.place : null,
          error: result.found ? null : result.error || 'not found',
        });
      },
      (err) => {
        if (cancelled) return;
        updatePlace(stale.id, {
          resolvedFor: committedArea,
          resolved: null,
          error: err.message,
        });
      }
    );

    return () => {
      cancelled = true;
    };
  }, [places, committedArea, updatePlace]);

  useEffect(() => {
    if (!code || !polling) return undefined;

    let cancelled = false;
    const poll = async () => {
      try {
        const data = await fetchItinerary(code);
        if (cancelled) return;
        setPlan(data);
        if (data.status === 'completed' || data.status === 'failed') {
          setPolling(false);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err.message);
        setPolling(false);
      }
    };

    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [code, polling]);

  const changeDays = (value) => {
    const count = Math.max(1, Math.min(MAX_DAYS, Number(value) || 1));
    setDays(count);
    setDayPoints((current) => {
      const next = current.slice(0, count);
      while (next.length < count) next.push({ startId: '', endId: '' });
      return next;
    });
  };

  const setDayPoint = (dayIndex, field, value) => {
    setDayPoints((current) =>
      current.map((entry, index) =>
        index === dayIndex ? { ...entry, [field]: value } : entry
      )
    );
  };

  // Days are tracked by place id so that reordering or removing a place cannot
  // silently point a day at the wrong stop.
  const indexOfId = useCallback(
    (id, fallback) => {
      const index = places.findIndex((place) => place.id === id);
      return index === -1 ? fallback : index;
    },
    [places]
  );

  const startIdxOf = (dayIndex) => indexOfId(dayPoints[dayIndex]?.startId, 0);
  const endIdxOf = (dayIndex) =>
    indexOfId(dayPoints[dayIndex]?.endId, places.length - 1);

  const dayStarts = dayPoints.map((_, index) => startIdxOf(index));
  const dayEnds = dayPoints.map((_, index) => endIdxOf(index));

  const resolvedForArea = places.filter(
    (place) => place.resolved && place.resolvedFor === committedArea
  );
  const unresolved = places.filter((place) => place.error);

  const validationError = (() => {
    if (!areaLocked) return t('error.city');
    if (places.length < 2) return t('error.places');
    if (unresolved.length > 0) {
      return t('error.unresolved', {
        names: unresolved.map((place) => place.name).join(', '),
      });
    }
    if (resolvedForArea.length !== places.length) return t('error.resolving');
    // Start and end points are not stops: a day ending elsewhere is already a
    // journey, but a day looping back shows nothing without a place of its own.
    const loopDays = dayStarts.filter((start, i) => start === dayEnds[i]).length;
    const pinned = new Set([...dayStarts, ...dayEnds]);
    if (places.length - pinned.size < loopDays) {
      return t('error.daysTooMany', { days });
    }
    return null;
  })();

  const submit = async (event) => {
    event.preventDefault();
    if (validationError) return;

    setError(null);
    setPlan(null);
    setCode(null);

    try {
      const response = await submitItinerary({
        places: places.map((place) => place.name),
        // Already resolved as they were entered, so geocoding is skipped.
        resolved_places: places.map((place) => ({
          query: place.name,
          name: place.resolved.name,
          lat: place.resolved.lat,
          lon: place.resolved.lon,
        })),
        area: committedArea,
        days,
        start_idx: dayStarts[0],
        end_idx: dayEnds[0],
        day_starts: dayStarts,
        day_ends: dayEnds,
        start_time: new Date(startTime).toISOString(),
        modes: [mode],
        // Always on: the traveller picked a mode, so honour it rather than
        // silently switching them to whatever is fastest.
        walking_preference: true,
        max_walking_distance: Number(maxWalking),
        max_cycling_distance: Number(maxCycling),
      });
      setCode(response.code);
      setPolling(true);
    } catch (err) {
      setError(err.message);
    }
  };

  const itinerary = plan?.status === 'completed' ? plan.itinerary : null;

  const placeOptions = places.map((place) => (
    <option key={place.id} value={place.id}>
      {place.name}
    </option>
  ));

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>{t('app.title')}</h1>
          <p className="tagline">
            {t('app.tagline1')}
            <br />
            {t('app.tagline2')}
          </p>
        </div>
        <div className="header-actions">
          <select
            className="lang-select"
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
            aria-label={t('language.switch')}
          >
            {Object.entries(LANGUAGES).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
          <span
            className={`health health-${backendUp === null ? 'unknown' : backendUp}`}
          >
            {backendUp === null && t('health.checking')}
            {backendUp === true && t('health.online')}
            {backendUp === false && t('health.offline')}
          </span>
        </div>
      </header>

      <main className="layout">
        <section className="panel">
          <form onSubmit={submit}>
            <h2>{t('form.heading')}</h2>

            <label className="field">
              <span className="field-label">{t('form.city')}</span>
              <div className="commit-row">
                <input
                  type="text"
                  value={area}
                  onChange={(event) => setArea(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    commitArea();
                  }}
                  placeholder={t('form.cityPlaceholder')}
                  disabled={polling || areaLocked}
                  required
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => (areaLocked ? setCommittedArea('') : commitArea())}
                  disabled={polling || (!areaLocked && !trimmedArea)}
                >
                  {areaLocked ? t('form.cityChange') : t('form.citySet')}
                </button>
              </div>
            </label>

            <div className="field">
              <span className="field-label">{t('form.places')}</span>
              <PlaceList
                places={places}
                onChange={setPlaces}
                onAdd={addPlace}
                disabled={polling}
                needsArea={!areaLocked}
              />
            </div>

            <fieldset className="field">
              <legend className="field-label">{t('form.mode')}</legend>
              <div className="mode-choice">
                {TRAVEL_MODES.map((id) => (
                  <label
                    key={id}
                    className={`mode-option${mode === id ? ' mode-option-active' : ''}`}
                  >
                    <input
                      type="radio"
                      name="travel-mode"
                      value={id}
                      checked={mode === id}
                      onChange={() => setMode(id)}
                      disabled={polling}
                    />
                    <span className="mode-icon" aria-hidden="true">
                      {MODE_ICON[id]}
                    </span>
                    <span>{t(`mode.${id}`)}</span>
                  </label>
                ))}
              </div>
              {mode !== 'driving' && (
                <small>{t(`mode.hint.${mode}`)}</small>
              )}
            </fieldset>

            <div className="field">
              <span className="field-label" id="days-label">
                {t('form.days')}
              </span>
              <div className="stepper" role="group" aria-labelledby="days-label">
                <button
                  type="button"
                  onClick={() => changeDays(days - 1)}
                  disabled={polling || days <= 1}
                  aria-label={t('form.daysFewer')}
                >
                  −
                </button>
                <output className="stepper-value">{days}</output>
                <button
                  type="button"
                  onClick={() => changeDays(days + 1)}
                  disabled={polling || days >= MAX_DAYS}
                  aria-label={t('form.daysMore')}
                >
                  +
                </button>
              </div>
            </div>

            {places.length >= 2 &&
              dayPoints.map((point, index) => (
                <div key={index} className="day-block">
                  <div className="field-row">
                    <label className="field">
                      <span className="field-label">
                        {days === 1
                          ? t('form.startAt')
                          : t('form.dayStart', { day: index + 1 })}
                      </span>
                      <select
                        value={places[startIdxOf(index)]?.id ?? ''}
                        onChange={(event) =>
                          setDayPoint(index, 'startId', event.target.value)
                        }
                        disabled={polling}
                      >
                        {placeOptions}
                      </select>
                    </label>

                    <label className="field">
                      <span className="field-label">
                        {days === 1
                          ? t('form.finishAt')
                          : t('form.dayFinish', { day: index + 1 })}
                      </span>
                      <select
                        value={places[endIdxOf(index)]?.id ?? ''}
                        onChange={(event) =>
                          setDayPoint(index, 'endId', event.target.value)
                        }
                        disabled={polling}
                      >
                        {placeOptions}
                      </select>
                    </label>
                  </div>

                  {startIdxOf(index) === endIdxOf(index) && (
                    <p className="hint">
                      {days === 1
                        ? t('form.roundTrip')
                        : t('form.roundTripDay', { day: index + 1 })}
                    </p>
                  )}
                </div>
              ))}

            <label className="field">
              <span className="field-label">{t('form.startTime')}</span>
              <input
                type="datetime-local"
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
                disabled={polling}
              />
            </label>

            {mode !== 'driving' && (
              <div className="options">
                <label className="field">
                  <span className="field-label">
                    {mode === 'bicycle' ? t('form.maxCycle') : t('form.maxWalk')}
                  </span>
                  <input
                    type="number"
                    min="0"
                    value={mode === 'bicycle' ? maxCycling : maxWalking}
                    onChange={(event) =>
                      mode === 'bicycle'
                        ? setMaxCycling(event.target.value)
                        : setMaxWalking(event.target.value)
                    }
                    disabled={polling}
                  />
                </label>
              </div>
            )}

            <button
              type="submit"
              className="primary"
              disabled={!!validationError || polling}
            >
              {polling ? t('form.submitting') : t('form.submit')}
            </button>

            {validationError && places.length > 0 && (
              <p className="hint">{validationError}</p>
            )}
          </form>
        </section>

        <section className="panel results">
          <h2>{t('results.heading')}</h2>

          {error && <div className="alert alert-error">{error}</div>}

          {plan?.status === 'failed' && (
            <div className="alert alert-error">{describeFailure(plan, t)}</div>
          )}

          {polling && (
            <div className="alert alert-info">{t('results.working')}</div>
          )}

          {itinerary && (
            <>
              <RouteMap days={itinerary.days} />
              <Itinerary itinerary={itinerary} />
            </>
          )}

          {!itinerary && !polling && !error && plan?.status !== 'failed' && (
            <p className="empty-hint">{t('results.empty')}</p>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
