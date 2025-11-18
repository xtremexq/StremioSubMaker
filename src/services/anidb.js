const axios = require('axios');
const log = require('../utils/logger');

class AniDBService {
  constructor() {
    this.baseUrl = 'https://api.anidb.net';
    this.cache = new Map();
    this.cacheExpiry = 24 * 60 * 60 * 1000; // 24 hours
  }

  /**
   * Extract numeric ID from AniDB ID string
   * @param {string} anidbId - AniDB ID (e.g., "anidb:1234" or just "1234")
   * @returns {string} - Numeric ID
   */
  extractNumericId(anidbId) {
    if (!anidbId) return null;

    // Handle formats like "anidb:1234" or "anidb-1234"
    const match = anidbId.match(/(?:anidb[:-])?(\d+)/i);
    return match ? match[1] : null;
  }

  /**
   * Get anime info from AniDB API
   * @param {string} anidbId - AniDB ID
   * @returns {Promise<Object>} - Anime info including IMDB ID if available
   */
  async getAnimeInfo(anidbId) {
    const numericId = this.extractNumericId(anidbId);
    if (!numericId) {
      log.warn(() => [`[AniDB] Invalid AniDB ID format: ${anidbId}`]);
      return null;
    }

    // Check cache first
    const cacheKey = `anime_${numericId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
      log.debug(() => [`[AniDB] Cache hit for ID ${numericId}`]);
      return cached.data;
    }

    try {
      log.debug(() => [`[AniDB] Fetching anime info for ID: ${numericId}`]);

      const response = await axios.get(`${this.baseUrl}/api/anime/${numericId}`, {
        timeout: 10000,
        headers: {
          'User-Agent': 'StremioSubMaker/1.0'
        }
      });

      const animeInfo = response.data;

      // Cache the result
      this.cache.set(cacheKey, {
        data: animeInfo,
        timestamp: Date.now()
      });

      return animeInfo;
    } catch (error) {
      log.warn(() => [`[AniDB] Failed to fetch anime info for ID ${numericId}:`, error.message]);

      // Cache null result to avoid repeated failed requests
      this.cache.set(cacheKey, {
        data: null,
        timestamp: Date.now()
      });

      return null;
    }
  }

  /**
   * Get IMDB ID from AniDB ID
   * @param {string} anidbId - AniDB ID
   * @returns {Promise<string|null>} - IMDB ID if found
   */
  async getImdbId(anidbId) {
    const animeInfo = await this.getAnimeInfo(anidbId);

    if (!animeInfo) {
      return null;
    }

    // Check for IMDB ID in various possible fields
    const imdbId = animeInfo.imdb_id || animeInfo.imdbId || animeInfo.imdb;

    if (imdbId) {
      log.debug(() => [`[AniDB] Found IMDB ID ${imdbId} for AniDB ID ${anidbId}`]);
      return imdbId.startsWith('tt') ? imdbId : `tt${imdbId}`;
    }

    log.debug(() => [`[AniDB] No IMDB ID found for AniDB ID ${anidbId}`]);
    return null;
  }

  /**
   * Search for anime by title
   * @param {string} title - Anime title
   * @returns {Promise<Array>} - Array of matching anime
   */
  async searchAnime(title) {
    try {
      log.debug(() => [`[AniDB] Searching for anime: ${title}`]);

      const response = await axios.get(`${this.baseUrl}/api/anime/search`, {
        params: { q: title },
        timeout: 10000,
        headers: {
          'User-Agent': 'StremioSubMaker/1.0'
        }
      });

      return response.data || [];
    } catch (error) {
      log.warn(() => [`[AniDB] Failed to search anime "${title}":`, error.message]);
      return [];
    }
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    log.debug(() => ['[AniDB] Cache cleared']);
  }
}

module.exports = AniDBService;
