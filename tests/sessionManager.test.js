const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_SESSION_BRIEF_BATCH,
  normalizeSessionBriefTokens
} = require('../src/utils/sessionBriefBatch');

const TOKENS = Array.from({ length: MAX_SESSION_BRIEF_BATCH + 4 }, (_, index) => `${index.toString(16).padStart(32, 'a')}`.slice(-32));

test('normalizeSessionBriefTokens filters invalid entries, dedupes, and caps the batch size', () => {
  const result = normalizeSessionBriefTokens([
    TOKENS[0],
    TOKENS[0].toUpperCase(),
    'not-a-token',
    '',
    ...TOKENS.slice(1)
  ]);

  assert.equal(result.length, MAX_SESSION_BRIEF_BATCH);
  assert.deepEqual(result, TOKENS.slice(0, MAX_SESSION_BRIEF_BATCH));
});

test('normalizeSessionBriefTokens respects an explicit lower max token limit', () => {
  const result = normalizeSessionBriefTokens(TOKENS, 3);
  assert.deepEqual(result, TOKENS.slice(0, 3));
});
