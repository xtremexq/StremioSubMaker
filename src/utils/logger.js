/**
 * High-performance global logger utility with lazy evaluation and async file logging
 *
 * Key Performance Features:
 * - Lazy evaluation: Logs only evaluate when level is enabled (prevents wasted CPU)
 * - Async file logging: Non-blocking writes with proper buffering
 * - Log sampling: Reduce log volume under high load
 * - Zero-cost when disabled: Level checks happen BEFORE any string operations
 *
 * Log levels (set via LOG_LEVEL env var):
 * - 'debug': Show all logs (console.log, warn, error)
 * - 'warn' (default): Show only warnings and errors
 * - 'error': Show only errors
 */

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

/**
 * Get current ISO timestamp for logging
 * @returns {string} ISO timestamp string (e.g., "2024-11-06T15:30:45.123Z")
 */
const getTimestamp = () => new Date().toISOString();

// Log level configuration (default to 'warn' for production)
const LOG_LEVEL = (process.env.LOG_LEVEL || 'warn').toLowerCase();
const LEVELS = { debug: 0, warn: 1, error: 2 };
const currentLevel = LEVELS[LOG_LEVEL] !== undefined ? LEVELS[LOG_LEVEL] : LEVELS.warn;

// Log sampling configuration (for high-load scenarios)
const LOG_SAMPLE_RATE = Math.max(0, Math.min(1, Number(process.env.LOG_SAMPLE_RATE) || 1)); // 0.0 to 1.0, default 1.0 (no sampling)
const LOG_SAMPLE_DEBUG_ONLY = process.env.LOG_SAMPLE_DEBUG_ONLY === 'true'; // Only sample debug logs
let logCounter = 0;

/**
 * Check if a log should be sampled (allowed to pass through)
 * @param {string} level - Log level (debug, warn, error)
 * @returns {boolean} True if log should be output
 */
function shouldSample(level) {
    if (LOG_SAMPLE_RATE >= 1) return true; // No sampling
    if (LOG_SAMPLE_DEBUG_ONLY && level !== 'debug') return true; // Only sample debug logs

    // Simple counter-based sampling (deterministic and fast)
    logCounter++;
    return (logCounter % Math.ceil(1 / LOG_SAMPLE_RATE)) === 0;
}

// Optional file logging with rotation/purge (enabled by default in production)
// NOTE: Application logs ALWAYS use filesystem, regardless of STORAGE_TYPE setting
// STORAGE_TYPE (redis/filesystem) only controls where CACHE data is stored
// Logs and cache are separate concerns - logs need disk for rotation/debugging
const fs = require('fs');
const path = require('path');

const LOG_TO_FILE = process.env.LOG_TO_FILE !== 'false'; // Enabled by default, disable with LOG_TO_FILE=false
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs');
const LOG_BASENAME = process.env.LOG_BASENAME || 'app.log';
const LOG_MAX_SIZE_BYTES = (() => {
    const byBytes = Number(process.env.LOG_MAX_SIZE_BYTES || '');
    if (Number.isFinite(byBytes) && byBytes > 0) return byBytes;
    const byMb = Number(process.env.LOG_MAX_SIZE_MB || '');
    if (Number.isFinite(byMb) && byMb > 0) return Math.floor(byMb * 1024 * 1024);
    return 10 * 1024 * 1024; // 10 MB default
})();
const LOG_MAX_FILES = Math.max(1, Number(process.env.LOG_MAX_FILES || 10));
const LOG_MAX_AGE_DAYS = Math.max(1, Number(process.env.LOG_MAX_AGE_DAYS || 7));
const LOG_MAX_TOTAL_BYTES = (() => {
    const v = Number(process.env.LOG_MAX_TOTAL_BYTES || '');
    if (Number.isFinite(v) && v > 0) return v;
    return Math.max(LOG_MAX_SIZE_BYTES * LOG_MAX_FILES, 50 * 1024 * 1024); // at least 50MB or size*files
})();

// Async file logging with buffering
let logStream = null;
let currentLogSize = 0;
let rotating = false;
let writeBuffer = [];
let flushTimer = null;
const FLUSH_INTERVAL_MS = 1000; // Flush buffer every 1 second
const MAX_BUFFER_SIZE = 100; // Flush buffer after 100 entries

function ensureLogDir() {
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    } catch (_) {
        // Ignore directory creation errors to avoid crashing app
    }
}

function currentLogPath() {
    return path.join(LOG_DIR, LOG_BASENAME);
}

function openStream() {
    try {
        ensureLogDir();
        const filePath = currentLogPath();
        try {
            const stats = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
            currentLogSize = stats ? stats.size : 0;
        } catch (_) {
            currentLogSize = 0;
        }
        // Use high water mark for better buffering performance
        logStream = fs.createWriteStream(filePath, {
            flags: 'a',
            highWaterMark: 64 * 1024 // 64KB buffer
        });
    } catch (_) {
        logStream = null;
        currentLogSize = 0;
    }
}

function closeStream() {
    try {
        if (logStream) {
            logStream.end();
            logStream = null;
        }
    } catch (_) {}
}

/**
 * Flush the write buffer to disk asynchronously
 */
function flushBuffer() {
    if (!logStream || writeBuffer.length === 0) return;

    try {
        const lines = writeBuffer.join('');
        writeBuffer = [];

        // Async write - non-blocking!
        logStream.write(lines, (err) => {
            if (err) {
                // Silent failure - don't crash the app for logging errors
            }
        });

        currentLogSize += Buffer.byteLength(lines);
    } catch (_) {
        writeBuffer = [];
    }
}

/**
 * Schedule a buffer flush
 */
function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushBuffer();
    }, FLUSH_INTERVAL_MS);
}

/**
 * Rotate logs asynchronously to avoid blocking
 */
function rotateLogs() {
    if (rotating) return;
    rotating = true;

    // Flush any pending writes before rotating
    flushBuffer();
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }

    // Use setImmediate to avoid blocking the event loop
    setImmediate(() => {
        try {
            closeStream();
            // Shift older files: app.log.(n-1) -> app.log.n
            for (let i = LOG_MAX_FILES - 1; i >= 1; i--) {
                const src = path.join(LOG_DIR, `${LOG_BASENAME}.${i}`);
                const dst = path.join(LOG_DIR, `${LOG_BASENAME}.${i + 1}`);
                try {
                    if (fs.existsSync(src)) {
                        try { fs.unlinkSync(dst); } catch (_) {}
                        fs.renameSync(src, dst);
                    }
                } catch (_) { /* continue */ }
            }
            // app.log -> app.log.1
            const mainPath = currentLogPath();
            const rotatedPath = path.join(LOG_DIR, `${LOG_BASENAME}.1`);
            try { fs.unlinkSync(rotatedPath); } catch (_) {}
            try {
                if (fs.existsSync(mainPath)) fs.renameSync(mainPath, rotatedPath);
            } catch (_) {}
        } finally {
            openStream();
            currentLogSize = 0;
            rotating = false;
            try { purgeOldLogs(); } catch (_) {}
        }
    });
}

function purgeOldLogs() {
    try {
        // Single directory scan - optimized for efficiency
        let files = fs.readdirSync(LOG_DIR)
            .filter(f => f === LOG_BASENAME || f.startsWith(`${LOG_BASENAME}.`))
            .map(f => {
                const p = path.join(LOG_DIR, f);
                try {
                    const s = fs.statSync(p);
                    return { name: f, path: p, size: s.size, mtimeMs: s.mtimeMs };
                } catch (_) {
                    return null;
                }
            })
            .filter(Boolean);

        // Remove by age (filter out deleted files)
        const cutoff = Date.now() - LOG_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
        files = files.filter(file => {
            if (file.mtimeMs < cutoff && file.name !== LOG_BASENAME) {
                try {
                    fs.unlinkSync(file.path);
                    return false; // Remove from list
                } catch (_) {
                    return true; // Keep if deletion fails
                }
            }
            return true; // Keep non-expired files
        });

        // Enforce total size cap (sort newest first, delete oldest)
        files.sort((a, b) => b.mtimeMs - a.mtimeMs);
        let total = files.reduce((sum, f) => sum + f.size, 0);

        for (let i = files.length - 1; i >= 0 && total > LOG_MAX_TOTAL_BYTES; i--) {
            const file = files[i];
            if (file.name === LOG_BASENAME) continue; // Never delete current log
            try {
                fs.unlinkSync(file.path);
                total -= file.size;
            } catch (_) {}
        }
    } catch (_) {
        // ignore purge errors
    }
}

function maybeRotate(nextBytes) {
    if (!LOG_TO_FILE) return;
    if (!logStream) openStream();
    if (!logStream) return;
    if (currentLogSize + nextBytes > LOG_MAX_SIZE_BYTES) rotateLogs();
}

/**
 * Serialize an Error object with truncation to prevent ridiculously long logs
 * @param {Error} error - Error object to serialize
 * @param {number} maxStackLines - Maximum stack trace lines to include
 * @returns {string} - Serialized error string
 */
function serializeError(error, maxStackLines = 5) {
    const result = {
        message: error.message || 'Unknown error',
        name: error.name || 'Error'
    };

    // Add essential properties only
    if (error.code) result.code = error.code;
    if (error.statusCode) result.statusCode = error.statusCode;
    if (error.status) result.status = error.status;
    if (error.type) result.type = error.type;
    if (error.errno) result.errno = error.errno;
    if (error.syscall) result.syscall = error.syscall;

    // Truncate stack trace to prevent excessive log size
    if (error.stack) {
        const lines = error.stack.split('\n');
        if (lines.length <= maxStackLines) {
            result.stack = error.stack;
        } else {
            result.stack = lines.slice(0, maxStackLines).join('\n') +
                          `\n... (${lines.length - maxStackLines} more lines omitted)`;
        }
    }

    // DO NOT include: originalError, request, response, config, data, socket, etc.
    // These can contain massive objects (buffers, streams, circular refs)

    try {
        return JSON.stringify(result, null, 2);
    } catch (_) {
        return `[Error: ${result.message}]`;
    }
}

/**
 * Create a JSON replacer that prevents logging of large/circular objects
 * @param {number} maxDepth - Maximum object nesting depth
 * @param {number} maxStringLength - Maximum string length before truncation
 * @returns {Function} - JSON replacer function
 */
function createSafeReplacer(maxDepth = 3, maxStringLength = 500) {
    const seen = new WeakSet();
    let depth = 0;

    return function(key, value) {
        // Skip known problematic/large objects that bloat logs
        const skipKeys = [
            'request',      // Axios request object (huge)
            'socket',       // Network socket (circular)
            'agent',        // HTTP agent (circular)
            'originalError',// Can contain all of the above
            'config',       // Axios config (redundant)
            'data',         // Response data buffers (huge)
            'rawHeaders',   // Duplicate header data
            'req',          // Express request (huge)
            'res',          // Express response (circular)
            '_eventsCount', // Internal Node.js (noise)
            '_events',      // Internal Node.js (noise)
            'domain',       // Internal Node.js (noise)
            '_readableState', // Stream internals (huge)
            '_writableState'  // Stream internals (huge)
        ];

        if (skipKeys.includes(key)) {
            return '[Omitted]';
        }

        // Handle objects
        if (typeof value === 'object' && value !== null) {
            // Check for circular references
            if (seen.has(value)) {
                return '[Circular]';
            }
            seen.add(value);

            // Limit depth to prevent massive nested structures
            if (depth >= maxDepth) {
                return '[Max Depth Exceeded]';
            }
            depth++;
        }

        // Truncate long strings (like response bodies, large buffers)
        if (typeof value === 'string' && value.length > maxStringLength) {
            return value.substring(0, maxStringLength) +
                   `... (${value.length - maxStringLength} more characters)`;
        }

        // Truncate buffers
        if (Buffer.isBuffer(value)) {
            if (value.length > 100) {
                return `[Buffer ${value.length} bytes (truncated): ${value.slice(0, 100).toString('hex')}...]`;
            }
            return `[Buffer ${value.length} bytes: ${value.toString('hex')}]`;
        }

        return value;
    };
}

function serializeArg(arg) {
    if (arg === null) return 'null';
    if (arg === undefined) return 'undefined';
    if (typeof arg === 'string') return arg;
    if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);

    // Special handling for Error objects to prevent massive stack traces and circular refs
    if (arg instanceof Error) {
        return serializeError(arg);
    }

    try {
        // Use safe replacer to prevent logging huge objects or circular references
        return JSON.stringify(arg, createSafeReplacer(), 2);
    } catch (_) {
        try { return String(arg); } catch (_) { return '[Unserializable]'; }
    }
}

/**
 * Write to file log asynchronously with buffering
 */
function writeFileLog(level, args) {
    if (!LOG_TO_FILE) return;

    const line = `[${getTimestamp()}] [${level}] ` + args.map(serializeArg).join(' ') + '\n';
    const bytes = Buffer.byteLength(line);

    try {
        maybeRotate(bytes);
        if (logStream) {
            writeBuffer.push(line);

            // Flush immediately if buffer is full, otherwise schedule a flush
            if (writeBuffer.length >= MAX_BUFFER_SIZE) {
                if (flushTimer) {
                    clearTimeout(flushTimer);
                    flushTimer = null;
                }
                flushBuffer();
            } else {
                scheduleFlush();
            }
        }
    } catch (_) {
        // ignore file write errors
    }
}

// Logger shutdown function (exported for graceful shutdown coordination)
const shutdownLogger = () => {
    try {
        if (LOG_TO_FILE) {
            if (flushTimer) {
                clearTimeout(flushTimer);
                flushTimer = null;
            }
            flushBuffer(); // Flush any pending writes
            closeStream();
        }
    } catch (_) {}
};

// Periodic purge (every 1 hour)
if (LOG_TO_FILE) {
    ensureLogDir();
    openStream();
    try { purgeOldLogs(); } catch (_) {}
    setInterval(() => { try { purgeOldLogs(); } catch (_) {} }, 1000 * 60 * 60);

    // Close stream on normal process exit
    // NOTE: SIGINT/SIGTERM are handled by sessionManager for coordinated shutdown
    process.on('exit', shutdownLogger);
}

/**
 * PERFORMANCE-OPTIMIZED LOGGING FUNCTIONS
 * These functions accept callbacks to enable lazy evaluation
 * String operations only execute when the log level is enabled
 */

/**
 * Debug log with lazy evaluation
 * @param {Function|string} messageFn - Function that returns the message, or a plain string
 * Usage: log.debug(() => `[Module] Expensive: ${JSON.stringify(obj)}`)
 */
function debug(messageFn) {
    if (currentLevel > LEVELS.debug) return; // Early exit - zero cost!
    if (!shouldSample('debug')) return; // Sampling check

    const message = typeof messageFn === 'function' ? messageFn() : messageFn;
    const args = Array.isArray(message) ? message : [message];
    originalLog(`[${getTimestamp()}]`, ...args);
    writeFileLog('INFO', args);
}

/**
 * Info log with lazy evaluation
 * @param {Function|string} messageFn - Function that returns the message, or a plain string
 * Usage: log.info(() => `[Module] Info: ${data}`)
 */
function info(messageFn) {
    if (currentLevel > LEVELS.debug) return; // Info logs at debug level
    if (!shouldSample('debug')) return; // Sampling check

    const message = typeof messageFn === 'function' ? messageFn() : messageFn;
    const args = Array.isArray(message) ? message : [message];
    originalLog(`[${getTimestamp()}]`, ...args);
    writeFileLog('INFO', args);
}

/**
 * Warn log with lazy evaluation
 * @param {Function|string} messageFn - Function that returns the message, or a plain string
 * Usage: log.warn(() => `[Module] Warning: ${error}`)
 */
function warn(messageFn) {
    if (currentLevel > LEVELS.warn) return; // Early exit
    if (!shouldSample('warn')) return; // Sampling check

    const message = typeof messageFn === 'function' ? messageFn() : messageFn;
    const args = Array.isArray(message) ? message : [message];
    originalWarn(`[${getTimestamp()}]`, ...args);
    writeFileLog('WARN', args);
}

/**
 * Error log with lazy evaluation
 * @param {Function|string} messageFn - Function that returns the message, or a plain string
 * Usage: log.error(() => `[Module] Error: ${error.stack}`)
 */
function error(messageFn) {
    if (currentLevel > LEVELS.error) return; // Early exit
    if (!shouldSample('error')) return; // Sampling check

    const message = typeof messageFn === 'function' ? messageFn() : messageFn;
    const args = Array.isArray(message) ? message : [message];
    originalError(`[${getTimestamp()}]`, ...args);
    writeFileLog('ERROR', args);
}

/**
 * BACKWARD COMPATIBILITY: Console wrappers
 * These are kept for backward compatibility but still optimized
 * New code should use the lazy log.debug/info/warn/error functions above
 */

console.log = function(...args) {
    if (currentLevel <= LEVELS.debug && shouldSample('debug')) {
        originalLog(`[${getTimestamp()}]`, ...args);
        writeFileLog('INFO', args);
    }
};

console.error = function(...args) {
    if (currentLevel <= LEVELS.error && shouldSample('error')) {
        originalError(`[${getTimestamp()}]`, ...args);
        writeFileLog('ERROR', args);
    }
};

console.warn = function(...args) {
    if (currentLevel <= LEVELS.warn && shouldSample('warn')) {
        originalWarn(`[${getTimestamp()}]`, ...args);
        writeFileLog('WARN', args);
    }
};

/**
 * Special method for startup banner - always visible regardless of log level
 * This bypasses the log level filtering to ensure critical startup info is always shown
 */
console.startup = function(...args) {
    // Always show startup messages using originalLog (bypasses filtering)
    originalLog(...args);
    // Also write to file log
    writeFileLog('STARTUP', args);
};

// Export the high-performance lazy logging functions
module.exports = {
    debug,
    info,
    warn,
    error,
    shutdownLogger,
    // Legacy export for backward compatibility
    log: { debug, info, warn, error }
};
