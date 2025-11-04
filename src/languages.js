// Comprehensive ISO639-2 language mappings for Stremio with ISO639-1 mappings for OpenSubtitles
// Special handling for PTBR (Portuguese Brazil) and other regional variants

const languages = {
  // Major languages with regional variants
  'por': { name: 'Portuguese', iso639_1: 'pt', flag: '🇵🇹' },
  'pob': { name: 'Portuguese (Brazil)', iso639_1: 'pb', flag: '🇧🇷', stremioCode: 'pob' }, // PTBR
  'eng': { name: 'English', iso639_1: 'en', flag: '🇬🇧' },
  'spa': { name: 'Spanish', iso639_1: 'es', flag: '🇪🇸' },
  'fra': { name: 'French', iso639_1: 'fr', flag: '🇫🇷' },
  'deu': { name: 'German', iso639_1: 'de', flag: '🇩🇪' },
  'ita': { name: 'Italian', iso639_1: 'it', flag: '🇮🇹' },
  'rus': { name: 'Russian', iso639_1: 'ru', flag: '🇷🇺' },
  'jpn': { name: 'Japanese', iso639_1: 'ja', flag: '🇯🇵' },
  'kor': { name: 'Korean', iso639_1: 'ko', flag: '🇰🇷' },
  'chi': { name: 'Chinese', iso639_1: 'zh', flag: '🇨🇳' },
  'zho': { name: 'Chinese (Simplified)', iso639_1: 'zh', flag: '🇨🇳' },
  'zht': { name: 'Chinese (Traditional)', iso639_1: 'zh', flag: '🇹🇼' },
  'ara': { name: 'Arabic', iso639_1: 'ar', flag: '🇸🇦' },
  'hin': { name: 'Hindi', iso639_1: 'hi', flag: '🇮🇳' },
  'ben': { name: 'Bengali', iso639_1: 'bn', flag: '🇧🇩' },
  'tur': { name: 'Turkish', iso639_1: 'tr', flag: '🇹🇷' },
  'pol': { name: 'Polish', iso639_1: 'pl', flag: '🇵🇱' },
  'nld': { name: 'Dutch', iso639_1: 'nl', flag: '🇳🇱' },
  'swe': { name: 'Swedish', iso639_1: 'sv', flag: '🇸🇪' },
  'nor': { name: 'Norwegian', iso639_1: 'no', flag: '🇳🇴' },
  'dan': { name: 'Danish', iso639_1: 'da', flag: '🇩🇰' },
  'fin': { name: 'Finnish', iso639_1: 'fi', flag: '🇫🇮' },
  'ces': { name: 'Czech', iso639_1: 'cs', flag: '🇨🇿' },
  'hun': { name: 'Hungarian', iso639_1: 'hu', flag: '🇭🇺' },
  'ron': { name: 'Romanian', iso639_1: 'ro', flag: '🇷🇴' },
  'ell': { name: 'Greek', iso639_1: 'el', flag: '🇬🇷' },
  'heb': { name: 'Hebrew', iso639_1: 'he', flag: '🇮🇱' },
  'ukr': { name: 'Ukrainian', iso639_1: 'uk', flag: '🇺🇦' },
  'vie': { name: 'Vietnamese', iso639_1: 'vi', flag: '🇻🇳' },
  'tha': { name: 'Thai', iso639_1: 'th', flag: '🇹🇭' },
  'ind': { name: 'Indonesian', iso639_1: 'id', flag: '🇮🇩' },
  'msa': { name: 'Malay', iso639_1: 'ms', flag: '🇲🇾' },
  'fil': { name: 'Filipino', iso639_1: 'tl', flag: '🇵🇭' },
  'bul': { name: 'Bulgarian', iso639_1: 'bg', flag: '🇧🇬' },
  'hrv': { name: 'Croatian', iso639_1: 'hr', flag: '🇭🇷' },
  'srp': { name: 'Serbian', iso639_1: 'sr', flag: '🇷🇸' },
  'slv': { name: 'Slovenian', iso639_1: 'sl', flag: '🇸🇮' },
  'slk': { name: 'Slovak', iso639_1: 'sk', flag: '🇸🇰' },
  'est': { name: 'Estonian', iso639_1: 'et', flag: '🇪🇪' },
  'lav': { name: 'Latvian', iso639_1: 'lv', flag: '🇱🇻' },
  'lit': { name: 'Lithuanian', iso639_1: 'lt', flag: '🇱🇹' },
  'cat': { name: 'Catalan', iso639_1: 'ca', flag: '🏴' },
  'eus': { name: 'Basque', iso639_1: 'eu', flag: '🏴' },
  'glg': { name: 'Galician', iso639_1: 'gl', flag: '🏴' },
  'isl': { name: 'Icelandic', iso639_1: 'is', flag: '🇮🇸' },
  'sqi': { name: 'Albanian', iso639_1: 'sq', flag: '🇦🇱' },
  'mkd': { name: 'Macedonian', iso639_1: 'mk', flag: '🇲🇰' },
  'bos': { name: 'Bosnian', iso639_1: 'bs', flag: '🇧🇦' },
  'aze': { name: 'Azerbaijani', iso639_1: 'az', flag: '🇦🇿' },
  'kat': { name: 'Georgian', iso639_1: 'ka', flag: '🇬🇪' },
  'hye': { name: 'Armenian', iso639_1: 'hy', flag: '🇦🇲' },
  'per': { name: 'Persian', iso639_1: 'fa', flag: '🇮🇷' },
  'fas': { name: 'Persian (Farsi)', iso639_1: 'fa', flag: '🇮🇷' },
  'urd': { name: 'Urdu', iso639_1: 'ur', flag: '🇵🇰' },
  'tam': { name: 'Tamil', iso639_1: 'ta', flag: '🇮🇳' },
  'tel': { name: 'Telugu', iso639_1: 'te', flag: '🇮🇳' },
  'kan': { name: 'Kannada', iso639_1: 'kn', flag: '🇮🇳' },
  'mal': { name: 'Malayalam', iso639_1: 'ml', flag: '🇮🇳' },
  'mar': { name: 'Marathi', iso639_1: 'mr', flag: '🇮🇳' },
  'pan': { name: 'Punjabi', iso639_1: 'pa', flag: '🇮🇳' },
  'guj': { name: 'Gujarati', iso639_1: 'gu', flag: '🇮🇳' },
};

// Create reverse mapping from ISO639-1 to ISO639-2
const iso639_1ToIso639_2 = {};
Object.keys(languages).forEach(code => {
  const lang = languages[code];
  if (lang.iso639_1 && !iso639_1ToIso639_2[lang.iso639_1]) {
    iso639_1ToIso639_2[lang.iso639_1] = code;
  }
});

// Special mapping for OpenSubtitles
const openSubtitlesMapping = {
  'pob': 'pb', // Portuguese (Brazil)
  'por': 'pt',
};

/**
 * Get ISO639-1 code for OpenSubtitles API
 * @param {string} iso639_2 - The ISO639-2 code
 * @returns {string} - The ISO639-1 code
 */
function getISO639_1(iso639_2) {
  if (openSubtitlesMapping[iso639_2]) {
    return openSubtitlesMapping[iso639_2];
  }
  const lang = languages[iso639_2];
  return lang ? lang.iso639_1 : iso639_2;
}

/**
 * Get language name
 * @param {string} code - ISO639-2 or ISO639-1 code
 * @returns {string} - Language name
 */
function getLanguageName(code) {
  if (languages[code]) {
    return languages[code].name;
  }
  // Try to find by ISO639-1
  const iso639_2 = iso639_1ToIso639_2[code];
  if (iso639_2 && languages[iso639_2]) {
    return languages[iso639_2].name;
  }
  return code;
}

/**
 * Get all supported languages as array for UI
 * @returns {Array} - Array of language objects
 */
function getAllLanguages() {
  return Object.keys(languages)
    .map(code => ({
      code,
      name: languages[code].name,
      flag: languages[code].flag,
      iso639_1: languages[code].iso639_1
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  languages,
  getISO639_1,
  getLanguageName,
  getAllLanguages,
  iso639_1ToIso639_2,
  openSubtitlesMapping
};
