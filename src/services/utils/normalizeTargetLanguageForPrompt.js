const { resolveLanguageCode, resolveLanguageDisplayName } = require('../../utils/languageResolver');

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeTargetLanguageForPrompt(targetLanguage) {
  const raw = String(targetLanguage || '').trim();
  if (!raw) return 'target language';

  const resolvedName = resolveLanguageDisplayName(raw) || raw;
  const resolvedCode = resolveLanguageCode(raw) || raw;

  const nameKey = normalizeKey(resolvedName);
  const codeKey = normalizeKey(resolvedCode).replace(/_/g, '-');

  // Portuguese (our config page uses ISO-639-2: por=PT default, pob=PT-BR)
  if (
    codeKey === 'pt-pt' ||
    codeKey === 'por' ||
    nameKey === 'portuguese (portugal)' ||
    nameKey === 'portuguese portugal'
  ) {
    return 'European Portuguese (Português de Portugal)';
  }
  if (
    codeKey === 'pt-br' ||
    codeKey === 'pob' ||
    nameKey === 'portuguese (brazil)' ||
    nameKey === 'portuguese (brazilian)' ||
    nameKey === 'portuguese brazil' ||
    nameKey === 'portuguese brazilian' ||
    nameKey === 'brazilian portuguese'
  ) {
    return 'Brazilian Portuguese (Português do Brasil)';
  }
  if (nameKey === 'portuguese' || codeKey === 'pt') {
    return 'European Portuguese (Português de Portugal)';
  }

  // Spanish regional variants (es-XX codes from allLanguages.js)
  if (codeKey === 'es-mx' || nameKey.includes('mexico')) {
    return 'Mexican Spanish (Español de México)';
  }
  if (codeKey === 'es-ar' || nameKey.includes('argentina')) {
    return 'Argentine Spanish (Español de Argentina)';
  }
  if (codeKey === 'es-co' || nameKey.includes('colombia')) {
    return 'Colombian Spanish (Español de Colombia)';
  }
  if (codeKey === 'es-cl' || nameKey.includes('chile')) {
    return 'Chilean Spanish (Español de Chile)';
  }
  if (codeKey === 'es-pe' || nameKey.includes('peru')) {
    return 'Peruvian Spanish (Español de Perú)';
  }
  if (codeKey === 'es-ve' || nameKey.includes('venezuela')) {
    return 'Venezuelan Spanish (Español de Venezuela)';
  }
  // Central American and Caribbean Spanish
  if (codeKey === 'es-cu' || nameKey.includes('cuba')) {
    return 'Cuban Spanish (Español de Cuba)';
  }
  if (codeKey === 'es-pr' || nameKey.includes('puerto rico')) {
    return 'Puerto Rican Spanish (Español de Puerto Rico)';
  }
  if (codeKey === 'es-do' || nameKey.includes('dominican')) {
    return 'Dominican Spanish (Español dominicano)';
  }
  // Other South American Spanish
  if (codeKey === 'es-ec' || nameKey.includes('ecuador')) {
    return 'Ecuadorian Spanish (Español de Ecuador)';
  }
  if (codeKey === 'es-bo' || nameKey.includes('bolivia')) {
    return 'Bolivian Spanish (Español de Bolivia)';
  }
  if (codeKey === 'es-uy' || nameKey.includes('uruguay')) {
    return 'Uruguayan Spanish (Español de Uruguay)';
  }
  if (codeKey === 'es-py' || nameKey.includes('paraguay')) {
    return 'Paraguayan Spanish (Español de Paraguay)';
  }
  // Central American Spanish
  if (codeKey === 'es-gt' || nameKey.includes('guatemala')) {
    return 'Guatemalan Spanish (Español de Guatemala)';
  }
  if (codeKey === 'es-hn' || nameKey.includes('honduras')) {
    return 'Honduran Spanish (Español de Honduras)';
  }
  if (codeKey === 'es-sv' || nameKey.includes('el salvador')) {
    return 'Salvadoran Spanish (Español salvadoreño)';
  }
  if (codeKey === 'es-ni' || nameKey.includes('nicaragua')) {
    return 'Nicaraguan Spanish (Español de Nicaragua)';
  }
  if (codeKey === 'es-cr' || nameKey.includes('costa rica')) {
    return 'Costa Rican Spanish (Español de Costa Rica)';
  }
  if (codeKey === 'es-pa' || nameKey.includes('panama')) {
    return 'Panamanian Spanish (Español de Panamá)';
  }
  if (
    codeKey === 'es-419' ||
    codeKey === 'spn' ||
    nameKey.includes('latin america') ||
    nameKey.includes('latam')
  ) {
    return 'Latin American Spanish (Español de Latinoamérica)';
  }
  if (codeKey === 'es-es' || nameKey.includes('spain')) {
    return 'Castilian Spanish (Español de España)';
  }
  if (nameKey === 'spanish' || codeKey === 'es' || codeKey === 'spa') {
    return 'Castilian Spanish (Español de España)';
  }

  // English regional variants
  if (codeKey === 'en-gb' || (nameKey.includes('english') && (nameKey.includes('uk') || nameKey.includes('united kingdom') || nameKey.includes('british')))) {
    return 'British English';
  }
  if (codeKey === 'en-us' || (nameKey.includes('english') && nameKey.includes('american'))) {
    return 'American English';
  }
  if (codeKey === 'en-au' || (nameKey.includes('english') && nameKey.includes('australia'))) {
    return 'Australian English';
  }
  if (codeKey === 'en-ca' || (nameKey.includes('english') && nameKey.includes('canad'))) {
    return 'Canadian English';
  }
  if (codeKey === 'en-in' || (nameKey.includes('english') && nameKey.includes('india'))) {
    return 'Indian English';
  }
  if (codeKey === 'en-ie' || (nameKey.includes('english') && nameKey.includes('ireland'))) {
    return 'Irish English';
  }
  if (codeKey === 'en-nz' || (nameKey.includes('english') && nameKey.includes('zealand'))) {
    return 'New Zealand English';
  }
  if (codeKey === 'en-za' || (nameKey.includes('english') && nameKey.includes('south africa'))) {
    return 'South African English';
  }
  if (codeKey === 'en-sg' || (nameKey.includes('english') && nameKey.includes('singapore'))) {
    return 'Singaporean English';
  }
  if (codeKey === 'en-ph' || (nameKey.includes('english') && nameKey.includes('philippines'))) {
    return 'Philippine English';
  }
  // Default English (don't specify variant)
  if (nameKey === 'english' || codeKey === 'en' || codeKey === 'eng') {
    return 'English';
  }

  // French regional variants
  if (codeKey === 'fr-ca' || (nameKey.includes('french') && nameKey.includes('canad'))) {
    return 'Canadian French (Français canadien)';
  }
  if (codeKey === 'fr-be' || (nameKey.includes('french') && nameKey.includes('belg'))) {
    return 'Belgian French (Français de Belgique)';
  }
  if (codeKey === 'fr-ch' || (nameKey.includes('french') && nameKey.includes('swiss'))) {
    return 'Swiss French (Français de Suisse)';
  }
  if (codeKey === 'fr-fr' || nameKey === 'french' || codeKey === 'fr' || codeKey === 'fra' || codeKey === 'fre') {
    return 'French (Français)';
  }

  // German regional variants
  if (codeKey === 'de-at' || (nameKey.includes('german') && nameKey.includes('austria'))) {
    return 'Austrian German (Österreichisches Deutsch)';
  }
  if (codeKey === 'de-ch' || (nameKey.includes('german') && nameKey.includes('swiss'))) {
    return 'Swiss German (Schweizerdeutsch)';
  }
  if (codeKey === 'de-de' || nameKey === 'german' || codeKey === 'de' || codeKey === 'deu' || codeKey === 'ger') {
    return 'German (Deutsch)';
  }

  // Arabic regional variants
  if (codeKey === 'ar-eg' || nameKey.includes('egypt')) {
    return 'Egyptian Arabic (العربية المصرية)';
  }
  if (codeKey === 'ar-sa' || nameKey.includes('saudi')) {
    return 'Saudi Arabic (العربية السعودية)';
  }
  if (codeKey === 'ar-ma' || nameKey.includes('morocco')) {
    return 'Moroccan Arabic (الدارجة المغربية)';
  }
  if (codeKey === 'ar-lb' || nameKey.includes('leban')) {
    return 'Lebanese Arabic (اللهجة اللبنانية)';
  }
  if (codeKey === 'ar-dz' || nameKey.includes('algeria')) {
    return 'Algerian Arabic (الدارجة الجزائرية)';
  }
  if (codeKey === 'ar-tn' || nameKey.includes('tunisia')) {
    return 'Tunisian Arabic (الدارجة التونسية)';
  }
  if (codeKey === 'ar-ly' || nameKey.includes('libya')) {
    return 'Libyan Arabic (اللهجة الليبية)';
  }
  if (codeKey === 'ar-iq' || nameKey.includes('iraq')) {
    return 'Iraqi Arabic (اللهجة العراقية)';
  }
  if (codeKey === 'ar-sy' || nameKey.includes('syria')) {
    return 'Syrian Arabic (اللهجة السورية)';
  }
  if (codeKey === 'ar-jo' || nameKey.includes('jordan')) {
    return 'Jordanian Arabic (اللهجة الأردنية)';
  }
  if (codeKey === 'ar-ae' || nameKey.includes('uae') || nameKey.includes('emirates')) {
    return 'Gulf Arabic (اللهجة الخليجية)';
  }
  if (codeKey === 'ar-kw' || nameKey.includes('kuwait')) {
    return 'Kuwaiti Arabic (اللهجة الكويتية)';
  }
  if (codeKey === 'ar-qa' || nameKey.includes('qatar')) {
    return 'Gulf Arabic (اللهجة الخليجية)';
  }
  if (codeKey === 'ar-bh' || nameKey.includes('bahrain')) {
    return 'Gulf Arabic (اللهجة الخليجية)';
  }
  if (codeKey === 'ar-om' || nameKey.includes('oman')) {
    return 'Gulf Arabic (اللهجة الخليجية)';
  }
  if (codeKey === 'ar-ye' || nameKey.includes('yemen')) {
    return 'Yemeni Arabic (اللهجة اليمنية)';
  }
  if (nameKey === 'arabic' || codeKey === 'ar' || codeKey === 'ara') {
    return 'Modern Standard Arabic (العربية الفصحى)';
  }

  // Chinese (chi=ZH default; zhs/zht are our simplified/traditional variants)
  if (codeKey === 'zh-hant' || codeKey === 'zht' || codeKey === 'zh-tw' || codeKey === 'zh-hk' || nameKey.includes('traditional')) {
    return 'Traditional Chinese (繁體中文)';
  }
  if (codeKey === 'zh-hans' || codeKey === 'zhs' || codeKey === 'zh-cn' || codeKey === 'chi' || nameKey.includes('simplified')) {
    return 'Simplified Chinese (简体中文)';
  }
  if (codeKey === 'zh-sg' || (nameKey.includes('chinese') && nameKey.includes('singapore'))) {
    return 'Simplified Chinese (简体中文)'; // Singapore uses simplified
  }
  if (nameKey === 'chinese' || codeKey === 'zh') {
    return 'Simplified Chinese (简体中文)';
  }

  // Serbian script variants
  if (codeKey === 'sr-cyrl' || (nameKey.includes('serbian') && nameKey.includes('cyrillic'))) {
    return 'Serbian (Cyrillic script - Ћирилица)';
  }
  if (codeKey === 'sr-latn' || (nameKey.includes('serbian') && nameKey.includes('latin'))) {
    return 'Serbian (Latin script - Latinica)';
  }

  // Bosnian script variants
  if (codeKey === 'bs-cyrl' || (nameKey.includes('bosnian') && nameKey.includes('cyrillic'))) {
    return 'Bosnian (Cyrillic script)';
  }

  // Korean variants (both are the same language, just political distinction)
  if (codeKey === 'ko-kr' || (nameKey.includes('korean') && nameKey.includes('south'))) {
    return 'Korean (한국어)';
  }
  if (codeKey === 'ko-kp' || (nameKey.includes('korean') && nameKey.includes('north'))) {
    return 'Korean (조선어)';
  }

  // Dutch variants
  if (codeKey === 'nl-be' || (nameKey.includes('dutch') && nameKey.includes('belgium'))) {
    return 'Flemish Dutch (Vlaams)';
  }
  if (codeKey === 'nl-nl' || nameKey === 'dutch' || codeKey === 'nl' || codeKey === 'nld' || codeKey === 'dut') {
    return 'Dutch (Nederlands)';
  }

  // Italian variants
  if (codeKey === 'it-ch' || (nameKey.includes('italian') && nameKey.includes('switzerland'))) {
    return 'Swiss Italian (Italiano svizzero)';
  }
  if (codeKey === 'it-it' || nameKey === 'italian' || codeKey === 'it' || codeKey === 'ita') {
    return 'Italian (Italiano)';
  }

  // Swedish variants
  if (codeKey === 'sv-fi' || (nameKey.includes('swedish') && nameKey.includes('finland'))) {
    return 'Finland Swedish (Finlandssvenska)';
  }
  if (codeKey === 'sv-se' || nameKey === 'swedish' || codeKey === 'sv' || codeKey === 'swe') {
    return 'Swedish (Svenska)';
  }

  // Script variants for other languages
  if (codeKey === 'ms-arab' || (nameKey.includes('malay') && nameKey.includes('jawi'))) {
    return 'Malay (Jawi script)';
  }
  if (codeKey === 'pa-arab' || (nameKey.includes('punjabi') && nameKey.includes('shahmukhi'))) {
    return 'Punjabi (Shahmukhi script)';
  }

  return resolvedName;
}

module.exports = { normalizeTargetLanguageForPrompt };
