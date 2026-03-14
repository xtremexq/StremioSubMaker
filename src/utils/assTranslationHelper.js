/**
 * ASS/SSA Translation Helper
 *
 * Provides utilities to translate ASS/SSA subtitles while preserving
 * the original document structure (Script Info, Styles, Events).
 *
 * Strategy:
 *   1. parseASSForTranslation() - parse ASS, extract translatable text + preserved segments
 *   2. buildSRTFromASSDialogue() - build a temporary SRT for the translation engine
 *   3. reassembleASS() - re-inject translated text and timings into the original ASS structure
 */

const log = require('./logger');
const { parseSRT } = require('./subtitle');

/**
 * Convert ASS timecode (h:mm:ss.cc) to SRT timecode (HH:MM:SS,mmm)
 * @param {string} assTime - ASS format timecode, e.g. "0:01:23.45"
 * @returns {string} SRT format timecode, e.g. "00:01:23,450"
 */
function assTimeToSRT(assTime) {
  const m = String(assTime || '').trim().match(/(\d+):(\d{2}):(\d{2})\.(\d{2})/);
  if (!m) return '00:00:00,000';
  const h = parseInt(m[1], 10) || 0;
  const mi = parseInt(m[2], 10) || 0;
  const s = parseInt(m[3], 10) || 0;
  const cs = parseInt(m[4], 10) || 0;
  return (
    String(h).padStart(2, '0') + ':' +
    String(mi).padStart(2, '0') + ':' +
    String(s).padStart(2, '0') + ',' +
    String(cs * 10).padStart(3, '0')
  );
}

/**
 * Convert SRT timecode (HH:MM:SS,mmm) to ASS timecode (h:mm:ss.cc)
 * @param {string} srtTime - SRT format timecode, e.g. "00:01:23,450"
 * @returns {string} ASS format timecode, e.g. "0:01:23.45"
 */
function srtTimeToASS(srtTime) {
  const m = String(srtTime || '').trim().match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
  if (!m) return '0:00:00.00';

  const totalMs = (
    (((parseInt(m[1], 10) || 0) * 60 + (parseInt(m[2], 10) || 0)) * 60 + (parseInt(m[3], 10) || 0)) * 1000
  ) + (parseInt(m[4], 10) || 0);

  let totalCentiseconds = Math.round(totalMs / 10);
  const cs = totalCentiseconds % 100;
  totalCentiseconds = Math.floor(totalCentiseconds / 100);
  const s = totalCentiseconds % 60;
  totalCentiseconds = Math.floor(totalCentiseconds / 60);
  const mi = totalCentiseconds % 60;
  const h = Math.floor(totalCentiseconds / 60);

  return (
    String(h) + ':' +
    String(mi).padStart(2, '0') + ':' +
    String(s).padStart(2, '0') + '.' +
    String(cs).padStart(2, '0')
  );
}

/**
 * Parse an SRT timecode range into ASS start/end timestamps.
 * @param {string} srtTimecode - SRT range, e.g. "00:00:01,000 --> 00:00:03,500"
 * @returns {{ startTime: string, endTime: string }|null}
 */
function parseSrtTimecodeRange(srtTimecode) {
  const m = String(srtTimecode || '').trim().match(
    /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/
  );
  if (!m) return null;
  return {
    startTime: srtTimeToASS(m[1]),
    endTime: srtTimeToASS(m[2])
  };
}

/**
 * Track ASS drawing mode switches from override tags.
 * @param {number} currentMode - Current drawing mode (0 = text)
 * @param {string} tagBlock - ASS override block, e.g. "{\p1\an7}"
 * @returns {number}
 */
function updateDrawingMode(currentMode, tagBlock) {
  let nextMode = currentMode > 0 ? currentMode : 0;
  const drawingModePattern = /\\p(-?\d+)/gi;
  let match;

  while ((match = drawingModePattern.exec(String(tagBlock || ''))) !== null) {
    const value = parseInt(match[1], 10);
    if (Number.isFinite(value)) {
      nextMode = value > 0 ? value : 0;
    }
  }

  return nextMode;
}

/**
 * Replace a field value while preserving surrounding whitespace from the source.
 * @param {string} originalField - Original ASS field text
 * @param {string} newValue - Replacement value
 * @returns {string}
 */
function replaceFieldValuePreservingWhitespace(originalField, newValue) {
  const match = String(originalField || '').match(/^(\s*)(.*?)(\s*)$/);
  if (!match) return newValue;
  return `${match[1]}${newValue}${match[3]}`;
}

/**
 * Extract translatable text plus preserved raw ASS segments from dialogue text.
 * Preserved segments include override tags ({...}) and drawing payloads that
 * appear while \p drawing mode is active.
 *
 * @param {string} rawText - Raw ASS dialogue text field (with tags and \N)
 * @returns {{ cleanText: string, preservedSegments: Array<{position: number, raw: string}> }}
 */
function extractTags(rawText) {
  const preservedSegments = [];
  let clean = '';
  let inTag = false;
  let currentTag = '';
  let cleanPos = 0;
  let drawingMode = 0;
  let drawingBuffer = '';
  let drawingBufferPos = 0;

  const flushDrawingBuffer = () => {
    if (!drawingBuffer) return;
    preservedSegments.push({ position: drawingBufferPos, raw: drawingBuffer });
    drawingBuffer = '';
  };

  for (let i = 0; i < rawText.length; i++) {
    const ch = rawText[i];

    if (ch === '{' && !inTag) {
      flushDrawingBuffer();
      inTag = true;
      currentTag = '{';
      continue;
    }

    if (inTag) {
      currentTag += ch;
      if (ch === '}') {
        preservedSegments.push({ position: cleanPos, raw: currentTag });
        drawingMode = updateDrawingMode(drawingMode, currentTag);
        inTag = false;
        currentTag = '';
      }
      continue;
    }

    if (drawingMode > 0) {
      if (!drawingBuffer) drawingBufferPos = cleanPos;
      drawingBuffer += ch;
      continue;
    }

    if (ch === '\\' && i + 1 < rawText.length) {
      const next = rawText[i + 1];
      if (next === 'N' || next === 'n') {
        clean += '\n';
        cleanPos++;
        i++;
        continue;
      }
      if (next === 'h') {
        clean += ' ';
        cleanPos++;
        i++;
        continue;
      }
    }

    clean += ch;
    cleanPos++;
  }

  if (inTag && currentTag) {
    preservedSegments.push({ position: cleanPos, raw: currentTag });
  }
  flushDrawingBuffer();

  return { cleanText: clean, preservedSegments };
}

/**
 * Re-insert preserved ASS raw segments into translated text using proportional
 * position mapping.
 *
 * @param {string} translatedText - Translated clean text (may contain \n)
 * @param {Array<{position: number, raw: string}>} preservedSegments - Original raw ASS segments
 * @param {number} originalLength - Length of the original clean text (for proportion calc)
 * @returns {string} - Text with preserved ASS segments re-inserted and \n converted back to \N
 */
function reinsertTags(translatedText, preservedSegments, originalLength) {
  const normalizedTranslatedText = String(translatedText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  if (!preservedSegments || preservedSegments.length === 0) {
    return normalizedTranslatedText.replace(/\n/g, '\\N');
  }

  const translatedLen = normalizedTranslatedText.length;

  const mappedSegments = preservedSegments
    .filter(segment => segment && typeof segment.raw === 'string' && segment.raw.length > 0)
    .map((segment, index) => {
      let mappedPos;
      if (segment.position <= 0) {
        mappedPos = 0;
      } else if (originalLength > 0 && segment.position >= originalLength) {
        mappedPos = translatedLen;
      } else if (originalLength > 0) {
        mappedPos = Math.round((segment.position / originalLength) * translatedLen);
        mappedPos = Math.max(0, Math.min(mappedPos, translatedLen));
      } else {
        mappedPos = 0;
      }

      return {
        mappedPos,
        raw: segment.raw,
        order: index
      };
    });

  // Insert from right to left. Within the same mapped position, reverse the
  // original order so the final rendered order still matches the source line.
  mappedSegments.sort((a, b) => {
    if (a.mappedPos !== b.mappedPos) return b.mappedPos - a.mappedPos;
    return b.order - a.order;
  });

  let result = normalizedTranslatedText;
  for (const { mappedPos, raw } of mappedSegments) {
    const pos = Math.max(0, Math.min(mappedPos, result.length));
    result = result.slice(0, pos) + raw + result.slice(pos);
  }

  return result.replace(/\n/g, '\\N');
}

/**
 * Parse an ASS/SSA file for translation.
 * Extracts the document structure and dialogue entries with separated tags/text.
 *
 * @param {string} assContent - Raw ASS/SSA file content
 * @returns {{ header: string, formatLine: string, dialogueEntries: Array, footer: string, format: string }|null}
 */
function parseASSForTranslation(assContent) {
  if (!assContent || typeof assContent !== 'string') return null;

  const lines = assContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // Detect format (ASS vs SSA)
  const hasV4Plus = /\[v4\+\s*styles\]/i.test(assContent);
  const format = hasV4Plus ? 'ass' : 'ssa';

  // Find [Events] section
  let eventsStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\[events\]\s*$/i.test(lines[i].trim())) {
      eventsStart = i;
      break;
    }
  }

  if (eventsStart === -1) {
    log.warn(() => '[ASSTranslationHelper] No [Events] section found');
    return null;
  }

  // Everything before [Events] is the header (Script Info, Styles, etc.)
  const header = lines.slice(0, eventsStart + 1).join('\n');

  // Find Format line in Events section
  let formatLine = '';
  let formatFields = [];
  let formatLineIndex = -1;

  for (let i = eventsStart + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^\[.*\]/.test(trimmed)) break; // Hit next section
    if (/^format\s*:/i.test(trimmed)) {
      formatLine = lines[i];
      formatLineIndex = i;
      formatFields = trimmed.split(':').slice(1).join(':').split(',').map(s => s.trim().toLowerCase());
      break;
    }
  }

  if (formatFields.length === 0) {
    log.warn(() => '[ASSTranslationHelper] No Format line found in [Events]');
    return null;
  }

  // Determine field indices
  const idxStart = formatFields.indexOf('start');
  const idxEnd = formatFields.indexOf('end');
  const idxText = formatFields.indexOf('text');

  if (idxText === -1) {
    log.warn(() => '[ASSTranslationHelper] No Text field in Format line');
    return null;
  }

  // The text field is always the last field - commas inside text are not separators
  const numFieldsBeforeText = idxText;

  // Parse dialogue entries
  const dialogueEntries = [];
  const footerLines = [];
  let pastDialogue = false;

  for (let i = (formatLineIndex >= 0 ? formatLineIndex + 1 : eventsStart + 1); i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^\[.*\]/.test(trimmed)) {
      pastDialogue = true;
      footerLines.push(line);
      continue;
    }

    if (pastDialogue) {
      footerLines.push(line);
      continue;
    }

    if (!/^dialogue\s*:/i.test(trimmed)) {
      dialogueEntries.push({
        isDialogue: false,
        originalLine: line
      });
      continue;
    }

    const colonPos = line.indexOf(':');
    if (colonPos === -1) continue;
    const payload = line.substring(colonPos + 1);

    const parts = [];
    let current = '';
    let splitCount = 0;
    for (let j = 0; j < payload.length; j++) {
      const ch = payload[j];
      if (ch === ',' && splitCount < numFieldsBeforeText) {
        parts.push(current);
        current = '';
        splitCount++;
      } else {
        current += ch;
      }
    }
    parts.push(current);

    const startTime = (idxStart >= 0 && idxStart < parts.length) ? parts[idxStart].trim() : '';
    const endTime = (idxEnd >= 0 && idxEnd < parts.length) ? parts[idxEnd].trim() : '';
    const rawText = parts[parts.length - 1] || '';
    const prefix = 'Dialogue:' + parts.slice(0, numFieldsBeforeText).join(',') + ',';
    const { cleanText, preservedSegments } = extractTags(rawText);

    dialogueEntries.push({
      isDialogue: true,
      originalLine: line,
      prefix,
      partsBeforeText: parts.slice(0, numFieldsBeforeText),
      rawText,
      cleanText,
      preservedSegments,
      startTime,
      endTime,
      originalCleanLength: cleanText.length
    });
  }

  const actualDialogueCount = dialogueEntries.filter(e => e.isDialogue).length;
  if (actualDialogueCount === 0) {
    log.warn(() => '[ASSTranslationHelper] No Dialogue entries found');
    return null;
  }

  log.debug(() => `[ASSTranslationHelper] Parsed ${actualDialogueCount} dialogue entries (${format.toUpperCase()})`);

  return {
    header,
    formatLine,
    startFieldIndex: idxStart,
    endFieldIndex: idxEnd,
    dialogueEntries,
    footer: footerLines.join('\n'),
    format
  };
}

/**
 * Build a temporary SRT string from parsed ASS dialogue entries.
 * This SRT is fed to the translation engine (which is SRT-in/SRT-out).
 *
 * @param {Array} dialogueEntries - Parsed dialogue entries from parseASSForTranslation
 * @returns {string} - SRT formatted content
 */
function buildSRTFromASSDialogue(dialogueEntries) {
  const srtBlocks = [];
  let srtIndex = 1;

  for (const entry of dialogueEntries) {
    if (!entry.isDialogue) continue;

    // Skip entries with empty clean text (e.g. drawing commands only)
    const text = entry.cleanText.trim();
    if (!text) continue;

    const startSRT = assTimeToSRT(entry.startTime);
    const endSRT = assTimeToSRT(entry.endTime);

    srtBlocks.push(
      `${srtIndex}\n${startSRT} --> ${endSRT}\n${text}`
    );
    srtIndex++;
  }

  return srtBlocks.length > 0 ? `${srtBlocks.join('\n\n')}\n` : '';
}

/**
 * Reassemble a complete ASS/SSA file by injecting translated text
 * back into the original document structure.
 *
 * @param {Object} parsedASS - Result from parseASSForTranslation
 * @param {string} translatedSRTContent - Translated SRT output from the translation engine
 * @returns {string} - Complete ASS/SSA file with translated dialogue text
 */
function reassembleASS(parsedASS, translatedSRTContent) {
  if (!parsedASS) {
    log.warn(() => '[ASSTranslationHelper] reassembleASS: missing input');
    return translatedSRTContent || '';
  }

  if (translatedSRTContent === undefined || translatedSRTContent === null) {
    log.warn(() => '[ASSTranslationHelper] reassembleASS: missing translated SRT, returning original');
    return rebuildASSFromParsed(parsedASS, null);
  }

  const translatedEntries = parseSRT(translatedSRTContent);
  if (!translatedEntries || translatedEntries.length === 0) {
    log.warn(() => '[ASSTranslationHelper] reassembleASS: no entries in translated SRT, returning original');
    return rebuildASSFromParsed(parsedASS, null);
  }

  const translatedLookup = new Map();
  for (const entry of translatedEntries) {
    translatedLookup.set(entry.id, {
      text: entry.text,
      timecode: entry.timecode
    });
  }

  return rebuildASSFromParsed(parsedASS, translatedLookup);
}

/**
 * Rebuild the ASS file from parsed structure, optionally replacing dialogue text.
 *
 * @param {Object} parsedASS - Parsed ASS structure
 * @param {Map<number, {text: string, timecode: string}>|null} translatedLookup - Map of SRT index -> translated entry
 * @returns {string}
 */
function rebuildASSFromParsed(parsedASS, translatedLookup) {
  const outputLines = [];

  outputLines.push(parsedASS.header);

  if (parsedASS.formatLine) {
    outputLines.push(parsedASS.formatLine);
  }

  const startFieldIndex = Number.isInteger(parsedASS.startFieldIndex) ? parsedASS.startFieldIndex : -1;
  const endFieldIndex = Number.isInteger(parsedASS.endFieldIndex) ? parsedASS.endFieldIndex : -1;

  let srtIndex = 1;
  for (const entry of parsedASS.dialogueEntries) {
    if (!entry.isDialogue) {
      outputLines.push(entry.originalLine);
      continue;
    }

    const originalClean = entry.cleanText.trim();
    if (!originalClean) {
      outputLines.push(entry.originalLine);
      continue;
    }

    const translatedEntry = translatedLookup ? translatedLookup.get(srtIndex) : null;
    srtIndex++;

    if (translatedEntry !== undefined && translatedEntry !== null) {
      const translatedText = translatedEntry.text !== undefined && translatedEntry.text !== null
        ? String(translatedEntry.text)
        : '';

      const taggedText = reinsertTags(
        translatedText,
        entry.preservedSegments || entry.tags,
        entry.originalCleanLength
      );

      let linePrefix = entry.prefix;
      const translatedTiming = parseSrtTimecodeRange(translatedEntry.timecode);
      if (
        translatedTiming &&
        Array.isArray(entry.partsBeforeText) &&
        entry.partsBeforeText.length > 0
      ) {
        const rebuiltParts = entry.partsBeforeText.slice();
        if (startFieldIndex >= 0 && startFieldIndex < rebuiltParts.length) {
          rebuiltParts[startFieldIndex] = replaceFieldValuePreservingWhitespace(
            rebuiltParts[startFieldIndex],
            translatedTiming.startTime
          );
        }
        if (endFieldIndex >= 0 && endFieldIndex < rebuiltParts.length) {
          rebuiltParts[endFieldIndex] = replaceFieldValuePreservingWhitespace(
            rebuiltParts[endFieldIndex],
            translatedTiming.endTime
          );
        }
        linePrefix = 'Dialogue:' + rebuiltParts.join(',') + ',';
      }

      outputLines.push(linePrefix + taggedText);
    } else {
      outputLines.push(entry.originalLine);
    }
  }

  if (parsedASS.footer) {
    outputLines.push(parsedASS.footer);
  }

  return outputLines.join('\n');
}

module.exports = {
  parseASSForTranslation,
  buildSRTFromASSDialogue,
  reassembleASS,
  assTimeToSRT,
  srtTimeToASS,
  extractTags,
  reinsertTags,
  parseSrtTimecodeRange
};
