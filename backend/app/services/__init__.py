"""
Service layer: geocoding, travel matrices, route optimization and job storage.

Re-exports the job-store entry points the routers use; the planning facade
itself lives in `app.services.travel_planner`.
"""

from .itinerary import (
    delete_travel_plan,
    get_travel_plan,
    start_itinerary_computation,
    travel_plan_exists,
)

__all__ = [
    "delete_travel_plan",
    "get_travel_plan",
    "start_itinerary_computation",
    "travel_plan_exists",
]
