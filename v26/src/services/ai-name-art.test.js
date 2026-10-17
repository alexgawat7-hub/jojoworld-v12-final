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


test('restores artwork from persistent storage without an API key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jojoworld-ai-art-store-'));
  const stored = Buffer.alloc(2048, 7);
  try {
    const result = await getNameEffectArtwork('gold', dir, {
      apiKey: '',
      loadFromStore: async effect => {
        assert.equal(effect, 'gold');
        return stored;
      },
      client: { post: () => { throw new Error('should not call provider'); } }
    });
    assert.equal(result, path.join(dir, 'ai_name_art_v1_gold.png'));
    assert.deepEqual(fs.readFileSync(result), stored);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saves newly generated artwork to persistent storage when a provider is configured', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jojoworld-ai-art-save-'));
  const stored = Buffer.alloc(2048, 9);
  let savedEffect = null;
  let savedBytes = null;
  try {
    const result = await getNameEffectArtwork('gold', dir, {
      apiKey: 'unit-test-key',
      client: { post: async () => ({ data: { data: [{ b64_json: stored.toString('base64') }] } }) },
      saveToStore: async (effect, bytes) => { savedEffect = effect; savedBytes = bytes; }
    });
    assert.equal(result, path.join(dir, 'ai_name_art_v1_gold.png'));
    assert.equal(savedEffect, 'gold');
    assert.deepEqual(savedBytes, stored);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
