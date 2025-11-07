# 🎬 SubMaker

**AI-Powered Subtitle Translation for Stremio**

Watch any content in your language!

SubMaker fetches subtitles from multiple sources and allows you to translate them instantly using Google's Gemini AI—all without leaving your player.

No-Translation mode: simply fetch selected languages from OpenSubtitles, SubSource and SubDL.

Auto-sync subtitles in development!

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)
[![Stremio Addon](https://img.shields.io/badge/Stremio-Addon-purple)](https://www.stremio.com)

---

## ✨ Why SubMaker?

- 🌍 **190+ Languages** - Full ISO-639-2 support including regional variants (PT-BR, etc.)
- 📥 **4 Subtitle Sources** - OpenSubtitles, SubDL, SubSource, with automatic fallback
- 🎯 **One-Click Translation** - Translate on-the-fly without ever leaving Stremio
- 🤖 **Context-Aware AI** - Google Gemini preserves timing, formatting, and natural dialogue flow
- ⚡ **Translation Caching** - Permanent subtitles database with dual-layer cache (memory + disk) and deduplication
- 🔒 **Production-Ready** - Rate limiting, CORS protection, session tokens, HTTPS enforcement
- 🎨 **Beautiful UI** - Modern configuration interface with live model fetching

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+ ([Download](https://nodejs.org))
- **Gemini API Key** ([Get one free](https://makersuite.google.com/app/apikey))
- **OpenSubtitles** account for higher limits ([Sign up](https://www.opensubtitles.com/en/newuser))
- **SubSource API Key** ([Get one free](https://subsource.net/api-docs))
- **SubDL API Key** ([Get one free](https://subdl.com/panel/api)) 

### Installation

```bash
# Clone and install
git clone https://github.com/xtremexq/SubMaker.git
cd SubMaker
npm install

# Start the server
npm start

# Open configuration page
open http://localhost:7001
```

### Configure & Install

1. **Add your API keys** (required)
2. **Select source languages** (where to fetch subtitles from)
3. **Select target languages** (what to translate to)
4. **Click "Install in Stremio"** or copy the URL

That's it! Translation buttons (Make [Language]) will now appear in your Stremio subtitle menu.

---

## 🎯 How It Works

```
┌─────────────────────────────────────────────┐
│  1. Watch content in Stremio                │
│  2. Subtitles appear with "Make [Language]" │
│  3. Click → Select source subtitle          │
│  4. AI translates in ~1 to 3 minutes        │
│  5. Reselect the translated subtitles       │
│  6. Next time? Instant! (cached on DB)      │
└─────────────────────────────────────────────┘
```

### Architecture

```
Stremio Player
    ↓
SubMaker Addon (Express + Stremio SDK)
    ├── Subtitle Fetcher → [OpenSubtitles, SubDL, SubSource, Podnapisi]
    ├── Translation Engine → [Google Gemini AI]
    └── Cache Manager → [Memory LRU + Persistent Disk]
```

### Key Features

**Multi-Source Fetching**
- Queries 4 providers simultaneously
- Automatic fallback if one fails
- Ranks by downloads, ratings, quality

**AI Translation**
- Context-aware (processes entire subtitle at once)
- Handles files up to unlimited size with chunking
- Customizable translation prompts
- Supports all Gemini models (Flash, Pro, etc.)

**Intelligent Caching**
- **Memory**: LRU cache for hot translations (~200ms)
- **Disk**: Persistent cache survives restarts
- **Deduplication**: Multiple users requesting same translation share cost
- **Cost Savings**: 100% for cached, ~$0.50-$2 for new (typical movie)

---

## ⚙️ Configuration Guide

### Source Languages
Languages to **fetch** subtitles in (Single language recommended)
- Example: English, Spanish, Portuguese (BR)

### Target Languages
Languages to **translate to** (unlimited)
- Example: French, German, Japanese

### Gemini Model Selection
- Flash or Flash-Lite Latest recommended. 
- Do not use Pro or other models. (takes too long/fails)

**Provider Configuration**
- OpenSubtitles: Optional username/password for higher limits
- SubDL: Requires API key
- SubSource: Requires API key
- Podnapisi: (DISABLED)

---

## 🐛 Troubleshooting

### No Subtitles Appearing?

1. **Check source languages** - Did you select the right languages in config?
2. **Verify content has subs** - Search on OpenSubtitles.com to confirm
3. **Check rate limits** - Add OpenSubtitles account credentials if hitting limits
4. **Review server logs** - Look for 401/403 errors indicating quota issues

### Translation Fails?

1. **Validate API key** - Test at [Google AI Studio](https://makersuite.google.com)
2. **Check model selection** - Ensure model used is Flash or Flash-Lite Latest
3. **Check Gemini quota** - Review your free API usage

### Configuration Not Saving?

1. **Clear browser cache** - Force reload with Ctrl+F5
2. **Check JavaScript console** - Look for errors (F12)
3. **Disable browser extensions** - Some block localStorage
4. **Try incognito mode** - Eliminate cache/extension issues

---

## 📖 API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Configuration UI |
| `/api/languages` | GET | List all supported languages |
| `/api/gemini-models` | POST | Fetch available Gemini models |
| `/api/create-session` | POST | Create session token from config |
| `/addon/:config/manifest.json` | GET | Stremio addon manifest |
| `/addon/:config/subtitles/:type/:id.json` | GET | Subtitle list (Stremio SDK) |
| `/addon/:config/translate-selector/:id/:lang` | GET | Translation source selection UI |
| `/addon/:config/translate/:fileId/:lang` | GET | Translate subtitle file |

---

## 💡 Roadmap

**In Progress**
- [ ] Timing sync adjustment for any subtitle
- [ ] Translation quality rating system

**Planned**
- [ ] Support for more Subtitles sources
- [ ] Batch translation for entire series
- [ ] User preference cloud sync

---

## 🙏 Acknowledgments

**Built With**
- [Stremio Addon SDK](https://github.com/Stremio/stremio-addon-sdk) - Addon framework
- [Google Gemini](https://ai.google.dev/) - AI translation
- [OpenSubtitles](https://www.opensubtitles.com/) - Primary subtitle database
- [SubDL](https://subdl.com/) - Alternative subtitle source
- [SubSource](https://subsource.net/) - Alternative subtitle source

**Special Thanks**
- Stremio team for excellent addon SDK
- Google for free Gemini API access
- All Subtitles communities

---

## 📧 Support

**Issues & Questions**
[Open an issue](https://github.com/xtremexq/SubMaker/issues) on GitHub

**Documentation**
Check the `/public/configure.html` UI for interactive help

**Community**
Join Stremio Discord for general Stremio addon help

---

**Made with ❤️ for the Stremio community**

[⭐ Star this repo](https://github.com/xtremexq/SubMaker) · [🐛 Report Bug](https://github.com/xtremexq/SubMaker/issues) · [✨ Request Feature](https://github.com/xtremexq/SubMaker/issues)
