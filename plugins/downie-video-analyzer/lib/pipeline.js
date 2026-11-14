import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readdir } from 'node:fs/promises';

import {
  buildDirName,
  ensureDir,
  listMediaFiles,
  pathExists,
  pruneOldTemp,
  readText,
  removeTreeSafe,
  uniqueDir,
  updateIndex,
  writeJsonAtomic,
  writeText,
} from './artifacts.js';
import {
  downloadFile,
  extractAudio,
  extractFrame,
  findExecutable,
  probeDuration,
  probeHasAudio,
  runCommand,
  transcribeWithWhisper,
} from './process.js';
import {
  cuesToMarkdown,
  cuesToPlainText,
  formatFileTime,
  formatTimestamp,
  parseTranscript,
  parseSrt,
} from './transcript.js';

const VIDEO_ONLY = new Set(['.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.flv', '.ts']);
const SUBTITLE_ONLY = new Set(['.vtt', '.srt']);
const WHISPER_BASES = [
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main',
  'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main',
];

export async function runPipeline({ ctx, settings, args, exec, pluginRoot }) {
  const startedAt = Date.now();
  const warnings = [];
  let outputRoot = null;
  let tmpRoot = null;
  let tmp = null;
  let finalDir = null;
  let meta = null;
  let result = null;
  let failure = null;

  try {
    const cwd = await resolveCwd(ctx, exec);
    const downieRoot = await resolveDownieRoot(ctx, settings, cwd, pluginRoot, warnings);
    outputRoot = settings.outputDir ? path.resolve(cwd, settings.outputDir) : path.join(cwd, '.downie-video');
    await ensureDir(outputRoot);
    tmpRoot = path.join(outputRoot, '.tmp');
    await ensureDir(tmpRoot);
    await pruneOldTemp(tmpRoot);

    const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    tmp = path.join(tmpRoot, runId);
    await ensureDir(tmp);

    const toolchain = await resolveToolchain(ctx, settings, downieRoot, exec.signal, warnings);
    const payload = await downloadVideo({
      ctx,
      pluginRoot,
      downieRoot,
      args,
      tmp,
      toolchain,
      signal: exec.signal,
    });
    const primary = await pickPrimaryMedia(payload, tmp);
    const duration =
      payload.duration > 0
        ? payload.duration
        : toolchain.ffprobe
          ? await probeDuration(ctx, toolchain.ffprobe, primary.path, exec.signal)
          : 0;
    const chapters = normalizeChapters(payload.chapters);

    const analysisName = buildDirName(payload.id, payload.title);
    finalDir = await uniqueDir(outputRoot, analysisName);
    const transcriptPath = path.join(finalDir, 'transcript.md');
    const metaPath = path.join(finalDir, 'meta.json');
    const analysisPath = path.join(finalDir, 'analysis.md');

    const transcript = await resolveTranscript({
      ctx,
      settings,
      args,
      payload,
      tmp,
      outputRoot,
      toolchain,
      duration,
      cwd,
      videoPath: primary.path,
      signal: exec.signal,
      warnings,
    });

    const frames = await sampleFrames({
      ctx,
      args,
      duration,
      videoPath: primary.path,
      finalDir,
      ffmpeg: toolchain.ffmpeg,
      signal: exec.signal,
      warnings,
    });

    const generatedAt = new Date().toISOString();
    const plainText = cuesToPlainText(transcript.cues);
    const transcriptChars = plainText.length;
    const transcriptPreview = buildPreview(plainText);
    const transcriptMd = cuesToMarkdown(transcript.cues, {
      title: payload.title,
      url: payload.webpage_url || args.url,
      language: transcript.language,
      source: transcript.source,
      generatedAt,
    });

    await writeText(transcriptPath, transcriptMd);

    meta = {
      version: 1,
      videoId: String(payload.id || 'video'),
      title: payload.title,
      durationSeconds: round(duration, 3),
      uploader: payload.uploader || '',
      webpageUrl: payload.webpage_url || args.url,
      extractor: payload.extractor || '',
      engine: payload.engine || 'yt-dlp',
      quality: args.quality,
      transcriptSource: transcript.source,
      transcriptLanguage: transcript.language,
      transcriptChars,
      frames: frames.map((frame) => ({
        file: path.relative(finalDir, frame.path),
        timeSeconds: frame.timeSeconds,
      })),
      chapters,
      createdAt: generatedAt,
      sourceDeleted: false,
      warnings: [...warnings],
      elapsedSeconds: 0,
    };
    await writeJsonAtomic(metaPath, meta);

    await writeText(
      analysisPath,
      buildAnalysisSkeleton({
        title: payload.title,
        url: payload.webpage_url || args.url,
        uploader: payload.uploader || '',
        duration,
        transcriptSource: transcript.source,
        transcriptLanguage: transcript.language,
        transcriptChars,
        frames,
        chapters,
        generatedAt,
        analysisDir: finalDir,
      }),
    );

    try {
      await updateIndex(outputRoot, {
        id: String(payload.id || 'video'),
        title: payload.title,
        url: payload.webpage_url || args.url,
        dir: path.relative(outputRoot, finalDir),
        createdAt: generatedAt,
        durationSeconds: round(duration, 3),
        transcriptSource: transcript.source,
        language: transcript.language,
        chars: transcriptChars,
      });
    } catch (error) {
      warnings.push(`索引写入失败：${messageOf(error)}`);
    }

    result = {
      videoId: String(payload.id || 'video'),
      title: payload.title,
      durationSeconds: round(duration, 3),
      uploader: payload.uploader || '',
      webpageUrl: payload.webpage_url || args.url,
      extractor: payload.extractor || '',
      analysisDir: finalDir,
      transcriptPath,
      analysisPath,
      metaPath,
      frames,
      transcriptSource: transcript.source,
      transcriptLanguage: transcript.language,
      transcriptChars,
      transcriptPreview,
      chapters,
      sourceDeleted: false,
      warnings,
      elapsedSeconds: 0,
    };
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const residual = [];
    if (tmp && tmpRoot) {
      try {
        const removed = await removeTreeSafe(tmp, tmpRoot);
        if (!removed || (await pathExists(tmp))) residual.push(tmp);
      } catch (error) {
        warnings.push(`临时目录清理失败：${messageOf(error)}`);
        residual.push(tmp);
      }
    }

    if (finalDir) {
      try {
        const media = await listMediaFiles(finalDir);
        for (const file of media) {
          try {
            await removeTreeSafe(file, finalDir);
          } catch {
            // Re-checked below.
          }
        }
        const remaining = await listMediaFiles(finalDir);
        if (remaining.length > 0) {
          warnings.push(`源文件清理失败，请手动删除：${remaining.join(', ')}`);
          residual.push(...remaining);
        }
      } catch (error) {
        warnings.push(`源文件清理检查失败：${messageOf(error)}`);
        residual.push(finalDir);
      }
    }

    if (!args.keepFrames && finalDir) {
      try {
        await removeTreeSafe(path.join(finalDir, 'frames'), finalDir);
      } catch {
        // Frames are not source media; a remainer here is harmless.
      }
    }

    const sourceDeleted = residual.length === 0;
    const elapsedSeconds = round((Date.now() - startedAt) / 1000, 1);

    if (result) {
      result.sourceDeleted = sourceDeleted;
      result.warnings = warnings;
      result.elapsedSeconds = elapsedSeconds;
    }
    if (meta && finalDir) {
      try {
        meta.sourceDeleted = sourceDeleted;
        meta.warnings = [...warnings];
        meta.elapsedSeconds = elapsedSeconds;
        await writeJsonAtomic(path.join(finalDir, 'meta.json'), meta);
      } catch (error) {
        warnings.push(`元数据更新失败：${messageOf(error)}`);
      }
    }

    if (failure) {
      if (finalDir) {
        try {
          if (!(await pathExists(path.join(finalDir, 'meta.json')))) {
            await removeTreeSafe(finalDir, outputRoot ?? path.dirname(finalDir));
          }
        } catch {
          // Keep the original failure.
        }
      }
      if (failure instanceof Error) {
        const suffix = sourceDeleted
          ? '临时文件与源媒体已清理。'
          : `仍有残留文件：${residual.join(', ')}`;
        failure.message = `${failure.message}（${suffix}）`;
      }
    }
  }
}

async function resolveCwd(ctx, exec) {
  try {
    if (exec.agent) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      if (cwd) return cwd;
    }
  } catch {
    // Fall through to the configured default.
  }
  try {
    if (ctx.workingDirectory.defaultDirectory) return ctx.workingDirectory.defaultDirectory;
  } catch {
    // Fall through to the process cwd.
  }
  return process.cwd();
}

async function resolveDownieRoot(ctx, settings, cwd, pluginRoot, warnings) {
  const looksRight = (candidate) => pathExists(path.join(candidate, 'backend', 'app', 'core', 'ytdlp_service.py'));

  if (settings.downieRoot) {
    const explicit = path.resolve(cwd, settings.downieRoot);
    if (await looksRight(explicit)) return explicit;
    warnings.push(`配置的 downieRoot 不包含 backend/app/core/ytdlp_service.py：${explicit}`);
  }

  let current = path.resolve(cwd);
  for (let depth = 0; depth < 12; depth += 1) {
    if (await looksRight(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  if (pluginRoot) {
    const fromPlugin = path.resolve(pluginRoot, '..', '..');
    if (await looksRight(fromPlugin)) return fromPlugin;
  }

  throw new Error(
    '未找到 Downie Enhanced 项目根目录（需要 backend/app/core/ytdlp_service.py）。请在插件配置中设置 downieRoot，或在项目目录内使用。',
  );
}

async function resolveToolchain(ctx, settings, downieRoot, signal, warnings) {
  const pythonCandidates = [
    path.join(downieRoot, '.venv', 'bin', 'python'),
    path.join(downieRoot, 'venv', 'bin', 'python'),
  ];
  const python = await findExecutable(ctx, pythonCandidates, 'python3', signal);
  if (!python) throw new Error('未找到 Python 解释器（尝试了项目 .venv 和 python3）。');

  const ffmpeg = await findExecutable(
    ctx,
    ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'],
    'ffmpeg',
    signal,
  );
  if (!ffmpeg) throw new Error('未找到 ffmpeg，请先安装 FFmpeg。');

  let ffprobe = await findExecutable(
    ctx,
    ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe'],
    'ffprobe',
    signal,
  );
  if (!ffprobe) {
    const sibling = path.join(path.dirname(ffmpeg), 'ffprobe');
    if (await pathExists(sibling)) ffprobe = sibling;
  }
  if (!ffprobe) warnings.push('未找到 ffprobe，关键帧和时长探测可能失败。');

  const whisper = await findExecutable(ctx, [settings.whisperBin].filter(Boolean), 'whisper-cli', signal);
  if (!whisper) warnings.push('未找到 whisper-cli；若视频没有站点字幕，将无法转写。');

  return { python, ffmpeg, ffprobe, whisper };
}

async function downloadVideo({ ctx, pluginRoot, downieRoot, args, tmp, toolchain, signal }) {
  const script = path.join(pluginRoot, 'scripts', 'downie_fetch.py');
  if (!(await pathExists(script))) throw new Error(`下载适配器不存在：${script}`);

  const argv = [
    toolchain.python,
    script,
    '--url',
    args.url,
    '--outdir',
    tmp,
    '--quality',
    args.quality,
    '--subtitles',
    '--downie-root',
    downieRoot,
  ];
  if (args.cookiesFromBrowser) argv.push('--cookies-from-browser', args.cookiesFromBrowser);

  const response = await runCommand(ctx, argv, {
    cwd: downieRoot,
    signal,
    timeoutMs: 50 * 60 * 1000,
    maxBytes: 32 * 1024 * 1024,
  });
  const payload = parseJsonOutput(response.stdout);

  if (response.aborted) throw new Error('下载已取消。');
  if (response.code !== 0 || !payload?.ok) {
    const detail =
      payload?.error ||
      firstLine(response.stderr) ||
      `下载器退出码 ${response.code}，没有返回可读错误。`;
    throw new Error(`视频下载失败：${detail}`);
  }
  return payload;
}

function parseJsonOutput(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function pickPrimaryMedia(payload, tmp) {
  const media = [];
  for (const item of payload.media ?? []) {
    if (item && typeof item.path === 'string' && (await pathExists(item.path))) media.push(item);
  }
  if (media.length === 0) {
    let entries = [];
    try {
      entries = await readdir(tmp, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const target = path.join(tmp, entry.name);
      media.push({ path: target, ext: path.extname(target).toLowerCase(), size: 0 });
    }
  }
  const videos = media.filter((item) => VIDEO_ONLY.has(String(item.ext || path.extname(item.path)).toLowerCase()));
  const chosen = (videos.length > 0 ? videos : media).sort((a, b) => (b.size || 0) - (a.size || 0))[0];
  if (!chosen) throw new Error('下载后没有找到可分析的媒体文件。');
  return chosen;
}

async function resolveTranscript({
  ctx,
  settings,
  args,
  payload,
  tmp,
  outputRoot,
  toolchain,
  cwd,
  videoPath,
  signal,
  warnings,
}) {
  if (!args.forceTranscribe) {
    const caption = await pickCaption(payload.subtitles, args.language);
    if (caption) {
      try {
        const cues = parseTranscript(await readText(caption.path));
        if (cuesToPlainText(cues).length >= 20) {
          return { cues, source: 'captions', language: caption.lang || 'unknown' };
        }
        warnings.push(`站点字幕内容过短，改用 whisper：${path.basename(caption.path)}`);
      } catch (error) {
        warnings.push(`站点字幕解析失败，改用 whisper：${messageOf(error)}`);
      }
    }
  }

  if (!toolchain.whisper) {
    warnings.push('没有可用的 whisper-cli，保留无转写结果。');
    return { cues: [], source: 'none', language: args.language };
  }
  if (!toolchain.ffprobe) {
    warnings.push('没有 ffprobe，无法确认音频流，跳过 whisper。');
    return { cues: [], source: 'none', language: args.language };
  }
  const hasAudio = await probeHasAudio(ctx, toolchain.ffprobe, videoPath, signal);
  if (!hasAudio) {
    warnings.push('视频没有音频流，跳过 whisper。');
    return { cues: [], source: 'none', language: args.language };
  }

  const model = await resolveWhisperModel({ ctx, settings, cwd, outputRoot, signal, warnings });
  if (!model) return { cues: [], source: 'none', language: args.language };

  const wavPath = path.join(tmp, 'audio.wav');
  const audio = await extractAudio(ctx, toolchain.ffmpeg, videoPath, wavPath, signal);
  if (audio.code !== 0) {
    warnings.push(`音频提取失败，无法 whisper：${firstLine(audio.stderr)}`);
    return { cues: [], source: 'none', language: args.language };
  }

  const prefix = path.join(tmp, 'transcript');
  const transcription = await transcribeWithWhisper(ctx, {
    whisperBin: toolchain.whisper,
    modelPath: model,
    language: args.language,
    wavPath,
    outputPrefix: prefix,
    signal,
  });
  if (transcription.code !== 0) {
    warnings.push(`whisper 转写失败：${firstLine(transcription.stderr)}`);
    return { cues: [], source: 'none', language: args.language };
  }

  try {
    const cues = parseSrt(await readText(`${prefix}.srt`));
    if (cuesToPlainText(cues).length < 20) {
      warnings.push('whisper 输出为空或过短。');
      return { cues: [], source: 'none', language: args.language };
    }
    return {
      cues,
      source: 'whisper',
      language: args.language === 'auto' ? 'auto' : args.language,
    };
  } catch (error) {
    warnings.push(`whisper 输出读取失败：${messageOf(error)}`);
    return { cues: [], source: 'none', language: args.language };
  }
}

async function pickCaption(subtitles, language) {
  const entries = [];
  for (const item of subtitles ?? []) {
    if (!item || typeof item.path !== 'string') continue;
    if (!SUBTITLE_ONLY.has(path.extname(item.path).toLowerCase())) continue;
    if (!(await pathExists(item.path))) continue;
    entries.push(item);
  }
  if (entries.length === 0) return null;

  const wanted = String(language || 'auto').toLowerCase();
  const score = (item) => {
    let value = item.manual ? 0 : 10;
    const lang = String(item.lang || '').toLowerCase();
    if (wanted !== 'auto') {
      if (lang === wanted || lang.startsWith(`${wanted}-`)) value -= 5;
      else value += 5;
    } else if (['zh-hans', 'zh-cn', 'zh', 'en'].includes(lang)) {
      value -= 2;
    }
    return value;
  };
  entries.sort((a, b) => score(a) - score(b));
  return entries[0];
}

async function resolveWhisperModel({ ctx, settings, cwd, outputRoot, signal, warnings }) {
  if (settings.modelPath) {
    const explicit = expandPath(cwd, settings.modelPath);
    if (await pathExists(explicit)) return explicit;
    warnings.push(`配置的 whisper 模型不存在：${explicit}`);
    return null;
  }

  const rawName = String(settings.whisperModel || 'base').trim();
  if (rawName.endsWith('.bin')) {
    const explicit = expandPath(cwd, rawName);
    if (await pathExists(explicit)) return explicit;
  }
  const name = rawName.replace(/[^A-Za-z0-9._-]/g, '') || 'base';
  const modelsDir = path.join(outputRoot, 'models');
  const destination = path.join(modelsDir, `ggml-${name}.bin`);
  if (await pathExists(destination)) return destination;

  await ensureDir(modelsDir);
  warnings.push(`首次使用 whisper 模型 ggml-${name}.bin，正在下载（约 148 MB）。`);
  for (const base of WHISPER_BASES) {
    const url = `${base}/ggml-${encodeURIComponent(name)}.bin`;
    try {
      await downloadFile(url, destination, { signal, timeoutMs: 30 * 60 * 1000 });
      warnings.push(`whisper 模型已缓存：${destination}`);
      return destination;
    } catch (error) {
      warnings.push(`模型下载源失败（${base}）：${messageOf(error)}`);
    }
  }
  return null;
}

async function sampleFrames({ ctx, args, duration, videoPath, finalDir, ffmpeg, signal, warnings }) {
  if (!args.keepFrames || args.maxFrames <= 0 || !(duration > 0)) return [];
  const count = Math.min(args.maxFrames, Math.max(1, Math.floor(duration / 30)));
  const framesDir = path.join(finalDir, 'frames');
  await ensureDir(framesDir);
  const frames = [];
  let frameFailures = 0;
  for (let index = 0; index < count; index += 1) {
    if (signal?.aborted) throw new Error('已取消。');
    const seconds = (duration * (index + 0.5)) / count;
    const filename = `frame-${String(index + 1).padStart(2, '0')}-${formatFileTime(seconds)}.jpg`;
    const destination = path.join(framesDir, filename);
    const result = await extractFrame(ctx, ffmpeg, videoPath, seconds, destination, signal);
    if (result.code !== 0) {
      frameFailures += 1;
      if (frameFailures === 1) warnings.push(`关键帧采样失败：${firstLine(result.stderr)}`);
      continue;
    }
    frames.push({ path: destination, timeSeconds: round(seconds, 2) });
  }
  if (frameFailures > 0) warnings.push(`共有 ${frameFailures} 个关键帧采样失败。`);
  return frames;
}

function buildAnalysisSkeleton({
  title,
  url,
  uploader,
  duration,
  transcriptSource,
  transcriptLanguage,
  transcriptChars,
  frames,
  chapters,
  generatedAt,
  analysisDir,
}) {
  const lines = [
    `# ${title}`,
    '',
    '> 这是自动生成的骨架。模型应先读取同目录的 `transcript.md`，必要时查看 `frames/`，再把下面各节补全成真正的分析。',
    '',
    `- 原视频：${url}`,
    `- 上传者：${uploader || '未知'}`,
    `- 时长：${formatTimestamp(duration)}`,
    `- 转写方式：${transcriptSource}`,
    `- 转写语言：${transcriptLanguage}`,
    `- 转写字数：${transcriptChars}`,
    `- 生成时间：${generatedAt}`,
    `- 转写文件：[transcript.md](transcript.md)`,
    `- 元数据：[meta.json](meta.json)`,
    '',
    '## 一句话概览',
    '<!-- 待填写：用 1–2 句话说明视频讲了什么、适合谁看。 -->',
    '',
    '## 内容结构',
  ];
  if (chapters.length > 0) {
    for (const chapter of chapters) lines.push(`- [${formatTimestamp(chapter.startSeconds)}] ${chapter.title || '未命名章节'}`);
  } else {
    lines.push('<!-- 待填写：按时间顺序拆成 3–8 个段落。 -->');
  }
  lines.push(
    '',
    '## 关键要点',
    '<!-- 待填写：每条要点尽量带时间戳；区分事实、观点和例子。 -->',
    '',
    '## 金句与时间戳',
    '<!-- 待填写：引用原文短句，并标注出现时间。 -->',
    '',
    '## 结论 / 可深入问题',
    '<!-- 待填写：总结结论，列出 2–5 个值得继续追问的问题。 -->',
    '',
    '## 原始资料',
    '- [完整转写](transcript.md)',
    '- [元数据](meta.json)',
  );
  if (frames.length > 0) {
    lines.push('- 关键帧：');
    for (const frame of frames) {
      lines.push(`  - [${formatTimestamp(frame.timeSeconds)}](${path.relative(analysisDir, frame.path)})`);
    }
  } else {
    lines.push('- 关键帧：未保留');
  }
  lines.push('', '---', '_由 downie-video-analyzer 生成。源视频、音频和字幕已在分析后删除。_', '');
  return lines.join('\n');
}

function normalizeChapters(chapters) {
  if (!Array.isArray(chapters)) return [];
  return chapters
    .filter((chapter) => chapter && Number.isFinite(Number(chapter.startSeconds)))
    .map((chapter) => ({
      startSeconds: Number(chapter.startSeconds),
      title: String(chapter.title || ''),
    }))
    .sort((a, b) => a.startSeconds - b.startSeconds);
}

function buildPreview(text) {
  const compact = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (compact.length <= 800) return compact;
  return `${compact.slice(0, 800)}…`;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function firstLine(text) {
  const line = String(text ?? '').trim().split('\n').find((entry) => entry.trim());
  return line ? line.trim().slice(0, 500) : '';
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function expandPath(base, value) {
  const raw = String(value ?? '').trim();
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(base, raw);
}
