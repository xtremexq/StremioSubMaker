'use strict';

function normalizeGeminiModelId(modelName) {
  return String(modelName || '').trim().replace(/^models\//i, '').toLowerCase();
}

function isGemini3Model(modelName) {
  const modelId = normalizeGeminiModelId(modelName);
  return /^gemini-3(?:[.-]|$)/i.test(modelId)
    || /^gemini-(?:flash|flash-lite|pro)-latest$/i.test(modelId);
}

function parseBooleanSetting(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

/**
 * Resolve whether legacy Gemini sampling controls should be sent.
 * Gemini 3.x is always forced off because Google requires these fields to be
 * omitted. Older Gemini and Gemma models remain backwards compatible while
 * allowing users to opt into the model's own defaults.
 */
function resolveGeminiSamplingParametersEnabled(modelName, requestedValue, fallback = true) {
  if (isGemini3Model(modelName)) return false;

  const requested = parseBooleanSetting(requestedValue);
  if (requested !== undefined) return requested;

  const fallbackValue = parseBooleanSetting(fallback);
  return fallbackValue !== undefined ? fallbackValue : true;
}

module.exports = {
  normalizeGeminiModelId,
  isGemini3Model,
  parseBooleanSetting,
  resolveGeminiSamplingParametersEnabled
};
