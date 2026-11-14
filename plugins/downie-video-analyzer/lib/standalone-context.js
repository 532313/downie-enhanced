import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const KILL_GRACE_MS = 5000;

/**
 * Minimal stand-in for the DSH host services used by lib/pipeline.js.
 * It lets the exact same analysis pipeline run from a normal Node process,
 * such as the Codex MCP server.
 */
export function createStandaloneContext({ cwd = process.cwd(), env = process.env } = {}) {
  const defaultDirectory = path.resolve(cwd);

  return {
    workingDirectory: {
      defaultDirectory,
      async ensure() {
        return defaultDirectory;
      },
      get() {
        return defaultDirectory;
      },
    },
    subprocess: {
      spawn(spec) {
        return spawnCompat(spec, { defaultDirectory, env });
      },
      async resolveExecutable(command, extraEnv, _signal) {
        if (!command) return null;
        if (command.includes('/')) {
          try {
            await access(command, constants.X_OK);
            return command;
          } catch {
            return null;
          }
        }
        const pathValue = (extraEnv && extraEnv.PATH) || env.PATH || '';
        for (const directory of pathValue.split(path.delimiter)) {
          if (!directory) continue;
          const candidate = path.join(directory, command);
          try {
            await access(candidate, constants.X_OK);
            return candidate;
          } catch {
            // Try the next PATH entry.
          }
        }
        return null;
      },
    },
  };
}

function spawnCompat(spec, { defaultDirectory, env }) {
  const argv = Array.isArray(spec?.argv) ? spec.argv : [];
  if (argv.length === 0) throw new Error('subprocess.spawn: argv is empty');

  const maxStdout = maxBytesFor(spec, 'stdout');
  const maxStderr = maxBytesFor(spec, 'stderr');
  const child = spawn(argv[0], argv.slice(1), {
    cwd: spec.cwd || defaultDirectory,
    env: { ...env, ...(spec.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const buffers = {
    stdout: { text: '', bytes: 0, lossy: false, maxBytes: maxStdout },
    stderr: { text: '', bytes: 0, lossy: false, maxBytes: maxStderr },
  };
  collect(child.stdout, buffers.stdout);
  collect(child.stderr, buffers.stderr);

  let settle;
  const done = new Promise((resolve) => {
    settle = resolve;
  });
  let finished = false;
  const finish = (outcome) => {
    if (finished) return;
    finished = true;
    settle(outcome);
  };

  child.once('error', (error) => {
    appendChunk(buffers.stderr, String(error?.stack || error));
    finish({ exitCode: -1, signal: null, error: String(error?.message || error) });
  });
  child.once('close', (code, signal) => {
    finish({ exitCode: typeof code === 'number' ? code : -1, signal: signal || null });
  });

  let killTimer = null;
  const terminate = () => {
    if (finished) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // Process may already be gone.
    }
    killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Process may already be gone.
      }
    }, KILL_GRACE_MS);
    killTimer.unref?.();
  };

  return {
    stdout: child.stdout,
    stderr: child.stderr,
    collected: {
      stdout: { readFrom: (offset) => readFrom(buffers.stdout, offset) },
      stderr: { readFrom: (offset) => readFrom(buffers.stderr, offset) },
    },
    done,
    terminate,
    waitForExit() {
      return done;
    },
  };
}

function collect(stream, buffer) {
  if (!stream) return;
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => appendChunk(buffer, chunk));
}

function appendChunk(buffer, chunk) {
  const text = String(chunk);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (buffer.bytes + bytes <= buffer.maxBytes) {
    buffer.text += text;
    buffer.bytes += bytes;
    return;
  }
  const remaining = Math.max(0, buffer.maxBytes - buffer.bytes);
  if (remaining > 0) {
    buffer.text += Buffer.from(text, 'utf8').subarray(0, remaining).toString('utf8');
    buffer.bytes = buffer.maxBytes;
  }
  buffer.lossy = true;
}

function readFrom(buffer, offset) {
  const start = Math.max(0, Number(offset) || 0);
  return {
    text: start < buffer.text.length ? buffer.text.slice(start) : '',
    nextOffset: buffer.text.length,
    lossy: buffer.lossy,
  };
}

function maxBytesFor(spec, name) {
  const stdio = spec?.stdio?.[name];
  if (stdio && typeof stdio === 'object' && Number.isFinite(stdio.maxBytes)) {
    return Math.max(1024, stdio.maxBytes);
  }
  return 16 * 1024 * 1024;
}
