const { generateFileTranslationPage } = require('../utils/fileUploadPageGenerator');

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
            res.status(500).send('Failed to load file translation page');
        }
    });

    // Actual file translation upload page (standalone, not under /addon route)
    app.get('/file-upload', async (req, res) => {
        try {
            // CRITICAL: Prevent caching to avoid cross-user config contamination (config/session in query)
            setNoStore(res);

            const { config: configStr, videoId, filename } = req.query;

            if (!configStr || !videoId) {
                return res.status(400).send('Missing config or videoId');
            }

            const config = await resolveConfigGuarded(configStr, req, res, '[File Upload Page] config');
            config.__configHash = computeConfigHash(config);

            log.debug(() => `[File Upload Page] Loading page for video ${videoId}, filename: ${filename || 'n/a'}`);

            // Generate HTML page for file upload and translation
            const html = generateFileTranslationPage(videoId, configStr, config, filename || '');

            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.send(html);
        } catch (error) {
            if (respondStorageUnavailable && respondStorageUnavailable(res, error, '[File Upload Page]')) return;
            log.error(() => '[File Upload Page] Error:', error);
            res.status(500).send('Failed to load file translation page');
        }
    });
}

module.exports = {
    registerFileUploadRoutes,
};
