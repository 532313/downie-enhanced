#!/usr/bin/env python3
"""Download one video through the Downie Enhanced yt-dlp engine.

This adapter deliberately imports the project's own ytdlp_service helpers so the
plugin and the web app share the same format selection and ffmpeg discovery.
It prints exactly one JSON object on stdout; diagnostics go to stderr.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

VIDEO_EXTENSIONS = {
    ".mp4",
    ".m4v",
    ".mkv",
    ".webm",
    ".mov",
    ".avi",
    ".flv",
    ".ts",
    ".m4a",
    ".mp3",
    ".aac",
    ".opus",
    ".ogg",
    ".flac",
    ".wav",
}
SUBTITLE_EXTENSIONS = {".vtt", ".srt"}

FALLBACK_QUALITY_MAP = {
    "auto": None,
    "best": None,
    "worst": "worst",
    "1080p": 1080,
    "720p": 720,
    "480p": 480,
    "360p": 360,
}


def emit(payload: Dict[str, Any], code: int = 0) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    raise SystemExit(code)


def clean_error(message: str) -> str:
    text = (message or "").replace("ERROR:", "").strip()
    first_line = text.splitlines()[0] if text else "未知错误"
    return first_line[:500]


def fallback_base_opts(cookies: str, cookies_from_browser: str) -> Dict[str, Any]:
    opts: Dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "socket_timeout": 30,
        "retries": 3,
        "fragment_retries": 3,
        "nocheckcertificate": True,
        "http_headers": {
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
            )
        },
    }
    ffmpeg = (
        shutil.which("ffmpeg")
        or next(
            (
                candidate
                for candidate in (
                    "/opt/homebrew/bin/ffmpeg",
                    "/usr/local/bin/ffmpeg",
                    "/usr/bin/ffmpeg",
                )
                if Path(candidate).exists()
            ),
            None,
        )
    )
    if ffmpeg:
        opts["ffmpeg_location"] = ffmpeg
    if cookies:
        opts["http_headers"]["Cookie"] = cookies
    if cookies_from_browser:
        opts["cookiesfrombrowser"] = (cookies_from_browser, None, None, None)
    return opts


def fallback_selector(quality: str) -> str:
    if quality == "worst":
        return "wv*+wa/w"
    height = FALLBACK_QUALITY_MAP.get(quality)
    if height:
        return f"bv*[height<={height}]+ba/b[height<={height}]/bv*+ba/b"
    return "bv*+ba/b"


def load_engine(root: Optional[Path]) -> Dict[str, Any]:
    engine: Dict[str, Any] = {
        "name": "yt-dlp",
        "base_opts": fallback_base_opts,
        "selector": fallback_selector,
        "warnings": [],
    }
    if root:
        backend = root / "backend"
        if backend.is_dir():
            sys.path.insert(0, str(backend))
    try:
        from app.core import ytdlp_service  # type: ignore

        engine["name"] = "downie-enhanced"
        engine["base_opts"] = ytdlp_service._base_opts
        engine["selector"] = ytdlp_service._format_selector
    except Exception as exc:  # noqa: BLE001 - fallback is intentional
        engine["warnings"].append(f"未能加载 Downie 引擎，改用 yt-dlp 默认配置：{clean_error(str(exc))}")
    return engine


def subtitle_language(path: Path) -> str:
    parts = path.name.split(".")
    if len(parts) >= 3:
        return parts[-2]
    return "unknown"


def build_opts(
    engine: Dict[str, Any],
    outdir: Path,
    quality: str,
    cookies: str,
    cookies_from_browser: str,
    with_subtitles: bool,
) -> Dict[str, Any]:
    opts = engine["base_opts"](cookies, cookies_from_browser)
    opts.update(
        {
            "outtmpl": {"default": str(outdir / "%(title).120B [%(id)s].%(ext)s")},
            "format": engine["selector"](quality),
            "merge_output_format": "mp4",
            "noplaylist": True,
            "overwrites": True,
            "continuedl": True,
            "concurrent_fragment_downloads": 4,
            "noprogress": True,
            "restrictfilenames": False,
        }
    )
    if with_subtitles:
        opts.update(
            {
                "writesubtitles": True,
                "writeautomaticsub": True,
                "subtitleslangs": ["zh-Hans", "zh-CN", "zh", "en"],
                "subtitlesformat": "vtt",
            }
        )
    return opts


def detect_subtitles(info: Dict[str, Any], outdir: Path) -> List[Dict[str, Any]]:
    manual = info.get("subtitles") or {}
    automatic = info.get("automatic_captions") or {}
    subtitles: List[Dict[str, Any]] = []
    for path in sorted(outdir.iterdir()):
        if not path.is_file() or path.suffix.lower() not in SUBTITLE_EXTENSIONS:
            continue
        lang = subtitle_language(path)
        subtitles.append(
            {
                "path": str(path.resolve()),
                "lang": lang,
                "auto": lang in automatic and lang not in manual,
                "manual": lang in manual,
                "size": path.stat().st_size,
            }
        )
    subtitles.sort(key=lambda item: (not item["manual"], item["lang"] not in ("zh-Hans", "zh-CN", "zh", "en")))
    return subtitles


def detect_media(outdir: Path) -> List[Dict[str, Any]]:
    media: List[Dict[str, Any]] = []
    for path in outdir.iterdir():
        if not path.is_file() or path.suffix.lower() not in VIDEO_EXTENSIONS:
            continue
        media.append(
            {
                "path": str(path.resolve()),
                "ext": path.suffix.lower(),
                "size": path.stat().st_size,
            }
        )
    media.sort(key=lambda item: item["size"], reverse=True)
    return media


def normalize_quality(value: str) -> str:
    return value if value in FALLBACK_QUALITY_MAP else "best"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--outdir", required=True)
    parser.add_argument("--quality", default="720p")
    parser.add_argument("--downie-root", default="")
    parser.add_argument("--cookies", default="")
    parser.add_argument("--cookies-from-browser", default="")
    parser.add_argument("--subtitles", action="store_true")
    args = parser.parse_args()

    outdir = Path(args.outdir).expanduser().resolve()
    outdir.mkdir(parents=True, exist_ok=True)
    root = Path(args.downie_root).expanduser().resolve() if args.downie_root else None
    quality = normalize_quality(args.quality)
    engine = load_engine(root)

    try:
        import yt_dlp  # type: ignore
    except Exception as exc:  # noqa: BLE001
        emit(
            {
                "ok": False,
                "error": f"yt-dlp 不可用，请确认项目 .venv 已安装 yt-dlp：{clean_error(str(exc))}",
            },
            1,
        )
        return

    opts = build_opts(
        engine,
        outdir,
        quality,
        args.cookies,
        args.cookies_from_browser,
        args.subtitles,
    )

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(args.url, download=True)
    except yt_dlp.utils.DownloadError as exc:  # type: ignore[attr-defined]
        emit({"ok": False, "error": clean_error(str(exc))}, 1)
        return
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "error": f"{type(exc).__name__}: {clean_error(str(exc))}"}, 1)
        return

    if not info:
        emit({"ok": False, "error": "没有解析到任何视频信息。"}, 1)
        return
    if info.get("_type") == "playlist":
        entries = [entry for entry in (info.get("entries") or []) if entry]
        if not entries:
            emit({"ok": False, "error": "播放列表为空。"}, 1)
            return
        info = entries[0]

    media = detect_media(outdir)
    if not media:
        emit({"ok": False, "error": "下载结束但输出目录中没有媒体文件。"}, 1)
        return

    subtitles = detect_subtitles(info, outdir)
    chapters = [
        {
            "startSeconds": float(chapter.get("start_time") or 0),
            "title": str(chapter.get("title") or ""),
        }
        for chapter in (info.get("chapters") or [])
        if chapter
    ]
    warnings = list(engine.get("warnings") or [])
    if len(media) > 1:
        warnings.append(f"下载产生了 {len(media)} 个媒体文件，将分析最大的一个。")

    emit(
        {
            "ok": True,
            "engine": engine["name"],
            "id": str(info.get("id") or "video"),
            "title": info.get("title") or "未命名视频",
            "duration": float(info.get("duration") or 0),
            "uploader": info.get("uploader") or info.get("channel") or "",
            "webpage_url": info.get("webpage_url") or args.url,
            "extractor": info.get("extractor_key") or info.get("extractor") or "",
            "chapters": chapters,
            "media": media,
            "subtitles": subtitles,
            "warnings": warnings,
        }
    )


if __name__ == "__main__":
    main()
