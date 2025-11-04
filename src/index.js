const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
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
function createManifest(config) {
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

// Main server setup
const server = require('http').createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Root - serve configuration page
  if (pathname === '/' || pathname === '/configure') {
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end(configPage);
    return;
  }

  // API: Get languages
  if (pathname === '/api/languages') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(getAllLanguages()));
    return;
  }

  // API: Get Gemini models
  if (pathname === '/api/gemini-models' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { apiKey } = JSON.parse(body);
        const geminiAPI = new GeminiAPI(apiKey);
        const models = await geminiAPI.listModels();
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify(models));
      } catch (error) {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(500);
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    return;
  }

  // Parse config from URL
  const pathParts = pathname.split('/').filter(p => p);
  if (pathParts.length < 2) {
    res.writeHead(404);
    res.end('Not found - Please configure the addon first');
    return;
  }

  const configString = pathParts[0];
  const config = parseConfig(configString);

  if (!config) {
    res.writeHead(400);
    res.end('Invalid configuration');
    return;
  }

  // Add addon URL to config
  config.addonUrl = `http://${req.headers.host}/${configString}`;

  // Create subtitle handler
  const subtitleHandler = new SubtitleHandler(config);

  // Manifest
  if (pathParts[1] === 'manifest.json') {
    const manifest = createManifest(config);
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(manifest));
    return;
  }

  // Subtitles endpoint
  if (pathParts[1] === 'subtitles') {
    const type = pathParts[2]; // movie or series
    const id = pathParts[3].replace('.json', ''); // e.g., tt1234567 or tt1234567:1:1

    try {
      const subtitles = await subtitleHandler.getSubtitles(type, id);
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify(subtitles));
    } catch (error) {
      console.error('Error getting subtitles:', error);
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(500);
      res.end(JSON.stringify({ subtitles: [] }));
    }
    return;
  }

  // Download subtitle from OpenSubtitles
  if (pathParts[1] === 'subtitle') {
    const filename = pathParts[2];
    const fileId = filename.replace('.srt', '');

    try {
      const content = await subtitleHandler.getSubtitleContent(fileId);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.writeHead(200);
      res.end(content);
    } catch (error) {
      console.error('Error downloading subtitle:', error);
      res.writeHead(500);
      res.end('Error downloading subtitle');
    }
    return;
  }

  // Translation selection page
  if (pathParts[1] === 'translate') {
    const videoId = pathParts[2]; // e.g., tt1234567:1:1
    const targetLang = pathParts[3];
    const filename = pathParts[4]; // select.srt

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
      res.writeHead(200);
      res.end(html);
    } catch (error) {
      console.error('Error generating selection page:', error);
      res.writeHead(500);
      res.end('Error loading subtitles');
    }
    return;
  }

  // Translate and serve subtitle
  if (pathParts[1] === 'translate' && pathParts.length >= 5) {
    const videoId = pathParts[2];
    const targetLang = pathParts[3];
    const filename = pathParts[4];
    const sourceFileId = filename.replace('.srt', '');

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
      res.setHeader('Content-Disposition', `attachment; filename="translated_${filename}"`);
      res.writeHead(200);
      res.end(translatedContent);
    } catch (error) {
      console.error('Error translating subtitle:', error);
      res.writeHead(500);
      res.end('Error translating subtitle: ' + error.message);
    }
    return;
  }

  // Not found
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`🚀 Stremio Subtitle Translator Addon running on http://localhost:${PORT}`);
  console.log(`📝 Configure your addon at http://localhost:${PORT}/configure`);
});
