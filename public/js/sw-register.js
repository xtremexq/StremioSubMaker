(function() {
    'use strict';

    if (!('serviceWorker' in navigator)) return;

    const BYPASS_PATH_PREFIXES = [
        '/sub-toolbox',
        '/embedded-subtitles',
        '/auto-subtitles',
        '/subtitle-sync',
        '/file-upload',
        '/addon/'
    ];

    function shouldBypassSw() {
        const path = window.location.pathname || '';
        return BYPASS_PATH_PREFIXES.some(prefix => path === prefix || path.startsWith(prefix));
    }

    // On toolbox/addon pages, unregister any existing SW; reload once to drop controller automatically
    function unregisterIfBypassed() {
        if (!shouldBypassSw()) return;
        navigator.serviceWorker.getRegistrations()
            .then(function(regs) {
                var hadRegs = Array.isArray(regs) && regs.length > 0;
                var hadController = !!navigator.serviceWorker.controller;
                return Promise.all((regs || []).map(function(reg) { return reg.unregister().catch(function(){}); }))
                    .then(function() {
                        // We used to force a reload here to drop the controller immediately.
                        // That caused surprise refreshes on toolbox pages; instead, rely on
                        // the next navigation to shed the controller naturally.
                        if (hadRegs || hadController) {
                            try { sessionStorage.setItem('swBypassReloaded', '1'); } catch (_) {}
                        }
                    });
            })
            .catch(function(){});
    }

    window.addEventListener('load', function() {
        if (shouldBypassSw()) {
            unregisterIfBypassed();
            return;
        }
        // Version-based cache-buster: keeps first load light while updating on new releases
        var versionTag = (window.__APP_VERSION__ || 'dev').toString();
        // Hourly bump ensures changed SW rolls out even if app version stays the same
        var cacheBust = versionTag + '-h' + Math.floor(Date.now() / 3600000);
        navigator.serviceWorker.register('/sw.js?v=' + encodeURIComponent(cacheBust), { scope: '/', updateViaCache: 'none' })
            .then(function(reg) {
                setInterval(function() {
                    reg.update().catch(function(){});
                }, 60 * 60 * 1000);

                navigator.serviceWorker.addEventListener('controllerchange', function() {
                    // no-op
                });
            })
            .catch(function(){ /* no-op */ });
    });

    navigator.serviceWorker.addEventListener('message', function(){ });
})();
