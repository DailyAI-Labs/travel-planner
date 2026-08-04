import { renderRouteImage } from './staticMap';

/**
 * jsdom has no 2D canvas and no network, so both are stood in for: the point
 * of these tests is what gets drawn and how often, not how it looks.
 */
function stubCanvas() {
  const drawn = { arcs: [], labels: [], segments: 0, tiles: 0 };
  const ctx = {
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    fill: () => {},
    stroke: () => {},
    fillRect: () => {},
    setLineDash: () => {},
    moveTo: () => {},
    lineTo: () => {
      drawn.segments += 1;
    },
    arc: (x, y, radius) => drawn.arcs.push({ x, y, radius }),
    drawImage: () => {
      drawn.tiles += 1;
    },
    fillText: (text) => drawn.labels.push(text),
  };

  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    toDataURL: () => 'data:image/jpeg;base64,stub',
  };

  const realCreateElement = document.createElement.bind(document);
  jest
    .spyOn(document, 'createElement')
    .mockImplementation((tag) =>
      tag === 'canvas' ? canvas : realCreateElement(tag)
    );

  return drawn;
}

/** Every tile fails, which is the path that must not lose the whole image. */
class FailingImage {
  set src(value) {
    this._src = value;
    if (this.onerror) setTimeout(() => this.onerror(), 0);
  }

  get src() {
    return this._src;
  }
}

const size = { width: 600, height: 400 };

function waypoint(name, lat, lon) {
  return { name, lat, lon, visit_seconds: 0 };
}

beforeEach(() => {
  global.Image = FailingImage;
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('nothing to draw means no image rather than a blank one', async () => {
  stubCanvas();
  expect(await renderRouteImage([], size)).toBeNull();
});

test('every stop gets a numbered badge and every leg a line', async () => {
  const drawn = stubCanvas();

  const image = await renderRouteImage(
    [
      {
        day: 1,
        waypoints: [
          waypoint('Colosseo', 41.89, 12.49),
          waypoint('Pantheon', 41.898, 12.476),
          waypoint('Trevi', 41.9009, 12.4833),
        ],
        route_details: [{ requires_vehicle: false }, { requires_vehicle: true }],
      },
    ],
    size
  );

  expect(image).toBe('data:image/jpeg;base64,stub');
  expect(drawn.arcs).toHaveLength(3);
  expect(drawn.labels).toEqual(['1', '2', '3']);
  // Two legs, drawn twice over: once as a white casing, once in colour.
  expect(drawn.segments).toBe(4);
});

test('a looping day does not stack a second badge on the start', async () => {
  const drawn = stubCanvas();

  await renderRouteImage(
    [
      {
        day: 1,
        waypoints: [
          waypoint('Hotel', 41.9, 12.5),
          waypoint('Pantheon', 41.898, 12.476),
          waypoint('Hotel', 41.9, 12.5),
        ],
        route_details: [{ requires_vehicle: false }, { requires_vehicle: false }],
      },
    ],
    size
  );

  expect(drawn.labels).toEqual(['1', '2']);
});

test('each day restarts its numbering in its own colour', async () => {
  const drawn = stubCanvas();

  await renderRouteImage(
    [
      {
        day: 1,
        waypoints: [
          waypoint('Colosseo', 41.89, 12.49),
          waypoint('Pantheon', 41.898, 12.476),
        ],
        route_details: [{ requires_vehicle: false }],
      },
      {
        day: 2,
        waypoints: [
          waypoint('Vaticano', 41.902, 12.4536),
          waypoint('Castel Sant Angelo', 41.903, 12.4663),
        ],
        route_details: [{ requires_vehicle: false }],
      },
    ],
    size
  );

  expect(drawn.labels).toEqual(['1', '2', '1', '2']);
});

test('unreachable tiles leave the route drawn on a plain backdrop', async () => {
  const drawn = stubCanvas();

  const image = await renderRouteImage(
    [
      {
        day: 1,
        waypoints: [
          waypoint('Colosseo', 41.89, 12.49),
          waypoint('Pantheon', 41.898, 12.476),
        ],
        route_details: [{ requires_vehicle: false }],
      },
    ],
    size
  );

  expect(drawn.tiles).toBe(0);
  expect(image).not.toBeNull();
});
