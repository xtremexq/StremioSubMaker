/**
 * Default API Keys Configuration
 * 
 * This file contains all default API keys used by the application.
 * To remove or update API keys, simply modify this file.
 * 
 * IMPORTANT: These are default fallback keys. Users should provide their own keys
 * through the configuration page.
 */

const DEFAULT_API_KEYS = {
  // OpenSubtitles API Key (do not hardcode real keys here)
  // Get your own at: https://www.opensubtitles.com/
  OPENSUBTITLES: '',
  
  // Sub-DL API Key
  // Get your own at: https://subdl.com/
  SUBDL: '',
  
  // SubSource API Key (if you have one)
  // Get your own at: https://subsource.net/
  SUBSOURCE: '',

  // Podnapisi API Key (free API, no authentication required)
  // Podnapisi is a free subtitle service that doesn't require API keys
  PODNAPISI: '',

  // Gemini API Key
  // Get your own at: https://makersuite.google.com/app/apikey
  GEMINI: ''
};

module.exports = DEFAULT_API_KEYS;
