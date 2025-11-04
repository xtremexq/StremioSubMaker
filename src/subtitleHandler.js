const OpenSubtitlesAPI = require('./opensubtitles');
const GeminiAPI = require('./gemini');
const { getLanguageName, getISO639_1 } = require('./languages');

/**
 * Subtitle Handler - Manages subtitle fetching and translation
 */
class SubtitleHandler {
  constructor(config) {
    this.config = config;
    this.opensubtitlesAPI = config.opensubtitlesApiKey
      ? new OpenSubtitlesAPI(config.opensubtitlesApiKey)
      : null;
    this.geminiAPI = config.geminiApiKey
      ? new GeminiAPI(config.geminiApiKey)
      : null;

    // Cache for subtitles to avoid re-fetching
    this.subtitleCache = new Map();
  }

  /**
   * Get cache key for subtitle search
   */
  getCacheKey(imdbId, type, season, episode, languages) {
    return `${imdbId}_${type}_${season || ''}_${episode || ''}_${languages.join(',')}`;
  }

  /**
   * Fetch subtitles from OpenSubtitles
   * @param {Object} params - Search parameters
   * @returns {Promise<Array>} - Array of subtitle objects
   */
  async fetchSubtitles(params) {
    if (!this.opensubtitlesAPI) {
      return [];
    }

    const cacheKey = this.getCacheKey(
      params.imdb_id,
      params.type,
      params.season_number,
      params.episode_number,
      params.languages
    );

    // Check cache
    if (this.subtitleCache.has(cacheKey)) {
      const cached = this.subtitleCache.get(cacheKey);
      if (Date.now() - cached.timestamp < 30 * 60 * 1000) { // 30 minutes
        return cached.data;
      }
    }

    const subtitles = await this.opensubtitlesAPI.searchSubtitles(params);

    // Cache results
    this.subtitleCache.set(cacheKey, {
      data: subtitles,
      timestamp: Date.now()
    });

    return subtitles;
  }

  /**
   * Convert OpenSubtitles result to Stremio subtitle format
   * @param {Object} subtitle - OpenSubtitles subtitle object
   * @param {string} lang - ISO639-2 language code
   * @returns {Object} - Stremio subtitle object
   */
  convertToStremioFormat(subtitle, lang) {
    const attributes = subtitle.attributes;
    return {
      id: `os-${attributes.files[0].file_id}`,
      lang: lang,
      url: `${this.config.addonUrl}/subtitle/${attributes.files[0].file_id}.srt`,
      name: attributes.release || attributes.feature_details?.movie_name || 'OpenSubtitles'
    };
  }

  /**
   * Create translation button subtitle entry
   * @param {string} targetLang - Target language code (ISO639-2)
   * @param {string} videoId - Video ID for the translation endpoint
   * @returns {Object} - Stremio subtitle object
   */
  createTranslationButton(targetLang, videoId) {
    const langName = getLanguageName(targetLang);
    return {
      id: `translate-to-${targetLang}`,
      lang: targetLang,
      url: `${this.config.addonUrl}/translate/${videoId}/${targetLang}/select.srt`,
      name: `🌐 Translate to ${langName}`
    };
  }

  /**
   * Get all subtitles including translation buttons
   * @param {string} type - 'movie' or 'series'
   * @param {string} id - Stremio ID (e.g., 'tt1234567' or 'tt1234567:1:1')
   * @returns {Promise<Object>} - Stremio subtitles response
   */
  async getSubtitles(type, id) {
    try {
      // Parse ID
      const parts = id.split(':');
      const imdbId = parts[0];
      const season = parts[1];
      const episode = parts[2];

      const videoType = type === 'series' ? 'episode' : 'movie';

      // Get all configured languages (both source and target)
      const allLanguages = [
        ...this.config.sourceLanguages,
        ...this.config.targetLanguages
      ].filter((v, i, a) => a.indexOf(v) === i); // Remove duplicates

      // Fetch subtitles from OpenSubtitles
      const searchParams = {
        imdb_id: imdbId,
        type: videoType,
        languages: allLanguages
      };

      if (videoType === 'episode') {
        searchParams.season_number = parseInt(season);
        searchParams.episode_number = parseInt(episode);
      }

      const openSubsResults = await this.fetchSubtitles(searchParams);

      // Group subtitles by language
      const subtitlesByLang = {};
      openSubsResults.forEach(sub => {
        const attributes = sub.attributes;
        if (attributes.files && attributes.files.length > 0) {
          const langCode = attributes.language;
          // Convert ISO639-1 to ISO639-2
          const iso639_2 = this.findISO639_2(langCode);
          if (!subtitlesByLang[iso639_2]) {
            subtitlesByLang[iso639_2] = [];
          }
          subtitlesByLang[iso639_2].push(sub);
        }
      });

      // Build Stremio subtitle list
      const stremioSubtitles = [];

      // Add fetched subtitles
      Object.keys(subtitlesByLang).forEach(lang => {
        subtitlesByLang[lang].forEach(sub => {
          stremioSubtitles.push(this.convertToStremioFormat(sub, lang));
        });
      });

      // Add translation buttons for each target language
      this.config.targetLanguages.forEach(targetLang => {
        stremioSubtitles.push(this.createTranslationButton(targetLang, id));
      });

      return { subtitles: stremioSubtitles };
    } catch (error) {
      console.error('Error getting subtitles:', error);
      return { subtitles: [] };
    }
  }

  /**
   * Find ISO639-2 code from ISO639-1
   * @param {string} iso639_1 - ISO639-1 code
   * @returns {string} - ISO639-2 code
   */
  findISO639_2(iso639_1) {
    const { iso639_1ToIso639_2 } = require('./languages');
    return iso639_1ToIso639_2[iso639_1] || iso639_1;
  }

  /**
   * Download and serve subtitle
   * @param {string} fileId - OpenSubtitles file ID
   * @returns {Promise<string>} - Subtitle content
   */
  async getSubtitleContent(fileId) {
    if (!this.opensubtitlesAPI) {
      throw new Error('OpenSubtitles API not configured');
    }
    return await this.opensubtitlesAPI.getSubtitleContent(fileId);
  }

  /**
   * Translate subtitle
   * @param {string} subtitleContent - Original subtitle content
   * @param {string} sourceLang - Source language (ISO639-2)
   * @param {string} targetLang - Target language (ISO639-2)
   * @returns {Promise<string>} - Translated subtitle content
   */
  async translateSubtitle(subtitleContent, sourceLang, targetLang) {
    if (!this.geminiAPI) {
      throw new Error('Gemini API not configured');
    }

    const sourceLangName = getLanguageName(sourceLang);
    const targetLangName = getLanguageName(targetLang);

    return await this.geminiAPI.translateSubtitleChunked(
      subtitleContent,
      sourceLangName,
      targetLangName,
      this.config.geminiModel,
      this.config.translationPrompt
    );
  }
}

module.exports = SubtitleHandler;
