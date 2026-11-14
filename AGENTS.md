# Agent Deployment Contract

This file is for automated coding agents. The canonical human guide is `README.md`.

## What this repository is

- A local-only video downloader: React UI + FastAPI + yt-dlp + FFmpeg.
- A Chrome/Edge MV3 extension in `browser-extension/`.
- A video analysis plugin in `plugins/downie-video-analyzer/`, exposed as:
  - a DeepSeek Harness Host tool (`downie_video_analyze`), and
  - a Codex stdio MCP server (`mcp-server.js`).

It is **not** a hosted service. Do not expose it to the public internet.

## Supported deployment

Use the native macOS/Linux path. Docker is not supported; there is no working Dockerfile in this repository.

### 1. Install

```bash
git clone https://github.com/532313/downie-enhanced.git
cd downie-enhanced
```

Requirements: Python 3.10+ (3.12 recommended), Node 18+ (20/22 LTS recommended), `ffmpeg`/`ffprobe`, Git.

### 2. Backend

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r backend/requirements.txt
```

### 3. Frontend

```bash
cd frontend
npm ci
PUBLIC_URL=/ REACT_APP_API_URL=/api CI=false npm run build
cd ..
```

The build output must be `frontend/build/index.html`. `frontend/build/` is gitignored and must be generated on every fresh machine.

### 4. Run

Preferred:

```bash
chmod +x run-local.sh
./run-local.sh --no-open
```

Or manually:

```bash
cd backend
../.venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

### 5. Verify

```bash
curl -fsS http://127.0.0.1:8000/api/health
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/api/docs
```

Acceptance:

- `/api/health` returns `"status": "healthy"`.
- `/api/docs` returns HTTP 200.
- `/` serves the built UI.
- `backend/downloads/` is writable.

Optional real download:

```bash
curl -fsS -X POST http://127.0.0.1:8000/api/downloads/add \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://download.samplelib.com/mp4/sample-5s.mp4","quality":"720p","auto_start":true}'
```

## Plugin / MCP

DSH install (Harness tool call, not shell):

```text
plugin_manager action=install_bundle target="<absolute path to this repo>/plugins/downie-video-analyzer"
```

Codex registration (run from the repo root):

```bash
codex mcp add downie-video-analyzer \
  --env DOWNIE_ROOT="$PWD" \
  --env DOWNIE_VIDEO_OUTPUT_DIR="$PWD/.downie-video" \
  --env DOWNIE_VIDEO_LANGUAGE=auto \
  -- "$(command -v node)" "$PWD/plugins/downie-video-analyzer/mcp-server.js"
```

Check:

```bash
codex mcp list
codex mcp get downie-video-analyzer
```

Restart Codex or open a new session before expecting the tool to appear.

## Do not commit

- `.venv/`
- `frontend/node_modules/`
- `frontend/build/`
- `backend/downloads/`
- `.downie-video/` (transcripts, analysis, frames, `ggml-*.bin`)
- `.run/`, `.env*`, `__pycache__/`, logs
- downloaded videos/audio/subtitles

## Do not

- Do not run or restore the legacy Docker Compose setup.
- Do not force-push or rewrite remote history.
- Do not bind the service to `0.0.0.0` unless the user explicitly asks for LAN access.
- Do not claim whisper transcription works without `whisper-cli` and a model; the pipeline degrades to an empty transcript instead.
- Do not claim visual understanding when the model cannot read images.

## Troubleshooting quick reference

- `ffmpeg: null` in health: install FFmpeg and ensure it is on `PATH`.
- Demo Mode UI: rebuild with `REACT_APP_API_URL=/api`.
- Codex tool missing: check `codex mcp list`, restart Codex, verify absolute `node` and `mcp-server.js` paths.
- `downieRoot` not found: set the plugin config `downieRoot` to the absolute repo path.
- whisper model download blocked: set `WHISPER_MODEL_PATH` to an existing `ggml-*.bin`.
- Port busy: use `./run-local.sh --port 8010`.
