"""
Downie Enhanced Backend Server
基于 FastAPI 的现代化视频下载服务

启动后：
  - Web UI:  http://127.0.0.1:8000/          （前端构建产物）
  - API 文档: http://127.0.0.1:8000/api/docs
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, HttpUrl

# Internal imports
from app.api.download_routes import router as download_router
from app.core import ytdlp_service
from app.core.download_manager import download_manager
from app.core.video_extractor import VideoExtractor

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_BUILD = BASE_DIR.parent / "frontend" / "build"

video_extractor = VideoExtractor()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager"""
    logger.info("🚀 Starting Downie Enhanced Backend...")
    logger.info("📁 Downloads directory: %s", download_manager.download_dir)
    logger.info("🎞  FFmpeg: %s", download_manager.ffmpeg_path or "not found")
    if FRONTEND_BUILD.is_dir():
        logger.info("🖥  Web UI: http://127.0.0.1:8000/")
    else:
        logger.warning("Web UI build not found - run the build step in run-local.sh")

    yield

    logger.info("🛑 Shutting down Downie Enhanced Backend...")


app = FastAPI(
    title="Downie Enhanced API",
    description="Modern Web Video Downloader Backend",
    version="1.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API routers
app.include_router(download_router)


# Pydantic models
class URLAnalyzeRequest(BaseModel):
    url: HttpUrl
    extract_playlist: bool = False
    quality_preference: str = "best"


class URLAnalyzeResponse(BaseModel):
    title: str
    duration: int
    thumbnail: str
    formats: List[dict]
    is_playlist: bool
    playlist_count: int = 0


# API Routes
@app.get("/api/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "message": "Downie Enhanced Backend is running",
        "version": "1.0.0",
        "ffmpeg": download_manager.ffmpeg_path,
        "download_dir": str(download_manager.download_dir),
    }


@app.get("/api/stats")
async def get_stats():
    """Get server statistics"""
    return {
        "active_downloads": len(download_manager.get_active_tasks()),
        "total_downloads": len(download_manager.get_all_tasks()),
        "supported_sites": len(video_extractor.supported_sites),
    }


@app.post("/api/analyze", response_model=URLAnalyzeResponse)
async def analyze_url(request: URLAnalyzeRequest):
    """Analyze video URL and extract metadata"""
    url = str(request.url)
    logger.info("Analyzing URL: %s", url)

    try:
        info = await asyncio.to_thread(ytdlp_service.extract, url, "")
    except ytdlp_service.YtdlpError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return URLAnalyzeResponse(
        title=info["title"],
        duration=info["duration"],
        thumbnail=info["thumbnail"],
        formats=info["formats"],
        is_playlist=info["is_playlist"],
        playlist_count=info["playlist_count"],
    )


@app.get("/api/supported-sites")
async def get_supported_sites():
    """Get list of supported video sites"""
    return {
        "sites": video_extractor.supported_sites,
        "total": len(video_extractor.supported_sites),
        "note": "实际解析由 yt-dlp 完成，支持 1000+ 网站",
    }


# Root fallback when the frontend has not been built yet.
if not FRONTEND_BUILD.is_dir():

    @app.get("/", response_class=HTMLResponse)
    async def root():
        """Root endpoint - API info"""
        return """
        <html>
            <head><title>Downie Enhanced API</title></head>
            <body style="font-family: -apple-system, sans-serif; padding: 40px;">
                <h1>🚀 Downie Enhanced Backend</h1>
                <p>Modern Web Video Downloader API</p>
                <p>前端尚未构建，请运行 <code>./run-local.sh</code></p>
                <ul>
                    <li><a href="/api/docs">📖 API Documentation</a></li>
                    <li><a href="/api/health">💚 Health Check</a></li>
                    <li><a href="/api/downloads/tasks">📥 Tasks</a></li>
                </ul>
            </body>
        </html>
        """


# Serve the built React app (if present) at the site root.
if FRONTEND_BUILD.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND_BUILD), html=True), name="frontend")


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "8000")),
        log_level="info",
    )
