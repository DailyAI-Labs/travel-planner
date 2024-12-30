import numpy as np
import time
import googlemaps
from ortools.constraint_solver import pywrapcp
from ortools.constraint_solver import routing_enums_pb2
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional, Tuple

INFINITE_VAL: int = 999999


def log_time(func):
    """
    Decorator function to compute the execution time of a function.
    """
    def wrapper(*args, **kwargs):
        start_time = time.time()
        result = func(*args, **kwargs)
        end_time = time.time()
        elapsed_time = end_time - start_time
        print(f"Execution time of {func.__name__}: {elapsed_time:.4f} seconds")
        return result
    return wrapper
        

@log_time
def validate_places(places: List[str],
                    api_key: str
                    ) -> Dict[str, Any]:
    """
    Validate and standardize place names using Google Geocoding API
    
    Args:
        places (list): List of place names or coordinates
        api_key (str): Google Maps API key
    
    Returns:
        dict: Validation results with is_valid, validated_places, and invalid_places
    """
    gmaps = googlemaps.Client(key=api_key)

    valid_places = []
    invalid_places = []

    print("Validating place names...")
    print("-" *60)

    for i, place in enumerate(places):
        try:
            geocode_result = gmaps.geocode(place)
            if geocode_result and len(geocode_result) > 0:
                formatted_address = geocode_result[0]['formatted_address']
                valid_places.append(formatted_address)
                print(f"OK [{i}] {place}")
                if place != formatted_address:
                    print(f"    → Standardized to: {formatted_address}")
            else:
                invalid_places.append({
                    'index': i,
                    'place': place,
                    'error': 'No geocoding results found'
                })
                print(f"KO [{i}] {place} - No results found")

        except Exception as e:
            invalid_places.append({
                'index': i,
                'place': place,
                'error': str(e)
            })
            print(f"KO [{i}] {place} - Error: {e}")

    print("-" * 60)

    is_valid = len(invalid_places) == 0

    return {
        'is_valid': is_valid,
        'valid_places': valid_places,
        'invalid_places': invalid_places
    }


def optimize_route(
    places: List[str],
    start_idx: int,
    end_idx: int,
    api_key: str,
    start_time: Optional[datetime] = None,
    modes: List[str] = ['driving', 'walking', 'transit'],
    walking_preference: bool = True,
    max_walking_distance: int = 1000
) -> Dict[str, Any]:
    """Main function that runs the route optimization."""
    if start_time is None:
        start_time = datetime.now()

    print("Optimize route...")
    print("-" * 60)

    print("Get travel matrices...")
    time_matrices, distance_matrices = _get_travel_matrices(
        places, modes, start_time, api_key
    )

    if not time_matrices:
        return {'success': False, 
                'error': 'Failed to get travel data'}

    print("Create optimal matrices...")
    best_time_matrix, best_mode_matrix = _create_optimal_matrices(
        time_matrices, distance_matrices, modes, walking_preference, max_walking_distance
    )

    print("Solve routing problem...")
    route_solution = _solve_routing_problem(best_time_matrix, start_idx, end_idx)

    if not route_solution['success']:
        return route_solution

    print("Build route response...")
    return _build_route_response(
        route_solution, places, best_time_matrix,
        best_mode_matrix, distance_matrices, start_time
    )


@log_time
def _solve_routing_problem(distance_matrix, start_index, end_index):
    data = {}
    data['distance_matrix'] = distance_matrix
    data['num_vehicles'] = 1
    data['starts'] = [start_index]  # Starting depot
    data['ends'] = [end_index]      # Ending depot
    
    # Create the routing index manager
    manager = pywrapcp.RoutingIndexManager(
        len(data['distance_matrix']), 
        data['num_vehicles'], 
        data['starts'],  # List of start depots
        data['ends'],  # List of end depots
    )
    
    # Create Routing Model
    routing = pywrapcp.RoutingModel(manager)
    
    # Create and register a transit callback
    def distance_callback(from_index, to_index):
        """Returns the distance between the two nodes."""
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)
        return data['distance_matrix'][from_node][to_node]
    
    transit_callback_index = routing.RegisterTransitCallback(distance_callback)
    
    # Define cost of each arc
    routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)
    
    # Setting first solution heuristic
    search_parameters = pywrapcp.DefaultRoutingSearchParameters()
    search_parameters.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    )

    search_parameters.time_limit.seconds = 30
    
    # Solve the problem
    solution = routing.SolveWithParameters(search_parameters)

    # Create output
    if solution:
        route_idxs, total_distance = _extract_route_from_solution(
            routing, manager, solution)
        return {
            'success': True,
            'route_idxs': route_idxs,
            'total_distance': total_distance
        }
    else:
        return {
            'success': False,
            'error': 'No solution found - OR-Tools could not find optimal route'
        }
    

@log_time
def _get_travel_matrices(
    places: List[str],
    modes: List[str],
    start_time: datetime,
    api_key: str,
    batch_size: int = 10,
) -> Tuple[Dict[str, List[List[int]]], Dict[str, List[List[int]]]]:
    """Get travel time and distance matrices for all transportation modes."""
    gmaps = googlemaps.Client(key=api_key)
    time_matrices = {}
    distance_matrices = {}
    n_places = len(places)
    
    for mode in modes:
        print(f"Getting {mode} travel data...")
        try:
            full_time_matrix = [[0 for _ in range(n_places)] for _ in range(n_places)]
            full_dist_matrix = [[0 for _ in range(n_places)] for _ in range(n_places)]

            # Process in batches
            for i in range(0, n_places, batch_size):
                for j in range(0, n_places, batch_size):
                    # Get batch indices
                    origin_end = min(i + batch_size, n_places)
                    dest_end = min(j + batch_size, n_places)

                    origin_batch = places[i:origin_end]
                    dest_batch = places[j:dest_end]

                    print(f"Processing batch: origins {i}-{origin_end-1}, destinations {j}-{dest_end-1}")

                    # Get matrix for this batch
                    params = _build_api_params(origin_batch, dest_batch, mode, start_time)
                    result = gmaps.distance_matrix(**params)

                    batch_time_matrix, batch_dist_matrix = _parse_distance_matrix_result(result)

                    # Insert batch results into full matrices
                    for orig_idx, orig_global_idx in enumerate(range(i, origin_end)):
                        for dest_idx, dest_global_idx in enumerate(range(j, dest_end)):
                            full_time_matrix[orig_global_idx][dest_global_idx] = batch_time_matrix[orig_idx][dest_idx]
                            full_dist_matrix[orig_global_idx][dest_global_idx] = batch_dist_matrix[orig_idx][dest_idx]

            time_matrices[mode] = full_time_matrix
            distance_matrices[mode] = full_dist_matrix

            # params = _build_api_params(places, mode, start_time)
            # result = gmaps.distance_matrix(**params)

            # time_matrix, dist_matrix = _parse_distance_matrix_result(result)
            # time_matrices[mode] = time_matrix
            # distance_matrices[mode] = dist_matrix

        except Exception as e:
            print(f"Error getting {mode} data: {e}")
            return {}, {}

    return time_matrices, distance_matrices


def _build_api_params(origins: List[str],
                      destinations: List[str],
                      mode: str, 
                      start_time: datetime) -> Dict[str, Any]:
    """Build API parameters for different transportation modes."""
    params = {
        'origins': origins,
        'destinations': destinations,
        'mode': mode
    }

    if mode in ['driving', 'transit']:
        params['departure_time'] = start_time

    if mode == 'driving':
        params['traffic_model'] = 'best_guess'
    elif mode == 'transit':
        params['transit_mode'] = ['bus', 'subway', 'train', 'tram', 'rail']
        params['transit_routing_preference'] = 'less_walking'

    return params


def _parse_distance_matrix_result(result: Dict[str, Any],
                                  ) -> Tuple[List[List[int]], 
                                             List[List[int]]]:
    """Parse Google Maps Distance Matrix API result into time and distance matrices."""
    time_matrix = []
    dist_matrix = []

    for row in result['rows']:
        time_row = []
        dist_row = []
        for element in row['elements']:
            if element['status'] == 'OK':
                time_row.append(element['duration']['value'])
                dist_row.append(element['distance']['value'])
            else:
                time_row.append(INFINITE_VAL)
                dist_row.append(INFINITE_VAL)
        time_matrix.append(time_row)
        dist_matrix.append(dist_row)

    return time_matrix, dist_matrix


@log_time
def _create_optimal_matrices(
    time_matrices: Dict[str, List[List[int]]],
    distance_matrices: Dict[str, List[List[int]]],
    modes: List[str],
    walking_preference: bool,
    max_walking_distance: int
) -> Tuple[List[List[int]], List[List[str]]]:
    """Create matrices with optimal mode and time for each place pair."""
    n_places = len(next(iter(time_matrices.values())))
    best_time_matrix = []
    best_mode_matrix = []

    for i in range(n_places):
        time_row = []
        mode_row = []
        for j in range(n_places):
            if i == j:
                time_row.append(0)
                mode_row.append('same_location')
            else:
                best_time, best_mode = _find_best_mode_for_pair(
                    i, j, time_matrices, distance_matrices, modes,
                    walking_preference, max_walking_distance
                )
                time_row.append(best_time)
                mode_row.append(best_mode)

        best_time_matrix.append(time_row)
        best_mode_matrix.append(mode_row)

    return best_time_matrix, best_mode_matrix


@log_time
def _find_best_mode_for_pair(
    from_idx: int,
    to_idx: int,
    time_matrices: Dict[str, List[List[int]]],
    distance_matrices: Dict[str, List[List[int]]],
    modes: List[str],
    walking_preference: bool,
    max_walking_distance: int
) -> Tuple[int, str]:
    """Find the best transportation mode for a specific place pair."""
    best_time = INFINITE_VAL
    best_mode = modes[0]

    for mode in modes:
        current_time = time_matrices[mode][from_idx][to_idx]
        current_distance = distance_matrices[mode][from_idx][to_idx]

        # Apply walking preference
        if (walking_preference and
            mode == 'walking' and
            current_distance <= max_walking_distance and
            current_time < INFINITE_VAL):
            return current_time, 'walking'
        elif current_time < best_time:
            best_time = current_time
            best_mode = mode

    return int(best_time), best_mode


def _extract_route_from_solution(routing, manager, solution):
    """Extract the optimized route indices from OR-Tools solution."""
    route_idxs = []
    total_distance = 0
    index = routing.Start(0)

    while not routing.IsEnd(index):
        route_idxs.append(manager.IndexToNode(index))
        previous_index = index
        index = solution.Value(routing.NextVar(index))
        total_distance += routing.GetArcCostForVehicle(
            previous_index, index, 0)

    route_idxs.append(manager.IndexToNode(index))
    return route_idxs, total_distance


def _build_route_response(
    route_solution: Dict[str, Any],
    places: List[str],
    best_time_matrix: List[List[int]],
    best_mode_matrix: List[List[str]],
    distance_matrices: Dict[str, List[List[int]]],
    start_time: datetime
) -> Dict[str, Any]:
    """Build the final detailed route response."""
    route_idxs = route_solution['route_idxs']
    total_distance = route_solution['total_distance']

    route_details = []
    total_actual_distance = 0

    for i in range(len(route_idxs) - 1):
        from_idx = route_idxs[i]
        to_idx = route_idxs[i + 1]
        mode_used = best_mode_matrix[from_idx][to_idx]
        travel_time = best_time_matrix[from_idx][to_idx]

        # Get actual distance for the chosen mode
        actual_distance = 0
        if mode_used in distance_matrices:
            actual_distance = distance_matrices[mode_used][from_idx][to_idx]
            total_actual_distance += actual_distance

        route_details.append({
            'from_place': places[from_idx],
            'to_place': places[to_idx],
            'mode': mode_used,
            'travel_time_seconds': travel_time,
            'distance_meters': actual_distance,
            'estimated_arrival': start_time + timedelta(seconds=sum([
                best_time_matrix[route_idxs[j]][route_idxs[j+1]] for j in range(i+1)
            ]))
        })

    return {
        'success': True,
        'ordered_places': [places[i] for i in route_idxs],
        'route_details': route_details,
        'total_travel_time_seconds': total_distance,
        'total_distance_meters': total_actual_distance,
        'start_time': start_time,
        'estimated_end_time': start_time + timedelta(seconds=total_distance)
    }


def print_result(result: Dict[str, Any]) -> None:
    if result['success']:
        print(f"\n{'='*60}")
        print(f"ROUTE RESULTS")
        print(f"{'='*60}")
        print(
            f"Start time: {result['start_time'].strftime('%Y-%m-%d %H:%M:%S')}")
        print(
            f"Estimated end time: {result['estimated_end_time'].strftime('%Y-%m-%d %H:%M:%S')}")
        print(
            f"Total travel time: {result['total_travel_time_seconds']} seconds ({result['total_travel_time_seconds']/60:.1f} minutes)")
        print(
            f"Total distance: {result['total_distance_meters']/1000:.2f} km")

        print(f"\nROUTE DETAILS:")
        print(f"{'-'*60}")
        for i, detail in enumerate(result['route_details'], 1):
            print(f"Step {i}: {detail['from_place']} → {detail['to_place']}")
            print(f"  Mode: {detail['mode']}")
            print(
                f"  Time: {detail['travel_time_seconds']} seconds ({detail['travel_time_seconds']/60:.1f} min)")
            print(f"  Distance: {detail['distance_meters']/1000:.2f} km")
            print(
                f"  Arrival: {detail['estimated_arrival'].strftime('%H:%M:%S')}")
            print()
    else:
        print(f"\nOptimization failed: {result['error']}")
        if 'validation_result' in result:
            print("Please fix the following places and try again:")
            for invalid in result['validation_result']['invalid_places']:
                print(f"  - {invalid['place']}: {invalid['error']}")
