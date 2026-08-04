"""
The planning facade tying the service layer together.

`TravelPlanner` validates the day plan, resolves place names to coordinates,
and hands the result to the optimizer. It reports problems as a dict with a
`success` key rather than raising, so the HTTP layer never has to catch.
"""

from datetime import datetime
from typing import Any

from app.services.geocoding import GeocodingProvider, Place, get_geocoder
from app.services.matrices import MatrixProvider, get_matrix_provider
from app.services.utils import DEFAULT_MODES, optimize_route, validate_places
from dotenv import load_dotenv


class TravelPlanner:
    """Facade over geocoding, travel matrices and the route optimizer.

    Holds the two providers for the lifetime of the process so that
    configuration is read once. Every method blocks — geocoding, HTTP to the
    routing engine and the solver all run synchronously — so callers on the
    event loop must go through `asyncio.to_thread`.
    """

    def __init__(self,
                 geocoder: GeocodingProvider | None = None,
                 matrix_provider: MatrixProvider | None = None,
                 ) -> None:
        """Build a planner, loading `.env` before consulting the factories.

        Parameters
        ----------
        geocoder : GeocodingProvider | None, optional
            Resolves place names to coordinates, by default None, which uses
            the provider configured via GEOCODER (Photon).
        matrix_provider : MatrixProvider | None, optional
            Computes travel times and distances, by default None, which uses
            the provider configured via MATRIX_PROVIDER (Valhalla).
        """
        load_dotenv()
        self.geocoder = geocoder if geocoder is not None else get_geocoder()
        self.matrix_provider = (matrix_provider if matrix_provider is not None
                                else get_matrix_provider())

    def plan_route(
        self,
        places: list[str],
        start_idx: int = 0,
        end_idx: int = -1,
        start_time: datetime | None = None,
        modes: list[str] = DEFAULT_MODES,
        walking_preference: bool = True,
        max_walking_distance: int = 1000,
        max_cycling_distance: int = 5000,
        area: str | None = None,
        days: int = 1,
        day_starts: list[int] | None = None,
        day_ends: list[int] | None = None,
        resolved_places: list[Place] | None = None,
        visit_seconds: list[int] | None = None
    ) -> dict[str, Any]:
        """
        Plan route: validate places first, then optimize route.

        With `days` greater than one the places are split across that many
        days. Each day has its own start and end place; when `day_starts` or
        `day_ends` are omitted, every day reuses `start_idx` and `end_idx`,
        which is how "leave from and return to the hotel daily" is expressed.

        Blocks: geocodes every place unless `resolved_places` is supplied,
        then fetches one matrix per mode and runs the solver.

        Parameters
        ----------
        places : list[str]
            Place names to visit, in no particular order. Every index below
            refers to a position in this list.
        start_idx : int, optional
            Index of the place every day starts from, by default 0. Negative
            values count from the end.
        end_idx : int, optional
            Index of the place every day ends at, by default -1, i.e. the
            last place. Negative values count from the end.
        start_time : datetime | None, optional
            When day one begins; later days resume at the same wall-clock
            time. By default None, meaning now.
        modes : list[str], optional
            Canonical modes the traveller is willing to use, by default
            DEFAULT_MODES (walking, bicycle, driving).
        walking_preference : bool, optional
            Prefer a human-powered mode wherever one is within range, even
            when driving would be faster, by default True.
        max_walking_distance : int, optional
            Longest leg to walk, in meters, by default 1000.
        max_cycling_distance : int, optional
            Longest leg to cycle, in meters, by default 5000. Legs beyond
            both limits are reported as requiring a vehicle.
        area : str | None, optional
            City or region appended to each place name when geocoding, by
            default None. Ignored when `resolved_places` is given.
        days : int, optional
            Number of days to split the places across, by default 1.
        day_starts : list[int] | None, optional
            Place index each day starts from, one entry per day, by default
            None, which reuses `start_idx` for every day. Negative values
            count from the end.
        day_ends : list[int] | None, optional
            Place index each day ends at, one entry per day, by default
            None, which reuses `end_idx` for every day. A day whose start and
            end coincide is a round trip.
        resolved_places : list[Place] | None, optional
            Places already geocoded by the caller, in the same order as
            `places` and of the same length, by default None. When given,
            geocoding is skipped entirely.
        visit_seconds : list[int] | None, optional
            Time spent at each place, one entry per place and of the same
            length, by default None, meaning a travel-only plan. Travel plus
            visits is capped at DAILY_TIME_BUDGET_SECONDS per day.

        Returns
        -------
        dict[str, Any]
            On success, the itinerary from `optimize_route`: `success` True
            plus `days`, `total_travel_time_seconds`,
            `total_visit_time_seconds`, `total_distance_meters`, `start_time`
            and `estimated_end_time`. On failure, `success` False plus
            `error`, and depending on the cause `error_code`/`error_params` (a
            user-actionable failure such as 'too_far_for_mode' or
            'day_budget_exceeded') or `validation_result` (the dict from
            `validate_places`, when a place name could not be resolved).
        """
        n_places = len(places)

        starts = list(day_starts) if day_starts else [start_idx] * days
        ends = list(day_ends) if day_ends else [end_idx] * days
        starts = [i if i >= 0 else n_places + i for i in starts]
        ends = [i if i >= 0 else n_places + i for i in ends]

        error = self._validate_day_plan(n_places, days, starts, ends)
        if error:
            return {'success': False, 'error': error}

        if visit_seconds is not None and len(visit_seconds) != n_places:
            return {
                'success': False,
                'error': (f"visit_seconds must match places: got "
                          f"{len(visit_seconds)} for {n_places} places")
            }

        print("=" * 60)
        print("ROUTE OPTIMIZATION WITH VALIDATION")
        print("=" * 60)

        if resolved_places is not None:
            if len(resolved_places) != n_places:
                return {
                    'success': False,
                    'error': (f"resolved_places must match places: got "
                              f"{len(resolved_places)} for {n_places} places")
                }
            print(f"Using {n_places} pre-resolved places, skipping geocoding")
            valid_places = resolved_places
        else:
            validation_result = validate_places(places, self.geocoder, area)

            if not validation_result['is_valid']:
                return {
                    'success': False,
                    'error': 'Place validation failed',
                    'validation_result': validation_result
                }
            valid_places = validation_result['valid_places']

        result = optimize_route(
            valid_places,
            starts,
            ends,
            self.matrix_provider,
            start_time if start_time else datetime.now(),
            modes,
            walking_preference,
            max_walking_distance,
            max_cycling_distance,
            visit_seconds
        )

        return result

    def resolve_place(self, place: str, area: str | None = None
                      ) -> Place | None:
        """
        Resolve a single place name, for validating input as it is entered.

        Returns None when nothing matches, so the caller can flag that one
        place instead of failing a whole itinerary.

        Blocks: one geocoder lookup, behind its rate limiter.

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
        return self.geocoder.geocode(place, area)

    @staticmethod
    def _validate_day_plan(n_places: int,
                           days: int,
                           starts: list[int],
                           ends: list[int]) -> str | None:
        """Return a readable reason the trip cannot be planned, or None.

        Parameters
        ----------
        n_places : int
            How many places the trip has to work with.
        days : int
            Number of days the places are split across.
        starts : list[int]
            Place index each day starts from, one entry per day, already
            normalised so that no value is negative.
        ends : list[int]
            Place index each day ends at, one entry per day, already
            normalised so that no value is negative.

        Returns
        -------
        str | None
            An English explanation of the first problem found, or None if the
            plan is fine.
        """
        if n_places < 2:
            return "Need at least 2 places to plan a route"
        if days < 1:
            return f"days must be at least 1, got {days}"
        if len(starts) != days or len(ends) != days:
            return (f"Expected {days} start and end places, got "
                    f"{len(starts)} and {len(ends)}")

        for label, indices in (('start', starts), ('end', ends)):
            for day, index in enumerate(indices, start=1):
                if index < 0 or index >= n_places:
                    return (f"Day {day} {label} place is out of range: "
                            f"expected 0..{n_places - 1}, got {index}")

        # Depots are not stops: a day ending elsewhere is already a journey,
        # but a day looping back shows nothing without a place of its own.
        loop_days = sum(1 for s, e in zip(starts, ends) if s == e)
        free_places = n_places - len(set(starts) | set(ends))
        if free_places < loop_days:
            return (f"Not enough places: {loop_days} day(s) return to their "
                    f"starting point and need a place to visit in between, but "
                    f"only {free_places} remain once every daily start and end "
                    f"point is set. Add more places or reduce the number of days")

        return None
