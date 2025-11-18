const axios = require('axios');
const log = require('../utils/logger');

class KitsuService {
  constructor() {
    this.baseUrl = 'https://kitsu.io/api/edge';
    this.cache = new Map();
    this.cacheExpiry = 24 * 60 * 60 * 1000; // 24 hours
  }

  /**
   * Extract numeric ID from Kitsu ID string
   * @param {string} kitsuId - Kitsu ID (e.g., "kitsu:1234" or just "1234")
   * @returns {string} - Numeric ID
   */
  extractNumericId(kitsuId) {
    if (!kitsuId) return null;

    // Handle formats like "kitsu:1234" or "kitsu-1234"
    const match = kitsuId.match(/(?:kitsu[:-])?(\d+)/i);
    return match ? match[1] : null;
  }

  /**
   * Get anime info from Kitsu API
   * @param {string} kitsuId - Kitsu ID
   * @returns {Promise<Object>} - Anime info including mappings
   */
  async getAnimeInfo(kitsuId) {
    const numericId = this.extractNumericId(kitsuId);
    if (!numericId) {
      log.warn(() => [`[Kitsu] Invalid Kitsu ID format: ${kitsuId}`]);
      return null;
    }

    // Check cache first
    const cacheKey = `anime_${numericId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
      log.debug(() => [`[Kitsu] Cache hit for ID ${numericId}`]);
      return cached.data;
    }

    try {
      log.debug(() => [`[Kitsu] Fetching anime info for ID: ${numericId}`]);

      // Fetch anime data with mappings included
      const response = await axios.get(`${this.baseUrl}/anime/${numericId}`, {
        params: {
          include: 'mappings'
        },
        timeout: 10000,
        headers: {
          'User-Agent': 'StremioSubMaker/1.0',
          'Accept': 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json'
        }
      });

      const animeData = response.data;

      // Cache the result
      this.cache.set(cacheKey, {
        data: animeData,
        timestamp: Date.now()
      });

      return animeData;
    } catch (error) {
      log.warn(() => [`[Kitsu] Failed to fetch anime info for ID ${numericId}:`, error.message]);

      // Cache null result to avoid repeated failed requests
      this.cache.set(cacheKey, {
        data: null,
        timestamp: Date.now()
      });

      return null;
    }
  }

  /**
   * Get IMDB ID from Kitsu ID by checking mappings
   * @param {string} kitsuId - Kitsu ID
   * @returns {Promise<string|null>} - IMDB ID if found
   */
  async getImdbId(kitsuId) {
    const animeData = await this.getAnimeInfo(kitsuId);

    if (!animeData || !animeData.data) {
      return null;
    }

    // First check if the anime data directly has slug or other info we can use
    const anime = animeData.data;
    const slug = anime.attributes?.slug;
    const canonicalTitle = anime.attributes?.canonicalTitle;
    const englishTitle = anime.attributes?.titles?.en || anime.attributes?.titles?.en_us;

    log.debug(() => [`[Kitsu] Anime: ${canonicalTitle} (slug: ${slug})`]);

    // Check included mappings for external IDs
    if (animeData.included && Array.isArray(animeData.included)) {
      for (const mapping of animeData.included) {
        if (mapping.type === 'mappings') {
          const externalSite = mapping.attributes?.externalSite;
          const externalId = mapping.attributes?.externalId;

          // Look for IMDB, TheMovieDB, or AniDB mappings
          if (externalSite === 'imdb' && externalId) {
            const imdbId = externalId.startsWith('tt') ? externalId : `tt${externalId}`;
            log.debug(() => [`[Kitsu] Found IMDB ID ${imdbId} for Kitsu ID ${kitsuId}`]);
            return imdbId;
          }

          // If we find TheMovieDB ID, we can try to get IMDB from there
          if (externalSite === 'themoviedb/movie' && externalId) {
            log.debug(() => [`[Kitsu] Found TMDB movie ID ${externalId}, attempting to get IMDB ID`]);
            const imdbId = await this.getImdbFromTmdb(externalId, 'movie');
            if (imdbId) {
              return imdbId;
            }
          }

          if (externalSite === 'themoviedb/tv' && externalId) {
            log.debug(() => [`[Kitsu] Found TMDB TV ID ${externalId}, attempting to get IMDB ID`]);
            const imdbId = await this.getImdbFromTmdb(externalId, 'tv');
            if (imdbId) {
              return imdbId;
            }
          }

          // AniDB mapping exists but we don't use it as fallback (unreliable API)
          if (externalSite === 'anidb' && externalId) {
            log.debug(() => [`[Kitsu] Found AniDB ID ${externalId} (not using as fallback)`]);
          }
        }
      }
    }

    // Fallback: Search Cinemeta by title (try multiple title variations)
    const titlesToTry = [];

    // Try English title first (most likely to match IMDB)
    if (englishTitle) titlesToTry.push({ type: 'English', title: englishTitle });

    // Try canonical/original title (often Japanese or romanized)
    if (canonicalTitle && canonicalTitle !== englishTitle) {
      titlesToTry.push({ type: 'Canonical', title: canonicalTitle });
    }

    // Try Japanese title if available
    const japaneseTitle = anime.attributes?.titles?.ja_jp;
    if (japaneseTitle && japaneseTitle !== canonicalTitle && japaneseTitle !== englishTitle) {
      titlesToTry.push({ type: 'Japanese', title: japaneseTitle });
    }

    for (const { type, title } of titlesToTry) {
      log.debug(() => [`[Kitsu] Attempting ${type} title search fallback for "${title}"`]);
      const imdbId = await this.searchByTitle(title);
      if (imdbId) {
        log.info(() => [`[Kitsu] Found IMDB ID ${imdbId} via ${type} title search for Kitsu ID ${kitsuId}`]);
        return imdbId;
      }
    }

    log.debug(() => [`[Kitsu] No IMDB ID found for Kitsu ID ${kitsuId}`]);
    return null;
  }

  /**
   * Get IMDB ID from TMDB ID using Cinemeta (Stremio's metadata addon)
   * This is more reliable than TMDB API and doesn't require an API key
   * @param {string} tmdbId - TMDB ID
   * @param {string} mediaType - 'movie' or 'tv'
   * @returns {Promise<string|null>} - IMDB ID if found
   */
  async getImdbFromTmdb(tmdbId, mediaType = 'tv') {
    try {
      // Use Cinemeta (Stremio's official metadata addon) to get IMDB ID from TMDB ID
      // Format: https://v3-cinemeta.strem.io/meta/{type}/tmdb:{id}.json
      const stremioType = mediaType === 'movie' ? 'movie' : 'series';
      const response = await axios.get(
        `https://v3-cinemeta.strem.io/meta/${stremioType}/tmdb:${tmdbId}.json`,
        {
          timeout: 10000,
          headers: {
            'User-Agent': 'StremioSubMaker/1.0'
          }
        }
      );

      const imdbId = response.data?.meta?.imdb_id;
      if (imdbId) {
        log.debug(() => [`[Kitsu] Mapped TMDB ${mediaType} ${tmdbId} to IMDB ${imdbId} via Cinemeta`]);
        return imdbId;
      }

      return null;
    } catch (error) {
      log.warn(() => [`[Kitsu] Failed to get IMDB from TMDB ${mediaType} ${tmdbId}:`, error.message]);
      return null;
    }
  }

  /**
   * Search Cinemeta by title to find IMDB ID
   * Used as fallback when Kitsu doesn't have IMDB mappings
   * @param {string} title - Anime title
   * @returns {Promise<string|null>} - IMDB ID if found
   */
  async searchByTitle(title) {
    try {
      log.debug(() => [`[Kitsu] Searching Cinemeta for title: "${title}"`]);

      // Search both series and movies
      const searchQueries = [
        `https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(title)}.json`,
        `https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(title)}.json`
      ];

      for (const url of searchQueries) {
        try {
          const response = await axios.get(url, {
            timeout: 10000,
            headers: {
              'User-Agent': 'StremioSubMaker/1.0'
            }
          });

          const metas = response.data?.metas || [];

          // Try to find an exact or close match
          for (const meta of metas) {
            const metaName = meta.name?.toLowerCase();
            const searchTitleLower = title.toLowerCase();

            // Check for exact match or very close match
            if (metaName === searchTitleLower ||
                metaName?.includes(searchTitleLower) ||
                searchTitleLower.includes(metaName)) {

              if (meta.imdb_id) {
                log.debug(() => [`[Kitsu] Found match: "${meta.name}" (${meta.imdb_id})`]);
                return meta.imdb_id;
              }
            }
          }

          // If no exact match, try the first result as a fallback
          if (metas.length > 0 && metas[0].imdb_id) {
            log.debug(() => [`[Kitsu] Using first result: "${metas[0].name}" (${metas[0].imdb_id})`]);
            return metas[0].imdb_id;
          }
        } catch (error) {
          // Continue to next search type
          log.debug(() => [`[Kitsu] Search failed for URL ${url}:`, error.message]);
        }
      }

      log.debug(() => [`[Kitsu] No results found in Cinemeta for "${title}"`]);
      return null;
    } catch (error) {
      log.warn(() => [`[Kitsu] Title search failed for "${title}":`, error.message]);
      return null;
    }
  }

  /**
   * Search for anime by title in Kitsu database
   * @param {string} title - Anime title
   * @returns {Promise<Array>} - Array of matching anime
   */
  async searchAnime(title) {
    try {
      log.debug(() => [`[Kitsu] Searching for anime: ${title}`]);

      const response = await axios.get(`${this.baseUrl}/anime`, {
        params: {
          filter: { text: title },
          page: { limit: 5 }
        },
        timeout: 10000,
        headers: {
          'User-Agent': 'StremioSubMaker/1.0',
          'Accept': 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json'
        }
      });

      return response.data?.data || [];
    } catch (error) {
      log.warn(() => [`[Kitsu] Failed to search anime "${title}":`, error.message]);
      return [];
    }
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    log.debug(() => ['[Kitsu] Cache cleared']);
  }
}

module.exports = KitsuService;
