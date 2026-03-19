(function() {
    'use strict';

    const SESSION_PING_TIMEOUT_MS = 9000;
    const PARTIALS_TIMEOUT_MS = 10000;

    function loadConfigJs(versionQuery) {
        var script = document.createElement('script');
        script.src = 'config.js' + versionQuery;
        script.defer = false;
        document.body.appendChild(script);
    }

    function getBootstrappedVersion() {
        try {
            var version = window.__APP_VERSION__;
            return typeof version === 'string' ? version.trim() : '';
        } catch (_) {
            return '';
        }
    }

    function hasBootstrappedLimits() {
        try {
            return !!window.__CONFIG_LIMITS__ && typeof window.__CONFIG_LIMITS__ === 'object';
        } catch (_) {
            return false;
        }
    }

    function buildVersionQuery(version) {
        return '?v=' + encodeURIComponent(version || String(Date.now()));
    }

    function updateVersionBadge(version) {
        if (!version) return;

        var badge = document.getElementById('version-badge');
        if (badge) {
            badge.textContent = 'v' + version;
            badge.style.display = 'inline-flex';
        }

        var portalBadge = document.getElementById('portalVersionBadge');
        if (portalBadge) {
            portalBadge.textContent = 'v' + version;
        }

        var logo = document.querySelector('.logo img');
        if (logo && logo.src && logo.src.indexOf('?v=') === -1) {
            logo.src = logo.src + (logo.src.indexOf('?') === -1 ? '?v=' : '&v=') + version;
        }
    }

    function fetchSessionStats() {
        try {
            var controller = new AbortController();
            var timer = setTimeout(function() {
                try { controller.abort(); } catch (_) {}
            }, SESSION_PING_TIMEOUT_MS);
            return fetch('/api/session-stats', { cache: 'no-store', signal: controller.signal })
                .then(function(res) { return res && res.ok ? res.json() : null; })
                .finally(function() {
                    clearTimeout(timer);
                });
        } catch (_) {
            return Promise.resolve(null);
        }
    }

    function loadWithVersion() {
        var bootVersion = getBootstrappedVersion();
        if (bootVersion && hasBootstrappedLimits()) {
            updateVersionBadge(bootVersion);
            loadConfigJs(buildVersionQuery(bootVersion));
            return;
        }

        fetchSessionStats()
            .then(function(data) {
                if (data && data.limits) {
                    window.__CONFIG_LIMITS__ = data.limits;
                }
                var version = data && data.version ? data.version : bootVersion;
                loadConfigJs(buildVersionQuery(version));
                if (version) {
                    updateVersionBadge(version);
                }
            })
            .catch(function() {
                loadConfigJs(buildVersionQuery(bootVersion));
                if (bootVersion) {
                    updateVersionBadge(bootVersion);
                }
            });
    }

    document.addEventListener('click', function(event) {
        if (window.__tokenVaultUiReady === true) return;
        var target = event.target;
        var launcher = target && target.closest ? target.closest('#tokenVaultLauncher') : null;
        if (!launcher) return;
        window.__tokenVaultLauncherOpenRequested = true;
    }, true);

    var partialsReady = window.mainPartialReady || window.partialsReady || Promise.resolve();
    var partialsOrTimeout = Promise.race([
        partialsReady,
        new Promise(function(resolve) { setTimeout(resolve, PARTIALS_TIMEOUT_MS); })
    ]);
    partialsOrTimeout.catch(function(err) { console.error(err); }).then(loadWithVersion);
})();
