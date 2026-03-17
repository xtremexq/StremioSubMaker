const MAX_SESSION_BRIEF_BATCH = 16;
const SESSION_BRIEF_LOOKUP_CONCURRENCY = 4;

function normalizeSessionBriefTokens(tokens = [], maxTokens = MAX_SESSION_BRIEF_BATCH) {
    const safeMax = Math.max(1, Number(maxTokens) || MAX_SESSION_BRIEF_BATCH);
    return Array.from(new Set((Array.isArray(tokens) ? tokens : [])
        .map(token => String(token || '').trim().toLowerCase())
        .filter(token => /^[a-f0-9]{32}$/.test(token))))
        .slice(0, safeMax);
}

module.exports = {
    MAX_SESSION_BRIEF_BATCH,
    SESSION_BRIEF_LOOKUP_CONCURRENCY,
    normalizeSessionBriefTokens
};
