"""
HTTP routers mounted by the FastAPI application.

Exposes `travel_router`, which carries every /api/v1 endpoint.
"""

from .travel import router as travel_router

__all__ = ["travel_router"]
