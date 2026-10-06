/**
 * Lay the itinerary out as an A4 PDF.
 *
 * Text is drawn with jsPDF's own primitives rather than rasterised from the
 * DOM, so the result stays selectable, searchable and sharp at any zoom. The
 * palette mirrors App.css: an export should look like the app it came from.
 *
 * `t` is passed in rather than pulled from context, matching
 * `itineraryToMarkdown` — the document then speaks whatever language the UI
 * is in, and the layout can be exercised without rendering React.
 */

import { jsPDF } from 'jspdf';
import { itineraryFilename } from './filename';
import { dayColour } from './RouteMap';
import {
  describeLegNote,
  describeStay,
  formatDistance,
  formatDuration,
  formatStopTimes,
  formatTime,
  isLoop,
} from './format';

const PAGE_WIDTH = 210;
const PAGE_HEIGHT = 297;
const MARGIN = 16;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
// Where the body must stop so it never runs into the footer.
const BODY_BOTTOM = PAGE_HEIGHT - 20;
const FOOTER_RULE_Y = PAGE_HEIGHT - 14;
const FOOTER_TEXT_Y = PAGE_HEIGHT - 9.5;

const HEADER_HEIGHT = 26;
const MAP_HEIGHT = 100;
const TILE_HEIGHT = 17;
const MARKER_X = MARGIN + 4;
const MARKER_RADIUS = 3.4;
const TEXT_X = MARGIN + 11;
const TEXT_WIDTH = PAGE_WIDTH - MARGIN - TEXT_X;

/** The light half of the App.css palette; a printed page has no dark mode. */
const COLOUR = {
  text: '#1e2420',
  muted: '#667065',
  border: '#dcdfd8',
  accent: '#2f6f4f',
  accentSoft: '#e7f1ea',
  danger: '#b23b36',
  vehicle: '#d9534f',
  white: '#ffffff',
};

/** Map size in pixels, chosen so the image lands at ~150 dpi once placed. */
export const MAP_PIXELS = {
  width: Math.round(CONTENT_WIDTH * 6),
  height: Math.round(MAP_HEIGHT * 6),
};

function rgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  // eslint-disable-next-line no-bitwise
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

// Characters above U+00FF that the built-in fonts can still show, since they
// sit in WinAnsi's upper block: quotes, dashes, the euro sign and friends.
const WINANSI_EXTRAS = new Set([
  '€', '‚', 'ƒ', '„', '…', '†', '‡',
  'ˆ', '‰', 'Š', '‹', 'Œ', 'Ž', '‘',
  '’', '“', '”', '•', '–', '—', '˜',
  '™', 'š', '›', 'œ', 'ž', 'Ÿ',
]);

/**
 * Make a string safe for the standard PDF fonts.
 *
 * Embedding a Unicode font would add hundreds of kilobytes to every page
 * load, so the built-in Helvetica is used instead and its repertoire is
 * respected here: accented Latin passes through untouched, "ā" degrades to
 * "a", emoji are dropped, and scripts with no Latin fallback become "?".
 */
export function pdfText(value) {
  return Array.from(String(value ?? ''))
    .map((character) => {
      const code = character.codePointAt(0);
      if (code <= 0xff || WINANSI_EXTRAS.has(character)) return character;

      const stripped = character.normalize('NFD').replace(/\p{Diacritic}/gu, '');
      if (
        stripped &&
        Array.from(stripped).every((part) => part.codePointAt(0) <= 0xff)
      ) {
        return stripped;
      }
      // Pictographs and stray combining marks carry nothing once flattened.
      if (/\p{Extended_Pictographic}|\p{Mark}/u.test(character)) return '';
      return '?';
    })
    .join('');
}

/** Shorthand for the four calls that precede almost every `text`. */
function style(doc, { size, weight = 'normal', colour = COLOUR.text }) {
  doc.setFont('helvetica', weight);
  doc.setFontSize(size);
  doc.setTextColor(...rgb(colour));
}

function write(doc, text, x, y, options) {
  doc.text(pdfText(text), x, y, options);
}

function wrap(doc, text, width) {
  return doc.splitTextToSize(pdfText(text), width);
}

/** Start a fresh page when `needed` millimetres will not fit on this one. */
function ensureSpace(state, needed) {
  if (state.y + needed <= BODY_BOTTOM) return false;
  state.doc.addPage();
  state.y = MARGIN;
  return true;
}

function drawHeader(state, { area, now }) {
  const { doc, t } = state;

  doc.setFillColor(...rgb(COLOUR.accent));
  doc.rect(0, 0, PAGE_WIDTH, HEADER_HEIGHT, 'F');

  const title = area
    ? t('export.heading', { area })
    : t('export.headingNoArea');
  style(doc, { size: 17, weight: 'bold', colour: COLOUR.white });
  write(doc, title, MARGIN, 14.5);

  style(doc, { size: 8, colour: COLOUR.accentSoft });
  write(doc, t('pdf.generated', { date: now.toLocaleDateString() }), MARGIN, 20.5);
  write(doc, t('app.title'), PAGE_WIDTH - MARGIN, 20.5, { align: 'right' });

  state.y = HEADER_HEIGHT + 9;
}

/** The same figures as the on-screen summary, as a row of tiles. */
function drawSummary(state, itinerary) {
  const { doc, t } = state;
  const days = itinerary.days;
  const multiDay = days.length > 1;

  // Depots repeat when a day loops, so count the distinct stops instead.
  const stopCount = days.reduce(
    (total, day) => total + day.waypoints.length - (isLoop(day.waypoints) ? 1 : 0),
    0
  );
  const anyLoop = days.some((day) => isLoop(day.waypoints));

  const tiles = [
    {
      value: String(stopCount),
      label: anyLoop ? t('results.stopsLoop') : t('results.stops'),
    },
  ];
  if (multiDay) {
    tiles.push({ value: String(days.length), label: t('results.days') });
  }
  tiles.push({
    value: formatDuration(itinerary.total_travel_time_seconds),
    label: t('results.time'),
  });
  if (itinerary.total_visit_time_seconds > 0) {
    tiles.push({
      value: formatDuration(itinerary.total_visit_time_seconds),
      label: t('results.visits'),
    });
  }
  tiles.push({
    value: formatDistance(itinerary.total_distance_meters),
    label: t('results.distance'),
  });
  if (!multiDay) {
    tiles.push({
      value: formatTime(itinerary.estimated_end_time),
      label: t('results.finish'),
    });
  }

  const gap = 3;
  const width = (CONTENT_WIDTH - gap * (tiles.length - 1)) / tiles.length;

  tiles.forEach((tile, index) => {
    const x = MARGIN + index * (width + gap);
    doc.setFillColor(...rgb(COLOUR.accentSoft));
    doc.roundedRect(x, state.y, width, TILE_HEIGHT, 2, 2, 'F');

    style(doc, { size: 12, weight: 'bold', colour: COLOUR.accent });
    write(doc, tile.value, x + width / 2, state.y + 7.5, { align: 'center' });

    style(doc, { size: 6.6, colour: COLOUR.muted });
    // Labels are short, but "travel time" in a six-tile row is not.
    const [label] = wrap(doc, tile.label, width - 3);
    write(doc, label, x + width / 2, state.y + 12.8, { align: 'center' });
  });

  state.y += TILE_HEIGHT + 8;
}

function drawMap(state, mapImage) {
  const { doc, t } = state;

  doc.addImage(mapImage, 'JPEG', MARGIN, state.y, CONTENT_WIDTH, MAP_HEIGHT);
  doc.setDrawColor(...rgb(COLOUR.border));
  doc.setLineWidth(0.3);
  doc.rect(MARGIN, state.y, CONTENT_WIDTH, MAP_HEIGHT);
  state.y += MAP_HEIGHT + 4;

  style(doc, { size: 6.6, colour: COLOUR.muted });
  const caption = wrap(doc, t('map.caption'), CONTENT_WIDTH - 45);
  caption.forEach((line, index) => {
    write(doc, line, MARGIN, state.y + index * 3);
  });
  // Required by the tile licence, and kept on the same line as the caption.
  write(doc, t('pdf.mapCredit'), PAGE_WIDTH - MARGIN, state.y, { align: 'right' });

  state.y += caption.length * 3 + 6;
}

/** Which colour means which day, for a trip that has more than one. */
function drawLegend(state, days) {
  const { doc, t } = state;
  const swatch = 3;
  let x = MARGIN;

  style(doc, { size: 8, colour: COLOUR.muted });
  days.forEach((day, index) => {
    const label = pdfText(t('results.day', { day: day.day }));
    const width = swatch + 2 + doc.getTextWidth(label) + 6;
    if (x + width > PAGE_WIDTH - MARGIN) {
      x = MARGIN;
      state.y += 5.5;
    }

    doc.setFillColor(...rgb(dayColour(index)));
    doc.roundedRect(x, state.y - 2.4, swatch, swatch, 0.6, 0.6, 'F');
    doc.text(label, x + swatch + 2, state.y);
    x += width;
  });

  // Generous, so the row reads as a key to the map above rather than as a
  // header for the first day below.
  state.y += 12;
}

function drawDayHeading(state, day, dayIndex, { continued = false } = {}) {
  const { doc, t } = state;

  doc.setFillColor(...rgb(dayColour(dayIndex)));
  doc.roundedRect(MARGIN, state.y - 3.4, 3.6, 3.6, 0.8, 0.8, 'F');

  style(doc, { size: 11.5, weight: 'bold' });
  const heading =
    t('results.day', { day: day.day }) + (continued ? ` ${t('pdf.continued')}` : '');
  write(doc, heading, MARGIN + 6, state.y);

  style(doc, { size: 8.5, colour: COLOUR.muted });
  const meta =
    `${formatDuration(day.total_travel_time_seconds)} · ` +
    `${formatDistance(day.total_distance_meters)}`;
  write(doc, meta, PAGE_WIDTH - MARGIN, state.y, { align: 'right' });

  state.y += 2.6;
  doc.setDrawColor(...rgb(COLOUR.border));
  doc.setLineWidth(0.2);
  doc.line(MARGIN, state.y, PAGE_WIDTH - MARGIN, state.y);
  state.y += 6;
}

/**
 * One stop: its badge, its name, and the leg that leaves it.
 *
 * Everything is measured before anything is drawn, so a stop is never split
 * across a page boundary with its travel details orphaned overleaf.
 */
function drawStop(state, { day, dayIndex, index, showDayHeading }) {
  const { doc, t } = state;
  const waypoints = day.waypoints;
  const point = waypoints[index];
  const leg = day.route_details[index];
  const loop = isLoop(waypoints);
  // The return to the start is not an extra place to visit.
  const isReturn = loop && index === waypoints.length - 1;

  const name = isReturn ? t('results.backTo', { name: point.name }) : point.name;
  style(doc, { size: 10.5, weight: isReturn ? 'normal' : 'bold' });
  const nameLines = wrap(doc, name, TEXT_WIDTH);

  const schedule =
    [
      // jsPDF's standard fonts are WinAnsi only: an arrow prints as "?".
      formatStopTimes(point, ' – '),
      describeStay(point, t),
    ]
      .filter(Boolean)
      .join(' · ') || null;

  style(doc, { size: 8.5 });
  const legLines = leg
    ? wrap(
        doc,
        [
          t(`mode.${leg.mode}`),
          formatDuration(leg.travel_time_seconds),
          formatDistance(leg.distance_meters),
        ].join(' · '),
        TEXT_WIDTH
      )
    : [];
  const note = leg ? describeLegNote(leg, t) : null;
  const noteLines = note ? wrap(doc, note, TEXT_WIDTH - 4) : [];

  const height =
    nameLines.length * 5 +
    (schedule ? 4.2 : 0) +
    legLines.length * 4.4 +
    noteLines.length * 4.2 +
    3.5;

  if (ensureSpace(state, height) && showDayHeading) {
    drawDayHeading(state, day, dayIndex, { continued: true });
    state.previousMarkerY = null;
  }

  const markerY = state.y + 1.4;

  // A hairline down the gutter turns the stops into one thread rather than a
  // stack of unrelated blocks.
  if (state.previousMarkerY !== null) {
    doc.setDrawColor(...rgb(COLOUR.border));
    doc.setLineWidth(0.6);
    doc.line(
      MARKER_X,
      state.previousMarkerY + MARKER_RADIUS + 0.8,
      MARKER_X,
      markerY - MARKER_RADIUS - 0.8
    );
  }

  if (isReturn) {
    // Hollow badge: the trip ends here, it does not stop here.
    doc.setFillColor(...rgb(COLOUR.white));
    doc.setDrawColor(...rgb(dayColour(dayIndex)));
    doc.setLineWidth(0.7);
    doc.circle(MARKER_X, markerY, MARKER_RADIUS - 0.6, 'FD');
  } else {
    doc.setFillColor(...rgb(dayColour(dayIndex)));
    doc.circle(MARKER_X, markerY, MARKER_RADIUS, 'F');
    style(doc, { size: 7.5, weight: 'bold', colour: COLOUR.white });
    write(doc, String(index + 1), MARKER_X, markerY, {
      align: 'center',
      baseline: 'middle',
    });
  }
  state.previousMarkerY = markerY;

  style(doc, {
    size: 10.5,
    weight: isReturn ? 'normal' : 'bold',
    colour: isReturn ? COLOUR.muted : COLOUR.text,
  });
  nameLines.forEach((line, lineIndex) => {
    write(doc, line, TEXT_X, state.y + 3 + lineIndex * 5);
  });
  state.y += nameLines.length * 5;

  if (schedule) {
    style(doc, { size: 8.5, weight: 'italic', colour: COLOUR.muted });
    write(doc, schedule, TEXT_X, state.y + 2.2);
    state.y += 4.2;
  }

  if (legLines.length > 0) {
    style(doc, { size: 8.5, colour: COLOUR.muted });
    legLines.forEach((line, lineIndex) => {
      write(doc, line, TEXT_X, state.y + 3 + lineIndex * 4.4);
    });
    state.y += legLines.length * 4.4;
  }

  if (noteLines.length > 0) {
    style(doc, { size: 8.5, weight: 'bold', colour: COLOUR.danger });
    write(doc, '!', TEXT_X, state.y + 3);
    style(doc, { size: 8.5, colour: COLOUR.danger });
    noteLines.forEach((line, lineIndex) => {
      write(doc, line, TEXT_X + 4, state.y + 3 + lineIndex * 4.2);
    });
    state.y += noteLines.length * 4.2;
  }

  state.y += 3.5;
}

function drawDay(state, day, dayIndex, showDayHeading) {
  if (showDayHeading) {
    ensureSpace(state, 26);
    drawDayHeading(state, day, dayIndex);
  }
  state.previousMarkerY = null;

  day.waypoints.forEach((_, index) => {
    drawStop(state, { day, dayIndex, index, showDayHeading });
  });

  state.y += 3;
}

function stampFooters(state) {
  const { doc, t } = state;
  const total = doc.getNumberOfPages();

  for (let page = 1; page <= total; page += 1) {
    doc.setPage(page);
    doc.setDrawColor(...rgb(COLOUR.border));
    doc.setLineWidth(0.2);
    doc.line(MARGIN, FOOTER_RULE_Y, PAGE_WIDTH - MARGIN, FOOTER_RULE_Y);

    style(doc, { size: 7.5, colour: COLOUR.muted });
    write(doc, t('app.title'), MARGIN, FOOTER_TEXT_Y);
    write(doc, t('pdf.page', { page, total }), PAGE_WIDTH - MARGIN, FOOTER_TEXT_Y, {
      align: 'right',
    });
  }
}

/**
 * Build the document.
 *
 * @param {object} options.itinerary - a completed plan, as the API returns it.
 * @param {string} [options.area] - the city the trip is in, for the title.
 * @param {Function} options.t - the UI's translator.
 * @param {string} [options.mapImage] - JPEG data URL from `renderRouteImage`;
 *   omitting it simply leaves the map out.
 * @returns {jsPDF} ready to `save()` or `output()`.
 */
export function createItineraryPdf({
  itinerary,
  area,
  t,
  mapImage = null,
  now = new Date(),
}) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const state = { doc, t, y: MARGIN, previousMarkerY: null };
  const days = itinerary.days;
  const multiDay = days.length > 1;

  doc.setDocumentProperties({
    title: pdfText(
      area ? t('export.heading', { area }) : t('export.headingNoArea')
    ),
    creator: pdfText(t('app.title')),
  });

  drawHeader(state, { area, now });
  drawSummary(state, itinerary);
  if (mapImage) drawMap(state, mapImage);
  if (multiDay) drawLegend(state, days);

  days.forEach((day, index) => drawDay(state, day, index, multiDay));

  stampFooters(state);
  return doc;
}

/** `Rome` on 2026-08-04 becomes `itinerary-rome-2026-08-04.pdf`. */
export function pdfFilename(area, now = new Date()) {
  return itineraryFilename(area, 'pdf', now);
}
