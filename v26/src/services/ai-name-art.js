// AI-generated artwork provider for JojoWorld name effects.
// The provider is optional until OPENAI_API_KEY is configured on the host.
// Generated art is cached per effect, so API calls happen at most once per effect per cache lifetime.
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const EFFECT_PROMPTS = {
  rainbow: 'luxury fantasy rainbow aurora ribbons, prismatic glass shards, iridescent crystals and elegant luminous particles, premium game cosmetic background, vivid but tasteful, dark midnight backdrop',
  sparkle: 'premium celestial stardust, brilliant crystal stars, pearlescent sparkles, fine gold dust and magical glints, luxury collectible game cosmetic background, midnight backdrop',
  heart: 'luxury romantic rose-pink crystal hearts, glowing satin ribbons, tiny gem highlights and elegant rose petals, premium collectible game cosmetic background, dark velvet backdrop',
  fire: 'dramatic blazing orange and scarlet flames, molten embers, sparks and heat shimmer, premium fantasy game cosmetic background, dark charcoal backdrop',
  ice: 'intricate translucent ice crystals, frozen blue glass, delicate snowflakes and arctic light rays, premium fantasy game cosmetic background, deep navy backdrop',
  neon: 'futuristic cyan and magenta neon circuitry, electric plasma arcs, luminous glass tubes and cyberpunk light trails, premium game cosmetic background, near-black backdrop',
  blossom: 'luxury sakura blossoms, glowing pink petals, soft rose-gold motes and delicate magical branches, premium fantasy game cosmetic background, deep plum backdrop',
  dark: 'mysterious violet shadow smoke, obsidian shards, amethyst crystals and subtle arcane particles, premium dark fantasy game cosmetic background, near-black backdrop',
  red: 'polished ruby shards, scarlet energy ribbons, red glass reflections and elegant crimson particles, premium collectible game cosmetic background, dark backdrop',
  blue: 'sapphire crystal shards, flowing electric-blue energy ribbons and icy blue highlights, premium collectible game cosmetic background, deep navy backdrop',
  green: 'emerald crystals, jade energy wisps, luminous green particles and elegant botanical light, premium collectible game cosmetic background, dark forest backdrop',
  yellow: 'bright citrine crystals, golden-yellow energy ribbons, radiant sun sparks and polished amber reflections, premium collectible game cosmetic background, deep charcoal backdrop',
  gold: 'regal liquid gold, ornate royal filigree, sculpted gold crown details, champagne-gold rays and brilliant jewel glints, premium legendary collectible game cosmetic background, black velvet backdrop',
  demon: 'infernal crimson flames, dark red smoke, obsidian horns, sharp ruby shards and ominous ember sparks, premium mythic dark-fantasy collectible game cosmetic background, near-black backdrop'
};

const inFlight = new Map();
const retryAfter = new Map();
const RETRY_COOLDOWN_MS = 60_000;

function isConfigured(options = {}) {
  return Boolean(String(options.apiKey ?? process.env.OPENAI_API_KEY ?? '').trim());
}

function cachedArtworkPath(effect, cacheDir) {
  const key = String(effect || '').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(EFFECT_PROMPTS, key)) return null;
  return path.join(cacheDir, 'ai_name_art_v1_' + key + '.png');
}

function hasUsableCachedArtwork(file) {
  if (!file) return false;
  try {
    return fs.statSync(file).isFile() && fs.statSync(file).size >= 1024;
  } catch (_) {
    return false;
  }
}

function getCachedNameEffectArtwork(effect, cacheDir) {
  const file = cachedArtworkPath(effect, cacheDir);
  return hasUsableCachedArtwork(file) ? file : null;
}

// Restore a previously saved image without ever calling the paid image provider.
async function restoreCachedNameEffectArtwork(effect, cacheDir, options = {}) {
  const file = cachedArtworkPath(effect, cacheDir);
  if (!file) return null;
  if (hasUsableCachedArtwork(file)) return file;
  if (fs.existsSync(file)) {
    try { await fs.promises.unlink(file); }
    catch (error) { console.warn('[AI NAME ART] Could not remove incomplete local cache for ' + String(effect) + ':', error.message); }
  }
  if (typeof options.loadFromStore !== 'function') return null;
  try {
    const stored = await options.loadFromStore(String(effect).toLowerCase());
    const bytes = Buffer.isBuffer(stored) ? stored : (stored ? Buffer.from(stored) : null);
    if (!bytes || bytes.length < 1024) return null;
    await fs.promises.mkdir(cacheDir, { recursive: true });
    await fs.promises.writeFile(file, bytes);
    console.log('[AI NAME ART] Restored profile artwork from persistent storage:', String(effect).toLowerCase());
    return hasUsableCachedArtwork(file) ? file : null;
  } catch (error) {
    console.warn('[AI NAME ART] Profile artwork restore failed for ' + String(effect) + ':', error.message);
    return null;
  }
}

async function getNameEffectArtwork(effect, cacheDir, options = {}) {
  const key = String(effect || '').toLowerCase();
  const file = cachedArtworkPath(key, cacheDir);
  if (!file) return null;
  if (hasUsableCachedArtwork(file)) return file;
  // Recover from an interrupted/partial cache restore instead of reusing a broken image forever.
  if (fs.existsSync(file)) {
    try {
      await fs.promises.unlink(file);
      console.warn('[AI NAME ART] Removed incomplete local artwork cache:', key);
    } catch (error) {
      console.warn('[AI NAME ART] Could not remove incomplete local cache for ' + key + ':', error.message);
    }
  }

  // MongoDB/GridFS is the durable cache; restore artwork before considering paid generation.
  if (typeof options.loadFromStore === 'function') {
    try {
      const stored = await options.loadFromStore(key);
      const bytes = Buffer.isBuffer(stored) ? stored : (stored ? Buffer.from(stored) : null);
      if (bytes && bytes.length >= 1024) {
        await fs.promises.mkdir(cacheDir, { recursive: true });
        await fs.promises.writeFile(file, bytes);
        console.log('[AI NAME ART] Restored artwork from persistent storage:', key);
        return file;
      }
    } catch (error) {
      console.warn('[AI NAME ART] Persistent cache read failed for ' + key + ':', error.message);
    }
  }

  const apiKey = String(options.apiKey ?? process.env.OPENAI_API_KEY ?? '').trim();
  if (!apiKey) return null;
  const cooldownKey = key + ':' + apiKey.slice(-6);
  if ((retryAfter.get(cooldownKey) || 0) > Date.now()) return null;
  if (inFlight.has(file)) return inFlight.get(file);

  const task = (async () => {
    try {
      await fs.promises.mkdir(cacheDir, { recursive: true });
      const model = String(options.model || process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5').trim();
      const quality = String(options.quality || process.env.OPENAI_IMAGE_QUALITY || 'low').trim();
      const prompt = [
        'Create one polished, high-end collectible visual effect artwork for a social gaming profile.',
        EFFECT_PROMPTS[key],
        'Composition: portrait-friendly square 1:1 image, ornate and visually rich edges, a clear darker central horizontal area where a real user name will be overlaid later by software.',
        'No letters, no words, no typography, no logos, no watermarks, no UI panels, no frames around the whole image.',
        'Crisp detailed digital illustration, premium game cosmetic concept art, strong material detail, controlled glow, professional lighting.'
      ].join(' ');
      const response = await (options.client || axios).post(
        'https://api.openai.com/v1/images/generations',
        { model, prompt, n: 1, size: '1024x1024', quality, output_format: 'png', background: 'opaque' },
        {
          headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
          timeout: 180000,
          maxContentLength: 25 * 1024 * 1024,
          maxBodyLength: 2 * 1024 * 1024
        }
      );
      const encoded = response?.data?.data?.[0]?.b64_json;
      if (!encoded || typeof encoded !== 'string') throw new Error('Image provider returned no base64 image data');
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length < 1024) throw new Error('Image provider returned an unexpectedly small image');
      const temp = file + '.' + process.pid + '.tmp';
      await fs.promises.writeFile(temp, bytes, { flag: 'wx' }).catch(async error => {
        if (error.code !== 'EEXIST') throw error;
        await fs.promises.unlink(temp).catch(() => {});
        await fs.promises.writeFile(temp, bytes, { flag: 'wx' });
      });
      await fs.promises.rename(temp, file).catch(async error => {
        if (error.code === 'EEXIST' || error.code === 'EPERM') {
          await fs.promises.unlink(temp).catch(() => {});
          if (!fs.existsSync(file)) throw error;
        } else throw error;
      });
      if (typeof options.saveToStore === 'function') {
        try {
          await options.saveToStore(key, bytes);
          console.log('[AI NAME ART] Saved artwork to persistent storage:', key);
        } catch (storageError) {
          // Local cache remains usable if durable storage is temporarily unavailable.
          console.warn('[AI NAME ART] Persistent cache write failed for ' + key + ':', storageError.message);
        }
      }
      retryAfter.delete(cooldownKey);
      console.log('[AI NAME ART] Generated and cached artwork for effect:', key);
      return fs.existsSync(file) ? file : null;
    } catch (error) {
      retryAfter.set(cooldownKey, Date.now() + RETRY_COOLDOWN_MS);
      console.error('[AI NAME ART] Generation failed for ' + key + ':', error.response?.data?.error?.message || error.message);
      return null;
    } finally {
      inFlight.delete(file);
    }
  })();

  inFlight.set(file, task);
  return task;
}

module.exports = { EFFECT_PROMPTS, isConfigured, getCachedNameEffectArtwork, restoreCachedNameEffectArtwork, getNameEffectArtwork };
