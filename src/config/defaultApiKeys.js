/**
 * Default API Keys Configuration
 *
 * This file contains all default API keys used by the application.
 * To remove or update API keys, simply modify this file.
 *
 * IMPORTANT: These are default fallback keys. Users should provide their own keys
 * through the configuration page.
 *
 * NOTE: OpenSubtitles uses username/password authentication only (no API keys)
 */

const DEFAULT_API_KEYS = {
  // Sub-DL API Key
  // Get your own at: https://subdl.com/
  SUBDL: '',

  // SubSource API Key (if you have one)
  // Get your own at: https://subsource.net/
  SUBSOURCE: '',

  // Wyzie Subs API Key
  // Get your own at: https://sub.wyzie.io/redeem
  // No bundled fallback key; users must provide their own
  WYZIE: '',

  // Gemini API Key
  // Get your own at: https://makersuite.google.com/app/apikey
  GEMINI: '',

  // AssemblyAI API Key
  // Get your own at: https://www.assemblyai.com/dashboard
  ASSEMBLYAI: '',

  // Cloudflare Workers AI (auto-subs via xSync extension)
  // Format: ACCOUNT_ID|TOKEN
  CF_WORKERS_AUTOSUBS: ''
};

module.exports = DEFAULT_API_KEYS;
