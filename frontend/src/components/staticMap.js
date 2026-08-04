/**
 * Draw the planned route onto a canvas and hand back an image.
 *
 * The on-screen map cannot be reused for this: html2canvas-style capture of a
 * Leaflet pane is fragile, and it would freeze whatever the reader had panned
 * or zoomed to rather than the whole trip. Fetching the tiles ourselves costs
 * about twenty requests and gives an image framed on the route, at whatever
 * resolution the PDF wants.
 *
 * Tiles come from the same public endpoint the live map uses, so an export
 * asks for roughly what scrolling the map already asks for. `crossOrigin`
 * matters: without it the canvas would be tainted and `toDataURL` would throw
 * at the very end, after all the work.
 */

import { dayColour } from './RouteMap';
import { isLoop } from './format';

const TILE_SIZE = 256;
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_TIMEOUT_MS = 8000;
const MIN_ZOOM = 2;
const MAX_ZOOM = 17;
// Kept clear around the route so no marker sits half off the edge.
const EDGE_PADDING = 44;
// Shown when a tile does not arrive; close to the land colour of the OSM
// style, so a hole in the mosaic reads as missing rather than broken.
const BACKDROP = '#eceee6';

/** Web Mercator, in the 256-pixel-per-tile space Leaflet and OSM both use. */
function project(lat, lon, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

/** The closest zoom that still leaves the whole route inside the frame. */
function chooseZoom(bounds, width, height) {
  const usableWidth = Math.max(width - EDGE_PADDING * 2, 1);
  const usableHeight = Math.max(height - EDGE_PADDING * 2, 1);

  for (let zoom = MAX_ZOOM; zoom > MIN_ZOOM; zoom -= 1) {
    const topLeft = project(bounds.north, bounds.west, zoom);
    const bottomRight = project(bounds.south, bounds.east, zoom);
    if (
      bottomRight.x - topLeft.x <= usableWidth &&
      bottomRight.y - topLeft.y <= usableHeight
    ) {
      return zoom;
    }
  }
  return MIN_ZOOM;
}

/**
 * Resolves to the image, or to null for anything that goes wrong: one absent
 * tile should leave a gap in the mosaic, not lose the whole export.
 */
function loadTile(url) {
  return new Promise((resolve) => {
    const image = new Image();
    const timer = setTimeout(() => {
      image.src = '';
      resolve(null);
    }, TILE_TIMEOUT_MS);
    const settle = (value) => {
      clearTimeout(timer);
      resolve(value);
    };

    image.crossOrigin = 'anonymous';
    image.onload = () => settle(image);
    image.onerror = () => settle(null);
    image.src = url;
  });
}

function boundsOf(points) {
  return points.reduce(
    (box, point) => ({
      north: Math.max(box.north, point.lat),
      south: Math.min(box.south, point.lat),
      west: Math.min(box.west, point.lon),
      east: Math.max(box.east, point.lon),
    }),
    {
      north: -Infinity,
      south: Infinity,
      west: Infinity,
      east: -Infinity,
    }
  );
}

async function paintTiles(ctx, { zoom, origin, width, height }) {
  const columns = 2 ** zoom;
  const requests = [];

  const firstColumn = Math.floor(origin.x / TILE_SIZE);
  const lastColumn = Math.floor((origin.x + width) / TILE_SIZE);
  const firstRow = Math.floor(origin.y / TILE_SIZE);
  const lastRow = Math.floor((origin.y + height) / TILE_SIZE);

  for (let row = firstRow; row <= lastRow; row += 1) {
    // Past the poles there is no tile to ask for; the backdrop stands in.
    if (row < 0 || row >= columns) continue;
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      // Longitude wraps, so a frame crossing the date line reuses tiles from
      // the other end of the world.
      const x = ((column % columns) + columns) % columns;
      const url = TILE_URL.replace('{z}', zoom)
        .replace('{x}', x)
        .replace('{y}', row);
      requests.push(
        loadTile(url).then((image) => ({
          image,
          dx: column * TILE_SIZE - origin.x,
          dy: row * TILE_SIZE - origin.y,
        }))
      );
    }
  }

  const tiles = await Promise.all(requests);
  tiles.forEach(({ image, dx, dy }) => {
    if (image) ctx.drawImage(image, dx, dy, TILE_SIZE, TILE_SIZE);
  });
  return tiles.some((tile) => tile.image);
}

function paintRoute(ctx, days, toCanvas) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Two passes: every casing first, so a later day's white outline cannot cut
  // through an earlier day's line where the two overlap.
  [
    { casing: true, width: 10, colour: 'rgba(255,255,255,0.9)' },
    { casing: false, width: 5 },
  ].forEach((pass) => {
    days.forEach((day, dayIndex) => {
      const points = day.waypoints.map((point) => toCanvas(point.lat, point.lon));
      const colour = dayColour(dayIndex);

      points.slice(0, -1).forEach((from, legIndex) => {
        const to = points[legIndex + 1];
        const leg = day.route_details[legIndex];
        const overLimit = Boolean(leg?.requires_vehicle);

        ctx.setLineDash(pass.casing || !overLimit ? [] : [16, 12]);
        ctx.lineWidth = pass.width;
        ctx.strokeStyle = pass.casing
          ? pass.colour
          : (overLimit && '#d9534f') || colour;

        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      });
    });
  });
  ctx.setLineDash([]);
}

function paintMarkers(ctx, days, toCanvas) {
  const radius = 15;

  days.forEach((day, dayIndex) => {
    const colour = dayColour(dayIndex);
    // Drawing the repeated final stop would stack two badges on one point,
    // hiding the "1" under the last number.
    const stops = isLoop(day.waypoints)
      ? day.waypoints.slice(0, -1)
      : day.waypoints;

    stops.forEach((point, index) => {
      const { x, y } = toCanvas(point.lat, point.lon);

      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 1;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = colour;
      ctx.fill();
      ctx.restore();

      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 15px Helvetica, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(index + 1), x, y);
    });
  });
}

/**
 * Render the whole trip to a JPEG data URL.
 *
 * @param {Array} days - the itinerary's days, as the API returns them.
 * @param {{width: number, height: number}} size - output size in pixels.
 * @returns {Promise<string|null>} null when there is nothing to draw or the
 *   browser refuses to export the canvas, which the caller treats as "produce
 *   the document without a map" rather than as a failure.
 */
export async function renderRouteImage(days, { width, height }) {
  const points = days.flatMap((day) => day.waypoints);
  if (points.length === 0) return null;

  const bounds = boundsOf(points);
  const singlePoint =
    bounds.north === bounds.south && bounds.west === bounds.east;
  const zoom = singlePoint ? 15 : chooseZoom(bounds, width, height);

  // Centring on the projected box rather than on the mean latitude: Mercator
  // stretches towards the poles, so the two are not the same point.
  const topLeft = project(bounds.north, bounds.west, zoom);
  const bottomRight = project(bounds.south, bounds.east, zoom);
  const origin = {
    x: (topLeft.x + bottomRight.x) / 2 - width / 2,
    y: (topLeft.y + bottomRight.y) / 2 - height / 2,
  };
  const toCanvas = (lat, lon) => {
    const projected = project(lat, lon, zoom);
    return { x: projected.x - origin.x, y: projected.y - origin.y };
  };

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = BACKDROP;
  ctx.fillRect(0, 0, width, height);

  await paintTiles(ctx, { zoom, origin, width, height });
  paintRoute(ctx, days, toCanvas);
  paintMarkers(ctx, days, toCanvas);

  try {
    return canvas.toDataURL('image/jpeg', 0.92);
  } catch {
    // A tainted canvas throws here. It should not happen while the tiles come
    // back with CORS headers, but losing the map beats losing the export.
    return null;
  }
}
