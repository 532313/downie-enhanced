# Downie 视频分析器（downie-video-analyzer）

一个 DeepSeek Harness Host 插件，同时提供一个 Codex 可调用的 MCP 服务：把视频链接交给它，它会调用本项目（Downie Enhanced）的 yt-dlp 引擎下载视频，优先取站点字幕，没有字幕时用本地 `whisper.cpp` 转写，按间隔采样关键帧，写出可复用的 `transcript.md` / `analysis.md` / `meta.json`，最后删除视频、音频、字幕和临时文件。

安装后，聊天模型会获得 `downie_video_analyze` 工具；随后按模型提示词读取保留的分析资料来回答追问，不会重新下载视频。

## 依赖

- 本项目的 Python 虚拟环境：`.venv/bin/python`，其中已安装 `yt-dlp`。
- `ffmpeg` / `ffprobe`：默认查找 `/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`。
- 可选 `whisper-cli`：默认查找 `/opt/homebrew/bin/whisper-cli`、`/usr/local/bin/whisper-cli`。Linux 上请通过 `WHISPER_BIN` 指定实际路径。首次转写会自动下载 `ggml-base.bin`（约 148 MB）到 `.downie-video/models/`，之后复用。
- 项目必须是包含 `backend/app/core/ytdlp_service.py` 的 Downie Enhanced 仓库；插件会自动从当前会话目录向上查找，也会尝试从插件自身位置推断。

## 安装

在 Harness 中调用：

```text
plugin_manager action=install_bundle target=/absolute/path/to/downie-enhanced/plugins/downie-video-analyzer
```

安装会实时生效；如果 Harness 提示需要重启，重启后再使用。插件只注册 Host 工具和一段系统提示词，没有客户端 UI 代码。

## 在 Codex 中使用

同一套分析流程也通过 stdio MCP 暴露给 Codex，不需要 DSH 处于运行状态。插件目录里已经包含 `mcp-server.js`，它直接复用 `lib/pipeline.js`。

在终端注册一次：

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

注册后重启 Codex，或新开一个 Codex 会话。之后直接说：

```text
用 downie_video_analyze 分析这个视频：https://www.bilibili.com/video/BV...
```

Codex 会看到 `downie_video_analyze` 工具，参数与 Harness 中一致。工具返回的是摘要和路径，Codex 再读取 `transcript.md`、按需查看关键帧，补全 `analysis.md` 并回答。

MCP 服务支持的环境变量：

| 变量 | 说明 |
| --- | --- |
| `DOWNIE_ROOT` | Downie Enhanced 仓库根目录 |
| `DOWNIE_VIDEO_OUTPUT_DIR` | 产物目录，默认 `<cwd>/.downie-video` |
| `DOWNIE_VIDEO_QUALITY` | 默认 `720p` |
| `DOWNIE_VIDEO_LANGUAGE` | 默认 `auto` |
| `DOWNIE_VIDEO_COOKIES_FROM_BROWSER` | 需要登录/风控的站点可填 `chrome`、`safari` 等 |
| `DOWNIE_VIDEO_KEEP_FRAMES` | `true` / `false` |
| `DOWNIE_VIDEO_MAX_FRAMES` | 默认 `12`，范围 0–24 |
| `WHISPER_BIN` | 默认 `/opt/homebrew/bin/whisper-cli` |
| `WHISPER_MODEL` | 默认 `base` |
| `WHISPER_MODEL_PATH` | 显式模型路径，优先于自动下载 |
| `DOWNIE_VIDEO_CWD` | 覆盖 MCP 进程的工作目录 |

注意：Codex 需要能启动本机 `node`，并允许它执行 `ffmpeg` / `whisper-cli`、访问网络和写入输出目录。如果 Codex 的沙箱限制过严，请在 Codex 设置里允许网络和工作区写入。

## 使用

直接把视频链接发给模型，并说明你想了解什么，例如：

```text
https://www.bilibili.com/video/BV... 帮我看看这个视频讲了什么，重点整理一下。
```

模型会调用：

```text
downie_video_analyze(url, quality?, language?, cookies_from_browser?, keep_frames?, max_frames?, force_transcribe?)
```

工具只返回摘要和文件路径，不会把完整转写塞进上下文。模型再读取 `transcript.md`、按需查看关键帧，补全 `analysis.md` 并回答。

## 产物

默认目录：`<会话工作目录>/.downie-video/`（已加入 `.gitignore`）。

```text
.downie-video/
├── index.json
├── models/ggml-base.bin          # 首次 whisper 转写后缓存
├── .tmp/                         # 每次运行结束后清理
└── <videoId>-<标题>/
    ├── meta.json
    ├── transcript.md             # 带 [HH:MM:SS] 的完整转写
    ├── analysis.md               # 骨架，模型回答前补全
    └── frames/                   # 可选关键帧 JPEG
```

`index.json` 记录已分析视频，后续追问同一个视频时按它找到资料，不重复下载。

## 清理规则

工具的 `finally` 分支会：

1. 删除本次下载的临时目录（包含视频、音频、提取的 wav、字幕）。
2. 扫描分析目录，删除任何残留媒体/字幕扩展名文件（`.mp4`、`.webm`、`.mkv`、`.m4a`、`.mp3`、`.wav`、`.vtt`、`.srt` 等）。
3. 只有确认没有残留时才返回 `sourceDeleted: true`；否则返回 `false`，并在 `warnings` 里给出残留路径。
4. 失败、超时或用户取消时同样执行清理。

## 配置

插件行 `config` 可覆盖以下默认值（不设置也能用）：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `downieRoot` | 自动查找 | Downie Enhanced 仓库根目录 |
| `outputDir` | `<cwd>/.downie-video` | 产物目录 |
| `quality` | `720p` | `360p` / `480p` / `720p` / `1080p` / `best` / `worst` |
| `language` | `auto` | 转写语言提示，如 `zh`、`en` |
| `keepFrames` | `true` | 是否保留关键帧 |
| `maxFrames` | `12` | 最多关键帧数（0–24） |
| `cookiesFromBrowser` | `""` | 需要登录/风控的站点可填 `chrome`、`safari` 等 |
| `whisperBin` | `/opt/homebrew/bin/whisper-cli` | whisper.cpp 可执行文件 |
| `whisperModel` | `base` | 模型名，或直接给 `.bin` 路径 |
| `modelPath` | `""` | 显式模型路径，优先于自动下载 |

## 限制

- 不处理 DRM；受版权保护或需要登录的视频请使用你有权访问的链接，并自行确认使用条款。
- 站点字幕质量参差；自动字幕会做滚动去重，但仍可能有错字。
- 关键帧只是均匀采样，不替代完整视觉理解；当前模型看不到图片时只能依据转写分析。
- 首次 whisper 转写需要下载模型；长视频转写可能较慢，工具超时为 60 分钟。
- 下载受 yt-dlp 支持范围限制；失败时错误会以中文返回，并已清理临时文件。

## 开发检查

```bash
node --check index.js
node --check mcp-server.js
node --check lib/standalone-context.js
node --test test/parsers.test.js
.venv/bin/python -m py_compile plugins/downie-video-analyzer/scripts/downie_fetch.py
```
