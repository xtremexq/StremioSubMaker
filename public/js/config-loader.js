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

    function updateVersionBadge(version) {
        if (!version) return;

        var badge = document.getElementById('version-badge');
        if (badge) {
            badge.textContent = 'v' + version;
            badge.style.display = 'inline-flex';
        }

        var logo = document.querySelector('.logo img');
        if (logo && logo.src && logo.src.indexOf('?v=') === -1) {
            logo.src = logo.src + (logo.src.indexOf('?') === -1 ? '?v=' : '&v=') + version;
        }
    }

    function loadWithVersion() {
        try {
            var controller = new AbortController();
            var timer = setTimeout(function() {
                try { controller.abort(); } catch (_) {}
            }, SESSION_PING_TIMEOUT_MS);

            fetch('/api/session-stats', { cache: 'no-store', signal: controller.signal })
                .then(function(res) { return res && res.ok ? res.json() : null; })
                .then(function(data) {
                    if (data && data.limits) {
                        window.__CONFIG_LIMITS__ = data.limits;
                    }
                    var query = data && data.version ? ('?v=' + data.version) : ('?v=' + Date.now());
                    loadConfigJs(query);
                    if (data && data.version) {
                        updateVersionBadge(data.version);
                    }
                })
                .catch(function() {
                    loadConfigJs('?v=' + Date.now());
                })
                .finally(function() {
                    clearTimeout(timer);
                });
        } catch (_) {
            loadConfigJs('?v=' + Date.now());
        }
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
