"""
Route optimization: mode selection, the OR-Tools model, response building.

`optimize_route` is the entry point. It fetches one time and distance matrix
per transport mode, collapses them into a single matrix holding the best mode
for each pair of places, and hands that to OR-Tools as one vehicle per day
with per-day start and end depots.

Times are in seconds and distances in meters throughout; INFINITE_VAL (999999)
marks a pair the routing engine could not connect. Nothing here raises across
the layer boundary: failures come back as a dict whose `success` key is false.
"""

import time
from collections.abc import Callable
from datetime import datetime, timedelta
from math import asin, cos, radians, sin, sqrt
from typing import Any, ParamSpec, TypeVar

from app.services.geocoding import GeocodingProvider, Place
from app.services.matrices import (
    CYCLING_MODE,
    INFINITE_VAL,
    VEHICLE_FALLBACK_MODE,
    WALKING_MODE,
    MatrixProvider,
    MatrixProviderError,
    UnsupportedModeError,
)

# ortools ships no type information, so every solver object below is Any.
from ortools.constraint_solver import (  # type: ignore[import-untyped]
    pywrapcp,
    routing_enums_pb2,
)

# Aliases for the untyped OR-Tools objects, so signatures still say what they
# take even though the checker cannot verify it.
RoutingModel = Any  # pywrapcp.RoutingModel
RoutingIndexManager = Any  # pywrapcp.RoutingIndexManager
Assignment = Any  # pywrapcp.Assignment, the solver's answer

DEFAULT_MODES: list[str] = [WALKING_MODE, CYCLING_MODE, VEHICLE_FALLBACK_MODE]

# How hard to push days towards carrying equal travel time. High enough to
# matter against raw travel cost, low enough not to produce absurd detours.
DAY_BALANCE_COEFFICIENT: int = 100

# How long the solver is allowed to keep improving. See _solve_routing_problem.
SOLVER_TIME_LIMIT_MS: int = 1000

# Travel plus time spent at places, per day. Fixed rather than configurable:
# 24 hours minus 8 asleep is a ceiling nobody needs to tune, and one less
# number to fill in. It is a safety rail, not a target — days are still
# balanced on travel time alone.
DAILY_TIME_BUDGET_SECONDS: int = 16 * 60 * 60


_P = ParamSpec("_P")
_R = TypeVar("_R")


def log_time(func: Callable[_P, _R]) -> Callable[_P, _R]:
    """
    Decorator function to compute the execution time of a function.

    The timing goes to stdout, which is the app's only progress log for the
    slow stages: geocoding, matrix fetching and the solver.

    Parameters
    ----------
    func : Callable[_P, _R]
        The function to time. Its signature is preserved.

    Returns
    -------
    Callable[_P, _R]
        A wrapper that calls `func`, prints how long it took, and returns
        whatever it returned. Note that `functools.wraps` is not applied, so
        the wrapper does not carry the original name or docstring.
    """

    def wrapper(*args: _P.args, **kwargs: _P.kwargs) -> _R:
        """Time one call to the decorated function and print the result."""
        start_time = time.time()
        result = func(*args, **kwargs)
        end_time = time.time()
        elapsed_time = end_time - start_time
        print(f"Execution time of {func.__name__}: {elapsed_time:.4f} seconds")
        return result

    return wrapper


@log_time
def validate_places(
    places: list[str], geocoder: GeocodingProvider, area: str | None = None
) -> dict[str, Any]:
    """
    Resolve place names to coordinates using the configured geocoding provider.

    Blocks: one geocoder lookup per place, each behind the provider's rate
    limiter, so a long list takes seconds per name. One place failing does not
    stop the batch — every name is attempted and the failures collected.

    Parameters
    ----------
    places : list[str]
        List of place names.
    geocoder : GeocodingProvider
        Provider used to resolve the names.
    area : str | None, optional
        City or region the places belong to, by default None. Strongly
        recommended: a bare landmark name is often ambiguous worldwide.

    Returns
    -------
    dict[str, Any]
        Validation results with `is_valid` (True only when nothing failed),
        `valid_places` (Place objects, in input order but with the failures
        missing, so positions no longer line up with `places`), and
        `invalid_places` (one dict per failure, with `index`, `place` and
        `error`).
    """
    valid_places: list[Place] = []
    invalid_places: list[dict[str, Any]] = []

    print(f"Validating place names via '{geocoder.name}'...")
    if area:
        print(f"Area context: {area}")
    print("-" * 60)

    for i, place in enumerate(places):
        try:
            resolved = geocoder.geocode(place, area)
            if resolved is not None:
                valid_places.append(resolved)
                print(f"OK [{i}] {place}")
                print(f"    → {resolved.display_name}")
                print(f"    → {resolved.lat:.5f}, {resolved.lon:.5f}")
            else:
                invalid_places.append(
                    {"index": i, "place": place, "error": "No geocoding results found"}
                )
                print(f"KO [{i}] {place} - No results found")

        except Exception as e:  # noqa: BLE001 - one bad place must not sink the batch
            invalid_places.append({"index": i, "place": place, "error": str(e)})
            print(f"KO [{i}] {place} - Error: {e}")

    print("-" * 60)

    is_valid = len(invalid_places) == 0

    return {
        "is_valid": is_valid,
        "valid_places": valid_places,
        "invalid_places": invalid_places,
    }


def optimize_route(
    places: list[Place],
    day_starts: list[int],
    day_ends: list[int],
    matrix_provider: MatrixProvider,
    start_time: datetime | None = None,
    modes: list[str] = DEFAULT_MODES,
    walking_preference: bool = True,
    max_walking_distance: int = 1000,
    max_cycling_distance: int = 5000,
    visit_seconds: list[int] | None = None,
) -> dict[str, Any]:
    """
    Main function that runs the route optimization.

    `day_starts` and `day_ends` hold one place index per day; their length is
    the number of days the trip is split across.

    Blocks: one matrix request per mode, then the solver's fixed time budget.

    Parameters
    ----------
    places : list[Place]
        Places to visit, already resolved to coordinates. Every index below
        refers to a position in this list.
    day_starts : list[int]
        Place index each day starts from, one entry per day. Must be
        non-negative; `TravelPlanner.plan_route` normalises them first.
    day_ends : list[int]
        Place index each day ends at, one entry per day. A day whose start
        and end coincide is a round trip.
    matrix_provider : MatrixProvider
        Source of the travel time and distance matrices.
    start_time : datetime | None, optional
        When day one begins; later days resume at the same wall-clock time.
        By default None, meaning now.
    modes : list[str], optional
        Canonical modes the traveller is willing to use, by default
        DEFAULT_MODES. VEHICLE_FALLBACK_MODE is fetched even when absent
        here, so that over-long legs get a realistic cost; this list, not the
        fetched one, is what the failure and vehicle notes are worded from.
    walking_preference : bool, optional
        Prefer a human-powered mode wherever one is within range, even when
        driving would be faster, by default True.
    max_walking_distance : int, optional
        Longest leg to walk, in meters, by default 1000.
    max_cycling_distance : int, optional
        Longest leg to cycle, in meters, by default 5000.
    visit_seconds : list[int] | None, optional
        Time spent at each place, one entry per place and in the same order.
        By default None, meaning no time is spent anywhere. Places serving as
        a daily start or end contribute nothing wherever they appear, since
        depots are not stops.

    Returns
    -------
    dict[str, Any]
        On success, `success` True plus `days` (one plan per day),
        `total_travel_time_seconds`, `total_visit_time_seconds`,
        `total_distance_meters`, `start_time` and `estimated_end_time`. On
        failure, `success` False plus `error`, and for a refusal a user can
        act on also `error_code` ('too_far_for_mode' or 'day_budget_exceeded')
        and `error_params`, so the UI can phrase it in its own language.
    """
    if start_time is None:
        # Naive local wall-clock on purpose: this is the time the traveller
        # sets off, and it is added to naive per-day starts/ends downstream.
        start_time = datetime.now()  # noqa: DTZ005

    if visit_seconds is not None:
        # Cheap and certain: refuse before spending a matrix request.
        refusal = _check_visit_budget(visit_seconds, day_starts, day_ends)
        if refusal is not None:
            return {"success": False, **refusal}

    print("Optimize route...")
    print("-" * 60)

    # Long legs need a driving cost, or the solver prices them as multi-hour
    # walks — or as unreachable, since pedestrian routing gives up on them.
    fetch_modes = list(modes)
    if VEHICLE_FALLBACK_MODE not in fetch_modes:
        fetch_modes.append(VEHICLE_FALLBACK_MODE)

    print("Get travel matrices...")
    try:
        time_matrices, distance_matrices = _get_travel_matrices(
            places, fetch_modes, start_time, matrix_provider
        )
    except UnsupportedModeError as e:
        return {"success": False, "error": str(e)}
    except MatrixProviderError as e:
        return {"success": False, **_explain_matrix_refusal(str(e), places, modes)}

    if not time_matrices:
        return {"success": False, "error": "Failed to get travel data"}

    print("Create optimal matrices...")
    best_time_matrix, best_mode_matrix, vehicle_matrix = _create_optimal_matrices(
        time_matrices,
        distance_matrices,
        fetch_modes,
        walking_preference,
        max_walking_distance,
        max_cycling_distance,
    )

    print("Solve routing problem...")
    route_solution = _solve_routing_problem(
        best_time_matrix, day_starts, day_ends, visit_seconds
    )

    if not route_solution["success"]:
        return route_solution

    print("Build route response...")
    return _build_route_response(
        route_solution,
        places,
        best_time_matrix,
        best_mode_matrix,
        vehicle_matrix,
        distance_matrices,
        start_time,
        modes,
        visit_seconds,
    )


@log_time
def _solve_routing_problem(
    time_matrix: list[list[int]],
    start_indices: list[int],
    end_indices: list[int],
    visit_seconds: list[int] | None = None,
) -> dict[str, Any]:
    """
    Split the places across days and order each day, minimising total travel.

    One vehicle per day, each with its own start and end depot. Days may share
    a depot, which is how "leave from and return to the hotel every day" is
    expressed.

    Time spent at places deliberately does not enter the objective. Every
    place is visited exactly once, so the visit total is the same for every
    ordering and cancels out; it would only shift which places share a day,
    and days are balanced on travel time by design. It is capped instead: see
    the 'DayTotal' dimension below.

    Blocks for SOLVER_TIME_LIMIT_MS (1 s), which is a runtime rather than a
    ceiling: guided local search keeps improving until the limit expires.

    Parameters
    ----------
    time_matrix : list[list[int]]
        Square matrix of travel times in seconds, one entry per pair of
        places, already collapsed to the best mode for each pair.
    start_indices : list[int]
        Place index each day starts from, one entry per day. Its length is
        what determines the number of days.
    end_indices : list[int]
        Place index each day ends at, one entry per day.
    visit_seconds : list[int] | None, optional
        Time spent at each place, one entry per place. By default None,
        meaning no time is spent anywhere and only travel is capped.

    Returns
    -------
    dict[str, Any]
        On success, `success` True, `routes` (one list of place indices per
        day, including the day's start and end depots), and
        `total_distance` — which despite its name holds the total travel
        **time in seconds**, because the arc cost evaluator is registered
        from the time matrix. No caller reads it. On failure, `success` False
        and `error`, plus `error_code` 'day_budget_exceeded' when the cap is
        the likely cause.
    """
    n_nodes = len(time_matrix)
    n_days = len(start_indices)
    depots = set(start_indices) | set(end_indices)
    visits = visit_seconds or [0] * n_nodes

    manager = pywrapcp.RoutingIndexManager(n_nodes, n_days, start_indices, end_indices)
    routing = pywrapcp.RoutingModel(manager)

    def travel_time_callback(from_index: int, to_index: int) -> int:
        """Returns the travel time between the two nodes."""
        from_node: int = manager.IndexToNode(from_index)
        to_node: int = manager.IndexToNode(to_index)
        return time_matrix[from_node][to_node]

    transit_callback_index = routing.RegisterTransitCallback(travel_time_callback)
    routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)

    def total_time_callback(from_index: int, to_index: int) -> int:
        """Travel to a node plus the time spent once there."""
        from_node: int = manager.IndexToNode(from_index)
        to_node: int = manager.IndexToNode(to_index)
        # Depots are not stops, so no time is spent at them.
        stay = 0 if to_node in depots else visits[to_node]
        return time_matrix[from_node][to_node] + stay

    # A hard cap, unlike the balancing above: a day physically cannot hold
    # more than DAILY_TIME_BUDGET_SECONDS. Registered for every trip, not
    # just multi-day ones, since a single day overflows just as easily.
    total_callback_index = routing.RegisterTransitCallback(total_time_callback)
    routing.AddDimension(
        total_callback_index,
        0,  # no waiting between stops
        DAILY_TIME_BUDGET_SECONDS,
        True,  # every day starts its clock at zero
        "DayTotal",
    )

    if n_days > 1:
        _balance_days_across_vehicles(
            routing,
            manager,
            transit_callback_index,
            n_nodes,
            start_indices,
            end_indices,
        )

    search_parameters = pywrapcp.DefaultRoutingSearchParameters()
    search_parameters.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    )
    search_parameters.local_search_metaheuristic = (
        routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    )
    # Guided local search never proves optimality, so this limit is the
    # runtime, not a ceiling. On fixed instances up to 40 places over 4 days
    # the objective was identical at 500 ms and at 30 s, so a second is ample.
    search_parameters.time_limit.FromMilliseconds(SOLVER_TIME_LIMIT_MS)

    solution = routing.SolveWithParameters(search_parameters)

    if not solution:
        # The cap is the only hard constraint that can make a well-formed
        # request infeasible, so name it rather than blaming the solver.
        if any(visits[node] for node in range(n_nodes) if node not in depots):
            hours = DAILY_TIME_BUDGET_SECONDS // 3600
            return {
                "success": False,
                "error": (
                    f"These places do not fit in {n_days} day(s): "
                    f"travel plus time spent at each place exceeds the "
                    f"{hours} hours a day allows. Add days or shorten "
                    f"the time at some places."
                ),
                "error_code": "day_budget_exceeded",
                "error_params": {
                    "days": n_days,
                    "budget_hours": hours,
                },
            }
        return {
            "success": False,
            "error": (
                "No solution found - OR-Tools could not split these "
                "places across the requested number of days"
            ),
        }

    routes, total_distance = _extract_routes_from_solution(
        routing, manager, solution, n_days
    )
    return {"success": True, "routes": routes, "total_distance": total_distance}


def _balance_days_across_vehicles(
    routing: RoutingModel,
    manager: RoutingIndexManager,
    transit_callback_index: int,
    n_nodes: int,
    start_indices: list[int],
    end_indices: list[int],
) -> None:
    """
    Even out how much travel each day carries.

    Days are balanced on travel time rather than on how many stops they hold,
    because that is what actually makes a day tiring: three sights spread
    across a city is a harder day than six clustered in one quarter. On a test
    set of three near and three far places, balancing by count left one day
    with eight times the travel of the other; balancing by time brought them
    within 3% of each other.

    A global span cost penalises the gap between the busiest and quietest day.
    It is a cost rather than a hard cap on purpose: a hard limit turns into an
    unexplained "no solution" the moment it cannot be met.

    Parameters
    ----------
    routing : RoutingModel
        The model to add the dimensions to. Mutated in place.
    manager : RoutingIndexManager
        Translates solver indices back to place indices.
    transit_callback_index : int
        Handle for the registered travel time callback, reused as the
        transit evaluator of the 'DayTravel' dimension.
    n_nodes : int
        Number of places, used as the per-day cap on the stop counter — high
        enough never to bind.
    start_indices : list[int]
        Place index each day starts from, one entry per day.
    end_indices : list[int]
        Place index each day ends at, one entry per day. Together with
        `start_indices` these identify the depots, which are excluded from
        the stop count.
    """
    depots = set(start_indices) | set(end_indices)
    n_days = len(start_indices)

    routing.AddDimension(
        transit_callback_index,
        0,  # no waiting time between stops
        24 * 60 * 60,  # a day cannot hold more than a day of travel
        True,  # every day starts its clock at zero
        "DayTravel",
    )
    routing.GetDimensionOrDie("DayTravel").SetGlobalSpanCostCoefficient(
        DAY_BALANCE_COEFFICIENT
    )

    # Balancing alone still allows an empty day, which is never a useful
    # itinerary, so require at least one real stop per day. Depots do not count.
    def stop_counter(index: int) -> int:
        """Count a node as one stop unless it is a depot."""
        return 0 if manager.IndexToNode(index) in depots else 1

    counter_index = routing.RegisterUnaryTransitCallback(stop_counter)
    routing.AddDimensionWithVehicleCapacity(
        counter_index, 0, [n_nodes] * n_days, True, "StopCount"
    )
    stop_count = routing.GetDimensionOrDie("StopCount")
    for vehicle in range(n_days):
        stop_count.CumulVar(routing.End(vehicle)).SetMin(1)


def _check_visit_budget(
    visit_seconds: list[int], day_starts: list[int], day_ends: list[int]
) -> dict[str, Any] | None:
    """
    Refuse a trip whose time at places alone cannot fit in the days allowed.

    A necessary condition, checked before any matrix request: travel only
    adds to the total, so a plan failing this could never have succeeded. The
    solver enforces the same cap per day, but only after the network round
    trips, and its refusal cannot say how many days would have worked.

    Parameters
    ----------
    visit_seconds : list[int]
        Time spent at each place, one entry per place.
    day_starts : list[int]
        Place index each day starts from, one entry per day.
    day_ends : list[int]
        Place index each day ends at, one entry per day.

    Returns
    -------
    dict[str, Any] | None
        A failure dict with `error`, `error_code` ('day_budget_exceeded') and
        `error_params` carrying the hours needed, the hours available and the
        smallest number of days that would fit, or None when the trip fits.
    """
    depots = set(day_starts) | set(day_ends)
    needed = sum(
        seconds for node, seconds in enumerate(visit_seconds) if node not in depots
    )
    n_days = len(day_starts)
    available = n_days * DAILY_TIME_BUDGET_SECONDS
    if needed <= available:
        return None

    budget_hours = DAILY_TIME_BUDGET_SECONDS // 3600
    # Ceiling division: the last day may be part-used, but it is still a day.
    minimum_days = -(-needed // DAILY_TIME_BUDGET_SECONDS)
    return {
        "error": (
            f"Time at these places adds up to {needed / 3600:.1f} h, "
            f"which does not fit in {n_days} day(s) of {budget_hours} h "
            f"— and that is before any travel. At least {minimum_days} "
            f"day(s) would be needed."
        ),
        "error_code": "day_budget_exceeded",
        "error_params": {
            "needed_hours": round(needed / 3600, 1),
            "available_hours": available // 3600,
            "days": n_days,
            "budget_hours": budget_hours,
            "minimum_days": minimum_days,
        },
    }


def _straight_line_meters(a: Place, b: Place) -> float:
    """Measure the distance between two places as the crow flies.

    Great-circle distance, enough to judge which places are implausible.

    Parameters
    ----------
    a : Place
        One end of the pair.
    b : Place
        The other end.

    Returns
    -------
    float
        Haversine distance in meters, on a spherical earth of radius
        6371 km. Always a lower bound on the real travel distance.
    """
    lat1, lon1, lat2, lon2 = map(radians, [a.lat, a.lon, b.lat, b.lon])
    haversine = (
        sin((lat2 - lat1) / 2) ** 2
        + cos(lat1) * cos(lat2) * sin((lon2 - lon1) / 2) ** 2
    )
    return 2 * 6371000 * asin(sqrt(haversine))


def _furthest_pair(places: list[Place]) -> tuple[Place, Place, float] | None:
    """Find the two places furthest apart in a straight line.

    Parameters
    ----------
    places : list[Place]
        Places to compare, pairwise.

    Returns
    -------
    tuple[Place, Place, float] | None
        The two furthest places and their separation in meters, or None if
        fewer than two places were given and there is no pair to report.
    """
    if len(places) < 2:
        return None
    return max(
        (
            (a, b, _straight_line_meters(a, b))
            for i, a in enumerate(places)
            for b in places[i + 1 :]
        ),
        key=lambda item: item[2],
    )


def _explain_matrix_refusal(
    message: str, places: list[Place], modes: list[str]
) -> dict[str, Any]:
    """
    Turn a routing engine's complaint into something a traveller can act on.

    Valhalla says a pair exceeds its distance limit but not which pair, and its
    wording ("Path distance exceeds the max distance limit: 200000 meters") is
    engine-speak. What matters is that two specific stops are too far apart for
    the chosen mode. The structured code lets the UI say so in its own
    language; the message is the fallback for anything else.

    Parameters
    ----------
    message : str
        The engine's own complaint, as carried by MatrixProviderError. Only
        messages mentioning "distance" get the structured treatment.
    places : list[Place]
        The places the request covered, searched for the furthest pair to
        blame.
    modes : list[str]
        Modes the traveller asked for, first one wins. Note this is the
        user's own list, not the fetch list, so the vehicle fallback added
        internally never shows up in the wording.

    Returns
    -------
    dict[str, Any]
        Always an `error` key with an English message. For a distance
        refusal with at least two places, also `error_code`
        ('too_far_for_mode') and `error_params` with `first`, `second`, `km`
        (rounded) and `mode`, for a client to phrase itself. The caller
        merges this into a result dict, so no `success` key is set here.
    """
    if "distance" not in message.lower():
        return {"error": message}

    furthest = _furthest_pair(places)
    if furthest is None:
        return {"error": message}

    first, second, meters = furthest
    mode = modes[0] if modes else WALKING_MODE
    verb = {WALKING_MODE: "on foot", CYCLING_MODE: "by bike"}.get(mode, "in one trip")

    return {
        "error": (
            f"'{first.query}' and '{second.query}' are "
            f"{meters / 1000:.0f} km apart — too far to cover {verb}."
        ),
        "error_code": "too_far_for_mode",
        "error_params": {
            "first": first.query,
            "second": second.query,
            "km": round(meters / 1000),
            "mode": mode,
        },
    }


@log_time
def _get_travel_matrices(
    places: list[Place],
    modes: list[str],
    start_time: datetime,
    matrix_provider: MatrixProvider,
) -> tuple[dict[str, list[list[int]]], dict[str, list[list[int]]]]:
    """
    Get travel time and distance matrices for all transportation modes.

    Places are passed to the provider as coordinates rather than address
    strings, so nothing re-geocodes names we have already resolved.

    Blocks: one matrix request per mode, sequentially.

    Parameters
    ----------
    places : list[Place]
        Places to connect. Every matrix is indexed by position in this list.
    modes : list[str]
        Canonical modes to fetch, including the vehicle fallback the caller
        appended.
    start_time : datetime
        Departure time, honoured only by providers that model traffic or
        timetables.
    matrix_provider : MatrixProvider
        Source of the matrices.

    Returns
    -------
    tuple[dict[str, list[list[int]]], dict[str, list[list[int]]]]
        Time matrices in seconds and distance matrices in meters, both keyed
        by mode. Two empty dicts if any mode failed opaquely — the caller
        reads that as "failed to get travel data".

    Raises
    ------
    UnsupportedModeError
        If the provider cannot serve one of the modes.
    MatrixProviderError
        If the engine refused a request and explained why. Both are let
        through deliberately, because their message is worth showing.
    """
    time_matrices = {}
    distance_matrices = {}

    for mode in modes:
        print(f"Getting {mode} travel data via '{matrix_provider.name}'...")
        try:
            time_matrix, dist_matrix = matrix_provider.travel_matrix(
                places, mode, start_time
            )
        except (UnsupportedModeError, MatrixProviderError):
            # These carry a reason worth showing; only genuinely opaque
            # failures are flattened by the clause below.
            raise
        except Exception as e:  # noqa: BLE001 - opaque failures collapse to "no data"
            print(f"Error getting {mode} data: {e}")
            return {}, {}

        time_matrices[mode] = time_matrix
        distance_matrices[mode] = dist_matrix

    return time_matrices, distance_matrices


@log_time
def _create_optimal_matrices(
    time_matrices: dict[str, list[list[int]]],
    distance_matrices: dict[str, list[list[int]]],
    modes: list[str],
    walking_preference: bool,
    max_walking_distance: int,
    max_cycling_distance: int,
) -> tuple[list[list[int]], list[list[str]], list[list[bool]]]:
    """
    Create matrices with the chosen mode, its time, and whether the leg is
    beyond human-powered range, for each place pair.

    Parameters
    ----------
    time_matrices : dict[str, list[list[int]]]
        Travel times in seconds, keyed by mode. Must not be empty: its first
        value sets the number of places.
    distance_matrices : dict[str, list[list[int]]]
        Travel distances in meters, keyed by mode.
    modes : list[str]
        Modes eligible for costing a leg, including the vehicle fallback.
    walking_preference : bool
        Prefer a human-powered mode wherever one is within range, even when
        driving would be faster.
    max_walking_distance : int
        Longest leg to walk, in meters.
    max_cycling_distance : int
        Longest leg to cycle, in meters.

    Returns
    -------
    tuple[list[list[int]], list[list[str]], list[list[bool]]]
        Three square matrices: the travel time in seconds for the chosen
        mode, the name of that mode, and whether the leg is beyond both
        human-powered limits. The diagonal is 0 seconds, mode
        'same_location', and False.
    """
    n_places = len(next(iter(time_matrices.values())))
    best_time_matrix = []
    best_mode_matrix = []
    vehicle_matrix = []

    for i in range(n_places):
        time_row = []
        mode_row = []
        vehicle_row = []
        for j in range(n_places):
            if i == j:
                time_row.append(0)
                mode_row.append("same_location")
                vehicle_row.append(False)
            else:
                best_time, best_mode, needs_vehicle = _find_best_mode_for_pair(
                    i,
                    j,
                    time_matrices,
                    distance_matrices,
                    modes,
                    walking_preference,
                    max_walking_distance,
                    max_cycling_distance,
                )
                time_row.append(best_time)
                mode_row.append(best_mode)
                vehicle_row.append(needs_vehicle)

        best_time_matrix.append(time_row)
        best_mode_matrix.append(mode_row)
        vehicle_matrix.append(vehicle_row)

    return best_time_matrix, best_mode_matrix, vehicle_matrix


def _reachable_human_mode(
    from_idx: int,
    to_idx: int,
    time_matrices: dict[str, list[list[int]]],
    distance_matrices: dict[str, list[list[int]]],
    max_walking_distance: int,
    max_cycling_distance: int,
) -> str | None:
    """
    The cheapest human-powered mode that can cover this leg, or None.

    None means the traveller needs a vehicle, regardless of which mode the
    optimizer ends up costing the leg with.

    Parameters
    ----------
    from_idx : int
        Row index of the leg, a position in the resolved places list.
    to_idx : int
        Column index of the leg.
    time_matrices : dict[str, list[list[int]]]
        Travel times in seconds, keyed by mode. A mode missing from here is
        simply skipped, so a leg is judged only against the data available.
    distance_matrices : dict[str, list[list[int]]]
        Travel distances in meters, keyed by mode.
    max_walking_distance : int
        Longest leg to walk, in meters. Compared against the walking
        distance, inclusively.
    max_cycling_distance : int
        Longest leg to cycle, in meters.

    Returns
    -------
    str | None
        WALKING_MODE if the leg is within the walking limit and routable,
        else CYCLING_MODE on the same test, else None when neither applies —
        either because the leg is too long or because the engine returned
        INFINITE_VAL for it.
    """
    for mode, limit in (
        (WALKING_MODE, max_walking_distance),
        (CYCLING_MODE, max_cycling_distance),
    ):
        if mode not in time_matrices:
            continue
        if (
            distance_matrices[mode][from_idx][to_idx] <= limit
            and time_matrices[mode][from_idx][to_idx] < INFINITE_VAL
        ):
            return mode
    return None


def _find_best_mode_for_pair(
    from_idx: int,
    to_idx: int,
    time_matrices: dict[str, list[list[int]]],
    distance_matrices: dict[str, list[list[int]]],
    modes: list[str],
    walking_preference: bool,
    max_walking_distance: int,
    max_cycling_distance: int,
) -> tuple[int, str, bool]:
    """
    Pick the transport mode for one leg, preferring human-powered travel.

    Returns (seconds, mode, requires_vehicle). Walking wins when the leg is
    short enough, then cycling; anything beyond both thresholds falls back to
    whatever is fastest, normally VEHICLE_FALLBACK_MODE.

    `requires_vehicle` reflects the thresholds, not the mode finally chosen: a
    short leg costed as driving because walking_preference is off is still a
    leg you could walk, and must not be reported as needing a vehicle.

    Parameters
    ----------
    from_idx : int
        Row index of the leg, a position in the resolved places list.
    to_idx : int
        Column index of the leg.
    time_matrices : dict[str, list[list[int]]]
        Travel times in seconds, keyed by mode. Every entry of `modes` must
        be present here.
    distance_matrices : dict[str, list[list[int]]]
        Travel distances in meters, keyed by mode.
    modes : list[str]
        Modes eligible for costing this leg. The first is the fallback
        answer when every mode times out at INFINITE_VAL.
    walking_preference : bool
        Take the human-powered mode when one is within range, without
        comparing it against the motorised alternatives.
    max_walking_distance : int
        Longest leg to walk, in meters.
    max_cycling_distance : int
        Longest leg to cycle, in meters.

    Returns
    -------
    tuple[int, str, bool]
        The travel time in seconds, the mode chosen, and whether the leg
        exceeds both human-powered limits. The last is always False when the
        human-powered branch was taken, and always False when no walking or
        cycling data was available to judge against.
    """
    human_mode = _reachable_human_mode(
        from_idx,
        to_idx,
        time_matrices,
        distance_matrices,
        max_walking_distance,
        max_cycling_distance,
    )

    # With no walking or cycling data there is nothing to judge against, so
    # make no claim about whether a vehicle is needed.
    human_data_available = any(
        mode in time_matrices for mode in (WALKING_MODE, CYCLING_MODE)
    )
    requires_vehicle = human_data_available and human_mode is None

    if walking_preference and human_mode is not None:
        return int(time_matrices[human_mode][from_idx][to_idx]), human_mode, False

    best_time = INFINITE_VAL
    best_mode = modes[0]

    for mode in modes:
        current_time = time_matrices[mode][from_idx][to_idx]
        if current_time < best_time:
            best_time = current_time
            best_mode = mode

    return int(best_time), best_mode, requires_vehicle


def _extract_routes_from_solution(
    routing: RoutingModel,
    manager: RoutingIndexManager,
    solution: Assignment,
    n_days: int,
) -> tuple[list[list[int]], int]:
    """Extract one ordered list of place indices per day, plus the total cost.

    Parameters
    ----------
    routing : RoutingModel
        The solved model, queried for each vehicle's chain of nodes.
    manager : RoutingIndexManager
        Translates solver indices back to place indices.
    solution : Assignment
        The solver's answer.
    n_days : int
        Number of vehicles, one per day.

    Returns
    -------
    tuple[list[list[int]], int]
        One list of place indices per day, in visit order and including the
        day's start and end depots; and the summed arc cost. That cost is
        travel **time in seconds**, since the arc cost evaluator was
        registered from the time matrix.
    """
    routes: list[list[int]] = []
    total_distance = 0

    for vehicle in range(n_days):
        route_idxs = []
        index = routing.Start(vehicle)

        while not routing.IsEnd(index):
            route_idxs.append(manager.IndexToNode(index))
            previous_index = index
            index = solution.Value(routing.NextVar(index))
            total_distance += routing.GetArcCostForVehicle(
                previous_index, index, vehicle
            )

        route_idxs.append(manager.IndexToNode(index))
        routes.append(route_idxs)

    return routes, total_distance


def _vehicle_note(modes: list[str]) -> tuple[str, str]:
    """
    Explain a flagged leg in terms of what the traveller actually asked for:
    saying "too far to cycle" to someone planning a walk is noise.

    Parameters
    ----------
    modes : list[str]
        Modes the traveller asked for. Only WALKING_MODE and CYCLING_MODE
        contribute wording; anything else, including the vehicle fallback, is
        skipped.

    Returns
    -------
    tuple[str, str]
        An English note naming the human-powered modes that were ruled out,
        and a stable code for it. The variants are enumerable, so the code
        carries no parameters: 'too_far_to_walk', 'too_far_to_cycle',
        'too_far_to_walk_or_cycle', or 'too_far_for_selected_mode' when the
        traveller asked for neither.
    """
    verbs = {WALKING_MODE: "walk", CYCLING_MODE: "cycle"}
    attempted = [verbs[mode] for mode in modes if mode in verbs]
    if not attempted:
        return (
            "Too far for the selected mode: take public transport or a car",
            "too_far_for_selected_mode",
        )
    return (
        f"Too far to {' or '.join(attempted)}: take public transport or a car",
        f"too_far_to_{'_or_'.join(attempted)}",
    )


def _build_route_response(
    route_solution: dict[str, Any],
    places: list[Place],
    best_time_matrix: list[list[int]],
    best_mode_matrix: list[list[str]],
    vehicle_matrix: list[list[bool]],
    distance_matrices: dict[str, list[list[int]]],
    start_time: datetime,
    modes: list[str],
    visit_seconds: list[int] | None = None,
) -> dict[str, Any]:
    """Build the final detailed response, one entry per day.

    Parameters
    ----------
    route_solution : dict[str, Any]
        The solver's result. Only its `routes` key is read.
    places : list[Place]
        Resolved places, indexed by the values in `routes`. Their
        `display_name` is what reaches the client, not the original query.
    best_time_matrix : list[list[int]]
        Travel time in seconds for the chosen mode of each pair.
    best_mode_matrix : list[list[str]]
        Mode chosen for each pair.
    vehicle_matrix : list[list[bool]]
        Whether each pair is beyond human-powered range.
    distance_matrices : dict[str, list[list[int]]]
        Travel distances in meters, keyed by mode. A leg whose chosen mode
        is missing here — 'same_location', for one — contributes 0 meters.
    start_time : datetime
        When day one begins. Each later day resumes at the same wall-clock
        time on the following date.
    modes : list[str]
        Modes the traveller asked for, used only to word the note on legs
        that need a vehicle.

    Returns
    -------
    dict[str, Any]
        `success` True, `days` (one dict per day with `day`,
        `ordered_places`, `waypoints`, `route_details`,
        `total_travel_time_seconds`, `total_distance_meters`, `start_time`
        and `estimated_end_time`), and the trip-wide
        `total_travel_time_seconds`, `total_visit_time_seconds`,
        `total_distance_meters`, `start_time` and `estimated_end_time`. End
        times are start plus travel plus time spent at each place, so they
        track the clock rather than just the walking.
    """
    routes = route_solution["routes"]
    # Reconstructed rather than passed in, but identical to the set the solver
    # used: a depot node is reserved by its vehicle and never appears mid-route.
    depots = {r[0] for r in routes} | {r[-1] for r in routes}

    def stay_at(node: int) -> int:
        """Time spent at a place, or zero for a depot, which is not a stop."""
        if visit_seconds is None or node in depots:
            return 0
        return visit_seconds[node]

    day_plans = []
    total_travel_time = 0
    total_visit_time = 0
    total_actual_distance = 0

    for day_number, route_idxs in enumerate(routes, start=1):
        day_start = start_time + timedelta(days=day_number - 1)
        route_details = []
        day_travel_time = 0
        day_visit_time = 0
        day_distance = 0
        # Wall-clock offset into the day: travel so far plus every visit
        # already finished. Arrivals are read off this, not off travel alone.
        elapsed = 0

        for i in range(len(route_idxs) - 1):
            from_idx = route_idxs[i]
            to_idx = route_idxs[i + 1]
            mode_used = best_mode_matrix[from_idx][to_idx]
            travel_time = best_time_matrix[from_idx][to_idx]
            day_travel_time += travel_time

            # You leave a place only once you are done with it.
            stay = stay_at(from_idx)
            day_visit_time += stay
            elapsed += stay + travel_time

            actual_distance = 0
            if mode_used in distance_matrices:
                actual_distance = distance_matrices[mode_used][from_idx][to_idx]
                day_distance += actual_distance

            requires_vehicle = vehicle_matrix[from_idx][to_idx]
            vehicle_note, vehicle_note_code = (
                _vehicle_note(modes) if requires_vehicle else (None, None)
            )

            route_details.append(
                {
                    "from_place": places[from_idx].display_name,
                    "to_place": places[to_idx].display_name,
                    "mode": mode_used,
                    "requires_vehicle": requires_vehicle,
                    "note": vehicle_note,
                    "note_code": vehicle_note_code,
                    "travel_time_seconds": travel_time,
                    "visit_time_seconds": stay,
                    "distance_meters": actual_distance,
                    "estimated_arrival": day_start + timedelta(seconds=elapsed),
                }
            )

        total_travel_time += day_travel_time
        total_visit_time += day_visit_time
        total_actual_distance += day_distance

        day_plans.append(
            {
                "day": day_number,
                "ordered_places": [places[i].display_name for i in route_idxs],
                "waypoints": [
                    {
                        "name": places[i].display_name,
                        "lat": places[i].lat,
                        "lon": places[i].lon,
                        "visit_seconds": stay_at(i),
                    }
                    for i in route_idxs
                ],
                "route_details": route_details,
                "total_travel_time_seconds": day_travel_time,
                "total_visit_time_seconds": day_visit_time,
                "total_distance_meters": day_distance,
                "start_time": day_start,
                "estimated_end_time": day_start + timedelta(seconds=elapsed),
            }
        )

    return {
        "success": True,
        "days": day_plans,
        "total_travel_time_seconds": total_travel_time,
        "total_visit_time_seconds": total_visit_time,
        "total_distance_meters": total_actual_distance,
        "start_time": start_time,
        "estimated_end_time": (
            day_plans[-1]["estimated_end_time"] if day_plans else start_time
        ),
    }


def print_result(result: dict[str, Any]) -> None:
    """Print a plan to stdout, for use from a script or a notebook.

    Nothing in the HTTP path calls this; the API serialises the same dict
    instead.

    Parameters
    ----------
    result : dict[str, Any]
        A result from `optimize_route`. A successful one is printed day by
        day with per-leg times and distances converted to minutes and
        kilometers; a failed one prints its `error`, plus the unresolved
        names from `validation_result` where that key is present.
    """
    if result["success"]:
        total_seconds = result["total_travel_time_seconds"]
        print("\n" + "=" * 60)
        print("ROUTE RESULTS")
        print("=" * 60)
        print(
            f"Total travel time: {total_seconds} seconds "
            f"({total_seconds / 60:.1f} minutes)"
        )
        print(f"Total distance: {result['total_distance_meters'] / 1000:.2f} km")

        for day in result["days"]:
            print(
                f"\nDAY {day['day']} — "
                f"{day['start_time'].strftime('%Y-%m-%d %H:%M')} to "
                f"{day['estimated_end_time'].strftime('%H:%M')} "
                f"({day['total_distance_meters'] / 1000:.2f} km)"
            )
            print("-" * 60)
            for i, detail in enumerate(day["route_details"], 1):
                leg_seconds = detail["travel_time_seconds"]
                arrival = detail["estimated_arrival"]
                print(f"Step {i}: {detail['from_place']} → {detail['to_place']}")
                print(f"  Mode: {detail['mode']}")
                print(f"  Time: {leg_seconds} seconds " f"({leg_seconds / 60:.1f} min)")
                print(f"  Distance: {detail['distance_meters'] / 1000:.2f} km")
                print(f"  Arrival: {arrival.strftime('%H:%M:%S')}")
                print()
    else:
        print(f"\nOptimization failed: {result['error']}")
        if "validation_result" in result:
            print("Please fix the following places and try again:")
            for invalid in result["validation_result"]["invalid_places"]:
                print(f"  - {invalid['place']}: {invalid['error']}")
