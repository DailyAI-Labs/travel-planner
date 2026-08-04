"""
Pydantic request and response models for the travel planning API.

These are the wire format: FastAPI validates incoming payloads against them
and publishes their `Field(description=...)` text in the OpenAPI schema, so
field semantics live there rather than in the class docstrings.
"""

from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class ComputationStatus(str, Enum):
    """Lifecycle of a background itinerary computation."""

    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class ResolvedPlace(BaseModel):
    """A place already resolved by the geocode endpoint."""

    query: str
    name: str
    lat: float
    lon: float


class TravelPlanRequest(BaseModel):
    """Everything needed to compute one itinerary, as posted to the API.

    Every index field (`start_idx`, `end_idx`, `day_starts`, `day_ends`) is a
    position in `places`; negative values count from the end. Distances are in
    meters.
    """

    places: list[str]
    resolved_places: list[ResolvedPlace] | None = Field(
        default=None,
        description=(
            "Places already resolved via /geocode, in the same order as "
            "`places`. When given, the planner skips geocoding entirely."
        ),
    )
    start_idx: int
    end_idx: int
    days: int = Field(
        default=1,
        ge=1,
        description="Number of days to split the places across.",
    )
    day_starts: list[int] | None = Field(
        default=None,
        description=(
            "Place index each day starts from, one per day. Omit to reuse "
            "start_idx every day."
        ),
    )
    day_ends: list[int] | None = Field(
        default=None,
        description=(
            "Place index each day ends at, one per day. Omit to reuse "
            "end_idx every day. A day whose start and end match is a round trip."
        ),
    )
    visit_seconds: list[int] | None = Field(
        default=None,
        description=(
            "Time spent at each place, one entry per entry in `places` and in "
            "the same order. Omit for a travel-only plan. A place serving as a "
            "daily start or end contributes nothing, since depots are not "
            "stops. Travel plus visits is capped at 16 hours per day."
        ),
    )
    start_time: datetime
    modes: list[str]
    walking_preference: bool
    max_walking_distance: int
    max_cycling_distance: int = Field(
        default=5000,
        description=(
            "Legs longer than this, and longer than max_walking_distance, are "
            "reported as requiring public transport or a car."
        ),
    )
    area: str | None = Field(
        default=None,
        description=(
            "City or region the places belong to, e.g. 'London'. Strongly "
            "recommended: a bare landmark name is often ambiguous worldwide, "
            "and this is what disambiguates it."
        ),
    )


class TravelPlanStatus(BaseModel):
    """Acknowledgement of a submitted request, carrying its tracking code."""

    code: str
    status: str
    message: str


class RouteDetail(BaseModel):
    """One leg of a day, from one stop to the next.

    `requires_vehicle` marks a leg beyond both the walking and the cycling
    threshold, with `note` explaining it in English; the leg is still costed
    and timed, using whichever available mode is fastest.
    """

    from_place: str
    to_place: str
    mode: str
    requires_vehicle: bool = False
    note: str | None = None
    note_code: str | None = Field(
        default=None,
        description=(
            "Stable identifier for `note`, e.g. 'too_far_to_walk', so a client "
            "can phrase it itself. `note` is the English fallback."
        ),
    )
    travel_time_seconds: int
    visit_time_seconds: int = Field(
        default=0,
        description=(
            "Time spent at `from_place` before this leg departs. Zero for a "
            "daily start or end point."
        ),
    )
    distance_meters: int
    estimated_arrival: datetime


class Waypoint(BaseModel):
    """A stop in visit order, with the coordinates needed to plot it."""

    name: str
    lat: float
    lon: float
    visit_seconds: int = 0


class GeocodeRequest(BaseModel):
    """A single place name to resolve, with optional area context."""

    place: str
    area: str | None = Field(
        default=None,
        description="City or region to disambiguate the place name.",
    )


class GeocodeResponse(BaseModel):
    """Result of resolving a single place name, for validation as you type."""

    found: bool
    query: str
    place: Waypoint | None = None
    error: str | None = None


class DayPlan(BaseModel):
    """One day of the trip, in visit order."""

    day: int
    ordered_places: list[str]
    waypoints: list[Waypoint] = []
    route_details: list[RouteDetail]
    total_travel_time_seconds: int
    total_visit_time_seconds: int = 0
    total_distance_meters: int
    start_time: datetime
    estimated_end_time: datetime


class Itinerary(BaseModel):
    """A completed plan: every day in order, plus trip-wide totals.

    The totals sum the per-day figures, in seconds and meters respectively.
    End times account for time spent at places as well as travel.
    """

    success: bool
    days: list[DayPlan]
    total_travel_time_seconds: int
    total_visit_time_seconds: int = 0
    total_distance_meters: int
    start_time: datetime
    estimated_end_time: datetime


class TravelPlanResponse(BaseModel):
    """A tracked computation: its status and, once finished, its outcome.

    `itinerary` is populated only for COMPLETED, the `error*` fields only for
    FAILED. `created_at`/`updated_at` are UTC instants stamped per instance,
    unlike the itinerary's own times, which are local wall-clock.
    """

    status: ComputationStatus = ComputationStatus.PENDING
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    itinerary: Itinerary | None = None
    error: str | None = None
    error_code: str | None = Field(
        default=None,
        description=(
            "Stable identifier for failures a client can phrase itself, e.g. "
            "'too_far_for_mode'. `error` is the ready-made English fallback."
        ),
    )
    error_params: dict[str, Any] | None = None
