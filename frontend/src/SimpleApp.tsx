import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Downie Enhanced - Web UI
 *
 * Talks to the FastAPI backend that serves this build:
 *   POST /api/downloads/extract -> metadata + formats
 *   POST /api/downloads/add     -> create + start a job (yt-dlp)
 *   GET  /api/downloads/tasks   -> poll progress
 *   GET  /api/downloads/files   -> already downloaded files
 */

const API_BASE = (process.env.REACT_APP_API_URL || '/api').replace(/\/$/, '');

type Format = {
  format_id: string;
  ext: string;
  quality: string;
  height: number | null;
  vcodec: string;
  acodec: string;
  filesize: number | null;
  tbr: number | null;
};

type Extracted = {
  url: string;
  title: string;
  duration: number;
  thumbnail: string;
  uploader: string;
  formats: Format[];
  is_playlist: boolean;
  playlist_count: number;
};

type Task = {
  id: string;
  url: string;
  title: string;
  status: string;
  progress_percentage: number;
  downloaded_bytes: number;
  total_bytes: number;
  speed: number;
  eta: number;
  files: string[];
  download_url: string;
  error_message: string;
};

type DownloadFile = {
  name: string;
  size: number;
  modified: number;
  url: string;
};

const STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  starting: '准备中',
  downloading: '下载中',
  processing: '处理中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  paused: '已暂停',
};

const QUALITY_OPTIONS = [
  { value: 'best', label: '最佳画质' },
  { value: '1080p', label: '1080p' },
  { value: '720p', label: '720p' },
  { value: '480p', label: '480p' },
  { value: '360p', label: '360p' },
  { value: 'audio', label: '仅音频 MP3' },
];

const BROWSER_OPTIONS = [
  { value: '', label: '不使用 Cookie' },
  { value: 'safari', label: '读取 Safari Cookie' },
  { value: 'chrome', label: '读取 Chrome Cookie' },
  { value: 'edge', label: '读取 Edge Cookie' },
  { value: 'firefox', label: '读取 Firefox Cookie' },
];

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '--:--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function formatEta(seconds: number): string {
  if (!seconds || seconds <= 0) return '';
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m} 分 ${s} 秒`;
}

const SimpleApp: React.FC = () => {
  const [url, setUrl] = useState('');
  const [quality, setQuality] = useState('best');
  const [browser, setBrowser] = useState('');
  const [info, setInfo] = useState<Extracted | null>(null);
  const [parsing, setParsing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [files, setFiles] = useState<DownloadFile[]>([]);
  const [online, setOnline] = useState<boolean | null>(null);
  const [advanced, setAdvanced] = useState(false);

  const noticeTimer = useRef<number | null>(null);

  const flash = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 4000);
  }, []);

  const refreshTasks = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/downloads/tasks`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as Task[];
      setTasks(data);
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }, []);

  const refreshFiles = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/downloads/files`);
      if (!response.ok) return;
      const data = (await response.json()) as { files: DownloadFile[] };
      setFiles(data.files || []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refreshTasks();
    refreshFiles();
    const timer = window.setInterval(refreshTasks, 1200);
    return () => {
      window.clearInterval(timer);
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    };
  }, [refreshTasks, refreshFiles]);

  const completedKey = tasks
    .filter((task) => task.status === 'completed')
    .map((task) => `${task.id}:${task.files.join(',')}`)
    .join('|');

  useEffect(() => {
    if (completedKey) refreshFiles();
  }, [completedKey, refreshFiles]);

  const payload = () => {
    const audioOnly = quality === 'audio';
    return {
      url: url.trim(),
      quality: audioOnly ? 'best' : quality,
      post_processing: audioOnly ? 'audio' : 'none',
      cookies: '',
      cookies_from_browser: browser,
    };
  };

  const handleExtract = async () => {
    const target = url.trim();
    if (!target) {
      setError('请先粘贴视频链接');
      return;
    }
    setParsing(true);
    setError('');
    setInfo(null);
    try {
      const response = await fetch(`${API_BASE}/downloads/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload()),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || `解析失败 (HTTP ${response.status})`);
      setInfo(data as Extracted);
      flash('解析成功，可以开始下载了');
    } catch (err) {
      setError(err instanceof Error ? err.message : '解析失败');
    } finally {
      setParsing(false);
    }
  };

  const handleDownload = async () => {
    const target = url.trim();
    if (!target) {
      setError('请先粘贴视频链接');
      return;
    }
    setStarting(true);
    setError('');
    try {
      const response = await fetch(`${API_BASE}/downloads/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload(), auto_start: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || `创建任务失败 (HTTP ${response.status})`);
      flash('已加入下载队列');
      setInfo(null);
      await refreshTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建任务失败');
    } finally {
      setStarting(false);
    }
  };

  const handleCancel = async (id: string) => {
    try {
      await fetch(`${API_BASE}/downloads/cancel/${id}`, { method: 'POST' });
      await refreshTasks();
    } catch {
      /* ignore */
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await fetch(`${API_BASE}/downloads/tasks/${id}`, { method: 'DELETE' });
      await refreshTasks();
    } catch {
      /* ignore */
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setUrl(text.trim());
    } catch {
      setError('无法读取剪贴板，请手动粘贴');
    }
  };

  const activeTasks = tasks.filter((task) =>
    ['pending', 'starting', 'downloading', 'processing'].includes(task.status)
  );

  return (
    <div className="dx-app">
      <header className="dx-hero">
        <div className="dx-hero-inner">
          <div className="dx-brand">
            <span className="dx-logo">🎬</span>
            <div>
              <h1>Downie Enhanced</h1>
              <p>基于 Downie 4 的本地网页视频下载器 · yt-dlp 引擎</p>
            </div>
          </div>
          <div className={`dx-status ${online === false ? 'is-offline' : online ? 'is-online' : ''}`}>
            <span className="dx-dot" />
            {online === null ? '连接中…' : online ? '服务运行中' : '无法连接后端'}
          </div>
        </div>
      </header>

      <main className="dx-main">
        <section className="dx-card">
          <label className="dx-label" htmlFor="dx-url">
            视频链接
          </label>
          <div className="dx-input-row">
            <input
              id="dx-url"
              className="dx-input"
              type="url"
              placeholder="粘贴 YouTube / Bilibili / Vimeo / TikTok 等视频链接"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleExtract();
              }}
            />
            <button className="dx-btn dx-btn-ghost" type="button" onClick={handlePaste}>
              粘贴
            </button>
          </div>

          <div className="dx-options">
            <div className="dx-field">
              <span>画质</span>
              <select value={quality} onChange={(event) => setQuality(event.target.value)}>
                {QUALITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <button className="dx-link" type="button" onClick={() => setAdvanced(!advanced)}>
              {advanced ? '收起高级选项' : '高级选项（登录 / 会员视频）'}
            </button>
          </div>

          {advanced && (
            <div className="dx-advanced">
              <label className="dx-field">
                <span>Cookie 来源</span>
                <select value={browser} onChange={(event) => setBrowser(event.target.value)}>
                  {BROWSER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <p>
                遇到“Sign in to confirm you’re not a bot”、会员 / 私有视频时，选择已登录该网站的浏览器即可复用登录状态。
                macOS 首次读取浏览器 Cookie 可能需要在系统设置中授权。
              </p>
            </div>
          )}

          <div className="dx-actions">
            <button className="dx-btn dx-btn-secondary" type="button" onClick={handleExtract} disabled={parsing || !url}>
              {parsing ? '解析中…' : '🔍 解析视频'}
            </button>
            <button className="dx-btn dx-btn-primary" type="button" onClick={handleDownload} disabled={starting || !url}>
              {starting ? '创建任务…' : '⬇️ 开始下载'}
            </button>
          </div>

          {error && <div className="dx-alert dx-alert-error">{error}</div>}
          {notice && <div className="dx-alert dx-alert-ok">{notice}</div>}
        </section>

        {info && (
          <section className="dx-card dx-preview">
            {info.thumbnail ? (
              <img className="dx-thumb" src={info.thumbnail} alt="" referrerPolicy="no-referrer" />
            ) : (
              <div className="dx-thumb dx-thumb-empty">无封面</div>
            )}
            <div className="dx-preview-body">
              <h2>{info.title}</h2>
              <p className="dx-meta">
                {info.uploader && <span>{info.uploader}</span>}
                {info.duration > 0 && <span>⏱ {formatDuration(info.duration)}</span>}
                <span>🎞 {info.formats.length} 个格式</span>
                {info.is_playlist && <span>📚 播放列表 {info.playlist_count} 个</span>}
              </p>
              <div className="dx-pills">
                {Array.from(new Set(info.formats.map((fmt) => fmt.quality)))
                  .slice(0, 8)
                  .map((label) => (
                    <span key={label} className="dx-pill">
                      {label}
                    </span>
                  ))}
              </div>
            </div>
          </section>
        )}

        <section className="dx-card">
          <div className="dx-section-head">
            <h2>下载任务</h2>
            <span className="dx-count">
              {activeTasks.length > 0 ? `${activeTasks.length} 个进行中` : `${tasks.length} 个任务`}
            </span>
          </div>

          {tasks.length === 0 ? (
            <p className="dx-empty">还没有任务，粘贴链接后点击“开始下载”。</p>
          ) : (
            <ul className="dx-tasks">
              {tasks.map((task) => {
                const percent = Math.max(0, Math.min(100, task.progress_percentage || 0));
                const active = ['pending', 'starting', 'downloading', 'processing'].includes(task.status);
                return (
                  <li key={task.id} className={`dx-task is-${task.status}`}>
                    <div className="dx-task-top">
                      <div className="dx-task-title" title={task.url}>
                        {task.title}
                      </div>
                      <span className={`dx-badge dx-badge-${task.status}`}>
                        {STATUS_LABEL[task.status] || task.status}
                      </span>
                    </div>

                    <div className="dx-bar">
                      <div className="dx-bar-fill" style={{ width: `${task.status === 'completed' ? 100 : percent}%` }} />
                    </div>

                    <div className="dx-task-meta">
                      <span>
                        {formatBytes(task.downloaded_bytes)}
                        {task.total_bytes > 0 ? ` / ${formatBytes(task.total_bytes)}` : ''}
                      </span>
                      {task.status === 'downloading' && <span>{formatBytes(task.speed)}/s</span>}
                      {task.status === 'downloading' && task.eta > 0 && <span>剩余 {formatEta(task.eta)}</span>}
                      {task.status === 'completed' && <span>{percent.toFixed(0)}%</span>}
                      {task.error_message && <span className="dx-error-text">{task.error_message}</span>}
                    </div>

                    <div className="dx-task-actions">
                      {task.status === 'completed' && task.download_url && (
                        <a className="dx-btn dx-btn-small dx-btn-primary" href={task.download_url} download>
                          保存到本机
                        </a>
                      )}
                      {active && (
                        <button className="dx-btn dx-btn-small dx-btn-ghost" type="button" onClick={() => handleCancel(task.id)}>
                          取消
                        </button>
                      )}
                      {!active && (
                        <button className="dx-btn dx-btn-small dx-btn-ghost" type="button" onClick={() => handleDelete(task.id)}>
                          移除记录
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="dx-card">
          <div className="dx-section-head">
            <h2>已下载文件</h2>
            <span className="dx-count">保存在 backend/downloads</span>
          </div>
          {files.length === 0 ? (
            <p className="dx-empty">下载完成的文件会出现在这里。</p>
          ) : (
            <ul className="dx-files">
              {files.map((file) => (
                <li key={file.name}>
                  <a href={`${API_BASE}/downloads/files/${encodeURIComponent(file.name)}`} download>
                    {file.name}
                  </a>
                  <span>{formatBytes(file.size)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      <footer className="dx-footer">
        <span>Downie Enhanced · 本地部署版</span>
        <a href={`${API_BASE}/docs`} target="_blank" rel="noreferrer">
          API 文档
        </a>
      </footer>
    </div>
  );
};

export default SimpleApp;
