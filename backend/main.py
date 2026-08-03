"""
uvicorn entry point for the backend.

Run from the repository root, since the app is installed editable and imports
itself as `app.*`. HOST and PORT override the defaults; reload is always on,
so this is a development server.
"""

import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8000")),
        reload=True,
        log_level="info"
    )
