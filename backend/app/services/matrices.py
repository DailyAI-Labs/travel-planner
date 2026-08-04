"""
Travel time and distance matrix providers.

The optimizer needs, for every pair of places and every transport mode, how
long the trip takes and how far it is. This module abstracts where those
numbers come from, so the routing engine is a configuration choice.

Valhalla is the default: it is MIT licensed, self-hostable, and serves every
costing model from a single set of tiles, so one container covers driving,
walking and cycling.
"""

import os
from datetime import datetime
from typing import Any, Protocol

import requests
from app.services.geocoding import Place

# Cost used for pairs the engine cannot connect. Large enough that the solver
# avoids such an arc, small enough to stay well inside OR-Tools' int64 range.
INFINITE_VAL: int = 999999

DEFAULT_PROVIDER: str = "valhalla"
DEFAULT_VALHALLA_URL: str = "http://localhost:8002"
DEFAULT_TIMEOUT_SECONDS: int = 120

# Canonical mode names used across the app, mapped to each engine's own name.
VALHALLA_COSTING: dict[str, str] = {
    "driving": "auto",
    "walking": "pedestrian",
    "bicycle": "bicycle",
}

GOOGLE_MODES: dict[str, str] = {
    "driving": "driving",
    "walking": "walking",
    "bicycle": "bicycling",
    "transit": "transit",
}

SUPPORTED_MODES: tuple[str, ...] = tuple(VALHALLA_COSTING)

WALKING_MODE: str = "walking"
CYCLING_MODE: str = "bicycle"

# Legs too long to walk or cycle are costed with this mode and reported as
# requiring a vehicle — the same Valhalla instance serves it, at no extra cost.
VEHICLE_FALLBACK_MODE: str = "driving"

_METERS_PER_UNIT: dict[str, float] = {
    "kilometers": 1000.0,
    "km": 1000.0,
    "miles": 1609.344,
    "mi": 1609.344,
}


class UnsupportedModeError(ValueError):
    """Raised when a transport mode the provider cannot serve is requested."""


class MatrixProviderError(RuntimeError):
    """
    The routing engine refused the request and said why.

    Kept distinct from transient failures so the reason reaches the user
    instead of being flattened into "failed to get travel data".
    """


class MatrixProvider(Protocol):
    """Computes travel time and distance between every pair of places."""

    name: str

    def travel_matrix(
        self,
        places: list[Place],
        mode: str,
        start_time: datetime,
    ) -> tuple[list[list[int]], list[list[int]]]:
        """
        Return (time_matrix in seconds, distance_matrix in meters).

        Unreachable pairs are filled with INFINITE_VAL.

        Implementations call out to a routing engine over HTTP, so callers on
        the event loop must go through `asyncio.to_thread`.

        Parameters
        ----------
        places : list[Place]
            Places to connect, used as both sources and targets. Both
            matrices are indexed by position in this list.
        mode : str
            Canonical transport mode: 'walking', 'bicycle' or 'driving'.
            Each provider maps it onto its own engine's vocabulary.
        start_time : datetime
            Departure time, for engines that model traffic or timetables.

        Returns
        -------
        tuple[list[list[int]], list[list[int]]]
            Square time and distance matrices, in seconds and whole meters,
            with INFINITE_VAL (999999) wherever the engine could not connect
            a pair.

        Raises
        ------
        UnsupportedModeError
            If the provider cannot serve `mode`.
        MatrixProviderError
            If the engine refused the request and explained why.
        """
        ...


class ValhallaMatrixProvider:
    """
    Valhalla's `sources_to_targets` endpoint.

    One request yields the full matrix. Valhalla has no live traffic model, so
    `start_time` is accepted for interface compatibility but not used: the
    numbers are free-flow estimates.
    """

    name = "valhalla"

    def __init__(
        self,
        base_url: str = DEFAULT_VALHALLA_URL,
        timeout: int = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        """Point the provider at a Valhalla instance.

        Parameters
        ----------
        base_url : str, optional
            Base URL of the Valhalla HTTP service, by default
            'http://localhost:8002'. A trailing slash is stripped.
        timeout : int, optional
            Seconds to wait for one matrix request, by default 120. A large
            matrix on a cold instance genuinely takes that long.
        """
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def travel_matrix(
        self,
        places: list[Place],
        mode: str,
        start_time: datetime,
    ) -> tuple[list[list[int]], list[list[int]]]:
        """Fetch the full matrix in one `sources_to_targets` call.

        Blocks on an HTTP request for up to `self.timeout` seconds.

        Parameters
        ----------
        places : list[Place]
            Places to connect, used as both sources and targets. Both
            matrices are indexed by position in this list.
        mode : str
            Canonical mode, mapped through VALHALLA_COSTING: 'walking' to
            'pedestrian', 'bicycle' to 'bicycle', 'driving' to 'auto'.
        start_time : datetime
            Accepted for interface compatibility and ignored: Valhalla has no
            traffic model, so the numbers are free-flow estimates whatever is
            passed here.

        Returns
        -------
        tuple[list[list[int]], list[list[int]]]
            Time in seconds and distance in whole meters, with INFINITE_VAL
            (999999) for pairs Valhalla could not connect.

        Raises
        ------
        UnsupportedModeError
            If `mode` is not one of VALHALLA_COSTING's keys.
        MatrixProviderError
            If Valhalla answered with a non-OK status; the message carries
            its own explanation where it gave one.
        """
        costing = VALHALLA_COSTING.get(mode)
        if costing is None:
            raise UnsupportedModeError(_unsupported_mode_message(mode))

        locations = [{"lat": place.lat, "lon": place.lon} for place in places]
        response = requests.post(
            f"{self.base_url}/sources_to_targets",
            json={
                "sources": locations,
                "targets": locations,
                "costing": costing,
                "units": "kilometers",
            },
            timeout=self.timeout,
        )
        if not response.ok:
            raise MatrixProviderError(_describe_valhalla_error(response))
        payload = response.json()

        return _parse_valhalla_response(payload, len(places))

    def health(self) -> bool:
        """Probe the Valhalla instance.

        True if it answers. Useful for start-up checks.

        Blocks on an HTTP request for up to 5 seconds.

        Returns
        -------
        bool
            True if /status returned an OK status, False if it did not or the
            request failed outright.
        """
        try:
            response = requests.get(f"{self.base_url}/status", timeout=5)
            return response.ok
        except requests.RequestException:
            return False


class GoogleMatrixProvider:
    """
    Google Distance Matrix API.

    Kept as an opt-in alternative: it is the only provider here that offers
    live traffic and public transport, and the only one that is billed.
    """

    name = "google"

    def __init__(self, api_key: str | None = None, batch_size: int = 10) -> None:
        """Configure access to the Distance Matrix API.

        Parameters
        ----------
        api_key : str | None, optional
            Billable Google API key, by default None, in which case the
            GCP_API_KEY environment variable is used.
        batch_size : int, optional
            Origins and destinations per request, by default 10, so the
            matrix is walked in blocks small enough for the API's cap on
            elements per request.

        Raises
        ------
        ValueError
            If no key is given and GCP_API_KEY is unset or empty.
        """
        self.api_key = api_key or os.getenv("GCP_API_KEY")
        if not self.api_key:
            raise ValueError("Google matrices require an API key (set GCP_API_KEY)")
        self.batch_size = batch_size

    def travel_matrix(
        self,
        places: list[Place],
        mode: str,
        start_time: datetime,
    ) -> tuple[list[list[int]], list[list[int]]]:
        """Assemble the matrix from batched Distance Matrix requests.

        Blocks on one HTTP request per block of `batch_size` origins by
        `batch_size` destinations, and each one is billed.

        Parameters
        ----------
        places : list[Place]
            Places to connect, used as both origins and destinations. Both
            matrices are indexed by position in this list.
        mode : str
            Canonical mode, mapped through GOOGLE_MODES. 'transit' is
            accepted here as well as the three canonical modes, since Google
            is the only provider that serves it.
        start_time : datetime
            Departure time. Used for 'driving' (with traffic model
            'best_guess') and 'transit'; ignored for walking and cycling.

        Returns
        -------
        tuple[list[list[int]], list[list[int]]]
            Time in seconds and distance in whole meters, with INFINITE_VAL
            (999999) for any element Google did not return as OK.

        Raises
        ------
        UnsupportedModeError
            If `mode` is not one of GOOGLE_MODES' keys.
        """
        google_mode = GOOGLE_MODES.get(mode)
        if google_mode is None:
            raise UnsupportedModeError(_unsupported_mode_message(mode))

        # googlemaps ships no type information; imported lazily because only
        # this provider needs it.
        import googlemaps  # type: ignore[import-untyped]

        gmaps = googlemaps.Client(key=self.api_key)
        n_places = len(places)
        time_matrix = [[0] * n_places for _ in range(n_places)]
        dist_matrix = [[0] * n_places for _ in range(n_places)]

        # The API caps elements per request, so walk the matrix in blocks.
        for origin_start in range(0, n_places, self.batch_size):
            for dest_start in range(0, n_places, self.batch_size):
                origin_end = min(origin_start + self.batch_size, n_places)
                dest_end = min(dest_start + self.batch_size, n_places)

                print(
                    f"Processing batch: origins {origin_start}-{origin_end-1}, "
                    f"destinations {dest_start}-{dest_end-1}"
                )

                result = gmaps.distance_matrix(
                    **_google_params(
                        places[origin_start:origin_end],
                        places[dest_start:dest_end],
                        google_mode,
                        start_time,
                    )
                )
                batch_time, batch_dist = _parse_google_response(result)

                # The batch is indexed from zero; the matrices are not.
                for batch_row, origin in enumerate(range(origin_start, origin_end)):
                    for batch_col, dest in enumerate(range(dest_start, dest_end)):
                        time_matrix[origin][dest] = batch_time[batch_row][batch_col]
                        dist_matrix[origin][dest] = batch_dist[batch_row][batch_col]

        return time_matrix, dist_matrix


def _describe_valhalla_error(response: requests.Response) -> str:
    """
    Turn a Valhalla rejection into something worth showing a user.

    Valhalla explains itself in the response body — "Path distance exceeds the
    max distance limit: 200000 meters" when two places are too far apart for
    the chosen profile, "Exceeded max locations" for an oversized matrix — and
    that explanation is the only thing that makes the failure actionable.

    Parameters
    ----------
    response : requests.Response
        The non-OK response, whose JSON body is searched for an 'error' or
        'message' key.

    Returns
    -------
    str
        Valhalla's own wording wrapped in a sentence, or a bare mention of
        the HTTP status when the body carried no explanation.
    """
    try:
        body = response.json()
        message = body.get("error") or body.get("message")
    except ValueError:
        message = None

    if message:
        return f"The routing engine rejected the request: {message}"
    return (
        f"The routing engine returned HTTP {response.status_code} "
        f"with no explanation"
    )


def _unsupported_mode_message(mode: str) -> str:
    """Explain why a mode cannot be served, and what to do about it.

    Parameters
    ----------
    mode : str
        The mode that was asked for and rejected.

    Returns
    -------
    str
        A message naming the supported modes. 'transit' gets its own
        wording, because the answer is not "no such mode" but "not without
        per-city GTFS tiles, or a billed Google key".
    """
    if mode == "transit":
        return (
            "Public transport is not available with the open source routing "
            "engine: it needs GTFS transit tiles built per city. Supported "
            f"modes are {', '.join(SUPPORTED_MODES)}. Set "
            "MATRIX_PROVIDER=google (billed) if you need transit."
        )
    return (
        f"Unsupported transport mode '{mode}'. "
        f"Expected one of: {', '.join(SUPPORTED_MODES)}."
    )


def _parse_valhalla_response(
    payload: dict[str, Any],
    n_places: int,
) -> tuple[list[list[int]], list[list[int]]]:
    """
    Turn Valhalla's sources_to_targets payload into dense matrices.

    Valhalla reports `time` in seconds and `distance` in the requested units,
    and uses null for pairs it could not connect.

    Parameters
    ----------
    payload : dict[str, Any]
        Decoded response body. Its 'units' key decides the distance scale;
        anything unrecognised is treated as kilometers.
    n_places : int
        Side length of the matrices to build, so unconnected pairs keep
        their INFINITE_VAL fill.

    Returns
    -------
    tuple[list[list[int]], list[list[int]]]
        Time in seconds and distance in whole meters, with INFINITE_VAL
        (999999) left in place wherever Valhalla reported a null.

    Raises
    ------
    ValueError
        If the payload has no 'sources_to_targets' key.
    """
    rows = payload.get("sources_to_targets")
    if rows is None:
        raise ValueError(f"Unexpected Valhalla response: {payload}")

    to_meters = _METERS_PER_UNIT.get(payload.get("units", "kilometers"), 1000.0)

    time_matrix = [[INFINITE_VAL] * n_places for _ in range(n_places)]
    dist_matrix = [[INFINITE_VAL] * n_places for _ in range(n_places)]

    for row_idx, row in enumerate(rows):
        for col_idx, entry in enumerate(row):
            # Valhalla echoes the indices back; trust them over position.
            i = entry.get("from_index", row_idx)
            j = entry.get("to_index", col_idx)
            travel_time = entry.get("time")
            distance = entry.get("distance")
            if travel_time is None or distance is None:
                continue
            time_matrix[i][j] = round(travel_time)
            dist_matrix[i][j] = round(distance * to_meters)

    return time_matrix, dist_matrix


def _google_params(
    origins: list[Place], destinations: list[Place], mode: str, start_time: datetime
) -> dict[str, Any]:
    """Build Distance Matrix parameters for a transport mode.

    Parameters
    ----------
    origins : list[Place]
        Places forming the rows of this batch.
    destinations : list[Place]
        Places forming the columns of this batch.
    mode : str
        Google's own mode name, as produced by GOOGLE_MODES — not the
        canonical one.
    start_time : datetime
        Departure time. Only reaches the request for 'driving' and
        'transit'; the other modes have no time dependence to model.

    Returns
    -------
    dict[str, Any]
        Keyword arguments for `googlemaps.Client.distance_matrix`, with
        coordinates rather than address strings so nothing is re-geocoded.
    """
    params: dict[str, Any] = {
        "origins": [place.coords for place in origins],
        "destinations": [place.coords for place in destinations],
        "mode": mode,
    }

    if mode in ("driving", "transit"):
        params["departure_time"] = start_time

    if mode == "driving":
        params["traffic_model"] = "best_guess"
    elif mode == "transit":
        params["transit_mode"] = ["bus", "subway", "train", "tram", "rail"]
        params["transit_routing_preference"] = "less_walking"

    return params


def _parse_google_response(
    result: dict[str, Any],
) -> tuple[list[list[int]], list[list[int]]]:
    """Parse a Distance Matrix response into time and distance matrices.

    Parameters
    ----------
    result : dict[str, Any]
        One decoded Distance Matrix response, covering a single batch.

    Returns
    -------
    tuple[list[list[int]], list[list[int]]]
        Time in seconds and distance in meters for the batch, indexed
        relative to the batch rather than to the full matrix. Elements whose
        status is not 'OK' become INFINITE_VAL (999999).
    """
    time_matrix = []
    dist_matrix = []

    for row in result["rows"]:
        time_row = []
        dist_row = []
        for element in row["elements"]:
            if element["status"] == "OK":
                time_row.append(element["duration"]["value"])
                dist_row.append(element["distance"]["value"])
            else:
                time_row.append(INFINITE_VAL)
                dist_row.append(INFINITE_VAL)
        time_matrix.append(time_row)
        dist_matrix.append(dist_row)

    return time_matrix, dist_matrix


def get_matrix_provider(provider: str | None = None) -> MatrixProvider:
    """
    Build a matrix provider from configuration.

    Environment:
        MATRIX_PROVIDER  valhalla | google, default 'valhalla'
        VALHALLA_URL     base URL of the Valhalla instance,
                         default 'http://localhost:8002'

    Parameters
    ----------
    provider : str | None, optional
        Provider name overriding the MATRIX_PROVIDER environment variable,
        by default None.

    Returns
    -------
    MatrixProvider
        A ValhallaMatrixProvider or a GoogleMatrixProvider.

    Raises
    ------
    ValueError
        If the name is neither 'valhalla' nor 'google', or — for 'google' —
        if no API key is configured.
    """
    provider = (provider or os.getenv("MATRIX_PROVIDER") or DEFAULT_PROVIDER).lower()

    if provider == "valhalla":
        return ValhallaMatrixProvider(
            base_url=os.getenv("VALHALLA_URL", DEFAULT_VALHALLA_URL)
        )
    if provider == "google":
        return GoogleMatrixProvider()

    raise ValueError(
        f"Unknown matrix provider '{provider}'. Expected: valhalla, google."
    )
