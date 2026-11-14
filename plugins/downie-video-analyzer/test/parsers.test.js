import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDirName, safeSegment } from '../lib/artifacts.js';
import {
  cuesToPlainText,
  formatFileTime,
  formatTimestamp,
  mergeRollingCues,
  parseSrt,
  parseVtt,
  timestampToSeconds,
} from '../lib/transcript.js';

const VTT = `WEBVTT

NOTE this line is ignored
00:00:01.000 --> 00:00:03.000
<v Speaker>你好</v> &amp; 世界

00:00:03.000 --> 00:00:05.000
你好 &amp; 世界

00:00:05.000 --> 00:00:07.000
我们
00:00:07.000 --> 00:00:09.000
我们开始
`;

test('parseVtt strips markup, decodes entities and merges duplicates', () => {
  const cues = parseVtt(VTT);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, '你好 & 世界');
  assert.equal(cues[0].start, 1);
  assert.equal(cues[1].text, '我们开始');
  assert.equal(cues[1].start, 5);
});

test('parseSrt reads comma timestamps and multiline cues', () => {
  const cues = parseSrt(`1
00:00:01,500 --> 00:00:03,000
第一句
续行

2
00:01:02,000 --> 00:01:04,000
第二句
`);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, '第一句 续行');
  assert.equal(cues[0].start, 1.5);
  assert.equal(cues[1].start, 62);
});

test('timestamp helpers handle hours and compact frame names', () => {
  assert.equal(timestampToSeconds('01:02:03.500'), 3723.5);
  assert.equal(timestampToSeconds('02:03'), 123);
  assert.equal(formatTimestamp(3723), '01:02:03');
  assert.equal(formatTimestamp(0), '00:00:00');
  assert.equal(formatFileTime(3661), '01-01-01');
});

test('mergeRollingCues keeps one growing caption with the latest end', () => {
  const cues = mergeRollingCues([
    { start: 1, end: 2, text: '今天' },
    { start: 2, end: 3, text: '今天我们' },
    { start: 3, end: 4, text: '今天我们来聊' },
    { start: 4, end: 5, text: '另一个话题' },
  ]);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, '今天我们来聊');
  assert.equal(cues[0].end, 4);
  assert.equal(cues[1].text, '另一个话题');
  assert.equal(cuesToPlainText(cues), '今天我们来聊\n另一个话题');
});

test('safeSegment and buildDirName keep Chinese and drop unsafe characters', () => {
  assert.equal(safeSegment(' Hello: World / 你好 '), 'Hello-World-你好');
  assert.equal(safeSegment('///'), 'video');
  assert.equal(buildDirName('abc:123', 'Hello: World'), 'abc123-Hello-World');
  assert.equal(buildDirName('', 'Hello'), 'video-Hello');
});
