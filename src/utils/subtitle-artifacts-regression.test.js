const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeSubtitleText } = require('./subtitle');

test('subtitle text cleanup removes duplicated apostrophe artifacts without changing valid accents', () => {
  assert.equal(sanitizeSubtitleText("I'm I'’m I'´m"), "I'm I'm I'm");
  assert.equal(sanitizeSubtitleText("No, he'’s kidding. l’amour d’ete"), "No, he's kidding. l’amour d’ete");
});

test('subtitle text cleanup decodes common named and numeric entities', () => {
  assert.equal(
    sanitizeSubtitleText("I&apos;m &#39;ready&#39; &amp; <3 &#x2019;ok&#x2019;"),
    "I'm 'ready' & <3 ’ok’"
  );
});
