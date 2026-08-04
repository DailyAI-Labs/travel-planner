"""
HTTP endpoints for geocoding places and computing itineraries.

Itineraries are computed in the background: /compute_itinerary returns a
tracking code immediately and the client polls /travel_plan/{code} until the
status is "completed" or "failed". Nothing here blocks the event loop; the
service layer moves the geocoder, the routing engine and the solver onto
worker threads.
"""

from typing import Any, cast

from app.models.travel import (
    GeocodeRequest,
    GeocodeResponse,
    TravelPlanRequest,
    TravelPlanResponse,
    TravelPlanStatus,
    Waypoint,
)
from app.services.itinerary import (
    delete_travel_plan,
    get_all_travel_plans,
    get_travel_plan,
    resolve_place,
    start_itinerary_computation,
    travel_plan_exists,
)
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/v1", tags=["travel_planner"])


@router.post("/geocode", response_model=GeocodeResponse)
async def geocode_single_place(request: GeocodeRequest) -> GeocodeResponse:
    """
    Resolve one place name to coordinates.

    Lets a client check each place as it is entered, instead of discovering a
    bad match only once a whole itinerary comes back. Feed the results to
    /compute_itinerary as `resolved_places` to skip geocoding there.

    - **place**: the name to resolve
    - **area**: city or region providing context, strongly recommended

    Parameters
    ----------
    request : GeocodeRequest
        Carries the place name and the optional area context described above.

    Returns
    -------
    GeocodeResponse
        `found=True` with `place` set to the matched waypoint, or
        `found=False` with `error` describing why: "No match found" when the
        geocoder returned nothing, or the exception text when it failed. A
        geocoder failure is reported this way rather than raised.

    Raises
    ------
    HTTPException
        422 if `place` is empty or only whitespace.
    """
    if not request.place.strip():
        raise HTTPException(status_code=422, detail="place must not be empty")

    try:
        resolved = await resolve_place(request.place, request.area)
    except Exception as e:  # noqa: BLE001 - geocoder failures are reported, not raised
        return GeocodeResponse(found=False, query=request.place, error=str(e))

    if resolved is None:
        return GeocodeResponse(
            found=False,
            query=request.place,
            error="No match found",
        )

    return GeocodeResponse(
        found=True,
        query=request.place,
        place=Waypoint(name=resolved.display_name, lat=resolved.lat, lon=resolved.lon),
    )


@router.post("/compute_itinerary", response_model=TravelPlanStatus)
async def post_travel_plan_request(request: TravelPlanRequest) -> TravelPlanStatus:
    """
    Submit a travel request and get a code to retrieve the computed itinerary.
    The computation runs asynchronously in the background.

    - **places**: List of place names to visit
    - **area**: Optional city or region the places belong to (e.g. "London").
      Strongly recommended: it disambiguates landmark names that are otherwise
      ambiguous worldwide.
    - **start_idx**: Index of the starting place in the places list
    - **end_idx**: Index of the ending place in the places list
    - **start_time**: When to start the journey
    - **modes**: Preferred transportation modes (e.g., ["walking", "public_transport", "car"])
    - **walking_preference**: Whether walking is preferred when possible
    - **max_walking_distance**: Maximum walking distance in meters

    Returns a code to track the computation progress.

    Parameters
    ----------
    request : TravelPlanRequest
        The full itinerary request, whose fields are described above.

    Returns
    -------
    TravelPlanStatus
        The 12-character tracking code, a status of "pending", and a message.
        The code is returned before any computation has run; poll
        /travel_plan/{code} for the result.

    Raises
    ------
    HTTPException
        500 if the computation could not be scheduled at all.
    """
    try:
        code = await start_itinerary_computation(request)
        return TravelPlanStatus(
            code=code,
            status="pending",
            message="Itinerary computation started. Use the code to check progress.",
        )
    except Exception as e:  # noqa: BLE001 - any start-up failure becomes a 500
        raise HTTPException(
            status_code=500, detail=f"Error starting computation: {e!s}"
        )


@router.get("/travel_plan/{code}", response_model=TravelPlanResponse)
async def get_travel_plan_by_code(code: str) -> TravelPlanResponse:
    """
    Retrieve a computed travel plan using its code.

    - **code**: The unique code returned when submitting the travel request

    Status can be:
    - **pending**: Computation not started yet
    - **processing**: Computation in progress
    - **completed**: Computation finished successfully
    - **failed**: Computation failed with error

    Parameters
    ----------
    code : str
        Tracking code returned by /compute_itinerary.

    Returns
    -------
    TravelPlanResponse
        The stored plan. `itinerary` is populated once the status is
        "completed"; `error`, `error_code` and `error_params` once it is
        "failed".

    Raises
    ------
    HTTPException
        404 if no plan is stored under that code.
    """
    if not travel_plan_exists(code):
        raise HTTPException(status_code=404, detail="Travel plan not found")

    # travel_plan_exists() above already established the code is present.
    plan = cast("dict[str, Any]", get_travel_plan(code))
    return TravelPlanResponse(**plan)


@router.delete("/travel_plan/{code}")
async def delete_travel_plan_endpoint(code: str) -> dict[str, str]:
    """
    Delete a travel plan (optional cleanup endpoint).

    - **code**: The unique code of the travel plan to delete

    Parameters
    ----------
    code : str
        Tracking code of the plan to remove from the in-memory store.

    Returns
    -------
    dict[str, str]
        A single `message` key confirming the deletion.

    Raises
    ------
    HTTPException
        404 if no plan is stored under that code, 500 if the deletion itself
        did not take effect.
    """
    if not travel_plan_exists(code):
        raise HTTPException(status_code=404, detail="Travel plan not found")

    success = delete_travel_plan(code)
    if success:
        return {"message": "Travel plan deleted successfully"}
    else:
        raise HTTPException(status_code=500, detail="Failed to delete travel plan")


@router.get("/travel_plan/{code}/status")
async def get_travel_plan_status(code: str) -> dict[str, Any]:
    """
    Get just the status of a travel plan computation.

    - **code**: The unique code of the travel plan

    Cheaper to poll than the full plan, which carries the whole itinerary.

    Parameters
    ----------
    code : str
        Tracking code returned by /compute_itinerary.

    Returns
    -------
    dict[str, Any]
        Keys `code`, `status`, `updated_at` (ISO 8601 string) and `error`,
        the last being None while the computation has not failed.

    Raises
    ------
    HTTPException
        404 if no plan is stored under that code.
    """
    if not travel_plan_exists(code):
        raise HTTPException(status_code=404, detail="Travel plan not found")

    # travel_plan_exists() above already established the code is present.
    plan = cast("dict[str, Any]", get_travel_plan(code))
    return {
        "code": code,
        "status": plan["status"],
        "updated_at": plan["updated_at"],
        "error": plan.get("error"),
    }


@router.get("/travel_plans/status")
async def get_all_travel_plans_statuses() -> dict[str, str | list[str]]:
    """
    Get the status of all travel plan computations.

    Returns a list of all travel plans with their current status.

    Returns
    -------
    dict[str, str | list[str]]
        `{"codes": [...]}` listing every tracking code currently held in
        memory. Despite the summary, no status is included. When the store is
        empty the shape differs: `{"message": ..., "plans": []}`.
    """
    all_plans = get_all_travel_plans()

    if not all_plans:
        return {"message": "No travel plans found", "plans": []}

    return {"codes": list(all_plans.keys())}
