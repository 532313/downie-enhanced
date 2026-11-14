// Downie Enhanced - background service worker (Manifest V3)
//
// Responsibilities:
//   - context menu / keyboard shortcut / popup -> local backend API
//   - attach the user's browser cookies so yt-dlp can handle
//     "sign in to confirm" / member-only pages
//   - badge with the number of media URLs found on the page
//
// The backend runs at http://127.0.0.1:8000 by default. It can be overridden
// with chrome.storage.local.set({ apiBase: 'http://127.0.0.1:9000/api' }).

const DEFAULT_API_BASE = 'http://127.0.0.1:8000/api';
const DEFAULT_WEB_BASE = 'http://127.0.0.1:8000';

const VIDEO_SITES = [
  'youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com',
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
  'tiktok.com', 'bilibili.com', 'xiaoeknow.com'
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
async function getApiBase() {
  try {
    const stored = await chrome.storage.local.get('apiBase');
    return (stored.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
  } catch (error) {
    return DEFAULT_API_BASE;
  }
}

function getWebBase(apiBase) {
  return apiBase.replace(/\/api$/, '') || DEFAULT_WEB_BASE;
}

function showNotification(message) {
  try {
    chrome.notifications.create(
      {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('images/icon-128.png'),
        title: 'Downie Enhanced',
        message: String(message).slice(0, 200)
      },
      () => void chrome.runtime.lastError
    );
  } catch (error) {
    // Notifications are best-effort (permission may be revoked by the user).
  }
}

function ignoreRejection(result) {
  if (result && typeof result.catch === 'function') result.catch(() => {});
}

function setBadge(tabId, count) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  try {
    ignoreRejection(chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' }));
    if (count > 0) {
      ignoreRejection(chrome.action.setBadgeBackgroundColor({ tabId, color: '#7c3aed' }));
    }
  } catch (error) {
    // Tab may have been closed.
  }
}

async function readError(response) {
  try {
    const data = await response.json();
    if (typeof data.detail === 'string') return data.detail;
    if (Array.isArray(data.detail)) {
      return data.detail.map((item) => item.msg || JSON.stringify(item)).join('; ');
    }
    if (data.message) return data.message;
    return JSON.stringify(data);
  } catch (error) {
    return `HTTP ${response.status} ${response.statusText}`;
  }
}

async function getCookiesForUrl(url) {
  if (!/^https?:/i.test(url || '')) return '';
  try {
    const cookies = await chrome.cookies.getAll({ url });
    // Include HttpOnly cookies: chrome.cookies returns them, document.cookie does not.
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  } catch (error) {
    console.warn('Downie Enhanced: unable to read cookies', error);
    return '';
  }
}

// ---------------------------------------------------------------------------
// Backend calls
// ---------------------------------------------------------------------------
async function startDownload(url, quality = 'best', postProcessing = 'none', providedCookies = '') {
  if (!/^https?:/i.test(url || '')) {
    throw new Error('Only http(s) links can be downloaded');
  }

  const apiBase = await getApiBase();
  const cookies = providedCookies || (await getCookiesForUrl(url));

  const response = await fetch(`${apiBase}/downloads/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      quality,
      post_processing: postProcessing,
      cookies,
      auto_start: true
    })
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return response.json();
}

async function getDownloadHistory() {
  const apiBase = await getApiBase();
  const response = await fetch(`${apiBase}/downloads/tasks`);
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

async function checkServerStatus() {
  const apiBase = await getApiBase();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    const response = await fetch(`${apiBase}/health`, { signal: controller.signal });
    if (!response.ok) return { online: false, error: `HTTP ${response.status}` };
    const data = await response.json();
    return { online: true, data, apiBase };
  } catch (error) {
    return { online: false, error: error.name === 'AbortError' ? 'timeout' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function extractVideoInfo(url, cookies = '') {
  const apiBase = await getApiBase();
  const response = await fetch(`${apiBase}/downloads/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      quality: 'best',
      post_processing: 'none',
      cookies
    })
  });

  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

// ---------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------
function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;

    const items = [
      { id: 'download-current-page', title: 'Download with Downie Enhanced', contexts: ['page'] },
      { id: 'download-link', title: 'Download Link with Downie Enhanced', contexts: ['link'] },
      { id: 'download-video', title: 'Download Video with Downie Enhanced', contexts: ['video', 'audio'] },
      { id: 'separator1', type: 'separator', contexts: ['page', 'link', 'video', 'audio'] },
      { id: 'download-best', title: 'Download Best Quality', contexts: ['page', 'link', 'video', 'audio'] },
      { id: 'download-720p', title: 'Download 720p', contexts: ['page', 'link'] },
      { id: 'download-audio', title: 'Download Audio Only (MP3)', contexts: ['page', 'link', 'video', 'audio'] }
    ];

    for (const item of items) {
      chrome.contextMenus.create(item, () => void chrome.runtime.lastError);
    }
  });
}

chrome.runtime.onInstalled.addListener(createContextMenus);
chrome.runtime.onStartup.addListener(() => {
  // Menus survive restarts, but re-creating is harmless and repairs older installs.
  createContextMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.linkUrl || info.srcUrl || info.pageUrl || (tab && tab.url);
  if (!url) return;

  let quality = 'best';
  let postProcessing = 'none';

  if (info.menuItemId === 'download-720p') quality = '720p';
  if (info.menuItemId === 'download-audio') postProcessing = 'audio';

  try {
    await startDownload(url, quality, postProcessing);
    showNotification(postProcessing === 'audio' ? 'Audio download queued.' : 'Download queued.');
  } catch (error) {
    console.error('Downie Enhanced: download request failed', error);
    showNotification(`Failed: ${error.message}`);
  }
});

// ---------------------------------------------------------------------------
// Keyboard shortcut
// ---------------------------------------------------------------------------
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'download-current-tab') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;

  try {
    await startDownload(tab.url, 'best', 'none');
    showNotification('Download queued from the current tab.');
  } catch (error) {
    showNotification(`Failed: ${error.message}`);
  }
});

// ---------------------------------------------------------------------------
// Messages from popup / content script
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const action = request && request.action;

  const run = async () => {
    switch (action) {
      case 'downloadUrl':
        return startDownload(
          request.data.url,
          request.data.quality || 'best',
          request.data.postProcessing || 'none',
          request.data.cookies || ''
        );

      case 'getDownloadHistory':
        return getDownloadHistory();

      case 'checkServerStatus':
        return checkServerStatus();

      case 'extractVideoInfo':
        return extractVideoInfo(request.data.url, request.data.cookies || '');

      case 'videosDetected': {
        const count = (request.data && request.data.count) || 0;
        if (sender.tab) setBadge(sender.tab.id, count);
        return { count };
      }

      case 'getConfig': {
        const apiBase = await getApiBase();
        return { apiBase, webBase: getWebBase(apiBase) };
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  };

  run()
    .then((data) => sendResponse({ success: true, data }))
    .catch((error) => sendResponse({ success: false, error: error.message }));

  return true; // keep the message channel open for the async response
});

// ---------------------------------------------------------------------------
// Badge for known video sites
// ---------------------------------------------------------------------------
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab || !tab.url) return;

  const isVideoSite = VIDEO_SITES.some((site) => tab.url.includes(site));
  if (isVideoSite) {
    ignoreRejection(chrome.action.setBadgeText({ tabId, text: '!' }));
    ignoreRejection(chrome.action.setBadgeBackgroundColor({ tabId, color: '#7c3aed' }));
    ignoreRejection(chrome.action.setTitle({
      tabId,
      title: 'Video site detected - click to download with Downie Enhanced'
    }));
  } else {
    ignoreRejection(chrome.action.setBadgeText({ tabId, text: '' }));
    ignoreRejection(chrome.action.setTitle({ tabId, title: 'Download with Downie Enhanced' }));
  }
});

console.log('Downie Enhanced background service worker ready');
