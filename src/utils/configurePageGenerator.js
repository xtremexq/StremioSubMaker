const fs = require('fs');
const path = require('path');

const { getLanguageSelectionLimits } = require('./config');
const { version } = require('./version');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'public', 'configure.html');
const APP_VERSION_JSON_TOKEN = '__APP_VERSION_JSON__';
const APP_VERSION_QUERY_TOKEN = '__APP_VERSION_QUERY__';
const CONFIG_LIMITS_JSON_TOKEN = '__CONFIG_LIMITS_JSON__';
const INLINE_PARTIALS = [
  {
    token: '__CONFIGURE_MAIN_PARTIAL__',
    filePath: path.join(__dirname, '..', '..', 'public', 'partials', 'main.html')
  },
  {
    token: '__CONFIGURE_FOOTER_PARTIAL__',
    filePath: path.join(__dirname, '..', '..', 'public', 'partials', 'footer.html')
  },
  {
    token: '__CONFIGURE_OVERLAYS_PARTIAL__',
    filePath: path.join(__dirname, '..', '..', 'public', 'partials', 'overlays.html')
  },
  {
    token: '__CONFIGURE_QUICK_SETUP_PARTIAL__',
    filePath: path.join(__dirname, '..', '..', 'public', 'partials', 'quick-setup.html')
  }
];

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loadTemplate() {
  return fs.readFileSync(TEMPLATE_PATH, 'utf8');
}

function escapeJsonForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeJsSingleQuotedString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function renderConfigurePage() {
  const appVersion = version || 'dev';
  const languageLimits = getLanguageSelectionLimits();
  let template = loadTemplate();

  INLINE_PARTIALS.forEach(({ token, filePath }) => {
    template = template.split(token).join(fs.readFileSync(filePath, 'utf8'));
  });

  return template
    .split(APP_VERSION_JSON_TOKEN).join(`'${escapeJsSingleQuotedString(appVersion)}'`)
    .split(APP_VERSION_QUERY_TOKEN).join(escapeHtml(encodeURIComponent(appVersion)))
    .split(CONFIG_LIMITS_JSON_TOKEN).join(escapeJsonForInlineScript(languageLimits));
}

const CACHED_CONFIGURE_PAGE = renderConfigurePage();

function generateConfigurePage() {
  return CACHED_CONFIGURE_PAGE;
}

module.exports = { generateConfigurePage };
