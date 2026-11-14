// Downie Enhanced - page-context media detector.
//
// This file is injected into the page (MAIN world) by content.js so it can see
// the page's own fetch/XHR traffic. It never talks to the network itself: it
// only reports candidate media URLs to content.js via window.postMessage.
(() => {
  'use strict';

  if (window.__downieEnhancedInjected) return;
  window.__downieEnhancedInjected = true;

  const MEDIA_PATTERN = /\.(m3u8|mpd|mp4|webm|m4v|mkv|mov|flv|m4a|mp3|aac)(?:[?#]|$)/i;
  const MAX_URLS = 2000;
  const seen = new Set();

  function report(url, source) {
    try {
      if (typeof url !== 'string' || !url) return;
      if (!/^https?:/i.test(url)) return; // ignore blob:, data:, chrome-extension:
      if (!MEDIA_PATTERN.test(url)) return;

      const key = url.split('#')[0];
      if (seen.has(key) || seen.size >= MAX_URLS) return;
      seen.add(key);

      window.postMessage(
        { __downieEnhanced: true, type: 'media-url', url: key, source },
        '*'
      );
    } catch (error) {
      // Never break the host page because of detection.
    }
  }

  // --- fetch ---------------------------------------------------------------
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function downieFetch(input) {
      try {
        report(typeof input === 'string' ? input : input && input.url, 'fetch');
      } catch (error) {
        /* ignore */
      }
      return nativeFetch.apply(this, arguments);
    };
  }

  // --- XMLHttpRequest ------------------------------------------------------
  const nativeOpen = XMLHttpRequest.prototype.open;
  if (typeof nativeOpen === 'function') {
    XMLHttpRequest.prototype.open = function downieOpen(method, url) {
      try {
        report(url, 'xhr');
      } catch (error) {
        /* ignore */
      }
      return nativeOpen.apply(this, arguments);
    };
  }

  // --- <video> / <audio> / <source> ---------------------------------------
  function scanMediaElements() {
    try {
      document.querySelectorAll('video, audio, source').forEach((element) => {
        if (element.src) report(element.src, 'element');
        if (element.currentSrc) report(element.currentSrc, 'element');
      });
    } catch (error) {
      /* ignore */
    }
  }

  document.addEventListener(
    'play',
    (event) => {
      const media = event.target;
      if (media && (media.currentSrc || media.src)) {
        report(media.currentSrc || media.src, 'play');
      }
    },
    true
  );

  document.addEventListener(
    'loadedmetadata',
    (event) => {
      const media = event.target;
      if (media && (media.currentSrc || media.src)) {
        report(media.currentSrc || media.src, 'metadata');
      }
    },
    true
  );

  // --- resource timing (catches URLs loaded before this script ran) -------
  try {
    performance.getEntriesByType('resource').forEach((entry) => report(entry.name, 'resource'));
  } catch (error) {
    /* ignore */
  }

  if (typeof PerformanceObserver === 'function') {
    try {
      new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => report(entry.name, 'resource'));
      }).observe({ type: 'resource', buffered: true });
    } catch (error) {
      /* older browsers */
    }
  }

  // --- DOM changes ---------------------------------------------------------
  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanMediaElements();
    }, 400);
  }

  try {
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src']
    });
  } catch (error) {
    /* ignore */
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanMediaElements, { once: true });
  } else {
    scanMediaElements();
  }

  window.addEventListener('load', scanMediaElements, { once: true });

  // content.js starts later (document_idle) and asks us to replay what we saw.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__downieEnhanced !== true || data.type !== 'request-scan') return;

    seen.forEach((url) => {
      window.postMessage(
        { __downieEnhanced: true, type: 'media-url', url, source: 'replay' },
        '*'
      );
    });
  });
})();
