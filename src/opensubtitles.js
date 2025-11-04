const axios = require('axios');
const { getISO639_1 } = require('./languages');

const OPENSUBTITLES_API_URL = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = 'StremioSubtitleTranslator v1.0';

class OpenSubtitlesAPI {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.token = null;
    this.tokenExpiry = null;
  }

  /**
   * Login to OpenSubtitles API and get token
   */
  async login() {
    if (this.token && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.token;
    }

    try {
      const response = await axios.post(
        `${OPENSUBTITLES_API_URL}/login`,
        {},
        {
          headers: {
            'Api-Key': this.apiKey,
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json'
          }
        }
      );

      this.token = response.data.token;
      // Token expires in 24 hours, we'll refresh after 23 hours
      this.tokenExpiry = Date.now() + (23 * 60 * 60 * 1000);
      return this.token;
    } catch (error) {
      console.error('OpenSubtitles login error:', error.response?.data || error.message);
      throw new Error('Failed to authenticate with OpenSubtitles');
    }
  }

  /**
   * Search for subtitles
   * @param {Object} params - Search parameters
   * @param {string} params.imdb_id - IMDB ID (without 'tt' prefix for movies)
   * @param {string} params.type - 'movie' or 'episode'
   * @param {number} params.season_number - Season number for episodes
   * @param {number} params.episode_number - Episode number for episodes
   * @param {Array<string>} params.languages - Array of ISO639-2 language codes
   * @returns {Promise<Array>} - Array of subtitle objects
   */
  async searchSubtitles(params) {
    try {
      await this.login();

      const { imdb_id, type, season_number, episode_number, languages } = params;

      // Convert ISO639-2 codes to ISO639-1 for OpenSubtitles
      const languageCodes = languages.map(lang => getISO639_1(lang)).join(',');

      const searchParams = {
        languages: languageCodes,
      };

      // Remove 'tt' prefix from IMDB ID if present
      const cleanImdbId = imdb_id.replace('tt', '');

      if (type === 'movie') {
        searchParams.imdb_id = cleanImdbId;
      } else if (type === 'episode') {
        searchParams.parent_imdb_id = cleanImdbId;
        if (season_number) searchParams.season_number = season_number;
        if (episode_number) searchParams.episode_number = episode_number;
      }

      const response = await axios.get(`${OPENSUBTITLES_API_URL}/subtitles`, {
        params: searchParams,
        headers: {
          'Api-Key': this.apiKey,
          'Authorization': `Bearer ${this.token}`,
          'User-Agent': USER_AGENT
        }
      });

      return response.data.data || [];
    } catch (error) {
      console.error('OpenSubtitles search error:', error.response?.data || error.message);
      return [];
    }
  }

  /**
   * Download subtitle file
   * @param {number} file_id - File ID from search results
   * @returns {Promise<Object>} - Download info with link and file name
   */
  async downloadSubtitle(file_id) {
    try {
      await this.login();

      const response = await axios.post(
        `${OPENSUBTITLES_API_URL}/download`,
        { file_id },
        {
          headers: {
            'Api-Key': this.apiKey,
            'Authorization': `Bearer ${this.token}`,
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json'
          }
        }
      );

      return response.data;
    } catch (error) {
      console.error('OpenSubtitles download error:', error.response?.data || error.message);
      throw new Error('Failed to download subtitle');
    }
  }

  /**
   * Fetch subtitle content from download URL
   * @param {string} url - Download URL
   * @returns {Promise<string>} - Subtitle content
   */
  async fetchSubtitleContent(url) {
    try {
      const response = await axios.get(url, {
        responseType: 'text',
        headers: {
          'User-Agent': USER_AGENT
        }
      });
      return response.data;
    } catch (error) {
      console.error('Subtitle content fetch error:', error.message);
      throw new Error('Failed to fetch subtitle content');
    }
  }

  /**
   * Get subtitle content by file ID
   * @param {number} file_id - File ID
   * @returns {Promise<string>} - Subtitle content
   */
  async getSubtitleContent(file_id) {
    const downloadInfo = await this.downloadSubtitle(file_id);
    if (!downloadInfo || !downloadInfo.link) {
      throw new Error('No download link available');
    }
    return await this.fetchSubtitleContent(downloadInfo.link);
  }
}

module.exports = OpenSubtitlesAPI;
