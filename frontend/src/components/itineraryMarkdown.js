import { itineraryFilename } from './filename';
import {
  describeLegNote,
  describeStay,
  formatDistance,
  formatDuration,
  formatStopTimes,
  formatTime,
  isLoop,
} from './format';

const MODE_ICON = {
  walking: '🚶',
  bicycle: '🚲',
  driving: '🚗',
};

/**
 * Render one completed itinerary as Markdown.
 *
 * Pure on purpose: `t` is passed in rather than pulled from context so the
 * output can be asserted in tests, and so the export speaks whatever language
 * the UI is currently in.
 */
export function itineraryToMarkdown(itinerary, { area, t }) {
  const days = itinerary.days;
  const multiDay = days.length > 1;
  const anyLoop = days.some((day) => isLoop(day.waypoints));

  // Depots repeat when a day loops, so count the distinct stops instead.
  const stopCount = days.reduce(
    (total, day) => total + day.waypoints.length - (isLoop(day.waypoints) ? 1 : 0),
    0
  );

  const lines = [];

  lines.push(
    area
      ? `# ${t('export.heading', { area })}`
      : `# ${t('export.headingNoArea')}`
  );
  lines.push('');

  const totals = [
    `${stopCount} ${anyLoop ? t('results.stopsLoop') : t('results.stops')}`,
    `${formatDuration(itinerary.total_travel_time_seconds)} ${t('results.time')}`,
    `${formatDistance(itinerary.total_distance_meters)} ${t('results.distance')}`,
  ];
  if (itinerary.total_visit_time_seconds) {
    totals.splice(2, 0, `${formatDuration(itinerary.total_visit_time_seconds)} `
      + `${t('results.visits')}`);
  }
  if (multiDay) {
    totals.splice(1, 0, `${days.length} ${t('results.days')}`);
  } else {
    totals.push(`${t('results.finish')} ${formatTime(itinerary.estimated_end_time)}`);
  }
  lines.push(`**${totals.join(' · ')}**`);
  lines.push('');

  days.forEach((day) => {
    const waypoints = day.waypoints;
    const legs = day.route_details;
    const loop = isLoop(waypoints);

    if (multiDay) {
      lines.push(`## ${t('results.day', { day: day.day })}`);
      lines.push('');
      lines.push(
        `_${formatDuration(day.total_travel_time_seconds)} · ` +
          `${formatDistance(day.total_distance_meters)}_`
      );
      lines.push('');
    }

    waypoints.forEach((point, index) => {
      // The return to the start is not an extra place to visit.
      const isReturn = loop && index === waypoints.length - 1;
      const stay = describeStay(point, t);
      const schedule = [formatStopTimes(point), stay && `_${stay}_`].filter(
        Boolean
      );
      const suffix = schedule.length ? ` — ${schedule.join(' · ')}` : '';
      if (isReturn) {
        lines.push(`- ↩ ${t('results.backTo', { name: point.name })}${suffix}`);
      } else {
        lines.push(`${index + 1}. **${point.name}**${suffix}`);
      }

      const leg = legs[index];
      if (!leg) return;

      const detail = [
        `${MODE_ICON[leg.mode] || '➜'} ${t(`mode.${leg.mode}`)}`,
        formatDuration(leg.travel_time_seconds),
        formatDistance(leg.distance_meters),
      ].join(' · ');
      lines.push(`   - ${detail}`);
      const note = describeLegNote(leg, t);
      if (note) lines.push(`   - ⚠️ ${note}`);
    });

    lines.push('');
  });

  return `${lines.join('\n').trimEnd()}\n`;
}

/** `Rome` on 2026-08-04 becomes `itinerary-rome-2026-08-04.md`. */
export function markdownFilename(area, now = new Date()) {
  return itineraryFilename(area, 'md', now);
}
