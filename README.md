# DailyAI: Travel Planner

Travel planning application to organize trips by optimizing itineraries.

### Tech Stack
- Backend: Python (FastAPI)
- Frontend: React
- Geocoding: [Photon](https://github.com/komoot/photon) (OpenStreetMap), swappable
- Travel times and distances: [Valhalla](https://github.com/valhalla/valhalla), swappable
- Route optimization: Google OR-Tools

No paid API is required. Both external services are open source and
self-hostable, and cost nothing per request.

## Quick start

You do not need Docker to try it. Public community instances of both services
exist, so this works immediately:

```
./run.sh
```

That creates the virtualenv, installs both sets of dependencies and copies
`backend/.env` on first run, then starts the API on
[localhost:8000](http://localhost:8000) and the UI on
[localhost:3000](http://localhost:3000), tagging each line of output with which
side it came from. Ctrl-C stops both, and if either one dies the other is shut
down with it.

Ports and browser behaviour are overridable:

```
BACKEND_PORT=8010 FRONTEND_PORT=3010 OPEN_BROWSER=0 ./run.sh
```

**`run.sh` requires Linux, macOS or WSL.** It stops its two servers with POSIX
signals and process groups, which Windows does not have, and it relies on
`lsof` and `pgrep`, which Git Bash does not ship. On native Windows, start the
two halves separately as below — that works everywhere. The script checks for
its tools up front and says so rather than failing halfway.

To run the two halves yourself instead:

```
# 1. Backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
pip install -e backend
cp backend/.env.example backend/.env      # defaults already point at the public instances
python backend/main.py                    # http://localhost:8000

# 2. Frontend, in a second terminal
cd frontend && npm install && npm start   # http://localhost:3000
```

Those public endpoints — `photon.komoot.io` for geocoding and
`valhalla1.openstreetmap.de`, run by FOSSGIS for the OpenStreetMap project,
for routing — are community services with fair-use expectations. They are
right for development and personal use, and wrong for production load. When
you outgrow them, `docker compose up -d` runs both locally and you change two
URLs in `backend/.env`; nothing else moves.

Google remains available as an opt-in alternative for either service — it is
the only option that offers live traffic and public transport, and the only
one that is billed.

## Geocoding

Place names are resolved to coordinates by an open source, OpenStreetMap-backed
geocoder. The provider is chosen with the `GEOCODER` environment variable — see
`backend/.env.example` for all settings.

| Provider | `GEOCODER` | Notes |
|---|---|---|
| Photon | `photon` | Default. Prebuilt index, so self-hosting needs no database import |
| Nominatim | `nominatim` | Comparable accuracy; self-hosting needs PostgreSQL + PostGIS and a full OSM import |
| Google | `google` | Requires a billable `GCP_API_KEY` |

Chain providers with `+` to fall back when the first finds nothing, e.g.
`GEOCODER=photon+nominatim`.

### Validate as you type

`POST /api/v1/geocode` resolves a single place name, so a client can check each
one as it is entered instead of discovering a bad match inside a finished
itinerary. The UI does this on every add, shows what the geocoder matched, and
re-checks everything when the city changes.

Feed the results back as `resolved_places` on `/compute_itinerary` and the
planner skips geocoding altogether — the same four-place Rome trip completes in
about 1 second instead of 4, since the rate-limited lookups already happened
while you were typing.

Note that a result is not the same as a *good* result: `qwertyuiop asdfgh` with
`area: Roma` resolves happily to a school in Casablanca. Photon almost always
returns something, which is exactly why showing the matched name matters.

### Always pass an `area`

OpenStreetMap geocoders match on structured map tags rather than a query log,
so a bare landmark name is frequently ambiguous worldwide. The optional `area`
field in the request is what disambiguates it, and it matters a lot:

| Query | Result |
|---|---|
| `Big Ben` | a hill in Queensland, Australia |
| `Big Ben` + `area: London` | Big Ben, Bridge Street, London |
| `Eiffel Tower` | Eiffel Tower, Alberta, Canada |
| `Eiffel Tower` + `area: Paris` | Tour Eiffel, Paris |

Across 20 landmarks in 8 cities, Photon resolved 20/20 within 200 m when given
an `area`. Note also that parenthesised text derails these geocoders —
`Big Ben (Elizabeth Tower)` alone matches a replica in Cambodia — so the
backend strips parentheses and retries before giving up.

### Self-hosting Photon

The public endpoints are fine for development but are not production services:
Nominatim caps callers at 1 request/second and forbids bulk querying, and
Komoot provides `photon.komoot.io` without an SLA. Self-hosting removes both
the rate limit and the external dependency, at no per-request cost. It is part
of `docker compose up -d`; then set in `backend/.env`:

```
GEOCODER=photon
GEOCODER_DOMAIN=localhost:2322
GEOCODER_MIN_DELAY=0
```

The first start downloads the search index and takes a while. The full planet
index is large, so the compose file defaults to a country extract via
`PHOTON_REGION` — make sure it covers every area you want to support, since a
place outside the imported extract will not resolve. To avoid the third-party
image, download the index and jar from the
[Photon releases](https://github.com/komoot/photon/releases) and run
`java -jar photon.jar` directly; it serves on port 2322 either way.

## Travel times and distances

The optimizer needs, for every pair of places and every mode, a travel time
and a distance. Those come from a routing engine chosen with
`MATRIX_PROVIDER`.

| Provider | `MATRIX_PROVIDER` | Notes |
|---|---|---|
| Valhalla | `valhalla` | Default. One instance serves every mode from one set of tiles |
| Google | `google` | Requires a billable `GCP_API_KEY`. The only option with live traffic and transit |

Valhalla was chosen over OSRM because a single container and a single tile
build cover driving, walking and cycling, whereas OSRM needs a separately
preprocessed graph — and therefore a separate service and its own memory
footprint — per profile. OSRM computes matrices faster, but at the sizes this
app produces (a handful of places) that advantage is invisible.

### Splitting a trip across days

Set `days` to more than one and the places are clustered into that many days,
each ordered internally. Every day has its own start and end place via
`day_starts` and `day_ends`; pointing them all at the same place is how "leave
from and return to the hotel every day" is expressed.

Under the hood this is one vehicle per day sharing a single distance matrix, so
extra days cost no extra requests to the routing engine.

**Days are balanced on travel time, not on how many stops they hold.** That is
what actually makes a day tiring: three sights spread across a city is a harder
day than six clustered in one quarter. A global span cost penalises the gap
between the busiest and the quietest day. On six places in Rome over two days,
this produces one day with four central stops (59 min) and one with a single
round trip to the Colosseum (57 min) — very different counts, near-identical
effort. Balancing by count instead gave three and three, and on a deliberately
lopsided test set left one day carrying eight times the travel of the other.

The balance is a cost rather than a hard cap on purpose: a hard limit on daily
travel turns into an unexplained "no solution" the moment it cannot be met. A
separate floor of one stop per day keeps any day from being emptied out, since
piling everything onto one day genuinely does minimise total travel.

Guided local search never proves optimality, so `SOLVER_TIME_LIMIT_MS` is the
solver's runtime rather than a ceiling on it — set it to 30 s and every
multi-day plan takes 30 s. Measured on fixed instances up to 40 places over
4 days, the objective was identical at 500 ms and at 30 s, so it is set to one
second.

Start and end places are not stops, so they do not count towards a day's load.
A day that goes from one place to a different one is already a journey even
with nothing in between; a day that loops back to its own start needs at least
one place of its own, and the request is rejected when there are not enough to
go round.

### Modes

You travel one way per trip: `walking`, `bicycle`, or `driving`. The UI offers
these as a single choice, and walking is the default.

For walking and cycling, a leg longer than its threshold —
`max_walking_distance` (default 1000 m) or `max_cycling_distance` (default
5000 m) — is not silently switched to another mode. It is returned with
`requires_vehicle: true` and a note naming what you asked for, e.g. *"Too far
to walk: take public transport or a car"*. Raise the threshold if you are
willing to go further on your own.

Those flagged legs are still costed with driving times, which is why the
driving matrix is fetched even when you did not ask for it. Without a real
cost, a 30 km leg would be priced as a seven-hour walk, or dropped entirely,
since pedestrian routing gives up over long distances. It comes from the same
Valhalla instance as the other profiles, so it costs nothing extra.

**Public transport is not supported.** No open source engine provides it from
OSM data alone: it requires a GTFS feed for each city, ingested into
[OpenTripPlanner](https://www.opentripplanner.org/) or into Valhalla's
multimodal transit tiles, and re-ingested whenever a feed changes. The feeds
themselves are free — see the
[Mobility Database](https://mobilitydatabase.org/),
[Transitland](https://www.transit.land/), and the national access points EU
member states are required to run — but keeping them current is ongoing work.
Legs needing transit are flagged rather than routed. Set
`MATRIX_PROVIDER=google` if you need real transit routing.

Valhalla also has no live traffic model, so driving times are free-flow
estimates rather than traffic-aware predictions.

### Distance limits

Valhalla refuses a matrix outright when any pair of places exceeds its limit
for the chosen profile — 200 km on foot or by bike, 400 km by car on the public
instance. One place resolving somewhere unexpected is enough to trigger it, so
the failure names the two furthest-apart stops and how far apart they are.
Self-hosted instances can raise these limits in `service_limits`. There is also
a cap of 2500 source–target pairs, or roughly fifty places.

### Self-hosting Valhalla

Part of `docker compose up -d`. Set the OSM extract to build tiles from with
`PBF_URL` — [Geofabrik](https://download.geofabrik.de/) publishes these per
country and region, and the smallest extract covering your trips is the right
choice. Then in `backend/.env`:

```
MATRIX_PROVIDER=valhalla
VALHALLA_URL=http://localhost:8002
```

The first start builds routing tiles and takes a while. Keep `PBF_URL` and
`PHOTON_REGION` pointing at the same area: routes that cross the boundary of
the imported extract will not be found. To avoid the third-party image, follow
the [official Valhalla build instructions](https://github.com/valhalla/valhalla)
and run `valhalla_service` yourself; it serves `sources_to_targets` on port
8002 either way.

### Backend set up
1. Create and activate a virtual environment
2. Navigate to the backend folder
```
cd backend
```
3. Install required libraries by running 
```
pip install -r requirements.txt
```
4. Install our package in editable mode by running: 
```
pip3 install -e .
```

### Running the backend
- From the root folder, run
```
python backend/main.py   
```

- Alternatively, from the folder `backend/`, run
```
uvicorn app.main:app --reload    
```

Example
```
{
  "places": ["Big Ben", "Tower Bridge", "Buckingham Palace", "Tower of London", "London Eye"],
  "area": "London",
  "start_idx": 0,
  "end_idx": -1,
  "start_time": "2025-05-30T21:31:18.387Z",
  "modes": ["walking", "driving"],
  "walking_preference": true,
  "max_walking_distance": 1000
}
```


### Running the frontend
```
cd frontend
npm install
npm start
```

Name the city and confirm it — it is required, because a bare landmark name is
ambiguous worldwide, and everything you add afterwards is looked up inside it.
Then add the places, choose how you are getting around, pick where to start and
finish, and plan. The result is shown as an ordered list of legs and drawn on a
map.

Places can be added one at a time or pasted as a whole list. The paste box
strips the markers people actually use — `-`, `*`, `•`, `1.`, `(2)`, `#3`,
markdown checkboxes, and any indentation — splitting on lines so that commas
stay inside names like `Piazza San Marco, Venezia`. It shows how many places it
found before you commit, skips ones already in your list, and keeps any it
could not resolve in the box so you can fix the spelling and retry.

The interface is available in English and Italian; the selector is in the
header and the choice is remembered.

Example

- City or region: `London`
- Places: `Big Ben`, `Tower Bridge`, `Buckingham Palace`, `Tower of London`
- Getting around: `On foot`
- Days: `1` — raise it and each day gets its own start and finish selectors

The map uses [Leaflet](https://leafletjs.com/) with OpenStreetMap tiles — no
API key and no billing. The lines connect stops in visit order as straight
segments rather than tracing streets; drawing real geometry would mean asking
Valhalla for route shapes and returning them from the backend. Note that
`tile.openstreetmap.org` has a
[tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
intended for modest traffic; anything heavier should use a self-hosted or
commercial tile source.
