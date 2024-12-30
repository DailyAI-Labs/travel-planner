from typing import Dict, Any
from fastapi import APIRouter, HTTPException
from app.models.travel import TravelPlanRequest, TravelPlanStatus, TravelPlanResponse
from app.services.itinerary import (
    start_itinerary_computation,
    get_all_travel_plans,
    get_travel_plan,
    travel_plan_exists,
    delete_travel_plan
)

router = APIRouter(
    prefix="/api/v1",
    tags=["travel_planner"]
)


@router.post("/compute_itinerary", response_model=TravelPlanStatus)
async def post_travel_plan_request(request: TravelPlanRequest) -> TravelPlanStatus:
    """
    Submit a travel request and get a code to retrieve the computed itinerary.
    The computation runs asynchronously in the background.
    
    - **places**: List of place names to visit
    - **start_idx**: Index of the starting place in the places list
    - **end_idx**: Index of the ending place in the places list
    - **start_time**: When to start the journey
    - **modes**: Preferred transportation modes (e.g., ["walking", "public_transport", "car"])
    - **walking_preference**: Whether walking is preferred when possible
    - **max_walking_distance**: Maximum walking distance in meters
    
    Returns a code to track the computation progress.
    """
    try:
        code = await start_itinerary_computation(request)
        return TravelPlanStatus(
            code=code,
            status="pending",
            message="Itinerary computation started. Use the code to check progress."
        )
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Error starting computation: {str(e)}")


@router.get("/travel_plan/{code}", response_model=TravelPlanResponse)
async def get_travel_plan_status(code: str) -> TravelPlanResponse:
    """
    Retrieve a computed travel plan using its code.
    
    - **code**: The unique code returned when submitting the travel request
    
    Status can be:
    - **pending**: Computation not started yet
    - **processing**: Computation in progress
    - **completed**: Computation finished successfully
    - **failed**: Computation failed with error
    """
    if not travel_plan_exists(code):
        raise HTTPException(status_code=404, detail="Travel plan not found")

    plan = get_travel_plan(code)
    print(plan)
    return TravelPlanResponse(**plan)


@router.delete("/travel_plan/{code}")
async def delete_travel_plan_endpoint(code: str) -> Dict[str, str]:
    """
    Delete a travel plan (optional cleanup endpoint).
    
    - **code**: The unique code of the travel plan to delete
    """
    if not travel_plan_exists(code):
        raise HTTPException(status_code=404, detail="Travel plan not found")

    success = delete_travel_plan(code)
    if success:
        return {"message": "Travel plan deleted successfully"}
    else:
        raise HTTPException(
            status_code=500, detail="Failed to delete travel plan")


@router.get("/travel_plan/{code}/status")
async def get_travel_plan_status(code: str) -> Dict[str, Any]:
    """
    Get just the status of a travel plan computation.
    
    - **code**: The unique code of the travel plan
    """
    if not travel_plan_exists(code):
        raise HTTPException(status_code=404, detail="Travel plan not found")

    plan = get_travel_plan(code)
    return {
        "code": code,
        "status": plan["status"],
        "updated_at": plan["updated_at"],
        "error": plan.get("error")
    }


@router.get("/travel_plans/status")
async def get_all_travel_plans_statuses() -> Dict[str, str | list[str]]:
    """
    Get the status of all travel plan computations.
    
    Returns a list of all travel plans with their current status.
    """
    all_plans = get_all_travel_plans()

    if not all_plans:
        return {"message": "No travel plans found", "plans": []}
    
    return {"codes": list(all_plans.keys())}


