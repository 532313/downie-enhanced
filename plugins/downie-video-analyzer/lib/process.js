import { createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const STDIO_MAX_BYTES = 16 * 1024 * 1024;

export async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function runCommand(ctx, argv, options = {}) {
  const signal = combineSignals(options.signal, options.timeoutMs);
  const maxBytes = options.maxBytes ?? STDIO_MAX_BYTES;
  let handle;
  try {
    handle = ctx.subprocess.spawn({
      argv,
      cwd: options.cwd ?? process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes },
        stderr: { maxBytes },
      },
      graceMs: 5000,
      signal,
      ...(options.env ? { env: options.env } : {}),
    });
  } catch (error) {
    const result = {
      code: -1,
      signal: null,
      aborted: signal?.aborted === true,
      stdout: '',
      stderr: stringifyError(error),
      error,
    };
    return result;
  }

  const onAbort = () => {
    try {
      handle.terminate();
    } catch {
      // The provider may have already stopped the process.
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const outcome = await handle.done;
    const result = {
      code: outcome?.exitCode ?? -1,
      signal: outcome?.signal ?? null,
      aborted: signal?.aborted === true,
      stdout: readCollected(handle, 'stdout'),
      stderr: readCollected(handle, 'stderr'),
    };
    return result;
  } catch (error) {
    const result = {
      code: -1,
      signal: null,
      aborted: signal?.aborted === true,
      stdout: readCollected(handle, 'stdout'),
      stderr: readCollected(handle, 'stderr') || stringifyError(error),
      error,
    };
    return result;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function readCollected(handle, name) {
  try {
    return handle.collected?.[name]?.readFrom(0)?.text ?? '';
  } catch {
    return '';
  }
}

function stringifyError(error) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

export function combineSignals(parent, timeoutMs) {
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
  if (!parent) return timeout ?? undefined;
  if (!timeout) return parent;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([parent, timeout]);
  return parent;
}

export async function findExecutable(ctx, candidates, command, signal) {
  for (const candidate of candidates) {
    if (candidate && (await pathExists(candidate))) return candidate;
  }
  if (!command) return null;
  try {
    const resolved = await ctx.subprocess.resolveExecutable(command, undefined, signal);
    return resolved || null;
  } catch {
    return null;
  }
}

export async function downloadFile(url, destination, options = {}) {
  const signal = combineSignals(options.signal, options.timeoutMs ?? 30 * 60 * 1000);
  const temporary = `${destination}.part`;
  await mkdir(path.dirname(destination), { recursive: true });
  let response;
  try {
    response = await fetch(url, { signal, redirect: 'follow' });
  } catch (error) {
    throw new Error(`模型下载请求失败：${stringifyError(error)}`);
  }
  if (!response.ok || !response.body) {
    throw new Error(`模型下载失败：HTTP ${response.status} ${response.statusText}`);
  }
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    const info = await stat(temporary);
    if (info.size < 1024 * 1024) {
      throw new Error(`模型文件过小（${info.size} bytes），可能下载到了错误页面。`);
    }
    await rename(temporary, destination);
    return destination;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export async function probeDuration(ctx, ffprobe, file, signal) {
  const result = await runCommand(
    ctx,
    [ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
    { signal, timeoutMs: 60_000 },
  );
  const seconds = Number.parseFloat(result.stdout.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

export async function probeHasAudio(ctx, ffprobe, file, signal) {
  const result = await runCommand(
    ctx,
    [ffprobe, '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file],
    { signal, timeoutMs: 60_000 },
  );
  return result.code === 0 && /audio/i.test(result.stdout);
}

export async function extractAudio(ctx, ffmpeg, video, wavPath, signal) {
  return runCommand(
    ctx,
    [ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath],
    { signal, timeoutMs: 45 * 60 * 1000 },
  );
}

export async function extractFrame(ctx, ffmpeg, video, seconds, destination, signal) {
  return runCommand(
    ctx,
    [
      ffmpeg,
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      seconds.toFixed(3),
      '-i',
      video,
      '-frames:v',
      '1',
      '-vf',
      'scale=640:-2',
      '-q:v',
      '4',
      destination,
    ],
    { signal, timeoutMs: 120_000 },
  );
}

export async function transcribeWithWhisper(ctx, options) {
  const threads = Math.max(1, Math.min(8, os.cpus().length || 1));
  return runCommand(
    ctx,
    [
      options.whisperBin,
      '-m',
      options.modelPath,
      '-l',
      options.language || 'auto',
      '-f',
      options.wavPath,
      '-osrt',
      '-of',
      options.outputPrefix,
      '-np',
      '-t',
      String(threads),
    ],
    { signal: options.signal, timeoutMs: 45 * 60 * 1000, maxBytes: 4 * 1024 * 1024 },
  );
}
