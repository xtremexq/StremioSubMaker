const { generateFileTranslationPage } = require('../utils/fileUploadPageGenerator');
const { getTranslator, loadLocale, DEFAULT_LANG } = require('../utils/i18n');

/**
 * Registers routes for the file-upload translation page.
 * This keeps the page-specific rendering logic out of index.js.
 */
function registerFileUploadRoutes(app, { log, resolveConfigGuarded, computeConfigHash, setNoStore, respondStorageUnavailable }) {
    if (!app) {
        throw new Error('Express app instance is required to register file upload routes');
    }
    if (!log || !resolveConfigGuarded || !computeConfigHash || !setNoStore) {
        throw new Error('Missing dependencies for file upload routes');
    }

    // Custom route: File translation page (BEFORE SDK router to take precedence)
    app.get('/addon/:config/file-translate/:videoId', async (req, res) => {
        try {
            // Defense-in-depth: Prevent caching (carries session token in query)
            setNoStore(res);

            const { config: configStr, videoId } = req.params;
            const config = await resolveConfigGuarded(configStr, req, res, '[File Translation] config');

            log.debug(() => `[File Translation] Request for video ${videoId}`);

            // Redirect to the actual upload page
            // Using a separate non-addon route so browser opens it directly
            res.redirect(302, `/file-upload?config=${encodeURIComponent(configStr)}&videoId=${encodeURIComponent(videoId)}`);
        } catch (error) {
            if (respondStorageUnavailable && respondStorageUnavailable(res, error, '[File Translation]')) return;
            log.error(() => '[File Translation] Error:', error);
            const uiLang = (() => {
                try { return loadLocale(req.query.lang || req.query.uiLang || DEFAULT_LANG).lang || DEFAULT_LANG; } catch (_) { return DEFAULT_LANG; }
            })();
            const tx = getTranslator(uiLang);
            res.status(500).send(tx('api.fileUpload.loadFailed', {}, 'Failed to load file translation page'));
        }
    });

    // Actual file translation upload page (standalone, not under /addon route)
    app.get('/file-upload', async (req, res) => {
        const lang = (req.query.lang || req.query.uiLang || '').toString().split('-')[0] || DEFAULT_LANG;
        const t = getTranslator(lang);
        try {
            // CRITICAL: Prevent caching to avoid cross-user config contamination (config/session in query)
            setNoStore(res);

            const { config: configStr, videoId, filename } = req.query;

            if (!configStr || !videoId) {
                return res.status(400).send(t('api.fileUpload.missingConfig', {}, 'Missing config or videoId'));
            }

            const config = await resolveConfigGuarded(configStr, req, res, '[File Upload Page] config');
            // Preserve canonical scoped hash from config resolution when available.
            // Fallback to local computation only for legacy/unscoped paths.
            if (!config.__configHash) {
                config.__configHash = computeConfigHash(config);
            }

            log.debug(() => `[File Upload Page] Loading page for video ${videoId}, filename: ${filename || 'n/a'}`);

            // Generate HTML page for file upload and translation
            const html = generateFileTranslationPage(videoId, configStr, config, filename || '');

            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.send(html);
        } catch (error) {
            if (respondStorageUnavailable && respondStorageUnavailable(res, error, '[File Upload Page]')) return;
            log.error(() => '[File Upload Page] Error:', error);
            const uiLang = (() => {
                try { return loadLocale(req.query.lang || req.query.uiLang || DEFAULT_LANG).lang || DEFAULT_LANG; } catch (_) { return DEFAULT_LANG; }
            })();
            const tx = getTranslator(uiLang);
            res.status(500).send(tx('api.fileUpload.loadFailed', {}, 'Failed to load file translation page'));
        }
    });
}

module.exports = {
    registerFileUploadRoutes,
};
