from pydantic import BaseModel, Field
from datetime import datetime
from typing import List, Optional
from enum import Enum


class ComputationStatus(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class TravelPlanRequest(BaseModel):
    places: List[str]
    start_idx: int
    end_idx: int
    start_time: datetime
    modes: List[str]
    walking_preference: bool
    max_walking_distance: int


class TravelPlanStatus(BaseModel):
    code: str
    status: str
    message: str


class RouteDetail(BaseModel):
    from_place: str
    to_place: str
    mode: str
    travel_time_seconds: int
    distance_meters: int
    estimated_arrival: datetime


class Itinerary(BaseModel):
    success: bool
    ordered_places: List[str]
    route_details: List[RouteDetail]
    total_travel_time_seconds: int
    total_distance_meters: int
    start_time: datetime
    estimated_end_time: datetime


class TravelPlanResponse(BaseModel):
    status: ComputationStatus = ComputationStatus.PENDING
    created_at: datetime = datetime.now()
    updated_at: datetime = datetime.now()
    itinerary: Optional[Itinerary] = None
    error: Optional[str] = None
