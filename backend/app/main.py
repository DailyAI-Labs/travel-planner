"""
FastAPI application: CORS, router wiring, and the two service endpoints.

`app` is the ASGI object uvicorn is pointed at. The planning endpoints live in
`app.routers.travel`; what is defined here is only the root banner and the
health check.
"""

import os
from datetime import datetime

from app.routers.travel import router as travel_router
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Comma-separated, so the dev server can be moved off port 3000.
CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")
    if origin.strip()
]

app = FastAPI(
    title="Travel Planner API",
    description="Backend service for optimizing travel itineraries",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,  # React dev server
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(travel_router)

# response_model=None keeps the return annotation from turning into a declared
# response schema, which these two endpoints never had.
@app.get("/", response_model=None)
async def root() -> dict[str, str]:
    """
    Root endpoint providing API information.

    Returns
    -------
    dict[str, str]
        Keys `message`, `version`, and `docs`/`redoc` pointing at the two
        generated documentation UIs.
    """
    return {
        "message": "Travel Planner API",
        "version": "1.0.0",
        "docs": "/docs",
        "redoc": "/redoc"
    }

@app.get("/health", response_model=None)
async def health_check() -> dict[str, str]:
    """
    Health check endpoint.

    Reports only that the process is up: it does not probe the geocoder or the
    routing engine.

    Returns
    -------
    dict[str, str]
        Keys `status` (always "healthy") and `timestamp` (ISO 8601, local
        time).
    """
    return {"status": "healthy", "timestamp": datetime.now().isoformat()}
