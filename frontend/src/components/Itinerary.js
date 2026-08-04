import React from 'react';
import { useI18n } from '../i18n';
import { dayColour } from './RouteMap';
import {
  describeLegNote,
  formatDistance,
  formatDuration,
  formatTime,
  isLoop,
} from './format';

const MODE_ICON = {
  walking: '🚶',
  bicycle: '🚲',
  driving: '🚗',
};

function DaySection({ day, dayIndex, showHeading }) {
  const { t } = useI18n();
  const waypoints = day.waypoints;
  const legs = day.route_details;
  const loop = isLoop(waypoints);

  return (
    <div className="day-section">
      {showHeading && (
        <h5 className="day-heading">
          <span
            className="legend-swatch"
            style={{ background: dayColour(dayIndex) }}
          />
          {t('results.day', { day: day.day })}
          <span className="day-heading-meta">
            {formatDuration(day.total_travel_time_seconds)} ·{' '}
            {formatDistance(day.total_distance_meters)}
          </span>
        </h5>
      )}

      <ol className="legs">
        {waypoints.map((point, index) => {
          const leg = legs[index];
          const note = leg ? describeLegNote(leg, t) : null;
          // The return to the start is not an extra place to visit.
          const isReturn = loop && index === waypoints.length - 1;
          return (
            <li key={`${point.name}-${index}`} className="leg">
              <div className="leg-stop">
                <span
                  className={`leg-number${isReturn ? ' leg-number-return' : ''}`}
                  style={isReturn ? undefined : { background: dayColour(dayIndex) }}
                  aria-hidden={isReturn}
                >
                  {isReturn ? '↩' : index + 1}
                </span>
                <span className="leg-place">
                  {isReturn ? t('results.backTo', { name: point.name }) : point.name}
                </span>
              </div>

              {leg && (
                <div
                  className={`leg-travel${leg.requires_vehicle ? ' leg-travel-vehicle' : ''}`}
                >
                  <span className="leg-mode">
                    {MODE_ICON[leg.mode] || '➜'} {t(`mode.${leg.mode}`)}
                  </span>
                  <span className="leg-metrics">
                    {formatDuration(leg.travel_time_seconds)} ·{' '}
                    {formatDistance(leg.distance_meters)} ·{' '}
                    {t('results.arrive', {
                      time: formatTime(leg.estimated_arrival),
                    })}
                  </span>
                  {note && <span className="leg-note">{note}</span>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Itinerary({ itinerary }) {
  const { t } = useI18n();
  const days = itinerary.days;
  const multiDay = days.length > 1;

  const allLegs = days.flatMap((day) => day.route_details);
  const overLimit = allLegs.filter((leg) => leg.requires_vehicle).length;

  // Depots repeat when a day loops, so count the distinct stops instead.
  const stopCount = days.reduce(
    (total, day) =>
      total + day.waypoints.length - (isLoop(day.waypoints) ? 1 : 0),
    0
  );
  const anyLoop = days.some((day) => isLoop(day.waypoints));

  return (
    <div className="itinerary">
      <div className="summary">
        <div className="summary-item">
          <span className="summary-value">{stopCount}</span>
          <span className="summary-label">
            {anyLoop ? t('results.stopsLoop') : t('results.stops')}
          </span>
        </div>
        {multiDay && (
          <div className="summary-item">
            <span className="summary-value">{days.length}</span>
            <span className="summary-label">{t('results.days')}</span>
          </div>
        )}
        <div className="summary-item">
          <span className="summary-value">
            {formatDuration(itinerary.total_travel_time_seconds)}
          </span>
          <span className="summary-label">{t('results.time')}</span>
        </div>
        <div className="summary-item">
          <span className="summary-value">
            {formatDistance(itinerary.total_distance_meters)}
          </span>
          <span className="summary-label">{t('results.distance')}</span>
        </div>
        {!multiDay && (
          <div className="summary-item">
            <span className="summary-value">
              {formatTime(itinerary.estimated_end_time)}
            </span>
            <span className="summary-label">{t('results.finish')}</span>
          </div>
        )}
      </div>

      {overLimit > 0 && (
        <p className="callout">
          {overLimit === 1
            ? t('results.overLimitOne')
            : t('results.overLimitMany', { count: overLimit })}
        </p>
      )}

      {days.map((day, index) => (
        <DaySection
          key={day.day}
          day={day}
          dayIndex={index}
          showHeading={multiDay}
        />
      ))}
    </div>
  );
}

export default Itinerary;
