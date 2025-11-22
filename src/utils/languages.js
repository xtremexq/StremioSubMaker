// Comprehensive language mapping for Stremio (ISO-639-2) to OpenSubtitles (ISO-639-1)
// Includes special cases like PT-BR

const languageMap = {
  // Full ISO-639-2 to ISO-639-1 mapping
  'aar': { code1: 'aa', name: 'Afar' },
  'abk': { code1: 'ab', name: 'Abkhazian' },
  'afr': { code1: 'af', name: 'Afrikaans' },
  'aka': { code1: 'ak', name: 'Akan' },
  'alb': { code1: 'sq', name: 'Albanian' },
  'sqi': { code1: 'sq', name: 'Albanian' },
  'amh': { code1: 'am', name: 'Amharic' },
  'ara': { code1: 'ar', name: 'Arabic' },
  'arg': { code1: 'an', name: 'Aragonese' },
  'arm': { code1: 'hy', name: 'Armenian' },
  'hye': { code1: 'hy', name: 'Armenian' },
  'asm': { code1: 'as', name: 'Assamese' },
  'ava': { code1: 'av', name: 'Avaric' },
  'ave': { code1: 'ae', name: 'Avestan' },
  'aym': { code1: 'ay', name: 'Aymara' },
  'aze': { code1: 'az', name: 'Azerbaijani' },
  'bak': { code1: 'ba', name: 'Bashkir' },
  'bam': { code1: 'bm', name: 'Bambara' },
  'baq': { code1: 'eu', name: 'Basque' },
  'eus': { code1: 'eu', name: 'Basque' },
  'bel': { code1: 'be', name: 'Belarusian' },
  'ben': { code1: 'bn', name: 'Bengali' },
  'bih': { code1: 'bh', name: 'Bihari languages' },
  'bis': { code1: 'bi', name: 'Bislama' },
  'bos': { code1: 'bs', name: 'Bosnian' },
  'bre': { code1: 'br', name: 'Breton' },
  'bul': { code1: 'bg', name: 'Bulgarian' },
  'bur': { code1: 'my', name: 'Burmese' },
  'mya': { code1: 'my', name: 'Burmese' },
  'cat': { code1: 'ca', name: 'Catalan' },
  'cha': { code1: 'ch', name: 'Chamorro' },
  'che': { code1: 'ce', name: 'Chechen' },
  'chi': { code1: 'zh', name: 'Chinese' },
  'zho': { code1: 'zh', name: 'Chinese' },
  'chu': { code1: 'cu', name: 'Church Slavic' },
  'chv': { code1: 'cv', name: 'Chuvash' },
  'cor': { code1: 'kw', name: 'Cornish' },
  'cos': { code1: 'co', name: 'Corsican' },
  'cre': { code1: 'cr', name: 'Cree' },
  'cze': { code1: 'cs', name: 'Czech' },
  'ces': { code1: 'cs', name: 'Czech' },
  'dan': { code1: 'da', name: 'Danish' },
  'div': { code1: 'dv', name: 'Divehi' },
  'dut': { code1: 'nl', name: 'Dutch' },
  'nld': { code1: 'nl', name: 'Dutch' },
  'dzo': { code1: 'dz', name: 'Dzongkha' },
  'eng': { code1: 'en', name: 'English' },
  'epo': { code1: 'eo', name: 'Esperanto' },
  'est': { code1: 'et', name: 'Estonian' },
  'ewe': { code1: 'ee', name: 'Ewe' },
  'fao': { code1: 'fo', name: 'Faroese' },
  'fij': { code1: 'fj', name: 'Fijian' },
  'fin': { code1: 'fi', name: 'Finnish' },
  'fre': { code1: 'fr', name: 'French' },
  'fra': { code1: 'fr', name: 'French' },
  'ful': { code1: 'ff', name: 'Fulah' },
  'geo': { code1: 'ka', name: 'Georgian' },
  'kat': { code1: 'ka', name: 'Georgian' },
  'ger': { code1: 'de', name: 'German' },
  'deu': { code1: 'de', name: 'German' },
  'gla': { code1: 'gd', name: 'Gaelic' },
  'gle': { code1: 'ga', name: 'Irish' },
  'glg': { code1: 'gl', name: 'Galician' },
  'glv': { code1: 'gv', name: 'Manx' },
  'gre': { code1: 'el', name: 'Greek' },
  'ell': { code1: 'el', name: 'Greek' },
  'grn': { code1: 'gn', name: 'Guarani' },
  'guj': { code1: 'gu', name: 'Gujarati' },
  'hat': { code1: 'ht', name: 'Haitian' },
  'hau': { code1: 'ha', name: 'Hausa' },
  'heb': { code1: 'he', name: 'Hebrew' },
  'her': { code1: 'hz', name: 'Herero' },
  'hin': { code1: 'hi', name: 'Hindi' },
  'hmo': { code1: 'ho', name: 'Hiri Motu' },
  'hrv': { code1: 'hr', name: 'Croatian' },
  'hun': { code1: 'hu', name: 'Hungarian' },
  'ibo': { code1: 'ig', name: 'Igbo' },
  'ice': { code1: 'is', name: 'Icelandic' },
  'isl': { code1: 'is', name: 'Icelandic' },
  'ido': { code1: 'io', name: 'Ido' },
  'iii': { code1: 'ii', name: 'Sichuan Yi' },
  'iku': { code1: 'iu', name: 'Inuktitut' },
  'ile': { code1: 'ie', name: 'Interlingue' },
  'ina': { code1: 'ia', name: 'Interlingua' },
  'ind': { code1: 'id', name: 'Indonesian' },
  'ipk': { code1: 'ik', name: 'Inupiaq' },
  'ita': { code1: 'it', name: 'Italian' },
  'jav': { code1: 'jv', name: 'Javanese' },
  'jpn': { code1: 'ja', name: 'Japanese' },
  'kal': { code1: 'kl', name: 'Kalaallisut' },
  'kan': { code1: 'kn', name: 'Kannada' },
  'kas': { code1: 'ks', name: 'Kashmiri' },
  'kau': { code1: 'kr', name: 'Kanuri' },
  'kaz': { code1: 'kk', name: 'Kazakh' },
  'khm': { code1: 'km', name: 'Central Khmer' },
  'kik': { code1: 'ki', name: 'Kikuyu' },
  'kin': { code1: 'rw', name: 'Kinyarwanda' },
  'kir': { code1: 'ky', name: 'Kirghiz' },
  'kom': { code1: 'kv', name: 'Komi' },
  'kon': { code1: 'kg', name: 'Kongo' },
  'kor': { code1: 'ko', name: 'Korean' },
  'kua': { code1: 'kj', name: 'Kuanyama' },
  'kur': { code1: 'ku', name: 'Kurdish' },
  'lao': { code1: 'lo', name: 'Lao' },
  'lat': { code1: 'la', name: 'Latin' },
  'lav': { code1: 'lv', name: 'Latvian' },
  'lim': { code1: 'li', name: 'Limburgan' },
  'lin': { code1: 'ln', name: 'Lingala' },
  'lit': { code1: 'lt', name: 'Lithuanian' },
  'ltz': { code1: 'lb', name: 'Luxembourgish' },
  'lub': { code1: 'lu', name: 'Luba-Katanga' },
  'lug': { code1: 'lg', name: 'Ganda' },
  'mac': { code1: 'mk', name: 'Macedonian' },
  'mkd': { code1: 'mk', name: 'Macedonian' },
  'mah': { code1: 'mh', name: 'Marshallese' },
  'mal': { code1: 'ml', name: 'Malayalam' },
  'mao': { code1: 'mi', name: 'Maori' },
  'mri': { code1: 'mi', name: 'Maori' },
  'mar': { code1: 'mr', name: 'Marathi' },
  'may': { code1: 'ms', name: 'Malay' },
  'msa': { code1: 'ms', name: 'Malay' },
  'mlg': { code1: 'mg', name: 'Malagasy' },
  'mlt': { code1: 'mt', name: 'Maltese' },
  'mon': { code1: 'mn', name: 'Mongolian' },
  'nau': { code1: 'na', name: 'Nauru' },
  'nav': { code1: 'nv', name: 'Navajo' },
  'nbl': { code1: 'nr', name: 'South Ndebele' },
  'nde': { code1: 'nd', name: 'North Ndebele' },
  'ndo': { code1: 'ng', name: 'Ndonga' },
  'nep': { code1: 'ne', name: 'Nepali' },
  'nno': { code1: 'nn', name: 'Norwegian Nynorsk' },
  'nob': { code1: 'nb', name: 'Norwegian Bokmål' },
  'nor': { code1: 'no', name: 'Norwegian' },
  'nya': { code1: 'ny', name: 'Chichewa' },
  'oci': { code1: 'oc', name: 'Occitan' },
  'oji': { code1: 'oj', name: 'Ojibwa' },
  'ori': { code1: 'or', name: 'Oriya' },
  'orm': { code1: 'om', name: 'Oromo' },
  'oss': { code1: 'os', name: 'Ossetian' },
  'pan': { code1: 'pa', name: 'Panjabi' },
  'per': { code1: 'fa', name: 'Persian' },
  'fas': { code1: 'fa', name: 'Persian' },
  'pli': { code1: 'pi', name: 'Pali' },
  'pol': { code1: 'pl', name: 'Polish' },
  'por': { code1: 'pt', name: 'Portuguese' },
  'pus': { code1: 'ps', name: 'Pushto' },
  'que': { code1: 'qu', name: 'Quechua' },
  'roh': { code1: 'rm', name: 'Romansh' },
  'rum': { code1: 'ro', name: 'Romanian' },
  'ron': { code1: 'ro', name: 'Romanian' },
  'run': { code1: 'rn', name: 'Rundi' },
  'rus': { code1: 'ru', name: 'Russian' },
  'sag': { code1: 'sg', name: 'Sango' },
  'san': { code1: 'sa', name: 'Sanskrit' },
  'sin': { code1: 'si', name: 'Sinhala' },
  'slo': { code1: 'sk', name: 'Slovak' },
  'slk': { code1: 'sk', name: 'Slovak' },
  'slv': { code1: 'sl', name: 'Slovenian' },
  'sme': { code1: 'se', name: 'Northern Sami' },
  'smo': { code1: 'sm', name: 'Samoan' },
  'sna': { code1: 'sn', name: 'Shona' },
  'snd': { code1: 'sd', name: 'Sindhi' },
  'som': { code1: 'so', name: 'Somali' },
  'sot': { code1: 'st', name: 'Southern Sotho' },
  'spa': { code1: 'es', name: 'Spanish' },
  'srd': { code1: 'sc', name: 'Sardinian' },
  'srp': { code1: 'sr', name: 'Serbian' },
  'ssw': { code1: 'ss', name: 'Swati' },
  'sun': { code1: 'su', name: 'Sundanese' },
  'swa': { code1: 'sw', name: 'Swahili' },
  'swe': { code1: 'sv', name: 'Swedish' },
  'tah': { code1: 'ty', name: 'Tahitian' },
  'tam': { code1: 'ta', name: 'Tamil' },
  'tat': { code1: 'tt', name: 'Tatar' },
  'tel': { code1: 'te', name: 'Telugu' },
  'tgk': { code1: 'tg', name: 'Tajik' },
  'tgl': { code1: 'tl', name: 'Tagalog' },
  'tha': { code1: 'th', name: 'Thai' },
  'tib': { code1: 'bo', name: 'Tibetan' },
  'bod': { code1: 'bo', name: 'Tibetan' },
  'tir': { code1: 'ti', name: 'Tigrinya' },
  'ton': { code1: 'to', name: 'Tonga' },
  'tsn': { code1: 'tn', name: 'Tswana' },
  'tso': { code1: 'ts', name: 'Tsonga' },
  'tuk': { code1: 'tk', name: 'Turkmen' },
  'tur': { code1: 'tr', name: 'Turkish' },
  'twi': { code1: 'tw', name: 'Twi' },
  'uig': { code1: 'ug', name: 'Uighur' },
  'ukr': { code1: 'uk', name: 'Ukrainian' },
  'urd': { code1: 'ur', name: 'Urdu' },
  'uzb': { code1: 'uz', name: 'Uzbek' },
  'ven': { code1: 've', name: 'Venda' },
  'vie': { code1: 'vi', name: 'Vietnamese' },
  'vol': { code1: 'vo', name: 'Volapük' },
  'wel': { code1: 'cy', name: 'Welsh' },
  'cym': { code1: 'cy', name: 'Welsh' },
  'wln': { code1: 'wa', name: 'Walloon' },
  'wol': { code1: 'wo', name: 'Wolof' },
  'xho': { code1: 'xh', name: 'Xhosa' },
  'yid': { code1: 'yi', name: 'Yiddish' },
  'yor': { code1: 'yo', name: 'Yoruba' },
  'zha': { code1: 'za', name: 'Zhuang' },
  'zul': { code1: 'zu', name: 'Zulu' },

  // Special cases for regional variants (per OpenSubtitles API)
  'pob': { code1: 'pt-br', name: 'Portuguese (Brazilian)', isCustom: true },
  'ptbr': { code1: 'pt-br', name: 'Portuguese (Brazilian)', isCustom: true },
  'pt-br': { code1: 'pt-br', name: 'Portuguese (Brazilian)', isCustom: true },
  'spn': { code1: 'ea', name: 'Spanish (Latin America)', isCustom: true },
  'mne': { code1: 'me', name: 'Montenegrin', isCustom: true },
  'zht': { code1: 'zh-tw', name: 'Chinese (traditional)', isCustom: true },
  'zhs': { code1: 'zh-cn', name: 'Chinese (simplified)', isCustom: true },
  'ze': { code1: 'ze', name: 'Chinese bilingual', isCustom: true },

  // Additional languages observed in OpenSubtitles API list
  // Use OS-specific short codes in code1 to maximize compatibility with their REST API
  'ast': { code1: 'at', name: 'Asturian', isCustom: true },
  'ext': { code1: 'ex', name: 'Extremaduran', isCustom: true },
  'mni': { code1: 'ma', name: 'Manipuri', isCustom: true },
  'syr': { code1: 'sy', name: 'Syriac', isCustom: true },
  'tet': { code1: 'tm-td', name: 'Tetum', isCustom: true },
  'sat': { code1: 'sx', name: 'Santali', isCustom: true },
  'tok': { code1: 'tp', name: 'Toki Pona', isCustom: true },
};

// Reverse mapping for ISO-639-1 to ISO-639-2
const reverseLanguageMap = {};
Object.keys(languageMap).forEach(code2 => {
  const { code1, name, isCustom } = languageMap[code2];
  if (!reverseLanguageMap[code1]) {
    reverseLanguageMap[code1] = [];
  }
  reverseLanguageMap[code1].push({ code2, name, isCustom: isCustom || false });
});

/**
 * Convert ISO-639-2 code to ISO-639-1 code
 * @param {string} code2 - ISO-639-2 code (e.g., 'eng', 'pob')
 * @returns {string|null} - ISO-639-1 code (e.g., 'en', 'pb') or null if not found
 */
function toISO6391(code2) {
  const normalized = code2.toLowerCase().replace(/[_-]/g, '');
  const lang = languageMap[normalized];
  return lang ? lang.code1 : null;
}

/**
 * Convert ISO-639-1 code to ISO-639-2 code(s)
 * @param {string} code1 - ISO-639-1 code (e.g., 'en', 'pb')
 * @returns {Array} - Array of ISO-639-2 codes with names
 */
function toISO6392(code1) {
  const normalized = code1.toLowerCase();
  return reverseLanguageMap[normalized] || [];
}

/**
 * Get language name from ISO-639-2 code
 * @param {string} code2 - ISO-639-2 code
 * @returns {string|null} - Language name or null if not found
 */
function getLanguageName(code2) {
  const normalized = code2.toLowerCase().replace(/[_-]/g, '');
  const lang = languageMap[normalized];
  return lang ? lang.name : null;
}

/**
 * Get all supported languages for Stremio (ISO-639-2)
 * @returns {Array} - Array of { code: string, name: string } objects
 */
function getAllLanguages() {
  const languages = [];
  const seen = new Set();

  Object.keys(languageMap).forEach(code2 => {
    const { name } = languageMap[code2];
    const key = `${code2}:${name}`;

    if (!seen.has(key)) {
      seen.add(key);
      languages.push({ code: code2, name });
    }
  });

  return languages.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get all supported languages for OpenSubtitles (ISO-639-1)
 * @returns {Array} - Array of { code: string, name: string } objects
 */
function getAllLanguagesISO1() {
  const languages = [];
  const seen = new Set();

  Object.keys(reverseLanguageMap).forEach(code1 => {
    const variants = reverseLanguageMap[code1];
    variants.forEach(({ name }) => {
      const key = `${code1}:${name}`;

      if (!seen.has(key)) {
        seen.add(key);
        languages.push({ code: code1, name });
      }
    });
  });

  return languages.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get display name for language code, including translation variants (_tr suffix)
 * @param {string} code - Language code (e.g., 'pob', 'pob_tr', 'eng_tr')
 * @returns {string} - Display name (e.g., 'Portuguese (Brazil)', 'Translation Portuguese (Brazil)')
 */
function getDisplayName(code) {
  // Check if this is a translation variant (ends with _tr)
  const isTranslation = code.endsWith('_tr');
  const baseCode = isTranslation ? code.slice(0, -3) : code;

  // Get the base language name
  const baseName = getLanguageName(baseCode);

  if (!baseName) {
    // If we can't find the name, return the code as-is
    return code;
  }

  // Add "Translation" prefix for translation variants
  return isTranslation ? `Translation ${baseName}` : baseName;
}

module.exports = {
  languageMap,
  reverseLanguageMap,
  toISO6391,
  toISO6392,
  getLanguageName,
  getDisplayName,
  getAllLanguages,
  getAllLanguagesISO1
};
