const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_TO_FILE = 'false';
process.env.LOG_LEVEL = 'error';

const { preprocessASS, postprocessVTT, validateVTT, convertASSToVTT } = require('../src/utils/assConverter');
const { convertSubtitleToVtt } = require('../src/utils/archiveExtractor');
const { parseSRT, convertToSRT, validateSRT } = require('../src/utils/subtitle');

const assWithBlankEventLines = `\uFEFF[Script Info]
Title: Sample

ScriptType: v4.00+
WrapStyle: 0

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,Strikeout,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,Trebuchet MS,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,0010,0010,0018,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text

Dialogue: 0,0:00:01.70,0:00:04.94,Default,Speaker,0000,0000,0000,,Under Jujutsu regulations, Itadori Yuuji,

Dialogue: 0,0:00:05.55,0:00:07.87,Default,Speaker,0000,0000,0000,,More importantly, you and I \\Nare both pretty beat up.
Dialogue: 0,0:00:07.87,0:00:10.00,Default,Sign,0000,0000,0000,,{\\pos(320,240)}Sugisawa Hospital
`;

test('preprocessASS removes blank lines inside the Events section', () => {
  const preprocessed = preprocessASS(assWithBlankEventLines, 'ass');
  const eventsSection = preprocessed.slice(preprocessed.indexOf('[Events]'));

  assert.match(eventsSection, /\[Events\]\nFormat: .*?\nDialogue:/s);
  assert.doesNotMatch(eventsSection, /\n\s*\n/);
});

test('convertASSToVTT returns valid cues for ASS files with blank lines in Events', () => {
  const result = convertASSToVTT(assWithBlankEventLines, 'ass');

  assert.equal(result.success, true);
  assert.ok(result.content);
  assert.match(result.content, /^WEBVTT/m);
  assert.match(result.content, /00:00:01\.700 --> 00:00:04\.940/);
  assert.match(result.content, /Under Jujutsu regulations, Itadori Yuuji,/);
  assert.match(result.content, /Sugisawa Hospital/);
  assert.doesNotMatch(result.content, /\bundefined\b/i);
  assert.doesNotMatch(result.content, /(?:^|\n)\d+\n(?=\d{2}:\d{2}:\d{2}\.\d{3}\s*-->)/);
});

test('postprocessVTT strips numeric cue ids and undefined rows from subsrt-ts style output', () => {
  const rawVtt = `WEBVTT\r\n\r\nundefined\r\n\r\n11\r\n00:00:01.700 --> 00:00:04.940\r\nFirst line\r\n\r\n12\r\n00:00:05.550 --> 00:00:07.870\r\nSecond line\r\n`;
  const processed = postprocessVTT(rawVtt);

  assert.match(processed, /^WEBVTT\n\n00:00:01\.700 --> 00:00:04\.940/m);
  assert.doesNotMatch(processed, /\bundefined\b/i);
  assert.doesNotMatch(processed, /(?:^|\n)\d+\n(?=\d{2}:\d{2}:\d{2}\.\d{3}\s*-->)/);
});

test('convertSubtitleToVtt rejects invalid subsrt-ts output and returns valid VTT', async () => {
  const converted = await convertSubtitleToVtt(assWithBlankEventLines, 'sample.ass', 'TestProvider');

  assert.equal(typeof converted, 'string');
  assert.match(converted, /^WEBVTT/m);
  assert.match(converted, /00:00:01\.700 --> 00:00:04\.940/);
  assert.match(converted, /More importantly, you and I/);
  assert.doesNotMatch(converted, /\bundefined\b/i);
  assert.doesNotMatch(converted, /(?:^|\n)\d+\n(?=\d{2}:\d{2}:\d{2}\.\d{3}\s*-->)/);
});

test('convertToSRT returns valid SRT for the same ASS sample', () => {
  const converted = convertToSRT(assWithBlankEventLines, '[Test]');
  const entries = parseSRT(converted);

  assert.equal(validateSRT(converted), true);
  assert.match(converted, /1\n00:00:01,700 --> 00:00:04,940/);
  assert.match(converted, /Under Jujutsu regulations, Itadori Yuuji,/);
  assert.match(converted, /Sugisawa Hospital/);
  assert.deepEqual(entries.map(entry => entry.id), [1, 2, 3]);
});

test('validateVTT rejects cue-id-only VTT with no subtitle text', () => {
  const cueIdOnlyVtt = `WEBVTT

11
00:00:01.700 --> 00:00:04.940

12
00:00:05.550 --> 00:00:07.870
`;

  assert.equal(validateVTT(cueIdOnlyVtt), false);
});
