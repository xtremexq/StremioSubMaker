const axios = require('axios');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function normalizeTargetName(name) {
  let n = String(name || '').trim();
  const rules = [
    [/^Portuguese\s*\(Brazil\)$/i, 'Brazilian Portuguese'],
    [/^Spanish\s*\(Latin America\)$/i, 'Latin American Spanish'],
    [/^Chinese\s*\(Simplified\)$/i, 'Simplified Chinese'],
    [/^Chinese\s*\(Traditional\)$/i, 'Traditional Chinese'],
    [/^Portuguese\s*\(Portugal\)$/i, 'European Portuguese'],
    [/^Portuguese\s*\(European\)$/i, 'European Portuguese']
  ];
  for (const [re, out] of rules) {
    if (re.test(n)) return out;
  }
  return n;
}

class GeminiAPI {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  /**
   * List available models from Gemini API
   * @returns {Promise<Array>} - Array of model objects
   */
  async listModels() {
    try {
      const response = await axios.get(`${GEMINI_API_BASE}/models`, {
        params: {
          key: this.apiKey
        }
      });

      // Filter models that support generateContent
      const models = response.data.models
        .filter(model =>
          model.supportedGenerationMethods &&
          model.supportedGenerationMethods.includes('generateContent')
        )
        .map(model => ({
          name: model.name.replace('models/', ''),
          displayName: model.displayName,
          description: model.description,
          inputTokenLimit: model.inputTokenLimit,
          outputTokenLimit: model.outputTokenLimit
        }));

      return models;
    } catch (error) {
      console.error('Gemini list models error:', error.response?.data || error.message);
      throw new Error('Failed to fetch Gemini models');
    }
  }

  /**
   * Translate subtitle content using Gemini
   * @param {string} subtitleContent - Original subtitle content (SRT format)
   * @param {string} sourceLang - Source language name
   * @param {string} targetLang - Target language name
   * @param {string} model - Model name (e.g., 'gemini-pro')
   * @param {string} customPrompt - Custom translation prompt/instructions
   * @returns {Promise<string>} - Translated subtitle content
   */
  async translateSubtitle(subtitleContent, sourceLang, targetLang, model, customPrompt) {
    try {
      const systemPrompt = customPrompt || this.getDefaultPrompt();

      // Normalize target language to a human-readable form (handle common regional variants)
      const normalizedTarget = normalizeTargetName(targetLang);

      const prompt = `${systemPrompt}

Target Language: ${normalizedTarget}

Please translate the following SRT subtitle file to ${normalizedTarget}. Maintain the exact SRT format with timing codes and sequence numbers. Only translate the text content, keep all timestamps and formatting intact. NEVER output markdown.

Subtitle content:
${subtitleContent}`;

      const response = await axios.post(
        `${GEMINI_API_BASE}/models/${model}:generateContent`,
        {
          contents: [{
            parts: [{
              text: prompt
            }]
          }],
          generationConfig: {
            temperature: 0.3,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 8192,
          }
        },
        {
          params: {
            key: this.apiKey
          },
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      if (!response.data.candidates || response.data.candidates.length === 0) {
        throw new Error('No translation generated');
      }

      const translatedText = response.data.candidates[0].content.parts[0].text;

      // Clean up potential markdown formatting that Gemini might add
      return this.cleanTranslatedSubtitle(translatedText);
    } catch (error) {
      console.error('Gemini translation error:', error.response?.data || error.message);
      throw new Error('Failed to translate subtitle');
    }
  }

  /**
   * Clean translated subtitle by removing markdown artifacts
   * @param {string} text - Translated text
   * @returns {string} - Cleaned subtitle text
   */
  cleanTranslatedSubtitle(text) {
    // Remove markdown code blocks if present
    let cleaned = text.replace(/```srt\n/g, '').replace(/```\n/g, '').replace(/```/g, '');

    // Ensure proper SRT format
    cleaned = cleaned.trim();

    return cleaned;
  }

  /**
   * Get default translation prompt
   * @returns {string} - Default prompt
   */
  getDefaultPrompt() {
    return `You are a professional subtitles translator. Translate the following subtitles while:
1. Maintaining perfect SRT format (sequence numbers, timestamps, and text)
2. Preserving the timing and structure exactly as given
3. Keeping the same number of lines and line breaks
4. Translating text naturally and contextually
5. Ensuring cultural adaptation where necessary while staying faithful to the original meaning
6. Preserving any existing formatting tags

This is an automatic system, DO NOT make any explanations or comments - simply output the translated SRT content

Return ONLY the translated SRT content, nothing else. NEVER output markdown.`;
  }

  /**
   * Translate subtitle in chunks if too large
   * @param {string} subtitleContent - Original subtitle content
   * @param {string} sourceLang - Source language
   * @param {string} targetLang - Target language
   * @param {string} model - Model name
   * @param {string} customPrompt - Custom prompt
   * @returns {Promise<string>} - Translated subtitle
   */
  async translateSubtitleChunked(subtitleContent, sourceLang, targetLang, model, customPrompt) {
    // Split into subtitle blocks
    const blocks = subtitleContent.split(/\n\n+/);
    const chunkSize = 50; // Process 50 subtitle blocks at a time

    if (blocks.length <= chunkSize) {
      return await this.translateSubtitle(subtitleContent, sourceLang, targetLang, model, customPrompt);
    }

    // Process in chunks
    const chunks = [];
    for (let i = 0; i < blocks.length; i += chunkSize) {
      chunks.push(blocks.slice(i, i + chunkSize).join('\n\n'));
    }

    const translatedChunks = [];
    for (const chunk of chunks) {
      const translated = await this.translateSubtitle(chunk, sourceLang, targetLang, model, customPrompt);
      translatedChunks.push(translated);
    }

    return translatedChunks.join('\n\n');
  }
}

module.exports = GeminiAPI;
