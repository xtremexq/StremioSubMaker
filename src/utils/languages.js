// Comprehensive language mapping for Stremio (ISO-639-2) to OpenSubtitles (ISO-639-1)
// Includes special cases like PT-BR

const { allLanguages: toolLanguages } = require('./allLanguages');

const languageMap = {
  // Full ISO-639-2 to ISO-639-1 mapping
  'aar': { code1: 'aa', name: 'Afar' },
  'abk': { code1: 'ab', name: 'Abkhaz' },
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
  'div': { code1: 'dv', name: 'Dhivehi (Maldivian)' },
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
  'ful': { code1: 'ff', name: 'Fulani (Fula)' },
  'geo': { code1: 'ka', name: 'Georgian' },
  'kat': { code1: 'ka', name: 'Georgian' },
  'ger': { code1: 'de', name: 'German' },
  'deu': { code1: 'de', name: 'German' },
  'gla': { code1: 'gd', name: 'Scottish Gaelic' },
  'gle': { code1: 'ga', name: 'Irish' },
  'glg': { code1: 'gl', name: 'Galician' },
  'glv': { code1: 'gv', name: 'Manx' },
  'gre': { code1: 'el', name: 'Greek' },
  'ell': { code1: 'el', name: 'Greek' },
  'grn': { code1: 'gn', name: 'Guarani' },
  'guj': { code1: 'gu', name: 'Gujarati' },
  'hat': { code1: 'ht', name: 'Haitian Creole' },
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
  'khm': { code1: 'km', name: 'Khmer' },
  'kik': { code1: 'ki', name: 'Kikuyu' },
  'kin': { code1: 'rw', name: 'Kinyarwanda' },
  'kir': { code1: 'ky', name: 'Kyrgyz' },
  'kom': { code1: 'kv', name: 'Komi' },
  'kon': { code1: 'kg', name: 'Kongo' },
  'kor': { code1: 'ko', name: 'Korean' },
  'kua': { code1: 'kj', name: 'Kuanyama' },
  'kur': { code1: 'ku', name: 'Kurdish' },
  'lao': { code1: 'lo', name: 'Lao' },
  'lat': { code1: 'la', name: 'Latin' },
  'lav': { code1: 'lv', name: 'Latvian' },
  'lim': { code1: 'li', name: 'Limburgish' },
  'lin': { code1: 'ln', name: 'Lingala' },
  'lit': { code1: 'lt', name: 'Lithuanian' },
  'ltz': { code1: 'lb', name: 'Luxembourgish' },
  'lub': { code1: 'lu', name: 'Luba-Katanga' },
  'lug': { code1: 'lg', name: 'Ganda (Luganda)' },
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
  'nno': { code1: 'nn', name: 'Norwegian (Nynorsk)' },
  'nob': { code1: 'nb', name: 'Norwegian (Bokmål)' },
  'nor': { code1: 'no', name: 'Norwegian' },
  'nya': { code1: 'ny', name: 'Nyanja (Chichewa)' },
  'oci': { code1: 'oc', name: 'Occitan' },
  'oji': { code1: 'oj', name: 'Ojibwa' },
  'ori': { code1: 'or', name: 'Odia (Oriya)' },
  'orm': { code1: 'om', name: 'Oromo' },
  'oss': { code1: 'os', name: 'Ossetian' },
  'pan': { code1: 'pa', name: 'Punjabi' },
  'per': { code1: 'fa', name: 'Persian (Farsi)' },
  'fas': { code1: 'fa', name: 'Persian (Farsi)' },
  'pli': { code1: 'pi', name: 'Pali' },
  'pol': { code1: 'pl', name: 'Polish' },
  'por': { code1: 'pt', name: 'Portuguese' },
  'pus': { code1: 'ps', name: 'Pashto' },
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
  'sot': { code1: 'st', name: 'Sesotho' },
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
  'uig': { code1: 'ug', name: 'Uyghur' },
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
  'fil': { code1: 'fil', name: 'Filipino', isCustom: true },
  'mni': { code1: 'ma', name: 'Manipuri', isCustom: true },
  'syr': { code1: 'sy', name: 'Syriac', isCustom: true },
  'tet': { code1: 'tm-td', name: 'Tetum', isCustom: true },
  'sat': { code1: 'sx', name: 'Santali', isCustom: true },
  'tok': { code1: 'tp', name: 'Toki Pona', isCustom: true },
  'fry': { code1: 'fy', name: 'Frisian', isCustom: true },
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
 * Find ISO-639-1 code by matching a human-readable language name.
 * Searches languageMap first, then allLanguages.
 * @param {string} name - Language name (e.g., 'English', 'Portuguese (Brazilian)')
 * @returns {string|null} - ISO-639-1 code or null if not found
 */
function findISO6391ByName(name) {
  if (!name) return null;
  const normalize = (str) => String(str || '').trim().toLowerCase().replace(/[\s_()-]/g, '');
  const target = normalize(name);
  if (!target) return null;

  // First search languageMap (provider-compatible codes)
  for (const entry of Object.values(languageMap)) {
    const candidate = normalize(entry?.name);
    if (candidate && candidate === target) {
      return entry.code1 || null;
    }
  }

  // Then search allLanguages (returns the code directly, as they're already ISO-639-1/3)
  for (const entry of toolLanguages) {
    const candidate = normalize(entry?.name);
    if (candidate && candidate === target) {
      return entry.code || null;
    }
  }

  return null;
}

/**
 * Get language name from any language code (ISO-639-2, ISO-639-1, regional variants).
 * Searches languageMap first (provider-compatible codes), then allLanguages (translation codes).
 * @param {string} code - Language code (e.g., 'eng', 'pob', 'ar-BH', 'hbo', 'es-SV')
 * @returns {string|null} - Language name or null if not found
 */
function getLanguageName(code) {
  if (!code) return null;

  // First try languageMap with normalized code (removes dashes/underscores)
  const normalized = code.toLowerCase().replace(/[_-]/g, '');
  const lang = languageMap[normalized];
  if (lang) return lang.name;

  // Then try allLanguages with case-insensitive exact match (preserves regional codes like ar-BH)
  const codeLower = code.toLowerCase();
  const allLang = toolLanguages.find(l => l.code.toLowerCase() === codeLower);
  if (allLang) return allLang.name;

  return null;
}

/**
 * Get all supported languages for Stremio/subtitle providers (ISO-639-2)
 * Returns ONLY languageMap entries - these are the codes that work with
 * Stremio, OpenSubtitles, SubDL, SubSource, and other subtitle providers.
 * For AI translation target languages (with regional variants), use getAllTranslationLanguages().
 * @returns {Array} - Array of { code: string, name: string } objects
 */
function getAllLanguages() {
  const languages = [];
  const seenNames = new Set();

  Object.keys(languageMap).forEach(code2 => {
    const { name } = languageMap[code2];
    if (!seenNames.has(name)) {
      seenNames.add(name);
      languages.push({ code: code2, name });
    }
  });

  return languages.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get all languages available for AI translation targets.
 * Merges languageMap entries with allLanguages entries to provide:
 * - All provider-compatible languages (ISO-639-2)
 * - Regional variants for AI translation (en-GB, es-MX, etc.)
 * - Extended/rare languages (marked with extended: true)
 * Deduplicates by both name AND ISO-639-1 code.
 * @returns {Array} - Array of { code: string, name: string, extended?: boolean } objects
 */
function getAllTranslationLanguages() {
  const languages = [];
  const seenNames = new Set();
  const seenCode1 = new Set();  // track ISO-639-1 codes already covered

  // 1) languageMap entries first (ISO-639-2 codes for Stremio / subtitle providers)
  Object.keys(languageMap).forEach(code2 => {
    const { code1, name } = languageMap[code2];
    if (!seenNames.has(name)) {
      seenNames.add(name);
      if (code1) seenCode1.add(code1.toLowerCase());
      languages.push({ code: code2, name });
    }
  });

  // 2) Merge in allLanguages entries (ISO-639-1/3 codes for translation providers)
  //    Skip if name OR code already covered by languageMap
  toolLanguages.forEach(({ code, name, extended }) => {
    const codeLower = code.toLowerCase();
    if (!seenNames.has(name) && !seenCode1.has(codeLower)) {
      seenNames.add(name);
      seenCode1.add(codeLower);
      languages.push({ code, name, ...(extended ? { extended: true } : {}) });
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

/**
 * Build lookup maps for language detection by code or normalized name.
 * Used by the subtitle menu to resolve friendly names from varied inputs.
 * Includes both languageMap (provider-compatible) and allLanguages (translation) codes.
 * @returns {{ byCode: Record<string, string>, byNameKey: Record<string, string> }}
 */
function buildLanguageLookupMaps() {
  const byCode = {};
  const byNameKey = {};

  // 1) Add languageMap entries first (provider-compatible codes)
  Object.entries(languageMap).forEach(([code2, entry]) => {
    if (!entry || !entry.name) return;
    const normCode2 = code2.toLowerCase();
    const compactCode2 = normCode2.replace(/[_-]/g, '');
    [normCode2, compactCode2].forEach(code => {
      if (code && !byCode[code]) byCode[code] = entry.name;
    });

    if (entry.code1) {
      const normCode1 = entry.code1.toLowerCase();
      const compactCode1 = normCode1.replace(/[_-]/g, '');
      [normCode1, compactCode1].forEach(code => {
        if (code && !byCode[code]) byCode[code] = entry.name;
      });
    }

    const nameKey = entry.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (nameKey && !byNameKey[nameKey]) {
      byNameKey[nameKey] = entry.name;
    }
  });

  // 2) Add allLanguages entries (regional variants, extended languages)
  toolLanguages.forEach(({ code, name }) => {
    if (!code || !name) return;
    const normCode = code.toLowerCase();
    const compactCode = normCode.replace(/[_-]/g, '');

    // Add code lookups (don't overwrite existing entries from languageMap)
    if (normCode && !byCode[normCode]) byCode[normCode] = name;
    if (compactCode && !byCode[compactCode]) byCode[compactCode] = name;

    // Add name lookup
    const nameKey = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (nameKey && !byNameKey[nameKey]) {
      byNameKey[nameKey] = name;
    }
  });

  if (byNameKey.spanishlatinamerica) {
    ['spanishla', 'latamspanish', 'spanishlatam'].forEach(key => {
      if (!byNameKey[key]) byNameKey[key] = byNameKey.spanishlatinamerica;
    });
  }
  if (byNameKey.portuguesebrazilian) {
    ['brazilianportuguese', 'portuguesebrazil'].forEach(key => {
      if (!byNameKey[key]) byNameKey[key] = byNameKey.portuguesebrazilian;
    });
  }

  return { byCode, byNameKey };
}

/**
 * Canonicalize a language code for synced subtitle storage/lookups.
 * Always returns the preferred ISO-639-2/custom code for the given input.
 * Examples:
 *  - 'en' or 'eng' -> 'eng'
 *  - 'pt-br', 'pob', 'ptbr' -> 'pob'
 */
function canonicalSyncLanguageCode(raw) {
  const val = (raw || '').toString().trim().toLowerCase();
  if (!val) return '';

  // Prefer ISO-639-1 base when available, then pick the first ISO-639-2/custom entry
  let iso1 = toISO6391(val);
  if (!iso1 && /^[a-z]{2}(-[a-z]{2})?$/.test(val)) {
    iso1 = val;
  }

  if (iso1) {
    const variants = toISO6392(iso1) || [];
    if (variants.length) {
      const first = variants[0];
      const code2 = typeof first === 'string' ? first : first?.code2;
      if (code2) return code2.toLowerCase();
    }
  }

  // If input is already a known ISO-639-2/custom code, keep it as-is
  if (getLanguageName(val)) {
    return val;
  }

  return val;
}

/**
 * Normalize any language code (BCP-47 regional variant, ISO-639-1, ISO-639-2, custom)
 * to its canonical ISO-639-2 (3-letter) form suitable for subtitle providers.
 *
 * Examples:
 *   'es-MX'     → 'spa'    (BCP-47 regional → ISO-639-2)
 *   'en-GB'     → 'eng'    (BCP-47 regional → ISO-639-2)
 *   'zh-CN'     → 'zhs'    (Chinese simplified)
 *   'zh-TW'     → 'zht'    (Chinese traditional)
 *   'pt-BR'     → 'pob'    (Brazilian Portuguese)
 *   'es-419'    → 'spn'    (Latin American Spanish)
 *   'eng'       → 'eng'    (already ISO-639-2, no-op)
 *   'en'        → 'eng'    (ISO-639-1 → ISO-639-2)
 *
 * @param {string} lang - Language code in any supported format
 * @returns {string} - Normalized ISO-639-2 code (or original lowercased if unknown)
 */
function normalizeLanguageCode(lang) {
  if (!lang) return '';
  let lower = lang.toLowerCase().trim();

  // Handle special cases for Portuguese Brazilian (various formats)
  if (lower === 'pt-br' || lower === 'ptbr' || lower === 'pb') {
    return 'pob';
  }

  // Filipino (fil) is a custom 3-letter ISO 639-1 code for the same language as Tagalog (tgl).
  // Canonicalize to tgl so all providers and filters use a single consistent code.
  if (lower === 'fil') {
    return 'tgl';
  }

  // Helper: convert a 2-or-3-letter base code to ISO-639-2
  const baseToISO2 = (base) => {
    if (base.length === 3 && languageMap[base]) return base;
    if (base.length === 2) {
      const iso2Codes = toISO6392(base);
      if (iso2Codes && iso2Codes.length > 0) return iso2Codes[0].code2;
    }
    return null;
  };

  // --- BCP-47 compound tags (contains a hyphen or underscore) ---
  // Split into parts: base[-script][-region][-variant...]
  const parts = lower.split(/[-_]/);
  if (parts.length >= 2) {
    const base = parts[0];
    const subtag1 = parts[1];

    // Special case: Chinese regional/script variants → distinct codes
    // zh-CN, zh-SG, zh-Hans, zh-Hans-CN → zhs (simplified)
    // zh-TW, zh-HK, zh-Hant, zh-Hant-HK → zht (traditional)
    if (base === 'zh') {
      const fullTag = parts.join('-');
      if (subtag1 === 'cn' || subtag1 === 'sg' || subtag1 === 'hans' ||
        fullTag.includes('hans')) {
        return 'zhs';
      }
      if (subtag1 === 'tw' || subtag1 === 'hk' || subtag1 === 'hant' ||
        fullTag.includes('hant')) {
        return 'zht';
      }
    }

    // Special case: pt-BR variants (pt-BR-x-anything, etc.)
    if (base === 'pt' && subtag1 === 'br') {
      return 'pob';
    }

    // Special case: es-419 → spn (Latin American Spanish)
    // UN M.49 numeric region code for Latin America
    if (base === 'es' && subtag1 === '419') {
      return 'spn';
    }

    // Special case: LatAm country codes → spn (Latin American Spanish)
    // These are BCP-47 codes for countries in Latin America
    // They should fetch LatAm-tagged subtitles from providers that distinguish
    // (SubSource: spanish_latin_america, Wyzie: ea, OpenSubs V3: spn)
    const latamCountries = new Set(['ar', 'bo', 'cl', 'co', 'cr', 'cu', 'do', 'ec', 'sv', 'gt', 'hn', 'mx', 'ni', 'pa', 'py', 'pe', 'pr', 'uy', 've']);
    if (base === 'es' && latamCountries.has(subtag1)) {
      return 'spn';
    }

    // BCP-47 script subtags: exactly 4 letters (e.g., Cyrl, Latn, Mtei, Arab)
    if (/^[a-z]{4}$/.test(subtag1)) {
      const result = baseToISO2(base);
      if (result) return result;
    }

    // BCP-47 region subtags: exactly 2 letters (e.g., MX, GB, CN)
    if (/^[a-z]{2}$/.test(subtag1)) {
      const result = baseToISO2(base);
      if (result) return result;
    }

    // BCP-47 numeric region subtags: exactly 3 digits (e.g., 419, 150)
    if (/^\d{3}$/.test(subtag1)) {
      const result = baseToISO2(base);
      if (result) return result;
    }

    // Multi-part tags (e.g., zh-Hant-HK, sr-Cyrl-ME) or variant subtags
    // (e.g., sl-nedis, de-1996, ca-valencia) — extract the base language code
    const result = baseToISO2(base);
    if (result) return result;

    // Last resort for compound tags: use the base as-is
    lower = base;
  }

  // --- Simple codes (no hyphen/underscore) ---

  // Strip any remaining hyphens/underscores for compacted codes (e.g., 'ptbr')
  lower = lower.replace(/[_-]/g, '');

  // If it's already 3 letters, return as-is (ISO-639-2 or custom like pob, spn)
  if (/^[a-z]{3}$/.test(lower)) {
    return lower;
  }

  // If it's 2 letters, try to convert to ISO-639-2
  if (lower.length === 2) {
    const iso2Codes = toISO6392(lower);
    if (iso2Codes && iso2Codes.length > 0) {
      return iso2Codes[0].code2;
    }
  }

  // Return original if we can't normalize
  return lower;
}

module.exports = {
  languageMap,
  reverseLanguageMap,
  toISO6391,
  toISO6392,
  findISO6391ByName,
  getLanguageName,
  getDisplayName,
  getAllLanguages,
  getAllTranslationLanguages,
  getAllLanguagesISO1,
  buildLanguageLookupMaps,
  canonicalSyncLanguageCode,
  normalizeLanguageCode
};
