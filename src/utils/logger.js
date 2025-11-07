/**
 * Global logger utility that wraps console methods to add timestamps
 * This intercepts all console.log, console.error, and console.warn calls
 * and automatically prepends ISO timestamps without modifying existing code
 *
 * Log levels (set via LOG_LEVEL env var):
 * - 'debug' (default): Show all logs (console.log, warn, error)
 * - 'warn': Show only warnings and errors
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

// Log level configuration
const LOG_LEVEL = (process.env.LOG_LEVEL || 'debug').toLowerCase();
const LEVELS = { debug: 0, warn: 1, error: 2 };
const currentLevel = LEVELS[LOG_LEVEL] !== undefined ? LEVELS[LOG_LEVEL] : LEVELS.debug;

// Optional file logging with rotation/purge (enabled by default in production)
const fs = require('fs');
const path = require('path');

const LOG_TO_FILE = (process.env.LOG_TO_FILE === 'true') || (process.env.NODE_ENV === 'production' && process.env.LOG_TO_FILE !== 'false');
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs');
const LOG_BASENAME = process.env.LOG_BASENAME || 'app.log';
const LOG_MAX_SIZE_BYTES = (() => {
    const byBytes = Number(process.env.LOG_MAX_SIZE_BYTES || '');
    if (Number.isFinite(byBytes) && byBytes > 0) return byBytes;
    const byMb = Number(process.env.LOG_MAX_SIZE_MB || '');
    if (Number.isFinite(byMb) && byMb > 0) return Math.floor(byMb * 1024 * 1024);
    return 10 * 1024 * 1024; // 10 MB default
})();
const LOG_MAX_FILES = Math.max(1, Number(process.env.LOG_MAX_FILES || 100));
const LOG_MAX_AGE_DAYS = Math.max(1, Number(process.env.LOG_MAX_AGE_DAYS || 14));
const LOG_MAX_TOTAL_BYTES = (() => {
    const v = Number(process.env.LOG_MAX_TOTAL_BYTES || '');
    if (Number.isFinite(v) && v > 0) return v;
    return Math.max(LOG_MAX_SIZE_BYTES * LOG_MAX_FILES, 50 * 1024 * 1024); // at least 50MB or size*files
})();

let logStream = null;
let currentLogSize = 0;
let rotating = false;

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
        logStream = fs.createWriteStream(filePath, { flags: 'a' });
    } catch (_) {
        logStream = null;
        currentLogSize = 0;
    }
}

function closeStream() {
    try { if (logStream) logStream.end(); } catch (_) {}
    logStream = null;
}

function rotateLogs() {
    if (rotating) return;
    rotating = true;
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
}

function purgeOldLogs() {
    try {
        const files = fs.readdirSync(LOG_DIR)
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

        // Remove by age
        const cutoff = Date.now() - LOG_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
        for (const file of files) {
            if (file.mtimeMs < cutoff && file.name !== LOG_BASENAME) {
                try { fs.unlinkSync(file.path); } catch (_) {}
            }
        }

        // Enforce total size cap
        const remaining = fs.readdirSync(LOG_DIR)
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
            .filter(Boolean)
            .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

        let total = remaining.reduce((sum, f) => sum + f.size, 0);
        for (let i = remaining.length - 1; i >= 0 && total > LOG_MAX_TOTAL_BYTES; i--) {
            const file = remaining[i];
            if (file.name === LOG_BASENAME) continue; // do not delete current log
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

function serializeArg(arg) {
    if (arg === null) return 'null';
    if (arg === undefined) return 'undefined';
    if (typeof arg === 'string') return arg;
    if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
    try { return JSON.stringify(arg); } catch (_) {
        try { return String(arg); } catch (_) { return '[Unserializable]'; }
    }
}

function writeFileLog(level, args) {
    if (!LOG_TO_FILE) return;
    const line = `[${getTimestamp()}] [${level}] ` + args.map(serializeArg).join(' ');
    const bytes = Buffer.byteLength(line + '\n');
    try {
        maybeRotate(bytes);
        if (logStream) {
            logStream.write(line + '\n');
            currentLogSize += bytes;
        }
    } catch (_) {
        // ignore file write errors
    }
}

// Periodic purge (every 6 hours)
if (LOG_TO_FILE) {
    ensureLogDir();
    openStream();
    try { purgeOldLogs(); } catch (_) {}
    setInterval(() => { try { purgeOldLogs(); } catch (_) {} }, 1000 * 60 * 60 * 6);
    // Close stream on exit
    const shutdown = () => { try { closeStream(); } catch (_) {} };
    process.on('exit', shutdown);
    process.on('SIGINT', () => { shutdown(); process.exit(0); });
    process.on('SIGTERM', () => { shutdown(); process.exit(0); });
}

/**
 * Wrapper for console.log that prepends timestamp
 */
console.log = function(...args) {
    if (currentLevel <= LEVELS.debug) {
        originalLog(`[${getTimestamp()}]`, ...args);
        writeFileLog('INFO', args);
    }
};

/**
 * Wrapper for console.error that prepends timestamp
 */
console.error = function(...args) {
    if (currentLevel <= LEVELS.error) {
        originalError(`[${getTimestamp()}]`, ...args);
        writeFileLog('ERROR', args);
    }
};

/**
 * Wrapper for console.warn that prepends timestamp
 */
console.warn = function(...args) {
    if (currentLevel <= LEVELS.warn) {
        originalWarn(`[${getTimestamp()}]`, ...args);
        writeFileLog('WARN', args);
    }
};

module.exports = {};
