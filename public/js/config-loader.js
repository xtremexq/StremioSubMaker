(function() {
    'use strict';

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
            fetch('/api/session-stats', { cache: 'no-store' })
                .then(function(res) { return res.ok ? res.json() : null; })
                .then(function(data) {
                    var query = data && data.version ? ('?v=' + data.version) : ('?v=' + Date.now());
                    loadConfigJs(query);
                    if (data && data.version) {
                        updateVersionBadge(data.version);
                    }
                })
                .catch(function() {
                    loadConfigJs('?v=' + Date.now());
                });
        } catch (_) {
            loadConfigJs('?v=' + Date.now());
        }
    }

    var partialsReady = window.partialsReady || Promise.resolve();
    partialsReady.catch(function(err) { console.error(err); }).then(loadWithVersion);
})();
