![Travel Planner — powered by DailyAI Labs](docs/images/readme-front.png)

# Travel Planner

A travel planning application that organizes trips by optimizing itineraries.
You add places, and they are ordered to minimize travel time. Every place has
its own dwell time (e.g. `45m`, `1h30`, `1:30`, `1.5h`, `2h`) and optional
opening hours (e.g. `10:00-18:00`). A trip can be split across days, which are
balanced on travel time. Three modes are supported — `walking`, `bicycle`
and `driving` — with a maximum walking distance of 2 km by default.
The itinerary can be exported as Markdown or PDF.

**Try it live: [dai-travel-planner-web.onrender.com](https://dai-travel-planner-web.onrender.com)**

Note: it is hosted on Render's free plan, so the first request after a period
of inactivity can take up to a minute while the API wakes up.

## Tech stack

| Layer | Choice |
|---|---|
| Backend | Python ([FastAPI](https://fastapi.tiangolo.com/)) |
| Frontend | React |
| Geocoding | [Photon](https://github.com/komoot/photon) (OpenStreetMap), swappable |
| Travel times and distances | [Valhalla](https://github.com/valhalla/valhalla), swappable |
| Route optimization | [Google OR-Tools](https://developers.google.com/optimization) |

No paid API is required. Both external services are open source and
self-hostable, and cost nothing per request.

## Contents

- [Quick start](#quick-start) — running locally with `run.sh` or by hand
  - [Self-hosting Photon](#self-hosting-photon)
  - [Self-hosting Valhalla](#self-hosting-valhalla)
- [API reference](#api-reference) — endpoints and an example request
- [Development](#development) — reload, tests, configuration and constants

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

**`run.sh` requires Linux, macOS or WSL.** The backend and frontend can also be
started separately, which works on any system, including **Windows**:

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

The public endpoints `photon.komoot.io` (geocoding) and
`valhalla1.openstreetmap.de` (travel times and distances) are community
services with fair-use expectations: fine for development and personal use,
not for production load. `docker compose up -d` hosts both locally.

### Self-hosting Photon

Part of `docker compose up -d`. Then in `backend/.env`:

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

## API reference

Every endpoint lives under `/api/v1`. There is no authentication, and jobs are
held in a module-level dict: nothing is persisted and nothing is evicted, so
restarting the backend loses every plan.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/geocode` | Resolve one place name to coordinates |
| `POST` | `/compute_itinerary` | Submit a trip; returns a 12-character code immediately |
| `GET` | `/travel_plan/{code}` | The full plan; poll until `completed` or `failed` |
| `GET` | `/travel_plan/{code}/status` | Status only — cheaper to poll than the whole itinerary |
| `DELETE` | `/travel_plan/{code}` | Drop one plan from the store |
| `GET` | `/travel_plans/status` | Every tracking code currently in memory |

`GET /health` sits outside the prefix, and FastAPI serves interactive docs at
[`/docs`](http://localhost:8000/docs) while the backend is running.

A request to `/compute_itinerary` — five places over two days, leaving from and
returning to the hotel each day:

```json
{
  "places": ["Hotel", "Big Ben", "Tower Bridge", "Buckingham Palace", "Tower of London"],
  "area": "London",
  "start_idx": 0,
  "end_idx": 0,
  "days": 2,
  "day_starts": [0, 0],
  "day_ends": [0, 0],
  "visit_seconds": [0, 3600, 1800, 3600, 5400],
  "opening_hours": [null, null, {"opens": "09:30", "closes": "18:00"}, {"opens": "10:00"}, null],
  "start_time": "2026-05-30T09:00:00",
  "modes": ["walking"],
  "walking_preference": true,
  "max_walking_distance": 2000,
  "max_cycling_distance": 5000
}
```

Required: `places`, `start_idx`, `end_idx`, `start_time`, `modes`,
`walking_preference`, `max_walking_distance`. Everything else may be omitted.
Index fields point into `places` and may be negative, counting from the end.
`modes` is a list for historical reasons, but the interface sends exactly one —
you travel one way per trip. Passing `resolved_places`, the payloads `/geocode`
already returned in the same order as `places`, skips geocoding entirely.
`start_time` is local wall-clock time with no UTC offset, since opening hours
are read against it.

Failures a client can act on carry a stable `error_code` and machine-readable
`error_params` beside the English `error` text, so a UI can phrase them in its
own language: `too_far_for_mode` when the routing engine refuses the distance,
`day_budget_exceeded` when the 16-hour daily cap cannot be met, and
`closes_before_start`, `opening_window_too_short` or `opening_hours_conflict`
when opening hours cannot be respected.

## Development

The virtualenv lives at `.venv/` in the **repo root**, not in `backend/`, and
the backend is installed editable. That is why imports read `app.services...`
rather than `backend.app.services...`, and why the backend runs from the repo
root. `./run.sh` sets all of this up; [Quick start](#quick-start) has the
manual equivalent.

To run the backend with reload on every edit, from the repo root:

```
uvicorn app.main:app --reload
```

The frontend suite is the only test suite that exists:

```
npm --prefix frontend test
```

Configuration is `backend/.env`, copied from `backend/.env.example` on first
run; that file documents every geocoding and routing setting. Three more are
read from the environment without appearing there, since the defaults are
almost always right:

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `0.0.0.0` | Interface uvicorn binds to |
| `PORT` | `8000` | Backend port |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated allowed origins |

A few numbers are deliberately constants in `backend/app/services/utils.py`
rather than settings, so changing them means editing the source:

| Constant | Value | What it does |
|---|---|---|
| `SOLVER_TIME_LIMIT_MS` | `1000` | How long the solver keeps improving a solution |
| `DAILY_TIME_BUDGET_SECONDS` | `16 * 60 * 60` | Hard cap on travel plus visits per day |
| `DAY_BALANCE_COEFFICIENT` | `100` | How hard days are pushed towards equal travel time |
