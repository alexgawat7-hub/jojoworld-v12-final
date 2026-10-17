const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  EFFECT_PROMPTS,
  getCachedNameEffectArtwork,
  getNameEffectArtwork
} = require('./ai-name-art');

test('defines an art prompt for every supported premium name effect', () => {
  assert.equal(Object.keys(EFFECT_PROMPTS).length, 14);
  for (const key of ['rainbow','sparkle','heart','fire','ice','neon','blossom','dark','red','blue','green','yellow','gold','demon']) {
    assert.ok(EFFECT_PROMPTS[key], 'missing prompt for ' + key);
  }
});

test('does not call a provider when the API key is not configured', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jojoworld-ai-art-'));
  try {
    const result = await getNameEffectArtwork('gold', dir, { apiKey: '', client: { post: () => { throw new Error('should not call provider'); } } });
    assert.equal(result, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects unsupported effects without calling the provider', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jojoworld-ai-art-'));
  try {
    const result = await getNameEffectArtwork('../secrets', dir, { apiKey: 'test-key', client: { post: () => { throw new Error('should not call provider'); } } });
    assert.equal(result, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uses an already-cached effect image without requiring an API key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jojoworld-ai-art-'));
  try {
    const cached = path.join(dir, 'ai_name_art_v1_gold.png');
    fs.writeFileSync(cached, Buffer.from('cached artwork'));
    assert.equal(getCachedNameEffectArtwork('gold', dir), cached);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
