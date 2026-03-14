(function () {
    'use strict';

    var html = document.documentElement;
    var darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

    function getThirdThemeToken() {
        return html.getAttribute('data-third-theme') === 'true-dark' ? 'true-dark' : 'blackhole';
    }

    function normalizeTheme(theme) {
        if (theme === 'true-dark' || theme === 'blackhole') return 'blackhole';
        if (theme === 'light' || theme === 'dark') return theme;
        return null;
    }

    function readStoredTheme() {
        try {
            return localStorage.getItem('theme');
        } catch (_) {
            return null;
        }
    }

    function getPreferredTheme() {
        var saved = normalizeTheme(readStoredTheme());
        if (saved) return saved;
        return darkQuery && darkQuery.matches ? 'dark' : 'light';
    }

    function setTheme(theme, persist) {
        var normalized = normalizeTheme(theme) || 'light';
        var applied = normalized === 'blackhole' ? getThirdThemeToken() : normalized;
        html.setAttribute('data-theme', applied);
        try {
            if (persist === true) {
                localStorage.setItem('theme', normalized);
            }
        } catch (_) { }
        return normalized;
    }

    function spawnCoin(x, y) {
        try {
            var c = document.createElement('div');
            c.className = 'coin animate';
            c.style.left = x + 'px';
            c.style.top = y + 'px';
            document.body.appendChild(c);
            c.addEventListener('animationend', function () { c.remove(); }, { once: true });
            setTimeout(function () { if (c && c.parentNode) c.remove(); }, 1200);
        } catch (_) { }
    }

    function wireToggle() {
        var themeToggle = document.getElementById('themeToggle');
        var rawStoredTheme = readStoredTheme();
        var normalizedStoredTheme = normalizeTheme(rawStoredTheme);

        if (rawStoredTheme && normalizedStoredTheme && rawStoredTheme !== normalizedStoredTheme) {
            setTheme(normalizedStoredTheme, true);
        } else {
            setTheme(getPreferredTheme(), false);
        }

        if (themeToggle && themeToggle.dataset.themeToggleBound !== 'true') {
            themeToggle.dataset.themeToggleBound = 'true';
            themeToggle.addEventListener('click', function (e) {
                var active = normalizeTheme(html.getAttribute('data-theme')) || 'light';
                var next = active === 'light' ? 'dark' : (active === 'dark' ? 'blackhole' : 'light');
                setTheme(next, true);
                if (e && e.clientX != null && e.clientY != null) {
                    spawnCoin(e.clientX, e.clientY);
                }
            });
        }

        if (darkQuery && html.dataset.themeMediaListenerBound !== 'true') {
            html.dataset.themeMediaListenerBound = 'true';
            darkQuery.addEventListener('change', function (event) {
                if (!normalizeTheme(readStoredTheme())) {
                    setTheme(event.matches ? 'dark' : 'light', false);
                }
            });
        }
    }

    (window.partialsReady || Promise.resolve()).finally(wireToggle);
})();
