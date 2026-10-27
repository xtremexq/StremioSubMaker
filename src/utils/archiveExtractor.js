/**
 * Archive Extractor Utility
 * Handles extraction of subtitle files from ZIP, RAR, Gzip, 7z, Tar, Bzip2, XZ, and Brotli archives
 */

const log = require('./logger');
const { detectAndConvertEncoding } = require('./encodingDetector');
const { appendHiddenInformationalNote } = require('./subtitle');
const { DEFAULT_ARCHIVE_LIMITS } = require('./resourceLimits');
const zlib = require('zlib');

class ArchiveLimitError extends Error {
    constructor(reason, limitBytes, actualBytes) {
        super(`Archive safety limit exceeded (${reason})`);
        this.name = 'ArchiveLimitError';
        this.code = 'ARCHIVE_LIMIT_EXCEEDED';
        this.reason = reason;
        this.limitBytes = limitBytes;
        this.actualBytes = actualBytes;
    }
}

function resolveArchiveLimits(options = {}) {
    const custom = options.archiveLimits && typeof options.archiveLimits === 'object'
        ? options.archiveLimits
        : {};
    const resolvePositiveInteger = (value, fallback) => (
        Number.isSafeInteger(value) && value > 0 ? value : fallback
    );

    return {
        maxEntries: resolvePositiveInteger(custom.maxEntries, DEFAULT_ARCHIVE_LIMITS.maxEntries),
        maxEntryBytes: resolvePositiveInteger(custom.maxEntryBytes, DEFAULT_ARCHIVE_LIMITS.maxEntryBytes),
        maxTotalBytes: resolvePositiveInteger(custom.maxTotalBytes, DEFAULT_ARCHIVE_LIMITS.maxTotalBytes),
        maxCompressionRatio: resolvePositiveInteger(custom.maxCompressionRatio, DEFAULT_ARCHIVE_LIMITS.maxCompressionRatio),
        minRatioBytes: resolvePositiveInteger(custom.minRatioBytes, DEFAULT_ARCHIVE_LIMITS.minRatioBytes),
        maxDepth: resolvePositiveInteger(custom.maxDepth, DEFAULT_ARCHIVE_LIMITS.maxDepth)
    };
}

function formatVttTime(milliseconds) {
    const total = Math.max(0, Math.floor(milliseconds));
    const hours = Math.floor(total / 3600000);
    const minutes = Math.floor((total % 3600000) / 60000);
    const seconds = Math.floor((total % 60000) / 1000);
    const millis = total % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function parseSubtitleTime(value) {
    const input = String(value || '').trim();
    const clock = input.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
    if (clock) {
        const hours = Number(clock[1] || 0);
        const minutes = Number(clock[2]);
        const seconds = Number(clock[3]);
        const millis = Number((clock[4] || '').padEnd(3, '0'));
        if (minutes < 60 && seconds < 60) return ((hours * 3600 + minutes * 60 + seconds) * 1000) + millis;
    }
    if (/^\d+(?:\.\d+)?$/.test(input)) return Math.round(Number(input) * 1000);
    return null;
}

function cleanSubtitleMarkup(text) {
    return String(text || '')
        .replace(/\\[Nn]/g, '\n')
        .replace(/\{\\i1\}/gi, '<i>').replace(/\{\\i0\}/gi, '</i>')
        .replace(/\{\\b1\}/gi, '<b>').replace(/\{\\b0\}/gi, '</b>')
        .replace(/\{\\u1\}/gi, '<u>').replace(/\{\\u0\}/gi, '</u>')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/\r\n?/g, '\n')
        .trim();
}

function cuesToVtt(cues) {
    const valid = cues.filter(cue => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start && cue.text.trim());
    if (!valid.length) return null;
    return `WEBVTT\n\n${valid.map((cue, index) => `${index + 1}\n${formatVttTime(cue.start)} --> ${formatVttTime(cue.end)}\n${cue.text}`).join('\n\n')}\n`;
}

function convertMplToVtt(content) {
    const cues = [];
    for (const line of String(content || '').split(/\r?\n/)) {
        const match = line.match(/^\s*\[(\d+)\]\[(\d+)\](.*)$/);
        if (!match) continue;
        cues.push({
            start: Number(match[1]) * 100,
            end: Number(match[2]) * 100,
            text: cleanSubtitleMarkup(match[3].replace(/\|/g, '\n'))
        });
    }
    return cuesToVtt(cues);
}

function convertTmpToVtt(content) {
    const cues = [];
    let current = null;
    for (const line of String(content || '').split(/\r?\n/)) {
        const match = line.match(/^\s*(\d{1,3}:\d{2}:\d{2}(?:[.,]\d{1,3})?)\s*[:=]\s*(.*)$/);
        if (match) {
            const start = parseSubtitleTime(match[1]);
            if (start === null) continue;
            current = { start, end: null, text: cleanSubtitleMarkup(match[2]) };
            cues.push(current);
        } else if (current && line.trim()) {
            current.text += `\n${cleanSubtitleMarkup(line)}`;
        }
    }
    for (let index = 0; index < cues.length; index++) {
        const next = cues[index + 1];
        cues[index].end = next ? Math.max(cues[index].start + 1000, next.start) : cues[index].start + 4000;
    }
    return cuesToVtt(cues);
}

function decodeXmlText(text) {
    return String(text || '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity])
        .replace(/&#(\d+);/g, (_, code) => {
            const point = Number(code);
            return point <= 0x10FFFF && !(point >= 0xD800 && point <= 0xDFFF) ? String.fromCodePoint(point) : '';
        })
        .replace(/&#x([\da-f]+);/gi, (_, code) => {
            const point = Number.parseInt(code, 16);
            return point <= 0x10FFFF && !(point >= 0xD800 && point <= 0xDFFF) ? String.fromCodePoint(point) : '';
        });
}

function convertUsfToVtt(content) {
    const xml = String(content || '');
    // USF is XML; reject DTD/entity declarations instead of resolving external or custom entities.
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return null;
    const cues = [];
    for (const match of xml.matchAll(/<subtitle\b([^>]*)>([\s\S]*?)<\/subtitle\s*>/gi)) {
        const attributes = match[1];
        const body = match[2];
        const attr = name => attributes.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1];
        const child = name => body.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, 'i'))?.[1];
        const start = parseSubtitleTime(attr('start') || child('start'));
        const stop = parseSubtitleTime(attr('stop') || attr('end') || child('stop') || child('end'));
        const duration = parseSubtitleTime(attr('duration') || child('duration'));
        const textMatch = body.match(/<text\b[^>]*>([\s\S]*?)<\/text\s*>/i);
        const rawText = textMatch ? textMatch[1] : body;
        const preservedTags = [];
        const safeText = rawText
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/?(?:i|b|u)\b[^>]*>/gi, tag => {
                const token = `\u0001USF_TAG_${preservedTags.length}\u0001`;
                const name = tag.match(/^<\/?(i|b|u)\b/i)[1].toLowerCase();
                preservedTags.push(tag.match(/^<\//) ? `</${name}>` : `<${name}>`);
                return token;
            })
            .replace(/<[^>]*>/g, '');
        const text = cleanSubtitleMarkup(decodeXmlText(safeText)
            .replace(/[<>]/g, character => character === '<' ? '&lt;' : '&gt;')
            .replace(/\u0001USF_TAG_(\d+)\u0001/g, (_, index) => preservedTags[Number(index)] || ''));
        if (start !== null && text) {
            const end = stop !== null ? stop : (duration !== null ? start + duration : null);
            if (end !== null) cues.push({ start, end, text });
        }
    }
    return cuesToVtt(cues);
}

function normalizeArchiveSize(value, fallback) {
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function assertArchiveMetadata(metadata, archiveBytes, limits) {
    if (metadata.length > limits.maxEntries) {
        throw new ArchiveLimitError('entry count', limits.maxEntries, metadata.length);
    }

    let totalBytes = 0;
    for (const item of metadata) {
        const expandedBytes = normalizeArchiveSize(item.expandedBytes, limits.maxEntryBytes + 1);
        const compressedBytes = normalizeArchiveSize(item.compressedBytes, null);

        if (expandedBytes > limits.maxEntryBytes) {
            throw new ArchiveLimitError('single entry bytes', limits.maxEntryBytes, expandedBytes);
        }

        totalBytes += expandedBytes;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
            throw new ArchiveLimitError('cumulative expanded bytes', limits.maxTotalBytes, totalBytes);
        }

        if (expandedBytes >= limits.minRatioBytes && compressedBytes !== null) {
            const ratioLimitBytes = compressedBytes * limits.maxCompressionRatio;
            if (expandedBytes > ratioLimitBytes) {
                throw new ArchiveLimitError('entry compression ratio', ratioLimitBytes, expandedBytes);
            }
        }
    }

    if (totalBytes >= limits.minRatioBytes && archiveBytes > 0) {
        const ratioLimitBytes = archiveBytes * limits.maxCompressionRatio;
        if (totalBytes > ratioLimitBytes) {
            throw new ArchiveLimitError('archive compression ratio', ratioLimitBytes, totalBytes);
        }
    }
}

function assertExpandedBuffer(buffer, limits, totalBytes = 0) {
    const size = buffer?.length || 0;
    if (size > limits.maxEntryBytes) {
        throw new ArchiveLimitError('single entry bytes', limits.maxEntryBytes, size);
    }
    if (totalBytes + size > limits.maxTotalBytes) {
        throw new ArchiveLimitError('cumulative expanded bytes', limits.maxTotalBytes, totalBytes + size);
    }
    return totalBytes + size;
}

function assertCompressionRatio(compressedBytes, expandedBytes, limits) {
    if (expandedBytes < limits.minRatioBytes) return;
    const ratioLimitBytes = compressedBytes * limits.maxCompressionRatio;
    if (expandedBytes > ratioLimitBytes) {
        throw new ArchiveLimitError('compression ratio', ratioLimitBytes, expandedBytes);
    }
}

// Magic byte signatures for archive detection
const ARCHIVE_SIGNATURES = {
    ZIP: [0x50, 0x4B, 0x03, 0x04],  // PK..
    RAR4: [0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00],  // Rar!...  (RAR 4.x)
    RAR5: [0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00],  // Rar!.... (RAR 5.x)
    GZIP: [0x1F, 0x8B],  // Gzip compressed
    SEVENZ: [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C],  // 7z archive
    XZ: [0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00],  // XZ compressed
    BZIP2: [0x42, 0x5A, 0x68],  // BZh (Bzip2)
    // Tar has no fixed header magic at offset 0, but 'ustar' at offset 257
    // Brotli has no reliable magic bytes — detected by exclusion + trial decompression
};

/**
 * Detect archive type from buffer
 * @param {Buffer} buffer - Buffer to analyze
 * @returns {'zip'|'rar'|null} - Archive type or null if not recognized
 */
function detectArchiveType(buffer) {
    if (!buffer || buffer.length < 4) {
        log.debug(() => `[ArchiveExtractor] detectArchiveType: buffer is null or too small (${buffer?.length || 0} bytes)`);
        return null;
    }

    // Log first bytes for debugging
    const hexBytes = buffer.slice(0, Math.min(8, buffer.length)).toString('hex').match(/.{2}/g)?.join(' ') || '';
    log.debug(() => `[ArchiveExtractor] detectArchiveType: first 8 bytes: ${hexBytes}`);

    // Check ZIP signature (PK\x03\x04)
    if (buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04) {
        log.debug(() => `[ArchiveExtractor] Detected ZIP archive (PK signature)`);
        return 'zip';
    }

    // Check RAR signatures (both RAR4 and RAR5)
    if (buffer.length >= 7 &&
        buffer[0] === 0x52 && buffer[1] === 0x61 && buffer[2] === 0x72 && buffer[3] === 0x21 &&
        buffer[4] === 0x1A && buffer[5] === 0x07) {
        const isRar5 = buffer.length >= 8 && buffer[6] === 0x01 && buffer[7] === 0x00;
        log.debug(() => `[ArchiveExtractor] Detected RAR archive (Rar! signature, version: ${isRar5 ? 'RAR5' : 'RAR4'})`);
        return 'rar';
    }

    // Check Gzip signature (1F 8B)
    if (buffer.length >= 2 && buffer[0] === 0x1F && buffer[1] === 0x8B) {
        log.debug(() => `[ArchiveExtractor] Detected Gzip compressed content`);
        return 'gzip';
    }

    // Check 7z signature (37 7A BC AF 27 1C)
    if (buffer.length >= 6 &&
        buffer[0] === 0x37 && buffer[1] === 0x7A && buffer[2] === 0xBC &&
        buffer[3] === 0xAF && buffer[4] === 0x27 && buffer[5] === 0x1C) {
        log.debug(() => `[ArchiveExtractor] Detected 7-Zip archive`);
        return '7z';
    }

    // Check XZ signature (FD 37 7A 58 5A 00)
    if (buffer.length >= 6 &&
        buffer[0] === 0xFD && buffer[1] === 0x37 && buffer[2] === 0x7A &&
        buffer[3] === 0x58 && buffer[4] === 0x5A && buffer[5] === 0x00) {
        log.debug(() => `[ArchiveExtractor] Detected XZ compressed content`);
        return 'xz';
    }

    // Check Bzip2 signature (42 5A 68) - "BZh"
    if (buffer.length >= 3 &&
        buffer[0] === 0x42 && buffer[1] === 0x5A && buffer[2] === 0x68) {
        log.debug(() => `[ArchiveExtractor] Detected Bzip2 compressed content`);
        return 'bz2';
    }

    // Check Tar archive - 'ustar' at offset 257
    if (buffer.length >= 263 &&
        buffer[257] === 0x75 && buffer[258] === 0x73 && buffer[259] === 0x74 &&
        buffer[260] === 0x61 && buffer[261] === 0x72) {
        log.debug(() => `[ArchiveExtractor] Detected Tar archive (ustar signature)`);
        return 'tar';
    }

    log.debug(() => `[ArchiveExtractor] Content is not an archive (plain subtitle file)`);
    return null;
}

/**
 * Check if buffer is a valid archive (ZIP, RAR, Gzip, 7z, Tar, Bzip2, or XZ)
 * @param {Buffer} buffer - Buffer to check
 * @returns {boolean}
 */
function isArchive(buffer) {
    return detectArchiveType(buffer) !== null;
}

/**
 * Create informative subtitle for archive too large errors
 * @param {number} limitBytes - Maximum allowed size
 * @param {number} actualBytes - Actual size received
 * @returns {string}
 */
function createArchiveTooLargeSubtitle(limitBytes, actualBytes) {
    const toMb = (bytes) => Math.round((bytes / (1024 * 1024)) * 10) / 10;
    const limitMb = toMb(limitBytes);
    const actualMb = toMb(actualBytes);

    const message = `1
00:00:00,000 --> 04:00:00,000
Subtitle pack is too large to process.
Size: ${actualMb} MB (limit: ${limitMb} MB).
Please pick another subtitle or provider.`;

    return appendHiddenInformationalNote(message);
}

function createArchiveSafetyLimitSubtitle(error) {
    const reason = error?.reason || 'safe processing limit';
    const detail = reason === 'entry count'
        ? `The pack contains too many files (${error.actualBytes}; limit: ${error.limitBytes}).`
        : reason.includes('compression ratio')
            ? 'The pack expands far beyond its compressed size.'
            : reason === 'recursion depth'
                ? `The pack contains too many nested compression layers (limit: ${error.limitBytes}).`
                : 'The pack expands beyond the safe processing limit.';

    const message = `1
00:00:00,000 --> 04:00:00,000
Subtitle pack is too large or complex to process safely.
${detail}
Please pick another subtitle or provider.`;

    return appendHiddenInformationalNote(message);
}

/**
 * Create informative subtitle when episode not found in season pack
 * @param {number} episode - Requested episode number
 * @param {number} season - Requested season number
 * @param {Array<string>} entries - List of files in archive
 * @returns {string}
 */
function createEpisodeNotFoundSubtitle(episode, season, entries = []) {
    try {
        const seasonStr = String(season).padStart(2, '0');
        const episodeStr = String(episode).padStart(2, '0');
        const seasonEpisodeStr = `S${seasonStr}E${episodeStr}`;

        // Try to extract episode numbers from filenames for helpful message
        const foundEpisodes = (entries || [])
            .map(filename => {
                // Match explicit episode labels (Episode 12, Ep12, Cap 12, OVA 3, etc.)
                // Supports: episode, episodio, capitulo, cap, ep, e, ova, oad, x
                const labeled = String(filename || '').match(/(?:episode|episodio|capitulo|cap|ep|e|ova|oad|x)\s*0*(\d{1,4})/i);
                if (labeled && labeled[1]) return parseInt(labeled[1], 10);

                // Fallback: any standalone 1-4 digit number not obviously a resolution/year
                const generic = String(filename || '').match(/(?:^|[^0-9])(\d{1,4})(?=[^0-9]|$)/);
                if (generic && generic[1]) {
                    const n = parseInt(generic[1], 10);
                    if (Number.isNaN(n)) return null;
                    // Skip common resolutions and years
                    if ([480, 720, 1080, 2160].includes(n)) return null;
                    if (n >= 1900 && n <= 2099) return null;
                    return n;
                }
                return null;
            })
            .filter(ep => ep !== null && ep > 0 && ep < 4000)
            .sort((a, b) => a - b);

        const uniqueEpisodes = [...new Set(foundEpisodes)];
        const availableInfo = uniqueEpisodes.length > 0
            ? `Pack contains ~${uniqueEpisodes.length} files, episodes ${uniqueEpisodes[0]}-${uniqueEpisodes[uniqueEpisodes.length - 1]}`
            : 'No episode numbers detected in pack.';

        const message = `1
00:00:00,000 --> 04:00:00,000
Episode ${seasonEpisodeStr} not found in this subtitle pack.
${availableInfo}
Try another subtitle or a different provider.`;

        return appendHiddenInformationalNote(message);
    } catch (_) {
        const fallback = `1
00:00:00,000 --> 04:00:00,000
Episode not found in this subtitle pack.
`;
        return appendHiddenInformationalNote(fallback);
    }
}

/**
 * Create informative subtitle for corrupted archive errors
 * @param {string} providerName - Name of the subtitle provider
 * @param {string} archiveType - Type of archive (zip/rar/gzip/7z/tar/bz2/xz)
 * @returns {string}
 */
function createCorruptedArchiveSubtitle(providerName, archiveType) {
    const archiveName = (archiveType || 'unknown').toUpperCase();
    const message = `1
00:00:00,000 --> 04:00:00,000
${providerName} download failed: Corrupted ${archiveName} file
The subtitle file appears to be damaged or incomplete.
Try selecting a different subtitle.`;
    return appendHiddenInformationalNote(message);
}

/**
 * Create informative subtitle for unsupported format errors
 * @param {string} providerName - Name of the subtitle provider
 * @param {string} formatName - Name of the unsupported format (e.g., 'VobSub', 'PGS')
 * @param {string} filename - Original filename
 * @param {string} reason - Why this format is unsupported
 * @returns {string}
 */
function createUnsupportedFormatSubtitle(providerName, formatName, filename, reason) {
    const message = `1
00:00:00,000 --> 04:00:00,000
Unsupported subtitle format: ${formatName}
${reason}
Please select a different subtitle (SRT, VTT, or ASS recommended).`;
    return appendHiddenInformationalNote(message);
}

/**
 * Extract files from a RAR archive
 * @param {Buffer} buffer - RAR archive buffer
 * @returns {Promise<{files: Map<string, Buffer>, entries: string[]}>}
 */
async function extractRar(buffer, selectionOptions = {}, limits = DEFAULT_ARCHIVE_LIMITS) {
    log.debug(() => `[ArchiveExtractor] extractRar: starting RAR extraction (${buffer.length} bytes)`);

    const { createExtractorFromData } = require('node-unrar-js');
    const path = require('path');

    try {
        const extractor = await createExtractorFromData({ data: buffer });
        log.debug(() => `[ArchiveExtractor] extractRar: RAR extractor created successfully`);

        const list = extractor.getFileList();
        const fileHeaders = [...list.fileHeaders];
        log.debug(() => `[ArchiveExtractor] extractRar: found ${fileHeaders.length} total entries (including directories)`);

        const nonDirectoryHeaders = fileHeaders.filter(h => !h.flags.directory);
        assertArchiveMetadata(nonDirectoryHeaders.map(header => ({
            expandedBytes: header.unpSize,
            compressedBytes: header.packSize
        })), buffer.length, limits);

        const entries = nonDirectoryHeaders
            .map(h => h.name)
            .filter(name => {
                // Reject entries with path traversal sequences or absolute paths
                // Check for '..' as a path component, not just any '..' substring (avoids false positives for ellipses like "Cloudy...")
                const normalized = name.replace(/\\/g, '/');
                const hasPathTraversal = /(^|\/)\.\.(\/|$)/.test(normalized);
                if (hasPathTraversal || path.isAbsolute(normalized) || normalized.startsWith('/')) {
                    log.warn(() => `[ArchiveExtractor] extractRar: skipping suspicious entry: ${name}`);
                    return false;
                }
                return true;
            });
        log.debug(() => `[ArchiveExtractor] extractRar: ${entries.length} files (excluding directories)`);

        if (entries.length > 0) {
            log.debug(() => `[ArchiveExtractor] extractRar: files in RAR: ${entries.slice(0, 10).join(', ')}${entries.length > 10 ? ` ... and ${entries.length - 10} more` : ''}`);
        }

        const files = new Map();
        const { filename: selectedFilename } = findSubtitleFile(entries, selectionOptions);
        if (!selectedFilename) {
            return { files, entries };
        }

        // node-unrar-js can filter before extraction. Expanding only the file
        // selected by the existing matching logic avoids materializing an
        // entire season pack while preserving the chosen subtitle.
        const safeEntrySet = new Set([selectedFilename]);
        const extracted = extractor.extract({ files: [selectedFilename] });
        let extractedCount = 0;
        let totalBytes = 0;

        for (const file of extracted.files) {
            if (file.extraction) {
                const entryName = file.fileHeader.name;
                // Only include entries that passed our safety filter
                if (!safeEntrySet.has(entryName)) {
                    log.warn(() => `[ArchiveExtractor] extractRar: skipping extraction of unsafe entry: ${entryName}`);
                    continue;
                }
                const fileBuffer = Buffer.from(file.extraction);
                totalBytes = assertExpandedBuffer(fileBuffer, limits, totalBytes);
                files.set(entryName, fileBuffer);
                extractedCount++;
                log.debug(() => `[ArchiveExtractor] extractRar: extracted ${entryName} (${fileBuffer.length} bytes)`);
            }
        }

        log.debug(() => `[ArchiveExtractor] extractRar: successfully extracted ${extractedCount} files`);
        return { files, entries };
    } catch (err) {
        if (err instanceof ArchiveLimitError) throw err;
        log.error(() => [`[ArchiveExtractor] extractRar: RAR extraction failed:`, err.message]);
        log.error(() => `[ArchiveExtractor] extractRar: stack trace: ${err.stack}`);
        throw err;
    }
}

/**
 * Decompress a Gzip buffer
 * After decompression, the result may be a tar archive, another archive, or plain subtitle content
 * @param {Buffer} buffer - Gzip compressed buffer
 * @returns {Promise<Buffer>} - Decompressed buffer
 */
async function decompressGzip(buffer, maxOutputBytes = DEFAULT_ARCHIVE_LIMITS.maxTotalBytes) {
    log.debug(() => `[ArchiveExtractor] decompressGzip: decompressing ${buffer.length} bytes`);
    try {
        const decompressed = zlib.gunzipSync(buffer, { maxOutputLength: maxOutputBytes });
        log.debug(() => `[ArchiveExtractor] decompressGzip: decompressed to ${decompressed.length} bytes`);
        return decompressed;
    } catch (err) {
        if (err?.code === 'ERR_BUFFER_TOO_LARGE') throw err;
        log.error(() => [`[ArchiveExtractor] decompressGzip: Gzip decompression failed:`, err.message]);
        throw err;
    }
}

/**
 * Decompress a Brotli buffer
 * @param {Buffer} buffer - Brotli compressed buffer
 * @returns {Promise<Buffer>} - Decompressed buffer
 */
async function decompressBrotli(buffer, maxOutputBytes = DEFAULT_ARCHIVE_LIMITS.maxTotalBytes) {
    log.debug(() => `[ArchiveExtractor] decompressBrotli: decompressing ${buffer.length} bytes`);
    try {
        // maxOutputLength limits expansion; only the patched Node runtime protects its native Brotli decoder.
        const decompressed = zlib.brotliDecompressSync(buffer, { maxOutputLength: maxOutputBytes });
        log.debug(() => `[ArchiveExtractor] decompressBrotli: decompressed to ${decompressed.length} bytes`);
        return decompressed;
    } catch (err) {
        if (err?.code === 'ERR_BUFFER_TOO_LARGE') throw err;
        log.error(() => [`[ArchiveExtractor] decompressBrotli: Brotli decompression failed:`, err.message]);
        throw err;
    }
}

/**
 * Decompress a Bzip2 buffer using bzip2 decompression
 * Node.js doesn't include bzip2 natively, so we attempt with a pure-JS fallback
 * @param {Buffer} buffer - Bzip2 compressed buffer
 * @returns {Promise<Buffer>} - Decompressed buffer
 */
async function decompressBzip2(buffer) {
    log.debug(() => `[ArchiveExtractor] decompressBzip2: decompressing ${buffer.length} bytes`);
    try {
        // Try to use seek-bzip if available
        const seekBzip = require('seek-bzip');
        const decompressed = seekBzip.decode(buffer);
        log.debug(() => `[ArchiveExtractor] decompressBzip2: decompressed to ${decompressed.length} bytes`);
        return Buffer.from(decompressed);
    } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') {
            log.warn(() => `[ArchiveExtractor] decompressBzip2: seek-bzip not installed, Bzip2 decompression unavailable`);
            throw new Error('Bzip2 decompression not available (seek-bzip not installed)');
        }
        log.error(() => [`[ArchiveExtractor] decompressBzip2: Bzip2 decompression failed:`, err.message]);
        throw err;
    }
}

/**
 * Decompress an XZ/LZMA buffer
 * Node.js doesn't include XZ natively; we try lzma-native if available
 * @param {Buffer} buffer - XZ compressed buffer
 * @returns {Promise<Buffer>} - Decompressed buffer
 */
async function decompressXz(buffer) {
    log.debug(() => `[ArchiveExtractor] decompressXz: decompressing ${buffer.length} bytes`);
    try {
        const lzma = require('lzma-native');
        const decompressed = await new Promise((resolve, reject) => {
            lzma.decompress(buffer, (result, err) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
        log.debug(() => `[ArchiveExtractor] decompressXz: decompressed to ${decompressed.length} bytes`);
        return Buffer.from(decompressed);
    } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') {
            log.warn(() => `[ArchiveExtractor] decompressXz: lzma-native not installed, XZ decompression unavailable`);
            throw new Error('XZ decompression not available (lzma-native not installed)');
        }
        log.error(() => [`[ArchiveExtractor] decompressXz: XZ decompression failed:`, err.message]);
        throw err;
    }
}

/**
 * Extract files from a 7-Zip archive
 * @param {Buffer} buffer - 7z archive buffer
 * @returns {Promise<{files: Map<string, Buffer>, entries: string[]}>}
 */
async function extract7z(buffer, limits = DEFAULT_ARCHIVE_LIMITS) {
    log.debug(() => `[ArchiveExtractor] extract7z: starting 7z extraction (${buffer.length} bytes)`);
    const path = require('path');

    try {
        const { SevenZipReader } = require('7z-iterator');
        const reader = new SevenZipReader(buffer);
        const files = new Map();
        const entries = [];
        let totalBytes = 0;

        for (const entry of reader) {
            // Skip directories
            if (entry.isDirectory) continue;

            const name = entry.name || entry.path || '';
            // Path traversal protection
            const normalized = name.replace(/\\/g, '/');
            const hasPathTraversal = /(^|\/)\.\.(\/$|$)/.test(normalized);
            if (hasPathTraversal || path.isAbsolute(normalized) || normalized.startsWith('/')) {
                log.warn(() => `[ArchiveExtractor] extract7z: skipping suspicious entry: ${name}`);
                continue;
            }

            entries.push(name);
            if (entries.length > limits.maxEntries) {
                throw new ArchiveLimitError('entry count', limits.maxEntries, entries.length);
            }

            const declaredSize = normalizeArchiveSize(
                entry.size ?? entry.uncompressedSize ?? entry.unpackedSize,
                null
            );
            if (declaredSize !== null) {
                if (declaredSize > limits.maxEntryBytes) {
                    throw new ArchiveLimitError('single entry bytes', limits.maxEntryBytes, declaredSize);
                }
                if (totalBytes + declaredSize > limits.maxTotalBytes) {
                    throw new ArchiveLimitError('cumulative expanded bytes', limits.maxTotalBytes, totalBytes + declaredSize);
                }
            }

            const content = entry.extract();
            if (content) {
                const fileBuffer = Buffer.from(content);
                totalBytes = assertExpandedBuffer(fileBuffer, limits, totalBytes);
                assertCompressionRatio(buffer.length, totalBytes, limits);
                files.set(name, fileBuffer);
                log.debug(() => `[ArchiveExtractor] extract7z: extracted ${name} (${content.length} bytes)`);
            }
        }

        log.debug(() => `[ArchiveExtractor] extract7z: successfully extracted ${files.size} files`);
        return { files, entries };
    } catch (err) {
        if (err instanceof ArchiveLimitError) throw err;
        log.error(() => [`[ArchiveExtractor] extract7z: 7z extraction failed:`, err.message]);
        log.error(() => `[ArchiveExtractor] extract7z: stack trace: ${err.stack}`);
        throw err;
    }
}

/**
 * Extract files from a Tar archive
 * @param {Buffer} buffer - Tar archive buffer
 * @returns {Promise<{files: Map<string, Buffer>, entries: string[]}>}
 */
async function extractTar(buffer, limits = DEFAULT_ARCHIVE_LIMITS) {
    log.debug(() => `[ArchiveExtractor] extractTar: starting Tar extraction (${buffer.length} bytes)`);
    const path = require('path');

    try {
        const tar = require('tar-stream');
        const { Readable } = require('stream');
        const extract = tar.extract();
        const files = new Map();
        const entries = [];
        let entryCount = 0;
        let totalBytes = 0;

        const promise = new Promise((resolve, reject) => {
            extract.on('entry', (header, stream, next) => {
                const name = header.name || '';
                const chunks = [];

                // Skip directories
                if (header.type === 'directory') {
                    stream.resume();
                    next();
                    return;
                }

                entryCount++;
                if (entryCount > limits.maxEntries) {
                    extract.destroy(new ArchiveLimitError('entry count', limits.maxEntries, entryCount));
                    return;
                }

                const declaredSize = normalizeArchiveSize(header.size, limits.maxEntryBytes + 1);
                if (declaredSize > limits.maxEntryBytes) {
                    extract.destroy(new ArchiveLimitError('single entry bytes', limits.maxEntryBytes, declaredSize));
                    return;
                }
                if (totalBytes + declaredSize > limits.maxTotalBytes) {
                    extract.destroy(new ArchiveLimitError('cumulative expanded bytes', limits.maxTotalBytes, totalBytes + declaredSize));
                    return;
                }

                // Path traversal protection
                const normalized = name.replace(/\\/g, '/');
                const hasPathTraversal = /(^|\/)\.\.(\/$|$)/.test(normalized);
                if (hasPathTraversal || path.isAbsolute(normalized) || normalized.startsWith('/')) {
                    log.warn(() => `[ArchiveExtractor] extractTar: skipping suspicious entry: ${name}`);
                    stream.resume();
                    next();
                    return;
                }

                stream.on('data', (chunk) => chunks.push(chunk));
                stream.on('end', () => {
                    try {
                        const fileBuffer = Buffer.concat(chunks);
                        totalBytes = assertExpandedBuffer(fileBuffer, limits, totalBytes);
                        assertCompressionRatio(buffer.length, totalBytes, limits);
                        entries.push(name);
                        files.set(name, fileBuffer);
                        log.debug(() => `[ArchiveExtractor] extractTar: extracted ${name} (${fileBuffer.length} bytes)`);
                        next();
                    } catch (err) {
                        extract.destroy(err);
                    }
                });
                stream.on('error', (err) => {
                    log.warn(() => `[ArchiveExtractor] extractTar: error reading entry ${name}: ${err.message}`);
                    next();
                });
            });

            extract.on('finish', () => resolve());
            extract.on('error', (err) => reject(err));
        });

        // Pipe buffer into the tar extractor
        const readable = Readable.from(buffer);
        readable.pipe(extract);

        await promise;

        log.debug(() => `[ArchiveExtractor] extractTar: successfully extracted ${files.size} files`);
        return { files, entries };
    } catch (err) {
        if (err instanceof ArchiveLimitError) throw err;
        log.error(() => [`[ArchiveExtractor] extractTar: Tar extraction failed:`, err.message]);
        log.error(() => `[ArchiveExtractor] extractTar: stack trace: ${err.stack}`);
        throw err;
    }
}

/**
 * Extract files from a ZIP archive
 * @param {Buffer} buffer - ZIP archive buffer
 * @returns {Promise<{zip: JSZip, entries: string[]}>}
 */
async function extractZip(buffer, limits = DEFAULT_ARCHIVE_LIMITS) {
    log.debug(() => `[ArchiveExtractor] extractZip: starting ZIP extraction (${buffer.length} bytes)`);

    const JSZip = require('jszip');
    const path = require('path');

    try {
        const zip = await JSZip.loadAsync(buffer, { base64: false });
        const allEntries = Object.keys(zip.files);
        const fileEntries = allEntries.filter(name => !zip.files[name].dir);
        assertArchiveMetadata(fileEntries.map(name => ({
            expandedBytes: zip.files[name]?._data?.uncompressedSize,
            compressedBytes: zip.files[name]?._data?.compressedSize
        })), buffer.length, limits);

        const entries = allEntries.filter(name => {
            if (zip.files[name].dir) return false;
            // Reject entries with path traversal sequences or absolute paths
            // Check for '..' as a path component, not just any '..' substring (avoids false positives for ellipses like "Cloudy...")
            const normalized = name.replace(/\\/g, '/');
            const hasPathTraversal = /(^|\/)\.\.(\/|$)/.test(normalized);
            if (hasPathTraversal || path.isAbsolute(normalized) || normalized.startsWith('/')) {
                log.warn(() => `[ArchiveExtractor] extractZip: skipping suspicious entry: ${name}`);
                return false;
            }
            return true;
        });

        log.debug(() => `[ArchiveExtractor] extractZip: ${allEntries.length} total entries, ${entries.length} files (excluding directories and unsafe entries)`);
        if (entries.length > 0) {
            log.debug(() => `[ArchiveExtractor] extractZip: files in ZIP: ${entries.slice(0, 10).join(', ')}${entries.length > 10 ? ` ... and ${entries.length - 10} more` : ''}`);
        }

        return { zip, entries };
    } catch (err) {
        if (err instanceof ArchiveLimitError) throw err;
        log.error(() => [`[ArchiveExtractor] extractZip: ZIP extraction failed:`, err.message]);
        log.error(() => `[ArchiveExtractor] extractZip: stack trace: ${err.stack}`);
        throw err;
    }
}


/**
 * Helper function to find episode file in season pack (regular TV shows)
 * @param {string[]} files - Array of filenames
 * @param {number} season - Season number
 * @param {number} episode - Episode number
 * @returns {string|null}
 */
function findEpisodeFile(files, season, episode) {
    const seasonEpisodePatterns = [
        new RegExp(`s0*${season}e0*${episode}(?:v\\d+)?(?![0-9])`, 'i'),
        new RegExp(`${season}x0*${episode}(?:v\\d+)?(?![0-9])`, 'i'),
        new RegExp(`s0*${season}[\\s._-]*x[\\s._-]*e?0*${episode}(?:v\\d+)?(?![0-9])`, 'i'),
        new RegExp(`0*${season}[\\s._-]*x[\\s._-]*e?0*${episode}(?:v\\d+)?(?![0-9])`, 'i'),
        new RegExp(`season[\\s._-]*0*${season}[\\s._-]*episode[\\s._-]*0*${episode}(?![0-9])`, 'i'),
        new RegExp(`s0*${season}\\.e0*${episode}(?:v\\d+)?`, 'i'),
        // Matches "s01-e10", "s01_e10", "s01 e10"
        new RegExp(`s0*${season}[\\s._-]*e0*${episode}(?:v\\d+)?(?![0-9])`, 'i'),
        // Matches "01e10" format (common in some releases, e.g. "01e10 - Title.srt")
        new RegExp(`(?:^|[^a-z])0*${season}e0*${episode}(?:v\\d+)?(?![0-9])`, 'i')
    ];

    for (const filename of files) {
        const lowerName = filename.toLowerCase();
        if (seasonEpisodePatterns.some(pattern => pattern.test(lowerName))) {
            return filename;
        }
    }

    return null;
}

/**
 * Helper function to find episode file in anime season pack (episode number only)
 * @param {string[]} files - Array of filenames
 * @param {number} episode - Episode number
 * @returns {string|null}
 */
function findEpisodeFileAnime(files, episode) {
    const animeEpisodePatterns = [
        new RegExp(`(?<=\\b|\\s|\\[|\\(|-|_)e(?:p(?:isode)?)?[\\s._-]*0*${episode}(?:v\\d+)?(?=\\b|\\s|\\]|\\)|\\.|-|_|$)`, 'i'),
        new RegExp(`(?:^|[\\s\\[\\(\\-_.])0*${episode}(?:v\\d+)?(?=$|[\\s\\[\\]\\(\\)\\-_.])`, 'i'),
        new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${episode}(?:v\\d+)?[a-z]{2,3}(?=\\.|[\\s\\[\\]\\(\\)\\-_.]|$)`, 'i'),
        new RegExp(`(?:episode|episodio|ep|cap(?:itulo)?)\\s*0*${episode}(?![0-9])`, 'i'),
        new RegExp(`第?\\s*0*${episode}\\s*(?:話|集|화)`, 'i'),
        new RegExp(`^(?!.*(?:720|1080|480|2160)p).*[\\[\\(\\-_\\s]0*${episode}[\\]\\)\\-_\\s\\.]`, 'i')
    ];

    for (const filename of files) {
        const lowerName = filename.toLowerCase();
        const targetEpisode = Number(episode);

        // If filename has an explicit TV-style episode marker (SxxEyy / x format),
        // only accept it when that episode actually matches the requested one.
        const explicitEpisodeMatch =
            lowerName.match(/\bs\d{1,3}[.\s_-]*e(\d{1,4})(?!\d)/i) ||
            lowerName.match(/(?:^|[^a-z0-9])\d{1,3}x(\d{1,4})(?!\d)/i);
        if (explicitEpisodeMatch) {
            const explicitEpisode = parseInt(explicitEpisodeMatch[1], 10);
            if (!Number.isNaN(explicitEpisode) && explicitEpisode !== targetEpisode) {
                continue;
            }
        }

        // Skip resolution/year false positives
        if (/(?:720|1080|480|2160)p|(?:19|20)\d{2}/.test(lowerName)) {
            const episodeStr = String(episode).padStart(2, '0');
            if (lowerName.includes(`${episodeStr}p`) || lowerName.includes(`20${episodeStr}`)) {
                continue;
            }
        }

        if (animeEpisodePatterns.some(pattern => pattern.test(lowerName))) {
            return filename;
        }
    }

    return null;
}

/**
 * Find the target subtitle file in an archive
 * @param {string[]} entries - List of files in archive
 * @param {Object} options - Search options
 * @param {boolean} options.isSeasonPack - Whether this is a season pack
 * @param {number} options.season - Season number (for season packs)
 * @param {number} options.episode - Episode number (for season packs)
 * @param {boolean} options.skipAssConversion - When true, prefer ASS/SSA files over SRT
 * @returns {{filename: string|null, isSrt: boolean}}
 */
function findSubtitleFile(entries, options = {}) {
    const { isSeasonPack, season, episode, skipAssConversion = false } = options;

    log.debug(() => `[ArchiveExtractor] findSubtitleFile: searching ${entries.length} entries, isSeasonPack=${isSeasonPack}, season=${season}, episode=${episode}, preferAss=${skipAssConversion}`);

    // Some providers ship valid SubRip files with a trailing transport/storage
    // suffix (for example `release.srt.txt`). Treat those as SRT without
    // accepting arbitrary `.txt` files such as readmes or release notes.
    const isSrtFilename = (filename) => /\.srt(?:\.txt)?$/i.test(String(filename || ''));

    // Filter by extension type
    const srtFiles = entries.filter(isSrtFilename);
    const assFiles = entries.filter(f => {
        const lower = f.toLowerCase();
        return lower.endsWith('.ass') || lower.endsWith('.ssa');
    });
    const altFiles = entries.filter(f => {
        const lower = f.toLowerCase();
        return lower.endsWith('.vtt') || lower.endsWith('.ass') || lower.endsWith('.ssa') || lower.endsWith('.sub');
    });

    log.debug(() => `[ArchiveExtractor] findSubtitleFile: found ${srtFiles.length} SRT files, ${assFiles.length} ASS/SSA files, ${altFiles.length} alternate format files`);

    // When ASS passthrough is enabled, prefer ASS/SSA files; otherwise prefer SRT
    const primaryFiles = skipAssConversion ? assFiles : srtFiles;
    const primaryLabel = skipAssConversion ? 'ASS/SSA' : 'SRT';
    const secondaryFiles = skipAssConversion ? srtFiles : altFiles;
    const secondaryLabel = skipAssConversion ? 'SRT' : 'alternate format';

    if (isSeasonPack && season && episode) {
        log.debug(() => `[ArchiveExtractor] findSubtitleFile: searching for S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')} in season pack`);

        // Season pack: find specific episode
        // Try preferred format first with anime patterns, then TV patterns
        let target = findEpisodeFileAnime(primaryFiles, episode);
        if (target) {
            log.debug(() => `[ArchiveExtractor] findSubtitleFile: found ${primaryLabel} via anime pattern: ${target}`);
            return { filename: target, isSrt: isSrtFilename(target) };
        }

        target = findEpisodeFile(primaryFiles, season, episode);
        if (target) {
            log.debug(() => `[ArchiveExtractor] findSubtitleFile: found ${primaryLabel} via TV pattern: ${target}`);
            return { filename: target, isSrt: isSrtFilename(target) };
        }

        // Try any format with anime patterns, then TV patterns
        target = findEpisodeFileAnime(entries, episode);
        if (target) {
            log.debug(() => `[ArchiveExtractor] findSubtitleFile: found via anime pattern (any format): ${target}`);
            return { filename: target, isSrt: isSrtFilename(target) };
        }

        target = findEpisodeFile(entries, season, episode);
        if (target) {
            log.debug(() => `[ArchiveExtractor] findSubtitleFile: found via TV pattern (any format): ${target}`);
            return { filename: target, isSrt: isSrtFilename(target) };
        }

        log.warn(() => `[ArchiveExtractor] findSubtitleFile: episode not found in season pack. Available files: ${entries.join(', ')}`);
        return { filename: null, isSrt: false };
    } else {
        // Not a season pack: find first subtitle file (prefer ASS/SSA when passthrough enabled)
        if (primaryFiles.length > 0) {
            log.debug(() => `[ArchiveExtractor] findSubtitleFile: using first ${primaryLabel}: ${primaryFiles[0]}`);
            return { filename: primaryFiles[0], isSrt: isSrtFilename(primaryFiles[0]) };
        }
        if (secondaryFiles.length > 0) {
            log.debug(() => `[ArchiveExtractor] findSubtitleFile: using first ${secondaryLabel}: ${secondaryFiles[0]}`);
            return { filename: secondaryFiles[0], isSrt: isSrtFilename(secondaryFiles[0]) };
        }
        log.warn(() => `[ArchiveExtractor] findSubtitleFile: no subtitle files found`);
        return { filename: null, isSrt: false };
    }
}

/**
 * Read file content from archive
 * @param {Object} archive - Archive object (JSZip instance or Map of files)
 * @param {string} filename - Filename to read
 * @param {'zip'|'rar'} archiveType - Type of archive
 * @returns {Promise<Buffer>}
 */
async function readFileFromArchive(archive, filename, archiveType) {
    if (archiveType === 'zip') {
        return await archive.files[filename].async('nodebuffer');
    } else if (archiveType === 'rar') {
        return archive.get(filename);
    }
    throw new Error(`Unknown archive type: ${archiveType}`);
}

/**
 * Decode buffer with proper encoding detection
 * Uses centralized encoding detector for Arabic/Hebrew/RTL language support
 * @param {Buffer} buffer - Buffer to decode
 * @param {string} providerName - Provider name for logging
 * @returns {string}
 */
function decodeWithBomAwareness(buffer, providerName, languageHint) {
    // Use centralized encoding detector for proper Arabic/Hebrew/RTL support
    return detectAndConvertEncoding(buffer, providerName, languageHint || null);
}

/**
 * Convert non-SRT subtitle formats to VTT
 * @param {string} content - Subtitle content
 * @param {string} filename - Original filename
 * @param {string} providerName - Provider name for logging
 * @param {Object} options - Conversion options
 * @param {boolean} options.skipAssConversion - If true, return ASS/SSA as-is without conversion
 * @returns {Promise<string|{content: string, format: string}>} - VTT string or object with original content and format
 */
async function convertSubtitleToVtt(content, filename, providerName, options = {}) {
    const { skipAssConversion = false } = options;
    const lower = filename.toLowerCase();
    const contentLength = content?.length || 0;

    log.debug(() => `[${providerName}] convertSubtitleToVtt: converting ${filename} (${contentLength} chars, skipAss=${skipAssConversion})`);

    // Strip UTF-8 BOM if present
    if (content && typeof content === 'string') {
        const hadBom = content.charCodeAt(0) === 0xFEFF;
        content = content.replace(/^\uFEFF/, '');
        if (hadBom) log.debug(() => `[${providerName}] Stripped UTF-8 BOM from ${filename}`);
    }

    const textExtension = lower.endsWith('.txt');
    const mpl = lower.endsWith('.mpl') || (textExtension && /^\s*\[\d+\]\[\d+\]/m.test(content));
    const tmp = lower.endsWith('.tmp') || (textExtension && /^\s*\d{1,3}:\d{2}:\d{2}(?:[.,]\d{1,3})?\s*[:=]/m.test(content));
    const usf = lower.endsWith('.usf') || (textExtension && /<USFSubtitles\b|<subtitle\b/i.test(content));
    const customVtt = mpl ? convertMplToVtt(content) : tmp ? convertTmpToVtt(content) : usf ? convertUsfToVtt(content) : null;
    if (customVtt) {
        log.debug(() => `[${providerName}] Converted ${mpl ? 'MPL2' : tmp ? 'TMP' : 'USF'} subtitles to VTT (${customVtt.length} chars)`);
        return customVtt;
    }

    // If skipAssConversion is enabled, return ASS/SSA files as-is with format info
    if (skipAssConversion && (lower.endsWith('.ass') || lower.endsWith('.ssa'))) {
        const format = lower.endsWith('.ass') ? 'ass' : 'ssa';
        log.debug(() => `[${providerName}] ASS/SSA conversion disabled, returning original ${format.toUpperCase()}: ${filename}`);
        return { content, format };
    }

    // VTT - return as-is
    if (lower.endsWith('.vtt')) {
        log.debug(() => `[${providerName}] Keeping original VTT: ${filename}`);
        return content;
    }

    // Handle MicroDVD .sub files
    if (lower.endsWith('.sub')) {
        const isMicroDVD = /^\s*\{\d+\}\{\d+\}/.test(content);
        log.debug(() => `[${providerName}] .sub file detected, isMicroDVD format: ${isMicroDVD}`);
        if (isMicroDVD) {
            log.debug(() => `[${providerName}] Converting MicroDVD .sub format: ${filename}`);
            try {
                const subsrt = require('subsrt-ts');
                const fps = 25; // Default PAL framerate
                const converted = subsrt.convert(content, { to: 'vtt', from: 'sub', fps });
                if (converted && typeof converted === 'string' && converted.trim().length > 0) {
                    log.debug(() => `[${providerName}] Successfully converted MicroDVD .sub to VTT (fps=${fps}, ${converted.length} chars)`);
                    return converted;
                }
                log.warn(() => `[${providerName}] MicroDVD conversion returned empty result`);
            } catch (subErr) {
                log.error(() => [`[${providerName}] Failed to convert MicroDVD .sub:`, subErr.message]);
                log.debug(() => `[${providerName}] MicroDVD conversion stack: ${subErr.stack}`);
            }
        } else {
            log.warn(() => `[${providerName}] VobSub .sub format (binary/image-based) not supported: ${filename}`);
            return createUnsupportedFormatSubtitle(
                providerName,
                'VobSub (.sub)',
                filename,
                'This is an image-based subtitle from a DVD rip.\nIt cannot be converted to text.'
            );
        }
    }

    // Try enhanced ASS/SSA conversion for .ass and .ssa files
    if (lower.endsWith('.ass') || lower.endsWith('.ssa')) {
        log.debug(() => `[${providerName}] Attempting enhanced ASS/SSA conversion for ${filename}`);
        try {
            const assConverter = require('./assConverter');
            const format = lower.endsWith('.ass') ? 'ass' : 'ssa';
            const result = assConverter.convertASSToVTT(content, format);
            if (result.success) {
                log.debug(() => `[${providerName}] Enhanced converter succeeded: ${filename} -> VTT (${result.content.length} chars)`);
                return result.content;
            }
            log.warn(() => `[${providerName}] Enhanced converter failed: ${result.error}, trying subsrt-ts fallback`);
        } catch (e) {
            log.debug(() => `[${providerName}] Enhanced ASS converter not available or failed: ${e.message}`);
        }
    }

    // Try subsrt-ts library conversion
    // Apply ASS preprocessor to fix subsrt-ts first-letter-loss bug for ASS/SSA content
    log.debug(() => `[${providerName}] Attempting subsrt-ts conversion for ${filename}`);
    try {
        const subsrt = require('subsrt-ts');
        const assConverterMod = require('./assConverter');
        const isAss = lower.endsWith('.ass') || lower.endsWith('.ssa');
        const preprocessed = isAss ? assConverterMod.preprocessASS(content, lower.endsWith('.ass') ? 'ass' : 'ssa') : content;
        let converted;
        if (lower.endsWith('.ass')) {
            converted = subsrt.convert(preprocessed, { to: 'vtt', from: 'ass' });
        } else if (lower.endsWith('.ssa')) {
            converted = subsrt.convert(preprocessed, { to: 'vtt', from: 'ssa' });
        } else {
            converted = subsrt.convert(preprocessed, { to: 'vtt' });
        }

        if (!converted || typeof converted !== 'string' || converted.trim().length === 0) {
            log.debug(() => `[${providerName}] subsrt-ts returned empty, trying with sanitized content (removing null chars)`);
            const sanitized = (preprocessed || '').replace(/\u0000/g, '');
            if (sanitized && sanitized !== preprocessed) {
                if (lower.endsWith('.ass')) {
                    converted = subsrt.convert(sanitized, { to: 'vtt', from: 'ass' });
                } else if (lower.endsWith('.ssa')) {
                    converted = subsrt.convert(sanitized, { to: 'vtt', from: 'ssa' });
                } else {
                    converted = subsrt.convert(sanitized, { to: 'vtt' });
                }
            }
        }

        if (converted && typeof converted === 'string' && converted.trim().length > 0) {
            if (isAss) {
                const postprocessed = assConverterMod.postprocessVTT(converted);
                if (assConverterMod.validateVTT(postprocessed)) {
                    log.debug(() => `[${providerName}] subsrt-ts conversion succeeded: ${filename} -> VTT (${postprocessed.length} chars)`);
                    return postprocessed;
                }

                const preview = postprocessed.trim().slice(0, 120).replace(/\s+/g, ' ');
                log.warn(() => `[${providerName}] subsrt-ts conversion produced invalid VTT, rejecting result: ${preview || '<empty>'}`);
            } else {
                log.debug(() => `[${providerName}] subsrt-ts conversion succeeded: ${filename} -> VTT (${converted.length} chars)`);
                return converted;
            }
        }
        log.warn(() => `[${providerName}] subsrt-ts conversion returned empty or invalid result`);
    } catch (convErr) {
        log.error(() => [`[${providerName}] subsrt-ts conversion failed:`, convErr.message]);
        log.debug(() => `[${providerName}] subsrt-ts stack: ${convErr.stack}`);
    }

    // Manual ASS/SSA fallback parser
    log.debug(() => `[${providerName}] Attempting manual ASS/SSA fallback parser for ${filename}`);
    try {
        const manual = manualAssToVtt(content);
        if (manual && manual.trim().length > 0) {
            log.debug(() => `[${providerName}] Manual parser succeeded: ${filename} -> VTT (${manual.length} chars)`);
            return manual;
        }
        log.warn(() => `[${providerName}] Manual parser returned empty result`);
    } catch (fallbackErr) {
        log.error(() => [`[${providerName}] Manual ASS/SSA fallback failed:`, fallbackErr.message]);
        log.debug(() => `[${providerName}] Manual parser stack: ${fallbackErr.stack}`);
    }

    // All conversion methods failed - return informational subtitle instead of garbage
    log.warn(() => `[${providerName}] All conversion methods failed for ${filename} (${contentLength} chars)`);

    // Detect specific unsupported formats for better messaging
    const ext = lower.split('.').pop();
    if (ext === 'idx') {
        return createUnsupportedFormatSubtitle(providerName, 'VobSub Index (.idx)', filename, 'This is a VobSub index file, not a text subtitle.');
    }
    if (ext === 'sup') {
        return createUnsupportedFormatSubtitle(providerName, 'PGS/SUP (.sup)', filename, 'This is a Blu-ray image-based subtitle.\nIt cannot be converted to text.');
    }

    // Check if content looks like binary (high ratio of non-printable chars)
    const nonPrintable = (content.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || []).length;
    const isBinary = contentLength > 0 && (nonPrintable / contentLength) > 0.1;
    if (isBinary) {
        return createUnsupportedFormatSubtitle(providerName, `Unknown binary format (.${ext})`, filename, 'This subtitle appears to be in an image-based or binary format.');
    }

    // Generic conversion failure
    return createUnsupportedFormatSubtitle(providerName, `${ext.toUpperCase()} format`, filename, 'Could not convert this subtitle to a displayable format.');
}

/**
 * Manual ASS/SSA to VTT converter (fallback)
 * @param {string} input - ASS/SSA content
 * @returns {string|null}
 */
function manualAssToVtt(input) {
    if (!input || !/\[events\]/i.test(input)) return null;

    const lines = input.split(/\r?\n/);
    let format = [];
    let inEvents = false;

    for (const line of lines) {
        const l = line.trim();
        if (/^\[events\]/i.test(l)) {
            inEvents = true;
            continue;
        }
        if (!inEvents) continue;
        if (/^\[.*\]/.test(l)) break;
        if (/^format\s*:/i.test(l)) {
            format = l.split(':')[1].split(',').map(s => s.trim().toLowerCase());
        }
    }

    const idxStart = Math.max(0, format.indexOf('start'));
    const idxEnd = Math.max(1, format.indexOf('end'));
    const idxText = format.length > 0 ? Math.max(format.indexOf('text'), format.length - 1) : 9;

    const out = ['WEBVTT', ''];

    const parseTime = (t) => {
        const m = t.trim().match(/(\d+):(\d{2}):(\d{2})[\.\:](\d{2})/);
        if (!m) return null;
        const h = parseInt(m[1], 10) || 0;
        const mi = parseInt(m[2], 10) || 0;
        const s = parseInt(m[3], 10) || 0;
        const cs = parseInt(m[4], 10) || 0;
        const ms = (h * 3600 + mi * 60 + s) * 1000 + cs * 10;
        const hh = String(Math.floor(ms / 3600000)).padStart(2, '0');
        const mm = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
        const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
        const mmm = String(ms % 1000).padStart(3, '0');
        return `${hh}:${mm}:${ss}.${mmm}`;
    };

    const cleanText = (txt) => {
        let t = txt.replace(/\{[^}]*\}/g, '');
        t = t.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ');
        t = t.replace(/[\u0000-\u001F]/g, '');
        return t.trim();
    };

    for (const line of lines) {
        if (!/^dialogue\s*:/i.test(line)) continue;
        const payload = line.split(':').slice(1).join(':');
        const parts = [];
        let cur = '';
        let splits = 0;
        for (let i = 0; i < payload.length; i++) {
            const ch = payload[i];
            if (ch === ',' && splits < Math.max(idxText, 9)) {
                parts.push(cur);
                cur = '';
                splits++;
            } else {
                cur += ch;
            }
        }
        parts.push(cur);
        const st = parseTime(parts[idxStart]);
        const et = parseTime(parts[idxEnd]);
        if (!st || !et) continue;
        const ct = cleanText(parts[idxText] ?? '');
        if (!ct) continue;
        out.push(`${st} --> ${et}`);
        out.push(ct);
        out.push('');
    }

    return out.length > 2 ? out.join('\n') : null;
}

/**
 * Extract subtitle content from an archive buffer
 * @param {Buffer} buffer - Archive buffer (ZIP, RAR, Gzip, 7z, Tar, etc.)
 * @param {Object} options - Extraction options
 * @param {string} options.providerName - Provider name for logging
 * @param {number} options.maxBytes - Maximum archive size in bytes
 * @param {boolean} options.isSeasonPack - Whether this is a season pack
 * @param {number} options.season - Season number (for season packs)
 * @param {number} options.episode - Episode number (for season packs)
 * @param {boolean} options.skipAssConversion - If true, return ASS/SSA as-is without conversion
 * @param {Object} options.archiveLimits - Optional per-call safety limits (primarily for tests/self-host customization)
 * @returns {Promise<string|{content: string, format: string}>} - Extracted subtitle content or object with format
 */
async function extractSubtitleFromArchive(buffer, options = {}) {
    const {
        providerName = 'Archive',
        maxBytes = 25 * 1024 * 1024,
        isSeasonPack = false,
        season = null,
        episode = null,
        languageHint = null,
        skipAssConversion = false,
        _archiveDepth = 0
    } = options;
    const archiveLimits = resolveArchiveLimits(options);
    let archiveDepth = _archiveDepth;
    const maxCompressionOutputBytes = Math.min(
        maxBytes,
        archiveLimits.maxEntryBytes,
        archiveLimits.maxTotalBytes
    );

    log.debug(() => `[${providerName}] extractSubtitleFromArchive: starting (buffer=${buffer?.length || 0} bytes, isSeasonPack=${isSeasonPack}, season=${season}, episode=${episode})`);

    // Validate buffer
    if (!buffer || buffer.length === 0) {
        log.error(() => `[${providerName}] extractSubtitleFromArchive: empty or null buffer received`);
        throw new Error('Empty archive buffer received');
    }

    // Enforce the compressed/input limit before format probing. In particular,
    // Brotli trial decompression must never run on a response that has already
    // exceeded the caller's established download ceiling.
    if (buffer.length > maxBytes) {
        const sizeMB = (buffer.length / (1024 * 1024)).toFixed(2);
        const limitMB = (maxBytes / (1024 * 1024)).toFixed(2);
        log.warn(() => `[${providerName}] Archive too large: ${sizeMB} MB > ${limitMB} MB limit`);
        return createArchiveTooLargeSubtitle(maxBytes, buffer.length);
    }

    if (archiveDepth > archiveLimits.maxDepth) {
        return createArchiveSafetyLimitSubtitle(new ArchiveLimitError(
            'recursion depth',
            archiveLimits.maxDepth,
            archiveDepth
        ));
    }

    // Detect archive type
    let archiveType = detectArchiveType(buffer);
    if (!archiveType) {
        if (archiveDepth >= archiveLimits.maxDepth) {
            return createArchiveSafetyLimitSubtitle(new ArchiveLimitError(
                'recursion depth',
                archiveLimits.maxDepth,
                archiveDepth + 1
            ));
        }
        // Try Brotli decompression as last resort (no reliable magic bytes)
        try {
            log.debug(() => `[${providerName}] No archive signature detected, trying Brotli decompression...`);
            const compressedBytes = buffer.length;
            const decompressed = await decompressBrotli(buffer, maxCompressionOutputBytes);
            if (decompressed && decompressed.length > 0) {
                assertCompressionRatio(compressedBytes, decompressed.length, archiveLimits);
                const innerType = detectArchiveType(decompressed);
                if (innerType) {
                    archiveDepth++;
                    if (archiveDepth > archiveLimits.maxDepth) {
                        return createArchiveSafetyLimitSubtitle(new ArchiveLimitError(
                            'recursion depth',
                            archiveLimits.maxDepth,
                            archiveDepth
                        ));
                    }
                    log.debug(() => `[${providerName}] Brotli decompressed to ${innerType.toUpperCase()} (${decompressed.length} bytes)`);
                    buffer = decompressed;
                    archiveType = innerType;
                }
            }
        } catch (err) {
            if (err?.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof ArchiveLimitError) {
                return createArchiveSafetyLimitSubtitle(
                    err instanceof ArchiveLimitError
                        ? err
                        : new ArchiveLimitError('expanded bytes', maxCompressionOutputBytes, maxCompressionOutputBytes + 1)
                );
            }
            // Not Brotli — continue to error
        }

        if (!archiveType) {
            const hexBytes = buffer.slice(0, Math.min(20, buffer.length)).toString('hex').match(/.{2}/g)?.join(' ') || '';
            log.error(() => `[${providerName}] Not a valid archive file. First 20 bytes: ${hexBytes}`);
            throw new Error('Not a valid archive file (not a recognized archive format)');
        }
    }

    log.debug(() => `[${providerName}] Archive type: ${archiveType.toUpperCase()}, size: ${buffer.length} bytes`);

    // Handle compression-only formats (gzip, bz2, xz) by decompressing first,
    // then re-detecting the inner content (may be tar, another archive, or plain subtitle)
    if (archiveType === 'gzip' || archiveType === 'bz2' || archiveType === 'xz') {
        if (archiveDepth >= archiveLimits.maxDepth) {
            return createArchiveSafetyLimitSubtitle(new ArchiveLimitError(
                'recursion depth',
                archiveLimits.maxDepth,
                archiveDepth + 1
            ));
        }
        try {
            let decompressed;
            const compressedBytes = buffer.length;
            if (archiveType === 'gzip') {
                decompressed = await decompressGzip(buffer, maxCompressionOutputBytes);
            } else if (archiveType === 'bz2') {
                decompressed = await decompressBzip2(buffer);
            } else {
                decompressed = await decompressXz(buffer);
            }

            assertExpandedBuffer(decompressed, archiveLimits);
            assertCompressionRatio(compressedBytes, decompressed.length, archiveLimits);

            // Check size limit on decompressed content
            if (decompressed.length > maxBytes) {
                log.warn(() => `[${providerName}] Decompressed content too large: ${(decompressed.length / (1024 * 1024)).toFixed(2)} MB`);
                return createArchiveTooLargeSubtitle(maxBytes, decompressed.length);
            }

            // Re-detect the inner content type
            const innerType = detectArchiveType(decompressed);
            if (innerType) {
                log.debug(() => `[${providerName}] ${archiveType.toUpperCase()} decompressed to ${innerType.toUpperCase()} archive, extracting recursively...`);
                // Recursively extract the inner archive (e.g., tar.gz → tar → files)
                return await extractSubtitleFromArchive(decompressed, {
                    ...options,
                    _archiveDepth: archiveDepth + 1
                });
            }

            // Not an archive — treat as plain subtitle content
            log.debug(() => `[${providerName}] ${archiveType.toUpperCase()} decompressed to plain content (${decompressed.length} bytes)`);
            const content = detectAndConvertEncoding(decompressed, providerName, languageHint);
            if (content && content.trim().length > 0) {
                return content;
            }
            throw new Error(`${archiveType.toUpperCase()} decompressed content is empty`);
        } catch (err) {
            if (err?.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof ArchiveLimitError) {
                return createArchiveSafetyLimitSubtitle(
                    err instanceof ArchiveLimitError
                        ? err
                        : new ArchiveLimitError('expanded bytes', maxCompressionOutputBytes, maxCompressionOutputBytes + 1)
                );
            }
            if (err.message && (err.message.includes('not available') || err.message.includes('not installed'))) {
                // Optional dependency not installed
                return createCorruptedArchiveSubtitle(providerName, archiveType);
            }
            log.error(() => [`[${providerName}] ${archiveType.toUpperCase()} decompression failed:`, err.message]);
            return createCorruptedArchiveSubtitle(providerName, archiveType);
        }
    }

    let entries = [];
    let archive = null;
    let filesMap = null;

    // Extract archive
    try {
        log.debug(() => `[${providerName}] Extracting ${archiveType.toUpperCase()} archive...`);

        if (archiveType === 'zip') {
            const result = await extractZip(buffer, archiveLimits);
            archive = result.zip;
            entries = result.entries;
        } else if (archiveType === 'rar') {
            const result = await extractRar(buffer, {
                isSeasonPack,
                season,
                episode,
                skipAssConversion
            }, archiveLimits);
            filesMap = result.files;
            entries = result.entries;
        } else if (archiveType === '7z') {
            const result = await extract7z(buffer, archiveLimits);
            filesMap = result.files;
            entries = result.entries;
        } else if (archiveType === 'tar') {
            const result = await extractTar(buffer, archiveLimits);
            filesMap = result.files;
            entries = result.entries;
        }

        log.debug(() => `[${providerName}] Successfully extracted ${entries.length} file entries`);
    } catch (err) {
        if (err instanceof ArchiveLimitError || err?.code === 'ARCHIVE_LIMIT_EXCEEDED') {
            log.warn(() => `[${providerName}] Archive rejected by ${err.reason || 'safety'} limit`);
            return createArchiveSafetyLimitSubtitle(err);
        }
        log.error(() => [`[${providerName}] Failed to parse ${archiveType.toUpperCase()} archive:`, err.message]);
        log.error(() => `[${providerName}] Archive parse error stack: ${err.stack}`);
        return createCorruptedArchiveSubtitle(providerName, archiveType);
    }

    if (entries.length === 0) {
        log.error(() => `[${providerName}] Archive is empty - no files found`);
        throw new Error('Archive is empty');
    }

    // Find target subtitle file
    log.debug(() => `[${providerName}] Searching for subtitle file in ${entries.length} entries...`);
    const { filename, isSrt } = findSubtitleFile(entries, { isSeasonPack, season, episode, skipAssConversion });

    if (!filename) {
        if (isSeasonPack && season && episode) {
            log.warn(() => `[${providerName}] Episode S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')} not found in archive`);
            log.warn(() => `[${providerName}] Available files: ${entries.join(', ')}`);
            return createEpisodeNotFoundSubtitle(episode, season, entries);
        }
        log.error(() => `[${providerName}] No subtitle file found in archive`);
        log.error(() => `[${providerName}] Available entries: ${entries.join(', ')}`);
        throw new Error('No subtitle file found in archive');
    }

    log.debug(() => `[${providerName}] Selected subtitle file: ${filename} (isSrt=${isSrt})`);

    // Read file content
    let fileBuffer;
    try {
        if (archiveType === 'zip') {
            log.debug(() => `[${providerName}] Reading ${filename} from ZIP...`);
            fileBuffer = await archive.files[filename].async('nodebuffer');
        } else if (archiveType === 'rar' || archiveType === '7z' || archiveType === 'tar') {
            log.debug(() => `[${providerName}] Reading ${filename} from ${archiveType.toUpperCase()}...`);
            fileBuffer = filesMap.get(filename);
        }
    } catch (readErr) {
        log.error(() => [`[${providerName}] Failed to read file from archive:`, readErr.message]);
        log.error(() => `[${providerName}] Read error stack: ${readErr.stack}`);
        throw new Error(`Failed to read ${filename} from archive: ${readErr.message}`);
    }

    if (!fileBuffer || fileBuffer.length === 0) {
        log.error(() => `[${providerName}] File buffer is empty for ${filename}`);
        throw new Error(`Failed to read ${filename} from archive - file is empty`);
    }

    try {
        assertExpandedBuffer(fileBuffer, archiveLimits);
    } catch (err) {
        if (err instanceof ArchiveLimitError) {
            return createArchiveSafetyLimitSubtitle(err);
        }
        throw err;
    }

    log.debug(() => `[${providerName}] Read ${fileBuffer.length} bytes from ${filename}`);

    // Handle SRT files with encoding detection
    if (isSrt) {
        log.debug(() => `[${providerName}] Processing SRT file with encoding detection...`);
        const content = detectAndConvertEncoding(fileBuffer, providerName, languageHint);
        log.debug(() => `[${providerName}] Extracted SRT: ${filename} (${content.length} chars)`);
        return content;
    }

    // Handle other formats with BOM-aware decoding and conversion
    log.debug(() => `[${providerName}] Processing non-SRT file with BOM-aware decoding...`);
    const raw = decodeWithBomAwareness(fileBuffer, providerName, languageHint);
    log.debug(() => `[${providerName}] Decoded content: ${raw.length} chars, converting to VTT...`);

    const result = await convertSubtitleToVtt(raw, filename, providerName, { skipAssConversion });
    // Handle both string returns (VTT) and object returns (original ASS/SSA)
    if (typeof result === 'object' && result.content) {
        log.debug(() => `[${providerName}] Final result: ${result.content.length} chars, format: ${result.format}`);
    } else {
        log.debug(() => `[${providerName}] Final result: ${result.length} chars`);
    }
    return result;
}

module.exports = {
    detectArchiveType,
    isArchive,
    extractSubtitleFromArchive,
    createArchiveTooLargeSubtitle,
    createArchiveSafetyLimitSubtitle,
    createZipTooLargeSubtitle: createArchiveTooLargeSubtitle, // Alias for backward compatibility
    createEpisodeNotFoundSubtitle,
    createCorruptedArchiveSubtitle,
    createUnsupportedFormatSubtitle,
    findSubtitleFile,
    findEpisodeFile,
    findEpisodeFileAnime,
    convertSubtitleToVtt,
    decodeWithBomAwareness,
    manualAssToVtt,
    decompressGzip,
    decompressBrotli,
    extract7z,
    extractTar,
    ArchiveLimitError,
    DEFAULT_ARCHIVE_LIMITS
};
