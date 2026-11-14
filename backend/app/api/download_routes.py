"""
Download API Routes
REST API endpoints for download management inspired by Downie 4
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel, HttpUrl

from ..core import ytdlp_service
from ..core.download_manager import (
    DownloadManager,
    DownloadProgress,
    DownloadStatus,
    DownloadTask,
    download_manager,
)
from ..core.video_extractor import PostProcessing, VideoQuality

router = APIRouter(prefix="/api/downloads", tags=["downloads"])

# WebSocket connections for real-time updates
active_connections: List[WebSocket] = []


# ----------------------------------------------------------------------
# Pydantic models
# ----------------------------------------------------------------------
class DownloadRequest(BaseModel):
    """Download request model"""

    url: HttpUrl
    quality: VideoQuality = VideoQuality.BEST
    post_processing: PostProcessing = PostProcessing.NONE
    cookies: str = ""
    cookies_from_browser: str = ""
    custom_filename: Optional[str] = None
    auto_start: bool = True


class DownloadResponse(BaseModel):
    """Download response model"""

    task_id: str
    message: str
    status: str = "created"


class TaskInfo(BaseModel):
    """Task information model"""

    id: str
    url: str
    title: str
    status: str
    progress_percentage: float
    downloaded_bytes: int
    total_bytes: int
    speed: float
    eta: int
    created_at: float
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    error_message: str = ""
    files: List[str] = []
    download_url: str = ""


class VideoInfoResponse(BaseModel):
    """Video information response"""

    url: str
    title: str
    duration: int
    thumbnail: str
    description: str
    uploader: str
    extractor: str = ""
    formats: List[Dict[str, Any]]
    is_playlist: bool = False
    playlist_count: int = 0


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------
async def broadcast_progress(task_id: str, progress: DownloadProgress):
    """Broadcast progress to all connected WebSocket clients"""
    if not active_connections:
        return

    message = {
        "type": "progress",
        "task_id": task_id,
        "progress": {
            "status": progress.status.value,
            "percentage": progress.percentage,
            "downloaded_bytes": progress.downloaded_bytes,
            "total_bytes": progress.total_bytes,
            "speed": progress.speed,
            "eta": progress.eta,
            "progress_text": progress.progress_text,
            "speed_text": progress.speed_text,
        },
    }
    payload = json.dumps(message, ensure_ascii=False)

    disconnected = []
    for connection in list(active_connections):
        try:
            await connection.send_text(payload)
        except Exception:  # noqa: BLE001
            disconnected.append(connection)

    for conn in disconnected:
        if conn in active_connections:
            active_connections.remove(conn)


def _attach_ws_callback(task_id: str) -> None:
    def callback(progress: DownloadProgress) -> None:
        asyncio.create_task(broadcast_progress(task_id, progress))

    download_manager.add_progress_callback(task_id, callback)


def task_to_info(task: DownloadTask) -> TaskInfo:
    """Convert DownloadTask to TaskInfo"""
    names = [Path(f).name for f in task.files]
    download_url = f"/api/downloads/files/{quote(names[0])}" if names else ""
    return TaskInfo(
        id=task.id,
        url=task.url,
        title=task.title,
        status=task.progress.status.value,
        progress_percentage=round(task.progress.percentage, 1),
        downloaded_bytes=task.progress.downloaded_bytes,
        total_bytes=task.progress.total_bytes,
        speed=task.progress.speed,
        eta=task.progress.eta,
        created_at=task.created_at,
        started_at=task.started_at,
        completed_at=task.completed_at,
        error_message=task.progress.error_message,
        files=names,
        download_url=download_url,
    )


# ----------------------------------------------------------------------
# API Routes
# ----------------------------------------------------------------------
@router.post("/extract", response_model=VideoInfoResponse)
async def extract_video_info(request: DownloadRequest):
    """Extract video information without downloading"""
    try:
        info = await asyncio.to_thread(
            ytdlp_service.extract,
            str(request.url),
            request.cookies,
            request.cookies_from_browser,
        )
    except ytdlp_service.YtdlpError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400, detail=f"解析失败: {exc}"
        ) from exc

    return VideoInfoResponse(**info)


@router.post("/add", response_model=DownloadResponse)
async def add_download(request: DownloadRequest):
    """Add a new download task (and start it unless auto_start=False)"""
    try:
        task_id = await download_manager.add_download(
            url=str(request.url),
            quality=request.quality,
            post_processing=request.post_processing,
            cookies=request.cookies,
            custom_filename=request.custom_filename or "",
            cookies_from_browser=request.cookies_from_browser,
        )
    except ytdlp_service.YtdlpError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"创建任务失败: {exc}") from exc

    # Stream progress to the UI.
    _attach_ws_callback(task_id)

    status = "created"
    if request.auto_start:
        started = await download_manager.start_download(task_id)
        status = "started" if started else "queued"

    return DownloadResponse(
        task_id=task_id,
        message="下载任务已创建",
        status=status,
    )


@router.post("/start/{task_id}")
async def start_download(task_id: str):
    """Start a download task"""
    success = await download_manager.start_download(task_id)

    if not success:
        task = download_manager.get_task(task_id)
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")
        raise HTTPException(status_code=400, detail="Unable to start download")

    return {"message": "Download started", "task_id": task_id}


@router.post("/cancel/{task_id}")
async def cancel_download(task_id: str):
    """Cancel a download task"""
    success = await download_manager.cancel_download(task_id)

    if not success:
        raise HTTPException(status_code=404, detail="Task not found or not active")

    return {"message": "Download cancelled", "task_id": task_id}


@router.get("/tasks", response_model=List[TaskInfo])
async def get_all_tasks():
    """Get all download tasks"""
    return [task_to_info(task) for task in download_manager.get_all_tasks()]


@router.get("/tasks/active", response_model=List[TaskInfo])
async def get_active_tasks():
    """Get currently active download tasks"""
    return [task_to_info(task) for task in download_manager.get_active_tasks()]


@router.get("/tasks/{task_id}", response_model=TaskInfo)
async def get_task(task_id: str):
    """Get specific task information"""
    task = download_manager.get_task(task_id)

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    return task_to_info(task)


@router.delete("/tasks/{task_id}")
async def delete_task(task_id: str):
    """Delete a task record (downloaded files are kept)"""
    task = download_manager.get_task(task_id)

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    if task.progress.status in [DownloadStatus.DOWNLOADING, DownloadStatus.PROCESSING, DownloadStatus.STARTING]:
        raise HTTPException(status_code=400, detail="Cannot delete active task")

    download_manager.tasks.pop(task_id, None)
    download_manager.progress_callbacks.pop(task_id, None)

    return {"message": "Task deleted", "task_id": task_id}


@router.post("/cleanup")
async def cleanup_tasks(max_age_hours: int = 24):
    """Clean up old completed tasks"""
    download_manager.cleanup_completed_tasks(max_age_hours)
    return {"message": f"Cleaned up tasks older than {max_age_hours} hours"}


@router.get("/stats")
async def get_download_stats():
    """Get download statistics"""
    all_tasks = download_manager.get_all_tasks()
    active_tasks = download_manager.get_active_tasks()

    return {
        "total_tasks": len(all_tasks),
        "active_tasks": len(active_tasks),
        "completed_tasks": len(
            [t for t in all_tasks if t.progress.status == DownloadStatus.COMPLETED]
        ),
        "failed_tasks": len(
            [t for t in all_tasks if t.progress.status == DownloadStatus.FAILED]
        ),
        "pending_tasks": len(
            [t for t in all_tasks if t.progress.status == DownloadStatus.PENDING]
        ),
        "total_downloaded_bytes": sum(t.progress.downloaded_bytes for t in all_tasks),
        "current_speed": sum(t.progress.speed for t in active_tasks),
    }


@router.get("/files")
async def list_files():
    """List files already saved in the download directory"""
    return {"files": download_manager.list_downloaded_files()}


@router.get("/files/{filename}")
async def get_file(filename: str):
    """Serve a downloaded file"""
    safe_name = Path(filename).name
    if safe_name != filename or safe_name.startswith("."):
        raise HTTPException(status_code=400, detail="Invalid filename")

    path = (download_manager.download_dir / safe_name).resolve()
    if download_manager.download_dir.resolve() not in path.parents:
        raise HTTPException(status_code=400, detail="Invalid filename")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    return FileResponse(path, filename=safe_name)


@router.get("/qualities")
async def get_available_qualities():
    """Get available video qualities"""
    return {
        "qualities": [q.value for q in VideoQuality],
        "post_processing": [p.value for p in PostProcessing],
    }


@router.get("/supported-sites")
async def get_supported_sites():
    """Get list of supported sites"""
    return {
        "supported_sites": [
            "youtube.com",
            "bilibili.com",
            "vimeo.com",
            "twitter.com",
            "tiktok.com",
            "instagram.com",
            "facebook.com",
            "dailymotion.com",
            "以及 yt-dlp 支持的 1000+ 网站",
        ],
        "total_sites": 1000,
    }


# ----------------------------------------------------------------------
# Batch operations
# ----------------------------------------------------------------------
@router.post("/batch/add")
async def batch_add_downloads(requests: List[DownloadRequest]):
    """Add multiple downloads"""
    results = []

    for request in requests:
        try:
            task_id = await download_manager.add_download(
                url=str(request.url),
                quality=request.quality,
                post_processing=request.post_processing,
                cookies=request.cookies,
                custom_filename=request.custom_filename or "",
                cookies_from_browser=request.cookies_from_browser,
            )
            _attach_ws_callback(task_id)
            if request.auto_start:
                await download_manager.start_download(task_id)
            results.append(
                {"task_id": task_id, "url": str(request.url), "status": "created"}
            )
        except Exception as exc:  # noqa: BLE001
            results.append(
                {"url": str(request.url), "status": "error", "error": str(exc)}
            )

    return {"results": results}


@router.post("/batch/start")
async def batch_start_downloads(task_ids: List[str]):
    """Start multiple downloads"""
    results = []

    for task_id in task_ids:
        try:
            success = await download_manager.start_download(task_id)
            results.append(
                {"task_id": task_id, "status": "started" if success else "failed"}
            )
        except Exception as exc:  # noqa: BLE001
            results.append({"task_id": task_id, "status": "error", "error": str(exc)})

    return {"results": results}


# ----------------------------------------------------------------------
# WebSocket endpoint for real-time updates
# ----------------------------------------------------------------------
@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time download progress"""
    await websocket.accept()
    active_connections.append(websocket)

    try:
        tasks = download_manager.get_all_tasks()
        initial_data = {
            "type": "initial",
            "tasks": [task_to_info(task).model_dump() for task in tasks],
        }
        await websocket.send_text(json.dumps(initial_data, ensure_ascii=False))

        while True:
            try:
                data = await asyncio.wait_for(websocket.receive_text(), timeout=30.0)
                try:
                    message = json.loads(data)
                    if message.get("type") == "ping":
                        await websocket.send_text(json.dumps({"type": "pong"}))
                except json.JSONDecodeError:
                    pass
            except asyncio.TimeoutError:
                await websocket.send_text(json.dumps({"type": "heartbeat"}))

    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        print(f"WebSocket error: {exc}")
    finally:
        if websocket in active_connections:
            active_connections.remove(websocket)
