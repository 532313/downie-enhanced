# Downie Enhanced

> 一个本地优先的视频下载器 + 视频分析工具链：Web 界面、FastAPI 后端、Chrome/Edge 扩展，以及可被 DeepSeek Harness / Codex 调用的 `downie_video_analyze` 工具。

这个仓库不是 SaaS，也不提供在线下载服务。它在你自己的电脑上运行，默认只监听 `127.0.0.1`，下载和转写都在本机完成。

> **只下载你有权访问和保存的内容。** 本项目不绕过 DRM，不提供破解或付费内容获取能力；请遵守目标网站的服务条款和当地法律。

---

## 目录

- [1. 项目包含什么](#1-项目包含什么)
- [2. 环境要求](#2-环境要求)
- [3. 快速开始（macOS）](#3-快速开始macos)
- [4. 快速开始（Linux）](#4-快速开始linux)
- [5. 手动部署（推荐给 agent）](#5-手动部署推荐给-agent)
- [6. 部署验证](#6-部署验证)
- [7. 目录结构](#7-目录结构)
- [8. 配置](#8-配置)
- [9. Web 界面与 API](#9-web-界面与-api)
- [10. 浏览器扩展](#10-浏览器扩展)
- [11. 视频分析插件](#11-视频分析插件)
- [12. 故障排除](#12-故障排除)
- [13. Agent 部署契约](#13-agent-部署契约)
- [14. 安全、隐私与限制](#14-安全隐私与限制)
- [15. License](#15-license)

---

## 1. 项目包含什么

| 模块 | 说明 |
| --- | --- |
| Web 下载器 | React 界面 + FastAPI 后端，粘贴链接、解析、选画质、下载、查看进度和文件 |
| 下载引擎 | `yt-dlp` + `ffmpeg`，支持 HLS/DASH、音视频合并、音频提取、Cookie |
| 浏览器扩展 | Chrome/Edge 111+，右键菜单、快捷键、页面媒体检测、Cookie 转发 |
| 视频分析插件 | `plugins/downie-video-analyzer/`，下载视频后优先取字幕，否则用本地 `whisper.cpp` 转写，抽关键帧，写分析资料，然后删除源视频 |
| DSH 集成 | 在 DeepSeek Harness 中注册 Host 工具 `downie_video_analyze` |
| Codex 集成 | 同一套 pipeline 通过 stdio MCP 暴露给 Codex |

视频分析插件最终只保留：

```text
.downie-video/<videoId>-<标题>/
├── transcript.md
├── analysis.md
├── meta.json
└── frames/            # 可选关键帧
```

源视频、音频、字幕、临时文件和模型下载缓存不会提交到 Git。

---

## 2. 环境要求

### 必需

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Python | 3.10+，建议 3.12 | 后端与插件脚本 |
| Node.js / npm | Node 18+，建议 20/22 LTS | 构建 React 前端 |
| FFmpeg / ffprobe | 6+ | yt-dlp 合并、音频提取、抽帧 |
| Git | 任意较新版本 | 克隆和更新 |

### 可选

| 依赖 | 用途 |
| --- | --- |
| `whisper-cli`（whisper.cpp） | 视频没有可用字幕时做本地语音转写 |
| Chrome / Edge 111+ | 浏览器扩展 |
| DeepSeek Harness | 安装 DSH Host 插件 |
| Codex CLI | 通过 MCP 调用视频分析工具 |

首次 whisper 转写会自动下载 `ggml-base.bin`（约 148 MB）到 `.downie-video/models/`。如果机器不能访问 Hugging Face，也可以提前把模型放到该路径，或设置 `WHISPER_MODEL_PATH`。

### 支持的系统

- **macOS**：已验证。
- **Linux**：支持，`run-local.sh` 会自动改用 `xdg-open`。
- **Windows**：不支持原生运行；请使用 WSL2，并按 Linux 步骤部署。
- **Docker**：旧版 `docker-compose.yml` 已移除，本仓库不支持 Docker 部署。

---

## 3. 快速开始（macOS）

```bash
# 1. 安装基础依赖（已安装可跳过）
brew install python@3.12 node ffmpeg

# 2. 克隆
git clone https://github.com/532313/downie-enhanced.git
cd downie-enhanced

# 3. 一键启动（首次会创建 .venv、安装依赖、构建前端）
./run-local.sh

# 4. 打开
open http://127.0.0.1:8000
```

常用命令：

```bash
./run-local.sh status      # 查看状态
./run-local.sh logs        # 实时日志
./run-local.sh stop        # 停止
./run-local.sh restart     # 重启
./run-local.sh rebuild     # 重新构建前端
./run-local.sh --port 8010 # 换端口
./run-local.sh --lan       # 监听 0.0.0.0，供同一 Wi-Fi 的设备访问
./run-local.sh --no-open   # 不自动打开浏览器（agent/CI 推荐）
```

> `--lan` 没有登录鉴权，只建议在可信局域网中临时使用。

可选安装 whisper.cpp：

```bash
brew install whisper-cpp
```

如果 Homebrew 没有该 formula，也可以从 <https://github.com/ggerganov/whisper.cpp> 自行编译，然后在插件配置或 `WHISPER_BIN` 中指定 `whisper-cli` 的绝对路径。

---

## 4. 快速开始（Linux）

以 Debian/Ubuntu 为例：

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip nodejs npm ffmpeg git

git clone https://github.com/532313/downie-enhanced.git
cd downie-enhanced

./run-local.sh --no-open
```

然后访问 <http://127.0.0.1:8000>，或用：

```bash
curl -fsS http://127.0.0.1:8000/api/health
```

Linux 上如果没有桌面环境，`run-local.sh --no-open` 不会尝试打开浏览器。

---

## 5. 手动部署（推荐给 agent）

如果不想用 `run-local.sh`，或者需要在没有 `open`/`lsof` 的环境里部署，按下面执行。所有命令都在仓库根目录运行。

```bash
export PROJECT_ROOT="$PWD"

# 1. Python 虚拟环境
python3.12 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r backend/requirements.txt

# 2. 构建前端
cd frontend
npm ci
PUBLIC_URL=/ REACT_APP_API_URL=/api CI=false npm run build
cd ..

# 3. 启动后端（同时托管 frontend/build）
cd backend
../.venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

说明：

- 必须使用 `PUBLIC_URL=/ REACT_APP_API_URL=/api` 构建，否则前端可能进入 Demo 模式或请求错误的 API 地址。
- `frontend/build/` 是生成物，不提交到 Git；新机器必须构建一次。
- `backend/downloads/` 会自动创建，已被 `.gitignore` 忽略。
- 如果 `python3.12` 不存在，用 `python3`，但建议 3.10+。
- 本项目已在 Node 24.21 上验证构建；如果 `npm ci` 因旧依赖报错，可改用 Node 20/22 LTS 后重试。

### 后台运行（agent 常用）

```bash
mkdir -p "$PROJECT_ROOT/.run"
cd "$PROJECT_ROOT/backend"
nohup ../.venv/bin/python -m uvicorn main:app \
  --host 127.0.0.1 --port 8000 \
  > "$PROJECT_ROOT/.run/downie.log" 2>&1 &
echo $! > "$PROJECT_ROOT/.run/downie.pid"
```

或者直接用：

```bash
./run-local.sh --no-open
```

---

## 6. 部署验证

### 6.1 健康检查

```bash
curl -fsS http://127.0.0.1:8000/api/health | python3 -m json.tool
```

期望包含：

```json
{
  "status": "healthy",
  "version": "1.0.0",
  "ffmpeg": "/opt/homebrew/bin/ffmpeg",
  "download_dir": ".../backend/downloads"
}
```

`ffmpeg` 为 `null` 说明没找到 ffmpeg，先安装并确保它在 `PATH` 中。

### 6.2 文档和前端

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/api/docs
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/
```

两个都应为 `200`。

### 6.3 解析一个公开视频

```bash
curl -fsS -X POST http://127.0.0.1:8000/api/downloads/extract \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://download.samplelib.com/mp4/sample-5s.mp4","quality":"720p"}'
```

应返回 `title`、`duration`、`formats` 等字段。

### 6.4 实际下载

```bash
curl -fsS -X POST http://127.0.0.1:8000/api/downloads/add \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://download.samplelib.com/mp4/sample-5s.mp4","quality":"720p","auto_start":true}'
```

然后：

```bash
curl -fsS http://127.0.0.1:8000/api/downloads/tasks
ls -lh backend/downloads/
```

### 6.5 插件静态检查

```bash
node --check plugins/downie-video-analyzer/index.js
node --check plugins/downie-video-analyzer/mcp-server.js
node --check plugins/downie-video-analyzer/lib/standalone-context.js
node --test plugins/downie-video-analyzer/test/parsers.test.js
.venv/bin/python -m py_compile plugins/downie-video-analyzer/scripts/downie_fetch.py
```

---

## 7. 目录结构

```text
downie-enhanced/
├── run-local.sh                  # macOS/Linux 一键启动脚本
├── backend/
│   ├── main.py                   # FastAPI 入口，同时托管前端构建
│   ├── requirements.txt
│   ├── app/
│   │   ├── api/
│   │   │   ├── download_routes.py
│   │   │   └── enhanced_download_routes.py
│   │   └── core/
│   │       ├── ytdlp_service.py  # yt-dlp 解析/下载
│   │       ├── download_manager.py
│   │       └── ffmpeg_processor.py
│   └── downloads/                # 运行时生成，不提交
├── frontend/
│   ├── src/SimpleApp.tsx         # 主界面
│   ├── public/
│   ├── package.json
│   └── build/                    # 构建生成，不提交
├── browser-extension/            # Chrome/Edge MV3 扩展
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── injected.js
│   ├── popup.html / popup.js
│   └── images/
├── plugins/downie-video-analyzer/ # DSH 插件 + Codex MCP
│   ├── index.js
│   ├── mcp-server.js
│   ├── lib/
│   ├── scripts/downie_fetch.py
│   └── test/parsers.test.js
├── docs/
│   ├── API.md
│   └── INSTALLATION.md
├── AGENTS.md                     # 给自动 agent 的部署契约
└── README.md
```

不提交的内容：`.venv/`、`frontend/node_modules/`、`frontend/build/`、`backend/downloads/`、`.downie-video/`、`.run/`、`__pycache__/`、`.env*`、模型缓存。

---

## 8. 配置

### 8.1 启动参数

```bash
./run-local.sh --port 8010
./run-local.sh --host 0.0.0.0
./run-local.sh --lan
./run-local.sh --no-open
```

`run-local.sh` 会：

- 在仓库根目录创建 `.venv`；
- 安装 `backend/requirements.txt`；
- 在 `frontend/` 执行 `npm ci`（首次）和 `npm run build`；
- 用 uvicorn 启动 `main:app`，默认 `127.0.0.1:8000`。

### 8.2 前端构建变量

| 变量 | 推荐值 | 说明 |
| --- | --- | --- |
| `PUBLIC_URL` | `/` | 由后端根路径托管 |
| `REACT_APP_API_URL` | `/api` | 同源 API，避免 CORS 和 Demo 模式 |
| `CI` | `false` | 避免把 ESLint warning 当构建失败 |

### 8.3 插件配置

DSH 插件行配置（`cordis.patch.yml` 的 `config`）支持：

| 键 | 默认值 |
| --- | --- |
| `downieRoot` | 自动查找包含 `backend/app/core/ytdlp_service.py` 的目录 |
| `outputDir` | `<当前工作目录>/.downie-video` |
| `quality` | `720p` |
| `language` | `auto` |
| `keepFrames` | `true` |
| `maxFrames` | `12`（0–24） |
| `cookiesFromBrowser` | `""` |
| `whisperBin` | `/opt/homebrew/bin/whisper-cli` |
| `whisperModel` | `base` |
| `modelPath` | `""` |

Codex MCP 使用环境变量配置，见 [第 11 节](#11-视频分析插件)。

---

## 9. Web 界面与 API

### 使用

1. 打开 <http://127.0.0.1:8000>。
2. 粘贴视频链接，点「解析视频」。
3. 选择画质、是否需要 Cookie、是否仅音频。
4. 点「开始下载」，任务卡片显示进度、速度、ETA。
5. 完成后可在页面下载，文件也会落在 `backend/downloads/`。

需要登录/风控的站点（YouTube 风控、B 站会员清晰度等）可在「高级选项」里选择读取浏览器 Cookie。macOS 首次读取浏览器 Cookie 时，系统可能要求给终端「完全磁盘访问权限」。

### 主要 API

完整、可交互的文档：<http://127.0.0.1:8000/api/docs>

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查、ffmpeg、下载目录 |
| `GET` | `/api/stats` | 任务/站点统计 |
| `POST` | `/api/analyze` | 解析 URL 元数据 |
| `POST` | `/api/downloads/extract` | 解析并返回格式列表 |
| `POST` | `/api/downloads/add` | 创建下载任务（默认自动开始） |
| `POST` | `/api/downloads/start/{id}` | 启动任务 |
| `POST` | `/api/downloads/cancel/{id}` | 取消任务 |
| `GET` | `/api/downloads/tasks` | 所有任务 |
| `GET` | `/api/downloads/tasks/{id}` | 单任务状态 |
| `GET` | `/api/downloads/files` | 已下载文件列表 |
| `GET` | `/api/downloads/files/{name}` | 下载文件 |
| `GET` | `/api/downloads/qualities` | 画质枚举 |
| `GET` | `/api/downloads/supported-sites` | 站点列表 |
| `WS` | `/api/downloads/ws` | 实时进度 |

`quality` 取值：`auto`、`best`、`worst`、`1080p`、`720p`、`480p`、`360p`。
`post_processing` 取值：`none`、`audio`、`mp4`、`permute`。

---

## 10. 浏览器扩展

1. 先启动后端：`./run-local.sh`。
2. 打开 `chrome://extensions`。
3. 打开右上角「开发者模式」。
4. 点「加载已解压的扩展程序」，选择仓库里的 `browser-extension/` 目录。
5. 固定图标到工具栏。

功能：

- 工具栏弹窗：服务状态、当前页 URL、画质选择、下载；
- 右键菜单：当前页 / 链接 / `<video>` / 720p / Audio Only；
- `⌘⇧Y`（Windows/Linux `Ctrl+Shift+Y`）：下载当前标签页；
- 页面媒体检测：`fetch`/XHR、`<video>`、Resource Timing；
- Cookie：只发送给本机 `127.0.0.1:8000`，不经过第三方。

如果后端不是 8000 端口，在扩展的 Service Worker 控制台执行：

```js
chrome.storage.local.set({ apiBase: 'http://127.0.0.1:9000/api' });
```

详见 [browser-extension/README.md](./browser-extension/README.md)。

---

## 11. 视频分析插件

插件目录：`plugins/downie-video-analyzer/`。它做四件事：

1. 用本仓库的 yt-dlp 引擎下载视频，优先取站点字幕；
2. 没有字幕或字幕太短时，用本地 `whisper.cpp` 转写；
3. 按时间均匀抽关键帧；
4. 写 `transcript.md`、`analysis.md`、`meta.json`，然后删除视频/音频/字幕/临时文件。

### 11.1 安装到 DeepSeek Harness

在 Harness 中执行（把路径换成你克隆后的绝对路径）：

```text
plugin_manager action=install_bundle target="$PROJECT_ROOT/plugins/downie-video-analyzer"
```

例如：

```text
plugin_manager action=install_bundle target="/Users/you/code/downie-enhanced/plugins/downie-video-analyzer"
```

安装后 Harness 会注册 Host 工具 `downie_video_analyze`，并注入一段中文系统提示词。若提示需要重启，重启 Harness 后再用。

### 11.2 注册到 Codex（MCP）

先确保 `node`、`ffmpeg` 可用，然后在仓库根目录执行：

```bash
codex mcp add downie-video-analyzer \
  --env DOWNIE_ROOT="$PWD" \
  --env DOWNIE_VIDEO_OUTPUT_DIR="$PWD/.downie-video" \
  --env DOWNIE_VIDEO_LANGUAGE=auto \
  -- "$(command -v node)" "$PWD/plugins/downie-video-analyzer/mcp-server.js"
```

检查：

```bash
codex mcp list
codex mcp get downie-video-analyzer
```

然后重启 Codex，或新开一个 Codex 会话。之后可以直接说：

```text
用 downie_video_analyze 分析这个视频：https://www.bilibili.com/video/BV...
```

Codex 会看到 `downie_video_analyze`，参数与 Harness 中一致：

```text
downie_video_analyze(
  url,
  quality?,
  language?,
  cookies_from_browser?,
  keep_frames?,
  max_frames?,
  force_transcribe?
)
```

工具只返回摘要和文件路径，不会把完整转写塞进上下文；模型再读取 `transcript.md`、按需查看关键帧，补全 `analysis.md` 并回答。

### 11.3 Codex MCP 环境变量

| 变量 | 默认/说明 |
| --- | --- |
| `DOWNIE_ROOT` | 本仓库根目录 |
| `DOWNIE_VIDEO_OUTPUT_DIR` | 默认 `<cwd>/.downie-video` |
| `DOWNIE_VIDEO_QUALITY` | 默认 `720p` |
| `DOWNIE_VIDEO_LANGUAGE` | 默认 `auto` |
| `DOWNIE_VIDEO_COOKIES_FROM_BROWSER` | 如 `chrome`、`safari` |
| `DOWNIE_VIDEO_KEEP_FRAMES` | `true` / `false` |
| `DOWNIE_VIDEO_MAX_FRAMES` | 默认 `12`，范围 0–24 |
| `WHISPER_BIN` | `whisper-cli` 绝对路径；Linux 必改 |
| `WHISPER_MODEL` | 默认 `base` |
| `WHISPER_MODEL_PATH` | 显式模型路径，优先于自动下载 |
| `DOWNIE_VIDEO_CWD` | 覆盖 MCP 进程工作目录 |

### 11.4 whisper 依赖

- macOS 默认查找 `/opt/homebrew/bin/whisper-cli`、`/usr/local/bin/whisper-cli`。
- Linux 通常需要设置 `WHISPER_BIN`，例如 `export WHISPER_BIN=/opt/whisper.cpp/build/bin/whisper-cli`。
- 首次转写会下载 `ggml-base.bin` 到 `.downie-video/models/`；也可以提前放置模型并设置 `WHISPER_MODEL_PATH`。
- 没有 `whisper-cli` 或没有音轨时，转写会降级为 `none`，但下载/抽帧/清理仍会完成。

### 11.5 产物与清理

```text
.downie-video/
├── index.json
├── models/ggml-base.bin
├── .tmp/                     # 每次运行后清理
└── <videoId>-<标题>/
    ├── transcript.md
    ├── analysis.md
    ├── meta.json
    └── frames/
```

清理规则：

- 分析完成后删除下载的视频、音频、字幕、提取的 wav 和临时目录；
- 扫描最终目录，确认没有媒体/字幕扩展名残留；
- 只有确认清理干净才返回 `sourceDeleted: true`，否则返回 `false` 并给出残留路径；
- 失败、超时、取消也会执行清理。

---

## 12. 故障排除

| 现象 | 处理 |
| --- | --- |
| `./run-local.sh: Permission denied` | `chmod +x run-local.sh` |
| 端口 8000 被占用 | `./run-local.sh --port 8010` |
| `ffmpeg: null` / 合并失败 | 安装 ffmpeg：macOS `brew install ffmpeg`；Linux `sudo apt install ffmpeg`；确保在 `PATH` |
| 前端打开是 Demo Mode | 构建时没设置 `REACT_APP_API_URL=/api`；重新执行 `PUBLIC_URL=/ REACT_APP_API_URL=/api CI=false npm run build` |
| `npm ci` 失败 | 确认 Node 18+；尝试 Node 20 LTS；必要时 `npm ci --legacy-peer-deps` |
| Node 24 构建报 OpenSSL 错误 | `export NODE_OPTIONS=--openssl-legacy-provider` 后重试，或改用 Node 20 |
| YouTube 提示 bot/登录 | 在网页「高级选项」读取浏览器 Cookie；macOS 给终端完全磁盘访问权限 |
| B 站只有低清晰度 | 登录 B 站并读取 Cookie；会员清晰度仍取决于账号权限 |
| 插件报找不到 downieRoot | 把插件安装在仓库内，或在插件配置里显式设置 `downieRoot` 为仓库绝对路径 |
| Codex 看不到 `downie_video_analyze` | 重启 Codex/新开会话；`codex mcp list` 确认 enabled；检查 `node` 和 `mcp-server.js` 路径；查看 Codex MCP 日志 |
| whisper 模型下载失败 | 设置 `WHISPER_MODEL_PATH` 指向已有 `ggml-*.bin`；不要把模型提交到 Git |
| 分析后仍残留视频 | 看工具返回的 `sourceDeleted` / `warnings`；确认没有进程占用文件；插件目录 `.downie-video/.tmp/` 可手动清理 |

---

## 13. Agent 部署契约

如果你是一个自动 agent，按下面执行即可，不需要浏览器：

```bash
git clone https://github.com/532313/downie-enhanced.git
cd downie-enhanced

python3.12 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt

cd frontend
npm ci
PUBLIC_URL=/ REACT_APP_API_URL=/api CI=false npm run build
cd ..

mkdir -p .run
cd backend
nohup ../.venv/bin/python -m uvicorn main:app \
  --host 127.0.0.1 --port 8000 \
  > ../.run/downie.log 2>&1 &
echo $! > ../.run/downie.pid

sleep 2
curl -fsS http://127.0.0.1:8000/api/health
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/api/docs
```

验收：

- `/api/health` 返回 `status: healthy`；
- `/api/docs` 返回 200；
- `frontend/build/index.html` 存在；
- `backend/downloads/` 可写；
- 可选：按第 6.4 节下载一个测试视频。

约束：

- 不要运行 `docker/`（本仓库已不包含 Docker 部署）；
- 不要提交 `.venv/`、`node_modules/`、`frontend/build/`、`backend/downloads/`、`.downie-video/`；
- 服务默认只监听 `127.0.0.1`，不要无意暴露到公网；
- 不要用 `--lan` 在不可信网络运行。

更简版本见 [AGENTS.md](./AGENTS.md)。

---

## 14. 安全、隐私与限制

- 服务没有登录鉴权，默认只监听 `127.0.0.1`；不要直接暴露到公网。
- 浏览器 Cookie 只发送给本机后端，但后端会用 Cookie 访问目标站点；请只在你信任的机器上使用。
- 不支持 DRM、付费墙绕过、私有视频破解。
- `yt-dlp` 支持范围随版本变化；某些站点需要更新 `yt-dlp` 或配置 Cookie/代理。
- whisper 转写质量取决于模型和音质；专有名词、数字、方言可能识别错误。
- 关键帧是均匀采样，不替代完整视频理解；模型看不到图片时只能基于转写回答。
- 下载和转写可能消耗大量磁盘、CPU 和网络；长视频首次转写会下载模型。

---

## 15. License

MIT，见 [LICENSE](./LICENSE)。

本项目受 Downie 4 的产品设计启发，但与 Charlie Monroe Software 无隶属关系；Downie 4 是其各自的商标/产品。
