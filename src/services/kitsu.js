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
   * Sleep helper for retry delays
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get anime info from Kitsu API with retry logic
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

    // Retry configuration: 2 retries with delays of 2s and 6s
    const retryDelays = [2000, 6000]; // milliseconds
    let lastError = null;

    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        if (attempt === 0) {
          log.debug(() => [`[Kitsu] Fetching anime info for ID: ${numericId}`]);
        } else {
          log.debug(() => [`[Kitsu] Retry ${attempt}/${retryDelays.length} for ID: ${numericId}`]);
        }

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

        if (attempt > 0) {
          log.info(() => [`[Kitsu] Successfully fetched anime info for ID ${numericId} on retry ${attempt}`]);
        }

        return animeData;
      } catch (error) {
        lastError = error;

        // Check if this is a retryable error (5xx server errors or network errors)
        const isRetryable =
          error.response?.status >= 500 || // 5xx server errors
          error.code === 'ECONNRESET' ||   // Connection reset
          error.code === 'ETIMEDOUT' ||    // Timeout
          error.code === 'ENOTFOUND' ||    // DNS lookup failed
          !error.response;                 // Network error (no response)

        // If we have retries left and the error is retryable, wait and retry
        if (attempt < retryDelays.length && isRetryable) {
          const delay = retryDelays[attempt];
          log.debug(() => [`[Kitsu] Retryable error for ID ${numericId} (${error.message}), waiting ${delay}ms before retry ${attempt + 1}/${retryDelays.length}`]);
          await this.sleep(delay);
          continue;
        }

        // No more retries or non-retryable error
        break;
      }
    }

    // All retries failed
    log.warn(() => [`[Kitsu] Failed to fetch anime info for ID ${numericId} after ${retryDelays.length} retries:`, lastError?.message]);

    // Cache null result to avoid repeated failed requests
    this.cache.set(cacheKey, {
      data: null,
      timestamp: Date.now()
    });

    return null;
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
   * Falls back to Wikidata if Cinemeta doesn't have the mapping
   * @param {string} tmdbId - TMDB ID
   * @param {string} mediaType - 'movie' or 'tv'
   * @returns {Promise<string|null>} - IMDB ID if found
   */
  async getImdbFromTmdb(tmdbId, mediaType = 'tv') {
    const retryDelays = [2000, 6000]; // milliseconds
    let lastError = null;
    let imdbId = null;

    // Step 1: Try Cinemeta first
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
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

        imdbId = response.data?.meta?.imdb_id;
        if (imdbId) {
          log.debug(() => [`[Kitsu] Mapped TMDB ${mediaType} ${tmdbId} to IMDB ${imdbId} via Cinemeta`]);
          return imdbId;
        }

        break; // Got response but no IMDB ID, try Wikidata
      } catch (error) {
        lastError = error;

        // Check if this is a retryable error
        const isRetryable =
          error.response?.status >= 500 ||
          error.code === 'ECONNRESET' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'ENOTFOUND' ||
          !error.response;

        if (attempt < retryDelays.length && isRetryable) {
          const delay = retryDelays[attempt];
          log.debug(() => [`[Kitsu] Retryable error getting IMDB from TMDB ${mediaType} ${tmdbId}, waiting ${delay}ms before retry ${attempt + 1}/${retryDelays.length}`]);
          await this.sleep(delay);
          continue;
        }

        break;
      }
    }

    // Step 2: If Cinemeta failed or has no mapping, try Wikidata (free, no API key)
    log.debug(() => [`[Kitsu] Cinemeta miss for TMDB ${tmdbId}, trying Wikidata fallback`]);
    imdbId = await this.queryWikidataTmdbToImdb(tmdbId, mediaType);
    if (imdbId) {
      return imdbId;
    }

    if (lastError) {
      log.warn(() => [`[Kitsu] Failed to get IMDB from TMDB ${mediaType} ${tmdbId} after retries:`, lastError?.message]);
    } else {
      log.debug(() => [`[Kitsu] No IMDB mapping found for TMDB ${mediaType} ${tmdbId}`]);
    }
    return null;
  }

  /**
   * Query Wikidata to get IMDB ID from TMDB ID
   * Wikidata is completely free and requires no API key
   * @param {string} tmdbId - The TMDB ID to look up
   * @param {string} mediaType - 'movie' or 'tv'
   * @returns {Promise<string|null>} - IMDB ID if found, null otherwise
   */
  async queryWikidataTmdbToImdb(tmdbId, mediaType) {
    try {
      // Wikidata properties:
      // P4947 = TMDB movie ID
      // P5607 = TMDB TV series ID  
      // P345 = IMDB ID
      const tmdbMovieProp = 'wdt:P4947';
      const tmdbTvProp = 'wdt:P5607';
      const imdbProp = 'wdt:P345';

      // SPARQL query that tries both movie and TV properties
      const sparqlQuery = `
        SELECT ?imdb WHERE {
          { ?item ${tmdbMovieProp} "${tmdbId}". }
          UNION
          { ?item ${tmdbTvProp} "${tmdbId}". }
          ?item ${imdbProp} ?imdb.
        } LIMIT 1
      `.trim().replace(/\s+/g, ' ');

      const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(sparqlQuery)}&format=json`;

      const response = await axios.get(url, {
        timeout: 8000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'StremioSubMaker/1.0 (subtitle addon; contact via GitHub)'
        }
      });

      const bindings = response?.data?.results?.bindings;
      if (bindings && bindings.length > 0 && bindings[0]?.imdb?.value) {
        const imdbId = bindings[0].imdb.value;
        log.info(() => [`[Kitsu] Wikidata found IMDB ${imdbId} for TMDB ${mediaType} ${tmdbId}`]);
        return imdbId.startsWith('tt') ? imdbId : `tt${imdbId}`;
      }

      log.debug(() => [`[Kitsu] Wikidata has no mapping for TMDB ${mediaType} ${tmdbId}`]);
      return null;
    } catch (error) {
      log.debug(() => [`[Kitsu] Wikidata lookup failed for TMDB ${tmdbId}:`, error.message]);
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
        const retryDelays = [2000, 6000]; // milliseconds
        let lastError = null;
        let metas = null;

        // Retry logic for each URL
        for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
          try {
            const response = await axios.get(url, {
              timeout: 10000,
              headers: {
                'User-Agent': 'StremioSubMaker/1.0'
              }
            });

            metas = response.data?.metas || [];
            break; // Success, exit retry loop
          } catch (error) {
            lastError = error;

            // Check if this is a retryable error
            const isRetryable =
              error.response?.status >= 500 ||
              error.code === 'ECONNRESET' ||
              error.code === 'ETIMEDOUT' ||
              error.code === 'ENOTFOUND' ||
              !error.response;

            if (attempt < retryDelays.length && isRetryable) {
              const delay = retryDelays[attempt];
              log.debug(() => [`[Kitsu] Retryable error searching Cinemeta "${title}", waiting ${delay}ms before retry ${attempt + 1}/${retryDelays.length}`]);
              await this.sleep(delay);
              continue;
            }

            break;
          }
        }

        // If all retries failed, continue to next search type
        if (!metas) {
          log.debug(() => [`[Kitsu] Search failed for URL ${url} after retries:`, lastError?.message]);
          continue;
        }

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
    const retryDelays = [2000, 6000]; // milliseconds
    let lastError = null;

    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        if (attempt === 0) {
          log.debug(() => [`[Kitsu] Searching for anime: ${title}`]);
        } else {
          log.debug(() => [`[Kitsu] Retry ${attempt}/${retryDelays.length} searching for anime: ${title}`]);
        }

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
        lastError = error;

        // Check if this is a retryable error
        const isRetryable =
          error.response?.status >= 500 ||
          error.code === 'ECONNRESET' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'ENOTFOUND' ||
          !error.response;

        if (attempt < retryDelays.length && isRetryable) {
          const delay = retryDelays[attempt];
          log.debug(() => [`[Kitsu] Retryable error searching anime "${title}", waiting ${delay}ms before retry ${attempt + 1}/${retryDelays.length}`]);
          await this.sleep(delay);
          continue;
        }

        break;
      }
    }

    log.warn(() => [`[Kitsu] Failed to search anime "${title}" after ${retryDelays.length} retries:`, lastError?.message]);
    return [];
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
