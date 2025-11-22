(function() {
    'use strict';

    var html = document.documentElement;
    var themeToggle = document.getElementById('themeToggle');

    function getPreferredTheme() {
        try {
            var saved = localStorage.getItem('theme');
            if (saved) return saved;
        } catch (_) {}

        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            return 'dark';
        }
        return 'light';
    }

    function setTheme(theme) {
        html.setAttribute('data-theme', theme);
        try {
            localStorage.setItem('theme', theme);
        } catch (_) {}
    }

    function spawnCoin(x, y) {
        try {
            var c = document.createElement('div');
            c.className = 'coin animate';
            c.style.left = x + 'px';
            c.style.top = y + 'px';
            document.body.appendChild(c);
            c.addEventListener('animationend', function() { c.remove(); }, { once: true });
            setTimeout(function() { if (c && c.parentNode) c.remove(); }, 1200);
        } catch (_) {}
    }

    function wireToggle() {
        if (!themeToggle) return;

        var current = html.getAttribute('data-theme') || getPreferredTheme();
        setTheme(current);

        themeToggle.addEventListener('click', function(e) {
            var active = html.getAttribute('data-theme') || 'light';
            var next = active === 'light' ? 'dark' : (active === 'dark' ? 'true-dark' : 'light');
            setTheme(next);
            if (e && e.clientX != null && e.clientY != null) {
                spawnCoin(e.clientX, e.clientY);
            }
        });

        if (window.matchMedia) {
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(event) {
                try {
                    if (!localStorage.getItem('theme')) {
                        setTheme(event.matches ? 'dark' : 'light');
                    }
                } catch (_) {}
            });
        }
    }

    (window.partialsReady || Promise.resolve()).finally(wireToggle);
})();
