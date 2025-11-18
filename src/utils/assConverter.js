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

  // 3. Remove ASS drawing commands that shouldn't be in text
  // Drawing commands start with {\p1} or higher and end with {\p0}
  // Format: {\p1}m 0 0 l 100 0 100 100 0 100{\p0}
  processed = processed.replace(/\{\\p\d+\}[^{]*\{\\p0\}/g, '');

  // 4. Handle malformed tags - ensure tags are properly closed
  // Sometimes tags are not properly closed, causing text loss
  processed = fixMalformedTags(processed);

  // 5. Remove comment lines (lines starting with ;)
  processed = processed.split('\n')
    .filter(line => !line.trim().startsWith(';'))
    .join('\n');

  // 6. Fix actor/name tags that might interfere with parsing
  // Some ASS files have actor names that contain special characters
  processed = processed.split('\n').map(line => {
    if (/^Dialogue:/i.test(line)) {
      // Extract and clean the text portion
      const parts = line.split(',');
      if (parts.length >= 10) {
        // The text is usually in the last part(s) after 9 comma-separated fields
        const textStartIndex = 9;
        const beforeText = parts.slice(0, textStartIndex).join(',');
        const textParts = parts.slice(textStartIndex);
        const text = textParts.join(',');

        // Clean the text portion
        const cleanedText = cleanDialogueText(text);
        return beforeText + ',' + cleanedText;
      }
    }
    return line;
  }).join('\n');

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

  // 3. Clean up excessive blank lines (more than 2 consecutive)
  processed = processed.replace(/\n{3,}/g, '\n\n');

  // 4. Ensure file ends with a single newline
  processed = processed.trim() + '\n';

  // 5. Fix any remaining encoding issues
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
