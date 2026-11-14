"""
yt-dlp based extraction and download service.

The original project listed yt-dlp in requirements.txt but never used it, so
"extraction" returned hand-made fake formats pointing at the web page itself.
This module is the real engine: metadata extraction, format listing and the
actual download (HLS/DASH/merge/audio extraction).
"""
from __future__ import annotations

import os
import shutil
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import yt_dlp

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

QUALITY_MAP = {
    "auto": None,
    "best": None,
    "worst": "worst",
    "1080p": 1080,
    "720p": 720,
    "480p": 480,
    "360p": 360,
}


class YtdlpError(RuntimeError):
    """Raised when yt-dlp fails to extract or download."""


def find_ffmpeg() -> Optional[str]:
    """Locate a usable ffmpeg binary (Homebrew first, then PATH)."""
    candidates = [
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    return shutil.which("ffmpeg")


def _base_opts(cookies: str = "", cookies_from_browser: str = "") -> Dict[str, Any]:
    opts: Dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "socket_timeout": 30,
        "retries": 3,
        "fragment_retries": 3,
        "nocheckcertificate": True,
        "http_headers": {"User-Agent": USER_AGENT},
    }
    ffmpeg = find_ffmpeg()
    if ffmpeg:
        opts["ffmpeg_location"] = ffmpeg
    if cookies:
        opts["http_headers"]["Cookie"] = cookies
    if cookies_from_browser:
        # ("browser", profile, keyring, container) - None means defaults.
        opts["cookiesfrombrowser"] = (cookies_from_browser, None, None, None)
    return opts


def _human_quality(fmt: Dict[str, Any]) -> str:
    height = fmt.get("height")
    if height:
        return f"{height}p"
    if fmt.get("resolution") == "audio only":
        return "audio"
    resolution = fmt.get("resolution")
    if resolution:
        return str(resolution)
    return "unknown"


def _format_rows(info: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for fmt in info.get("formats") or []:
        if not fmt.get("url"):
            continue
        vcodec = fmt.get("vcodec")
        acodec = fmt.get("acodec")
        # A format explicitly marked as neither audio nor video carries nothing.
        if vcodec == "none" and acodec == "none":
            continue
        rows.append(
            {
                "format_id": fmt.get("format_id"),
                "ext": fmt.get("ext"),
                "quality": _human_quality(fmt),
                "height": fmt.get("height"),
                "width": fmt.get("width"),
                "fps": fmt.get("fps"),
                "vcodec": vcodec or "unknown",
                "acodec": acodec or "unknown",
                "filesize": fmt.get("filesize") or fmt.get("filesize_approx"),
                "tbr": fmt.get("tbr"),
                "protocol": fmt.get("protocol"),
                "url": fmt.get("url"),
            }
        )

    # Best video first, then audio-only formats.
    def sort_key(fmt: Dict[str, Any]):
        is_audio = fmt.get("vcodec") == "none"
        return (1 if is_audio else 0, -(fmt.get("height") or 0), -(fmt.get("tbr") or 0))

    rows.sort(key=sort_key)
    return rows


def extract(url: str, cookies: str = "", cookies_from_browser: str = "") -> Dict[str, Any]:
    """Extract metadata + available formats without downloading."""
    opts = _base_opts(cookies, cookies_from_browser)
    opts["skip_download"] = True
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as exc:
        raise YtdlpError(_clean_error(str(exc))) from exc
    except Exception as exc:  # noqa: BLE001 - surface a readable message
        raise YtdlpError(str(exc)) from exc

    if not info:
        raise YtdlpError("没有解析到任何视频信息")

    is_playlist = info.get("_type") == "playlist"
    playlist_count = 0
    if is_playlist:
        entries = [e for e in (info.get("entries") or []) if e]
        playlist_count = len(entries)
        if not entries:
            raise YtdlpError("播放列表为空")
        info = entries[0]

    formats = _format_rows(info)
    if not formats:
        raise YtdlpError("该链接没有可直接下载的媒体格式")

    return {
        "url": info.get("webpage_url") or url,
        "title": info.get("title") or "未命名视频",
        "duration": int(info.get("duration") or 0),
        "thumbnail": info.get("thumbnail") or "",
        "description": (info.get("description") or "")[:500],
        "uploader": info.get("uploader") or info.get("channel") or "",
        "extractor": info.get("extractor_key") or "",
        "formats": formats,
        "is_playlist": is_playlist,
        "playlist_count": playlist_count,
    }


def _format_selector(quality: str) -> str:
    if quality == "worst":
        return "wv*+wa/w"
    height = QUALITY_MAP.get(quality)
    if height:
        return (
            f"bv*[height<={height}]+ba/"
            f"b[height<={height}]/"
            f"bv*+ba/b"
        )
    return "bv*+ba/b"


def download(
    url: str,
    outdir: Path,
    quality: str = "best",
    audio_only: bool = False,
    cookies: str = "",
    cookies_from_browser: str = "",
    progress_cb: Optional[Callable[[Dict[str, Any]], None]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> List[Path]:
    """Download a video into ``outdir`` and return the produced files."""
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    def hook(status: Dict[str, Any]) -> None:
        if cancel_check and cancel_check():
            raise yt_dlp.utils.DownloadCancelled("cancelled by user")
        if progress_cb:
            progress_cb(status)

    opts = _base_opts(cookies, cookies_from_browser)
    opts.update(
        {
            "outtmpl": {"default": str(outdir / "%(title).120B [%(id)s].%(ext)s")},
            "format": "bestaudio/best" if audio_only else _format_selector(quality),
            "merge_output_format": "mp4",
            "concurrent_fragment_downloads": 4,
            "overwrites": True,
            "continuedl": True,
            "progress_hooks": [hook],
            "postprocessor_hooks": [hook],
            "restrictfilenames": False,
        }
    )
    if audio_only:
        opts["postprocessors"] = [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ]

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])
    except yt_dlp.utils.DownloadCancelled as exc:
        raise YtdlpError("下载已取消") from exc
    except yt_dlp.utils.DownloadError as exc:
        raise YtdlpError(_clean_error(str(exc))) from exc

    files = [
        p
        for p in outdir.glob("*")
        if p.is_file() and not p.name.endswith(".part") and not p.name.endswith(".ytdl")
    ]
    if not files:
        raise YtdlpError("下载完成但没有找到输出文件")
    files.sort(key=lambda p: p.stat().st_size, reverse=True)
    return files


def _clean_error(message: str) -> str:
    """Turn yt-dlp's verbose errors into a single readable line."""
    message = message.replace("ERROR: ", "").strip()
    first_line = message.splitlines()[0] if message else "未知错误"
    return first_line[:500]
