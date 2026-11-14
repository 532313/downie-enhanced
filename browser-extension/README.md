# 🧩 Downie Enhanced 浏览器扩展

把当前页面、链接或 `<video>` 元素一键发送到本机的 Downie Enhanced 下载服务
（默认 `http://127.0.0.1:8000`），由后端的 yt-dlp 完成解析和下载。

- Manifest V3，无需构建，直接加载文件夹即可
- 需要 Chrome / Edge **111+**（使用了 `world: "MAIN"` 内容脚本）
- 配套后端：仓库根目录运行 `./run-local.sh`

## 安装

1. 启动本地服务：

   ```bash
   cd /path/to/downie-enhanced
   ./run-local.sh
   ```

2. 打开 `chrome://extensions`
3. 右上角打开「开发者模式」
4. 点击「加载已解压的扩展程序」，选择本目录 `browser-extension/`
5. 固定扩展图标到工具栏

安装后可以：

| 操作 | 结果 |
| --- | --- |
| 点击工具栏图标 | 打开弹窗：显示服务状态、当前页 URL、画质选择 |
| 页面右键 → Download with Downie Enhanced | 下载当前页面 |
| 右键链接 / 视频 → Download Link / Video | 下载该链接或媒体地址 |
| 右键 → Download 720p / Audio Only | 指定画质或提取 MP3 |
| `⌘⇧Y`（Windows: `Ctrl+Shift+Y`） | 下载当前标签页 |

下载任务会出现在 <http://127.0.0.1:8000> 的「下载任务」里，文件保存在
`backend/downloads/`。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `cookies` + `<all_urls>` | 读取目标站点的登录 Cookie，交给 yt-dlp，用于 YouTube 风控、B 站会员清晰度、私有视频 |
| `contextMenus` | 右键菜单 |
| `notifications` | 下载开始/失败提示 |
| `tabs` / `activeTab` | 获取当前标签页 URL，打开 Dashboard |
| `storage` | 保存自定义后端地址 |
| 内容脚本（所有 http/https 页面） | 检测页面中的 `<video>`、`.m3u8`、`.mp4` 等媒体地址 |

Cookie 只发送给本机 `127.0.0.1:8000`，不会上传到任何第三方服务器。

## 自定义后端地址

如果后端不是 8000 端口，在扩展的 Service Worker 控制台执行一次：

```js
chrome.storage.local.set({ apiBase: 'http://127.0.0.1:9000/api' });
```

弹窗里的 Dashboard 链接会自动跟随该地址。

## 文件结构

```
browser-extension/
├── manifest.json     # MV3 清单：权限、内容脚本、快捷键
├── background.js     # Service Worker：API 调用、Cookie、右键菜单、通知、徽标
├── content.js        # ISOLATED world：DOM 媒体检测、页面消息桥接
├── injected.js       # MAIN world：hook fetch/XHR，捕获真实媒体请求
├── popup.html/.js    # 弹窗 UI
└── images/           # 图标（16/32/48/128/512）
```

## 常见问题

**弹窗显示 Server Offline**
先运行 `./run-local.sh`，确认 <http://127.0.0.1:8000/api/health> 返回 healthy。

**提示 Failed: ... 401 / Sign in to confirm you're not a bot**
确认扩展有 Cookie 权限，并已登录对应网站；弹窗会自动附带当前域的 Cookie。
若仍失败，可在网页版「高级选项」里直接选择「读取 Safari/Chrome Cookie」。

**右键菜单没有出现**
在 `chrome://extensions` 里点扩展的「重新加载」，或重启浏览器；菜单在
`onInstalled` / `onStartup` 时重建。

**改了后端端口后扩展还是连 8000**
按上面的「自定义后端地址」设置 `apiBase`，然后在扩展页点「重新加载」。

**修改扩展代码后**
在 `chrome://extensions` 点刷新按钮，并刷新目标网页（内容脚本需要重新注入）。
