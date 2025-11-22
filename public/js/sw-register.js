(function() {
    'use strict';

    if (!('serviceWorker' in navigator)) return;

    window.addEventListener('load', function() {
        navigator.serviceWorker.register('/sw.js', { scope: '/' })
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
