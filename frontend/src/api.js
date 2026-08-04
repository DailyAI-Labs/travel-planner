const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:8000';

/** FastAPI reports problems in `detail`, which may be a string or a list. */
async function readError(response) {
  let detail;
  try {
    const body = await response.json();
    detail = body.detail;
  } catch {
    return `Request failed (HTTP ${response.status})`;
  }

  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => `${(item.loc || []).join('.')}: ${item.msg}`)
      .join('; ');
  }
  return `Request failed (HTTP ${response.status})`;
}

async function request(path, options) {
  const response = await fetch(`${API_BASE}${path}`, options);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return response.json();
}

/** Takes `options` so the caller can hand in an abort signal to time it out. */
export function checkHealth(options) {
  return request('/health', options);
}

/**
 * Submit an itinerary request. Returns a code used to poll for the result,
 * since the backend computes routes in the background.
 */
export function submitItinerary(payload) {
  return request('/api/v1/compute_itinerary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function fetchItinerary(code) {
  return request(`/api/v1/travel_plan/${code}`);
}

/**
 * Resolve one place name to coordinates, so a bad match shows up as it is
 * entered rather than buried in a finished itinerary.
 */
export function geocodePlace(place, area) {
  return request('/api/v1/geocode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ place, area: area || null }),
  });
}
