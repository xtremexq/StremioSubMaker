const axios = require('axios');
const { toISO6391, toISO6392 } = require('../utils/languages');
const { handleSearchError, handleDownloadError, handleAuthError } = require('../utils/apiErrorHandler');
const { httpAgent, httpsAgent, dnsLookup } = require('../utils/httpAgents');
const { version } = require('../utils/version');
const log = require('../utils/logger');

const OPENSUBTITLES_API_URL = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = `SubMaker v${version}`;

/**
 * Get OpenSubtitles API key at runtime (not at module load time)
 * This ensures Docker ENV vars and runtime environment changes are picked up
 * @returns {string} API key or empty string
 */
function getOpenSubtitlesApiKey() {
  return process.env.OPENSUBTITLES_API_KEY || '';
}

class OpenSubtitlesService {
  // Static flag to track if initialization logs have been shown
  static initLogged = false;

  constructor(config = {}) {
    // Config requires username/password for user authentication (mandatory)
    this.config = {
      username: config.username || '',
      password: config.password || ''
    };

    this.token = null;
    this.tokenExpiry = null;

    // Read API key at runtime (not at module load time)
    const apiKey = getOpenSubtitlesApiKey();

    // Create axios instance with default configuration
    const defaultHeaders = {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate, br'
    };

    // Add API key if configured
    if (apiKey) {
      defaultHeaders['Api-Key'] = apiKey;
      // Only log once at startup
      if (!OpenSubtitlesService.initLogged) {
        log.warn(() => '[OpenSubtitles] API key loaded successfully from environment');
      }
    }

    this.client = axios.create({
      baseURL: OPENSUBTITLES_API_URL,
      headers: defaultHeaders,
      httpAgent,
      httpsAgent,
      lookup: dnsLookup,
      timeout: 15000,
      maxRedirects: 5,
      decompress: true
    });

    // Only log initialization messages once at startup
    if (!OpenSubtitlesService.initLogged) {
      // Validate API key is configured
      if (!apiKey) {
        log.warn(() => '[OpenSubtitles] WARNING: OPENSUBTITLES_API_KEY not found in environment variables');
        log.warn(() => '[OpenSubtitles] Set it via: .env file, Docker ENV, or docker-compose environment');
        log.warn(() => '[OpenSubtitles] API requests may fail or have very limited rate limits');
      }

      // Validate that credentials are provided
      if (!this.config.username || !this.config.password) {
        log.warn(() => '[OpenSubtitles] Username and password are optional - searches will use basic API access (limited to 5 downloads/24h per IP)');
      } else {
        log.warn(() => '[OpenSubtitles] Initialized with user account authentication for higher rate limits');
      }

      // Mark as logged
      OpenSubtitlesService.initLogged = true;
    }

    // Add request interceptor to handle token refresh for user authentication
    this.client.interceptors.request.use((config) => {
      if (this.token && !this.isTokenExpired()) {
        config.headers['Authorization'] = `Bearer ${this.token}`;
      }
      return config;
    });
  }

  /**
   * Check if token is expired
   * @returns {boolean}
   */
  isTokenExpired() {
    return !this.tokenExpiry || Date.now() >= this.tokenExpiry;
  }

  /**
   * Login with username and password to get JWT token
   * @param {string} username - OpenSubtitles username
   * @param {string} password - OpenSubtitles password
   * @returns {Promise<string>} - JWT token
   */
  async loginWithCredentials(username, password) {
    try {
      log.debug(() => ['[OpenSubtitles] Authenticating user:', username]);

      const response = await this.client.post('/login', {
        username: username,
        password: password
      });

      if (!response.data?.token) {
        throw new Error('No token received from authentication');
      }

      this.token = response.data.token;
      // Token is valid for 24 hours
      this.tokenExpiry = Date.now() + (24 * 60 * 60 * 1000);

      log.debug(() => '[OpenSubtitles] User authentication successful');
      return this.token;

    } catch (error) {
      return handleAuthError(error, 'OpenSubtitles');
    }
  }

    /**
   * Login to OpenSubtitles REST API (optional, for higher download limits)
   * @returns {Promise<string|null>} - JWT token if credentials provided, null otherwise
   */
  async login() {
    if (this.config.username && this.config.password) {
      return await this.loginWithCredentials(this.config.username, this.config.password);
    }
    // No credentials provided, use basic API access
    return null;
  }

  /**
   * Search for subtitles using the new REST API
   * @param {Object} params - Search parameters
   * @param {string} params.imdb_id - IMDB ID (with 'tt' prefix)
   * @param {string} params.type - 'movie' or 'episode'
   * @param {number} params.season - Season number (for episodes)
   * @param {number} params.episode - Episode number (for episodes)
   * @param {Array<string>} params.languages - Array of ISO-639-2 language codes
   * @returns {Promise<Array>} - Array of subtitle objects
   */
  async searchSubtitles(params) {
    try {
      // Authenticate with user credentials (required)
      if (!this.config.username || !this.config.password) {
        log.error(() => '[OpenSubtitles] Username and password are required. Please configure your OpenSubtitles credentials.');
        return [];
      }

      if (this.isTokenExpired()) {
        const loginResult = await this.login();
        if (!loginResult) {
          // Authentication failed; surface this so callers can react (e.g., append UX hint entries)
          const authErr = new Error('OpenSubtitles authentication failed: invalid username/password');
          authErr.statusCode = 400;
          authErr.authError = true;
          throw authErr;
        }
      }

      const { imdb_id, type, season, episode, languages } = params;

      // Convert imdb_id to numeric format (remove 'tt' prefix)
      const imdbId = imdb_id.replace('tt', '');

      // Convert ISO-639-2 (3-letter) codes to ISO-639-1 (2-letter) codes for OpenSubtitles API
      const convertedLanguages = languages.map(lang => {
        const lower = lang.toLowerCase().trim();
        
        // Handle special case for Portuguese Brazilian
        if (lower === 'pob' || lower === 'ptbr' || lower === 'pt-br') {
          return 'pt-br';
        }
        
        // If already 2 letters, return as-is
        if (lower.length === 2 && /^[a-z]{2}$/.test(lower)) {
          return lower;
        }
        
        // If 3 letters (ISO-639-2), convert to ISO-639-1
        if (lower.length === 3 && /^[a-z]{3}$/.test(lower)) {
          const iso1Code = toISO6391(lower);
          if (iso1Code) {
            return iso1Code;
          }
        }
        
        // Return original if can't convert
        return lower;
      }).filter(lang => lang); // Remove any nulls/undefined

      log.debug(() => ['[OpenSubtitles] Converted languages from ISO-639-2 to ISO-639-1:', languages.join(','), '->', convertedLanguages.join(',')]);

      // Build query parameters for REST API
      const queryParams = {
        imdb_id: imdbId,
        languages: convertedLanguages.join(',')
      };

      if ((type === 'episode' || type === 'anime-episode') && episode) {
        // Default to season 1 if not specified (common for anime)
        queryParams.season_number = season || 1;
        queryParams.episode_number = episode;
      }

      log.debug(() => ['[OpenSubtitles] Searching with params:', JSON.stringify(queryParams)]);
      if (this.token) {
        log.debug(() => '[OpenSubtitles] Using user account authentication');
      } else {
        log.debug(() => '[OpenSubtitles] Using basic API access');
      }

      const response = await this.client.get('/subtitles', {
        params: queryParams
      });

      if (!response.data || !response.data.data || response.data.data.length === 0) {
        log.debug(() => '[OpenSubtitles] No subtitles found in response');
        return [];
      }

      const subtitles = response.data.data.map(sub => {

        const originalLang = sub.attributes.language;
        const normalizedLang = this.normalizeLanguageCode(originalLang);
        const fileId = sub.attributes.files?.[0]?.file_id || sub.id;

        return {
          id: String(fileId),
          language: originalLang,
          languageCode: normalizedLang,
          name: sub.attributes.release || sub.attributes.feature_details?.movie_name || 'Unknown',
          downloads: parseInt(sub.attributes.download_count) || 0,
          rating: parseFloat(sub.attributes.ratings) || 0,
          uploadDate: sub.attributes.upload_date,
          format: sub.attributes.format || 'srt',
          fileId: String(fileId),
          downloadLink: sub.attributes.url,
          hearing_impaired: sub.attributes.hearing_impaired || false,
          foreign_parts_only: sub.attributes.foreign_parts_only || false,
          machine_translated: sub.attributes.machine_translated || false,
          uploader: sub.attributes.uploader?.name || 'Unknown',
          provider: 'opensubtitles'
        };
      });

      // Limit to 20 results per language to control response size
      const MAX_RESULTS_PER_LANGUAGE = 20;
      const groupedByLanguage = {};

      for (const sub of subtitles) {
        const lang = sub.languageCode || 'unknown';
        if (!groupedByLanguage[lang]) {
          groupedByLanguage[lang] = [];
        }
        if (groupedByLanguage[lang].length < MAX_RESULTS_PER_LANGUAGE) {
          groupedByLanguage[lang].push(sub);
        }
      }

      const limitedSubtitles = Object.values(groupedByLanguage).flat();
      log.debug(() => `[OpenSubtitles] Found ${subtitles.length} subtitles total, limited to ${limitedSubtitles.length} (max ${MAX_RESULTS_PER_LANGUAGE} per language)`);
      return limitedSubtitles;

    } catch (error) {
      return handleSearchError(error, 'OpenSubtitles');
    }
  }

  /**
   * Download subtitle content via REST API
   * @param {string} fileId - File ID from search results
   * @returns {Promise<string>} - Subtitle content as text
   */
  async downloadSubtitle(fileId) {
    try {
      log.debug(() => ['[OpenSubtitles] Downloading subtitle via REST API:', fileId]);

      // Authenticate with user credentials (required)
      if (!this.config.username || !this.config.password) {
        log.error(() => '[OpenSubtitles] Username and password are required. Please configure your OpenSubtitles credentials.');
        throw new Error('OpenSubtitles credentials not configured');
      }

      if (this.isTokenExpired()) {
        const loginResult = await this.login();
        if (!loginResult) {
          // Authentication failed, handleAuthError already logged it
          throw new Error('OpenSubtitles authentication failed');
        }
      }

      // First, request download link
      const downloadResponse = await this.client.post('/download', {
        file_id: parseInt(fileId)
      });

      if (!downloadResponse.data || !downloadResponse.data.link) {
        throw new Error('No download link received');
      }

      const downloadLink = downloadResponse.data.link;
      log.debug(() => ['[OpenSubtitles] Got download link:', downloadLink]);

      // Download the subtitle file as raw bytes to handle BOM/ZIP cases efficiently
      const subtitleResponse = await this.client.get(downloadLink, {
        responseType: 'arraybuffer',
        headers: { 'User-Agent': USER_AGENT },
        timeout: 12000
      });

      const buf = Buffer.isBuffer(subtitleResponse.data)
        ? subtitleResponse.data
        : Buffer.from(subtitleResponse.data);

      // ZIP by magic bytes: 50 4B 03 04
      const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;

      if (isZip) {
        const JSZip = require('jszip');
        const zip = await JSZip.loadAsync(buf, { base64: false });
        const entries = Object.keys(zip.files);
        const srtEntry = entries.find(f => f.toLowerCase().endsWith('.srt'));
        if (srtEntry) {
          const srt = await zip.files[srtEntry].async('string');
          log.debug(() => '[OpenSubtitles] Extracted .srt from ZIP');
          return srt;
        }
        const altEntry = entries.find(f => {
          const l = f.toLowerCase();
          return l.endsWith('.vtt') || l.endsWith('.ass') || l.endsWith('.ssa');
        });
        if (altEntry) {
          const uint8 = await zip.files[altEntry].async('uint8array');
          const abuf = Buffer.from(uint8);
          let raw;
          if (abuf.length >= 2 && abuf[0] === 0xFF && abuf[1] === 0xFE) raw = abuf.slice(2).toString('utf16le');
          else if (abuf.length >= 2 && abuf[0] === 0xFE && abuf[1] === 0xFF) {
            const swapped = Buffer.allocUnsafe(Math.max(0, abuf.length - 2));
            for (let i = 2, j = 0; i + 1 < abuf.length; i += 2, j += 2) { swapped[j] = abuf[i + 1]; swapped[j + 1] = abuf[i]; }
            raw = swapped.toString('utf16le');
          } else raw = abuf.toString('utf8');

          const lname = altEntry.toLowerCase();
          if (lname.endsWith('.vtt')) return raw;

          // Try library conversion, then manual fallback
          try {
            const subsrt = require('subsrt-ts');
            let converted;
            if (lname.endsWith('.ass')) converted = subsrt.convert(raw, { to: 'vtt', from: 'ass' });
            else if (lname.endsWith('.ssa')) converted = subsrt.convert(raw, { to: 'vtt', from: 'ssa' });
            else converted = subsrt.convert(raw, { to: 'vtt' });
            if (!converted || typeof converted !== 'string' || converted.trim().length === 0) {
              const sanitized = (raw || '').replace(/\u0000/g, '');
              if (sanitized && sanitized !== raw) {
                if (lname.endsWith('.ass')) converted = subsrt.convert(sanitized, { to: 'vtt', from: 'ass' });
                else if (lname.endsWith('.ssa')) converted = subsrt.convert(sanitized, { to: 'vtt', from: 'ssa' });
                else converted = subsrt.convert(sanitized, { to: 'vtt' });
              }
            }
            if (converted && converted.trim().length > 0) return converted;
            throw new Error('Empty VTT after conversion');
          } catch (_) {
            const manual = (function assToVttFallback(input) {
              if (!input || !/\[events\]/i.test(input)) return null;
              const lines = input.split(/\r?\n/); let format = []; let inEvents = false;
              for (const line of lines) {
                const l = line.trim();
                if (/^\[events\]/i.test(l)) { inEvents = true; continue; }
                if (!inEvents) continue;
                if (/^\[.*\]/.test(l)) break;
                if (/^format\s*:/i.test(l)) format = l.split(':')[1].split(',').map(s => s.trim().toLowerCase());
              }
              const idxStart = Math.max(0, format.indexOf('start'));
              const idxEnd = Math.max(1, format.indexOf('end'));
              const idxText = format.length > 0 ? Math.max(format.indexOf('text'), format.length - 1) : 9;
              const out = ['WEBVTT', ''];
              const parseTime = (t) => {
                const m = t.trim().match(/(\d+):(\d{2}):(\d{2})[\.\:](\d{2})/);
                if (!m) return null;
                const h = +m[1]||0, mi=+m[2]||0, s=+m[3]||0, cs=+m[4]||0;
                const ms=(h*3600+mi*60+s)*1000+cs*10;
                const hh=String(Math.floor(ms/3600000)).padStart(2,'0');
                const mm=String(Math.floor((ms%3600000)/60000)).padStart(2,'0');
                const ss=String(Math.floor((ms%60000)/1000)).padStart(2,'0');
                const mmm=String(ms%1000).padStart(3,'0');
                return `${hh}:${mm}:${ss}.${mmm}`;
              };
              const cleanText = (txt) => {
                let t = txt.replace(/\{[^}]*\}/g,'');
                t = t.replace(/\\N/g,'\n').replace(/\\n/g,'\n').replace(/\\h/g,' ');
                t = t.replace(/[\u0000-\u001F]/g,'');
                return t.trim();
              };
              for (const line of lines) {
                if (!/^dialogue\s*:/i.test(line)) continue;
                const payload=line.split(':').slice(1).join(':');
                const parts=[]; let cur=''; let splits=0;
                for (let i=0;i<payload.length;i++){const ch=payload[i]; if(ch===',' && splits<Math.max(idxText,9)){parts.push(cur);cur='';splits++;} else {cur+=ch;}}
                parts.push(cur);
                const st=parseTime(parts[idxStart]); const et=parseTime(parts[idxEnd]);
                if (!st||!et) continue; const ct=cleanText(parts[idxText]??''); if(!ct) continue;
                out.push(`${st} --> ${et}`); out.push(ct); out.push('');
              }
              return out.length>2?out.join('\n'):null;
            })(raw);
            if (manual && manual.trim().length>0) return manual;
          }
        }
        throw new Error('Failed to extract or convert subtitle from ZIP (no .srt and conversion to VTT failed)');
      }

      // Non-ZIP: decode with BOM awareness
      let text;
      if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) text = buf.slice(2).toString('utf16le');
      else if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
        const swapped = Buffer.allocUnsafe(Math.max(0, buf.length - 2));
        for (let i = 2, j = 0; i + 1 < buf.length; i += 2, j += 2) { swapped[j] = buf[i + 1]; swapped[j + 1] = buf[i]; }
        text = swapped.toString('utf16le');
      } else text = buf.toString('utf8');

      const trimmed = (text || '').trimStart();
      if (trimmed.startsWith('WEBVTT')) {
        log.debug(() => '[OpenSubtitles] Detected VTT; returning original VTT');
        return text;
      }

      // If content looks like ASS/SSA, convert to SRT
      if (/\[events\]/i.test(text) || /^dialogue\s*:/im.test(text)) {
        try {
          const subsrt = require('subsrt-ts');
          let converted = subsrt.convert(text, { to: 'vtt', from: 'ass' });
          if (!converted || converted.trim().length === 0) {
            const sanitized = (text || '').replace(/\u0000/g, '');
            converted = subsrt.convert(sanitized, { to: 'vtt', from: 'ass' });
          }
          if (converted && converted.trim().length > 0) return converted;
        } catch (_) {
          // ignore and fallback to manual
        }
        const manual = (function assToVttFallback(input) {
          if (!input || !/\[events\]/i.test(input)) return null;
          const lines = input.split(/\r?\n/); let format = []; let inEvents = false;
          for (const line of lines) {
            const l = line.trim(); if (/^\[events\]/i.test(l)) { inEvents = true; continue; }
            if (!inEvents) continue; if (/^\[.*\]/.test(l)) break;
            if (/^format\s*:/i.test(l)) format = l.split(':')[1].split(',').map(s => s.trim().toLowerCase());
          }
          const idxStart = Math.max(0, format.indexOf('start'));
          const idxEnd = Math.max(1, format.indexOf('end'));
          const idxText = format.length > 0 ? Math.max(format.indexOf('text'), format.length - 1) : 9;
          const out = ['WEBVTT', ''];
          const parseTime = (t) => {
            const m = t.trim().match(/(\d+):(\d{2}):(\d{2})[\.\:](\d{2})/);
            if (!m) return null; const h=+m[1]||0, mi=+m[2]||0, s=+m[3]||0, cs=+m[4]||0;
            const ms=(h*3600+mi*60+s)*1000+cs*10; const hh=String(Math.floor(ms/3600000)).padStart(2,'0');
            const mm=String(Math.floor((ms%3600000)/60000)).padStart(2,'0'); const ss=String(Math.floor((ms%60000)/1000)).padStart(2,'0');
            const mmm=String(ms%1000).padStart(3,'0'); return `${hh}:${mm}:${ss}.${mmm}`;
          };
          const cleanText = (txt) => { let t = txt.replace(/\{[^}]*\}/g,''); t = t.replace(/\\N/g,'\n').replace(/\\n/g,'\n').replace(/\\h/g,' ');
            t = t.replace(/[\u0000-\u001F]/g,''); return t.trim(); };
          for (const line of lines) {
            if (!/^dialogue\s*:/i.test(line)) continue; const payload=line.split(':').slice(1).join(':');
            const parts=[]; let cur=''; let splits=0; for (let i=0;i<payload.length;i++){const ch=payload[i]; if(ch===',' && splits<Math.max(idxText,9)){parts.push(cur);cur='';splits++;} else {cur+=ch;}}
            parts.push(cur); const st=parseTime(parts[idxStart]); const et=parseTime(parts[idxEnd]); if(!st||!et) continue;
            const ct=cleanText(parts[idxText]??''); if(!ct) continue; out.push(`${st} --> ${et}`); out.push(ct); out.push('');
          }
          return out.length>2?out.join('\n'):null;
        })(text);
        if (manual && manual.trim().length > 0) return manual;
      }

      log.debug(() => '[OpenSubtitles] Subtitle downloaded successfully');
      return text;

    } catch (error) {
      handleDownloadError(error, 'OpenSubtitles');
    }
  }

  /**
   * Normalize language code to ISO-639-2 for Stremio
   * @param {string} language - Language code or name from OpenSubtitles (ISO-639-2)
   * @returns {string} - ISO-639-2 language code (3-letter)
   */
  normalizeLanguageCode(language) {
    if (!language) return null;

    const lower = language.toLowerCase().trim();

    // Map OpenSubtitles language names to ISO-639-2 codes
    const languageNameMap = {
      'english': 'eng',
      'spanish': 'spa',
      'french': 'fre',
      'german': 'ger',
      'italian': 'ita',
      'portuguese': 'por',
      'russian': 'rus',
      'japanese': 'jpn',
      'chinese': 'chi',
      'korean': 'kor',
      'arabic': 'ara',
      'dutch': 'dut',
      'polish': 'pol',
      'turkish': 'tur',
      'swedish': 'swe',
      'norwegian': 'nor',
      'danish': 'dan',
      'finnish': 'fin',
      'greek': 'gre',
      'hebrew': 'heb',
      'hindi': 'hin',
      'czech': 'cze',
      'hungarian': 'hun',
      'romanian': 'rum',
      'thai': 'tha',
      'vietnamese': 'vie',
      'indonesian': 'ind',
      'malay': 'may',
      'ukrainian': 'ukr',
      'bulgarian': 'bul',
      'croatian': 'hrv',
      'serbian': 'srp',
      'slovak': 'slo',
      'slovenian': 'slv',
      'estonian': 'est',
      'latvian': 'lav',
      'lithuanian': 'lit',
      'farsi': 'per',
      'persian': 'per',
      'bengali': 'ben',
      'catalan': 'cat',
      'basque': 'baq',
      'galician': 'glg',
      'bosnian': 'bos',
      'macedonian': 'mac',
      'albanian': 'alb',
      'belarusian': 'bel',
      'azerbaijani': 'aze',
      'georgian': 'geo',
      'malayalam': 'mal',
      'tamil': 'tam',
      'telugu': 'tel',
      'urdu': 'urd',
      'tagalog': 'tgl',
      'icelandic': 'ice',
      'kurdish': 'kur',
      'afrikaans': 'afr',
      'armenian': 'arm',
      'kazakh': 'kaz',
      'mongolian': 'mon',
      'nepali': 'nep',
      'punjabi': 'pan',
      'sinhala': 'sin',
      'swahili': 'swa',
      'uzbek': 'uzb',
      'amharic': 'amh',
      'burmese': 'bur',
      'khmer': 'khm',
      'central khmer': 'khm',
      'lao': 'lao',
      'pashto': 'pus',
      'somali': 'som',
      'sinhalese': 'sin'
    };

    // Check if it's a full language name
    if (languageNameMap[lower]) {
      return languageNameMap[lower];
    }

    // Handle special cases for regional variants per OpenSubtitles API format
    if (lower.includes('portuguese') && (lower.includes('brazil') || lower.includes('br'))) {
      return 'pob';
    }
    if (lower === 'brazilian' || lower === 'pt-br' || lower === 'ptbr') {
      return 'pob';
    }

    // Spanish (Latin America) short code sometimes appears as 'ea'
    if (lower === 'ea') {
      return 'spn';
    }

    // OS two-letter or variant codes requiring explicit mapping
    if (lower === 'sx') return 'sat'; // Santali
    if (lower === 'at') return 'ast'; // Asturian
    if (lower === 'pr') return 'per'; // Dari -> Persian macro
    if (lower === 'ex') return 'ext'; // Extremaduran (639-3)
    if (lower === 'ma') return 'mni'; // Manipuri
    if (lower === 'pm') return 'por'; // Portuguese (Mozambique)
    if (lower === 'sp') return 'spa'; // Spanish (EU)
    if (lower === 'sy') return 'syr'; // Syriac
    if (lower === 'tm-td') return 'tet'; // Tetum
    if (lower === 'tp') return 'tok'; // Toki Pona (639-3)

    // Handle Chinese variants per OpenSubtitles API format
    if (lower === 'zh-cn' || lower === 'zhcn' || (lower.includes('chinese') && lower.includes('simplified'))) {
      return 'zhs';
    }
    if (lower === 'zh-tw' || lower === 'zhtw' || (lower.includes('chinese') && lower.includes('traditional'))) {
      return 'zht';
    }
    if (lower === 'ze' || lower === 'chinese bilingual') {
      return 'ze';
    }

    // Handle Montenegrin
    if (lower === 'me' || lower === 'montenegrin') {
      return 'mne';
    }

    // Normalize region-style codes like 'pt-PT', 'az-ZB' to base ISO-639-2
    // Keep 'pt-br' handled above to map specifically to 'pob'
    const regionMatch = lower.match(/^([a-z]{2})-[a-z0-9]{2,}$/);
    if (regionMatch) {
      const base = regionMatch[1];
      // Map 'pt-pt' explicitly to Portuguese
      if (lower === 'pt-pt') {
        return 'por';
      }
      const iso2Codes = toISO6392(base);
      if (iso2Codes && iso2Codes.length > 0) {
        return iso2Codes[0].code2; // Convert base to ISO-639-2
      }
    }

    // If it's already 3 letters, assume it's ISO-639-2
    if (lower.length === 3 && /^[a-z]{3}$/.test(lower)) {
      return lower;
    }

    // If it's 2 letters, convert from ISO-639-1 to ISO-639-2
    if (lower.length === 2 && /^[a-z]{2}$/.test(lower)) {
      const iso2Codes = toISO6392(lower);
      if (iso2Codes && iso2Codes.length > 0) {
        return iso2Codes[0].code2; // Return the first ISO-639-2 code
      }
    }

    // Unknown language
    log.warn(() => `[OpenSubtitles] Unknown language format: "${language}", filtering out`);
    return null;
  }
}

module.exports = OpenSubtitlesService;
