import { createItineraryPdf, pdfFilename, pdfText } from './itineraryPdf';

// The real `t` for the keys the exporter touches, so the tests fail if a key
// is renamed out from under it.
const STRINGS = {
  'app.title': 'Travel Planner',
  'export.heading': 'Itinerary — {area}',
  'export.headingNoArea': 'Itinerary',
  'map.caption': 'Lines show the visit order as straight connections.',
  'pdf.generated': 'Generated {date}',
  'pdf.mapCredit': '© OpenStreetMap contributors',
  'pdf.continued': '(continued)',
  'pdf.page': 'Page {page} of {total}',
  'results.stops': 'stops',
  'results.stopsLoop': 'stops · loop',
  'results.time': 'travel time',
  'results.distance': 'distance',
  'results.finish': 'finish by',
  'results.days': 'days',
  'results.day': 'Day {day}',
  'results.backTo': 'Back to {name}',
  'results.arrive': 'arrive {time}',
  'results.stay': 'stay {duration}',
  'results.visits': 'at places',
  'mode.walking': 'walking',
  'mode.driving': 'driving',
  'note.too_far_to_walk': 'Too far to walk',
};

// Mirrors the real `t`, and records what was asked for: the exporter must not
// reach for a key the catalogue does not have.
function translator() {
  const requested = [];
  const t = (key, params) => {
    requested.push(key);
    const template = STRINGS[key];
    if (template === undefined) return key;
    if (!params) return template;
    return Object.entries(params).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, value),
      template
    );
  };
  return { t, requested };
}

function leg(overrides = {}) {
  return {
    mode: 'walking',
    travel_time_seconds: 720,
    distance_meters: 900,
    estimated_arrival: '2026-08-04T09:12:00',
    requires_vehicle: false,
    note: null,
    ...overrides,
  };
}

function day(number, waypoints, legs) {
  return {
    day: number,
    waypoints,
    route_details: legs,
    total_travel_time_seconds: 720,
    total_distance_meters: 900,
    start_time: '2026-08-04T09:00:00',
    estimated_end_time: '2026-08-04T17:30:00',
  };
}

const singleDay = {
  days: [
    day(
      1,
      [
        { name: 'Colosseo', lat: 41.89, lon: 12.49, visit_seconds: 3600 },
        { name: 'Foro Romano', lat: 41.892, lon: 12.485, visit_seconds: 0 },
      ],
      [leg()]
    ),
  ],
  total_travel_time_seconds: 720,
  total_visit_time_seconds: 3600,
  total_distance_meters: 900,
  start_time: '2026-08-04T09:00:00',
  estimated_end_time: '2026-08-04T17:30:00',
};

test('a plan without a map still produces one page of PDF', () => {
  const { t, requested } = translator();
  const doc = createItineraryPdf({ itinerary: singleDay, area: 'Roma', t });

  expect(doc.output('datauristring')).toMatch(/^data:application\/pdf/);
  expect(doc.getNumberOfPages()).toBe(1);
  // A key the catalogue does not know would have been printed raw.
  const unknown = requested.filter((key) => !(key in STRINGS));
  expect(unknown).toEqual([]);
});

test('a long itinerary flows onto further pages', () => {
  const { t } = translator();
  const waypoints = Array.from({ length: 14 }, (_, index) => ({
    name: `Place number ${index + 1}`,
    lat: 41.89 + index * 0.002,
    lon: 12.49 + index * 0.002,
    visit_seconds: 1800,
  }));
  const legs = waypoints.slice(0, -1).map(() => leg());

  const doc = createItineraryPdf({
    itinerary: {
      ...singleDay,
      days: [day(1, waypoints, legs), day(2, waypoints, legs)],
    },
    area: 'Roma',
    t,
  });

  expect(doc.getNumberOfPages()).toBeGreaterThan(1);
});

test('vehicle notes and loop returns do not derail the layout', () => {
  const { t, requested } = translator();
  const doc = createItineraryPdf({
    itinerary: {
      ...singleDay,
      days: [
        day(
          1,
          [
            { name: 'Hotel', lat: 41.9, lon: 12.5, visit_seconds: 0 },
            { name: 'Pantheon', lat: 41.898, lon: 12.476, visit_seconds: 900 },
            { name: 'Hotel', lat: 41.9, lon: 12.5, visit_seconds: 0 },
          ],
          [leg({ requires_vehicle: true, note_code: 'too_far_to_walk' }), leg()]
        ),
      ],
    },
    t,
  });

  expect(doc.getNumberOfPages()).toBe(1);
  expect(requested).toContain('results.backTo');
  expect(requested).toContain('note.too_far_to_walk');
});

test('the filename carries the area and the day it was exported', () => {
  const date = new Date(2026, 7, 4);
  expect(pdfFilename('Roma', date)).toBe('itinerary-roma-2026-08-04.pdf');
  expect(pdfFilename('', date)).toBe('itinerary-2026-08-04.pdf');
});

test('text is reduced to what the built-in fonts can actually show', () => {
  // Latin-1 accents are representable, so they must survive untouched.
  expect(pdfText('Città di Zürich — “centro”')).toBe('Città di Zürich — “centro”');
  // Beyond it, the closest ASCII beats a box.
  expect(pdfText('Ōsaka')).toBe('Osaka');
  // Emoji would print as garbage; dropping them loses nothing.
  expect(pdfText('Walk 🚶 there')).toBe('Walk  there');
  expect(pdfText(null)).toBe('');
});
