# 🌐 Stremio Subtitle Translator

A powerful Stremio addon that fetches subtitles from OpenSubtitles and translates them on-the-fly using Google Gemini AI. Perfect for watching content in your preferred language!

## ✨ Features

- 🎬 **Fetch subtitles** from OpenSubtitles for movies and TV shows
- 🤖 **AI-powered translation** using Google Gemini
- 🌍 **Multi-language support** with full ISO639-2 language list
- 🇧🇷 **Special regional support** (PTBR and other variants)
- ⚡ **Easy configuration** with beautiful web interface
- 🎨 **Dynamic model selection** - fetches available Gemini models from API
- ✏️ **Custom translation prompts** for better control over translations
- 🔄 **Real-time translation** - translate any subtitle to any language
- 📱 **Responsive design** - works on desktop and mobile

## 🚀 Quick Start

### Prerequisites

- Node.js (v14 or higher)
- OpenSubtitles API key ([Get it here](https://www.opensubtitles.com/en/consumers))
- Google Gemini API key ([Get it here](https://makersuite.google.com/app/apikey))

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/StremioSubMaker.git
   cd StremioSubMaker
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start the server**
   ```bash
   npm start
   ```

4. **Open the configuration page**
   ```
   http://localhost:7000
   ```

## 📖 Configuration Guide

### Step 1: API Keys

1. **OpenSubtitles API Key**
   - Sign up at [OpenSubtitles](https://www.opensubtitles.com)
   - Go to [Consumers page](https://www.opensubtitles.com/en/consumers)
   - Create a new application and get your API key

2. **Google Gemini API Key**
   - Visit [Google AI Studio](https://makersuite.google.com/app/apikey)
   - Create a new API key
   - Enter it in the configuration page

### Step 2: Select Gemini Model

1. Enter your Gemini API key
2. Click "Load Available Models"
3. Select the model you want to use (e.g., gemini-1.5-pro, gemini-1.5-flash)

### Step 3: Choose Languages

**Source Languages**: Languages to fetch subtitles from
- Use "Select Common" for popular languages
- Or manually select specific languages

**Target Languages**: Languages you want to translate to
- Select all languages you might need
- Translation buttons will appear for each target language in Stremio

### Step 4: Custom Translation Prompt (Optional)

Customize how the AI translates subtitles. The default prompt is optimized for subtitle translation, but you can modify it for:
- Different translation styles (formal/informal)
- Specific terminology handling
- Cultural adaptation preferences

### Step 5: Save & Install

1. Click "Save Configuration"
2. Copy the generated addon URL
3. Click "Install to Stremio" or manually add the URL to Stremio

## 🎯 How It Works

### For Users

1. **Play any movie or TV show** in Stremio
2. **Open subtitle selection** menu
3. **Choose from available subtitles** (fetched from OpenSubtitles)
4. **Or click a translation button** (e.g., "🌐 Translate to Portuguese (Brazil)")
5. **Select source subtitle** to translate from
6. **Translated subtitle loads automatically!**

### Technical Flow

```
User selects content in Stremio
       ↓
Addon fetches subtitles from OpenSubtitles
       ↓
Shows translation buttons for target languages
       ↓
User clicks translation button
       ↓
User selects source subtitle
       ↓
Subtitle is downloaded and translated with Gemini
       ↓
Translated subtitle is served to Stremio
```

## 🏗️ Architecture

```
src/
├── index.js              # Main server & routing
├── languages.js          # ISO639-2 language mappings
├── opensubtitles.js      # OpenSubtitles API client
├── gemini.js             # Google Gemini API client
├── subtitleHandler.js    # Subtitle fetching & translation logic
└── config.html           # Beautiful configuration UI
```

## 🌍 Language Support

The addon supports a comprehensive list of languages including:

- Major languages: English, Spanish, French, German, Italian, Portuguese, Russian, Japanese, Korean, Chinese, Arabic, Hindi
- Regional variants: Portuguese (Brazil), Chinese (Traditional/Simplified)
- European languages: Swedish, Norwegian, Danish, Finnish, Dutch, Polish, Czech, Hungarian, Romanian, Greek
- And many more...

**Special handling for PTBR**: Stremio uses `pob` for Brazilian Portuguese, which is automatically mapped to `pb` for OpenSubtitles API.

## ⚙️ Configuration Options

### Environment Variables

- `PORT` - Server port (default: 7000)

### Runtime Configuration (via UI)

- **opensubtitlesApiKey**: Your OpenSubtitles API key
- **geminiApiKey**: Your Google Gemini API key
- **geminiModel**: Selected Gemini model (dynamically loaded)
- **translationPrompt**: Custom prompt for translations
- **sourceLanguages**: Array of ISO639-2 language codes to fetch
- **targetLanguages**: Array of ISO639-2 language codes to translate to

## 🔧 Development

### Run in development mode

```bash
npm run dev
```

This uses `nodemon` to automatically restart the server on file changes.

### Project Structure

- **languages.js**: Maps ISO639-2 codes to ISO639-1 for API compatibility
- **opensubtitles.js**: Handles authentication, search, and download from OpenSubtitles
- **gemini.js**: Manages Gemini API calls including model listing and translation
- **subtitleHandler.js**: Orchestrates subtitle fetching and translation workflow
- **index.js**: HTTP server with routing for addon endpoints and config UI
- **config.html**: Beautiful, responsive configuration interface

## 🐛 Troubleshooting

### Subtitles not appearing
- Check if OpenSubtitles API key is valid
- Ensure selected languages match available subtitles
- Verify IMDB ID is correct

### Translation fails
- Verify Gemini API key is valid and has quota
- Check if selected model supports the content length
- Try a different Gemini model

### Addon not installing in Stremio
- Ensure the server is running and accessible
- Check if the addon URL is correctly copied
- Verify firewall settings if accessing remotely

## 📝 API Endpoints

### Public Endpoints

- `GET /` - Configuration page
- `GET /api/languages` - Get all supported languages
- `POST /api/gemini-models` - List available Gemini models

### Addon Endpoints (with config)

- `GET /{config}/manifest.json` - Addon manifest
- `GET /{config}/subtitles/{type}/{id}.json` - Get subtitles list
- `GET /{config}/subtitle/{fileId}.srt` - Download subtitle from OpenSubtitles
- `GET /{config}/translate/{videoId}/{targetLang}/select.srt` - Subtitle selection page
- `GET /{config}/translate/{videoId}/{targetLang}/{fileId}.srt` - Translate and serve

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

MIT License - feel free to use this project for personal or commercial purposes.

## 🙏 Credits

- [Stremio Addon SDK](https://github.com/Stremio/stremio-addon-sdk)
- [OpenSubtitles API](https://www.opensubtitles.com)
- [Google Gemini](https://ai.google.dev)

## 🎉 Features in Action

### Beautiful Configuration Page
- Gradient design with smooth animations
- Quick selection buttons for common languages
- Real-time model loading from Gemini API
- Responsive layout for all devices

### Smart Translation System
- Caches subtitles to avoid repeated API calls
- Chunks large subtitles for better processing
- Preserves SRT formatting and timing
- Handles special characters and formatting tags

### User-Friendly Interface
- Clear language selection with flags
- One-click installation to Stremio
- Copy-to-clipboard functionality
- Helpful status messages and error handling

---

Made with ❤️ for the Stremio community
