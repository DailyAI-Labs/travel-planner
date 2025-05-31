# DailyAI: Travel Planner

Travel planning application to organize trips by optimizing itineraries.

### Tech Stack
- Backend: Python (FastAPI)
- Frontend: React

### Backend set up
1. Create and activate a virtual environment
2. Navigate to the backend folder
```
cd backend
```
3. Install required libraries by running 
```
pip install -r requirements.txt
```
4. Install our package in editable mode by running: 
```
pip3 install -e .
```

### Running the backend
- From the root folder, run
```
python backend/main.py   
```

- Alternatively, from the folder `backend/`, run
```
uvicorn app.main:app --reload    
```

Example
```
{
  "places": ["Big Ben (Elizabeth Tower)", "Tower Bridge", "Buckingham Palace", "Tower of London", "London Eye"],
  "start_idx": 0,
  "end_idx": -1,
  "start_time": "2025-05-30T21:31:18.387Z",
  "modes": ["walking", "transit"],
  "walking_preference": true,
  "max_walking_distance": 1000
}
```


### Running the frontend
```
npm start
```

Example
```
Big Ben (Elizabeth Tower), Tower Bridge, Buckingham Palace, Tower of London
```
