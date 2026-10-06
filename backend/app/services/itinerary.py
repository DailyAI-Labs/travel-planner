"""
Job store and async orchestration for itinerary computations.

Requests are answered with a tracking code straight away and computed in a
background task, with the blocking planner pushed onto a worker thread. Jobs
live in the module-level `travel_plans` dict: nothing is persisted, nothing is
evicted, and a restart loses everything.
"""

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any

from app.models.travel import ComputationStatus, ResolvedPlace, TravelPlanRequest
from app.services.geocoding import Place
from app.services.travel_planner import TravelPlanner

_planner = TravelPlanner()


async def resolve_place(place: str, area: str | None = None) -> Place | None:
    """
    Resolve one place name off the event loop.

    Geocoding blocks — the rate limiter sleeps between calls — so it must not
    run inline or it would stall every other request.

    Parameters
    ----------
    place : str
        Free-text place name as typed by the user.
    area : str | None, optional
        City or region used to disambiguate the name, by default None.

    Returns
    -------
    Place | None
        The resolved place, or None if the geocoder found no match.
    """
    return await asyncio.to_thread(_planner.resolve_place, place, area)


def _to_places(resolved: list[ResolvedPlace] | None) -> list[Place] | None:
    """Turn request payload back into the Place objects the planner uses.

    Parameters
    ----------
    resolved : list[ResolvedPlace] | None
        Places the client already resolved through /geocode, or None if it
        did not.

    Returns
    -------
    list[Place] | None
        The same places as planner-side objects, order preserved, falling
        back to `name` where the client sent no original `query`. None passes
        straight through, which is what tells the planner to geocode itself.
    """
    if resolved is None:
        return None
    return [
        Place(
            query=item.query or item.name,
            display_name=item.name,
            lat=item.lat,
            lon=item.lon,
        )
        for item in resolved
    ]


travel_plans: dict[str, dict[str, Any]] = {}


async def compute_itinerary_async(request: TravelPlanRequest, code: str) -> None:
    """
    Async function that runs the actual itinerary computation in background.

    Records the outcome in `travel_plans[code]` and returns nothing. Nothing
    is allowed to propagate: any exception is stored as a FAILED status, since
    there is no caller left to catch it.

    Parameters
    ----------
    request : TravelPlanRequest
        The itinerary to compute. Its fields are forwarded to
        `TravelPlanner.plan_route` on a worker thread, because that call
        blocks on geocoding, HTTP and the solver.
    code : str
        Tracking code whose record in `travel_plans` is updated in place. It
        must already exist.
    """
    try:
        travel_plans[code]["status"] = ComputationStatus.PROCESSING
        travel_plans[code]["updated_at"] = datetime.now(timezone.utc).isoformat()

        itinerary = await asyncio.to_thread(
            _planner.plan_route,
            places=request.places,
            start_idx=request.start_idx,
            end_idx=request.end_idx,
            start_time=request.start_time,
            modes=request.modes,
            walking_preference=request.walking_preference,
            max_walking_distance=request.max_walking_distance,
            max_cycling_distance=request.max_cycling_distance,
            area=request.area,
            days=request.days,
            day_starts=request.day_starts,
            day_ends=request.day_ends,
            resolved_places=_to_places(request.resolved_places),
            visit_seconds=request.visit_seconds,
            opening_hours=(
                [(h.opens, h.closes) if h else None for h in request.opening_hours]
                if request.opening_hours is not None
                else None
            ),
        )

        if not itinerary.get("success"):
            # A failed plan carries only 'error', not the Itinerary fields, so
            # reporting it as COMPLETED would break response validation and
            # hide the reason (an unsupported mode, an unresolved place, ...).
            travel_plans[code].update(
                {
                    "status": ComputationStatus.FAILED,
                    "error": _failure_message(itinerary),
                    "error_code": itinerary.get("error_code"),
                    "error_params": itinerary.get("error_params"),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            )
            return

        travel_plans[code].update(
            {
                "status": ComputationStatus.COMPLETED,
                "itinerary": itinerary,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        )

    except Exception as e:  # noqa: BLE001 - nothing escapes a background task
        travel_plans[code].update(
            {
                "status": ComputationStatus.FAILED,
                "error": str(e),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        )


def _failure_message(itinerary: dict[str, Any]) -> str:
    """Flatten a failed plan into one readable message.

    Parameters
    ----------
    itinerary : dict[str, Any]
        A plan whose `success` key was false. Its `error` carries the
        headline reason; `validation_result`, when present, carries the
        individual `invalid_places` that could not be geocoded.

    Returns
    -------
    str
        The headline reason, extended with the unresolved place names and
        their own errors when geocoding was what failed.
    """
    error: str = itinerary.get("error", "Route optimization failed")

    validation = itinerary.get("validation_result")
    if validation:
        unresolved = ", ".join(
            f"{item['place']} ({item['error']})"
            for item in validation.get("invalid_places", [])
        )
        if unresolved:
            return f"{error}: {unresolved}"

    return error


async def start_itinerary_computation(request: TravelPlanRequest) -> str:
    """
    Start async itinerary computation and return tracking code.

    Returns as soon as the record exists and the background task is
    scheduled; no planning has happened yet.

    Parameters
    ----------
    request : TravelPlanRequest
        The itinerary to compute.

    Returns
    -------
    str
        A 12-character uppercase code, the key under which the plan can be
        polled for as long as the process lives.
    """
    code = str(uuid.uuid4())[:12].upper()

    travel_plans[code] = {
        "status": ComputationStatus.PENDING,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "itinerary": None,
        "error": None,
        "error_code": None,
        "error_params": None,
    }

    asyncio.create_task(compute_itinerary_async(request, code))

    return code


def get_all_travel_plans() -> dict[str, dict[str, Any]]:
    """
    Retrieve all travel plans.

    Returns
    -------
    dict[str, dict[str, Any]]
        A shallow copy keyed by tracking code, so callers cannot add or
        remove jobs — but the plan records themselves are shared.
    """
    return travel_plans.copy()


def get_travel_plan(code: str) -> dict[str, Any] | None:
    """
    Retrieve a travel plan by its code.

    Parameters
    ----------
    code : str
        Tracking code returned by `start_itinerary_computation`.

    Returns
    -------
    dict[str, Any] | None
        The live record — keys `status`, `created_at`, `updated_at`,
        `itinerary`, `error`, `error_code`, `error_params` — or None if no
        plan is stored under that code.
    """
    return travel_plans.get(code)


def travel_plan_exists(code: str) -> bool:
    """
    Check if a travel plan exists.

    Parameters
    ----------
    code : str
        Tracking code to look up.

    Returns
    -------
    bool
        True if a record is stored under that code, whatever its status.
    """
    return code in travel_plans


def delete_travel_plan(code: str) -> bool:
    """
    Delete a travel plan (optional cleanup).

    A still-running background task is not cancelled; it will fail with a
    KeyError when it next tries to record its progress.

    Parameters
    ----------
    code : str
        Tracking code of the plan to remove.

    Returns
    -------
    bool
        True if a record was removed, False if the code was unknown.
    """
    if code in travel_plans:
        del travel_plans[code]
        return True
    return False
