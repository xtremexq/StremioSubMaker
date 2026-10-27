# 🔧 Troubleshooting Guide

Common issues and solutions for SubMaker.

---

## Translation Issues

### ❌ Translation Fails / Errors

| Problem | Solution |
|---------|----------|
| API key invalid | Validate key at [Google AI Studio](https://aistudio.google.com/apikey) |
| Rate limit hit (HTTP 429) | Switch to Gemma 27b model, add more API keys with rotation, or use a secondary provider |
| Translation timeout | Increase provider timeout in API Keys section |
| Provider errors (503/prohibited) | Enable a **Secondary Provider** in Translation Settings as fallback |

### 🔄 Bad / Broken Translation

1. **Force re-translation** — Triple-click the problematic subtitle in Stremio (within 6 seconds)
2. **Bypass cache** — Enable "Bypass Cache (Force Retranslation)" in Translation Settings
3. **Try different model** — Switch between Flash-Lite, Flash, or Gemma models
4. **Change workflow mode** — Try "XML Tags" (recommended) or "Send Timestamps to AI" in Translation Settings

### ⏱️ Subtitles Out of Sync

1. **Switch workflow mode** — Change "Translation Workflow" setting:
   - "XML Tags" (recommended for sync issues)
   - "Original Timestamps" (legacy)
   - "Send Timestamps to AI" (trusts AI to preserve timecodes)
2. **Test source subtitle first** — Watch with original subtitle to verify correct sync before translating

---

## Subtitle Fetching Issues

### 📥 No Subtitles Found

| Check | Action |
|-------|--------|
| Provider status | Validate API keys using the "Test" button next to each provider |
| Provider timeout | Increase timeout (default 12s) — SCS requires 28-30s |
| Language selection | Verify both source and target languages are selected |
| Provider enabled | Ensure toggle is ON for desired providers |

### 🐢 Slow Subtitle Loading

- **Reduce providers** — Disable unnecessary providers (Wyzie, SCS are slower)
- **Increase timeout** — Higher values for reliable results from slow providers
- **Wyzie searches** — Wyzie automatically searches every current source available to the API-key plan; disable Wyzie itself if you do not want the extra aggregator request
- **Search hang guard** — The provider timeout saved in the config page controls normal subtitle searches. Advanced deployments can tune the separate stuck-search guard with `SUBTITLE_SEARCH_HARD_TIMEOUT_MS` (default 60000ms) and `SUBTITLE_SEARCH_STALE_GRACE_MS`; cache lookups such as xEmbed, xSync, Auto, and SMDB are not hidden behind route-level fallback timers.
- **Redis/cache stalls** — Redis commands are bounded by `REDIS_COMMAND_TIMEOUT_MS` (default 5000ms). xEmbed, xSync, and Auto subtitle-list reads use maintained per-video indexes and must not rebuild indexes with Redis `SCAN` during a subtitle request.

### OpenSubtitles Auth 429 / Login Coordination

OpenSubtitles limits API traffic per public IP, and `/login` is stricter than normal search traffic. In multi-instance deployments, use Redis storage so all SubMaker pods share the same JWT cache and login singleflight lock. Upstream `429` responses advance the next reservation from response headers; they do not create a separate multi-minute login cooldown.

Useful environment knobs:

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENSUBTITLES_LOGIN_MIN_INTERVAL_MS` | `1250` | Minimum spacing between `/login` sends across pods |
| `OPENSUBTITLES_LOGIN_LOCK_TTL_MS` | `30000` | Distributed per-credential login lock TTL |

If 429s persist on a public deployment using VPN/WARP/shared NAT egress, confirm no unrelated traffic shares the same OpenSubtitles-visible IP. Redis coordinates SubMaker pods, but it cannot coordinate other apps or other tenants using the same egress IP.

---

## Configuration Issues

### 💾 Settings Not Saving

1. **Hard refresh** — Press `Ctrl+F5` (Windows/Linux) or `Cmd+Shift+R` (Mac)
2. **Check browser console** — Press `F12` → Console tab for error messages
3. **Disable extensions** — Some ad blockers or privacy extensions break localStorage
4. **Try incognito mode** — Eliminates cache and extension conflicts
5. **Full reset** — Click "Reset" button at bottom of config page

### 🔗 Install URL Not Working

1. **Save first** — Click "Save Configuration" before installing
2. **Check URL format** — Must start with `stremio://` or be a valid HTTP(S) URL
3. **Copy manually** — Use "Copy Install URL" button and paste in Stremio

---

## Mobile / Android Issues

### 📱 Subtitles Not Loading on Android

1. **Enable Mobile Mode** — Check "Mobile Mode (fix/workaround)" in Other Settings
2. **Wait patiently** — Translations take 1-3 minutes in mobile mode
3. **Switch subtitles** — If stuck, switch to another subtitle and back
4. **Use Flash-Lite model** — Fastest model for mobile compatibility

### ℹ️ Why Mobile Mode Exists

Stremio on Android makes only 1 request for subtitles and caches it. Mobile Mode holds the translation request and delivers the complete subtitle only when ready.

---

## AI Provider Issues

### 🔑 API Key Problems

| Provider | Key Format | Notes |
|----------|------------|-------|
| Gemini | `AQ....` or legacy `AIza...` | Free at [Google AI Studio](https://aistudio.google.com/apikey) |
| OpenSubtitles | Username + Password | V3 mode needs no auth, Auth mode recommended |
| SubSource | API key | Get from [subsource.net/api-docs](https://subsource.net/api-docs) |
| SubDL | API key | Get from [subdl.com/panel/api](https://subdl.com/panel/api) |
| Cloudflare Workers | `ACCOUNT_ID\|TOKEN` | Pipe-separated format |

### 🔄 Key Rotation Issues

1. **Enable rotation** — Check "Enable Gemini API key rotation"
2. **Add multiple keys** — Click "Add Key" to add 2-5 keys
3. **Choose frequency** — "Per Batch" distributes load, "Per Request" uses one key per file

### 🤖 Multi-Provider Setup

1. Enable "Multiple providers (beta)" in AI Translation API Keys section
2. Configure each provider with API key and model
3. Set "Main Provider" in Translation Settings
4. Optionally enable "Secondary Provider" for fallback on errors

---

## Sub Toolbox Issues

### 🧰 Toolbox Not Appearing

1. **Enable Toolbox** — Check "Enable Sub Toolbox (Beta)" in Other Settings
2. **Save and reinstall** — Click "Save Configuration" then reinstall addon

### 🖥️ Toolbox Not Opening in Browser

1. In Stremio subtitles list, click "Sub Toolbox"
2. Right-click the video → "Download Subtitles" to open in browser
3. Ensure browser allows popups from your SubMaker domain

---

## Docker / Self-Hosting Issues

### 🐳 Container Not Starting

```bash
# Check logs
docker-compose logs -f submaker

# Check Redis health
docker-compose logs -f redis
docker-compose ps

# Port conflict
# Linux/Mac:
lsof -i :7001
# Windows:
netstat -ano | findstr :7001
```

### 🔄 Update to Latest Image

```bash
docker pull xtremexq/submaker:latest
docker-compose up -d
```

### 📁 Storage Issues

| Storage Type | Use Case |
|-------------|----------|
| `redis` | Multi-instance, production (requires Redis) |
| `filesystem` | Single-node, local development |

---

## Advanced Troubleshooting

### 🧪 Enable Advanced Mode

Check "Advanced Mode" in Other Settings to unlock:
- Batch Context settings
- Mismatch Retries configuration
- JSON Structured Output
- Gemini Advanced Parameters (model-default/custom sampling, temperature, Top-P, Top-K, and thinking)

### 📊 Parameters to Tune

| Parameter | Default | Effect |
|-----------|---------|--------|
| Custom sampling parameters | Off for Gemini 3.x; on for legacy/Gemma | When off, Temperature, Top-P, and Top-K are omitted so the model uses its defaults |
| Temperature | 0.8 | Higher = more creative, Lower = more consistent |
| Top-P | 0.95 | Lower = more focused responses |
| Top-K | 40 | Limits candidate tokens when custom sampling is enabled |
| Mismatch Retries | 1 | Retries when AI returns wrong entry count |
| Thinking Budget | 0 | Extended reasoning tokens (0 = disabled) |

---

## Getting Help

### 🆘 Before Opening an Issue

1. **Check this guide** — Most issues covered above
2. **Try reset** — Click "Reset" at bottom of config page
3. **Test in incognito** — Rules out extension conflicts
4. **Check browser console** — F12 → Console for errors

### 📧 Open a GitHub Issue

[Open an issue](https://github.com/xtremexq/StremioSubMaker/issues) with:
- Description of the problem
- Steps to reproduce
- Browser and OS
- Relevant error messages

---

[← Back to README](../README.md)
