const test = require('node:test');
const assert = require('node:assert/strict');
const { convertASSToVTT, collapseRepeatedCues } = require('./assConverter');

const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

const cs = (n) => {
  const t = n / 100;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(n % 100).padStart(2, '0')}`;
};

function cueTexts(vtt) {
  return vtt.split(/\n{2,}/).filter((b) => b.includes('-->')).map((b) => b.split('\n').slice(1).join(' ').trim());
}

test('frame-by-frame typesetting becomes one cue', () => {
  let events = '';
  // 25 frames of one animated narration line, 4 centiseconds each, from 1:31.60.
  for (let i = 0; i < 25; i += 1) {
    events += `Dialogue: 0,${cs(9160 + i * 4)},${cs(9164 + i * 4)},Default,,0,0,0,,{\\pos(${960 + i},540)}At the far northern edge of the continent,\n`;
  }
  events += `Dialogue: 0,${cs(9300)},${cs(9500)},Default,,0,0,0,,Another line.\n`;
  const result = convertASSToVTT(header + events);
  assert.equal(result.success, true);
  const texts = cueTexts(result.content);
  assert.deepEqual(texts, ['At the far northern edge of the continent,', 'Another line.']);
  assert.match(result.content, /00:01:31\.600 --> 00:01:32\.600/);
});

test('a line written twice on two layers shows once', () => {
  const events = `Dialogue: 1,0:00:05.00,0:00:07.00,Default,,0,0,0,,Hello there.\n`
    + `Dialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,Hello there.\n`
    + `Dialogue: 0,0:00:07.50,0:00:09.00,Default,,0,0,0,,General Kenobi.\n`;
  const result = convertASSToVTT(header + events);
  assert.equal(result.success, true);
  assert.deepEqual(cueTexts(result.content), ['Hello there.', 'General Kenobi.']);
});

test('the same words spoken again later stay separate cues', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nNo!\n\n00:00:05.000 --> 00:00:06.000\nNo!\n';
  assert.equal(collapseRepeatedCues(vtt), vtt);
});

test('content it does not understand is returned unchanged', () => {
  assert.equal(collapseRepeatedCues(''), '');
  assert.equal(collapseRepeatedCues(null), null);
  const odd = 'WEBVTT\n\nnot-a-time --> 00:00:01.000\nx\n\n00:00:01.000 --> 00:00:02.000\nx\n';
  assert.equal(collapseRepeatedCues(odd), odd);
});
