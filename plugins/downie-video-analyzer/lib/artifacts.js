import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MEDIA_EXTENSIONS = new Set([
  '.mp4',
  '.m4v',
  '.mkv',
  '.webm',
  '.mov',
  '.avi',
  '.flv',
  '.ts',
  '.m4a',
  '.mp3',
  '.aac',
  '.opus',
  '.ogg',
  '.flac',
  '.wav',
  '.vtt',
  '.srt',
  '.ass',
  '.lrc',
  '.part',
  '.ytdl',
]);

export async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(target) {
  await mkdir(target, { recursive: true });
  return target;
}

export function safeSegment(value, maxLength = 40) {
  const text = String(value ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return (text || 'video').slice(0, maxLength).replace(/-+$/g, '') || 'video';
}

export function safeId(value) {
  const text = String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  return (text || 'video').slice(0, 60);
}

export function buildDirName(id, title) {
  return `${safeId(id)}-${safeSegment(title)}`;
}

export async function uniqueDir(root, baseName) {
  await ensureDir(root);
  let candidate = path.join(root, baseName);
  let suffix = 2;
  while (await pathExists(candidate)) {
    candidate = path.join(root, `${baseName}-${suffix}`);
    suffix += 1;
    if (suffix > 999) throw new Error('无法为分析结果分配目录名。');
  }
  await ensureDir(candidate);
  return candidate;
}

export async function readText(target) {
  return readFile(target, 'utf8');
}

export async function writeText(target, text) {
  await ensureDir(path.dirname(target));
  await writeFile(target, text, 'utf8');
}

export async function writeJsonAtomic(target, value) {
  await ensureDir(path.dirname(target));
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
}

export async function readJson(target) {
  return JSON.parse(await readText(target));
}

export async function updateIndex(outputRoot, entry) {
  const indexPath = path.join(outputRoot, 'index.json');
  let videos = [];
  try {
    const parsed = await readJson(indexPath);
    if (parsed && Array.isArray(parsed.videos)) videos = parsed.videos;
  } catch {
    videos = [];
  }
  const kept = [];
  for (const item of videos) {
    if (!item || typeof item !== 'object' || typeof item.dir !== 'string') continue;
    const dir = path.resolve(outputRoot, item.dir);
    if (!isInside(dir, outputRoot)) continue;
    if (!(await pathExists(path.join(dir, 'meta.json')))) continue;
    if (item.id !== entry.id) kept.push(item);
  }
  kept.unshift(entry);
  const next = { version: 1, videos: kept.slice(0, 500) };
  await writeJsonAtomic(indexPath, next);
  return next;
}

export async function removeTreeSafe(target, allowedRoot) {
  const root = path.resolve(allowedRoot);
  const resolved = path.resolve(target);
  if (!isInside(resolved, root) || resolved === root) return false;
  let realRoot;
  try {
    realRoot = await realpath(root);
  } catch {
    realRoot = root;
  }
  try {
    const realTarget = await realpath(resolved);
    if (!isInside(realTarget, realRoot) || realTarget === realRoot) return false;
  } catch {
    // Missing target is already clean.
    return true;
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  return true;
}

export async function listMediaFiles(root) {
  const found = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(target);
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      if (MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push(target);
    }
  };
  await walk(root);
  return found;
}

export async function pruneOldTemp(tmpRoot, maxAgeMs = 24 * 60 * 60 * 1000) {
  let entries;
  try {
    entries = await readdir(tmpRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const target = path.join(tmpRoot, entry.name);
    try {
      const info = await stat(target);
      if (info.mtimeMs < cutoff && (await removeTreeSafe(target, tmpRoot))) removed += 1;
    } catch {
      // Best effort only.
    }
  }
  return removed;
}

export async function fileSize(target) {
  try {
    return (await stat(target)).size;
  } catch {
    return 0;
  }
}

export function isInside(target, root) {
  const resolved = path.resolve(target);
  const base = path.resolve(root);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}
