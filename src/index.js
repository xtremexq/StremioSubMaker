const { addonBuilder, serveHTTP, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const fs = require('fs');
const path = require('path');
const SubtitleHandler = require('./subtitleHandler');
const GeminiAPI = require('./gemini');
const { getAllLanguages } = require('./languages');

const PORT = process.env.PORT || 7000;

// Serve configuration page
const configPage = fs.readFileSync(path.join(__dirname, 'config.html'), 'utf8');

// Parse configuration from base64 encoded string
function parseConfig(configString) {
  try {
    const decoded = Buffer.from(configString, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (error) {
    console.error('Error parsing config:', error);
    return null;
  }
}

// Create addon manifest
function createManifest(config = {}) {
  return {
    id: 'org.stremio.subtitletranslator',
    version: '1.0.0',
    name: 'Subtitle Translator',
    description: 'Fetches subtitles from OpenSubtitles and translates them using AI',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt'],
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    }
  };
}

// Create addon builder with config
function createAddonBuilder(config) {
  const manifest = createManifest(config);
  const builder = new addonBuilder(manifest);

  // Add addon URL to config
  if (config && config.addonUrl) {
    // Config already has addon URL
  }

  // Create subtitle handler
  const subtitleHandler = new SubtitleHandler(config || {});

  // Define subtitles handler
  builder.defineSubtitlesHandler(async (args) => {
    try {
      const { type, id } = args;
      console.log(`Subtitle request: type=${type}, id=${id}`);

      const result = await subtitleHandler.getSubtitles(type, id);
      console.log(`Returning ${result.subtitles?.length || 0} subtitles`);

      return Promise.resolve(result);
    } catch (error) {
      console.error('Error in subtitles handler:', error);
      return Promise.resolve({ subtitles: [] });
    }
  });

  return builder;
}

// Main Express app setup for custom routes
const app = express();
app.use(express.json());

// Enable CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

// Root - serve configuration page
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(configPage);
});

app.get('/configure', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(configPage);
});

// API: Get languages
app.get('/api/languages', (req, res) => {
  res.json(getAllLanguages());
});

// API: Get Gemini models
app.post('/api/gemini-models', async (req, res) => {
  try {
    const { apiKey } = req.body;
    const geminiAPI = new GeminiAPI(apiKey);
    const models = await geminiAPI.listModels();
    res.json(models);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Custom routes for subtitle downloads and translations
app.get('/:config/subtitle/:fileId', async (req, res) => {
  const { config: configString, fileId } = req.params;
  const filename = `${fileId}.srt`;

  const config = parseConfig(configString);
  if (!config) {
    res.status(400).send('Invalid configuration');
    return;
  }

  const subtitleHandler = new SubtitleHandler(config);

  try {
    const content = await subtitleHandler.getSubtitleContent(fileId);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  } catch (error) {
    console.error('Error downloading subtitle:', error);
    res.status(500).send('Error downloading subtitle');
  }
});

// Translation selection page
app.get('/:config/translate/:videoId/:targetLang/select.srt', async (req, res) => {
  const { config: configString, videoId, targetLang } = req.params;

  const config = parseConfig(configString);
  if (!config) {
    res.status(400).send('Invalid configuration');
    return;
  }

  // Add addon URL to config
  config.addonUrl = `${req.protocol}://${req.get('host')}/${configString}`;

  const subtitleHandler = new SubtitleHandler(config);

  // Parse video ID to get search parameters
  const videoParts = videoId.split(':');
  const imdbId = videoParts[0];
  const season = videoParts[1];
  const episode = videoParts[2];

  const videoType = season && episode ? 'episode' : 'movie';

  try {
    // Fetch available subtitles
    const searchParams = {
      imdb_id: imdbId,
      type: videoType,
      languages: config.sourceLanguages
    };

    if (videoType === 'episode') {
      searchParams.season_number = parseInt(season);
      searchParams.episode_number = parseInt(episode);
    }

    const subtitles = await subtitleHandler.fetchSubtitles(searchParams);

    // Generate selection HTML
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Select Subtitle to Translate</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
      margin: 0;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
      background: white;
      border-radius: 15px;
      padding: 30px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.3);
    }
    h1 {
      color: #667eea;
      margin-bottom: 20px;
    }
    .subtitle-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .subtitle-item {
      padding: 15px;
      background: #f8f9fa;
      border-radius: 10px;
      border: 2px solid #e0e0e0;
      cursor: pointer;
      transition: all 0.3s ease;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .subtitle-item:hover {
      border-color: #667eea;
      transform: translateX(5px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.2);
    }
    .subtitle-info {
      flex: 1;
    }
    .subtitle-name {
      font-weight: 600;
      color: #333;
      margin-bottom: 5px;
    }
    .subtitle-meta {
      font-size: 0.9em;
      color: #666;
    }
    .translate-btn {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
      transition: all 0.3s ease;
    }
    .translate-btn:hover {
      transform: scale(1.05);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    }
    .loading {
      text-align: center;
      padding: 40px;
      color: #667eea;
      font-size: 1.2em;
    }
    .error {
      background: #f8d7da;
      color: #721c24;
      padding: 15px;
      border-radius: 10px;
      border: 2px solid #f5c6cb;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🌐 Select Subtitle to Translate</h1>
    <div id="content">
      ${subtitles.length === 0 ? '<p class="error">No subtitles found for translation.</p>' : `
        <div class="subtitle-list">
          ${subtitles.map(sub => {
            const attrs = sub.attributes;
            const fileId = attrs.files[0].file_id;
            const lang = attrs.language;
            const name = attrs.release || attrs.feature_details?.movie_name || 'Unknown';
            return `
              <div class="subtitle-item">
                <div class="subtitle-info">
                  <div class="subtitle-name">${name}</div>
                  <div class="subtitle-meta">Language: ${lang} | Downloads: ${attrs.download_count || 0}</div>
                </div>
                <button class="translate-btn" onclick="translateSubtitle('${fileId}', '${targetLang}')">
                  Translate
                </button>
              </div>
            `;
          }).join('')}
        </div>
      `}
    </div>
  </div>
  <script>
    async function translateSubtitle(fileId, targetLang) {
      const btn = event.target;
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Translating...';

      try {
        // Download the translated subtitle
        const url = window.location.pathname.replace('select.srt', fileId + '.srt');
        window.location.href = url;

        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = originalText;
        }, 2000);
      } catch (error) {
        alert('Translation failed: ' + error.message);
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    console.error('Error generating selection page:', error);
    res.status(500).send('Error loading subtitles');
  }
});

// Translate and serve subtitle
app.get('/:config/translate/:videoId/:targetLang/:fileId', async (req, res) => {
  const { config: configString, videoId, targetLang, fileId } = req.params;
  const sourceFileId = fileId.replace('.srt', '');

  const config = parseConfig(configString);
  if (!config) {
    res.status(400).send('Invalid configuration');
    return;
  }

  const subtitleHandler = new SubtitleHandler(config);

  try {
    // Download source subtitle
    const sourceContent = await subtitleHandler.getSubtitleContent(sourceFileId);

    // Determine source language from the subtitle metadata
    // For now, we'll use 'auto' or the first source language
    const sourceLang = config.sourceLanguages[0] || 'eng';

    // Translate
    const translatedContent = await subtitleHandler.translateSubtitle(
      sourceContent,
      sourceLang,
      targetLang
    );

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="translated_${fileId}"`);
    res.send(translatedContent);
  } catch (error) {
    console.error('Error translating subtitle:', error);
    res.status(500).send('Error translating subtitle: ' + error.message);
  }
});

// Mount Stremio addon routes with configuration
app.use('/:config', (req, res, next) => {
  const configString = req.params.config;

  // Skip if this is one of our custom routes
  if (req.path.startsWith('/subtitle/') ||
      req.path.startsWith('/translate/')) {
    next('route');
    return;
  }

  const config = parseConfig(configString);
  if (!config) {
    res.status(400).send('Invalid configuration');
    return;
  }

  // Add addon URL to config
  config.addonUrl = `${req.protocol}://${req.get('host')}/${configString}`;

  // Create addon builder with this config
  const builder = createAddonBuilder(config);
  const addonRouter = getRouter(builder.getInterface());

  // Use the addon router for this request
  addonRouter(req, res, next);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Stremio Subtitle Translator Addon running on http://localhost:${PORT}`);
  console.log(`📝 Configure your addon at http://localhost:${PORT}/configure`);
});
