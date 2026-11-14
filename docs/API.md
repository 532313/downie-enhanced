# API 参考

FastAPI 启动后，**交互式文档**是最准确的来源：

- Swagger UI: <http://127.0.0.1:8000/api/docs>
- ReDoc: <http://127.0.0.1:8000/api/redoc>
- OpenAPI JSON: <http://127.0.0.1:8000/openapi.json>

默认 Base URL：`http://127.0.0.1:8000/api`

## 健康与元数据

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 返回状态、版本、ffmpeg 路径、下载目录 |
| `GET` | `/api/stats` | 活跃任务、总任务、支持站点数 |
| `GET` | `/api/supported-sites` | 站点列表（实际由 yt-dlp 决定） |
| `POST` | `/api/analyze` | 快速解析 URL 元数据 |

## 下载

### 解析视频

`POST /api/downloads/extract`

请求：

```json
{
  "url": "https://download.samplelib.com/mp4/sample-5s.mp4",
  "quality": "720p",
  "post_processing": "none",
  "cookies": "",
  "cookies_from_browser": ""
}
```

`quality`：`auto` | `best` | `worst` | `1080p` | `720p` | `480p` | `360p`

`post_processing`：`none` | `audio` | `mp4` | `permute`

响应包含 `url`、`title`、`duration`、`thumbnail`、`uploader`、`extractor`、`formats`、`is_playlist`、`playlist_count`。

### 创建任务

`POST /api/downloads/add`

```json
{
  "url": "https://download.samplelib.com/mp4/sample-5s.mp4",
  "quality": "720p",
  "auto_start": true
}
```

响应：

```json
{
  "task_id": "…",
  "message": "下载任务已创建",
  "status": "started"
}
```

### 任务管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/downloads/start/{task_id}` | 启动 |
| `POST` | `/api/downloads/cancel/{task_id}` | 取消 |
| `GET` | `/api/downloads/tasks` | 全部任务 |
| `GET` | `/api/downloads/tasks/active` | 活跃任务 |
| `GET` | `/api/downloads/tasks/{task_id}` | 单任务 |
| `DELETE` | `/api/downloads/tasks/{task_id}` | 删除任务记录 |
| `POST` | `/api/downloads/cleanup` | 清理已完成记录 |
| `GET` | `/api/downloads/stats` | 下载统计 |
| `GET` | `/api/downloads/qualities` | 画质枚举 |
| `GET` | `/api/downloads/supported-sites` | 站点列表 |

### 文件

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/downloads/files` | 已下载文件列表 |
| `GET` | `/api/downloads/files/{filename}` | 下载文件 |

### 批量

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/downloads/batch/add` | 批量创建 |
| `POST` | `/api/downloads/batch/start` | 批量启动 |

### WebSocket

`WS /api/downloads/ws`

服务端推送示例：

```json
{
  "type": "progress",
  "task_id": "…",
  "progress": {
    "status": "downloading",
    "percentage": 42.5,
    "downloaded_bytes": 1024000,
    "total_bytes": 2400000,
    "speed": 512000,
    "eta": 3,
    "progress_text": "42.5% (1.0 MB/2.4 MB)",
    "speed_text": "500.0 KB/s"
  }
}
```

## 错误格式

FastAPI 标准错误：

```json
{
  "detail": "错误信息"
}
```

常见状态码：

- `400`：URL 无法解析、yt-dlp 报错、参数不合法
- `404`：任务或文件不存在
- `500`：未预期的服务端错误
