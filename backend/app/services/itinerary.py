import asyncio
import uuid
from datetime import datetime
from typing import Dict, Any, Optional
from app.models.travel import TravelPlanRequest, ComputationStatus
from app.services.TravelPlanner import TravelPlanner

tp = TravelPlanner()

# In-memory storage for travel plans (in production, use Redis or database)
travel_plans: Dict[str, Dict[str, Any]] = {}


async def compute_itinerary_async(request: TravelPlanRequest, code: str) -> None:
    """
    Async function that runs the actual itinerary computation in background.
    """
    try:
        travel_plans[code]["status"] = ComputationStatus.PROCESSING
        travel_plans[code]["updated_at"] = datetime.now().isoformat()

        itinerary = await asyncio.to_thread(
            tp.plan_route,
            places=request.places,
            start_idx=request.start_idx,
            end_idx=request.end_idx,
            start_time=request.start_time,
            modes=request.modes,
            walking_preference=request.walking_preference,
            max_walking_distance=request.max_walking_distance
        )

        # Update with completed results
        travel_plans[code].update({
            "status": ComputationStatus.COMPLETED,
            "itinerary": itinerary,
            "updated_at": datetime.now().isoformat()
        })

    except Exception as e:
        # Handle computation errors
        travel_plans[code].update({
            "status": ComputationStatus.FAILED,
            "error": str(e),
            "updated_at": datetime.now().isoformat()
        })


async def start_itinerary_computation(request: TravelPlanRequest) -> str:
    """
    Start async itinerary computation and return tracking code.
    """
    # Generate unique code for this travel plan
    code = str(uuid.uuid4())[:12].upper()

    # Initialize travel plan record
    travel_plans[code] = {
        "status": ComputationStatus.PENDING,
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
        "itinerary": None,
        "error": None
    }

    # Start async computation (fire and forget)
    asyncio.create_task(compute_itinerary_async(request, code))

    return code


def get_all_travel_plans() -> Dict[str, Dict[str, Any]]:
    """
    Retrieve all travel plans.
    """
    return travel_plans.copy()


def get_travel_plan(code: str) -> Optional[Dict[str, Any]]:
    """
    Retrieve a travel plan by its code.
    """
    return travel_plans.get(code)


def travel_plan_exists(code: str) -> bool:
    """
    Check if a travel plan exists.
    """
    return code in travel_plans


def delete_travel_plan(code: str) -> bool:
    """
    Delete a travel plan (optional cleanup).
    """
    if code in travel_plans:
        del travel_plans[code]
        return True
    return False
