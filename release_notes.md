**Improvements:**

- **Massively expanded language support:** Added 100+ new languages to allLanguages.js including Acehnese, Balinese, Cantonese (yue), Cherokee, Crimean Tatar, Dhivehi, Dzongkha, Faroese, Fijian, Hakka, Ilocano, Konkani, Lao, Limburgish, Lombard, Mongolian dialects, Navajo, Occitan, Ossetian, Quechua, Sanskrit, Shan, Sicilian, Tibetan, Tigrinya, Tok Pisin, Wolof, and many more. Extended section adds ancient languages (Akkadian, Ancient Egyptian, Ancient Greek, Classical Chinese, Gothic, Hittite, Latin variants, Old English, Old Norse, Sumerian), constructed languages (Esperanto, Lojban, Quenya, Sindarin), and additional regional languages.

- **Extended languages list toggle:** Added "Extended languages list" checkbox to the Target Languages and Learn Languages sections on the config page. When enabled, displays ~100 additional rare, ancient, regional, and constructed languages (AI translation only). The toggle state persists in localStorage and syncs between both language sections. Extended languages are marked with `extended: true` in allLanguages.js and filtered out by default.

- **Language name consistency across codebase:** Unified language names between languages.js (ISO-639-2 mappings for Stremio) and allLanguages.js (translation tools). Examples: "Abkhazian" → "Abkhaz", "Kirghiz" → "Kyrgyz", "Panjabi" → "Punjabi", "Pushto" → "Pashto", "Uighur" → "Uyghur", "Central Khmer" → "Khmer", "Chichewa" → "Nyanja (Chichewa)", "Gaelic" → "Scottish Gaelic", "Southern Sotho" → "Sesotho".

- **Separate language functions for different use cases:** Added `getAllTranslationLanguages()` function in languages.js that merges `languageMap` with `allLanguages.js` entries. The original `getAllLanguages()` now returns only `languageMap` entries (provider-compatible). This separation ensures source language selection shows what Stremio supports while target language selection shows what AI can translate to.

- **Added Filipino as custom language mapping:** Added `'fil': { code1: 'fil', name: 'Filipino', isCustom: true }` to languageMap in languages.js to ensure Filipino is available as a distinct option alongside Tagalog. Also added `fil` → `tl` normalization in config.js `normalizeLanguageCodes()` function. Filipino and Tagalog are the same language; both now resolve to the `tl` code. Added deduplication step to prevent duplicate entries after normalization (e.g., if user had both `fil` and `tl` selected).

- **DeepL beta languages expanded:** Added 30+ new beta language codes to deepl.js: AB (Abkhaz), AK (Akan), BM (Bambara), CV (Chuvash), DV (Dhivehi), DZ (Dzongkha), EE (Ewe), FF (Fulani), FIL (Filipino), FJ (Fijian), FO (Faroese), LG (Luganda), LI (Limburgish), NR (South Ndebele), NSO (Northern Sotho), OS (Ossetian), RN (Kirundi), RW (Kinyarwanda), SG (Sango), SI (Sinhala), SM (Samoan), SN (Shona), SS (Swati), TI (Tigrinya), VE (Venda), YO (Yoruba), and others.

**Bug Fixes:**

- **Fixed 524 timeout for large file translations (keepalive streaming):** Even with the correct workflow, translating large subtitle files (400+ entries) takes 2-5+ minutes, exceeding Cloudflare's 100-second origin response timeout. The `/api/translate-file` endpoint now streams periodic keepalive newline bytes (`\n`) every 30 seconds during translation (configurable via `FILE_UPLOAD_KEEPALIVE_INTERVAL`). Each byte resets Cloudflare's timer. `res.flush()` is called after each write to push data through Express's compression middleware. On success, the SRT content is appended after the keepalive newlines (SRT parsers ignore leading blank lines). On error after HTTP 200 is committed, a `[TRANSLATION_ERROR]` marker is written so the client can detect the failure. The client trims leading keepalive newlines from the response and checks for the error marker before processing.

- **Fixed source/no-translation language grids showing 400+ languages with unusable regional variants:** The expanded `allLanguages.js` (for AI translation) was being merged into `getAllLanguages()`, causing source and no-translation language grids to show 11 English variants (en-AU, en-GB, etc.), 22 Spanish variants, 17 Arabic variants, etc. These regional codes don't work with Stremio or subtitle providers (OpenSubtitles, SubDL, etc.) which only recognize ISO-639-2 codes. Split language endpoints:
  - `GET /api/languages` now returns only the 197 provider-compatible languages (ISO-639-2 codes from `languageMap`)
  - `GET /api/languages/translation` returns the full 434 translation-capable languages including regional variants and extended languages
  - Config page fetches both endpoints in parallel: source/no-translation grids use provider languages; target/learn grids use translation languages
  - Quick Setup, SMDB, and Sync pages continue using `/api/languages` (provider-compatible codes only)
  - File Upload and Toolbox pages import `allLanguages.js` directly for translation target selection

- **Fixed regional language variants breaking subtitle fetching in Stremio:** If users selected regional variants like `es-MX` (Spanish Mexico), `en-GB` (English UK), or `zh-CN` (Chinese Simplified) as target languages, subtitle fetching would fail because the `normalizeLanguageCode()` function converted `es-MX` to `esmx` instead of the provider-compatible `spa`. Updated the normalization to detect regional variant format (e.g., `xx-YY`) and extract the base language code, then convert to ISO-639-2. Now `es-MX` → `spa`, `en-GB` → `eng`, `pt-BR` → `pob`, `zh-CN` → `chi`, etc. Also handles script variants (e.g., `mni-Mtei` → `mni`, `sr-Cyrl` → `srp`).

- **Fixed Frisian language code mapping:** Added `fry` (Western Frisian) to languageMap with ISO-639-1 code `fy`. The 2-letter code `fy` now correctly maps to the provider-compatible `fry`.

- **Fixed regional variants losing their specificity in AI translation prompts:** Translation button URLs now preserve the original regional variant code (e.g., `es-MX`) instead of normalizing it to the base language (`spa`). This ensures the AI receives the specific regional variant and can produce translations appropriate for that region. Expanded `normalizeTargetLanguageForPrompt.js` with 71/72 regional variant mappings:
  - Spanish (19 variants): Mexican, Argentine, Colombian, Chilean, Peruvian, Venezuelan, Cuban, Puerto Rican, Dominican, Ecuadorian, Bolivian, Uruguayan, Paraguayan, Guatemalan, Honduran, Salvadoran, Nicaraguan, Costa Rican, Panamanian
  - English (10 variants): British, American, Australian, Canadian, Indian, Irish, New Zealand, South African, Singaporean, Philippine
  - Arabic (16 variants): Egyptian, Saudi, Moroccan, Lebanese, Algerian, Tunisian, Libyan, Iraqi, Syrian, Jordanian, Gulf (UAE/Qatar/Bahrain/Oman), Kuwaiti, Yemeni
  - French (4 variants): Canadian, Belgian, Swiss, Standard
  - German (3 variants): Austrian, Swiss, Standard
  - Chinese (4 variants): Simplified, Traditional, Hong Kong, Singapore
  - Other: Dutch (Flemish), Italian (Swiss), Swedish (Finland), Korean (South/North), Serbian (Cyrillic/Latin), Bosnian (Cyrillic), Malay (Jawi), Punjabi (Shahmukhi)
