import { fileURLToPath } from 'node:url';

import { runPipeline } from './lib/pipeline.js';

const PLUGIN_ROOT = fileURLToPath(new URL('.', import.meta.url));

export const TOOL_NAME = 'downie_video_analyze';

export const DEFAULTS = {
  downieRoot: '',
  outputDir: '',
  quality: '720p',
  language: 'auto',
  keepFrames: true,
  maxFrames: 12,
  cookiesFromBrowser: '',
  whisperBin: '/opt/homebrew/bin/whisper-cli',
  whisperModel: 'base',
  modelPath: '',
};

export const QUALITIES = ['360p', '480p', '720p', '1080p', 'best', 'worst'];

const PROMPT = [
  '## 视频链接处理规则',
  '当用户发来一个 http/https 视频链接，并且希望下载、总结、转写、分析或“看一下”这个视频时：',
  '1. 必须调用工具 `downie_video_analyze`，不要自己用 curl、yt-dlp、ffmpeg 或浏览器下载视频。',
  '2. 工具成功后，先读回它返回的 `transcriptPath`（完整转写），必要时再看 2–4 张 `frames` 关键帧；然后把你对视频的理解写入 `analysisPath`，替换掉骨架里的“待填写”占位内容。',
  '3. 写完后基于 `analysis.md` 和转写回答用户当前的问题。回答里可以引用时间戳和关键帧，但不要编造没有出现在转写或关键帧里的内容。',
  '4. 视频、音频、字幕和临时文件必须由工具清理；不要在 `.downie-video` 里保留或复制任何媒体文件。',
  '5. 如果工具返回 `sourceDeleted=false`，明确告诉用户残留文件的路径，并建议手动删除；不要声称已经清理干净。',
  '6. 用户后续追问同一个视频时，读取 `.downie-video/index.json` 找到对应的 `analysis.md` / `transcript.md`，不要重新下载视频。',
  '7. 如果当前模型看不到图片，只能依据转写分析，并说明关键帧已保存但未被用于视觉判断。',
  '8. 输出使用用户的语言；默认中文，保留专有名词、产品名和人名的原文。',
].join('\n');

export const inject = ['tools', 'systemPrompt', 'subprocess', 'workingDirectory'];

export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config ?? {}) };
  ctx.effect(() => ctx.tools.register(createTool(ctx, settings)));
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'downie-video-analyzer',
      order: 950,
      text: PROMPT,
    }),
  );
}

export function createTool(ctx, settings) {
  return {
    name: TOOL_NAME,
    description:
      'Download a video through the local Downie Enhanced yt-dlp engine, extract captions or run local whisper.cpp, sample keyframes, write a structured analysis skeleton, and delete the downloaded video/audio/subtitles. Returns the retained artifact paths so follow-up questions can be answered from the transcript and frames without re-downloading.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Public http/https video page URL (Bilibili, YouTube, and other yt-dlp supported sites).',
        },
        quality: {
          type: 'string',
          enum: QUALITIES,
          description: `Download quality. Defaults to the plugin setting (${settings.quality}).`,
        },
        language: {
          type: 'string',
          description: 'Preferred transcript language, or "auto" to detect. Example: zh, en, ja.',
        },
        cookies_from_browser: {
          type: 'string',
          description: 'Optional browser name for yt-dlp cookies, e.g. chrome, safari, edge, firefox.',
        },
        keep_frames: {
          type: 'boolean',
          description: 'Keep sampled JPEG keyframes after analysis. Defaults to true.',
        },
        max_frames: {
          type: 'integer',
          minimum: 0,
          maximum: 24,
          description: 'Maximum keyframes to sample; 0 disables frames. Defaults to 12.',
        },
        force_transcribe: {
          type: 'boolean',
          description: 'Ignore existing captions and run whisper.cpp anyway.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          videoId: { type: 'string' },
          title: { type: 'string' },
          durationSeconds: { type: 'number' },
          uploader: { type: 'string' },
          webpageUrl: { type: 'string' },
          extractor: { type: 'string' },
          analysisDir: { type: 'string' },
          transcriptPath: { type: 'string' },
          analysisPath: { type: 'string' },
          metaPath: { type: 'string' },
          frames: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                timeSeconds: { type: 'number' },
              },
              required: ['path', 'timeSeconds'],
              additionalProperties: false,
            },
          },
          transcriptSource: { type: 'string', enum: ['captions', 'whisper', 'none'] },
          transcriptLanguage: { type: 'string' },
          transcriptChars: { type: 'integer' },
          transcriptPreview: { type: 'string' },
          chapters: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                startSeconds: { type: 'number' },
                title: { type: 'string' },
              },
              required: ['startSeconds', 'title'],
              additionalProperties: false,
            },
          },
          sourceDeleted: { type: 'boolean' },
          warnings: { type: 'array', items: { type: 'string' } },
          elapsedSeconds: { type: 'number' },
        },
        required: [
          'videoId',
          'title',
          'durationSeconds',
          'uploader',
          'webpageUrl',
          'extractor',
          'analysisDir',
          'transcriptPath',
          'analysisPath',
          'metaPath',
          'frames',
          'transcriptSource',
          'transcriptLanguage',
          'transcriptChars',
          'transcriptPreview',
          'chapters',
          'sourceDeleted',
          'warnings',
          'elapsedSeconds',
        ],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: renderSummary(value) }];
      },
    },
    timeoutMs: 60 * 60 * 1000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const normalized = normalizeArgs(args, settings);
      return runPipeline({ ctx, settings, args: normalized, exec, pluginRoot: PLUGIN_ROOT });
    },
  };
}

export function normalizeArgs(args, settings) {
  const url = typeof args?.url === 'string' ? args.url.trim() : '';
  if (!url) throw new Error('缺少视频链接 url。');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`无效的视频链接：${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只支持 http/https 视频链接。');
  }
  const quality = typeof args?.quality === 'string' && QUALITIES.includes(args.quality) ? args.quality : settings.quality;
  const language = typeof args?.language === 'string' && args.language.trim() ? args.language.trim() : settings.language || 'auto';
  const cookies = typeof args?.cookies_from_browser === 'string' ? args.cookies_from_browser.trim() : '';
  const keepFrames = typeof args?.keep_frames === 'boolean' ? args.keep_frames : settings.keepFrames !== false;
  const requestedFrames = Number.isFinite(args?.max_frames) ? Math.trunc(args.max_frames) : Number(settings.maxFrames);
  const maxFrames = Math.min(24, Math.max(0, Number.isFinite(requestedFrames) ? requestedFrames : 12));
  return {
    url,
    quality: QUALITIES.includes(quality) ? quality : '720p',
    language,
    cookiesFromBrowser: cookies || settings.cookiesFromBrowser || '',
    keepFrames,
    maxFrames,
    forceTranscribe: args?.force_transcribe === true,
  };
}

export function renderSummary(value) {
  const v = value ?? {};
  const lines = [];
  lines.push(`已下载并分析：${v.title || '(未命名视频)'}`);
  lines.push(`- 时长：${formatDuration(Number(v.durationSeconds) || 0)}`);
  lines.push(`- 来源：${v.webpageUrl || ''}`);
  lines.push(`- 转写：${sourceLabel(v.transcriptSource)}（${v.transcriptChars || 0} 字，语言 ${v.transcriptLanguage || 'unknown'}）`);
  lines.push(`- 关键帧：${Array.isArray(v.frames) ? v.frames.length : 0} 张`);
  lines.push(`- 分析目录：${v.analysisDir || ''}`);
  lines.push(`- 转写文件：${v.transcriptPath || ''}`);
  lines.push(`- 分析骨架：${v.analysisPath || ''}`);
  lines.push(`- 源文件已删除：${v.sourceDeleted ? '是' : '否'}`);
  if (Array.isArray(v.warnings) && v.warnings.length > 0) {
    lines.push(`- 警告：${v.warnings.length} 条`);
    for (const warning of v.warnings.slice(0, 6)) lines.push(`  - ${warning}`);
    if (v.warnings.length > 6) lines.push(`  - ...另有 ${v.warnings.length - 6} 条`);
  }
  if (v.transcriptPreview) {
    lines.push('', '转写预览：', v.transcriptPreview);
  }
  lines.push('', '下一步：读取 transcriptPath 和关键帧，把理解写入 analysisPath，再回答用户。');
  return lines.join('\n');
}

function sourceLabel(source) {
  if (source === 'captions') return '站点字幕';
  if (source === 'whisper') return 'whisper.cpp 本地转写';
  return '未获得转写';
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s` : `${m}m${String(s).padStart(2, '0')}s`;
}
