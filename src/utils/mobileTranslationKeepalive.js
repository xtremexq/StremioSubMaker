function startMobileTranslationKeepalive(res, targetLang, options = {}) {
  if (res.headersSent || res.writableEnded || res.destroyed) return () => { };

  const setCacheHeaders = typeof options.setCacheHeaders === 'function'
    ? options.setCacheHeaders
    : () => { };
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0
    ? options.intervalMs
    : 15_000;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="translated_${targetLang}.srt"`);
  res.setHeader('X-Accel-Buffering', 'no');
  setCacheHeaders(res, 'loading');
  res.flushHeaders?.();

  try { res.write('\n'); } catch (_) { }

  const timer = setIntervalFn(() => {
    if (res.writableEnded || res.destroyed) return;
    try { res.write('\n'); } catch (_) { }
  }, intervalMs);
  timer?.unref?.();

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearIntervalFn(timer);
  };
  res.once?.('close', stop);
  return stop;
}

module.exports = { startMobileTranslationKeepalive };
