import os
from dotenv import load_dotenv
import googlemaps
from datetime import datetime
from typing import List, Dict, Any, Optional
from app.services.utils import validate_places, optimize_route


class TravelPlanner:
    def __init__(self,
                 api_key: Optional[str] = None,
                 ):
        if api_key:
            self.api_key = api_key
        else:
            load_dotenv()
            self.api_key = os.getenv('GCP_API_KEY')

        self.gmaps = googlemaps.Client(key=self.api_key)

    def plan_route(
        self,
        places: List[str],
        start_idx: int = 0,
        end_idx: int = -1,
        start_time: Optional[datetime] = None,
        modes: List[str] = ['driving', 'walking', 'transit'],
        walking_preference: bool = True,
        max_walking_distance: int = 1000
    ) -> Dict[str, Any]:
        """
        Plan route: validate places first, then optimize route
        """

        # Input sanitization
        start_idx = start_idx if start_idx >= 0 else len(places) + start_idx
        end_idx = end_idx if end_idx >= 0 else len(places) + end_idx
        if (
            start_idx == end_idx
            or start_idx < 0 or start_idx >= len(places)
            or end_idx < 0 or end_idx >= len(places)
        ):
            return {'success': False}

        print("=" * 60)
        print("ROUTE OPTIMIZATION WITH VALIDATION")
        print("=" * 60)

        # Step 1: Validate all places
        validation_result = validate_places(places, self.api_key)

        if not validation_result['is_valid']:
            return {
                'success': False,
                'error': 'Place validation failed',
                'validation_result': validation_result
            }

        # Step 2: Optimize route with validated places
        result = optimize_route(
            validation_result['valid_places'],
            start_idx,
            end_idx,
            self.api_key,
            start_time if start_time else datetime.now(),
            modes,
            walking_preference,
            max_walking_distance
        )

        return result
