const TIMING_RE = /^((?:\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{3})/;
const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

export function parseVtt(content) {
  return mergeRollingCues(parseCues(content));
}

export function parseSrt(content) {
  return mergeRollingCues(parseCues(content));
}

export function parseTranscript(content) {
  return String(content).includes('-->') ? mergeRollingCues(parseCues(content)) : [];
}

function parseCues(content) {
  const lines = String(content ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\uFEFF/, '')
    .split('\n');
  const cues = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    const text = cleanCueText(current.lines.join(' '));
    if (text) cues.push({ start: current.start, end: current.end, text });
    current = null;
  };

  for (const line of lines) {
    const timing = line.match(TIMING_RE);
    if (timing) {
      flush();
      current = {
        start: timestampToSeconds(timing[1]),
        end: timestampToSeconds(timing[2]),
        lines: [],
      };
      continue;
    }
    if (!current) continue;
    if (line.trim() === '') {
      flush();
      continue;
    }
    current.lines.push(line);
  }
  flush();
  return cues;
}

export function cleanCueText(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, decimal) => {
      const code = Number.parseInt(decimal, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&([a-z#0-9]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function mergeRollingCues(cues) {
  const out = [];
  for (const cue of cues) {
    const text = String(cue.text ?? '').trim();
    if (!text) continue;
    const prev = out[out.length - 1];
    if (prev) {
      if (prev.text === text) {
        prev.end = Math.max(prev.end, cue.end);
        continue;
      }
      if (text.startsWith(prev.text) && text.length - prev.text.length <= 80) {
        prev.text = text;
        prev.end = Math.max(prev.end, cue.end);
        continue;
      }
      if (prev.text.startsWith(text) && prev.text.length - text.length <= 80) {
        prev.end = Math.max(prev.end, cue.end);
        continue;
      }
    }
    out.push({ start: cue.start, end: cue.end, text });
  }
  return out;
}

export function timestampToSeconds(value) {
  const parts = String(value)
    .trim()
    .replace(',', '.')
    .split(':');
  if (parts.length === 0 || parts.some((part) => part === '' || Number.isNaN(Number(part)))) return 0;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + Number(part);
  return seconds;
}

export function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatFileTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}-${String(m).padStart(2, '0')}-${String(s).padStart(2, '0')}`;
}

export function cuesToMarkdown(cues, meta = {}) {
  const title = meta.title || '未命名视频';
  const lines = [
    `# 转写：${title}`,
    '',
    `- 来源：${meta.url || ''}`,
    `- 语言：${meta.language || 'unknown'}`,
    `- 方式：${meta.source || 'unknown'}`,
    `- 片段数：${cues.length}`,
    `- 字数：${cuesToPlainText(cues).length}`,
    `- 生成时间：${meta.generatedAt || new Date().toISOString()}`,
    '',
    '---',
    '',
  ];
  for (const cue of cues) lines.push(`- [${formatTimestamp(cue.start)}] ${cue.text}`);
  if (cues.length === 0) lines.push('_没有获得转写内容。_');
  lines.push('');
  return lines.join('\n');
}

export function cuesToPlainText(cues) {
  return cues.map((cue) => cue.text).join('\n');
}
