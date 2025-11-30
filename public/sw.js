/**
 * Service Worker - Version-Based Cache Management
 *
 * This service worker handles:
 * 1. Version detection and cache invalidation on app updates
 * 2. Offline-first caching for static assets
 * 3. Network-first for API calls and dynamic content
 * 4. Automatic cache cleanup on version changes
 */

// Cache version from build time
let APP_VERSION = 'unknown';

// Fetch version from server on install
async function getAppVersion() {
    try {
        const response = await fetch('/api/session-stats', { cache: 'no-store' });
        const data = await response.json();
        return data.version || 'unknown';
    } catch (e) {
        return 'unknown';
    }
}

// Initialize version
getAppVersion().then(v => {
    APP_VERSION = v;
});

const CACHE_PREFIX = 'submaker';
const getVersionedCacheName = (version) => `${CACHE_PREFIX}-static-v${version}`;
const API_CACHE_NAME = `${CACHE_PREFIX}-api-v2`;
const NON_CACHEABLE_PATH_PREFIXES = [
    '/sub-toolbox',
    '/embedded-subtitles',
    '/auto-subtitles',
    '/file-upload',
    '/subtitle-sync',
    '/addon/'
];
const NON_CACHEABLE_ASSETS = new Set([
    '/css/configure.css',
    '/css/combobox.css',
    '/js/init.js',
    '/js/combobox.js',
    '/js/combobox-init.js',
    '/js/config-loader.js',
    '/js/ui-widgets.js',
    '/js/theme-toggle.js',
    '/js/help-modal.js',
    '/js/sw-register.js',
    '/config.js',
    '/sw.js'
]);

// Treat all API requests as sensitive to avoid any chance of cached responses
// leaking configuration or credentials between users (especially on shared
// hosting/CDN layers). We simply skip caching altogether for /api/* paths.
function isSensitiveApiRequest(urlLike) {
    const url = urlLike instanceof URL ? urlLike : new URL(urlLike, self.location.origin);
    return url.pathname.startsWith('/api/');
}

// Honor server cache directives (no-store/private) when deciding to cache
function responseHasNoStore(response) {
    const cacheControl = (response.headers.get('Cache-Control') || '').toLowerCase();
    const pragma = (response.headers.get('Pragma') || '').toLowerCase();
    const surrogate = (response.headers.get('Surrogate-Control') || '').toLowerCase();

    return cacheControl.includes('no-store') ||
        cacheControl.includes('no-cache') ||
        cacheControl.includes('private') ||
        pragma.includes('no-cache') ||
        surrogate.includes('no-store');
}

// Cache API rejects responses with "Vary: *" to prevent opaque caching.
// Skip caching in that case to avoid runtime failures and unintended sharing.
function responseHasVaryStar(response) {
    const vary = response.headers.get('Vary');
    return !!vary && vary.includes('*');
}

// Certain routes intentionally send Vary:* and no-store; skip all caching work for them
function shouldBypassCaching(urlLike) {
    const url = urlLike instanceof URL ? urlLike : new URL(urlLike, self.location.origin);
    return NON_CACHEABLE_PATH_PREFIXES.some(prefix =>
        url.pathname === prefix || url.pathname.startsWith(prefix)
    );
}

// Centralized helper to avoid crashing on responses that cannot be cached
async function safeCachePut(cache, request, response) {
    if (!response || responseHasNoStore(response) || responseHasVaryStar(response)) {
        return;
    }

    try {
        // Double check Vary header just before putting
        const vary = response.headers.get('Vary');
        if (vary && (vary.includes('*') || vary.trim() === '*')) {
            return;
        }

        await cache.put(request, response);
    } catch (error) {
        // Some CDNs/proxies add Vary: * dynamically; skip caching instead of throwing
        console.warn('Cache put failed:', error);
    }
}

// Purge any previously cached sensitive API entries so legacy data isn't retained
async function purgeSensitiveApiCacheEntries() {
    try {
        const cache = await caches.open(API_CACHE_NAME);
        const requests = await cache.keys();
        await Promise.all(requests.map(async (req) => {
            const url = new URL(req.url);

            if (isSensitiveApiRequest(url)) {
                await cache.delete(req);
                return;
            }

            const cachedResp = await cache.match(req);
            if (cachedResp && responseHasNoStore(cachedResp)) {
                await cache.delete(req);
            }
        }));
    } catch (error) {
    }
}

// Assets to cache on install
const ASSET_URLS = [
    '/',
    '/configure',
    '/config.js',
    '/configure.html',
    '/favicon.svg'
];

/**
 * Install event: Cache static assets
 */
self.addEventListener('install', (event) => {

    event.waitUntil(
        getAppVersion().then(version => {
            APP_VERSION = version;
            const cacheName = getVersionedCacheName(version);

            return caches.open(cacheName).then(cache => {
                return Promise.all(ASSET_URLS.map(async (assetUrl) => {
                    try {
                        const response = await fetch(assetUrl, { cache: 'no-store' });
                        if (response && response.ok) {
                            // Skip caching if upstream adds Vary: *
                            if (responseHasVaryStar(response)) {
                                return;
                            }
                            try {
                                await safeCachePut(cache, assetUrl, response.clone());
                            } catch (err) {
                                // Avoid unhandled rejections when upstream sets Vary: *
                                console.warn('Skipping cache put for install asset due to error', assetUrl, err);
                            }
                        }
                    } catch (err) {
                        // Ignore individual asset failures to keep install resilient
                    }
                }));
            });
        })
    );

    // Skip waiting to activate immediately
    self.skipWaiting();
});

/**
 * Activate event: Clean up old cache versions
 */
self.addEventListener('activate', (event) => {

    event.waitUntil(
        (async () => {
            const currentVersion = await getAppVersion();
            APP_VERSION = currentVersion;
            const currentCacheName = getVersionedCacheName(currentVersion);

            // Delete old version caches
            const cacheNames = await caches.keys();
            await Promise.all(
                cacheNames.map(cacheName => {
                    // Keep current version cache and API cache
                    if (cacheName === currentCacheName || cacheName === API_CACHE_NAME) {
                        return Promise.resolve();
                    }

                    // Delete old version caches
                    if (cacheName.startsWith(CACHE_PREFIX)) {
                        return caches.delete(cacheName);
                    }

                    return Promise.resolve();
                })
            );
            await purgeSensitiveApiCacheEntries();
        })()
    );

    // Claim clients immediately
    self.clients.claim();
});

/**
 * Fetch event: Handle requests with appropriate caching strategy
 */
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Skip cross-origin requests
    if (url.origin !== self.location.origin) {
        return;
    }

    // Dynamic pages that deliberately set Vary:* (toolbox, upload, addon) should never be cached
    if (shouldBypassCaching(url)) {
        return event.respondWith(
            fetch(request, { cache: 'no-store' }).catch(() => new Response(
                'Offline - dynamic page not cached',
                { status: 503, statusText: 'Service Unavailable' }
            ))
        );
    }

    // API calls: Network-first strategy
    if (url.pathname.startsWith('/api/')) {
        return event.respondWith(handleApiRequest(request));
    }

    // HTML pages: Network-first strategy
    if (url.pathname === '/' || url.pathname === '/configure' || url.pathname.endsWith('.html')) {
        return event.respondWith(handleHtmlRequest(request));
    }

    // Static assets: Cache-first strategy
    if (isStaticAsset(url.pathname)) {
        return event.respondWith(handleStaticAsset(request));
    }
});

/**
 * Handle API requests with network-first strategy
 */
async function handleApiRequest(request) {
    const url = new URL(request.url);
    const isSensitiveRequest = isSensitiveApiRequest(url);

    try {
        // Always prefer fresh network data
        const fetchOptions = isSensitiveRequest ? { cache: 'no-store' } : undefined;
        const response = await fetch(request, fetchOptions);

        return response;
    } catch (error) {
        // No cache available (we do not cache API responses anymore), return error response
        return new Response(
            JSON.stringify({ error: 'Offline - no cached response available' }),
            {
                status: 503,
                statusText: 'Service Unavailable',
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

/**
 * Handle HTML requests with network-first strategy
 */
async function handleHtmlRequest(request) {
    try {
        // Always try network first for HTML (configured with no-cache headers)
        const response = await fetch(request, { cache: 'no-store' });

        if (response.ok) {
            // Check if response has no-cache headers
            const cacheControl = response.headers.get('Cache-Control');
            const hasVaryStar = responseHasVaryStar(response);
            const shouldCache = !hasVaryStar &&
                (!cacheControl || (!cacheControl.includes('no-cache') && !cacheControl.includes('no-store')));

            // Only cache HTML if it doesn't have no-cache headers
            // This ensures configure.html and config.js are always fresh
            if (shouldCache) {
                const cache = await caches.open(getVersionedCacheName(APP_VERSION));
                try {
                    await safeCachePut(cache, request, response.clone());
                } catch (err) {
                    console.warn('Skipping cache put for HTML due to error', request.url, err);
                }
            }
        }

        return response;
    } catch (error) {
        // Network failed, try cache
        const cached = await caches.match(request);
        if (cached) {
            return cached;
        }

        return new Response(
            'Offline - no cached response available',
            {
                status: 503,
                statusText: 'Service Unavailable'
            }
        );
    }
}

/**
 * Handle static assets with cache-first strategy
 */
async function handleStaticAsset(request) {
    const url = new URL(request.url);
    const cacheName = getVersionedCacheName(APP_VERSION);

    if (NON_CACHEABLE_ASSETS.has(url.pathname)) {
        try {
            const cache = await caches.open(cacheName);
            await cache.delete(request);
        } catch (_) {
        }

        try {
            return await fetch(request, { cache: 'no-store' });
        } catch (error) {
            const cached = await caches.match(request);
            if (cached) {
                return cached;
            }
            return new Response(
                'Offline - asset not cached',
                {
                    status: 503,
                    statusText: 'Service Unavailable'
                }
            );
        }
    }

    // Try cache first
    const cached = await caches.match(request);
    if (cached) {
        return cached;
    }

    try {
        // Not in cache, fetch from network
        const response = await fetch(request);

        if (response.ok) {
            // Cache the response unless headers forbid it
            const cache = await caches.open(cacheName);
            const shouldCache = !responseHasNoStore(response) && !responseHasVaryStar(response);
            if (shouldCache) {
                try {
                    await safeCachePut(cache, request, response.clone());
                } catch (err) {
                    console.warn('Skipping cache put for static asset due to error', request.url, err);
                }
            }
        }

        return response;
    } catch (error) {
        // Network failed and not in cache
        return new Response(
            'Offline - asset not cached',
            {
                status: 503,
                statusText: 'Service Unavailable'
            }
        );
    }
}

/**
 * Check if a path is a static asset
 */
function isStaticAsset(pathname) {
    const staticExtensions = ['.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.woff', '.woff2', '.ttf', '.eot'];
    return staticExtensions.some(ext => pathname.endsWith(ext));
}

/**
 * Message handler for cache control from clients
 */
self.addEventListener('message', (event) => {

    if (event.data && event.data.type === 'CLEAR_CACHE') {
        handleClearCache();
    } else if (event.data && event.data.type === 'GET_VERSION') {
        event.ports[0].postMessage({ version: APP_VERSION });
    }
});

/**
 * Manually clear cache when requested by client
 */
async function handleClearCache() {
    try {
        const cacheNames = await caches.keys();
        const deletePromises = cacheNames.map(cacheName => {
            if (cacheName.startsWith(CACHE_PREFIX)) {
                return caches.delete(cacheName);
            }
            return Promise.resolve();
        });

        await Promise.all(deletePromises);
    } catch (error) {
    }
}
