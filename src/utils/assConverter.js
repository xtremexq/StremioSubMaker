/**
 * Enhanced ASS/SSA to VTT conversion utility
 * Addresses common issues with text loss and formatting problems
 */

const log = require('./logger');

/**
 * Preprocess ASS/SSA content to improve conversion quality
 * Handles common issues that cause text loss or corruption
 * @param {string} content - Raw ASS/SSA content
 * @param {string} format - Format type ('ass' or 'ssa')
 * @returns {string} - Preprocessed content
 */
function preprocessASS(content, format = 'ass') {
  if (!content || typeof content !== 'string') {
    return content;
  }

  let processed = content;

  // 1. Remove BOM (Byte Order Mark) if present
  processed = processed.replace(/^\uFEFF/, '');

  // 2. Normalize line endings to \n
  processed = processed.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 3. Fix subsrt-ts bug: library consumes first char of text field in Dialogue lines
  // Solution: Add leading space before text field (after 9th comma in ASS format)
  // ASS Dialogue format: Dialogue: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
  // We find lines starting with "Dialogue:" and insert a space after the 9th comma
  processed = processed.split('\n').map(line => {
    const trimmed = line.trim();
    if (/^Dialogue\s*:/i.test(trimmed)) {
      // Count commas and find the 9th one (after Effect field, before Text)
      let commaCount = 0;
      let insertPos = -1;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === ',') {
          commaCount++;
          if (commaCount === 9) {
            insertPos = i + 1;
            break;
          }
        }
      }
      if (insertPos > 0 && insertPos < line.length) {
        // Check if there's already a space after the comma
        if (line[insertPos] !== ' ') {
          // Insert a space to protect the first character of text
          line = line.slice(0, insertPos) + ' ' + line.slice(insertPos);
        }
      }
    }
    return line;
  }).join('\n');

  // 4. Remove ASS drawing commands that shouldn't be in text
  // Drawing commands start with {\p1} or higher and end with {\p0}
  // Format: {\p1}m 0 0 l 100 0 100 100 0 100{\p0}
  processed = processed.replace(/\{\\p\d+\}[^{]*\{\\p0\}/g, '');

  // 5. Handle malformed tags - ensure tags are properly closed
  // Sometimes tags are not properly closed, causing text loss
  processed = fixMalformedTags(processed);

  // 6. Remove comment lines (lines starting with ;)
  processed = processed.split('\n')
    .filter(line => !line.trim().startsWith(';'))
    .join('\n');

  // Note: We do NOT clean dialogue text here because it interferes with subsrt-ts parsing
  // and can cause the first character of subtitle entries to be lost.
  // Instead, we clean up ASS tags in the VTT output during post-processing.

  return processed;
}

/**
 * Fix malformed ASS/SSA override tags
 * @param {string} content - Content with potentially malformed tags
 * @returns {string} - Content with fixed tags
 */
function fixMalformedTags(content) {
  let fixed = content;

  // Ensure all { have matching }
  // Count braces and add missing closing braces
  const lines = fixed.split('\n');
  const fixedLines = lines.map(line => {
    let openCount = (line.match(/\{/g) || []).length;
    let closeCount = (line.match(/\}/g) || []).length;

    if (openCount > closeCount) {
      // Add missing closing braces at the end of dialogue text
      const diff = openCount - closeCount;
      line += '}'.repeat(diff);
    } else if (closeCount > openCount) {
      // Remove extra closing braces
      let extraCloses = closeCount - openCount;
      line = line.replace(/\}/g, (match) => {
        if (extraCloses > 0) {
          extraCloses--;
          return '';
        }
        return match;
      });
    }

    return line;
  });

  return fixedLines.join('\n');
}

/**
 * Clean dialogue text by handling complex ASS override tags
 * @param {string} text - Dialogue text with ASS tags
 * @returns {string} - Cleaned text
 */
function cleanDialogueText(text) {
  if (!text) return text;

  let cleaned = text;

  // Handle escaped characters first
  // \h - non-breaking space
  cleaned = cleaned.replace(/\\h/g, ' ');

  // Keep \N and \n for now (line breaks) - they'll be handled by subsrt-ts
  // But normalize them
  cleaned = cleaned.replace(/\\N/g, '\n');
  cleaned = cleaned.replace(/\\n/g, '\n');

  // Remove ASS drawing commands more aggressively
  // Format: {\p1}...{\p0} or {\p2}...{\p0}, etc.
  cleaned = cleaned.replace(/\{\\p[1-9]\}.*?\{\\p0\}/g, '');

  // Handle nested or complex override tags
  // Instead of removing all {}, we need to be more careful
  // Valid ASS tags start with backslash: {\tag}
  // But we need to preserve text that might be in braces

  // Remove proper ASS override tags: {\...}
  // This regex matches { followed by backslash(es) and tag content, then }
  cleaned = cleaned.replace(/\{[\\][^}]*\}/g, '');

  // After removing proper tags, if there are still {} left, they might contain text
  // However, in proper ASS format, text should not be in {}
  // For safety, we'll log a warning but still remove them
  if (/\{[^\\][^}]*\}/.test(cleaned)) {
    // This might be malformed ASS or text in braces
    // Remove them but log for debugging
    const matches = cleaned.match(/\{[^\\][^}]*\}/g);
    if (matches) {
      log.debug(() => `[ASS Converter] Found potential text in braces: ${matches.join(', ')}`);
    }
    cleaned = cleaned.replace(/\{[^}]*\}/g, '');
  }

  // Remove any remaining control characters except newlines
  cleaned = cleaned.replace(/[\x00-\x09\x0B-\x0C\x0E-\x1F\x7F]/g, '');

  return cleaned;
}

/**
 * Post-process VTT output to fix common issues
 * @param {string} vttContent - Converted VTT content
 * @returns {string} - Fixed VTT content
 */
function postprocessVTT(vttContent) {
  if (!vttContent || typeof vttContent !== 'string') {
    return vttContent;
  }

  let processed = vttContent;

  // Defensive cleanup before deeper processing:
  // - Remove stray lines that are exactly 'undefined' (should never appear in valid VTT)
  // - Normalize the first non-empty line to the proper 'WEBVTT' header
  try {
    const prim = processed.split('\n');
    const filtered = prim.filter(l => l.trim().toLowerCase() !== 'undefined');
    const firstIdx = filtered.findIndex(l => l.trim().length > 0);
    if (firstIdx >= 0) {
      filtered[firstIdx] = 'WEBVTT';
    }
    processed = filtered.join('\n');
  } catch (_) { }

  // Defensive cleanup before deeper processing:
  // - Remove stray lines that are exactly 'undefined' (should never appear in valid VTT)
  // - Normalize the first non-empty line to the proper 'WEBVTT' header
  try {
    const prim = processed.split('\n');
    const filtered = prim.filter(l => l.trim().toLowerCase() !== 'undefined');
    const firstIdx = filtered.findIndex(l => l.trim().length > 0);
    if (firstIdx >= 0) {
      filtered[firstIdx] = 'WEBVTT';
    }
    processed = filtered.join('\n');
  } catch (_) { }

  // 1. Ensure WEBVTT header is present and properly formatted
  if (!processed.startsWith('WEBVTT')) {
    processed = 'WEBVTT\n\n' + processed;
  }

  // 2. Remove empty cues (cues with no text)
  const lines = processed.split('\n');
  const cleanedLines = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Check if this is a timestamp line
    if (/^\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/.test(line)) {
      // Look ahead to see if there's text for this cue
      let hasText = false;
      let j = i + 1;

      while (j < lines.length && lines[j].trim() !== '') {
        if (lines[j].trim().length > 0 &&
          !/^\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/.test(lines[j])) {
          hasText = true;
          break;
        }
        j++;
      }

      if (hasText) {
        // Include the timestamp and following text
        cleanedLines.push(line);
        i++;
        while (i < lines.length && lines[i].trim() !== '' &&
          !/^\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/.test(lines[i])) {
          cleanedLines.push(lines[i]);
          i++;
        }
        if (i < lines.length && lines[i].trim() === '') {
          cleanedLines.push('');
        }
      } else {
        // Skip empty cue
        i++;
      }
    } else {
      cleanedLines.push(line);
      i++;
    }
  }

  processed = cleanedLines.join('\n');

  // 3. Remove any remaining ASS/SSA override tags from the subtitle text
  // These tags might have been left by subsrt-ts conversion
  // Pattern: {\tag} where tag starts with backslash
  processed = processed.split('\n').map(line => {
    // Only clean subtitle text lines (not timestamps or headers)
    if (line.trim() &&
      !line.startsWith('WEBVTT') &&
      !/^\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/.test(line) &&
      !/^NOTE\s/.test(line) &&
      !/^\d+$/.test(line.trim())) {

      let cleaned = line;

      // Remove ASS override tags: {\...}
      // These always have a backslash after the opening brace
      cleaned = cleaned.replace(/\{\\([^}]*)\}/g, '');

      // Remove braces around text content (subsrt-ts bug)
      // Pattern: {text} where text doesn't start with backslash
      // These are NOT ASS tags (tags have backslash: {\tag}), so preserve the content
      // Example: {Ta}dah! -> Tadah!, {Bor}derlines -> Borderlines
      cleaned = cleaned.replace(/\{([^\\}]+)\}/g, '$1');

      // Handle escaped characters first (before orphaned tag removal)
      cleaned = cleaned.replace(/\\h/g, ' '); // non-breaking space
      cleaned = cleaned.replace(/\\N/g, '\n'); // line break

      // Remove orphaned ASS tags (missing opening brace, e.g., "\an8}" or "\i1}" or "\an8\fscx92}")
      // These are malformed tags left by subsrt-ts conversion
      // For single letters after \, preserve the letter (it's text, not a tag: \T}adah! -> Tadah!)
      // For actual tags, remove entirely (\i1}text -> text, \an8}text -> text)
      cleaned = cleaned.replace(/\\{1,2}([a-z])\}/gi, '$1'); // Single letter after orphaned tag: keep it

      // Handle multi-letter patterns that might be corrupted text (e.g., \Ta}dah! -> Tadah!)
      // Check if the letters form a known ASS tag; if not, preserve them (likely text)
      cleaned = cleaned.replace(/\\([a-z]{2,})\}/gi, (match, letters) => {
        // Whitelist of known ASS tags that might appear without digits
        const knownTags = ['fn', 'fe', 'an', 'fs', 'fscx', 'fscy', 'fsp', 'frx', 'fry', 'frz',
          'clip', 'iclip', 'pos', 'move', 'org', 'fad', 'fade',
          'blur', 'bord', 'xbord', 'ybord', 'shad', 'xshad', 'yshad',
          'alpha', 'pbo', 'q', 'be', 'kf', 'ko', 'k', 'kt'];

        // Check if letters match or start with a known tag
        const lowerLetters = letters.toLowerCase();
        const isKnownTag = knownTags.some(tag => lowerLetters === tag || lowerLetters.startsWith(tag));

        if (isKnownTag) {
          // It's a known ASS tag, remove it entirely
          return '';
        } else {
          // It's not a known tag, likely corrupted text - preserve the letters
          return letters;
        }
      });

      // ===== CRITICAL FIX FOR FIRST LETTER LOSS =====
      // subsrt-ts produces malformed tags where the first letter of text gets captured inside the tag
      // Example: \an8T}adah! where T is the first letter of "Tadah!"
      // We must handle this BEFORE other tag removal to preserve the text letter

      // Fix 1: Handle malformed tags with first letter inside
      // Pattern: \[letters][digits][LETTER]} → preserve only the letter
      // Examples: \an8T}adah! -> Tadah!, \i1I}t's -> It's, \b1Y}ou -> You
      cleaned = cleaned.replace(/\\[a-z]*\d+([a-zA-Z])\}/gi, '$1');

      // Fix 2: Remove normal orphaned ASS tags with digits (without captured letters)
      // Pattern: \[letters][digits]} → remove entire tag
      // Examples: \an8} -> (removed), \i1} -> (removed), \fs20} -> (removed)
      // Note: Won't match \an8T} because Fix 1 already handled it
      cleaned = cleaned.replace(/\\[a-z]*\d+\}/gi, '');

      // Fix 3: Remove leftover tag prefixes from complex tags
      // After removing \fscx92} from \an8\fscx92}text, we're left with \an8text
      // This removes the orphaned \an8 at the start of lines
      cleaned = cleaned.replace(/^\\[a-z]+\d+/gim, '');

      // Fix 4: Remove color/alpha tags with digit-first format
      // Pattern: \[digit][letter][optional hex]} → remove
      // Examples: \1c} -> (removed), \2a&HFFFFFF&} -> (removed)
      cleaned = cleaned.replace(/\\\d+[ac][^}]*\}/gi, '');

      // Remove nested tags (e.g., \tag\subtag)
      cleaned = cleaned.replace(/\\[a-z]+\\[a-z0-9\\]*\}/gi, '');

      return cleaned;
    }
    return line;
  }).join('\n');

  // 4. Clean up excessive blank lines (more than 2 consecutive)
  processed = processed.replace(/\n{3,}/g, '\n\n');

  // 5. Ensure file ends with a single newline
  processed = processed.trim() + '\n';

  // 6. Fix any remaining encoding issues
  processed = processed.replace(/\uFFFD/g, ''); // Remove replacement characters

  return processed;
}

/**
 * Validate VTT content to ensure it has actual subtitle content
 * @param {string} vttContent - VTT content to validate
 * @returns {boolean} - True if valid
 */
function validateVTT(vttContent) {
  if (!vttContent || typeof vttContent !== 'string') {
    return false;
  }

  // Check for WEBVTT header
  if (!vttContent.trim().startsWith('WEBVTT')) {
    return false;
  }

  // Check for at least one timing cue
  const hasTimingCues = /\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/.test(vttContent);

  if (!hasTimingCues) {
    return false;
  }

  // Check that there's actual text content (not just empty cues)
  const lines = vttContent.split('\n');
  let hasTextContent = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // If line has text and is not a header, timestamp, or empty
    if (line.length > 0 &&
      !line.startsWith('WEBVTT') &&
      !/^\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/.test(line) &&
      !/^NOTE\s/.test(line)) {
      hasTextContent = true;
      break;
    }
  }

  return hasTextContent;
}

/**
 * Convert ASS/SSA to VTT with enhanced error handling
 * @param {string} content - Raw ASS/SSA content
 * @param {string} format - Format type ('ass' or 'ssa')
 * @returns {Object} - { success: boolean, content: string, error: string }
 */
function convertASSToVTT(content, format = 'ass') {
  try {
    // Step 1: Preprocess
    const preprocessed = preprocessASS(content, format);

    // Step 2: Convert using subsrt-ts
    const subsrt = require('subsrt-ts');
    let converted = null;

    try {
      converted = subsrt.convert(preprocessed, { to: 'vtt', from: format });
    } catch (convErr) {
      // If conversion fails, try with sanitized content (remove null bytes and other issues)
      log.debug(() => `[ASS Converter] First conversion attempt failed: ${convErr.message}, trying with sanitized content`);
      const sanitized = preprocessed
        .replace(/\u0000/g, '')
        .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');

      converted = subsrt.convert(sanitized, { to: 'vtt', from: format });
    }

    // Step 3: Post-process
    if (converted && typeof converted === 'string' && converted.trim().length > 0) {
      const postprocessed = postprocessVTT(converted);

      // Step 4: Validate
      if (validateVTT(postprocessed)) {
        return {
          success: true,
          content: postprocessed,
          error: null
        };
      } else {
        return {
          success: false,
          content: null,
          error: 'Converted VTT failed validation (no text content)'
        };
      }
    } else {
      return {
        success: false,
        content: null,
        error: 'Conversion resulted in empty output'
      };
    }
  } catch (error) {
    return {
      success: false,
      content: null,
      error: error.message || 'Unknown conversion error'
    };
  }
}

module.exports = {
  preprocessASS,
  postprocessVTT,
  validateVTT,
  convertASSToVTT,
  cleanDialogueText,
  fixMalformedTags
};
