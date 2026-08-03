"""
Pydantic models describing the API's request and response payloads.

Re-exports the handful of models the routers and services import by name; the
full set lives in `app.models.travel`.
"""

from .travel import (
    Itinerary,
    RouteDetail,
    TravelPlanRequest,
    TravelPlanResponse,
    TravelPlanStatus,
)

__all__ = [
    "Itinerary",
    "RouteDetail",
    "TravelPlanRequest",
    "TravelPlanResponse",
    "TravelPlanStatus",
]
