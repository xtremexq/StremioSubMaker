(function() {
    'use strict';

    if (!('serviceWorker' in navigator)) return;

    window.addEventListener('load', function() {
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
