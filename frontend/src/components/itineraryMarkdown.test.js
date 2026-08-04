import { itineraryToMarkdown, markdownFilename } from './itineraryMarkdown';

// The real `t` for the keys the exporter touches, so the tests fail if a key
// is renamed out from under it.
const STRINGS = {
  'export.heading': 'Itinerary — {area}',
  'export.headingNoArea': 'Itinerary',
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
  'note.too_far_to_walk': 'Troppo lontano a piedi',
};

// Mirrors the real `t`: an unknown key comes back as itself, which is what
// `describeLegNote` keys its fallback off.
const t = (key, params) => {
  const template = STRINGS[key];
  if (template === undefined) return key;
  if (!params) return template;
  return Object.entries(params).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    template
  );
};

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

const singleDay = {
  days: [
    {
      day: 1,
      waypoints: [
        { name: 'Colosseo', lat: 41.89, lon: 12.49 },
        { name: 'Foro Romano', lat: 41.892, lon: 12.485 },
      ],
      route_details: [leg()],
      total_travel_time_seconds: 720,
      total_distance_meters: 900,
      start_time: '2026-08-04T09:00:00',
      estimated_end_time: '2026-08-04T17:30:00',
    },
  ],
  total_travel_time_seconds: 720,
  total_distance_meters: 900,
  start_time: '2026-08-04T09:00:00',
  estimated_end_time: '2026-08-04T17:30:00',
};

test('a single day gets no day headings, just the numbered stops', () => {
  const markdown = itineraryToMarkdown(singleDay, { area: 'Roma', t });

  expect(markdown).toContain('# Itinerary — Roma');
  expect(markdown).not.toContain('## Day 1');
  expect(markdown).toContain('1. **Colosseo**');
  expect(markdown).toContain('2. **Foro Romano**');
  expect(markdown).toContain('🚶 walking · 12 min · 900 m');
  expect(markdown.endsWith('\n')).toBe(true);
  // A key that leaked through unresolved means the exporter asked for one the
  // catalogue does not have.
  expect(markdown).not.toMatch(/(results|mode|export|note)\.[a-z_A-Z]+/);
});

test('totals count stops once and show the finish time only when one day', () => {
  const markdown = itineraryToMarkdown(singleDay, { area: 'Roma', t });
  expect(markdown).toContain('**2 stops · 12 min travel time · 900 m distance · finish by');
  expect(markdown).not.toContain('days');
});

test('a looping day marks the return and does not count it as a stop', () => {
  const looping = {
    ...singleDay,
    days: [
      {
        ...singleDay.days[0],
        waypoints: [
          { name: 'Hotel', lat: 41.9, lon: 12.5 },
          { name: 'Pantheon', lat: 41.898, lon: 12.476 },
          { name: 'Hotel', lat: 41.9, lon: 12.5 },
        ],
        route_details: [leg(), leg()],
      },
    ],
  };

  const markdown = itineraryToMarkdown(looping, { area: 'Roma', t });
  expect(markdown).toContain('2 stops · loop');
  expect(markdown).toContain('- ↩ Back to Hotel');
  expect(markdown).not.toContain('3. **Hotel**');
});

test('multi-day plans get a heading and per-day totals, and a day count', () => {
  const multiDay = {
    ...singleDay,
    days: [
      singleDay.days[0],
      { ...singleDay.days[0], day: 2, total_distance_meters: 4200 },
    ],
    total_distance_meters: 5100,
  };

  const markdown = itineraryToMarkdown(multiDay, { area: 'Roma', t });
  expect(markdown).toContain('## Day 1');
  expect(markdown).toContain('## Day 2');
  expect(markdown).toContain('_12 min · 4.2 km_');
  expect(markdown).toContain('2 days');
  expect(markdown).not.toContain('finish by');
});

function withNote(overrides) {
  return {
    ...singleDay,
    days: [
      {
        ...singleDay.days[0],
        route_details: [
          leg({ mode: 'driving', requires_vehicle: true, ...overrides }),
        ],
      },
    ],
  };
}

test('a vehicle note is phrased from its code, not the English fallback', () => {
  const markdown = itineraryToMarkdown(
    withNote({
      note: 'Too far to walk: take public transport or a car',
      note_code: 'too_far_to_walk',
    }),
    { area: 'Roma', t }
  );

  expect(markdown).toContain('⚠️ Troppo lontano a piedi');
  expect(markdown).not.toContain('Too far to walk');
});

test('an unknown note code falls back to the backend English', () => {
  const markdown = itineraryToMarkdown(
    withNote({
      note: 'Too far to hang-glide: take public transport or a car',
      note_code: 'too_far_to_hang_glide',
    }),
    { area: 'Roma', t }
  );

  expect(markdown).toContain('⚠️ Too far to hang-glide: take public transport or a car');
  expect(markdown).not.toContain('note.too_far_to_hang_glide');
});

test('a note with no code at all still comes through', () => {
  const markdown = itineraryToMarkdown(
    withNote({ note: 'Too far to walk: take public transport or a car' }),
    { area: 'Roma', t }
  );

  expect(markdown).toContain('⚠️ Too far to walk: take public transport or a car');
});

test('visit time appears per stop and in the totals', () => {
  const withVisits = {
    ...singleDay,
    total_visit_time_seconds: 9000,
    days: [
      {
        ...singleDay.days[0],
        total_visit_time_seconds: 9000,
        waypoints: [
          { name: 'Colosseo', lat: 41.89, lon: 12.49, visit_seconds: 7200 },
          { name: 'Foro Romano', lat: 41.892, lon: 12.485, visit_seconds: 1800 },
        ],
      },
    ],
  };

  const markdown = itineraryToMarkdown(withVisits, { area: 'Roma', t });
  expect(markdown).toContain('1. **Colosseo** — _stay 2 h 00 min_');
  expect(markdown).toContain('2. **Foro Romano** — _stay 30 min_');
  expect(markdown).toContain('2 h 30 min at places');
});

test('a depot with no visit time gets no stay annotation', () => {
  const looping = {
    ...singleDay,
    days: [
      {
        ...singleDay.days[0],
        waypoints: [
          { name: 'Hotel', lat: 41.9, lon: 12.5, visit_seconds: 0 },
          { name: 'Pantheon', lat: 41.898, lon: 12.476, visit_seconds: 3600 },
          { name: 'Hotel', lat: 41.9, lon: 12.5, visit_seconds: 0 },
        ],
        route_details: [leg(), leg()],
      },
    ],
  };

  const markdown = itineraryToMarkdown(looping, { area: 'Roma', t });
  expect(markdown).toContain('1. **Hotel**\n');
  expect(markdown).toContain('2. **Pantheon** — _stay 1 h 00 min_');
});

test('an itinerary with no visit time is unchanged', () => {
  const markdown = itineraryToMarkdown(singleDay, { area: 'Roma', t });
  expect(markdown).not.toContain('stay');
  expect(markdown).not.toContain('at places');
});

test('the heading falls back when no area was given', () => {
  const markdown = itineraryToMarkdown(singleDay, { area: '', t });
  expect(markdown).toContain('# Itinerary\n');
  expect(markdown).not.toContain('—');
});

test('filenames slug the area and strip accents', () => {
  // Local components on purpose: a UTC literal would make this test's result
  // depend on the runner's timezone, which is the bug it guards against.
  const on = new Date(2026, 7, 4, 0, 30);
  expect(markdownFilename('Roma', on)).toBe('itinerary-roma-2026-08-04.md');
  expect(markdownFilename('Zürich', on)).toBe('itinerary-zurich-2026-08-04.md');
  expect(markdownFilename("Reggio nell'Emilia", on)).toBe(
    'itinerary-reggio-nell-emilia-2026-08-04.md'
  );
  expect(markdownFilename('', on)).toBe('itinerary-2026-08-04.md');
});
