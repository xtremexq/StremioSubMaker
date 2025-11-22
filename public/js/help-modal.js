(function() {
    'use strict';

    function initHelpModal() {
        var helpBtn = document.getElementById('configHelp');
        var overlay = document.getElementById('instructionsModal');
        var closeBtn = document.getElementById('closeInstructionsBtn');
        var gotItBtn = document.getElementById('gotItInstructionsBtn');
        var dontShow = document.getElementById('dontShowInstructions');

        function openModal() {
            if (overlay) overlay.classList.add('show');
        }

        function closeModal() {
            if (overlay) {
                overlay.classList.remove('show');
                overlay.classList.remove('fly-out');
            }
        }

        if (helpBtn) helpBtn.addEventListener('click', openModal);
        if (closeBtn) closeBtn.addEventListener('click', closeModal);
        if (overlay) overlay.addEventListener('click', function(e) { if (e.target === overlay) closeModal(); });
        document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeModal(); });
        if (gotItBtn) {
            gotItBtn.addEventListener('click', function() {
                try {
                    if (dontShow && dontShow.checked) localStorage.setItem('hideConfigInstructions', '1');
                } catch (_) {}
                closeModal();
            });
        }
    }

    (window.partialsReady || Promise.resolve()).then(initHelpModal).catch(function(err) {
        console.error(err);
    });
})();
