(function() {
    'use strict';

    if (!('serviceWorker' in navigator)) return;

    window.addEventListener('load', function() {
        // Aggressive cache-buster ensures clients always fetch the latest SW immediately
        // This prevents stale SWs (with Vary:* cache.put) from lingering
        const cacheBust = Date.now();
        navigator.serviceWorker.register('/sw.js?v=' + cacheBust, { scope: '/', updateViaCache: 'none' })
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
