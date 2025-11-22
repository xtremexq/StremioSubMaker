(function() {
    'use strict';

    function wireGeminiTooltip() {
        var wrap = document.querySelector('.gemini-help-tooltip');
        if (!wrap) return;
        var icon = wrap.querySelector('.help-icon');
        var tooltip = wrap.querySelector('.tooltip-content');
        if (!icon || !tooltip) return;

        function show() {
            tooltip.style.opacity = '1';
            tooltip.style.pointerEvents = 'auto';
        }

        function hide() {
            tooltip.style.opacity = '0';
            tooltip.style.pointerEvents = 'none';
        }

        wrap.addEventListener('mouseenter', show);
        wrap.addEventListener('mouseleave', hide);
        icon.addEventListener('focus', show);
        icon.addEventListener('blur', hide);
        icon.addEventListener('click', function(e) {
            e.stopPropagation();
            var isVisible = tooltip.style.opacity === '1';
            if (isVisible) hide(); else show();
        });
        document.addEventListener('click', hide);
    }

    function wireProWarningToggle() {
        var modelSelect = document.getElementById('geminiModel');
        var warningDiv = document.getElementById('proRateLimitWarning');
        if (!modelSelect || !warningDiv) return;

        function updateWarning() {
            warningDiv.style.display = modelSelect.value === 'gemini-2.5-pro' ? 'block' : 'none';
        }

        modelSelect.addEventListener('change', updateWarning);
        updateWarning();
    }

    function initWidgets() {
        wireGeminiTooltip();
        wireProWarningToggle();
    }

    (window.partialsReady || Promise.resolve()).then(initWidgets).catch(function(err) {
        console.error(err);
    });
})();
