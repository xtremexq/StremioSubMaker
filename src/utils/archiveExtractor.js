/**
 * Archive Extractor Utility
 * Handles extraction of subtitle files from ZIP and RAR archives
 */

const log = require('./logger');
const { detectAndConvertEncoding } = require('./encodingDetector');
const { appendHiddenInformationalNote } = require('./subtitle');

// Magic byte signatures for archive detection
const ARCHIVE_SIGNATURES = {
    ZIP: [0x50, 0x4B, 0x03, 0x04],  // PK..
    RAR4: [0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00],  // Rar!...  (RAR 4.x)
    RAR5: [0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00]  // Rar!.... (RAR 5.x)
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

    log.debug(() => `[ArchiveExtractor] Content is not an archive (plain subtitle file)`);
    return null;
}

/**
 * Check if buffer is a valid archive (ZIP or RAR)
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
 * @param {string} archiveType - Type of archive (zip/rar)
 * @returns {string}
 */
function createCorruptedArchiveSubtitle(providerName, archiveType) {
    const archiveName = archiveType === 'rar' ? 'RAR' : 'ZIP';
    const message = `1
00:00:00,000 --> 04:00:00,000
${providerName} download failed: Corrupted ${archiveName} file
The subtitle file appears to be damaged or incomplete.
Try selecting a different subtitle.`;
    return appendHiddenInformationalNote(message);
}

/**
 * Extract files from a RAR archive
 * @param {Buffer} buffer - RAR archive buffer
 * @returns {Promise<{files: Map<string, Buffer>, entries: string[]}>}
 */
async function extractRar(buffer) {
    log.debug(() => `[ArchiveExtractor] extractRar: starting RAR extraction (${buffer.length} bytes)`);

    const { createExtractorFromData } = require('node-unrar-js');
    const path = require('path');

    try {
        const extractor = await createExtractorFromData({ data: buffer });
        log.debug(() => `[ArchiveExtractor] extractRar: RAR extractor created successfully`);

        const list = extractor.getFileList();
        const fileHeaders = [...list.fileHeaders];
        log.debug(() => `[ArchiveExtractor] extractRar: found ${fileHeaders.length} total entries (including directories)`);

        const entries = fileHeaders
            .filter(h => !h.flags.directory)
            .map(h => h.name)
            .filter(name => {
                // Reject entries with path traversal sequences or absolute paths
                const normalized = name.replace(/\\/g, '/');
                if (normalized.includes('..') || path.isAbsolute(normalized) || normalized.startsWith('/')) {
                    log.warn(() => `[ArchiveExtractor] extractRar: skipping suspicious entry: ${name}`);
                    return false;
                }
                return true;
            });
        log.debug(() => `[ArchiveExtractor] extractRar: ${entries.length} files (excluding directories)`);

        if (entries.length > 0) {
            log.debug(() => `[ArchiveExtractor] extractRar: files in RAR: ${entries.slice(0, 10).join(', ')}${entries.length > 10 ? ` ... and ${entries.length - 10} more` : ''}`);
        }

        const safeEntrySet = new Set(entries);
        const extracted = extractor.extract();
        const files = new Map();
        let extractedCount = 0;

        for (const file of extracted.files) {
            if (file.extraction) {
                const entryName = file.fileHeader.name;
                // Only include entries that passed our safety filter
                if (!safeEntrySet.has(entryName)) {
                    log.warn(() => `[ArchiveExtractor] extractRar: skipping extraction of unsafe entry: ${entryName}`);
                    continue;
                }
                const fileBuffer = Buffer.from(file.extraction);
                files.set(entryName, fileBuffer);
                extractedCount++;
                log.debug(() => `[ArchiveExtractor] extractRar: extracted ${entryName} (${fileBuffer.length} bytes)`);
            }
        }

        log.debug(() => `[ArchiveExtractor] extractRar: successfully extracted ${extractedCount} files`);
        return { files, entries };
    } catch (err) {
        log.error(() => [`[ArchiveExtractor] extractRar: RAR extraction failed:`, err.message]);
        log.error(() => `[ArchiveExtractor] extractRar: stack trace: ${err.stack}`);
        throw err;
    }
}


/**
 * Extract files from a ZIP archive
 * @param {Buffer} buffer - ZIP archive buffer
 * @returns {Promise<{zip: JSZip, entries: string[]}>}
 */
async function extractZip(buffer) {
    log.debug(() => `[ArchiveExtractor] extractZip: starting ZIP extraction (${buffer.length} bytes)`);

    const JSZip = require('jszip');
    const path = require('path');

    try {
        const zip = await JSZip.loadAsync(buffer, { base64: false });
        const allEntries = Object.keys(zip.files);
        const entries = allEntries.filter(name => {
            if (zip.files[name].dir) return false;
            // Reject entries with path traversal sequences or absolute paths
            const normalized = name.replace(/\\/g, '/');
            if (normalized.includes('..') || path.isAbsolute(normalized) || normalized.startsWith('/')) {
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
        new RegExp(`s0*${season}\\.e0*${episode}(?:v\\d+)?`, 'i')
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
 * @returns {{filename: string|null, isSrt: boolean}}
 */
function findSubtitleFile(entries, options = {}) {
    const { isSeasonPack, season, episode } = options;

    log.debug(() => `[ArchiveExtractor] findSubtitleFile: searching ${entries.length} entries, isSeasonPack=${isSeasonPack}, season=${season}, episode=${episode}`);

    // Filter by extension type
    const srtFiles = entries.filter(f => f.toLowerCase().endsWith('.srt'));
    const altFiles = entries.filter(f => {
        const lower = f.toLowerCase();
        return lower.endsWith('.vtt') || lower.endsWith('.ass') || lower.endsWith('.ssa') || lower.endsWith('.sub');
    });

    log.debug(() => `[ArchiveExtractor] findSubtitleFile: found ${srtFiles.length} SRT files, ${altFiles.length} alternate format files`);

    if (isSeasonPack && season && episode) {
        log.debug(() => `[ArchiveExtractor] findSubtitleFile: searching for S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')} in season pack`);

        // Season pack: find specific episode
        // Try SRT files first with anime patterns, then TV patterns
        let target = findEpisodeFileAnime(srtFiles, episode);
        if (target) {
            log.debug(() => `[ArchiveExtractor] findSubtitleFile: found SRT via anime pattern: ${target}`);
            return { filename: target, isSrt: true };
        }

        target = findEpisodeFile(srtFiles, season, episode);
        if (target) {
            log.debug(() => `[ArchiveExtractor] findSubtitleFile: found SRT via TV pattern: ${target}`);
            return { filename: target, isSrt: true };
        }

        // Try any format with anime patterns, then TV patterns
        target = findEpisodeFileAnime(entries, episode);
        if (target) {
            log.debug(() => `[ArchiveExtractor] findSubtitleFile: found via anime pattern (any format): ${target}`);
            return { filename: target, isSrt: target.toLowerCase().endsWith('.srt') };
        }

        target = findEpisodeFile(entries, season, episode);
        if (target) {
            log.debug(() => `[ArchiveExtractor] findSubtitleFile: found via TV pattern (any format): ${target}`);
            return { filename: target, isSrt: target.toLowerCase().endsWith('.srt') };
        }

        log.warn(() => `[ArchiveExtractor] findSubtitleFile: episode not found in season pack. Available files: ${entries.join(', ')}`);
        return { filename: null, isSrt: false };
    } else {
        // Not a season pack: find first subtitle file
        if (srtFiles.length > 0) {
            log.debug(() => `[ArchiveExtractor] findSubtitleFile: using first SRT: ${srtFiles[0]}`);
            return { filename: srtFiles[0], isSrt: true };
        }
        if (altFiles.length > 0) {
            log.debug(() => `[ArchiveExtractor] findSubtitleFile: using first alternate format: ${altFiles[0]}`);
            return { filename: altFiles[0], isSrt: false };
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
 * @returns {Promise<string>}
 */
async function convertSubtitleToVtt(content, filename, providerName) {
    const lower = filename.toLowerCase();
    const contentLength = content?.length || 0;

    log.debug(() => `[${providerName}] convertSubtitleToVtt: converting ${filename} (${contentLength} chars)`);

    // Strip UTF-8 BOM if present
    if (content && typeof content === 'string') {
        const hadBom = content.charCodeAt(0) === 0xFEFF;
        content = content.replace(/^\uFEFF/, '');
        if (hadBom) log.debug(() => `[${providerName}] Stripped UTF-8 BOM from ${filename}`);
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
    log.debug(() => `[${providerName}] Attempting subsrt-ts conversion for ${filename}`);
    try {
        const subsrt = require('subsrt-ts');
        let converted;
        if (lower.endsWith('.ass')) {
            converted = subsrt.convert(content, { to: 'vtt', from: 'ass' });
        } else if (lower.endsWith('.ssa')) {
            converted = subsrt.convert(content, { to: 'vtt', from: 'ssa' });
        } else {
            converted = subsrt.convert(content, { to: 'vtt' });
        }

        if (!converted || typeof converted !== 'string' || converted.trim().length === 0) {
            log.debug(() => `[${providerName}] subsrt-ts returned empty, trying with sanitized content (removing null chars)`);
            const sanitized = (content || '').replace(/\u0000/g, '');
            if (sanitized && sanitized !== content) {
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
            log.debug(() => `[${providerName}] subsrt-ts conversion succeeded: ${filename} -> VTT (${converted.length} chars)`);
            return converted;
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

    // Return original content as last resort
    log.warn(() => `[${providerName}] All conversion methods failed for ${filename}, returning raw content (${contentLength} chars)`);
    return content;
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
 * @param {Buffer} buffer - Archive buffer (ZIP or RAR)
 * @param {Object} options - Extraction options
 * @param {string} options.providerName - Provider name for logging
 * @param {number} options.maxBytes - Maximum archive size in bytes
 * @param {boolean} options.isSeasonPack - Whether this is a season pack
 * @param {number} options.season - Season number (for season packs)
 * @param {number} options.episode - Episode number (for season packs)
 * @returns {Promise<string>} - Extracted subtitle content
 */
async function extractSubtitleFromArchive(buffer, options = {}) {
    const {
        providerName = 'Archive',
        maxBytes = 25 * 1024 * 1024,
        isSeasonPack = false,
        season = null,
        episode = null,
        languageHint = null
    } = options;

    log.debug(() => `[${providerName}] extractSubtitleFromArchive: starting (buffer=${buffer?.length || 0} bytes, isSeasonPack=${isSeasonPack}, season=${season}, episode=${episode})`);

    // Validate buffer
    if (!buffer || buffer.length === 0) {
        log.error(() => `[${providerName}] extractSubtitleFromArchive: empty or null buffer received`);
        throw new Error('Empty archive buffer received');
    }

    // Detect archive type
    const archiveType = detectArchiveType(buffer);
    if (!archiveType) {
        // Log first bytes for debugging
        const hexBytes = buffer.slice(0, Math.min(20, buffer.length)).toString('hex').match(/.{2}/g)?.join(' ') || '';
        log.error(() => `[${providerName}] Not a valid archive file. First 20 bytes: ${hexBytes}`);
        throw new Error('Not a valid archive file (neither ZIP nor RAR)');
    }

    log.debug(() => `[${providerName}] Archive type: ${archiveType.toUpperCase()}, size: ${buffer.length} bytes`);

    // Check size limit
    if (buffer.length > maxBytes) {
        const sizeMB = (buffer.length / (1024 * 1024)).toFixed(2);
        const limitMB = (maxBytes / (1024 * 1024)).toFixed(2);
        log.warn(() => `[${providerName}] Archive too large: ${sizeMB} MB > ${limitMB} MB limit`);
        return createArchiveTooLargeSubtitle(maxBytes, buffer.length);
    }

    let entries = [];
    let archive = null;
    let filesMap = null;

    // Extract archive
    try {
        log.debug(() => `[${providerName}] Extracting ${archiveType.toUpperCase()} archive...`);

        if (archiveType === 'zip') {
            const result = await extractZip(buffer);
            archive = result.zip;
            entries = result.entries;
        } else if (archiveType === 'rar') {
            const result = await extractRar(buffer);
            filesMap = result.files;
            entries = result.entries;
        }

        log.debug(() => `[${providerName}] Successfully extracted ${entries.length} file entries`);
    } catch (err) {
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
    const { filename, isSrt } = findSubtitleFile(entries, { isSeasonPack, season, episode });

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
        } else if (archiveType === 'rar') {
            log.debug(() => `[${providerName}] Reading ${filename} from RAR...`);
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

    const result = await convertSubtitleToVtt(raw, filename, providerName);
    log.debug(() => `[${providerName}] Final result: ${result.length} chars`);
    return result;
}

module.exports = {
    detectArchiveType,
    isArchive,
    extractSubtitleFromArchive,
    createArchiveTooLargeSubtitle,
    createZipTooLargeSubtitle: createArchiveTooLargeSubtitle, // Alias for backward compatibility
    createEpisodeNotFoundSubtitle,
    createCorruptedArchiveSubtitle,
    findSubtitleFile,
    findEpisodeFile,
    findEpisodeFileAnime,
    convertSubtitleToVtt,
    decodeWithBomAwareness,
    manualAssToVtt
};
