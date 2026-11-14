#!/usr/bin/env node
import { createInterface } from 'node:readline';
import process from 'node:process';

import { createStandaloneContext } from './lib/standalone-context.js';
import { createTool, DEFAULTS, TOOL_NAME } from './index.js';

const SERVER_NAME = 'downie-video-analyzer';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_FALLBACK = '2024-11-05';

const settings = { ...DEFAULTS, ...readEnvSettings() };
const cwd = process.env.DOWNIE_VIDEO_CWD || process.cwd();
const ctx = createStandaloneContext({ cwd });
const tool = createTool(ctx, settings);
const pending = new Map();

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let chain = Promise.resolve();

rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${error.message}` } });
    return;
  }

  // Cancellation must not wait behind a long-running tools/call.
  if (message?.method === 'notifications/cancelled') {
    const requestId = message.params?.requestId;
    pending.get(requestId)?.abort();
    return;
  }

  chain = chain
    .then(() => handleMessage(message))
    .catch((error) => {
      if (message?.id !== undefined) {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: String(error?.message || error) },
        });
      }
    });
});

rl.on('close', () => {
  for (const controller of pending.values()) controller.abort();
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function handleMessage(message) {
  if (!message || message.jsonrpc !== '2.0') {
    if (message?.id !== undefined) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Invalid Request' } });
    }
    return;
  }

  const { id, method } = message;
  if (method === 'initialize') {
    const requested = message.params?.protocolVersion;
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: typeof requested === 'string' && requested ? requested : PROTOCOL_FALLBACK,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          'Use downie_video_analyze when the user gives a video URL and wants it summarized, transcribed, or analyzed. ' +
          'The tool downloads through the local Downie Enhanced yt-dlp engine, transcribes with captions or whisper.cpp, ' +
          'samples keyframes, deletes the source media, and returns paths to transcript.md and analysis.md. ' +
          'After the tool returns, read transcriptPath and 2-4 frames if useful, fill in analysisPath, and answer the user.',
      },
    });
    return;
  }

  if (method === 'notifications/initialized') return;

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
            annotations: {
              title: 'Downie Video Analyzer',
              readOnlyHint: false,
              destructiveHint: false,
              openWorldHint: true,
            },
          },
        ],
      },
    });
    return;
  }

  if (method === 'tools/call') {
    await handleToolCall(id, message.params);
    return;
  }

  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

async function handleToolCall(id, params) {
  if (params?.name !== TOOL_NAME) {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: `Unknown tool: ${params?.name || '(missing)'}` }],
        isError: true,
      },
    });
    return;
  }

  const controller = new AbortController();
  if (id !== undefined) pending.set(id, controller);
  try {
    const args = params?.arguments ?? {};
    const value = await tool.execute(args, { signal: controller.signal, agent: undefined });
    const content = tool.output.render(args, value);
    send({
      jsonrpc: '2.0',
      id,
      result: {
        content: Array.isArray(content) && content.length > 0 ? content : [{ type: 'text', text: JSON.stringify(value) }],
        isError: false,
      },
    });
  } catch (error) {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: String(error?.message || error) }],
        isError: true,
      },
    });
  } finally {
    if (id !== undefined) pending.delete(id);
  }
}

function readEnvSettings() {
  const out = {};
  if (process.env.DOWNIE_ROOT) out.downieRoot = process.env.DOWNIE_ROOT;
  if (process.env.DOWNIE_VIDEO_OUTPUT_DIR) out.outputDir = process.env.DOWNIE_VIDEO_OUTPUT_DIR;
  if (process.env.DOWNIE_VIDEO_QUALITY) out.quality = process.env.DOWNIE_VIDEO_QUALITY;
  if (process.env.DOWNIE_VIDEO_LANGUAGE) out.language = process.env.DOWNIE_VIDEO_LANGUAGE;
  if (process.env.DOWNIE_VIDEO_COOKIES_FROM_BROWSER) {
    out.cookiesFromBrowser = process.env.DOWNIE_VIDEO_COOKIES_FROM_BROWSER;
  }
  if (process.env.WHISPER_BIN) out.whisperBin = process.env.WHISPER_BIN;
  if (process.env.WHISPER_MODEL) out.whisperModel = process.env.WHISPER_MODEL;
  if (process.env.WHISPER_MODEL_PATH) out.modelPath = process.env.WHISPER_MODEL_PATH;

  const keepFrames = parseBoolean(process.env.DOWNIE_VIDEO_KEEP_FRAMES);
  if (keepFrames !== undefined) out.keepFrames = keepFrames;
  const maxFrames = Number.parseInt(process.env.DOWNIE_VIDEO_MAX_FRAMES || '', 10);
  if (Number.isFinite(maxFrames)) out.maxFrames = maxFrames;
  return out;
}

function parseBoolean(value) {
  if (value === undefined || value === '') return undefined;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return undefined;
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function shutdown() {
  for (const controller of pending.values()) controller.abort();
  setTimeout(() => process.exit(0), 250).unref();
}
