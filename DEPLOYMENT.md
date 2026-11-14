# 部署与验证记录

> 这是本项目的部署补充说明。**新机器部署请以 [README.md](./README.md) 为准**；本文件只记录支持范围、验证方式和运维要点。

## 支持范围

| 项目 | 状态 |
| --- | --- |
| macOS 原生 | 已验证 |
| Linux 原生 | 支持 |
| Windows 原生 | 不支持，请用 WSL2 |
| Docker Compose | 不支持（旧配置已移除） |
| GitHub Pages 静态站 | 不支持（下载功能需要 FastAPI 后端） |

## 一键部署

```bash
git clone https://github.com/532313/downie-enhanced.git
cd downie-enhanced
chmod +x run-local.sh
./run-local.sh --no-open
```

首次运行会：

1. 创建 `.venv/`；
2. 安装 `backend/requirements.txt`；
3. 在 `frontend/` 安装依赖并构建；
4. 启动 `uvicorn main:app`，默认 `127.0.0.1:8000`。

## 手动部署

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

## 运行目录

| 路径 | 说明 |
| --- | --- |
| `backend/downloads/` | 下载的视频/音频，运行时生成 |
| `frontend/build/` | 前端构建产物，运行时生成 |
| `.venv/` | Python 虚拟环境 |
| `.run/downie.log` | `run-local.sh` 后台日志 |
| `.downie-video/` | 视频分析插件的转写/分析/关键帧/模型缓存 |

这些目录都在 `.gitignore` 中，不应提交。

## 验证命令

```bash
curl -fsS http://127.0.0.1:8000/api/health
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/api/docs
curl -fsS -X POST http://127.0.0.1:8000/api/downloads/extract \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://download.samplelib.com/mp4/sample-5s.mp4","quality":"720p"}'
```

## 运维

```bash
./run-local.sh status
./run-local.sh logs
./run-local.sh stop
./run-local.sh restart
./run-local.sh rebuild
```

`--lan` 会监听 `0.0.0.0`；服务没有鉴权，只建议在可信局域网临时使用。

## 已知限制

- `yt-dlp` 支持范围随版本变化；失败时先升级：`.venv/bin/pip install -U yt-dlp`。
- YouTube 风控/B 站会员清晰度需要浏览器 Cookie。
- 本地 whisper 首次需要下载约 148 MB 模型；没有 `whisper-cli` 时转写会降级为空。
- 旧 Docker 配置引用了不存在的 Dockerfile/nginx/数据库服务，已从发布快照移除。

## 历史说明

本项目最初从 `ychenfen/downie-enhanced` 的界面原型继续开发，后续补上了真实的 yt-dlp 下载引擎、可用的前端、浏览器扩展和视频分析插件。发布仓库使用干净初始提交，不再保留旧的 GitHub Pages/Docker 演示配置。
