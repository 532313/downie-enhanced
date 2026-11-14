# 安装与部署

本文件是 `README.md` 的部署摘要。**完整、随时更新的步骤以仓库根目录的 [README.md](../README.md) 为准。**

## 支持的环境

- macOS：已验证
- Linux：支持（`run-local.sh` 会自动使用 `xdg-open`）
- Windows：请使用 WSL2，按 Linux 方式部署
- Docker：不支持；仓库中不再包含可用的 Docker 配置

## 依赖

- Python 3.10+（建议 3.12）
- Node.js 18+（建议 20/22 LTS）
- FFmpeg 6+（需要 `ffmpeg` 和 `ffprobe`）
- Git

可选：

- `whisper-cli`（whisper.cpp），用于本地语音转写
- Chrome/Edge 111+，用于浏览器扩展

## 最快路径

```bash
git clone https://github.com/532313/downie-enhanced.git
cd downie-enhanced
chmod +x run-local.sh
./run-local.sh
```

打开 <http://127.0.0.1:8000>。

无桌面环境 / agent：

```bash
./run-local.sh --no-open
curl -fsS http://127.0.0.1:8000/api/health
```

## 手动路径

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt

cd frontend
npm ci
PUBLIC_URL=/ REACT_APP_API_URL=/api CI=false npm run build
cd ..

cd backend
../.venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

## 验证

```bash
curl -fsS http://127.0.0.1:8000/api/health
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/api/docs
```

## 不要提交

`.venv/`、`frontend/node_modules/`、`frontend/build/`、`backend/downloads/`、`.downie-video/`、`.run/`、`.env*`、模型缓存。

## 常见问题

见 README 的[故障排除](../README.md#12-故障排除)一节。
