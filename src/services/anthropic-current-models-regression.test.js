'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const AnthropicProvider = require('./providers/anthropic');
const { getClaudeRequestCapabilities, parseClaudeModelId } = require('./providers/anthropic');

const SAMPLE_SRT = '1\n00:00:01,000 --> 00:00:02,000\nBonjour\n';

function buildBody(model, options = {}) {
  const provider = new AnthropicProvider({
    apiKey: 'test-key',
    model,
    maxRetries: 0,
    ...options
  });
  return provider.buildRequestBody(SAMPLE_SRT, 'Bulgarian');
}

function isAssistantPrefill(body) {
  const last = body.messages[body.messages.length - 1];
  return last.role === 'assistant';
}

async function withMockedPost(responses, fn) {
  const originalPost = axios.post;
  const requests = [];
  axios.post = async (url, body) => {
    requests.push(JSON.parse(JSON.stringify(body)));
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  try {
    return { result: await fn(), requests };
  } finally {
    axios.post = originalPost;
  }
}

function apiError(status, message) {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, data: { type: 'error', error: { type: 'invalid_request_error', message } } };
  return err;
}

test('parses current and Claude 3 model ids', () => {
  assert.deepEqual(parseClaudeModelId('claude-opus-5-5'), { family: 'opus', major: 5, minor: 5 });
  assert.deepEqual(parseClaudeModelId('claude-sonnet-4-20250514'), { family: 'sonnet', major: 4, minor: 0 });
  assert.deepEqual(parseClaudeModelId('claude-haiku-4-5-20251001'), { family: 'haiku', major: 4, minor: 5 });
  assert.deepEqual(parseClaudeModelId('claude-sonnet-5'), { family: 'sonnet', major: 5, minor: 0 });
  assert.deepEqual(parseClaudeModelId('claude-3-5-sonnet-20241022'), { family: 'sonnet', major: 3, minor: 5 });
  assert.deepEqual(parseClaudeModelId('claude-3-haiku-20240307'), { family: 'haiku', major: 3, minor: 0 });
  assert.equal(parseClaudeModelId('my-proxy-alias'), null);
});

for (const model of [
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-haiku-5-5',
  'claude-fable-5-2',
  'claude-mythos-5-2'
]) {
  test(`${model}: no sampling parameters and no assistant prefill`, () => {
    const { body, usedJsonPrefill } = buildBody(model, { enableJsonOutput: true, temperature: 0.4, topP: 0.95 });
    assert.equal('temperature' in body, false);
    assert.equal('top_p' in body, false);
    assert.equal('top_k' in body, false);
    assert.equal('thinking' in body, false);
    assert.equal(isAssistantPrefill(body), false);
    assert.equal(usedJsonPrefill, false);
  });
}

test('current models use adaptive thinking when a thinking budget is configured', () => {
  const { body } = buildBody('claude-opus-5-5', { thinkingBudget: 4096 });
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.equal('temperature' in body, false);
});

test('Claude 4.6 and earlier 4.x models send temperature without top_p', () => {
  for (const model of ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-20250514']) {
    const { body } = buildBody(model, { temperature: 0.4, topP: 0.95 });
    assert.equal(body.temperature, 0.4, model);
    assert.equal('top_p' in body, false, model);
  }
});

test('Claude 4.x keeps budget thinking', () => {
  const { body } = buildBody('claude-sonnet-4-6', { thinkingBudget: 4096 });
  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 4096 });
  assert.equal(body.temperature, 1);
});

test('assistant prefill is skipped on Sonnet/Opus 4.6 and kept on Haiku 4.5', () => {
  assert.equal(isAssistantPrefill(buildBody('claude-sonnet-4-6', { enableJsonOutput: true }).body), false);
  assert.equal(isAssistantPrefill(buildBody('claude-opus-4-6', { enableJsonOutput: true }).body), false);
  assert.equal(isAssistantPrefill(buildBody('claude-haiku-4-5', { enableJsonOutput: true }).body), true);
});

test('Claude 3 and unrecognized ids keep the original request shape', () => {
  for (const model of ['claude-3-5-sonnet-20241022', 'my-proxy-alias']) {
    const { body } = buildBody(model, { temperature: 0.4, topP: 0.95 });
    assert.equal(body.temperature, 0.4, model);
    assert.equal(body.top_p, 0.95, model);
  }
});

test('API version 2026-10-21 drops sampling parameters on every model', () => {
  assert.equal(getClaudeRequestCapabilities('claude-3-5-sonnet-20241022', '2026-10-21').sampling, 'none');
  assert.equal(getClaudeRequestCapabilities('claude-sonnet-4-6', '2023-06-01').sampling, 'temperature');
});

test('retries without sampling parameters when an unrecognized model rejects them', async () => {
  const provider = new AnthropicProvider({ apiKey: 'k', model: 'my-proxy-alias', maxRetries: 2 });
  const { result, requests } = await withMockedPost([
    apiError(400, 'temperature: this parameter is not supported for this model'),
    { data: { content: [{ type: 'text', text: SAMPLE_SRT }] } }
  ], () => provider.translateSubtitle(SAMPLE_SRT, 'French', 'Bulgarian'));

  assert.equal(requests.length, 2);
  assert.equal(requests[0].temperature, 0.4);
  assert.equal('temperature' in requests[1], false);
  assert.equal('top_p' in requests[1], false);
  assert.equal(result, SAMPLE_SRT.trim());
});

test('retries with adaptive thinking when budget_tokens is rejected', async () => {
  const provider = new AnthropicProvider({ apiKey: 'k', model: 'my-proxy-alias', maxRetries: 2, thinkingBudget: 2048 });
  const { requests } = await withMockedPost([
    apiError(400, 'thinking.type.enabled is not supported for this model. Use thinking.type.adaptive and output_config.effort instead.'),
    { data: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: SAMPLE_SRT }] } }
  ], () => provider.translateSubtitle(SAMPLE_SRT, 'French', 'Bulgarian'));

  assert.deepEqual(requests[0].thinking, { type: 'enabled', budget_tokens: 2048 });
  assert.deepEqual(requests[1].thinking, { type: 'adaptive' });
});

test('JSON output only gets a "[" prepended when the prefill was actually sent', async () => {
  const json = '[{"id":1,"text":"Здравей"}]';

  const current = new AnthropicProvider({ apiKey: 'k', model: 'claude-opus-5-5', maxRetries: 0, enableJsonOutput: true });
  const currentRun = await withMockedPost([
    { data: { content: [{ type: 'text', text: json }] } }
  ], () => current.translateSubtitle(SAMPLE_SRT, 'French', 'Bulgarian'));
  assert.equal(currentRun.result, json);

  const legacy = new AnthropicProvider({ apiKey: 'k', model: 'claude-haiku-4-5', maxRetries: 0, enableJsonOutput: true });
  const legacyRun = await withMockedPost([
    { data: { content: [{ type: 'text', text: json.slice(1) }] } }
  ], () => legacy.translateSubtitle(SAMPLE_SRT, 'French', 'Bulgarian'));
  assert.equal(legacyRun.result, json);
});
