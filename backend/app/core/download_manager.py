"""
Download Manager Service
Inspired by Downie 4's download management capabilities.

Downloads are executed by yt-dlp (see ``ytdlp_service``) inside a worker
thread, while progress is pushed back into the asyncio loop so the REST API
and the WebSocket can stream live status to the UI.
"""
from __future__ import annotations

import asyncio
import hashlib
import shutil
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Callable, Dict, List, Optional

from . import ytdlp_service
from .video_extractor import VideoInfo, VideoQuality, PostProcessing

BACKEND_DIR = Path(__file__).resolve().parents[2]
DEFAULT_DOWNLOAD_DIR = BACKEND_DIR / "downloads"


class DownloadStatus(Enum):
    """Download status states"""

    PENDING = "pending"
    STARTING = "starting"
    DOWNLOADING = "downloading"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    PAUSED = "paused"


@dataclass
class DownloadProgress:
    """Download progress information"""

    downloaded_bytes: int = 0
    total_bytes: int = 0
    speed: float = 0.0  # bytes per second
    eta: int = 0  # estimated time remaining in seconds
    percentage: float = 0.0
    status: DownloadStatus = DownloadStatus.PENDING
    error_message: str = ""

    @property
    def progress_text(self) -> str:
        """Human readable progress text"""
        if self.total_bytes > 0:
            return (
                f"{self.percentage:.1f}% "
                f"({self._format_bytes(self.downloaded_bytes)}/{self._format_bytes(self.total_bytes)})"
            )
        return f"{self._format_bytes(self.downloaded_bytes)} downloaded"

    @property
    def speed_text(self) -> str:
        """Human readable speed text"""
        return f"{self._format_bytes(self.speed)}/s"

    def _format_bytes(self, bytes_val: float) -> str:
        """Format bytes to human readable format"""
        for unit in ["B", "KB", "MB", "GB"]:
            if bytes_val < 1024.0:
                return f"{bytes_val:.1f} {unit}"
            bytes_val /= 1024.0
        return f"{bytes_val:.1f} TB"


@dataclass
class DownloadTask:
    """Download task representation"""

    id: str
    url: str
    title: str
    output_path: str
    video_info: Optional[VideoInfo] = None
    quality: VideoQuality = VideoQuality.BEST
    post_processing: PostProcessing = PostProcessing.NONE
    cookies: str = ""
    cookies_from_browser: str = ""
    headers: Dict[str, str] = field(default_factory=dict)
    progress: DownloadProgress = field(default_factory=DownloadProgress)
    files: List[str] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    completed_at: Optional[float] = None

    @property
    def duration(self) -> float:
        """Get task duration"""
        if self.started_at:
            end_time = self.completed_at or time.time()
            return end_time - self.started_at
        return 0


class DownloadManager:
    """
    Download manager inspired by Downie 4
    Handles video downloads with progress tracking and post-processing
    """

    def __init__(self, download_dir: Optional[str] = None, max_concurrent: int = 3):
        self.download_dir = Path(download_dir) if download_dir else DEFAULT_DOWNLOAD_DIR
        self.download_dir.mkdir(parents=True, exist_ok=True)

        self.max_concurrent = max_concurrent
        self.tasks: Dict[str, DownloadTask] = {}
        self.active_downloads: Dict[str, asyncio.Task] = {}
        self.progress_callbacks: Dict[str, List[Callable]] = {}
        self._cancelled: set[str] = set()
        self._last_notify: Dict[str, float] = {}

        self.ffmpeg_path = ytdlp_service.find_ffmpeg()

    # ------------------------------------------------------------------
    # Task lifecycle
    # ------------------------------------------------------------------
    def generate_task_id(self, url: str) -> str:
        """Generate unique task ID"""
        return hashlib.md5(f"{url}{time.time()}{id(self)}".encode()).hexdigest()[:12]

    async def add_download(
        self,
        url: str,
        quality: VideoQuality = VideoQuality.BEST,
        post_processing: PostProcessing = PostProcessing.NONE,
        cookies: str = "",
        custom_filename: str = "",
        cookies_from_browser: str = "",
    ) -> str:
        """Extract the URL and register a new (not yet started) download task."""
        info = await asyncio.to_thread(
            ytdlp_service.extract, url, cookies, cookies_from_browser
        )

        task_id = self.generate_task_id(url)
        title = custom_filename.strip() or info["title"]
        task = DownloadTask(
            id=task_id,
            url=info.get("url") or url,
            title=title,
            output_path="",
            quality=quality,
            post_processing=post_processing,
            cookies=cookies,
            cookies_from_browser=cookies_from_browser,
        )
        self.tasks[task_id] = task
        return task_id

    async def start_download(self, task_id: str) -> bool:
        """Start a download task"""
        task = self.tasks.get(task_id)
        if task is None:
            return False

        if task_id in self.active_downloads:
            return True  # already running

        active = [tid for tid in self.active_downloads if not self.active_downloads[tid].done()]
        if len(active) >= self.max_concurrent:
            # Queue it; _start_pending() picks it up when a slot frees.
            task.progress.status = DownloadStatus.PENDING
            return True

        self._cancelled.discard(task_id)
        task.progress.status = DownloadStatus.STARTING
        task.progress.error_message = ""
        task.started_at = task.started_at or time.time()
        task.completed_at = None

        self.active_downloads[task_id] = asyncio.create_task(self._download_task(task))
        return True

    async def _download_task(self, task: DownloadTask):
        """Execute download task"""
        loop = asyncio.get_running_loop()
        tmp_dir = self.download_dir / ".tmp" / task.id
        tmp_dir.mkdir(parents=True, exist_ok=True)

        def on_progress(data: Dict) -> None:
            status = data.get("status")
            now = time.time()

            if data.get("postprocessor"):
                if status == "started":
                    task.progress.status = DownloadStatus.PROCESSING
                    task.progress.speed = 0.0
            elif status == "downloading":
                total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
                downloaded = data.get("downloaded_bytes") or 0
                task.progress.status = DownloadStatus.DOWNLOADING
                task.progress.downloaded_bytes = int(downloaded)
                task.progress.total_bytes = int(total)
                task.progress.percentage = (downloaded / total * 100) if total else 0.0
                task.progress.speed = float(data.get("speed") or 0)
                task.progress.eta = int(data.get("eta") or 0)
            elif status == "finished":
                task.progress.downloaded_bytes = task.progress.total_bytes or task.progress.downloaded_bytes
                task.progress.percentage = 100.0
                task.progress.speed = 0.0
                task.progress.eta = 0

            if now - self._last_notify.get(task.id, 0.0) >= 0.3:
                self._last_notify[task.id] = now
                loop.call_soon_threadsafe(self._spawn_notify, task)

        try:
            quality = task.quality.value
            audio_only = task.post_processing == PostProcessing.AUDIO_ONLY

            produced = await asyncio.to_thread(
                ytdlp_service.download,
                task.url,
                tmp_dir,
                quality,
                audio_only,
                task.cookies,
                task.cookies_from_browser,
                on_progress,
                lambda: task.id in self._cancelled,
            )

            if task.id in self._cancelled:
                raise ytdlp_service.YtdlpError("下载已取消")

            moved: List[Path] = []
            for src in produced:
                dest = self._unique_path(self.download_dir / self._clean_name(src.name))
                shutil.move(str(src), str(dest))
                moved.append(dest)

            task.files = [str(p) for p in moved]
            if moved:
                task.output_path = str(moved[0])

            task.progress.downloaded_bytes = task.progress.total_bytes or task.progress.downloaded_bytes
            task.progress.total_bytes = task.progress.total_bytes or task.progress.downloaded_bytes
            task.progress.percentage = 100.0
            task.progress.speed = 0.0
            task.progress.eta = 0
            task.progress.status = DownloadStatus.COMPLETED
            task.completed_at = time.time()

        except ytdlp_service.YtdlpError as exc:
            if task.id in self._cancelled:
                task.progress.status = DownloadStatus.CANCELLED
                task.progress.error_message = "下载已取消"
            else:
                task.progress.status = DownloadStatus.FAILED
                task.progress.error_message = str(exc)
            task.completed_at = time.time()
        except asyncio.CancelledError:
            task.progress.status = DownloadStatus.CANCELLED
            task.progress.error_message = "下载已取消"
            task.completed_at = time.time()
            raise
        except Exception as exc:  # noqa: BLE001
            task.progress.status = DownloadStatus.FAILED
            task.progress.error_message = str(exc)
            task.completed_at = time.time()
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            tmp_root = self.download_dir / ".tmp"
            if tmp_root.exists() and not any(tmp_root.iterdir()):
                shutil.rmtree(tmp_root, ignore_errors=True)
            self.active_downloads.pop(task.id, None)
            self._cancelled.discard(task.id)
            self._start_pending()
            await self._notify_progress(task)

    def _start_pending(self) -> None:
        """Start queued tasks while download slots are free."""
        while len(self.active_downloads) < self.max_concurrent:
            pending = [
                t
                for t in self.tasks.values()
                if t.progress.status == DownloadStatus.PENDING and t.id not in self.active_downloads
            ]
            if not pending:
                return
            task = min(pending, key=lambda t: t.created_at)
            task.progress.status = DownloadStatus.STARTING
            task.started_at = task.started_at or time.time()
            self.active_downloads[task.id] = asyncio.create_task(self._download_task(task))

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _spawn_notify(self, task: DownloadTask) -> None:
        """Schedule a progress notification from inside the event loop."""
        asyncio.create_task(self._notify_progress(task))

    @staticmethod
    def _clean_name(name: str) -> str:
        name = Path(name).name.replace("/", "_").replace(":", "_").strip()
        return name or f"video-{int(time.time())}"

    @staticmethod
    def _unique_path(path: Path) -> Path:
        if not path.exists():
            return path
        stem, suffix = path.stem, path.suffix
        counter = 1
        while True:
            candidate = path.with_name(f"{stem} ({counter}){suffix}")
            if not candidate.exists():
                return candidate
            counter += 1

    async def _notify_progress(self, task: DownloadTask):
        """Notify progress callbacks"""
        for callback in self.progress_callbacks.get(task.id, []):
            try:
                if asyncio.iscoroutinefunction(callback):
                    await callback(task.progress)
                else:
                    callback(task.progress)
            except Exception as exc:  # noqa: BLE001
                print(f"Progress callback error: {exc}")

    def add_progress_callback(self, task_id: str, callback: Callable):
        """Add progress callback for a task"""
        self.progress_callbacks.setdefault(task_id, []).append(callback)

    def remove_progress_callback(self, task_id: str, callback: Callable):
        """Remove progress callback"""
        try:
            self.progress_callbacks.get(task_id, []).remove(callback)
        except ValueError:
            pass

    async def cancel_download(self, task_id: str) -> bool:
        """Cancel a download.

        We intentionally do not cancel the asyncio task while yt-dlp is
        writing: the worker thread would keep writing into a directory that
        the coroutine already deleted. Instead the progress hook raises
        ``DownloadCancelled`` on the next chunk, the thread exits, and the
        worker cleans up its temp directory and frees the slot.
        """
        task = self.tasks.get(task_id)
        if task is None:
            return False

        if task_id not in self.active_downloads:
            if task.progress.status in (DownloadStatus.PENDING, DownloadStatus.STARTING):
                task.progress.status = DownloadStatus.CANCELLED
                task.progress.error_message = "下载已取消"
                task.completed_at = time.time()
                return True
            return False

        self._cancelled.add(task_id)
        task.progress.status = DownloadStatus.CANCELLED
        task.progress.error_message = "下载已取消"
        task.completed_at = time.time()
        await self._notify_progress(task)
        return True

    def get_task(self, task_id: str) -> Optional[DownloadTask]:
        """Get download task by ID"""
        return self.tasks.get(task_id)

    def get_all_tasks(self) -> List[DownloadTask]:
        """Get all download tasks"""
        return sorted(self.tasks.values(), key=lambda t: t.created_at, reverse=True)

    def get_active_tasks(self) -> List[DownloadTask]:
        """Get currently active download tasks"""
        return [task for task in self.tasks.values() if task.id in self.active_downloads]

    def cleanup_completed_tasks(self, max_age_hours: int = 24):
        """Clean up old completed tasks (files on disk are kept)."""
        current_time = time.time()
        to_remove = []

        for task_id, task in self.tasks.items():
            if (
                task.progress.status in [DownloadStatus.COMPLETED, DownloadStatus.FAILED]
                and task.completed_at
                and (current_time - task.completed_at) > (max_age_hours * 3600)
            ):
                to_remove.append(task_id)

        for task_id in to_remove:
            self.tasks.pop(task_id, None)
            self.progress_callbacks.pop(task_id, None)

    def list_downloaded_files(self) -> List[Dict[str, object]]:
        """List files already present in the download directory."""
        results: List[Dict[str, object]] = []
        if not self.download_dir.exists():
            return results

        for path in sorted(
            (p for p in self.download_dir.iterdir() if p.is_file() and not p.name.startswith(".")),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        ):
            stat = path.stat()
            results.append(
                {
                    "name": path.name,
                    "size": stat.st_size,
                    "modified": stat.st_mtime,
                    "url": f"/api/downloads/files/{path.name}",
                }
            )
        return results


# Shared instance used by the API layer
download_manager = DownloadManager()
