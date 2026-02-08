# Contributing to SubMaker

Thanks for your interest in contributing to SubMaker! 🎬

## Getting Started

### Development Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/xtremexq/StremioSubMaker.git
   cd StremioSubMaker
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env with your API keys
   ```

4. **Start development server**
   ```bash
   npm run dev
   ```

### Prerequisites

- Node.js 18+
- API keys for subtitle sources (OpenSubtitles, SubDL, SubSource)
- Gemini API key (or alternative AI provider)

## How to Contribute

### Reporting Bugs

- Use the [Bug Report](https://github.com/xtremexq/StremioSubMaker/issues/new?template=bug_report.yml) template
- Include your SubMaker version, Node.js version, and device/platform
- Provide steps to reproduce and any relevant logs

### Suggesting Features

- Use the [Feature Request](https://github.com/xtremexq/StremioSubMaker/issues/new?template=feature_request.yml) template
- Describe the problem you're trying to solve
- Explain your proposed solution

### Submitting Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes
4. Test your changes locally
5. Commit with a clear message
6. Push and open a Pull Request

### Code Style

- Use consistent indentation (2 spaces)
- Add comments for complex logic
- Keep functions focused and readable
- Update `CHANGELOG.md` for notable changes

## Adding Translations (Localization)

SubMaker supports multiple UI languages via the `locales/` folder.

1. Copy `locales/en.json` to `locales/<language-code>.json`
2. Translate the `messages` values (keep keys and placeholders like `{provider}` intact)
3. Update the `lang` field with the language name
4. Submit a PR with your translation

## Questions?

- Open a [Question](https://github.com/xtremexq/StremioSubMaker/issues/new?template=question.yml) issue
- Check existing issues for similar questions
- Join the Stremio community on Discord/Reddit

---

Thanks for helping make SubMaker better! ❤️
