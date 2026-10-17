// ============================================================================
// JOJOWORLD V26 ULTIMATE EVOLUTION - MESSENGER BOT
// ============================================================================
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
// [ADDED] V28 canvas profile and leaderboard rendering.
const { createCanvas, loadImage } = require('canvas');
const path = require('path');
const fsExtra = require('fs-extra');
const mongoose = require('mongoose');
const axios = require('axios');
const crypto = require('crypto');
const { GridFSBucket } = require('mongodb');
const { Readable } = require('stream');
const { verifyPayMongoSignature } = require('./v26/src/security/paymongo');
const { verifyMessengerSignature } = require('./v26/src/security/messenger');
const { GiftHubError, sendGift: applyGift, renderGiftCatalog } = require('./v26/src/services/gifts');
const { isConfigured: isAINameArtConfigured, restoreCachedNameEffectArtwork, getNameEffectArtwork } = require('./v26/src/services/ai-name-art');

// [GLOBAL TEXT CLEANER] Remove private-use icon glyphs and unsupported symbols
// before dynamic user text is drawn on Canvas, for every account.
function cleanText(text) {
  if (!text) return "";
  return text.toString()
    .replace(/[\uE000-\uF8FF]/g, "")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/[^\w\s\-\.]/g, "")
    .trim();
}
function cleanName(name) {
  const cleaned = cleanText(name);
  return cleaned.toUpperCase() || "JOJO MEMBER";
}

// [GLOBAL COSMETIC SOURCE OF TRUTH] Profile and leaderboard use the same saved frame state and colors.
function getEquippedFrameStyle(user = {}) {
  const frameName = cleanText(user.equippedFrame || user.frame || (user.royalFrame ? 'Royalty Frame' : (user.goldFrame ? 'Gold Frame' : 'None'))) || 'None';
  const frameKey = frameName.toLowerCase();
  const royal = !!user.royalFrame || frameKey.includes('royal');
  const gold = !royal && (!!user.goldFrame || frameKey.includes('gold'));
  const diamond = frameKey.includes('diamond');
  const neon = frameKey.includes('neon');
  const silver = frameKey.includes('silver');
  const equipped = frameKey !== 'none' || royal || gold || diamond || neon || silver;
  const color = royal || gold ? '#ffd34f' : diamond ? '#00ffff' : neon ? '#ff00ff' : silver ? '#dce8ff' : '#65eaff';
  const glow = royal || gold ? 'rgba(255,215,0,0.85)' : diamond ? 'rgba(0,255,255,0.85)' : neon ? 'rgba(255,0,255,0.85)' : silver ? 'rgba(220,232,255,0.75)' : '#65eaff';
  return { frameName, frameKey, royal, gold, diamond, neon, silver, equipped, color, glow };
}

// [ADDED] V28 cache directory for generated profile and leaderboard images.
const cacheDir = path.join(__dirname, 'cache');
fsExtra.ensureDirSync(cacheDir);

// Durable AI name-art cache in MongoDB GridFS, separate from user/profile documents.
// MongoDB is already the bot's configured database; no extra connection or API key is needed.
const AI_NAME_ART_BUCKET = 'jojoWorldNameArt';
let aiNameArtBucket = null;
function getAINameArtBucket() {
  if (!MONGODB_URI || mongoose.connection.readyState !== 1 || !mongoose.connection.db) return null;
  if (!aiNameArtBucket) aiNameArtBucket = new GridFSBucket(mongoose.connection.db, { bucketName: AI_NAME_ART_BUCKET });
  return aiNameArtBucket;
}
async function loadAINameArtFromMongo(effect) {
  const bucket = getAINameArtBucket();
  if (!bucket) return null;
  const filename = 'ai_name_art_v1_' + String(effect) + '.png';
  const files = await bucket.find({ filename }).sort({ uploadDate: -1 }).limit(1).toArray();
  if (!files.length) return null;
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = bucket.openDownloadStream(files[0]._id);
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
async function saveAINameArtToMongo(effect, bytes) {
  const bucket = getAINameArtBucket();
  if (!bucket) throw new Error('MongoDB GridFS is not connected');
  const filename = 'ai_name_art_v1_' + String(effect) + '.png';
  const existing = await bucket.find({ filename }).limit(1).toArray();
  if (existing.length) return;
  await new Promise((resolve, reject) => {
    const stream = bucket.openUploadStream(filename, {
      contentType: 'image/png',
      metadata: { type: 'jojoworld-ai-name-art', effect: String(effect), version: 1 }
    });
    stream.on('error', reject);
    stream.on('finish', resolve);
    Readable.from(bytes).pipe(stream);
  });
}


// Reuse decoded profile photos across profile and leaderboard renders.
// This avoids repeatedly decoding the same base64 photo or downloading the same URL.
const decodedProfileImageCache = new Map();
const DECODED_PROFILE_IMAGE_CACHE_LIMIT = 80;
async function loadCachedProfileImage(source, cacheKey) {
  const existing = decodedProfileImageCache.get(cacheKey);
  if (existing) {
    // Refresh insertion order so frequently used photos remain cached.
    decodedProfileImageCache.delete(cacheKey);
    decodedProfileImageCache.set(cacheKey, existing);
    return existing;
  }
  const pending = loadImage(source);
  decodedProfileImageCache.set(cacheKey, pending);
  while (decodedProfileImageCache.size > DECODED_PROFILE_IMAGE_CACHE_LIMIT) {
    decodedProfileImageCache.delete(decodedProfileImageCache.keys().next().value);
  }
  try {
    return await pending;
  } catch (error) {
    if (decodedProfileImageCache.get(cacheKey) === pending) decodedProfileImageCache.delete(cacheKey);
    throw error;
  }
}
function loadCachedProfilePhotoData(base64Data) {
  const hash = crypto.createHash('sha1').update(base64Data).digest('hex');
  return loadCachedProfileImage(Buffer.from(base64Data, 'base64'), 'data:' + hash);
}
function loadCachedProfilePhotoUrl(url) {
  return loadCachedProfileImage(url, 'url:' + String(url));
}
const app = express();

// Body-parser rawBody configuration para sa PayMongo Webhook HMAC signature
app.use(bodyParser.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

function configuredValue(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (/replace_with|replace_me|YOUR_CLUSTER|YOUR_DATABASE/i.test(trimmed) ||
      /^mongodb(?:\+srv)?:\/\/USERNAME:PASSWORD@/i.test(trimmed)) return undefined;
  return trimmed;
}

const GCASH_NUM = configuredValue(process.env.GCASH_NUM);
const PAYMONGO_SECRET = configuredValue(process.env.PAYMONGO_SECRET);
const PAYMONGO_WEBHOOK_SECRET = configuredValue(process.env.PAYMONGO_WEBHOOK_SECRET);
const PAGE_TOKEN = configuredValue(process.env.PAGE_TOKEN);
const VERIFY_TOKEN = configuredValue(process.env.VERIFY_TOKEN);
const META_APP_SECRET = configuredValue(process.env.META_APP_SECRET);
const MONGODB_URI = configuredValue(process.env.MONGODB_URI);

// PAGE NAME FOR MESSENGER LINK
const PAGE_USERNAME = "100064525073153";

const UserSchema = new mongoose.Schema({ psid: { type: String, required: true, unique: true }, data: Object }, { strict: false });
const UserModel = mongoose.models.JUser || mongoose.model('JUser', UserSchema);

const JackpotSchema = new mongoose.Schema({ id: { type: String, required: true, unique: true }, amount: Number }, { strict: false });
const JackpotModel = mongoose.models.JJackpot || mongoose.model('JJackpot', JackpotSchema);

// Unique event IDs prevent the same paid webhook from crediting coins repeatedly.
const PaymentEventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true },
  status: { type: String, enum: ['processing', 'processed'], default: 'processing' },
  psid: String,
  createdAt: { type: Date, default: Date.now }
});
const PaymentEventModel = mongoose.models.JPaymentEvent || mongoose.model('JPaymentEvent', PaymentEventSchema);

// [FIXED] Store each generated PayMongo Link ID against its exact user/package.
// PayMongo link.payment.paid payloads do not reliably include the custom remarks field.
const TopupOrderSchema = new mongoose.Schema({
  linkId: { type: String, required: true, unique: true },
  psid: { type: String, required: true },
  amount: { type: Number, required: true },
  coins: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'processed'], default: 'pending' },
  eventId: { type: String },
  createdAt: { type: Date, default: Date.now }
});
const TopupOrderModel = mongoose.models.JTopupOrder || mongoose.model('JTopupOrder', TopupOrderSchema);

// Messenger may retry delivery of the same message. Keep a unique message ID
// record so a wallet-changing command is not applied twice.
const ProcessedMessengerMessageSchema = new mongoose.Schema({
  messageId: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 }
});
const ProcessedMessengerMessageModel = mongoose.models.JProcessedMessengerMessage ||
  mongoose.model('JProcessedMessengerMessage', ProcessedMessengerMessageSchema);
const processedMessengerMessages = new Set();

// Serialize commands per Messenger user, while allowing different users to be processed concurrently.
const messengerUserQueues = new Map();

let db = { users: {}, jackpotPool: 1500 };

if (fs.existsSync('./db.json')) {
  try {
    const localDb = JSON.parse(fs.readFileSync('./db.json'));
    if (localDb.users) db.users = localDb.users;
    if (localDb.jackpotPool) db.jackpotPool = localDb.jackpotPool;
  } catch (e) {
    console.error("Could not read local db.json; starting with an empty local cache:", e.message);
  }
}

// ================= MONGODB SETUP & STARTUP LOADER =================
if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(async () => {
      console.log("✅ MongoDB Connected Successfully");
      try {
        const jackpotDoc = await JackpotModel.findOne({ id: "global" });
        if (jackpotDoc && Number.isFinite(jackpotDoc.amount)) {
          db.jackpotPool = jackpotDoc.amount;
          console.log("🏆 Jackpot Pool loaded from DB:", db.jackpotPool);
        }
      } catch (e) {
        console.log("Error loading jackpot:", e.message);
      }
    })
    .catch(e => console.log("❌ MongoDB Error:", e.message));
}

// ================= DB PERSISTENCE HELPERS =================
async function loadUserFromDB(psid) {
  if (MONGODB_URI && mongoose.connection.readyState === 1) {
    try {
      const doc = await UserModel.findOne({ psid });
      if (doc && doc.data) {
        db.users[psid] = doc.data;
        return db.users[psid];
      }
    } catch (e) {
      console.log("Error loading user:", e.message);
    }
  }
  return db.users[psid] || null;
}

async function saveUserToDB(psid, { saveJackpot = false } = {}) {
  if (MONGODB_URI) {
    if (mongoose.connection.readyState !== 1) {
      console.error("Database save skipped: MongoDB is configured but not connected.");
      return false;
    }
    if (saveJackpot) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await JackpotModel.findOneAndUpdate(
            { id: "global" },
            { $set: { id: "global", amount: db.jackpotPool } },
            { upsert: true, runValidators: true, session }
          );
          if (db.users[psid]) {
            await UserModel.findOneAndUpdate(
              { psid },
              { $set: { psid, data: db.users[psid] } },
              { upsert: true, new: true, runValidators: true, session }
            );
          }
        });
      } catch (e) {
        console.error("MongoDB transaction failed while saving user:", e.message);
        return false;
      } finally {
        await session.endSession();
      }
    } else {
      try {
        if (db.users[psid]) {
          await UserModel.findOneAndUpdate(
            { psid },
            { $set: { psid, data: db.users[psid] } },
            { upsert: true, new: true, runValidators: true }
          );
        }
      } catch (e) {
        console.error("MongoDB user save failed:", e.message);
        return false;
      }
    }
  }

  try {
    fs.writeFileSync('./db.json', JSON.stringify(db, null, 2));
  } catch (e) {
    console.error("Error saving local database file:", e.message);
    if (!MONGODB_URI) return false;
  }
  return true;
}

// Persist paired account changes together to prevent one-sided chat or wallet state.
async function saveUserPair(senderPsid, recipientPsid) {
  if (MONGODB_URI) {
    if (mongoose.connection.readyState !== 1) return false;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await UserModel.updateOne(
          { psid: senderPsid },
          { $set: { psid: senderPsid, data: db.users[senderPsid] } },
          { upsert: true, session }
        );
        await UserModel.updateOne(
          { psid: recipientPsid },
          { $set: { psid: recipientPsid, data: db.users[recipientPsid] } },
          { upsert: true, session }
        );
      });
    } catch (error) {
      console.error("Gift transfer transaction failed:", error.message);
      return false;
    } finally {
      await session.endSession();
    }
  }

  try {
    fs.writeFileSync('./db.json', JSON.stringify(db, null, 2));
  } catch (error) {
    console.error("Gift transfer local snapshot failed:", error.message);
    if (!MONGODB_URI) return false;
  }
  return true;
}

const TOPUP_RATES = { 20: 120, 50: 300, 80: 500, 100: 700, 200: 1600, 500: 4500 };

// Shared V26 Gift Hub catalog keeps Messenger prices in sync with tests.

// [ADDED] [UPGRADED V28] House tiers, values, flex labels, tax, and canvas helpers.
const HOUSE_CONFIG = {
  none: { tier: 0, value: 0, price: 0, tax: 0, badge: '' },
  kubo: { tier: 1, value: 1500, price: 1500, tax: 20, badge: '🛖' },
  bahay: { tier: 2, value: 6500, price: 5000, tax: 100, badge: '🏠' },
  mansion: { tier: 3, value: 21500, price: 15000, tax: 350, badge: '🏰' },
  building: { tier: 4, value: 61500, price: 40000, tax: 1000, badge: '🏢' }
};
const HOUSE_REQUIREMENTS = { kubo: 'none', bahay: 'kubo', mansion: 'bahay', building: 'mansion' };
const FLEX_BADGES = { rainbow: '🌈 [RARE]', sparkle: '✨ [MYTHIC]', heart: '💖 [LOVE]', fire: '🔥 [HOT]', ice: '❄️ [COLD]', neon: '⚡ [NEON]', blossom: '🌸 [CUTE]', dark: '🖤 [DARK]', red: '🔴', blue: '🔵', green: '🟢', yellow: '🟡', gold: '👑 [GOLD]', demon: '😈 [DEMON]' };
function getHouseTier(house = 'none') { return HOUSE_CONFIG[String(house).toLowerCase()]?.tier ?? 0; }
function getHouseValue(house = 'none') { return HOUSE_CONFIG[String(house).toLowerCase()]?.value ?? 0; }

// PROFILE LEVEL + XP: every level requires 100 more XP than the previous one.
// Total XP is stored on the existing user data object, so MongoDB/local persistence stays compatible.
function getProfileLevelStats(totalXp = 0) {
  const xp = Math.max(0, Math.min(1000000000, Math.floor(Number(totalXp) || 0)));
  const level = Math.floor((Math.sqrt(1 + (8 * xp) / 100) - 1) / 2) + 1;
  const xpSpent = (100 * (level - 1) * level) / 2;
  const currentXp = xp - xpSpent;
  const nextLevelXp = level * 100;
  return { totalXp: xp, level, currentXp, nextLevelXp, progress: currentXp / nextLevelXp };
}


// ACHIEVEMENTS & TROPHY SHOWCASE: derived from existing saved user stats.
// This adds no new collection and does not alter wallet or payment logic.
function getProfileAchievements(user = {}) {
  const levelStats = getProfileLevelStats(user.xp);
  const coins = Math.max(0, Number(user.coins) || 0);
  const referrals = Math.max(0, Number(user.refCount) || 0);
  const scatterWins = Math.max(0, Number(user.scatterWins) || 0);
  const views = Math.max(0, Number(user.views) || 0);
  const houseTier = getHouseTier(user.house);
  const hasEffect = Boolean(user.nameEffect && user.nameEffect !== 'none');
  return [
    { id: 'registered', title: 'First Steps', icon: '🌱', description: 'Become a registered JojoWorld member', unlocked: user.registered === true },
    { id: 'level5', title: 'Rising Star', icon: '⭐', description: 'Reach Level 5', unlocked: levelStats.level >= 5 },
    { id: 'level10', title: 'Elite Climber', icon: '🌟', description: 'Reach Level 10', unlocked: levelStats.level >= 10 },
    { id: 'coins1000', title: 'Coin Collector', icon: '🪙', description: 'Hold 1,000 coins or more', unlocked: coins >= 1000 },
    { id: 'coins10000', title: 'Treasure Keeper', icon: '💰', description: 'Hold 10,000 coins or more', unlocked: coins >= 10000 },
    { id: 'house', title: 'Homeowner', icon: '🏠', description: 'Own a JojoWorld house', unlocked: houseTier >= 1 },
    { id: 'mansion', title: 'Property Tycoon', icon: '🏰', description: 'Own a mansion or building', unlocked: houseTier >= 3 },
    { id: 'referral', title: 'Community Builder', icon: '🤝', description: 'Invite at least 3 registered members', unlocked: referrals >= 3 },
    { id: 'scatter', title: 'Lucky Winner', icon: '🎰', description: 'Win 5 Scatter games', unlocked: scatterWins >= 5 },
    { id: 'style', title: 'Style Icon', icon: '✨', description: 'Equip a name effect', unlocked: hasEffect },
    { id: 'vip', title: 'VIP Elite', icon: '👑', description: 'Own the VIP profile badge', unlocked: Boolean(user.vip || String(user.badge || '').toLowerCase().includes('vip')) },
    { id: 'profileviews', title: 'In the Spotlight', icon: '📸', description: 'Open your profile 10 times', unlocked: views >= 10 }
  ];
}

function drawHouseArt(ctx, house, x, y, w, h) {
  const key = String(house || 'none').toLowerCase();
  const palette = {
    kubo: { main: '#c99a5d', dark: '#74482b', roof: '#e5bd79', glow: '#ffe0a0' },
    bahay: { main: '#e9d4a8', dark: '#80563c', roof: '#52bfff', glow: '#72eaff' },
    mansion: { main: '#d8c3ff', dark: '#604a88', roof: '#a879ff', glow: '#e2baff' },
    building: { main: '#6fe8ff', dark: '#183b65', roof: '#ffd34f', glow: '#5df6ff' }
  }[key];
  if (!palette) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.shadowColor = palette.glow;
  ctx.shadowBlur = Math.max(3, Math.min(14, w * 0.09));
  const baseY = h * 0.43;
  if (key === 'kubo') {
    ctx.fillStyle = palette.roof;
    ctx.beginPath(); ctx.moveTo(w*.08,baseY); ctx.lineTo(w*.5,h*.05); ctx.lineTo(w*.92,baseY); ctx.closePath(); ctx.fill();
    ctx.fillStyle = palette.main; ctx.fillRect(w*.19,baseY,w*.62,h*.48);
    ctx.fillStyle = palette.dark;
    for(let i=0;i<4;i++){ctx.fillRect(w*(.23+i*.14),baseY+h*.05,w*.045,h*.42);}
    ctx.fillRect(w*.44,baseY+h*.2,w*.13,h*.28);
    ctx.strokeStyle = '#ffe3ac'; ctx.lineWidth = Math.max(1,w*.012);
    ctx.beginPath();ctx.moveTo(w*.15,baseY+h*.04);ctx.lineTo(w*.85,baseY+h*.04);ctx.stroke();
  } else if (key === 'bahay') {
    ctx.fillStyle = palette.roof; ctx.beginPath();ctx.moveTo(w*.08,baseY);ctx.lineTo(w*.5,h*.06);ctx.lineTo(w*.92,baseY);ctx.closePath();ctx.fill();
    ctx.fillStyle = palette.main;ctx.fillRect(w*.16,baseY,w*.68,h*.5);
    ctx.fillStyle = palette.dark;ctx.fillRect(w*.43,baseY+h*.2,w*.14,h*.3);
    ctx.fillStyle = '#73e9ff';ctx.fillRect(w*.23,baseY+h*.1,w*.15,h*.15);ctx.fillRect(w*.63,baseY+h*.1,w*.15,h*.15);
    ctx.strokeStyle = '#fff0cf';ctx.lineWidth=Math.max(1,w*.012);ctx.strokeRect(w*.22,baseY+h*.09,w*.17,h*.17);ctx.strokeRect(w*.62,baseY+h*.09,w*.17,h*.17);
  } else if (key === 'mansion') {
    ctx.fillStyle = palette.main;ctx.fillRect(w*.12,h*.36,w*.76,h*.58);ctx.fillRect(w*.22,h*.17,w*.2,h*.28);ctx.fillRect(w*.58,h*.17,w*.2,h*.28);
    ctx.fillStyle = palette.roof;
    for(const cx of [.32,.68]){ctx.beginPath();ctx.moveTo(w*(cx-.14),h*.19);ctx.lineTo(w*cx,h*.02);ctx.lineTo(w*(cx+.14),h*.19);ctx.closePath();ctx.fill();}
    ctx.fillStyle = palette.dark;ctx.fillRect(w*.44,h*.64,w*.13,h*.3);
    ctx.fillStyle = '#fff0a8';for(let i=0;i<3;i++)ctx.fillRect(w*(.2+i*.25),h*.49,w*.09,h*.1);
    ctx.strokeStyle = '#fff0a8';ctx.lineWidth=Math.max(1,w*.012);ctx.strokeRect(w*.12,h*.36,w*.76,h*.58);
  } else {
    ctx.fillStyle = palette.main;ctx.fillRect(w*.24,h*.04,w*.52,h*.9);
    ctx.fillStyle = palette.dark;
    for(let yy=h*.13;yy<h*.82;yy+=h*.2)for(let xx=w*.31;xx<w*.68;xx+=w*.18)ctx.fillRect(xx,yy,w*.1,h*.1);
    ctx.fillStyle = '#fff0a8';ctx.fillRect(w*.46,h*.77,w*.1,h*.17);
    ctx.strokeStyle = palette.glow;ctx.lineWidth=Math.max(1,w*.012);ctx.strokeRect(w*.24,h*.04,w*.52,h*.9);
  }
  ctx.restore();
}
function getNetWorth(user) { return Math.max(0, Number(user.coins) || 0) + getHouseValue(user.house); }
// Canvas identity text must remain separate from cosmetic badges and name effects.
function getPlainDisplayName(user) {
  const raw = String(user?.name || 'Jojo Member');
  return cleanName(raw.replace(/\s+/g, ' '));
}
function getDisplayName(user) {
  const badges = [];
  if (HOUSE_CONFIG[user.house]?.badge) badges.push(HOUSE_CONFIG[user.house].badge);
  if (user.vip || user.badge === '👑 VIP Elite' || user.badge === 'VIP') badges.push('👑');
  if (user.royalFrame || String(user.frame || '').toLowerCase().includes('royal')) badges.push('👑');
  else if (user.goldFrame || String(user.frame || '').toLowerCase().includes('gold')) badges.push('🖼️');
  if (user.nameEffect && user.nameEffect !== 'none') badges.push(FLEX_BADGES[user.nameEffect] || '✨');
  return badges.length ? `${String(user.name || 'Jojo Member')} ${badges.join(' ')}` : String(user.name || 'Jojo Member');
}
function checkHouseTax(user) {
  const now = Date.now();
  const lastTax = Number(user.lastTax) || 0;
  if (now - lastTax < 86400000) return null;
  const house = String(user.house || 'none').toLowerCase();
  const tax = HOUSE_CONFIG[house]?.tax || 0;
  if (!tax) { user.lastTax = now; return null; }
  if ((Number(user.coins) || 0) < tax) {
    const downgrade = { building: 'mansion', mansion: 'bahay', bahay: 'kubo', kubo: 'none' };
    user.house = downgrade[house] || 'none';
    user.lastTax = now;
    return `⚠️ Hindi sapat ang coins para sa ${house} tax (${tax}c). Na-downgrade ang bahay mo sa ${user.house}.`;
  }
  user.coins -= tax;
  user.lastTax = now;
  return `🏠 House tax paid: ${tax} coins. Remaining balance: ${user.coins}c.`;
}
function canvasText(ctx, text, x, y, maxWidth, lineHeight = 26, maxLines = 3) {
  const words = String(text ?? '').split(/\s+/); let line = ''; let lines = 0;
  for (const word of words) { const test = line ? `${line} ${word}` : word; if (ctx.measureText(test).width > maxWidth && line) { ctx.fillText(line, x, y + lines * lineHeight); lines++; line = word; if (lines >= maxLines) break; } else line = test; }
  if (lines < maxLines && line) ctx.fillText(line, x, y + lines * lineHeight);
}
// [UPGRADED V35] Render name effects as vivid gradient text with a clean outline and subtle effect-colored light particles.
// Never draw a background box or plate behind the name; shop preview and applied profile share this renderer.
function drawPremiumNameEffect(ctx, name, x, y, maxWidth, effectKey, align = 'left', baseFontSize = 48) {
  const n = String(name || '').toUpperCase();
  const effect = String(effectKey || '').toLowerCase();
  const supported = ['rainbow','sparkle','heart','fire','ice','neon','blossom','dark','red','blue','green','yellow','gold','demon'];
  if (!supported.includes(effect) || !n) return false;

  ctx.save();
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  let fontSize = baseFontSize;
  ctx.font = 'bold ' + fontSize + 'px Arial Black';
  while (ctx.measureText(n).width > maxWidth && fontSize > 12) {
    fontSize -= 1;
    ctx.font = 'bold ' + fontSize + 'px Arial Black';
  }

  const palettes = {
    neon:['#ffffff','#baffff','#00ffff','#63f7ff'],
    fire:['#fffbd1','#fff000','#ff9b16','#ff3100','#9e0800'],
    gold:['#fffbd0','#ffe15a','#ffb000','#9b4d00'],
    demon:['#ffb0b0','#ff2424','#a50000','#210000'],
    ice:['#ffffff','#eafaff','#9beaff','#329cff'],
    rainbow:['#ff5353','#ffad43','#fff05c','#4bff91','#4bdfff','#a57aff','#ff70dd'],
    sparkle:['#ffffff','#fff2a8','#e6b7ff','#ffffff','#8feaff'],
    heart:['#fff0fa','#ff62b5','#ff9bd6'],
    blossom:['#fff0f8','#ff9cdb','#ff70a6'],
    dark:['#f2eaff','#b29aff','#5c4b8a','#211533'],
    red:['#ffd0d0','#ff5252','#a90000'],
    blue:['#ffffff','#a6d8ff','#54a8ff','#2457d6'],
    green:['#f0fff6','#c2ffd9','#64f59b','#168b57'],
    yellow:['#fffde0','#fff4b0','#ffe65b','#ffae18']
  };
  const palette = palettes[effect] || ['#ffffff','#dbeafe'];
  const textWidth = Math.min(maxWidth, ctx.measureText(n).width);
  const textLeft = align === 'center' ? x - textWidth / 2 : align === 'right' ? x - textWidth : x;
  const gradient = ctx.createLinearGradient(textLeft, y - fontSize, textLeft + Math.max(1, textWidth), y + 2);
  palette.forEach((color, i) => gradient.addColorStop(i / Math.max(1, palette.length - 1), color));

  const glow = {
    neon:'#00ffff', fire:'#ff4a00', gold:'#ffbf22', demon:'#ff0000', ice:'#42baff',
    rainbow:'#ff70dd', sparkle:'#d7a4ff', heart:'#ff62b5', blossom:'#ff70a6',
    dark:'#9b7cff', red:'#ff5252', blue:'#54a8ff', green:'#64f59b', yellow:'#ffe65b'
  }[effect] || palette[0];

  // Shared text renderer means every user's equipped effect looks identical in profile, leaderboard and shop preview.
  // Heavy shadow extrusion gives the letters a bold, game-logo depth instead of plain colored text.
  ctx.shadowColor = glow;
  ctx.shadowBlur = ['demon','neon','fire'].includes(effect) ? 30 : 22;
  ctx.fillStyle = glow;
  ctx.fillText(n, x + 2, y + 4);
  ctx.shadowBlur = 0;
  ctx.fillStyle = effect === 'demon' ? '#260000' : effect === 'fire' ? '#6d1300' : effect === 'ice' ? '#174b9c' : effect === 'gold' ? '#6d3900' : '#10162d';
  ctx.fillText(n, x + 1.5, y + 2.5);
  ctx.lineWidth = ['demon','fire','neon'].includes(effect) ? 4 : 3;
  ctx.strokeStyle = effect === 'demon' ? '#210000' : effect === 'ice' ? '#168bff' : effect === 'gold' ? '#9b4d00' : effect === 'fire' ? '#a91d00' : effect === 'neon' ? '#ffffff' : '#080d20';
  ctx.strokeText(n, x, y);
  ctx.shadowColor = glow;
  ctx.shadowBlur = ['demon','neon','fire'].includes(effect) ? 24 : 17;
  ctx.fillStyle = gradient;
  ctx.fillText(n, x, y);
  ctx.shadowBlur = 0;
  // Fine top highlight creates a polished, beveled finish.
  ctx.save(); ctx.globalAlpha = .48; ctx.lineWidth = 1; ctx.strokeStyle = '#ffffff'; ctx.strokeText(n, x, y - 1); ctx.restore();

  // Effect-specific ornaments: all are drawn around the letters, never behind them in a box.
  const left = textLeft, right = textLeft + textWidth;
  const top = y - fontSize * 0.95;
  const mid = y - fontSize * 0.58;
  const sparkle = (px, py, size, color) => {
    ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 7;
    ctx.beginPath(); ctx.moveTo(px,py-size); ctx.lineTo(px+size*.32,py-size*.25);
    ctx.lineTo(px+size,py); ctx.lineTo(px+size*.32,py+size*.25);
    ctx.lineTo(px,py+size); ctx.lineTo(px-size*.32,py+size*.25);
    ctx.lineTo(px-size,py); ctx.lineTo(px-size*.32,py-size*.25); ctx.closePath(); ctx.fill();
  };
  const dot = (px,py,r,color) => { ctx.fillStyle=color;ctx.shadowColor=color;ctx.shadowBlur=6;ctx.beginPath();ctx.arc(px,py,r,0,Math.PI*2);ctx.fill(); };
  const heart = (px,py,size,color) => {
    ctx.save();ctx.translate(px,py);ctx.scale(size/16,size/16);ctx.fillStyle=color;ctx.shadowColor=color;ctx.shadowBlur=5;
    ctx.beginPath();ctx.moveTo(0,6);ctx.bezierCurveTo(-17,-4,-9,-13,0,-6);ctx.bezierCurveTo(9,-13,17,-4,0,6);ctx.fill();ctx.restore();
  };
  const snowflake = (px,py,size,color) => {
    ctx.save();ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.shadowColor=color;ctx.shadowBlur=5;
    for(let a=0;a<3;a++){ctx.save();ctx.translate(px,py);ctx.rotate(a*Math.PI/3);ctx.beginPath();ctx.moveTo(-size,0);ctx.lineTo(size,0);ctx.moveTo(size*.45,0);ctx.lineTo(size*.2,-size*.25);ctx.moveTo(size*.45,0);ctx.lineTo(size*.2,size*.25);ctx.stroke();ctx.restore();}
    ctx.restore();
  };
  const positions = [left + textWidth*.08, left + textWidth*.3, left + textWidth*.72, right - textWidth*.06];
  ctx.save();ctx.globalAlpha=.96;
  if(effect==='sparkle'){
    positions.forEach((px,i)=>sparkle(px,top-(i%2)*7,Math.max(5,fontSize*.12)+i%2,['#fff2a8','#e6b7ff','#ffffff','#8feaff'][i]));
  } else if(effect==='heart'){
    heart(left+textWidth*.10,top,Math.max(13,fontSize*.30),'#ff62b5');heart(right-textWidth*.10,top-5,Math.max(11,fontSize*.25),'#ffd5ed');
    heart(left+textWidth*.83,mid,Math.max(8,fontSize*.18),'#ff9bd6');
  } else if(effect==='fire'||effect==='demon'){
    positions.forEach((px,i)=>{const h=fontSize*.42;ctx.fillStyle=effect==='demon'?(i%2?'#ff2424':'#a50000'):(i%2?'#ffcf39':'#ff4a16');ctx.shadowColor=ctx.fillStyle;ctx.shadowBlur=effect==='demon'?16:12;ctx.beginPath();ctx.moveTo(px,y-fontSize*.08);ctx.quadraticCurveTo(px-h*.8,y-fontSize*.42,px,y-fontSize*.68);ctx.quadraticCurveTo(px+h*.85,y-fontSize*.40,px+h*.25,y-fontSize*.12);ctx.closePath();ctx.fill();if(effect==='demon'){ctx.fillStyle='#fff0f0';ctx.beginPath();ctx.arc(px,y-fontSize*.35,2.2,0,Math.PI*2);ctx.fill();}});
  } else if(effect==='ice'){
    positions.forEach((px,i)=>snowflake(px,top-(i%2)*5,Math.max(6,fontSize*.15),'#dffaff'));
  } else if(effect==='neon'){
    [left+textWidth*.10,right-textWidth*.10].forEach((px,i)=>{ctx.strokeStyle=i?'#ff70dd':'#00ffff';ctx.lineWidth=3;ctx.shadowColor=ctx.strokeStyle;ctx.shadowBlur=16;ctx.beginPath();ctx.moveTo(px-8,top+8);ctx.lineTo(px-1,top-5);ctx.lineTo(px+5,top+4);ctx.lineTo(px+12,top-10);ctx.stroke();});
  } else if(effect==='blossom'){
    positions.forEach((px,i)=>{for(let p=0;p<5;p++){const a=p*Math.PI*2/5;dot(px+Math.cos(a)*fontSize*.10,top+Math.sin(a)*fontSize*.10,Math.max(2,fontSize*.045),p%2?'#ffd6ed':'#ff9cdb');}dot(px,top,Math.max(2,fontSize*.04),'#fff2a8');});
  } else if(effect==='rainbow'){
    positions.forEach((px,i)=>sparkle(px,top-(i%2)*6,Math.max(4,fontSize*.10),['#ff5353','#fff05c','#4bff91','#a57aff'][i]));
  } else if(effect==='gold'){
    // Royal gold gets gem-cut sparkles plus a tiny crown silhouette, distinct from the generic sparkle effect.
    positions.forEach((px,i)=>sparkle(px,top-(i%2)*5,Math.max(4,fontSize*.10),'#fff1a6'));
    const crownX = x, crownY = top - fontSize*.10, crownW = Math.max(22, Math.min(42, textWidth*.16)), crownH = Math.max(12, fontSize*.24);
    ctx.save(); ctx.translate(crownX, crownY); ctx.shadowColor='#ffd34f'; ctx.shadowBlur=10;
    ctx.beginPath(); ctx.moveTo(-crownW/2,crownH*.35); ctx.lineTo(-crownW*.42,-crownH*.45); ctx.lineTo(-crownW*.12,crownH*.02); ctx.lineTo(0,-crownH*.72); ctx.lineTo(crownW*.14,crownH*.02); ctx.lineTo(crownW*.43,-crownH*.45); ctx.lineTo(crownW/2,crownH*.35); ctx.closePath();
    ctx.fillStyle='#ffd34f'; ctx.fill(); ctx.strokeStyle='#fff7c2'; ctx.lineWidth=1.2; ctx.stroke();
    ctx.fillStyle='#65eaff'; ctx.beginPath(); ctx.arc(0,crownH*.10,Math.max(1.5,crownH*.09),0,Math.PI*2); ctx.fill(); ctx.restore();
  } else if(effect==='dark'){
    positions.forEach((px,i)=>{dot(px,top-(i%2)*5,Math.max(2,fontSize*.055),'#b29aff');dot(px+6,top+7,Math.max(1.5,fontSize*.035),'#5c4b8a');});
  } else {
    const color=glow;
    dot(left+textWidth*.08,top,Math.max(3,fontSize*.075),color);dot(right-textWidth*.08,top,Math.max(3,fontSize*.075),color);
    dot(left+textWidth*.9,mid,Math.max(2,fontSize*.05),palette[0]);
  }
  // A sharp signature underline is part of the name treatment (not a background plate).
  const underlineY = y + Math.max(7, fontSize*.16);
  ctx.save(); ctx.lineCap='round'; ctx.lineWidth=Math.max(2,fontSize*.045); ctx.shadowColor=glow; ctx.shadowBlur=10;
  if(effect==='neon') { ctx.strokeStyle='#00ffff'; ctx.beginPath();ctx.moveTo(left,underlineY);ctx.lineTo(right,underlineY);ctx.stroke();ctx.strokeStyle='#ff70dd';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(left+textWidth*.18,underlineY+4);ctx.lineTo(right-textWidth*.12,underlineY+4);ctx.stroke(); }
  else if(effect==='fire'||effect==='demon') { ctx.strokeStyle=effect==='demon'?'#ff2424':'#ff9b16';ctx.beginPath();ctx.moveTo(left,underlineY);ctx.lineTo(right,underlineY);ctx.stroke();for(let i=0;i<3;i++){const px=left+textWidth*(.2+i*.3);ctx.beginPath();ctx.moveTo(px,underlineY);ctx.lineTo(px+3,underlineY-5-i%2*3);ctx.stroke();} }
  else if(effect==='ice') { ctx.strokeStyle='#dffaff';ctx.beginPath();ctx.moveTo(left,underlineY);ctx.lineTo(right,underlineY);ctx.stroke(); }
  else if(effect==='dark') { ctx.strokeStyle='#9b7cff';ctx.setLineDash([fontSize*.18,fontSize*.09]);ctx.beginPath();ctx.moveTo(left,underlineY);ctx.lineTo(right,underlineY);ctx.stroke();ctx.setLineDash([]); }
  else { ctx.strokeStyle=gradient;ctx.beginPath();ctx.moveTo(left,underlineY);ctx.lineTo(right,underlineY);ctx.stroke(); }
  ctx.restore();
  ctx.restore();
  ctx.restore();
  return true;
}
async function generateProfileCanvas(user) {
  // [UPGRADED V28] Cleaner, aligned visual profile with separated sections and readable profile details.
  // Smooth visual mode: render at standard resolution to reduce CPU, memory, and image upload time.
  const W = 800, H = 1360, RENDER_SCALE = 1, canvas = createCanvas(W * RENDER_SCALE, H * RENDER_SCALE), ctx = canvas.getContext('2d');
  ctx.scale(RENDER_SCALE, RENDER_SCALE);
  const effect = String(user.nameEffect || 'none').toLowerCase();
  const effectColors = { rainbow:['#ff5353','#ffad43','#fff05c','#4bff91','#4bdfff','#a57aff','#ff70dd'], sparkle:['#fff2a8','#d5a4ff','#ffffff'], heart:['#ff62b5','#ff9bd6','#ffd5ed'], fire:['#ff4d22','#ff8a3d','#ffe36a'], ice:['#78eaff','#d8fbff','#5b9dff'], neon:['#45ffff','#a77bff','#ff4fe1'], blossom:['#ff9cdb','#ffd4ed','#ff70a6'], dark:['#bd9bff','#5c4b8a','#e5dcff'], red:['#ff5252','#ff9b9b'], blue:['#54a8ff','#a6d8ff'], green:['#64f59b','#c2ffd9'], yellow:['#ffe65b','#fff4b0'], gold:['#ffd34f','#fff1a8','#ffb000','#9b4d00'], demon:['#ff2424','#ff8a8a','#a50000','#210000'] };
  const colors = effectColors[effect] || ['#ffd34f','#ffec9e','#f59e0b'];
  // [GLOBAL PROFILE FRAME EFFECTS] Shared frame state used by the leaderboard too.
  const frameStyle = getEquippedFrameStyle(user);
  const { frameName, frameKey, royal: royalFrame, gold: goldFrame, diamond: diamondFrame, neon: neonFrame, silver: silverFrame, color: frameColor, glow: frameGlow } = frameStyle;
  // [FIXED V31] Show the purchased VIP badge even if an older saved account only has its badge label.
  const vip = !!user.vip || String(user.badge || '').toLowerCase().includes('vip');
  const bg = ctx.createLinearGradient(0,0,W,H); bg.addColorStop(0,'#050716'); bg.addColorStop(.5,'#111630'); bg.addColorStop(1,'#030914');
  ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
  for(let i=0;i<115;i++){ctx.globalAlpha=.10+(i%3)*.045;ctx.fillStyle=[colors[i%colors.length],'#4af5ff','#ff49e9'][i%3];ctx.beginPath();ctx.arc((i*127+19)%W,(i*83+27)%H,i%9===0?2:1,0,Math.PI*2);ctx.fill();}
  ctx.globalAlpha=1;
  const rr=(x,y,w,h,r)=>{ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();};
  // [ROYAL PROFILE POLISH] Reusable jewel-tone panels with layered borders, corner filigree, and soft accent glow.
  const panel=(x,y,w,h,accent='#344777')=>{
    ctx.save();
    const g=ctx.createLinearGradient(x,y,x+w,y+h);g.addColorStop(0,'#172849');g.addColorStop(.42,'#0d1730');g.addColorStop(1,'#070c1c');
    ctx.shadowColor=accent;ctx.shadowBlur=10;ctx.fillStyle=g;rr(x,y,w,h,22);ctx.fill();ctx.shadowBlur=0;
    ctx.strokeStyle=accent;ctx.globalAlpha=.95;ctx.lineWidth=2;rr(x,y,w,h,22);ctx.stroke();
    ctx.strokeStyle='#fff0b0';ctx.globalAlpha=.55;ctx.lineWidth=1;rr(x+5,y+5,w-10,h-10,17);ctx.stroke();
    // Small metallic corner cuts give each section a premium frame without crowding content.
    ctx.globalAlpha=.9;ctx.strokeStyle=accent;ctx.lineWidth=3;
    const c=18;
    ctx.beginPath();ctx.moveTo(x+12,y+c);ctx.lineTo(x+12,y+12);ctx.lineTo(x+c,y+12);
    ctx.moveTo(x+w-c,y+12);ctx.lineTo(x+w-12,y+12);ctx.lineTo(x+w-12,y+c);
    ctx.moveTo(x+12,y+h-c);ctx.lineTo(x+12,y+h-12);ctx.lineTo(x+c,y+h-12);
    ctx.moveTo(x+w-c,y+h-12);ctx.lineTo(x+w-12,y+h-12);ctx.lineTo(x+w-12,y+h-c);ctx.stroke();
    ctx.restore();
  };
  const label=(value,x,y,size=16,color='#91a9d3',align='left')=>{ctx.textAlign=align;ctx.fillStyle=color;ctx.font=size+'px Sans';ctx.fillText(value,x,y);};
  const heading=(value,x,y)=>{ctx.textAlign='left';ctx.fillStyle='#f4f7ff';ctx.font='bold 21px Sans';ctx.fillText(value,x,y);};
  const displayName = getPlainDisplayName(user).slice(0, 26);
  ctx.textAlign='center';ctx.fillStyle='#ffd875';ctx.font='bold 31px Sans';ctx.fillText('JOJOWORLD',W/2,62);
  ctx.fillStyle='#b9c8e8';ctx.font='15px Sans';ctx.fillText('VISUAL PROFILE - YOUR WORLD, YOUR STYLE',W/2,91);
  // [UPGRADED V28] Main identity card; avatar and text no longer overlap.
  panel(28,118,744,300,'#d9a441');
  // Apply the pre-generated AI artwork behind the equipped name effect when available.
  // Profile rendering only reads the cache; it never triggers a paid generation request.
  // Restore only previously saved artwork from MongoDB; profile rendering never triggers paid generation.
  const profileArtFile = effect !== 'none' ? await restoreCachedNameEffectArtwork(effect, cacheDir, { loadFromStore: loadAINameArtFromMongo }) : null;
  if (profileArtFile) {
    try {
      const profileArt = await loadImage(profileArtFile);
      ctx.save(); rr(28,118,744,300,22); ctx.clip(); ctx.globalAlpha = 0.24;
      const artScale = Math.max(744 / profileArt.width, 300 / profileArt.height);
      ctx.drawImage(profileArt, 28 + (744 - profileArt.width * artScale) / 2, 118 + (300 - profileArt.height * artScale) / 2, profileArt.width * artScale, profileArt.height * artScale);
      ctx.globalAlpha = 0.46; ctx.fillStyle = '#050a19'; ctx.fillRect(28,118,744,300); ctx.restore();
    } catch (artError) { console.warn('[PROFILE AI ART] Could not load cached artwork:', artError.message); }
  }
  const ax=150, ay=257;
  ctx.save();ctx.shadowColor=frameGlow;ctx.shadowBlur=frameName!=='None'?25:20;ctx.fillStyle='#091226';ctx.beginPath();ctx.arc(ax,ay,91,0,Math.PI*2);ctx.fill();ctx.restore();
  let photoShown=false;
  try{let photo=null;if(user.profilePhotoData)photo=await loadCachedProfilePhotoData(user.profilePhotoData);else if(user.profilePhotoUrl)photo=await loadCachedProfilePhotoUrl(user.profilePhotoUrl);if(photo){ctx.save();ctx.beginPath();ctx.arc(ax,ay,81,0,Math.PI*2);ctx.clip();const scale=Math.max(162/photo.width,162/photo.height),pw=photo.width*scale,ph=photo.height*scale;ctx.drawImage(photo,ax-pw/2,ay-ph/2,pw,ph);ctx.restore();photoShown=true;}}catch(photoError){console.warn('[PROFILE PHOTO] Could not load uploaded photo:',photoError.message);}
  if(!photoShown){ctx.fillStyle='#263c62';ctx.beginPath();ctx.arc(ax,ay-22,28,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.ellipse(ax,ay+42,48,36,0,Math.PI,Math.PI*2);ctx.fill();ctx.fillStyle='#d9e8fa';ctx.font='bold 13px Sans';ctx.textAlign='center';ctx.fillText('PROFILE',ax,ay+8);}
  ctx.save();ctx.shadowColor=frameGlow;ctx.shadowBlur=frameName!=='None'?25:12;ctx.strokeStyle=frameName!=='None'?frameColor:colors[0];ctx.lineWidth=frameName!=='None'?9:5;ctx.beginPath();ctx.arc(ax,ay,87,0,Math.PI*2);ctx.stroke();if(goldFrame||royalFrame){ctx.strokeStyle='#fff2b3';ctx.lineWidth=2;ctx.beginPath();ctx.arc(ax,ay,77,0,Math.PI*2);ctx.stroke();}if(diamondFrame||neonFrame){ctx.strokeStyle=frameColor;ctx.lineWidth=2;ctx.beginPath();ctx.arc(ax,ay,77,0,Math.PI*2);ctx.stroke();}
  // [PROFILE FLEX BOOST] Make every equipped frame visibly premium, not just a thin avatar ring.
  if(frameStyle.equipped){
    ctx.save();ctx.shadowColor=frameGlow;ctx.shadowBlur=13;ctx.fillStyle=frameColor;ctx.strokeStyle=frameColor;ctx.lineWidth=2;
    for(let j=0;j<16;j++){
      const a=-Math.PI/2+j*Math.PI/8, r=96, px=ax+Math.cos(a)*r, py=ay+Math.sin(a)*r;
      ctx.save();ctx.translate(px,py);ctx.rotate(a+Math.PI/4);
      if(royalFrame){ /* The Royalty frame has its own larger crown and jewel treatment below. */ }
      else if(diamondFrame){ctx.beginPath();ctx.moveTo(0,-5);ctx.lineTo(4,0);ctx.lineTo(0,5);ctx.lineTo(-4,0);ctx.closePath();ctx.fill();}
      else if(neonFrame){ctx.beginPath();ctx.moveTo(-3,-4);ctx.lineTo(3,4);ctx.moveTo(3,-4);ctx.lineTo(-3,4);ctx.stroke();}
      else if(goldFrame){ctx.beginPath();ctx.arc(0,0,j%4===0?4:2.2,0,Math.PI*2);ctx.fill();}
      else {ctx.beginPath();ctx.arc(0,0,j%4===0?3.2:1.8,0,Math.PI*2);ctx.fill();}
      ctx.restore();
    }
    ctx.restore();
  }
  // [UPGRADED V29] Royalty frame: glowing layered rings, jewel points and a crown silhouette around the profile photo.
  if(royalFrame){ctx.shadowColor='#ffd34f';ctx.shadowBlur=16;ctx.strokeStyle='#fff0a6';ctx.lineWidth=3;ctx.beginPath();ctx.arc(ax,ay,98,0,Math.PI*2);ctx.stroke();ctx.strokeStyle='#d99018';ctx.lineWidth=5;ctx.beginPath();ctx.arc(ax,ay,105,Math.PI*1.08,Math.PI*1.92);ctx.stroke();ctx.fillStyle='#ffdf69';for(let j=0;j<12;j++){const a=-Math.PI/2+j*Math.PI/6,rx=ax+Math.cos(a)*101,ry=ay+Math.sin(a)*101;ctx.beginPath();ctx.arc(rx,ry,j%3===0?5:2.5,0,Math.PI*2);ctx.fill();}ctx.beginPath();ctx.moveTo(ax-47,ay-88);ctx.lineTo(ax-38,ay-119);ctx.lineTo(ax-13,ay-97);ctx.lineTo(ax,ay-132);ctx.lineTo(ax+14,ay-97);ctx.lineTo(ax+39,ay-119);ctx.lineTo(ax+48,ay-88);ctx.closePath();ctx.fillStyle='#d99a25';ctx.fill();ctx.strokeStyle='#fff0a6';ctx.lineWidth=2;ctx.stroke();ctx.fillStyle='#63eaff';ctx.beginPath();ctx.arc(ax,ay-113,5,0,Math.PI*2);ctx.fill();}ctx.restore();
  // [UPGRADED V32] Every purchased name effect gets a distinct gradient, glow and matching visual accent in the generated Visual Profile.
  ctx.textAlign='left';let nameFill=colors[0];
  if(effect!=='none'&&colors.length>1){nameFill=ctx.createLinearGradient(270,0,680,0);colors.forEach((col,i)=>nameFill.addColorStop(i/(colors.length-1),col));}
  if(effect==='rainbow'){nameFill=ctx.createLinearGradient(270,0,680,0);colors.forEach((col,i)=>nameFill.addColorStop(i/(colors.length-1),col));}
  if(effect==='sparkle'){nameFill=ctx.createLinearGradient(270,0,680,0);['#fffde8','#d7a4ff','#ffffff','#ffe58a','#f2d9ff'].forEach((col,i)=>nameFill.addColorStop(i/4,col));}
  // [FIXED V32] Reserve space on the right for the purchased verified emblem so long names cannot cover it.
  // [ROYAL HEADER ALIGNMENT] Keep every user's name inside a fixed column, clear of the VIP shield and stacked plates.
  let nameFontSize=26;ctx.font='bold '+nameFontSize+'px Sans';while(ctx.measureText(displayName).width>340&&nameFontSize>16){nameFontSize--;ctx.font='bold '+nameFontSize+'px Sans';}
  const nameWidth=ctx.measureText(displayName).width;
  const effectGlow={rainbow:'#ff70dd',sparkle:'#d7a4ff',heart:'#ff62b5',fire:'#ff4d22',ice:'#78eaff',neon:'#45ffff',blossom:'#ff9cdb',dark:'#9b7cff',red:'#ff5252',blue:'#54a8ff',green:'#64f59b',yellow:'#ffe65b'};
  // [UPGRADED V33] Purchased premium plain-text effects render in uppercase with glow and outline.
  // [ROYAL HEADER ALIGNMENT V2] VIP layout stacks verified plate, centered name, and equipped-frame chip with clear gaps.
  // [EMOJI-MARKED HEADER PLACEMENT] VIP name sits at the user's heart marker, to the right of the verified plate; non-VIP layout stays unchanged.
  // [HEADER FINAL LAYOUT] Center every user's display name so purchased text effects stay fully visible; VIP plates stack beneath it.
  const nameX=400, nameY=237, nameAlign='center', nameMaxWidth=520;
  if (!drawPremiumNameEffect(ctx, displayName, nameX, nameY, nameMaxWidth, effect, nameAlign)) {
    ctx.fillStyle=nameFill;ctx.shadowColor=effectGlow[effect]||colors[0];ctx.shadowBlur=effect==='none'?0:(effect==='sparkle'||effect==='neon'?25:18);ctx.textAlign=nameAlign;ctx.fillText(displayName,nameX,nameY);ctx.shadowBlur=0;
  }
  // [UPGRADED V34] Name effects are text-only; no extra glyphs or ornaments are placed beside the name.
  // It is rendered directly into the profile image whenever the user owns the VIP shop item.
  // Premium SVG plate artwork is rendered by Canvas as transparent vector images.
  // Keep the small VIP shield beside the name, and place the detailed plates side-by-side at the bottom.
  if(vip){
    try {
      const royalPlate = await loadImage(path.join(__dirname, 'assets', 'royal-verified-plate.svg'));
      ctx.save();
      ctx.shadowColor = '#55cfff'; ctx.shadowBlur = 12;
      ctx.drawImage(royalPlate, 22, 292, 370, 106);
      ctx.restore();
    } catch (plateError) { console.warn('[PROFILE PLATE] Royal Verified artwork could not load:', plateError.message); }
    ctx.save();ctx.translate(721,158);ctx.shadowColor='#ffd34f';ctx.shadowBlur=22;
    const shield=()=>{ctx.beginPath();ctx.moveTo(0,-27);ctx.lineTo(23,-17);ctx.lineTo(21,7);ctx.quadraticCurveTo(13,23,0,30);ctx.quadraticCurveTo(-13,23,-21,7);ctx.lineTo(-23,-17);ctx.closePath();};
    const gold=ctx.createLinearGradient(-23,-27,23,30);gold.addColorStop(0,'#fffbd0');gold.addColorStop(.38,'#ffd447');gold.addColorStop(.72,'#f4a900');gold.addColorStop(1,'#a95b05');ctx.fillStyle=gold;shield();ctx.fill();ctx.shadowBlur=0;ctx.strokeStyle='#fff8cf';ctx.lineWidth=2.5;shield();ctx.stroke();
    ctx.shadowColor='#ffd34f';ctx.shadowBlur=12;ctx.fillStyle='#f6b900';ctx.strokeStyle='#fff4b0';ctx.lineWidth=1.8;
    ctx.beginPath();ctx.moveTo(-18,-25);ctx.lineTo(-16,-40);ctx.lineTo(-7,-31);ctx.lineTo(0,-44);ctx.lineTo(8,-31);ctx.lineTo(17,-40);ctx.lineTo(19,-25);ctx.closePath();ctx.fill();ctx.stroke();
    ctx.fillStyle='#64eaff';ctx.beginPath();ctx.arc(0,-35,3,0,Math.PI*2);ctx.fill();
    ctx.shadowBlur=0;ctx.strokeStyle='#9b5a08';ctx.lineWidth=1.5;shield();ctx.stroke();
    ctx.fillStyle='#fff5c2';for(const gx of [-15,15]){ctx.beginPath();ctx.arc(gx,-9,2.2,0,Math.PI*2);ctx.fill();}
    ctx.strokeStyle='#ffffff';ctx.lineWidth=4.5;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();ctx.moveTo(-10,1);ctx.lineTo(-3,9);ctx.lineTo(12,-9);ctx.stroke();
    ctx.restore();
  }
  // Gold Frame artwork is shown on the right; name and footer remain above both plates.
  try {
    const goldPlate = await loadImage(path.join(__dirname, 'assets', 'gold-frame-plate.svg'));
    ctx.save();
    ctx.shadowColor = '#ffd34f'; ctx.shadowBlur = 12;
    ctx.drawImage(goldPlate, 408, 292, 370, 106);
    ctx.restore();
  } catch (plateError) { console.warn('[PROFILE PLATE] Gold Frame artwork could not load:', plateError.message); }
  const frameLabel = frameName.toUpperCase();
  // [GLOBAL PROFILE CLEANUP] Keep the identity header limited to the name and verified emblem.
  // Location, zodiac, goal and frame details appear only in PROFILE DETAILS below.
  const levelStats = getProfileLevelStats(user.xp);
  const stats=[
    {x:28,w:174,title:'COINS',value:String(Number(user.coins)||0),color:'#ffd875'},
    {x:218,w:174,title:'LEVEL / XP',value:'LVL '+levelStats.level,color:'#ffe08a',level:true},
    {x:408,w:174,title:'NET WORTH',value:String(getNetWorth(user)),color:'#f4d28b'},
    {x:598,w:174,title:'PROFILE OPENS',value:String(Number(user.views)||0),color:'#ffe7b0'}
  ];
  stats.forEach(s=>{
    panel(s.x,438,s.w,94,'#344777');
    label(s.title,s.x+13,s.level?460:468,12,'#9fb4d6');
    ctx.textAlign='left';ctx.fillStyle=s.color;ctx.font='bold 22px Sans';ctx.fillText(s.value,s.x+13,s.level?488:507);
    if(s.level){
      label(levelStats.currentXp+' / '+levelStats.nextLevelXp+' XP',s.x+13,504,10,'#c6d5f0');
      ctx.save();rr(s.x+13,512,s.w-26,7,4);ctx.fillStyle='#0a1124';ctx.fill();
      const fillWidth=Math.max(0,(s.w-26)*levelStats.progress);
      if(fillWidth>0){const xpGradient=ctx.createLinearGradient(s.x+13,512,s.x+13+fillWidth,519);xpGradient.addColorStop(0,'#7dffb0');xpGradient.addColorStop(1,'#35eaff');ctx.fillStyle=xpGradient;rr(s.x+13,512,fillWidth,7,4);ctx.fill();}
      ctx.restore();
    }
  });
  const detailAccent = '#d9a441';
  panel(28,550,744,280,'#d9a441');
  // PROFILE DETAILS redesign: six luminous mini-cards instead of a plain text list.
  // Each detail gets its own accent marker and a clear label/value hierarchy.
  heading('PROFILE DETAILS',52,586);
  ctx.save();ctx.strokeStyle=detailAccent;ctx.globalAlpha=.55;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(52,599);ctx.lineTo(748,599);ctx.stroke();ctx.restore();
  const rows=[
    {label:'NAME & AGE',value:cleanName(displayName)+(user.age?'  '+cleanText(user.age):''),color:'#f4d28b'},
    {label:'LOCATION',value:cleanText(user.location||'Not set'),color:'#e7c16d'},
    {label:'ZODIAC',value:cleanText(user.zodiac||'Not set'),color:'#ffe7a0'},
    {label:'RELATIONSHIP GOAL',value:cleanText(user.relationshipGoal||'Not set'),color:'#d9a441'},
    {label:'BADGE',value:cleanText(user.badge||(vip?'VIP Elite':'Newbie')),color:vip?'#ffd34f':'#a9c8ff'},
    {label:'EQUIPPED FRAME',value:frameName,color:'#e7c16d'}
  ];
  rows.forEach((r,i)=>{
    const col=i%2,row=Math.floor(i/2),x=48+col*354,y=610+row*68,w=342,h=58;
    ctx.save();
    const cardGrad=ctx.createLinearGradient(x,y,x+w,y+h);cardGrad.addColorStop(0,'#172748');cardGrad.addColorStop(1,'#090f21');
    ctx.fillStyle=cardGrad;rr(x,y,w,h,13);ctx.fill();
    ctx.strokeStyle=r.color;ctx.globalAlpha=.75;ctx.lineWidth=1.4;rr(x,y,w,h,13);ctx.stroke();ctx.globalAlpha=1;
    ctx.shadowColor=r.color;ctx.shadowBlur=10;ctx.fillStyle=r.color;ctx.beginPath();ctx.arc(x+15,y+17,3.5,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
    ctx.textAlign='left';ctx.fillStyle=r.color;ctx.font='bold 11px Sans';ctx.fillText(r.label,x+27,y+21);
    ctx.fillStyle='#f5f7ff';ctx.font='bold 14px Sans';
    let val=String(r.value||'Not set');while(ctx.measureText(val).width>w-32&&val.length>7)val=val.slice(0,-4)+'...';
    if(r.label==='BADGE' && vip){
      const pillW=Math.min(w-28,Math.max(96,ctx.measureText(val).width+34));
      const pillX=x+(w-pillW)/2;
      const vipGrad=ctx.createLinearGradient(pillX,y+29,pillX+pillW,y+51);vipGrad.addColorStop(0,'#fff0a0');vipGrad.addColorStop(.5,'#f4b400');vipGrad.addColorStop(1,'#9b5a08');
      ctx.shadowColor='#ffd34f';ctx.shadowBlur=9;ctx.fillStyle='#111426';rr(pillX,y+29,pillW,23,11);ctx.fill();ctx.shadowBlur=0;
      ctx.strokeStyle=vipGrad;ctx.lineWidth=1.5;rr(pillX,y+29,pillW,23,11);ctx.stroke();
      ctx.fillStyle=vipGrad;ctx.font='bold 12px Sans';ctx.textAlign='center';ctx.fillText('👑 '+val,pillX+pillW/2,y+45);
    }else{ctx.textAlign='left';ctx.fillText(val,x+14,y+44);}
    ctx.restore();
  });
  // [UPGRADED V28] House showcase kept as its own compact panel.
  const house=String(user.house||'none').toLowerCase(), houseConfig={kubo:{label:'KUBO',color:'#e4c18a'},bahay:{label:'BAHAY',color:'#8fe5ff'},mansion:{label:'MANSION',color:'#d9a5ff'},building:{label:'BUILDING',color:'#ffd34f'}},hc=houseConfig[house];
  panel(28,850,744,145,hc?hc.color:'#344777');heading('MY HOUSE',52,885);
  if(hc){
    // Only the house saved on the user's account is rendered here as a flex asset.
    const houseGlow=ctx.createRadialGradient(350,940,4,350,940,95);
    houseGlow.addColorStop(0,hc.color+'55');houseGlow.addColorStop(1,'#07102000');
    ctx.fillStyle=houseGlow;ctx.fillRect(260,885,190,100);
    drawHouseArt(ctx,house,292,895,118,88);
    ctx.save();ctx.shadowColor=hc.color;ctx.shadowBlur=12;ctx.strokeStyle=hc.color;ctx.lineWidth=1.5;ctx.strokeRect(280,887,142,100);ctx.restore();
    label(hc.label+' - TIER '+getHouseTier(house),445,940,18,hc.color);
    label('OWNED - PROPERTY VALUE '+getHouseValue(house).toLocaleString('en-US')+'c',445,968,13,'#ffe7a0');
  }else{label('No house purchased yet - visit the Shop!',52,940,17,'#b7c8e6');}
  panel(28,1015,358,220,'#4656a0');heading('ABOUT ME',50,1053);ctx.fillStyle='#dce8ff';ctx.textAlign='left';ctx.font='16px Sans';canvasText(ctx,cleanText(user.bio||'Welcome to my JojoWorld profile!'),50,1085,314,24,4);
  panel(404,1015,368,220,'#d6a84b');heading('GIFTS SHOWCASE',426,1053);
  const received=user.giftsReceived&&typeof user.giftsReceived==='object'?user.giftsReceived:{};
  // Plain ASCII labels only in Gifts Showcase to prevent missing-glyph boxes on every device.
  const giftCatalogForProfile={
    ROSE:{name:'Red Rose'},COFFEE:{name:'Coffee Cup'},
    BEAR:{name:'Teddy Bear'},RING:{name:'Diamond Ring'},
    CAR:{name:'Sports Car'}
  };
  const giftEntries=Object.entries(received).filter(([name,count])=>Number(count)>0);
  const giftTotal=Math.max(Number(user.giftsCount)||0,giftEntries.reduce((sum,[name,count])=>sum+(Number(count)||0),0));
  label('TOTAL GIFTS RECEIVED: '+giftTotal,426,1086,14,'#ffe8a0');
  if(giftEntries.length){
    giftEntries.slice(0,5).forEach(([name,count],index)=>{
      const gift=giftCatalogForProfile[String(name).toUpperCase()]||{name:String(name).replace(/_/g,' ')};
      const yy=1110+index*23;
      ctx.fillStyle=index%2===0?'#20264b':'#171d3a';
      rr(420,yy-16,326,20,7);ctx.fill();
      label(cleanText(gift.name),430,yy,13,'#f4f7ff');
      ctx.textAlign='right';ctx.fillStyle='#ffe08a';ctx.font='bold 13px Sans';ctx.fillText('x '+Number(count),735,yy);
    });
  }else{
    const showcase=String(user.giftsShowcase||'None yet');
    label(showcase!=='None yet'?cleanText(showcase):'No gifts yet - be the first!',426,1124,13,'#c6d5f0');
  }
  // Gifts Showcase remains the final profile showcase; trophy panel removed as requested.
  ctx.textAlign='center';ctx.fillStyle='#8da8e4';ctx.font='bold 14px Sans';ctx.fillText('JOJOWORLD - PROFILE & STATS',400,1218);
  const file=path.join(cacheDir,'profile_'+String(user.id||user.psid||'user').replace(/[^a-zA-Z0-9_-]/g,'')+'.jpg');
  // JPEG is much smaller than PNG for this large canvas, reducing encode and Messenger upload time.
  await fsExtra.writeFile(file,canvas.toBuffer('image/jpeg',{quality:0.9}));return file;
}
async function generateShopCanvas() {
  // Reuse the static shop poster after its first render to keep repeat SHOP commands fast.
  const file = path.join(cacheDir, 'shop_v2.jpg');
  if (fs.existsSync(file)) return file;
  // [UPGRADED V28] Product-first neon shop: each item has its own visual card, name and price.
  // Smooth visual mode: standard 800x1480 output keeps the full shop layout while reducing render cost.
  const W = 800, H = 1480, RENDER_SCALE = 1, canvas = createCanvas(W * RENDER_SCALE, H * RENDER_SCALE), ctx = canvas.getContext('2d');
  ctx.scale(RENDER_SCALE, RENDER_SCALE);
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#050510'); bg.addColorStop(0.45, '#11102d'); bg.addColorStop(1, '#020914');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 190; i++) {
    const x = (i * 131 + 29) % (W - 8) + 4, y = (i * 79 + 17) % (H - 8) + 4;
    ctx.fillStyle = ['#39efff', '#ff48e9', '#ffd75b', '#a77bff'][i % 4];
    ctx.globalAlpha = 0.13 + (i % 4) * 0.075; ctx.beginPath(); ctx.arc(x, y, i % 7 === 0 ? 2.4 : 1, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.shadowColor = '#35eaff'; ctx.shadowBlur = 22; ctx.strokeStyle = '#35eaff'; ctx.lineWidth = 4; ctx.strokeRect(15, 15, W - 30, H - 30);
  ctx.shadowColor = '#ec48ff'; ctx.strokeStyle = '#ec48ff'; ctx.lineWidth = 1.5; ctx.strokeRect(27, 27, W - 54, H - 54); ctx.shadowBlur = 0;

  const text = (value, x, y, size, color, align = 'center', bold = true) => {
    ctx.textAlign = align; ctx.fillStyle = color; ctx.font = (bold ? 'bold ' : '') + size + 'px Sans'; ctx.fillText(value, x, y);
  };
  const panel = (x, y, w, h, color, title) => {
    const g = ctx.createLinearGradient(x, y, x + w, y + h); g.addColorStop(0, '#181632'); g.addColorStop(1, '#070e1d');
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h); ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = 12; ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h); ctx.restore();
    text(title, x + 18, y + 31, 21, color, 'left');
  };
  // [FIXED] Draw product logos with Canvas paths instead of emoji glyphs, which may be missing on Render.
  const drawProductLogo = (title, cx, cy, size, color) => {
    const name = String(title || '').toUpperCase();
    ctx.save(); ctx.translate(cx, cy); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = Math.max(2, size * 0.075);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.shadowColor = color; ctx.shadowBlur = 12;
    const star = (outer, inner, points = 5, rotation = -Math.PI / 2) => {
      ctx.beginPath();
      for (let i = 0; i < points * 2; i++) {
        const a = rotation + i * Math.PI / points, r = i % 2 === 0 ? outer : inner;
        const px = Math.cos(a) * r, py = Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
    };
    if (name.includes('VIP') || name.includes('BADGE')) {
      ctx.beginPath(); ctx.moveTo(-size*.48,-size*.36); ctx.lineTo(-size*.22,-size*.22); ctx.lineTo(0,-size*.48); ctx.lineTo(size*.22,-size*.22); ctx.lineTo(size*.48,-size*.36); ctx.lineTo(size*.38,size*.18); ctx.lineTo(0,size*.46); ctx.lineTo(-size*.38,size*.18); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#21152d'; ctx.font = 'bold ' + Math.round(size*.44) + 'px Sans'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText('V',0,0);
    } else if (name.includes('FRAME')) {
      ctx.strokeRect(-size*.42,-size*.42,size*.84,size*.84); ctx.lineWidth=size*.09; ctx.strokeRect(-size*.27,-size*.27,size*.54,size*.54);
      ctx.beginPath(); ctx.moveTo(-size*.42,-size*.12); ctx.lineTo(-size*.12,-size*.42); ctx.moveTo(size*.12,size*.42); ctx.lineTo(size*.42,size*.12); ctx.stroke();
    } else if (name.includes('RAINBOW')) {
      const colors=['#ff5050','#ffae42','#ffed57','#53ef85','#48cfff','#a77bff','#ff65d5'];
      colors.forEach((c,i)=>{ctx.strokeStyle=c;ctx.lineWidth=size*.10;ctx.beginPath();ctx.arc(0,size*.18,size*(.48-i*.055),Math.PI,Math.PI*2);ctx.stroke();});
    } else if (name.includes('SPARKLE')) {
      star(size*.46,size*.12,8); ctx.beginPath();ctx.arc(size*.35,-size*.35,size*.09,0,Math.PI*2);ctx.fill();
      ctx.beginPath();ctx.arc(-size*.36,size*.26,size*.07,0,Math.PI*2);ctx.fill();
    } else if (name.includes('HEART')) {
      ctx.beginPath();ctx.moveTo(0,size*.42);ctx.bezierCurveTo(-size*.12,size*.28,-size*.52,-size*.02,-size*.42,-size*.27);ctx.bezierCurveTo(-size*.34,-size*.49,-size*.08,-size*.46,0,-size*.25);ctx.bezierCurveTo(size*.12,-size*.48,size*.4,-size*.47,size*.44,-size*.24);ctx.bezierCurveTo(size*.5,-size*.02,size*.12,size*.31,0,size*.42);ctx.fill();
    } else if (name.includes('FIRE')) {
      ctx.beginPath();ctx.moveTo(0,size*.48);ctx.bezierCurveTo(-size*.4,size*.26,-size*.42,-size*.05,-size*.12,-size*.27);ctx.lineTo(-size*.05,-size*.02);ctx.bezierCurveTo(size*.02,-size*.34,size*.26,-size*.4,size*.2,-size*.5);ctx.bezierCurveTo(size*.55,-size*.08,size*.4,size*.31,0,size*.48);ctx.fill();
      ctx.fillStyle='#fff0a1';ctx.beginPath();ctx.moveTo(0,size*.3);ctx.bezierCurveTo(-size*.16,size*.1,-size*.05,-size*.05,size*.07,-size*.13);ctx.bezierCurveTo(size*.18,size*.05,size*.16,size*.19,0,size*.3);ctx.fill();
    } else if (name.includes('ICE')) {
      for(let i=0;i<6;i++){const a=i*Math.PI/3;ctx.beginPath();ctx.moveTo(Math.cos(a)*size*.08,Math.sin(a)*size*.08);ctx.lineTo(Math.cos(a)*size*.46,Math.sin(a)*size*.46);ctx.moveTo(Math.cos(a)*size*.30,Math.sin(a)*size*.30);ctx.lineTo(Math.cos(a-.28)*size*.19,Math.sin(a-.28)*size*.19);ctx.moveTo(Math.cos(a)*size*.30,Math.sin(a)*size*.30);ctx.lineTo(Math.cos(a+.28)*size*.19,Math.sin(a+.28)*size*.19);ctx.stroke();}
    } else if (name.includes('NEON')) {
      ctx.beginPath();ctx.moveTo(size*.12,-size*.5);ctx.lineTo(-size*.28,size*.06);ctx.lineTo(-size*.02,size*.06);ctx.lineTo(-size*.16,size*.48);ctx.lineTo(size*.31,-size*.12);ctx.lineTo(size*.04,-size*.12);ctx.closePath();ctx.fill();
    } else if (name.includes('BLOSSOM')) {
      for(let i=0;i<5;i++){ctx.save();ctx.rotate(i*Math.PI*2/5);ctx.beginPath();ctx.ellipse(0,-size*.24,size*.14,size*.25,0,0,Math.PI*2);ctx.fill();ctx.restore();}
      ctx.fillStyle='#ffe56e';ctx.beginPath();ctx.arc(0,0,size*.12,0,Math.PI*2);ctx.fill();
    } else if (name.includes('DARK')) {
      ctx.beginPath();ctx.arc(0,0,size*.38,0,Math.PI*2);ctx.fill();ctx.globalCompositeOperation='destination-out';ctx.beginPath();ctx.arc(size*.18,-size*.15,size*.34,0,Math.PI*2);ctx.fill();ctx.globalCompositeOperation='source-over';
      ctx.strokeStyle=color;ctx.beginPath();ctx.arc(0,0,size*.38,0,Math.PI*2);ctx.stroke();
    } else if (name.includes('RED') || name.includes('BLUE') || name.includes('GREEN') || name.includes('YELLOW')) {
      ctx.beginPath();ctx.arc(0,0,size*.36,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#ffffff';ctx.lineWidth=size*.045;ctx.stroke();
    } else if (name.includes('KUBO') || name.includes('BAHAY') || name.includes('MANSION') || name.includes('BUILDING')) {
      ctx.beginPath();ctx.moveTo(-size*.46,-size*.02);ctx.lineTo(0,-size*.42);ctx.lineTo(size*.46,-size*.02);ctx.closePath();ctx.fill();ctx.fillRect(-size*.34,-size*.02,size*.68,size*.42);
      ctx.fillStyle='#071426';ctx.fillRect(-size*.08,size*.16,size*.16,size*.24);
      if(name.includes('BUILDING')){ctx.fillStyle='#071426';for(let yy=-size*.25;yy<size*.20;yy+=size*.18)for(let xx=-size*.23;xx<size*.25;xx+=size*.18)ctx.fillRect(xx,yy,size*.08,size*.09);}
      if(name.includes('MANSION')){ctx.fillStyle=color;ctx.fillRect(-size*.40,-size*.26,size*.15,size*.20);ctx.fillRect(size*.25,-size*.26,size*.15,size*.20);}
    } else {
      ctx.beginPath();ctx.moveTo(0,-size*.46);ctx.lineTo(size*.4,0);ctx.lineTo(0,size*.46);ctx.lineTo(-size*.4,0);ctx.closePath();ctx.fill();
    }
    ctx.restore();
  };
  const card = (x, y, w, h, color, emoji, title, price, subtitle) => {
    // [FIXED] Clean vertical layout: logo, title, price and action never overlap.
    const rr = (px, py, pw, ph, radius) => {
      ctx.beginPath(); ctx.moveTo(px + radius, py); ctx.arcTo(px + pw, py, px + pw, py + ph, radius);
      ctx.arcTo(px + pw, py + ph, px, py + ph, radius); ctx.arcTo(px, py + ph, px, py, radius);
      ctx.arcTo(px, py, px + pw, py, radius); ctx.closePath();
    };
    ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = 10; rr(x, y, w, h, 12); ctx.fillStyle = '#080b19'; ctx.fill(); ctx.restore();
    const g = ctx.createLinearGradient(x, y, x + w, y + h); g.addColorStop(0, '#211f3c'); g.addColorStop(1, '#080d1a');
    rr(x, y, w, h, 12); ctx.fillStyle = g; ctx.fill();
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1.7; rr(x, y, w, h, 12); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 1; rr(x + 4, y + 4, w - 8, h - 8, 9); ctx.stroke(); ctx.restore();

    // Separate compact illustration area.
    const logoY = y + h * 0.25;
    ctx.save(); ctx.fillStyle = '#050914'; rr(x + 6, y + 6, w - 12, h * 0.39, 8); ctx.fill();
    ctx.save(); ctx.beginPath(); rr(x + 6, y + 6, w - 12, h * 0.39, 8); ctx.clip();
    ctx.globalAlpha = 0.35; ctx.fillStyle = color;
    for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.arc(x + 13 + ((k * 43) % Math.max(20, w - 26)), y + 12 + ((k * 13) % Math.max(14, h * 0.27)), 1.2, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    drawProductLogo(title, x + w / 2, logoY, Math.min(32, w * 0.21), color);
    ctx.restore();

    text(title, x + w / 2, y + h * 0.53, Math.min(14, w * 0.105), '#ffffff');
    // [FIXED] Price is a dedicated, unobstructed line; no subtitle or pill competes with it.
    text(price, x + w / 2, y + h * 0.70, Math.min(15, w * 0.115), '#ffe57a');
    const bh = Math.min(21, h * 0.18), by = y + h - bh - 5;
    const buy = ctx.createLinearGradient(x, by, x, by + bh); buy.addColorStop(0, '#7dffb0'); buy.addColorStop(0.5, '#17d879'); buy.addColorStop(1, '#087b55');
    rr(x + 7, by, w - 14, bh, bh / 2); ctx.fillStyle = buy; ctx.fill();
    ctx.save(); ctx.strokeStyle = '#a7ffd0'; ctx.lineWidth = 1; rr(x + 7, by, w - 14, bh, bh / 2); ctx.stroke(); ctx.restore();
    text('PREVIEW / BUY', x + w / 2, by + bh * 0.69, Math.min(10, w * 0.078), '#042719');
  };

  // [UPGRADED V29] Royal luxury header to match the premium JojoWorld shop caption.
  const headerGlow = ctx.createLinearGradient(70, 30, 730, 174);
  headerGlow.addColorStop(0, '#17112c'); headerGlow.addColorStop(0.5, '#252044'); headerGlow.addColorStop(1, '#10152b');
  ctx.save();
  ctx.shadowColor = '#ffd66b'; ctx.shadowBlur = 18;
  ctx.fillStyle = headerGlow; ctx.fillRect(42, 34, 716, 132);
  ctx.shadowBlur = 0; ctx.strokeStyle = '#f7d778'; ctx.lineWidth = 2; ctx.strokeRect(42, 34, 716, 132);
  ctx.strokeStyle = 'rgba(255,215,112,0.48)'; ctx.lineWidth = 1; ctx.strokeRect(49, 41, 702, 118);
  // Crown emblem drawn with Canvas paths so it renders consistently on the server.
  const drawRoyalCrown = (cx, cy, scale) => {
    ctx.save(); ctx.translate(cx, cy); ctx.scale(scale, scale);
    ctx.shadowColor = '#ffd66b'; ctx.shadowBlur = 10; ctx.fillStyle = '#ffd66b';
    ctx.beginPath(); ctx.moveTo(-18, -8); ctx.lineTo(-12, 7); ctx.lineTo(0, -1); ctx.lineTo(12, 7); ctx.lineTo(18, -8); ctx.lineTo(14, 12); ctx.lineTo(-14, 12); ctx.closePath(); ctx.fill();
    ctx.fillRect(-14, 14, 28, 3);
    ctx.restore();
  };
  drawRoyalCrown(400, 52, 0.72);
  const royalTitle = ctx.createLinearGradient(205, 0, 595, 0);
  royalTitle.addColorStop(0, '#fff0ad'); royalTitle.addColorStop(0.5, '#ffd45d'); royalTitle.addColorStop(1, '#fff0ad');
  ctx.shadowColor = '#ffc94f'; ctx.shadowBlur = 14;
  text('JOJOWORLD SHOP', 400, 91, 35, royalTitle);
  ctx.shadowBlur = 0;
  text('NAME EFFECTS  •  PROFILE UPGRADES  •  HOUSE COLLECTION', 400, 117, 12, '#e9e5ff');
  text('✦  PREVIEW  •  CHOOSE  •  FLEX YOUR STYLE  ✦', 400, 145, 14, '#ff8ff1');
  ctx.restore();

  panel(35, 182, 730, 184, '#ffd34f', '👑 VIP & PROFILE FRAMES');
  card(52, 223, 345, 128, '#ffd34f', '👑', 'VIP VERIFIED BADGE', '1,000 COINS', 'ELITE PROFILE');
  card(413, 223, 335, 128, '#ffb83f', '👑', 'ROYALTY PROFILE FRAME', '500 COINS', 'ROYAL CROWN • GOLD FILIGREE');

  panel(35, 384, 730, 562, '#e45bff', '💎 NAME EFFECTS • PROFILE STYLE');
  const effects = [
    ['🌈','RAINBOW','5,000c','#ff64d9'], ['✨','SPARKLE','10,000c','#d7a0ff'], ['💖','HEART','2,500c','#ff62b5'],
    ['🔥','FIRE','2,500c','#ff8748'], ['❄️','ICE','2,500c','#62eaff'], ['⚡','NEON','3,000c','#4affff'],
    ['🌸','BLOSSOM','2,000c','#ffa0dc'], ['🖤','DARK','2,500c','#b99bff'], ['🔴','RED','1,000c','#ff5555'],
    ['🔵','BLUE','1,000c','#59aaff'], ['🟢','GREEN','1,000c','#65f3a2'], ['🟡','YELLOW','1,000c','#ffe45c'],
    ['👑','GOLD','4,000c','#ffd34f'], ['😈','DEMON','4,000c','#ff4545']
  ];
  const ew = 224, eh = 96, ex = [52, 288, 524], ey = [425, 526, 627, 728, 829];
  effects.forEach((e, i) => card(ex[i % 3], ey[Math.floor(i / 3)], ew, eh, e[3], e[0], e[1], e[2], 'NAME EFFECT'));

  panel(35, 952, 730, 300, '#55efff', '🏠 HOUSE COLLECTION • UPGRADE YOUR HOME');
  const houses = [
    ['🛖','KUBO','1,500c','#e8c58e'], ['🏡','BAHAY','5,000c','#65eaff'],
    ['🏰','MANSION','15,000c','#c79bff'], ['🏢','BUILDING','40,000c','#ffd34f']
  ];
  const hw = 168, hh = 205, hx = [51, 229, 407, 585];
  houses.forEach((h, i) => {
    const x = hx[i], y = 995, w = hw, ht = hh, color = h[3];
    const g = ctx.createLinearGradient(x, y, x + w, y + ht); g.addColorStop(0, '#1b1a32'); g.addColorStop(1, '#070d1b');
    ctx.fillStyle = g; ctx.fillRect(x, y, w, ht); ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = 10; ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.strokeRect(x, y, w, ht); ctx.restore();
    // Premium layered house illustration with tier-specific glow and architectural details.
    ctx.fillStyle = '#050914'; ctx.fillRect(x + 7, y + 7, w - 14, 102);
    const houseKey = ['kubo','bahay','mansion','building'][i];
    const glow = ctx.createRadialGradient(x+w/2,y+58,3,x+w/2,y+58,78);
    glow.addColorStop(0, color + '66'); glow.addColorStop(1, '#05091400');
    ctx.fillStyle = glow; ctx.fillRect(x+7,y+7,w-14,102);
    drawHouseArt(ctx, houseKey, x+25, y+17, w-50, 84);
    ctx.save(); ctx.strokeStyle = color; ctx.globalAlpha=.65; ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(x+14,y+113);ctx.lineTo(x+w-14,y+113);ctx.stroke();ctx.restore();
    text(h[1], x + w/2, y + 132, 15, '#f4f7ff');
    text(h[2], x + w/2, y + 158, 17, '#ffe16b');
    ctx.fillStyle = '#16d98a'; ctx.fillRect(x + 12, y + 169, w - 24, 25); text('BUY / PREVIEW', x+w/2, y+186, 11, '#052b21');
  });

  // [ADDED] Clear action hint; real Messenger quick replies are sent alongside this image.
  ctx.textAlign = 'center'; ctx.shadowColor = '#36efff'; ctx.shadowBlur = 12;
  text('TAP A SHOP BUTTON BELOW TO PREVIEW & BUY', 400, 1292, 17, '#5af4ff'); ctx.shadowBlur = 0;
  text('COINS CHECKED • CONFIRM BEFORE PURCHASE', 400, 1320, 13, '#b6c9e4');
  text('MORE STYLE • MORE STATUS • MORE JOJOWORLD', 400, 1370, 15, '#ff8ff1');
  text('BE LEGENDARY!', 400, 1417, 27, '#ffe16b');
  await fsExtra.writeFile(file, canvas.toBuffer('image/jpeg', { quality: 0.9 })); return file;
}
async function generateShopProductPreview(product, user) {
  // [UPGRADED V28] Preview the selected item applied to a cloned profile before any coins are charged.
  const key = String(product || '').toLowerCase();
  const cfg = {
    vip: { title: 'VIP VERIFIED BADGE', price: '1,000 COINS', color: '#ffd34f', emoji: '👑', subtitle: 'VIP ELITE • VERIFIED PROFILE' },
    frame: { title: 'ROYALTY PROFILE FRAME', price: '500 COINS', color: '#ffd34f', emoji: '👑', subtitle: 'ROYAL CROWN • GOLD FILIGREE' },
    rainbow: { title: 'RAINBOW NAME EFFECT', price: '5,000 COINS', color: '#ff69e8', emoji: '🌈', subtitle: 'RARE • MULTICOLOR NAME' },
    sparkle: { title: 'SPARKLE NAME EFFECT', price: '10,000 COINS', color: '#d5a4ff', emoji: '✨', subtitle: 'MYTHIC • SHIMMERING NAME' },
    heart: { title: 'HEART NAME EFFECT', price: '2,500 COINS', color: '#ff62b5', emoji: '💖', subtitle: 'LOVE • PINK HEART STYLE' },
    fire: { title: 'FIRE NAME EFFECT', price: '2,500 COINS', color: '#ff8a3d', emoji: '🔥', subtitle: 'HOT • FLAME STYLE' },
    ice: { title: 'ICE NAME EFFECT', price: '2,500 COINS', color: '#78eaff', emoji: '❄️', subtitle: 'COLD • FROST STYLE' },
    neon: { title: 'NEON NAME EFFECT', price: '3,000 COINS', color: '#45ffff', emoji: '⚡', subtitle: 'NEON • ELECTRIC GLOW' },
    blossom: { title: 'BLOSSOM NAME EFFECT', price: '2,000 COINS', color: '#ff9cdb', emoji: '🌸', subtitle: 'CUTE • FLOWER STYLE' },
    dark: { title: 'DARK NAME EFFECT', price: '2,500 COINS', color: '#bd9bff', emoji: '🖤', subtitle: 'DARK • SHADOW STYLE' },
    red: { title: 'RED NAME EFFECT', price: '1,000 COINS', color: '#ff5252', emoji: '🔴', subtitle: 'SOLID RED STYLE' },
    blue: { title: 'BLUE NAME EFFECT', price: '1,000 COINS', color: '#54a8ff', emoji: '🔵', subtitle: 'SOLID BLUE STYLE' },
    green: { title: 'GREEN NAME EFFECT', price: '1,000 COINS', color: '#64f59b', emoji: '🟢', subtitle: 'SOLID GREEN STYLE' },
    yellow: { title: 'YELLOW NAME EFFECT', price: '1,000 COINS', color: '#ffe65b', emoji: '🟡', subtitle: 'SOLID YELLOW STYLE' },
    gold: { title: 'GOLD NAME EFFECT', price: '4,000 COINS', color: '#ffd34f', emoji: '👑', subtitle: 'LEGENDARY • GOLDEN ROYAL GLOW' },
    demon: { title: 'DEMON NAME EFFECT', price: '4,000 COINS', color: '#ff2424', emoji: '😈', subtitle: 'MYTHIC • INFERNAL RED AURA' },
    kubo: { title: 'KUBO HOUSE', price: '1,500 COINS', color: '#e4c18a', emoji: '🛖', subtitle: 'STARTER HOUSE • TIER 1' },
    bahay: { title: 'BAHAY HOUSE', price: '5,000 COINS', color: '#8fe5ff', emoji: '🏡', subtitle: 'UPGRADE • REQUIRES KUBO' },
    mansion: { title: 'MANSION HOUSE', price: '15,000 COINS', color: '#d9a5ff', emoji: '🏰', subtitle: 'PREMIUM • REQUIRES BAHAY' },
    building: { title: 'BUILDING HOUSE', price: '40,000 COINS', color: '#ffd34f', emoji: '🏢', subtitle: 'ELITE • REQUIRES MANSION' }
  };
  const item = cfg[key] || cfg.vip;
  const previewUser = { ...user, coins: Number(user.coins) || 0, id: 'preview-' + String(user.id || user.psid || 'member') + '-' + key };
  if (key === 'vip') { previewUser.vip = true; previewUser.badge = '👑 VIP Elite'; }
  else if (key === 'frame') { previewUser.goldFrame = true; previewUser.royalFrame = true; previewUser.frame = '👑 Royalty Frame'; }
  else if (['rainbow','sparkle','heart','fire','ice','neon','blossom','dark','red','blue','green','yellow','gold','demon'].includes(key)) previewUser.nameEffect = key;
  else if (['kubo','bahay','mansion','building'].includes(key)) previewUser.house = key;

  // Reuse finished name-effect artwork for the same user/name/effect. These previews do not
  // depend on avatar photos or changing profile details, unlike frame and other item previews.
  const nameEffectProducts = ['rainbow','sparkle','heart','fire','ice','neon','blossom','dark','red','blue','green','yellow','gold','demon'];
  const isNameEffectProduct = nameEffectProducts.includes(key);
  const isNameEffectPreview = isNameEffectProduct;
  // Generate each effect artwork lazily on its first shop preview; later previews reuse the cached PNG.
  const aiArtworkFile = isNameEffectProduct ? await getNameEffectArtwork(key, cacheDir, { loadFromStore: loadAINameArtFromMongo, saveToStore: saveAINameArtToMongo }) : null;
  const artworkCacheMode = aiArtworkFile ? 'ai' : (isNameEffectProduct && isAINameArtConfigured() ? 'fallback' : 'canvas');
  const previewOwner = String(user.psid || user.id || 'member').replace(/[^a-z0-9_-]/gi, '').slice(0, 48) || 'member';
  const previewNameText = String(getPlainDisplayName(previewUser) || 'member');
  const previewName = previewNameText.replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'member';
  const previewNameHash = previewNameText.split('').reduce((hash, char) => ((hash * 31) + char.charCodeAt(0)) >>> 0, 0).toString(36);
  const previewProduct = String(product || 'item').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'item';
  const file = path.join(cacheDir, 'shop_preview_v3_' + artworkCacheMode + '_' + previewOwner + '_' + previewProduct + '_' + previewName + '_' + previewNameHash + '.jpg');
  if (isNameEffectProduct && fs.existsSync(file)) return file;

  // Smooth visual mode: standard 800x900 product previews reduce rendering and upload time.
  const W = 800, H = 900, RENDER_SCALE = 1, canvas = createCanvas(W * RENDER_SCALE, H * RENDER_SCALE), ctx = canvas.getContext('2d');
  ctx.scale(RENDER_SCALE, RENDER_SCALE);
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#050510'); bg.addColorStop(0.5, '#11102b'); bg.addColorStop(1, '#030a17');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  if (aiArtworkFile && isNameEffectPreview) {
    try {
      const art = await loadImage(aiArtworkFile);
      const artScale = Math.max(W / art.width, H / art.height);
      ctx.save(); ctx.globalAlpha = 0.92;
      ctx.drawImage(art, (W - art.width * artScale) / 2, (H - art.height * artScale) / 2, art.width * artScale, art.height * artScale);
      const veil = ctx.createLinearGradient(0, 0, 0, H);
      veil.addColorStop(0, 'rgba(3,5,16,0.78)'); veil.addColorStop(0.38, 'rgba(3,5,16,0.36)'); veil.addColorStop(0.72, 'rgba(3,5,16,0.46)'); veil.addColorStop(1, 'rgba(3,5,16,0.84)');
      ctx.globalAlpha = 1; ctx.fillStyle = veil; ctx.fillRect(0, 0, W, H); ctx.restore();
    } catch (artError) { console.warn('[SHOP AI ART] Could not load cached artwork:', artError.message); }
  }
  for (let i = 0; i < 95; i++) {
    ctx.globalAlpha = 0.15 + (i % 4) * 0.08; ctx.fillStyle = [item.color, '#ff49e9', '#4af5ff'][i % 3];
    ctx.beginPath(); ctx.arc((i * 127 + 19) % W, (i * 83 + 27) % H, i % 8 === 0 ? 3 : 1.2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  // Name-effect previews intentionally have no surrounding box: only the name receives the cosmetic.
  const roundRect = (x,y,w,h,r) => { ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); };
  const borderGlow = ctx.createLinearGradient(18, 18, W-18, H-18); borderGlow.addColorStop(0, item.color); borderGlow.addColorStop(0.48, '#7b5cff'); borderGlow.addColorStop(1, '#ff4fd8');
  if (!isNameEffectPreview) {
    ctx.globalAlpha = 1; ctx.save(); ctx.shadowColor = item.color; ctx.shadowBlur = 30; ctx.strokeStyle = borderGlow; ctx.lineWidth = 5; roundRect(18,18,W-36,H-36,30); ctx.stroke(); ctx.restore();
    ctx.strokeStyle = '#ffffff'; ctx.globalAlpha = 0.35; ctx.lineWidth = 1.2; roundRect(29,29,W-58,H-58,24); ctx.stroke(); ctx.globalAlpha = 1;
  }
  ctx.textAlign = 'center'; ctx.fillStyle = '#f4f8ff'; ctx.font = 'bold 22px Sans'; ctx.fillText('✦ JOJOWORLD • ITEM SHOWCASE ✦', 400, 76);
  ctx.fillStyle = item.color; ctx.shadowColor = item.color; ctx.shadowBlur = 22; ctx.font = 'bold 30px Sans'; ctx.fillText(item.title, 400, 132); ctx.shadowBlur = 0;
  if (!isNameEffectPreview) {
    const gx = ctx.createLinearGradient(105, 205, 695, 630); gx.addColorStop(0, '#20203b'); gx.addColorStop(0.55, '#10162d'); gx.addColorStop(1, '#080d1c');
    ctx.fillStyle = gx; roundRect(105,195,590,440,28); ctx.fill();
    ctx.save(); ctx.shadowColor = item.color; ctx.shadowBlur = 28; ctx.strokeStyle = borderGlow; ctx.lineWidth = (key === 'frame' || previewUser.goldFrame) ? 7 : 3; roundRect(105,195,590,440,28); ctx.stroke(); ctx.restore();
    ctx.save(); ctx.globalAlpha = 0.15; ctx.fillStyle = item.color; roundRect(125,212,550,54,16); ctx.fill(); ctx.restore();
    ctx.fillStyle = '#a9bdd8'; ctx.font = 'bold 16px Sans'; ctx.fillText('PROFILE DISPLAY AFTER APPLY', 400, 240);
  }

  if (['kubo','bahay','mansion','building'].includes(key)) {
    // Use the exact same house-art renderer as the Visual Profile so the preview matches the purchased asset.
    const houseGlow = ctx.createRadialGradient(400, 420, 8, 400, 420, 190);
    houseGlow.addColorStop(0, item.color + '66'); houseGlow.addColorStop(1, '#07102000');
    ctx.fillStyle = houseGlow; ctx.fillRect(180, 260, 440, 360);
    drawHouseArt(ctx, key, 285, 280, 230, 300);
    ctx.fillStyle = item.color; ctx.shadowColor = item.color; ctx.shadowBlur = 12;
    ctx.font = 'bold 22px Sans'; ctx.textAlign = 'center'; ctx.fillText(item.title, 400, 590); ctx.shadowBlur = 0;
  } else if (key === 'frame') {
    // Preview the frame around an avatar using the shared frame state/color logic used by Profile and Leaderboard.
    const frameStyle = getEquippedFrameStyle(previewUser);
    const ax = 400, ay = 385, photoRadius = 78;
    ctx.save(); ctx.fillStyle = '#091226'; ctx.shadowColor = frameStyle.glow; ctx.shadowBlur = 25;
    ctx.beginPath(); ctx.arc(ax, ay, 88, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    let photoShown = false;
    try {
      let photo = null;
      if (user.profilePhotoData) photo = await loadCachedProfilePhotoData(user.profilePhotoData);
      else if (user.profilePhotoUrl) photo = await loadCachedProfilePhotoUrl(user.profilePhotoUrl);
      if (photo) {
        ctx.save(); ctx.beginPath(); ctx.arc(ax, ay, photoRadius, 0, Math.PI * 2); ctx.clip();
        const scale = Math.max((photoRadius * 2) / photo.width, (photoRadius * 2) / photo.height);
        const pw = photo.width * scale, ph = photo.height * scale;
        ctx.drawImage(photo, ax - pw / 2, ay - ph / 2, pw, ph); ctx.restore(); photoShown = true;
      }
    } catch (photoError) {
      console.warn('[SHOP PREVIEW] Could not load profile photo:', photoError.message);
    }
    if (!photoShown) {
      ctx.save(); ctx.fillStyle = '#263c62'; ctx.beginPath(); ctx.arc(ax, ay - 20, 26, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(ax, ay + 38, 43, 32, 0, Math.PI, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#d9e8fa'; ctx.font = 'bold 12px Sans'; ctx.textAlign = 'center'; ctx.fillText('YOUR AVATAR', ax, ay + 8); ctx.restore();
    }
    ctx.save(); ctx.shadowColor = frameStyle.glow; ctx.shadowBlur = frameStyle.equipped ? 25 : 12;
    ctx.strokeStyle = frameStyle.equipped ? frameStyle.color : item.color;
    ctx.lineWidth = frameStyle.equipped ? 9 : 5; ctx.beginPath(); ctx.arc(ax, ay, 87, 0, Math.PI * 2); ctx.stroke();
    if (frameStyle.gold || frameStyle.royal) {
      ctx.strokeStyle = '#fff2b3'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(ax, ay, 77, 0, Math.PI * 2); ctx.stroke();
    }
    if (frameStyle.diamond || frameStyle.neon) {
      ctx.strokeStyle = frameStyle.color; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(ax, ay, 77, 0, Math.PI * 2); ctx.stroke();
    }
    if (frameStyle.royal) {
      ctx.shadowColor = '#ffd34f'; ctx.shadowBlur = 16; ctx.strokeStyle = '#fff0a6'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(ax, ay, 98, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#d99018'; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(ax, ay, 105, Math.PI * 1.08, Math.PI * 1.92); ctx.stroke();
      ctx.fillStyle = '#ffdf69';
      for (let j = 0; j < 12; j++) { const angle = -Math.PI / 2 + j * Math.PI / 6, rx = ax + Math.cos(angle) * 101, ry = ay + Math.sin(angle) * 101; ctx.beginPath(); ctx.arc(rx, ry, j % 3 === 0 ? 5 : 2.5, 0, Math.PI * 2); ctx.fill(); }
      ctx.beginPath(); ctx.moveTo(ax - 47, ay - 88); ctx.lineTo(ax - 38, ay - 119); ctx.lineTo(ax - 13, ay - 97); ctx.lineTo(ax, ay - 132); ctx.lineTo(ax + 14, ay - 97); ctx.lineTo(ax + 39, ay - 119); ctx.lineTo(ax + 48, ay - 88); ctx.closePath();
      ctx.fillStyle = '#d99a25'; ctx.fill(); ctx.strokeStyle = '#fff0a6'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#63eaff'; ctx.beginPath(); ctx.arc(ax, ay - 113, 5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    const displayName = getPlainDisplayName(previewUser).slice(0, 25);
    ctx.textAlign = 'center'; ctx.font = 'bold 26px Sans'; ctx.fillStyle = '#f4f7ff';
    ctx.shadowColor = frameStyle.glow; ctx.shadowBlur = 10; ctx.fillText(displayName, 400, 535); ctx.shadowBlur = 0;
    ctx.fillStyle = frameStyle.color; ctx.font = 'bold 18px Sans'; ctx.fillText('ROYALTY FRAME • CROWN BORDER', 400, 585);
  } else {
    const displayName = getPlainDisplayName(previewUser).slice(0, 25);
    // Render the selected name effect with the same effect renderer used by Profile and Leaderboard.
    const previewEffect = String(previewUser.nameEffect || key || 'none').toLowerCase();
    if (!drawPremiumNameEffect(ctx, displayName, 400, 385, 620, previewEffect, 'center', 62)) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.font = 'bold 34px Arial Black';
      ctx.fillStyle = item.color;
      ctx.shadowColor = item.color;
      ctx.shadowBlur = 18;
      ctx.fillText(displayName.toUpperCase(), 400, 385);
      ctx.restore();
    }
    if (!isNameEffectPreview) { ctx.fillStyle = item.color; ctx.font = 'bold 68px Sans'; ctx.fillText(item.emoji, 400, 485); }
    if (key === 'vip') {
      // Match the actual verified shield drawn on the purchased user's Visual Profile.
      ctx.save(); ctx.translate(400, 545); ctx.shadowColor = '#ffd34f'; ctx.shadowBlur = 22;
      const shield = () => { ctx.beginPath(); ctx.moveTo(0,-30); ctx.lineTo(25,-19); ctx.lineTo(23,8); ctx.quadraticCurveTo(14,25,0,33); ctx.quadraticCurveTo(-14,25,-23,8); ctx.lineTo(-25,-19); ctx.closePath(); };
      const gold = ctx.createLinearGradient(-25,-30,25,33); gold.addColorStop(0,'#fffbd0'); gold.addColorStop(.38,'#ffd447'); gold.addColorStop(.72,'#f4a900'); gold.addColorStop(1,'#a95b05');
      ctx.fillStyle = gold; shield(); ctx.fill(); ctx.shadowBlur = 0; ctx.strokeStyle = '#fff8cf'; ctx.lineWidth = 2.5; shield(); ctx.stroke();
      // Matching royalty crown and gem accents, identical gold palette to the live profile badge.
      ctx.shadowColor='#ffd34f';ctx.shadowBlur=12;ctx.fillStyle='#f6b900';ctx.strokeStyle='#fff4b0';ctx.lineWidth=1.8;
      ctx.beginPath();ctx.moveTo(-19,-28);ctx.lineTo(-17,-44);ctx.lineTo(-8,-34);ctx.lineTo(0,-48);ctx.lineTo(8,-34);ctx.lineTo(17,-44);ctx.lineTo(19,-28);ctx.closePath();ctx.fill();ctx.stroke();
      ctx.fillStyle='#64eaff';ctx.beginPath();ctx.arc(0,-38,3,0,Math.PI*2);ctx.fill();
      ctx.shadowBlur=0;ctx.strokeStyle='#9b5a08';ctx.lineWidth=1.5;shield();ctx.stroke();
      ctx.fillStyle='#fff5c2';for(const gx of [-16,16]){ctx.beginPath();ctx.arc(gx,-9,2.3,0,Math.PI*2);ctx.fill();}
      ctx.strokeStyle='#ffffff';ctx.lineWidth=5;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();ctx.moveTo(-11,1);ctx.lineTo(-3,10);ctx.lineTo(13,-10);ctx.stroke();ctx.restore();
      const royalPlate=ctx.createLinearGradient(250,620,550,690);royalPlate.addColorStop(0,'#fffbd0');royalPlate.addColorStop(.22,'#ffd447');royalPlate.addColorStop(.5,'#f4a900');royalPlate.addColorStop(.78,'#a95b05');royalPlate.addColorStop(1,'#fff0a0');
      ctx.save();ctx.shadowColor='#ffd34f';ctx.shadowBlur=20;ctx.fillStyle='#080b17';roundRect(245,615,310,72,18);ctx.fill();ctx.strokeStyle=royalPlate;ctx.lineWidth=3;roundRect(245,615,310,72,18);ctx.stroke();ctx.strokeStyle='#fff0a0';ctx.lineWidth=1;roundRect(252,622,296,58,13);ctx.stroke();ctx.shadowBlur=0;
      ctx.fillStyle=royalPlate;ctx.font='bold 21px Sans';ctx.textAlign='center';ctx.fillText('ROYAL VERIFIED',400,647);
      ctx.fillStyle='#fff4c2';ctx.font='bold 13px Sans';ctx.fillText('VIP ELITE MEMBER',400,670);ctx.restore();
    } else {
      ctx.fillStyle = item.color; ctx.font = 'bold 15px Sans'; ctx.fillText(item.subtitle, 400, 560);
    }
  }
  // [UPGRADED V28] High-contrast price panel and polished call-to-action footer for all cosmetics and houses.
  const priceGrad = ctx.createLinearGradient(170, 675, 630, 735); priceGrad.addColorStop(0, '#fff0a0'); priceGrad.addColorStop(0.45, item.color); priceGrad.addColorStop(1, '#ffffff');
  ctx.save(); ctx.shadowColor = item.color; ctx.shadowBlur = 18; ctx.fillStyle = '#0b1025'; roundRect(185,665,430,72,22); ctx.fill(); ctx.strokeStyle = item.color; ctx.lineWidth = 2; roundRect(185,665,430,72,22); ctx.stroke(); ctx.restore();
  ctx.fillStyle = priceGrad; ctx.shadowColor = item.color; ctx.shadowBlur = 12; ctx.font = 'bold 27px Sans'; ctx.fillText('✦ ' + item.price + ' ✦', 400, 710); ctx.shadowBlur = 0;
  ctx.fillStyle = '#d9e8fa'; ctx.font = '17px Sans'; ctx.fillText(item.subtitle, 400, 770);
  const ctaGrad = ctx.createLinearGradient(175, 790, 625, 835); ctaGrad.addColorStop(0, '#ffd34f'); ctaGrad.addColorStop(0.5, '#fff3a6'); ctaGrad.addColorStop(1, '#ff9e2c');
  ctx.save(); ctx.shadowColor = '#ffbf3f'; ctx.shadowBlur = 22; ctx.fillStyle = ctaGrad; roundRect(175,790,450,52,20); ctx.fill(); ctx.restore();
  ctx.fillStyle = '#17112b'; ctx.font = 'bold 18px Sans'; ctx.fillText('✦ PREVIEW NOW  •  BUY WHEN READY ✦', 400, 822);
  ctx.fillStyle = '#a7bad1'; ctx.font = '13px Sans'; ctx.fillText('See how it looks on your profile before you buy', 400, 865);
  // Name-effect previews are safely reused on later requests; other item previews are refreshed.
  await fsExtra.writeFile(file, canvas.toBuffer('image/jpeg', { quality: 0.9 })); return file;
}
// [ADDED] [UPGRADED V28] Brief leaderboard data cache avoids a full MongoDB scan on rapid repeat taps.
let leaderboardUsersCache = { users: null, createdAt: 0 };
let leaderboardImageCache = { file: null, createdAt: 0 };
const LEADERBOARD_CACHE_MS = 30000; // Cache leaderboard data/image for 30 seconds to avoid repeated DB scans and canvas renders.

// [UPGRADED] Merge saved MongoDB players with the local cache so a valid player
// is not dropped from the leaderboard when this process has only a partial cache.
async function getLeaderboardUsers() {
  if (leaderboardUsersCache.users && Date.now() - leaderboardUsersCache.createdAt < LEADERBOARD_CACHE_MS) {
    return leaderboardUsersCache.users;
  }
  const combined = { ...(db.users || {}) };
  if (MONGODB_URI && mongoose.connection.readyState === 1) {
    try {
      const docs = await UserModel.find({}).select("psid data").lean();
      for (const doc of docs) {
        if (doc && doc.psid && doc.data && typeof doc.data === "object") {
          // Persisted values are authoritative; cached-only players remain as fallback.
          combined[doc.psid] = doc.data;
          db.users[doc.psid] = doc.data;
        }
      }
      leaderboardUsersCache = { users: combined, createdAt: Date.now() }; // [FIXED] Cache MongoDB results too, avoiding repeated full scans.
      return combined;
    } catch (error) {
      console.error("[UPGRADED] Could not fully load leaderboard from MongoDB; using merged cache:", error.message);
    }
  }
  leaderboardUsersCache = { users: combined, createdAt: Date.now() };
  return combined;
}

async function generateLeaderboardCanvas(users) {
  // [ADDED] [UPGRADED V28] Reuse the last rendered image for rapid repeat requests.
  // The short cache reduces repeat rendering cost while allowing rankings to refresh frequently.
  if (leaderboardImageCache.file && Date.now() - leaderboardImageCache.createdAt < LEADERBOARD_CACHE_MS &&
      fs.existsSync(leaderboardImageCache.file)) {
    return leaderboardImageCache.file;
  }
  // [UPGRADED V28] Premium JojoWorld leaderboard: gold Top 1 podium + neon Top 2/3 + ranks 4-10.
  // [UPGRADED V28] Canvas height trimmed to remove unused bottom space; content uses nearly the full image.
  const W = 800, H = 1320, RENDER_SCALE = 1; // Smooth standard-resolution leaderboard; names and layout retain their existing logical sizes.
  const canvas = createCanvas(Math.round(W * RENDER_SCALE), Math.round(H * RENDER_SCALE)), ctx = canvas.getContext('2d');
  ctx.scale(RENDER_SCALE, RENDER_SCALE);
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#060513'); bg.addColorStop(0.42, '#10102f'); bg.addColorStop(1, '#020b19');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  // [ADDED] Neon stars, light streaks, and premium double frame.
  for (let i = 0; i < 150; i++) {
    const x = (i * 137 + 23) % (W - 12) + 6, y = (i * 83 + 11) % (H - 12) + 6;
    ctx.fillStyle = ['#35f4ff', '#ff45e8', '#ffd45a', '#b58cff'][i % 4];
    ctx.globalAlpha = 0.12 + (i % 5) * 0.075; ctx.beginPath(); ctx.arc(x, y, i % 8 === 0 ? 2.5 : 1, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  for (let i = 0; i < 9; i++) {
    ctx.strokeStyle = i % 2 ? '#ff36e8' : '#36edff'; ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(i * 100 - 80, 200); ctx.lineTo(i * 100 + 90, 15); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 20; ctx.shadowColor = '#31eaff'; ctx.strokeStyle = '#31eaff'; ctx.lineWidth = 4; ctx.strokeRect(16, 16, W - 32, H - 32);
  ctx.shadowColor = '#ff39e8'; ctx.strokeStyle = '#ff39e8'; ctx.lineWidth = 1.5; ctx.strokeRect(26, 26, W - 52, H - 52); ctx.shadowBlur = 0;
  // [ADDED] JojoWorld branding and oversized title.
  ctx.textAlign = 'left'; ctx.shadowColor = '#ffd54a'; ctx.shadowBlur = 12;
  ctx.fillStyle = '#ffe56d'; ctx.font = 'bold 23px Sans'; ctx.fillText('♛ JojoWorld', 42, 62);
  ctx.shadowBlur = 0; ctx.fillStyle = '#d8faff'; ctx.font = 'bold 11px Sans'; ctx.fillText('PLAY • CHAT • WIN', 45, 81);
  ctx.textAlign = 'right'; ctx.fillStyle = '#ff8df1'; ctx.font = 'italic bold 17px Sans'; ctx.fillText('Climb The Rank', 755, 48); ctx.fillText('Be The Best!', 755, 71);
  ctx.textAlign = 'center'; ctx.shadowColor = '#ffc94b'; ctx.shadowBlur = 22;
  ctx.fillStyle = '#fff4bd'; ctx.font = 'bold 49px Sans'; ctx.fillText('LEADERBOARD', 400, 112);
  ctx.fillStyle = '#ffc94b'; ctx.font = 'bold 52px Sans'; ctx.fillText('TOP 10', 400, 164); ctx.shadowBlur = 0;
  const divider = ctx.createLinearGradient(40, 0, 760, 0);
  divider.addColorStop(0, '#36efff'); divider.addColorStop(0.32, '#ff4ce7'); divider.addColorStop(0.62, '#ffe16a'); divider.addColorStop(1, '#36efff');
  ctx.strokeStyle = divider; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(42, 187); ctx.lineTo(758, 187); ctx.stroke();

  const houseNames = { none: 'No House', nohouse: 'No House', kubo: 'Kubo', bahay: 'Bahay', mansion: 'Mansion', building: 'Building' };
  const top = Object.entries(users || {}).map(([id, user]) => ({ id, user, net: getNetWorth(user) }))
    .sort((a, b) => b.net - a.net).slice(0, 10);
  const accents = ['#ffd34f', '#dce8ff', '#ff8af4', '#3ceeff', '#e64cff', '#3ceeff', '#e64cff', '#3ceeff', '#e64cff', '#3ceeff'];
  // [FIXED] Preserve the complete displayed player name; sizing is handled per card so names are not cut at 19 characters.
  const getName = item => cleanName(item.user && item.user.name).slice(0, 26);
  // [UPGRADED V28] Render purchased name effects as real colors/glow in leaderboard text.
  const effectPalette = {
    rainbow: ['#ff5353','#ffad43','#fff05c','#4bff91','#4bdfff','#a57aff','#ff70dd'],
    sparkle: ['#fff2a8','#d5a4ff','#ffffff','#ffe68a'],
    heart: ['#ff62b5','#ff9bd6','#ffd5ed'],
    fire: ['#ff4d22','#ff8a3d','#ffe36a'],
    ice: ['#78eaff','#d8fbff','#5b9dff'],
    neon: ['#45ffff','#a77bff','#ff4fe1'],
    blossom: ['#ff9cdb','#ffd4ed','#ff70a6'],
    dark: ['#bd9bff','#5c4b8a','#e5dcff'],
    red: ['#ff5252','#ff9b9b'], blue: ['#54a8ff','#a6d8ff'],
    green: ['#64f59b','#c2ffd9'], yellow: ['#ffe65b','#fff4b0']
  };
  // [FIXED V36] Support centered names on Top 1–3 cards and fixed left alignment on ranks 4–10.
  const drawEffectNameLine = (text, x, y, fontSize, effectKey, maxWidth, baseColor = '#effaff', align = 'left') => {
    const premiumEffect = String(effectKey || '').toLowerCase();
    if (drawPremiumNameEffect(ctx, text, x, y, maxWidth, premiumEffect, align)) return;
    const palette = effectPalette[premiumEffect];
    ctx.save();
    ctx.textAlign = align;
    ctx.font = 'bold ' + fontSize + 'px Sans';
    if (palette && palette.length > 1) {
      const gradientStart = align === 'center' ? x - Math.max(80, maxWidth) / 2 : x;
      const gradientEnd = align === 'center' ? x + Math.max(80, maxWidth) / 2 : x + Math.max(80, maxWidth);
      const gradient = ctx.createLinearGradient(gradientStart, 0, gradientEnd, 0);
      palette.forEach((color, index) => gradient.addColorStop(index / (palette.length - 1), color));
      ctx.fillStyle = gradient;
      ctx.shadowColor = palette[Math.min(1, palette.length - 1)];
      ctx.shadowBlur = effectKey === 'sparkle' || effectKey === 'neon' || effectKey === 'rainbow' ? 13 : 9;
    } else if (palette && palette.length === 1) {
      ctx.fillStyle = palette[0];
      ctx.shadowColor = palette[0];
      ctx.shadowBlur = 9;
    } else {
      ctx.fillStyle = baseColor;
      ctx.shadowBlur = 0;
    }
    ctx.fillText(text, x, y);
    // [UPGRADED V34] Name effects use text styling only; no extra glyphs or ornaments.
    ctx.restore();
  };
  const getHouse = item => {
    const key = String(item.user.house || 'none').toLowerCase();
    return houseNames[key] || String(item.user.house || 'No House');
  };
  const getHouseWorth = item => Number(getHouseValue(item.user.house)) || 0;
  const drawMedal = (x, y, rank, color, radius) => {
    ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = 15; ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff4cf'; ctx.lineWidth = 2; ctx.stroke(); ctx.shadowBlur = 0;
    ctx.fillStyle = '#111127'; ctx.textAlign = 'center'; ctx.font = 'bold ' + Math.round(radius * 0.9) + 'px Sans';
    ctx.fillText(String(rank), x, y + radius * 0.32); ctx.restore();
  };
  // [UPGRADED V28] Draw each player's saved profile photo; use a clean initials/avatar fallback.
  const drawLeaderboardAvatar = async (item, x, y, radius) => {
    ctx.save();
    ctx.fillStyle = '#172344'; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
    let avatar = null;
    try {
      if (item && item.user && item.user.profilePhotoData) avatar = await loadCachedProfilePhotoData(item.user.profilePhotoData);
      else if (item && item.user && item.user.profilePhotoUrl) avatar = await loadCachedProfilePhotoUrl(item.user.profilePhotoUrl);
    } catch (e) { console.warn('[LEADERBOARD PHOTO] Could not load profile photo:', e.message); }
    if (avatar) {
      ctx.save(); ctx.beginPath(); ctx.arc(x, y, radius - 3, 0, Math.PI * 2); ctx.clip();
      const scale = Math.max((radius - 3) * 2 / avatar.width, (radius - 3) * 2 / avatar.height);
      const aw = avatar.width * scale, ah = avatar.height * scale;
      ctx.drawImage(avatar, x - aw / 2, y - ah / 2, aw, ah); ctx.restore();
    } else {
      const initials = String(item && item.user ? getDisplayName(item.user) || item.user.name || 'JW' : 'JW').trim().split(/\s+/).slice(0,2).map(v=>v[0]||'').join('').toUpperCase();
      ctx.fillStyle = '#d9e8ff'; ctx.font = 'bold ' + Math.round(radius * .8) + 'px Sans'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(initials || 'JW', x, y); ctx.textBaseline = 'alphabetic';
    }
    // [GLOBAL COSMETIC SYNC] Match the Visual Profile frame color and glow exactly.
    const frameStyle = getEquippedFrameStyle(item && item.user ? item.user : {});
    ctx.shadowColor = frameStyle.glow;
    ctx.shadowBlur = frameStyle.equipped ? 18 : 0;
    ctx.strokeStyle = frameStyle.color;
    ctx.lineWidth = frameStyle.equipped ? 5 : 3;
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.stroke();
    if (frameStyle.gold || frameStyle.royal) {
      ctx.shadowBlur = 8; ctx.strokeStyle = '#fff2b3'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, radius - 5, 0, Math.PI * 2); ctx.stroke();
    } else if (frameStyle.diamond || frameStyle.neon) {
      ctx.shadowBlur = 8; ctx.strokeStyle = frameStyle.color; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, radius - 5, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  };
  const drawPodium = async (item, rank, x, y, w, h, color, featured) => {
    const grad = ctx.createLinearGradient(x, y, x + w, y + h);
    grad.addColorStop(0, featured ? '#68400b' : (rank === 2 ? '#25334b' : '#471746'));
    grad.addColorStop(0.5, featured ? '#21152b' : '#11152b'); grad.addColorStop(1, '#071321');
    ctx.fillStyle = grad; ctx.fillRect(x, y, w, h);
    ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = featured ? 24 : 13; ctx.strokeStyle = color; ctx.lineWidth = featured ? 3 : 2;
    ctx.strokeRect(x, y, w, h); ctx.restore();
    ctx.textAlign = 'center'; ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 12;
    ctx.font = 'bold ' + (featured ? 26 : 23) + 'px Sans'; ctx.fillText(rank === 1 ? '♛ #1 CHAMPION' : '#' + rank, x + w / 2, y + 32); // [UPGRADED V28] Larger podium rank labels. ctx.shadowBlur = 0;
    // [FIXED] Keep the rank medal above the avatar so they never collide.
    drawMedal(x + w / 2, y + 63, rank, color, featured ? 22 : 20); // [UPGRADED V28] Larger rank medals.
    if (!item) {
      ctx.fillStyle = '#9eb5cc'; ctx.font = 'bold 18px Sans'; ctx.fillText('OPEN RANK', x + w / 2, y + 112);
      ctx.fillStyle = '#6e849b'; ctx.font = '13px Sans'; ctx.fillText('Play to claim this spot', x + w / 2, y + 137);
      return;
    }
    // [FIXED] Podium content uses separate vertical zones: medal, avatar, name, and stats never overlap.
    // [UPGRADED V28] Larger, clearly separated profile photo for flex visibility.
    await drawLeaderboardAvatar(item, x + w / 2, y + 132, featured ? 42 : 38); // [UPGRADED V28] Significantly larger podium profile photos.
    const name = getName(item);
    const podiumEffect = String(item.user.nameEffect || '').toLowerCase();
    // [UPGRADED V28] Apply the equipped effect's color and glow to Top 1–3 names.
    // [FIXED] Show the full podium name by wrapping it inside the card instead of letting neighboring cards cover it.
    const podiumWords = name.split(/\s+/);
    let podiumLines = [], podiumLine = '';
    let podiumFontSize = featured ? 19 : 17;
    ctx.font = 'bold ' + podiumFontSize + 'px Sans';
    for (const word of podiumWords) {
      const candidate = podiumLine ? podiumLine + ' ' + word : word;
      if (ctx.measureText(candidate).width > w - 18 && podiumLine) {
        podiumLines.push(podiumLine);
        podiumLine = word;
      } else podiumLine = candidate;
    }
    if (podiumLine) podiumLines.push(podiumLine);
    while (podiumLines.some(line => ctx.measureText(line).width > w - 18) && podiumFontSize > 12) {
      podiumFontSize--;
      ctx.font = 'bold ' + podiumFontSize + 'px Sans';
    }
    if (podiumLines.length > 2) {
      podiumLines = [podiumLines.slice(0, podiumLines.length - 1).join(' '), podiumLines[podiumLines.length - 1]];
      while (ctx.measureText(podiumLines[0]).width > w - 18 && podiumFontSize > 12) {
        podiumFontSize--;
        ctx.font = 'bold ' + podiumFontSize + 'px Sans';
      }
    }
    // [FIXED V36] Top 1–3 player names are centered on each card's actual midpoint.
    const podiumCenterX = x + w / 2;
    drawEffectNameLine(podiumLines[0] || name, podiumCenterX, y + 198, podiumFontSize, podiumEffect, w - 18, featured ? '#fff0a4' : '#eff8ff', 'center');
    if (podiumLines[1]) drawEffectNameLine(podiumLines[1], podiumCenterX, y + 216, podiumFontSize, podiumEffect, w - 18, featured ? '#fff0a4' : '#eff8ff', 'center');
    ctx.fillStyle = '#ffd85e'; ctx.font = 'bold ' + (featured ? 23 : 21) + 'px Sans'; // [UPGRADED V28] Larger coin flex stats.
    ctx.fillText((Math.max(0, Number(item.user.coins) || 0)).toLocaleString('en-US') + ' coins', x + w / 2, y + 239);
    ctx.fillStyle = '#d4f6ff'; ctx.font = '17px Sans'; // [UPGRADED V28] Larger house and property stats.
    ctx.fillText('House: ' + getHouse(item), x + w / 2, y + 261);
    ctx.fillText('Value: ' + getHouseWorth(item).toLocaleString('en-US') + 'c', x + w / 2, y + 282);
    ctx.fillStyle = '#ffe08a'; ctx.font = 'bold 18px Sans'; // [UPGRADED V28] Larger net-worth flex stat.
    ctx.fillText('NET WORTH: ' + item.net.toLocaleString('en-US') + 'c', x + w / 2, y + 304);
    ctx.fillStyle = color; ctx.font = 'bold 14px Sans';
    ctx.fillText(rank === 1 ? '★ TOP PLAYER ★' : (rank === 2 ? 'ELITE PLAYER' : 'RISING STAR'), x + w / 2, y + h - 12);
  };

  // [UPGRADED V28] A real podium layout for the top three, with the champion centered.
  await drawPodium(top[1], 2, 38, 205, 222, 330, '#b8d8ff', false); // [UPGRADED V28] Taller podium for larger profile and stats.
  await drawPodium(top[0], 1, 270, 190, 260, 345, '#ffd34f', true); // [UPGRADED V28] Larger champion card.
  await drawPodium(top[2], 3, 540, 205, 222, 330, '#ff83e9', false); // [UPGRADED V28] Taller podium for larger profile and stats.

  // [UPGRADED V28] Compact, readable neon cards for ranks 4–10.
  for (let rank = 4; rank <= 10; rank++) {
    // [UPGRADED V28] Taller leaderboard cards for readable photos, names, and flex stats.
    const i = rank - 1, item = top[i], y = 555 + (rank - 4) * 98, color = accents[i]; // [UPGRADED V28] More room per player row.
    const grad = ctx.createLinearGradient(38, y, 762, y + 88);
    grad.addColorStop(0, rank % 2 === 0 ? '#092843' : '#21113c'); grad.addColorStop(1, '#080f24');
    ctx.fillStyle = grad; ctx.fillRect(38, y, 724, 88);
    ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = 8; ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.strokeRect(38, y, 724, 88); ctx.restore();
    if (!item) {
      // [FIXED V37] Show the rank badge only for empty slots; occupied rows use the avatar instead.
      ctx.fillStyle = color; ctx.beginPath();
      for (let p = 0; p < 10; p++) {
        const angle = -Math.PI / 2 + p * Math.PI / 5, rad = p % 2 === 0 ? 28 : 22;
        const px = 78 + Math.cos(angle) * rad, py = y + 40 + Math.sin(angle) * rad;
        if (p === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill(); ctx.strokeStyle = '#fff4cf'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#101020'; ctx.textAlign = 'center'; ctx.font = 'bold 24px Sans'; ctx.fillText(String(rank), 78, y + 48);
      ctx.textAlign = 'left'; ctx.fillStyle = '#a9c2d8'; ctx.font = 'bold 19px Sans'; ctx.fillText('OPEN RANK', 119, y + 33);
      ctx.fillStyle = '#7189a0'; ctx.font = '13px Sans'; ctx.fillText('Register and play to claim this spot', 119, y + 57);
      ctx.textAlign = 'right'; ctx.fillStyle = color; ctx.font = 'bold 13px Sans'; ctx.fillText('AVAILABLE', 744, y + 47);
      continue;
    }
    const name = getName(item), coins = Math.max(0, Number(item.user.coins) || 0);
    // [FIXED] Stable leaderboard grid: avatar, player/coins, house, and net worth have separate columns.
    // [UPGRADED V28] Larger row avatar; player text starts farther right to avoid overlap.
    // [UPGRADED V28] Larger row avatar and readable name/coin/house/net-worth fields.
    await drawLeaderboardAvatar(item, 125, y + 44, 39); // [UPGRADED V28] Much bigger Top 4–10 profile photos.
    // [FIXED V35] Ranks 4–10 use one fixed, left-aligned name column on every row.
    // Keep the name just outside the avatar edge; Top 1–3 podium alignment is unchanged.
    // Long names shrink and then ellipsize within the same column.
    const rowEffect = String(item.user.nameEffect || '').toLowerCase();
    const rank4to10NameX = 170, nameY = y + 32, nameMaxWidth = 470; // [FIXED V36] Fixed name column stops before the right-side net-worth column.
    const nameX = rank4to10NameX;
    ctx.textAlign = 'left';
    let displayRowName = name;
    let rowNameFontSize = 22;
    ctx.textAlign = 'left';
    ctx.font = 'bold ' + rowNameFontSize + 'px Sans';
    while (ctx.measureText(displayRowName).width > nameMaxWidth && rowNameFontSize > 12) {
      rowNameFontSize--;
      ctx.font = 'bold ' + rowNameFontSize + 'px Sans';
    }
    if (ctx.measureText(displayRowName).width > nameMaxWidth) {
      while (displayRowName.length > 1 && ctx.measureText(displayRowName + '…').width > nameMaxWidth) {
        displayRowName = displayRowName.slice(0, -1);
      }
      displayRowName = displayRowName.trimEnd() + '…';
    }
    drawEffectNameLine(displayRowName, nameX, nameY, rowNameFontSize, rowEffect, nameMaxWidth);
    // [FIXED] Keep the lower stats aligned in fixed columns below the complete name.
    ctx.fillStyle = '#ffd85e'; ctx.font = 'bold 20px Sans';
    ctx.fillText(coins.toLocaleString('en-US') + ' coins', 184, y + 70);
    ctx.fillStyle = '#a8eefa'; ctx.font = 'bold 15px Sans';
    const ownedHouseKey = String(item.user.house || 'none').toLowerCase();
    if (getHouseTier(ownedHouseKey) > 0) drawHouseArt(ctx, ownedHouseKey, 364, y + 49, 26, 22);
    const houseText = getHouseTier(ownedHouseKey) > 0
      ? getHouse(item) + ' • ' + getHouseWorth(item).toLocaleString('en-US') + 'c'
      : 'No House';
    ctx.fillText(houseText, 395, y + 70);
    ctx.textAlign = 'right'; ctx.fillStyle = '#ffe08a'; ctx.font = 'bold 12px Sans';
    ctx.fillText('NET WORTH', 744, y + 49);
    ctx.fillStyle = '#ffe08a'; ctx.font = 'bold 18px Sans';
    ctx.fillText(item.net.toLocaleString('en-US') + 'c', 744, y + 76);
    // [FIXED V37] Removed the extra effect/RANKED PLAYER line so it cannot overlap net worth.
  }

  // [UPGRADED V28] Bright season footer and climb-to-the-top callout.
  const footerY = 1242; // [UPGRADED V28] Footer follows the last Top 10 card; removes unused vertical space.
  ctx.fillStyle = '#090d28'; ctx.fillRect(38, footerY, 724, 62);
  ctx.strokeStyle = divider; ctx.lineWidth = 2; ctx.strokeRect(38, footerY, 724, 62);
  ctx.textAlign = 'center'; ctx.shadowColor = '#34efff'; ctx.shadowBlur = 12;
  ctx.fillStyle = '#5af4ff'; ctx.font = 'bold 16px Sans'; ctx.fillText('UPDATED NOW', 150, footerY + 26);
  ctx.shadowColor = '#ffd34f'; ctx.fillStyle = '#ffe16a'; ctx.fillText('SEASON RANKINGS', 400, footerY + 26);
  ctx.shadowColor = '#ff45e8'; ctx.fillStyle = '#ff8df1'; ctx.fillText('PLAY TO CLIMB ↑', 630, footerY + 26);
  ctx.shadowBlur = 0; ctx.fillStyle = '#9cb6d2'; ctx.font = '11px Sans'; ctx.fillText('JOJOWORLD • YOUR NEXT LEVEL STARTS HERE', 400, footerY + 47);
  const file = path.join(cacheDir, 'lb.jpg');
  await fsExtra.writeFile(file, canvas.toBuffer('image/jpeg', { quality: 0.9 }));
  leaderboardImageCache = { file, createdAt: Date.now() }; // [ADDED] Cache completed leaderboard render for rapid repeat requests.
  return file;
}
// [ADDED] Messenger attachment upload for generated canvas images.
async function sendImage(id, imagePath, body, quickReplies) {
  if (!PAGE_TOKEN || !id) return false;
  try {
    const FormData = require('form-data'); const form = new FormData();
    form.append('recipient', JSON.stringify({ id }));
    const imageMessage = { attachment: { type: 'image', payload: { is_reusable: false } } };
    // [FIXED] When there is no caption but quick replies are requested, attach them directly to the image message.
    if (!body && quickReplies) imageMessage.quick_replies = quickReplies;
    form.append('message', JSON.stringify(imageMessage));
    const imageMime = /\.jpe?g$/i.test(imagePath) ? 'image/jpeg' : 'image/png';
    form.append('filedata', fs.createReadStream(imagePath), { contentType: imageMime, filename: path.basename(imagePath) });
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`, form, { headers: form.getHeaders(), timeout: 15000 });
    if (body) await send(id, body, quickReplies);
    return true;
  } catch (e) { console.error('Canvas image send failed:', e.response?.data?.error?.message || e.message); return false; }
}

// ASYNC SAFE SEND FUNCTION WITH TYPING INDICATOR
async function send(id, text, qr = null) {
  if (!PAGE_TOKEN || !id) {
    console.warn("Messenger send skipped: PAGE_TOKEN or recipient PSID is missing.");
    return false;
  }
  try {
    // Fast path: skip the extra typing_on API request and artificial 350ms delay.
    // Send the actual reply immediately to reduce perceived Messenger latency.
    const body = { recipient: { id }, message: { text } };
    // [ADDED V35] Never leave a text-only page without navigation: add Main Menu when no quick replies exist.
    const quickReplies = Array.isArray(qr) ? [...qr] : [];
    if (quickReplies.length === 0) {
      quickReplies.push({ content_type: "text", title: "↩️ Main Menu", payload: "MENU" });
    }
    body.message.quick_replies = quickReplies;

    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`, body, { timeout: 15000 });
    return true;
  } catch (e) {
    console.error(`Messenger send failed (PSID: ${id}):`, e.response?.data?.error?.message || e.message);
    return false;
  }
}


// [FIXED] Keep users inside the Shop after every purchase result; offer repeat shopping and Menu navigation.
async function sendShopResult(id, message) {
  return send(id, message, [
    { content_type: "text", title: "🛍️ Continue Shopping", payload: "SHOP" },
    { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
  ]);
}

// SANITIZE INPUT FUNCTION
function sanitizeInput(text) {
  if (!text) return "";
  let clean = text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '');
  clean = clean.toLowerCase().trim();

  if (["menu", "main menu", "start"].some(x => clean === x)) return "MENU";
  if (["1", "isa", "one", "uno", "profile"].some(x => clean === x)) return "PROFILE";
  if (["2", "dalawa", "two", "dos", "find match"].some(x => clean === x)) return "FIND MATCH";
  if (["3", "tatlo", "three", "tres", "top up"].some(x => clean === x)) return "TOP UP";
  if (["4", "apat", "four", "cuatro", "daily"].some(x => clean === x)) return "DAILY";
  if (["5", "lima", "five", "cinco", "spin"].some(x => clean === x)) return "SPIN";
  if (["6", "anim", "six", "shop"].some(x => clean === x)) return "SHOP";
  if (["7", "pito", "seven", "leaderboard"].some(x => clean === x)) return "LEADERBOARD";
  if (["8", "walo", "eight", "referral", "invite"].some(x => clean === x)) return "INVITE";

  return clean;
}

async function createPaymongoLink(amount, coins, psid) {
  if (!PAYMONGO_SECRET || !PAYMONGO_WEBHOOK_SECRET || !MONGODB_URI || mongoose.connection.readyState !== 1) return null;
  try {
    const res = await axios.post('https://api.paymongo.com/v1/links', {
      data: { attributes: { amount: amount * 100, description: `${coins} Coins JojoWorld V26`, remarks: psid.toString() } }
    }, {
      headers: { Authorization: `Basic ${Buffer.from(PAYMONGO_SECRET + ':').toString('base64')}`, 'Content-Type': 'application/json' }
    });
    const linkData = res.data && res.data.data;
    const checkoutUrl = linkData && linkData.attributes && linkData.attributes.checkout_url;
    const linkId = linkData && linkData.id;
    if (!checkoutUrl || !linkId) {
      console.error('[TOP-UP] PayMongo did not return a link ID and checkout URL.');
      return null;
    }
    // [FIXED] Save the order before showing the payment URL so the webhook can identify the recipient.
    await TopupOrderModel.create({ linkId, psid: String(psid), amount: Number(amount), coins: Number(coins), status: 'pending' });
    return checkoutUrl;
  } catch (e) {
    console.error('[TOP-UP] Could not create/save PayMongo top-up link:', e.message);
    return null;
  }
}

// ================= UI MENUS =================
function sendMenu(id) {
  send(id, `✨ JOJOWORLD V26 ULTIMATE ✨
━━━━━━━━━━━━━━━━━━━━
🔥 LIMITED TIME: +20% Bonus Coins
💘 Find match & connect worldwide
🎁 Daily bonuses & Scatter rewards

[1] 👤 My Profile
[2] 💘 Find Match (10c)
[3] 💰 Top-Up Center
[4] 🎁 Daily Bonus
[5] 🎡 Scatter Wheel & Jackpot
[6] 🛍️ Profile Shop & Themes
[7] 🏆 Leaderboards
[8] 🔗 Referral Invite

💬 *Tip: Select options below or type 1-8!*`, [
    { content_type: "text", title: "👤 Profile (1)", payload: "PROFILE" },
    { content_type: "text", title: "💘 Match (2)", payload: "FIND MATCH" },
    { content_type: "text", title: "💰 Top Up (3)", payload: "TOP UP" },
    { content_type: "text", title: "🎁 Daily (4)", payload: "DAILY" },
    { content_type: "text", title: "🎡 Spin (5)", payload: "SPIN" },
    { content_type: "text", title: "🛍️ Shop (6)", payload: "SHOP" },
    { content_type: "text", title: "🏆 Rank (7)", payload: "LEADERBOARD" },
    { content_type: "text", title: "🔗 Referral (8)", payload: "INVITE" }
  ]);
}

function sendTopupMenu(id) {
  send(id, `💰 JOJOWORLD TOP-UP CENTER
━━━━━━━━━━━━━━━━━━━━
🔒 Secure PayMongo Gateway (GCash/Maya/Card)
💎 Instant auto-credit after payment

⭐ PACKAGES & RATES:
📦 P20 = 120 Coins
📦 P50 = 300 Coins
🔥 P80 = 500 Coins (BEST SELLER!)
📦 P100 = 700 Coins
📦 P200 = 1600 Coins
🚀 P500 = 4500 Coins (VIP CHOICE!)

Select a package below:`, [
    { content_type: "text", title: "💰 P20 = 120c", payload: "TOP UP 20" },
    { content_type: "text", title: "💰 P50 = 300c", payload: "TOP UP 50" },
    { content_type: "text", title: "⭐ P80 = 500c", payload: "TOP UP 80" },
    { content_type: "text", title: "💰 P100 = 700c", payload: "TOP UP 100" },
    { content_type: "text", title: "💰 P200 = 1600c", payload: "TOP UP 200" },
    { content_type: "text", title: "💰 P500 = 4500c", payload: "TOP UP 500" },
    { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
  ]);
}

// ================= WEBHOOKS =================
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
});

// SECURED, IDEMPOTENT PAYMONGO WEBHOOK
app.post('/paymongo-webhook', async (req, res) => {
  if (!PAYMONGO_WEBHOOK_SECRET) {
    console.error('PayMongo webhook rejected: PAYMONGO_WEBHOOK_SECRET is not configured.');
    return res.sendStatus(503);
  }
  if (!verifyPayMongoSignature(req.rawBody, req.headers['paymongo-signature'], PAYMONGO_WEBHOOK_SECRET)) {
    console.warn('PayMongo webhook rejected: missing, stale, or invalid signature.');
    return res.sendStatus(401);
  }
  try {
    const ev = req.body?.data;
    if (!ev || !ev.id) return res.sendStatus(400);
    const eventAttributes = ev.attributes || {};
    const eventType = eventAttributes.type;
    // [FIXED] This bot creates Payment Links, so fulfill only link.payment.paid.
    // payment.paid contains a payment ID, not the saved Payment Link ID.
    if (eventType !== 'link.payment.paid') return res.sendStatus(200);
    const linkResource = eventAttributes.data || {};
    const paymentAttributes = linkResource.attributes || {};
    if (paymentAttributes.status !== 'paid') return res.sendStatus(200);
    if (String(paymentAttributes.currency || '').toUpperCase() !== 'PHP') {
      console.warn('PayMongo webhook ignored: missing or unsupported payment currency.');
      return res.sendStatus(400);
    }
    const amountInPesos = Number(paymentAttributes.amount) / 100;
    if (!Number.isFinite(amountInPesos) || !Number.isInteger(amountInPesos) || amountInPesos <= 0) {
      console.warn('PayMongo webhook ignored: invalid payment amount.');
      return res.sendStatus(400);
    }
    // [FIXED] Match by the Payment Link ID saved when the checkout URL was generated, not webhook remarks.
    const linkId = String(linkResource.id || '').trim();
    if (!linkId) return res.sendStatus(400);
    if (!MONGODB_URI || mongoose.connection.readyState !== 1) {
      console.error('PayMongo webhook deferred: MongoDB is not connected; payment was not credited.');
      return res.sendStatus(503);
    }
    let newBalance, committedUserData, creditedPsid, creditedCoins;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await PaymentEventModel.create([{ eventId: ev.id, status: 'processing' }], { session });
        const order = await TopupOrderModel.findOne({ linkId }).session(session);
        if (!order) { const err = new Error('TOPUP_ORDER_NOT_FOUND'); err.code = 'TOPUP_ORDER_NOT_FOUND'; throw err; }
        if (order.status === 'processed') { const err = new Error('TOPUP_ORDER_ALREADY_PROCESSED'); err.code = 'TOPUP_ORDER_ALREADY_PROCESSED'; throw err; }
        if (Number(order.amount) !== amountInPesos || !TOPUP_RATES[amountInPesos] || Number(order.coins) !== TOPUP_RATES[amountInPesos]) {
          const err = new Error('TOPUP_ORDER_AMOUNT_MISMATCH'); err.code = 'TOPUP_ORDER_AMOUNT_MISMATCH'; throw err;
        }
        const psid = String(order.psid || '').trim(), coins = Number(order.coins);
        if (!/^\d{5,32}$/.test(psid) || !Number.isSafeInteger(coins) || coins <= 0) {
          const err = new Error('TOPUP_ORDER_INVALID'); err.code = 'TOPUP_ORDER_INVALID'; throw err;
        }
        const userDoc = await UserModel.findOne({ psid }).session(session);
        if (!userDoc || !userDoc.data) { const err = new Error('PAYMENT_USER_NOT_FOUND'); err.code = 'PAYMENT_USER_NOT_FOUND'; throw err; }
        const updatedUser = { ...userDoc.data };
        const currentCoins = Number(updatedUser.coins);
        updatedUser.coins = Number.isFinite(currentCoins) && currentCoins >= 0 ? currentCoins + coins : coins;
        newBalance = updatedUser.coins; creditedPsid = psid; creditedCoins = coins;
        await UserModel.updateOne({ psid }, { $set: { data: updatedUser } }, { session, runValidators: true });
        const orderUpdate = await TopupOrderModel.updateOne({ linkId, status: 'pending' }, { $set: { status: 'processed', eventId: ev.id } }, { session });
        if (orderUpdate.matchedCount !== 1) { const err = new Error('TOPUP_ORDER_ALREADY_PROCESSED'); err.code = 'TOPUP_ORDER_ALREADY_PROCESSED'; throw err; }
        await PaymentEventModel.updateOne({ eventId: ev.id, status: 'processing' }, { $set: { status: 'processed', psid } }, { session });
        committedUserData = updatedUser;
      });
      if (committedUserData && creditedPsid) db.users[creditedPsid] = committedUserData;
    } catch (paymentError) {
      if (paymentError.code === 11000 || paymentError.code === 'TOPUP_ORDER_ALREADY_PROCESSED') return res.sendStatus(200);
      if (paymentError.code === 'PAYMENT_USER_NOT_FOUND' || paymentError.code === 'TOPUP_ORDER_NOT_FOUND') {
        console.error('[TOP-UP] No matching saved order/user for paid link:', linkId); return res.sendStatus(404);
      }
      if (paymentError.code === 'TOPUP_ORDER_AMOUNT_MISMATCH' || paymentError.code === 'TOPUP_ORDER_INVALID') {
        console.error('[TOP-UP] Paid event did not match the saved top-up order:', linkId); return res.sendStatus(400);
      }
      throw paymentError;
    } finally { await session.endSession(); }
    try {
      await send(creditedPsid, `✅ PAYMENT SUCCESSFUL!\n💰 +${creditedCoins} Coins added to your account!\n💎 New Balance: ${newBalance} coins\n\nEnjoy JojoWorld V26! 🚀`);
    } catch (notifyError) { console.error('Payment credited but Messenger notification failed:', notifyError.message); }
    return res.sendStatus(200);
  } catch (e) {
    console.error('PayMongo webhook processing error:', e.message);
    return res.sendStatus(500);
  }
});
app.post('/webhook', async (req, res) => {
  if (!META_APP_SECRET) {
    console.error('Messenger webhook rejected: META_APP_SECRET is not configured.');
    return res.sendStatus(503);
  }
  if (!verifyMessengerSignature(req.rawBody, req.headers['x-hub-signature-256'], META_APP_SECRET)) {
    console.warn('Messenger webhook rejected: missing or invalid Meta signature.');
    return res.sendStatus(401);
  }
  if (MONGODB_URI && mongoose.connection.readyState !== 1) {
    console.warn('Messenger webhook deferred: MongoDB is configured but not connected.');
    return res.sendStatus(503);
  }

  // Track the message currently being processed so a thrown error can release its deduplication reservation.
  let activeWebhookMessageId = null;
  try {
    const body = req.body;
    if (!body || body.object !== 'page' || !Array.isArray(body.entry)) return res.sendStatus(200);

    for (const entry of body.entry) {
      for (const ev of (Array.isArray(entry.messaging) ? entry.messaging : [])) {
        activeWebhookMessageId = null;
        if (!ev || !ev.sender || !ev.sender.id || (!ev.message && !ev.postback && !ev.referral)) continue;
        const messageId = ev.message && ev.message.mid ? String(ev.message.mid) : null;
        activeWebhookMessageId = messageId;
        if (messageId) {
          if (MONGODB_URI && mongoose.connection.readyState === 1) {
            try {
              await ProcessedMessengerMessageModel.create({ messageId });
            } catch (error) {
              if (error.code === 11000) continue;
              throw error;
            }
          } else {
            if (processedMessengerMessages.has(messageId)) continue;
            processedMessengerMessages.add(messageId);
            if (processedMessengerMessages.size > 10000) {
              processedMessengerMessages.delete(processedMessengerMessages.values().next().value);
            }
          }
        }
        const psid = String(ev.sender.id);

        // Keep commands from the same user ordered, but do not make unrelated users wait
        // for slow image generation or database work from another user's request.
        const previousUserQueue = messengerUserQueues.get(psid) || Promise.resolve();
        let releaseUserQueue;
        const currentUserQueue = new Promise(resolve => { releaseUserQueue = resolve; });
        messengerUserQueues.set(psid, currentUserQueue);
        await previousUserQueue;
        try {
        // CHECK REFERRAL PARAMETER ON START
        let referralParam = null;
        if (ev.referral && ev.referral.ref) {
          referralParam = ev.referral.ref;
        } else if (ev.postback && ev.postback.referral && ev.postback.referral.ref) {
          referralParam = ev.postback.referral.ref;
        } else if (ev.message && ev.message.text && ev.message.text.includes("REF_")) {
          let parts = ev.message.text.split("REF_");
          if (parts[1]) referralParam = "REF_" + parts[1].trim();
        }

        // LOAD FRESH DATA FROM MONGODB
        let user = await loadUserFromDB(psid);

        if (!user) {
          db.users[psid] = {
            // [UPGRADED V28] New accounts start with 100 coins and V28 defaults.
            id: psid,
            coins: 100,
            house: "none",
            nameEffect: "none",
            vip: false,
            goldFrame: false,
            lastScatter: 0,
            lastTax: Date.now(),
            scatterWins: 0,
            location: "Nueva Ecija",
            rating: 5.0,
            bio: "Hello JojoWorld V28!",
            age: 25,
            gender: "Not set",
            name: "Jojo Member",
            created: Date.now(),
            joinDate: new Date().toISOString(),
            giftsShowcase: "None yet",
            lastDaily: 0,
            lastSpin: 0,
            xp: 0,
            lastXpAt: 0,
            refCount: 0,
            views: 0,
            theme: "Default",
            frame: "None",
            badge: "Newbie",
            giftsCount: 0,
            giftsReceived: {},
            zodiac: "Not set 🌟",
            relationshipGoal: "Serious Relationship",
            profileEdits: 0,
            state: "IDLE",
            activeMatchPsid: null
          };
          user = db.users[psid];

          await saveUserToDB(psid);
        }

        // Save the referral source now, but do not reward anyone until registration succeeds.
        if (referralParam && referralParam.startsWith("REF_") && user.registered !== true && !user.referralRewarded) {
          const referrerPsid = referralParam.slice(4).trim();
          if (referrerPsid && referrerPsid !== psid && !user.pendingReferrerPsid) {
            const referrer = await loadUserFromDB(referrerPsid);
            if (referrer) {
              user.pendingReferrerPsid = referrerPsid;
              if (!await saveUserToDB(psid, { saveJackpot: false })) {
                delete user.pendingReferrerPsid;
                send(psid, "⚠️ Hindi na-save ang referral link. Pakisubukang muli.");
                continue;
              }
            }
          }
        }

        const numericCoins = Number(user.coins);
        user.coins = Number.isFinite(numericCoins) && numericCoins >= 0 ? numericCoins : 0;
        user.lastActive = Date.now();
        // Persist presence without rewriting the global jackpot on every message.
        // [ADDED] [UPGRADED V28] Daily house tax is checked on each incoming message.
        const houseTaxNotice = checkHouseTax(user);
        const activitySaved = await saveUserToDB(psid, { saveJackpot: false });
        if (houseTaxNotice) send(psid, houseTaxNotice);
        if (!activitySaved) {
          console.error("Could not persist activity timestamp; command processing stopped for user:", psid);
          // [FIXED] Release the message-id reservation when no command was processed, so Meta's retry can recover it.
          if (messageId) {
            if (MONGODB_URI && mongoose.connection.readyState === 1) {
              try {
                await ProcessedMessengerMessageModel.deleteOne({ messageId });
              } catch (releaseError) {
                console.error("[FIXED] Could not release failed Messenger message reservation:", releaseError.message);
              }
            } else {
              processedMessengerMessages.delete(messageId);
            }
          }
          send(psid, "⚠️ Hindi available ang database ngayon. Walang command na pinroseso; subukan ulit mamaya.");
          continue;
        }

        let rawText = "";
        if (ev.message && ev.message.quick_reply) rawText = ev.message.quick_reply.payload;
        else if (ev.message && ev.message.text) rawText = ev.message.text;
        else if (ev.postback && ev.postback.payload) rawText = ev.postback.payload;

        // [ADDED] [UPGRADED V28] Block external links in user-to-user active chat to reduce coin-sale scams.
        // Only checks ordinary text messages while chatting; button payloads and other bot features remain unaffected.
        const isActiveChatLinkMessage = user.state === "CHATTING" &&
          ev.message && typeof ev.message.text === "string" &&
          !ev.message.quick_reply &&
          /(?:https?:\/\/|www\.)\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?/i.test(ev.message.text);
        if (isActiveChatLinkMessage) {
          send(psid, "⛔ Bawal mag-send ng link habang nasa active chat para maiwasan ang scam at bentahan ng coins. Mag-chat gamit ang text na walang link.");
          continue;
        }

        // Award a small amount of XP for genuine activity, with a per-user 60-second cooldown.
        // The cooldown is persisted in the same user document to discourage message-spam farming.
        if (user.registered === true && ev.message && typeof ev.message.text === "string" && !ev.message.quick_reply && ev.message.text.trim()) {
          const xpNow = Date.now();
          const lastXpAt = Math.max(0, Number(user.lastXpAt) || 0);
          if (xpNow - lastXpAt >= 60000) {
            const previousXp = user.xp;
            const previousLastXpAt = user.lastXpAt;
            const beforeLevel = getProfileLevelStats(user.xp).level;
            user.xp = getProfileLevelStats(user.xp).totalXp + 5;
            user.lastXpAt = xpNow;
            const afterLevel = getProfileLevelStats(user.xp).level;
            if (!await saveUserToDB(psid, { saveJackpot: false })) {
              if (previousXp === undefined) delete user.xp;
              else user.xp = previousXp;
              if (previousLastXpAt === undefined) delete user.lastXpAt;
              else user.lastXpAt = previousLastXpAt;
              console.warn("[PROFILE XP] Could not persist XP award; user data was restored.");
            } else if (afterLevel > beforeLevel) {
              send(psid, `🎉 LEVEL UP! You reached **Level ${afterLevel}**!\n✨ Keep chatting to earn more XP and unlock higher levels.`);
            }
          }
        }

        let cleanText = sanitizeInput(rawText);
        let upperRaw = rawText.toUpperCase();

        // Registration is mandatory before any JojoWorld feature can be used.
        // Keep registration commands available so a new user can complete signup.
        if (user.registered !== true &&
            !upperRaw.startsWith("REGISTER ") &&
            upperRaw !== "REGISTER" &&
            upperRaw !== "REGISTER_HELP") {
          send(psid, "╔══════════════════════╗\n     ✨ 𝐖𝐄𝐋𝐂𝐎𝐌𝐄 𝐓𝐎 𝐉𝐎𝐉𝐎𝐖𝐎𝐑𝐋𝐃! ✨\n╚══════════════════════╝\n\n🌟 𝐘𝐨𝐮𝐫 𝐉𝐨𝐮𝐫𝐧𝐞𝐲 𝐁𝐞𝐠𝐢𝐧𝐬 𝐇𝐞𝐫𝐞!\n\n🔐 Before exploring JojoWorld, you must complete your registration first.\n\n📝 𝐇𝐎𝐖 𝐓𝐎 𝐑𝐄𝐆𝐈𝐒𝐓𝐄𝐑\n➤ Type: REGISTER Your Name\n\n💡 𝐄𝐱𝐚𝐦𝐩𝐥𝐞:\nREGISTER John Doe\n\n╭━━━━━━━━━━━━━━━━━━━━╮\n✅ Once your registration is successful, you will unlock access to:\n\n👤 𝐕𝐢𝐬𝐮𝐚𝐥 𝐏𝐫𝐨𝐟𝐢𝐥𝐞\n🛍️ 𝐒𝐡𝐨𝐩 & 𝐄𝐱𝐜𝐥𝐮𝐬𝐢𝐯𝐞 𝐈𝐭𝐞𝐦𝐬\n💕 𝐌𝐚𝐭𝐜𝐡𝐢𝐧𝐠 𝐒𝐲𝐬𝐭𝐞𝐦\n🪙 𝐂𝐨𝐢𝐧𝐬 & 𝐑𝐞𝐰𝐚𝐫𝐝𝐬\n🎮 𝐀𝐧𝐝 𝐌𝐚𝐧𝐲 𝐌𝐨𝐫𝐞 𝐅𝐞𝐚𝐭𝐮𝐫𝐞𝐬!\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n🚀 𝐑𝐞𝐠𝐢𝐬𝐭𝐞𝐫 𝐍𝐨𝐰 𝐚𝐧𝐝 𝐄𝐧𝐭𝐞𝐫 𝐭𝐡𝐞 𝐖𝐨𝐫𝐥𝐝 𝐨𝐟 𝐉𝐨𝐣𝐨𝐖𝐨𝐫𝐥𝐝! 💎");
          continue;
        }

        if (user.registered !== true && (upperRaw === "REGISTER" || upperRaw === "REGISTER_HELP")) {
          send(psid, "✨ 𝐉𝐎𝐉𝐎𝐖𝐎𝐑𝐋𝐃 𝐑𝐄𝐆𝐈𝐒𝐓𝐑𝐀𝐓𝐈𝐎𝐍 ✨\n\n📝 Type: REGISTER Your Name\n💡 Example: REGISTER John Doe\n\n🚀 Complete your registration to unlock all JojoWorld features!");
          continue;
        }

        // [ADDED V28] Allow users to upload a Messenger photo by sending an image directly in chat.
        // [FIXED] Profile photos are changed ONLY after the user explicitly taps "Change Photo".
        // A Messenger Like/sticker or an ordinary image can never silently overwrite the saved avatar.
        const isStickerOrLike = Boolean(ev.message && (ev.message.sticker_id || ev.message.is_animated));
        const incomingImage = ev.message && user.awaitingProfilePhoto === true && !isStickerOrLike &&
          !ev.message.quick_reply && !(ev.message.text && String(ev.message.text).trim()) &&
          Array.isArray(ev.message.attachments)
          ? ev.message.attachments.find(item => item && item.type === 'image' && item.payload && item.payload.url && !item.payload.sticker_id)
          : null;
        if (incomingImage) {
          const previousProfilePhotoData = user.profilePhotoData;
          const previousProfilePhotoUrl = user.profilePhotoUrl;
          const wasAwaitingProfilePhoto = user.awaitingProfilePhoto;
          try {
            // [UPGRADED V28] Download the Messenger attachment and store a resized JPEG in MongoDB for persistence.
            const photoResponse = await axios.get(incomingImage.payload.url, {
              responseType: 'arraybuffer', timeout: 12000, maxContentLength: 8 * 1024 * 1024,
              maxBodyLength: 8 * 1024 * 1024
            });
            const sourcePhoto = await loadImage(Buffer.from(photoResponse.data));
            const photoCanvas = createCanvas(512, 512);
            const photoCtx = photoCanvas.getContext('2d');
            photoCtx.fillStyle = '#080d1c'; photoCtx.fillRect(0, 0, 512, 512);
            const scale = Math.max(512 / sourcePhoto.width, 512 / sourcePhoto.height);
            const pw = sourcePhoto.width * scale, ph = sourcePhoto.height * scale;
            photoCtx.drawImage(sourcePhoto, (512 - pw) / 2, (512 - ph) / 2, pw, ph);
            const compressedPhoto = photoCanvas.toBuffer('image/jpeg', { quality: 0.78 });
            if (compressedPhoto.length > 2 * 1024 * 1024) throw new Error('Compressed profile photo exceeds 2 MB');
            user.profilePhotoData = compressedPhoto.toString('base64');
            delete user.profilePhotoUrl;
            // [FIXED] Clear upload mode before the single persistence attempt, so a failed second save cannot leave it armed.
            delete user.awaitingProfilePhoto;
            if (!await saveUserToDB(psid, { saveJackpot: false })) {
              if (previousProfilePhotoData) user.profilePhotoData = previousProfilePhotoData;
              else delete user.profilePhotoData;
              if (previousProfilePhotoUrl) user.profilePhotoUrl = previousProfilePhotoUrl;
              if (wasAwaitingProfilePhoto) user.awaitingProfilePhoto = true;
              send(psid, '⚠️ Hindi na-save ang profile photo. Subukan ulit mamaya.');
            } else {
              send(psid, '📸 Profile photo saved! Check your Visual Profile to see it with your equipped frame.', [
                { content_type: 'text', title: '👤 View Profile', payload: 'PROFILE' },
                { content_type: 'text', title: '🛍️ Visit Shop', payload: 'SHOP' }
              ]);
            }
          } catch (photoUploadError) {
            // [FIXED] Roll back in-memory photo changes if download, conversion, or persistence throws.
            if (previousProfilePhotoData) user.profilePhotoData = previousProfilePhotoData;
            else delete user.profilePhotoData;
            if (previousProfilePhotoUrl) user.profilePhotoUrl = previousProfilePhotoUrl;
            else delete user.profilePhotoUrl;
            if (wasAwaitingProfilePhoto) user.awaitingProfilePhoto = true;
            console.error('[PROFILE PHOTO] Upload failed:', photoUploadError.message);
            send(psid, '⚠️ Hindi ma-save ang picture. Subukan ang ibang larawan na mas maliit o ibang format.');
          }
          continue;
        }
        // [UPGRADED V28] If an image arrives outside the explicit Change Photo flow, never change the saved avatar.
        // [FIXED] Do not claim the user is on Profile/Leaderboard; provide only a neutral Exit action.
        if (ev.message && Array.isArray(ev.message.attachments) &&
            ev.message.attachments.some(item => item && item.type === 'image') &&
            user.awaitingProfilePhoto !== true) {
          const isImageReaction = Boolean(ev.message.sticker_id || ev.message.is_animated ||
            ev.message.attachments.some(item => item && item.type === 'image' && item.payload && item.payload.sticker_id));
          if (!isImageReaction) {
            send(psid, '↩️', [
              { content_type: 'text', title: '🚪 Exit', payload: 'MENU' }
            ]);
          }
          continue;
        }
        // [ADDED] [UPGRADED V28] V28 text commands. Existing command routing remains below.

        // [FIXED] Reuse the daily house tax check performed earlier in this message handler.

        // Registration is persisted before any referral reward is issued.
        if (upperRaw.startsWith('REGISTER ')) {
          const cleanName = rawText.slice(9).replace(/[^\w\s]/gi, '').trim();
          if (cleanName.length < 3) { send(psid, '❌ Bawal emoji/symbols boss! Min 3 letters!'); continue; }
          if (user.registered === true) { send(psid, "❌ Registered ka na boss! Type 'profile'"); continue; }

          const userSnapshot = JSON.parse(JSON.stringify(user));
          const referrerPsid = String(user.pendingReferrerPsid || '').trim();
          const referrer = referrerPsid && referrerPsid !== psid ? await loadUserFromDB(referrerPsid) : null;
          const referrerSnapshot = referrer ? JSON.parse(JSON.stringify(referrer)) : null;

          user.name = cleanName;
          user.registered = true;
          user.id = psid;

          if (referrer && !user.referralRewarded) {
            const previousCoins = Number(referrer.coins);
            referrer.coins = (Number.isFinite(previousCoins) && previousCoins >= 0 ? previousCoins : 0) + 100;
            referrer.refCount = (Number(referrer.refCount) || 0) + 1;
            user.referralRewarded = true;
            delete user.pendingReferrerPsid;

            if (!await saveUserPair(psid, referrerPsid)) {
              db.users[psid] = userSnapshot;
              db.users[referrerPsid] = referrerSnapshot;
              user = db.users[psid];
              send(psid, '⚠️ Hindi na-save ang registration/referral. Walang referral bonus na naibigay. Subukan ulit.');
              continue;
            }
            send(referrerPsid, `🎉 REFERRAL SUCCESS!
A new user successfully registered using your link! 🎁
💰 +100 Coins credited to your wallet!`);
          } else {
            delete user.pendingReferrerPsid;
            if (!await saveUserToDB(psid)) {
              db.users[psid] = userSnapshot;
              user = db.users[psid];
              send(psid, '⚠️ Hindi na-save ang registration. Try ulit.');
              continue;
            }
          }

          send(psid, '✅ Registered ka na, boss! Type profile para makita ang profile mo.');
          continue;
        }
        // [ADDED] V28 balance includes liquid coins, house value, and net worth.
        if (['BALANCE','WALLET'].includes(upperRaw.trim())) { send(psid, `💰 ${getDisplayName(user)}\\nCoins: ${user.coins}c\\nHouse value: ${getHouseValue(user.house)}c\\nNET WORTH: ${getNetWorth(user)}c\\nHouse tier: ${getHouseTier(user.house)}`); continue; }
        // [ADDED] V28 unequip and one-at-a-time name effects.
        if (upperRaw.trim() === 'UNEQUIP') { const old = user.nameEffect; user.nameEffect = 'none'; if (!await saveUserToDB(psid)) { user.nameEffect = old; send(psid,'⚠️ Hindi na-save ang pagbabago.'); } else send(psid,'✅ Name effect removed.'); continue; }
        // [ADDED] [UPGRADED V28] Scatter game, independent of legacy SPIN command.
        if (upperRaw.trim().startsWith('SCATTER')) {
          const parts = upperRaw.trim().split(/\s+/); const bet = Number(parts[1]);
          if (!Number.isInteger(bet) || bet < 50 || bet > 1000) { send(psid,'🎰 Use: scatter <50-1000> coins.'); continue; }
          const diff = Date.now() - (Number(user.lastScatter) || 0);
          if (diff < 120000) { send(psid, `⏳ Cooldown pa boss! ${Math.ceil((120000-diff)/1000)} secs pa!`); continue; }
          if ((Number(user.coins)||0) < bet) { send(psid, `❌ Insufficient coins! You need ${bet} coins, but you only have ${user.coins} coins.`); continue; }
          const snapshot = { coins:user.coins, lastScatter:user.lastScatter, scatterWins:user.scatterWins };
          const isWin = Math.random() < 0.30; user.coins = isWin ? user.coins - bet + Math.floor(bet*1.8) : user.coins - bet;
          user.lastScatter = Date.now(); if (isWin) user.scatterWins = (user.scatterWins||0)+1;
          if (!await saveUserToDB(psid)) { Object.assign(user,snapshot); send(psid,'⚠️ Hindi na-save ang scatter.'); continue; }
          send(psid, isWin ? `🎉 SCATTER WIN! +${Math.floor(bet*0.8)} net coins. Balance: ${user.coins}c` : `🎰 Scatter loss: -${bet}c. Balance: ${user.coins}c`); continue;
        }
        // [ADDED] V28 house purchase with prerequisite and duplicate checks before charging.
        if (upperRaw.trim().startsWith('BUY ')) {
          const parts = upperRaw.trim().split(/\s+/); const house = (parts[1]||'').toLowerCase(); const cfg = HOUSE_CONFIG[house];
          if (!cfg || house === 'none') { sendShopResult(psid,'🏠 Use: buy kubo / bahay / mansion / building'); continue; }
          const required = HOUSE_REQUIREMENTS[house];
          if (String(user.house||'none').toLowerCase() === house) { sendShopResult(psid,'❌ Meron ka na nyan boss!'); continue; }
          if (getHouseTier(user.house) + 1 !== cfg.tier || String(user.house||'none').toLowerCase() !== required) { sendShopResult(psid,`❌ Requirement: ${required} muna bago ${house}.`); continue; }
          if ((Number(user.coins)||0) < cfg.price) { sendShopResult(psid,`❌ Insufficient coins! You need ${cfg.price} coins, but you only have ${user.coins} coins.`); continue; }
          const old = {coins:user.coins,house:user.house}; user.coins -= cfg.price; user.house=house;
          if (!await saveUserToDB(psid)) { Object.assign(user,old); sendShopResult(psid,'⚠️ Hindi na-save ang house purchase. Walang coins na ikakaltas.'); continue; }
          sendShopResult(psid,`🏠 Congratulations! Purchased ${house} for ${cfg.price}c. House value: ${cfg.value}c.`); continue;
        }
        // [UPGRADED V28] Tapping an item preview opens its image immediately; purchase is available on that preview.
        if (upperRaw.startsWith('PREVIEW_')) {
          const key = upperRaw.slice('PREVIEW_'.length).toLowerCase();
          const product = key.startsWith('house_') ? key.slice(6) : key;
          const priceLabels = {vip:'1,000c',frame:'500c',rainbow:'5,000c',sparkle:'10,000c',heart:'2,500c',fire:'2,500c',ice:'2,500c',neon:'3,000c',blossom:'2,000c',dark:'2,500c',red:'1,000c',blue:'1,000c',green:'1,000c',yellow:'1,000c',gold:'4,000c',demon:'4,000c',kubo:'1,500c',bahay:'5,000c',mansion:'15,000c',building:'40,000c'};
          if (!priceLabels[product]) { sendShopResult(psid, '❌ Hindi mahanap ang item. Pili ulit sa Shop.'); continue; }
          const image = await generateShopProductPreview(product, user);
          const purchasePayload = product === 'vip' ? 'BUY_VIP'
            : product === 'frame' ? 'BUY_FRAME'
            : ['rainbow','sparkle','heart','fire','ice','neon','blossom','dark','red','blue','green','yellow','gold','demon'].includes(product) ? 'EFFECT ' + product
            : ['kubo','bahay','mansion','building'].includes(product) ? 'BUY ' + product.toUpperCase() : '';
          if (!purchasePayload) { sendShopResult(psid, '❌ Hindi mahanap ang item. Pili ulit sa Shop.'); continue; }
          // Return to the Name Effects catalog after previewing an effect, not the main Shop.
          // Keep page 2 effects on page 2 so users can browse the remaining styles without extra taps.
          const nameEffectProducts = ['rainbow','sparkle','heart','fire','ice','neon','blossom','dark','red','blue','green','yellow','gold','demon'];
          const effectsBackPayload = ['green','yellow','gold','demon'].includes(product) ? 'SHOP_EFFECTS_MORE' : 'SHOP_EFFECTS';
          const backPayload = nameEffectProducts.includes(product) ? effectsBackPayload : 'SHOP';
          const backTitle = nameEffectProducts.includes(product) ? '↩️ Back to Name Effects' : '🛍️ Back to Shop';
          await sendImage(psid, image, '✨ 𝐈𝐓𝐄𝐌 𝐏𝐑𝐄𝐕𝐈𝐄𝐖 ✨\n━━━━━━━━━━━━━━━━━━\n🛍️ 𝐈𝐭𝐞𝐦: ' + product.toUpperCase() + ' • ' + priceLabels[product] + '\n💰 𝐘𝐨𝐮𝐫 𝐁𝐚𝐥𝐚𝐧𝐜𝐞: ' + (Number(user.coins)||0) + ' coins\n━━━━━━━━━━━━━━━━━━\n👑 Check out how this item looks!\n🛒 Tap 𝐁𝐔𝐘 to purchase it. Your coins will only be deducted after you tap Buy.', [
            { content_type: 'text', title: '🛒 Buy', payload: purchasePayload },
            { content_type: 'text', title: backTitle, payload: backPayload }
          ]);
          continue;
        }

        // [ADDED] V28 flex effect purchase command, one active effect at a time.
        if (upperRaw.trim().startsWith('EFFECT ')) {
          const effect = upperRaw.trim().split(/\s+/)[1]?.toLowerCase(); const prices = {rainbow:5000,sparkle:10000,heart:2500,fire:2500,ice:2500,neon:3000,blossom:2000,dark:2500,red:1000,blue:1000,green:1000,yellow:1000,gold:4000,demon:4000};
          if (!FLEX_BADGES[effect]) { sendShopResult(psid,'✨ Effects: rainbow, sparkle, heart, fire, ice, neon, blossom, dark, red, blue, green, yellow, gold, demon.'); continue; }
          if (user.nameEffect && user.nameEffect !== 'none') { sendShopResult(psid,'❌ May effect ka na boss! Type unequip. Isa lang pwede!'); continue; }
          if (user.coins < prices[effect]) { sendShopResult(psid,`❌ Insufficient coins! You need ${prices[effect]} coins, but you only have ${user.coins} coins.`); continue; }
          const old = {coins:user.coins,nameEffect:user.nameEffect}; user.coins -= prices[effect]; user.nameEffect=effect;
          if (!await saveUserToDB(psid)) { Object.assign(user,old); sendShopResult(psid,'⚠️ Hindi na-save ang effect.'); continue; }
          sendShopResult(psid,`✨ Equipped ${FLEX_BADGES[effect]}! ${getDisplayName(user)}`); continue;
        }
        // [ADDED] V28 image commands. Existing textual profile command remains supported below.
        if (['ME','MY','PROFILE IMAGE'].includes(upperRaw.trim())) { user.views=(user.views||0)+1; if (!await saveUserToDB(psid)) { user.views--; send(psid,'⚠️ Hindi na-save ang profile view.'); continue; } const img=await generateProfileCanvas({...user,id:psid}); await sendImage(psid,img,`${getDisplayName(user)} • Black & Gold Profile`); continue; }
        if (['LB','TOP','LEADERBOARD IMAGE'].includes(upperRaw.trim())) { const img=await generateLeaderboardCanvas(await getLeaderboardUsers()); await sendImage(psid,img,null,[{content_type:'text',title:'🚪 Exit',payload:'MENU'}]); continue; } // [FIXED] Leaderboard image with only an Exit quick reply; no extra text or caption.

        // ================= ACTIVE CHAT STATE LOOP (1-ON-1 RELAY) =================
        if (user.state === "CHATTING" && !upperRaw.startsWith("GIFT_") && upperRaw !== "SEND_GIFT_MENU") {
          if (upperRaw === "END_CHAT" || cleanText === "end chat" || upperRaw === "MENU" || cleanText === "menu") {
            const partnerPsid = user.activeMatchPsid;
            const userSnapshot = JSON.parse(JSON.stringify(user));
            let partner = partnerPsid ? await loadUserFromDB(partnerPsid) : null;

            if (partner) {
              const partnerSnapshot = JSON.parse(JSON.stringify(partner));
              user.state = "IDLE";
              user.activeMatchPsid = null;
              user.pendingMatchPsid = null;
              partner.state = "IDLE";
              partner.activeMatchPsid = null;
              partner.pendingMatchPsid = null;
              if (!await saveUserPair(psid, partnerPsid)) {
                db.users[psid] = userSnapshot;
                db.users[partnerPsid] = partnerSnapshot;
                user = db.users[psid];
                send(psid, "⚠️ Hindi ma-save ang pag-end ng chat. Subukan ulit mamaya.");
                continue;
              }
              send(partnerPsid, "🔴 The active chat session has been ended by your match.", [
                { content_type: "text", title: "💘 Find New Match", payload: "FIND MATCH" },
                { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
              ]);
            } else {
              user.state = "IDLE";
              user.activeMatchPsid = null;
              user.pendingMatchPsid = null;
              if (!await saveUserToDB(psid, { saveJackpot: false })) {
                db.users[psid] = userSnapshot;
                user = db.users[psid];
                send(psid, "⚠️ Hindi ma-save ang pag-end ng chat. Subukan ulit mamaya.");
                continue;
              }
            }

            if (upperRaw === "MENU" || cleanText === "menu") {
              // [FIXED] Do not show the menu as successful if its page state was not saved.
              const previousPage = user.currentPage;
              user.currentPage = "MENU";
              if (!await saveUserToDB(psid, { saveJackpot: false })) {
                user.currentPage = previousPage;
                send(psid, "⚠️ Hindi na-save ang pagbalik sa Menu. Subukan ulit mamaya.");
                continue;
              }
              sendMenu(psid);
            } else {
              send(psid, "🔴 Chat ended successfully.", [
                { content_type: "text", title: "💘 Find New Match", payload: "FIND MATCH" },
                { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
              ]);
            }
            continue;
          }

          // Relay message to live paired partner if valid
          if (user.activeMatchPsid) {
            let partner = await loadUserFromDB(user.activeMatchPsid);
            if (partner && partner.state === "CHATTING") {
              try {
                const delivered = await send(user.activeMatchPsid, `💬 ${user.name}: ${rawText}`, [
                  { content_type: "text", title: "🎁 Send Gift", payload: "SEND_GIFT_MENU" },
                  { content_type: "text", title: "🔴 End Chat", payload: "END_CHAT" }
                ]);
                if (!delivered) throw new Error("Messenger could not deliver the chat message");
                await send(psid, `✉️ Message sent!`, [
                  { content_type: "text", title: "🎁 Send Gift", payload: "SEND_GIFT_MENU" },
                  { content_type: "text", title: "🔴 End Chat", payload: "END_CHAT" }
                ]);
              } catch (err) {
                user.state = "IDLE";
                user.activeMatchPsid = null;
                await saveUserToDB(psid);

                send(psid, `⚠️ Hindi naisend ang mensahe. Nadisconnect ang kausap mo.`, [
                  { content_type: "text", title: "💘 Find New Match", payload: "FIND MATCH" },
                  { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
                ]);
              }
            } else {
              send(psid, `⚠️ Your match has disconnected or ended the chat.`, [
                { content_type: "text", title: "💘 Find New Match", payload: "FIND MATCH" },
                { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
              ]);
              user.state = "IDLE";
              user.activeMatchPsid = null;
              await saveUserToDB(psid);
            }
          } else {
            send(psid, `💬 Match Reply: "That sounds awesome! Let's hang out soon 😊"`, [
              { content_type: "text", title: "🎁 Send Gift", payload: "SEND_GIFT_MENU" },
              { content_type: "text", title: "🔴 End Chat", payload: "END_CHAT" }
            ]);
          }
          await saveUserToDB(psid);
          continue;
        }

        // PROFILE EDITING HANDLERS
        if (user.state === "EDIT_NAME_AGE") {
          const parts = rawText.split(",");
          const newName = String(parts[0] || "").trim();
          const newAge = Number(String(parts[1] || "").trim());
          if (parts.length !== 2 || !newName || newName.length > 40 ||
              !Number.isInteger(newAge) || newAge < 18 || newAge > 99) {
            send(psid, "⚠️ Invalid format. Type a name (max 40 characters) and an age from 18 to 99, separated by a comma. Example: Alex, 24");
            continue;
          }

          if ((user.profileEdits || 0) > 0 && user.coins < 20) {
            user.state = "IDLE";
            await saveUserToDB(psid);
            send(psid, "❌ Subsequent profile edits cost 20 coins. Your edit was not applied.", [
              { content_type: "text", title: "💰 Top Up", payload: "TOP UP" }
            ]);
            continue;
          }

          const previousProfile = JSON.parse(JSON.stringify(user));
          if ((user.profileEdits || 0) > 0) user.coins -= 20;
          user.name = newName;
          user.age = newAge;
          user.state = "IDLE";
          user.profileEdits = (user.profileEdits || 0) + 1;
          if (!await saveUserToDB(psid)) {
            db.users[psid] = previousProfile;
            user = db.users[psid];
            send(psid, "⚠️ Hindi na-save ang profile. Walang coins na ikakaltas.");
            continue;
          }
          send(psid, `✅ Profile Name & Age updated to **${user.name}, ${user.age}**!`, [
            { content_type: "text", title: "👤 View Profile", payload: "PROFILE" },
            { content_type: "text", title: "↩️ Menu", payload: "MENU" }
          ]);
          continue;
        }

        if (user.state === "EDIT_LOCATION") {
          const newLocation = rawText.trim();
          if (!newLocation || newLocation.length > 80) {
            send(psid, "⚠️ Location must be between 1 and 80 characters. Please try again.");
            continue;
          }
          if ((user.profileEdits || 0) > 0 && user.coins < 20) {
            user.state = "IDLE";
            await saveUserToDB(psid);
            send(psid, "❌ Subsequent profile edits cost 20 coins. Your edit was not applied.");
            continue;
          }
          const previousProfile = JSON.parse(JSON.stringify(user));
          if ((user.profileEdits || 0) > 0) user.coins -= 20;
          user.location = newLocation;
          user.state = "IDLE";
          user.profileEdits = (user.profileEdits || 0) + 1;
          if (!await saveUserToDB(psid)) {
            db.users[psid] = previousProfile;
            user = db.users[psid];
            send(psid, "⚠️ Hindi na-save ang profile. Walang coins na ikakaltas.");
            continue;
          }
          send(psid, `✅ Location updated to **${user.location}**!`, [
            { content_type: "text", title: "👤 View Profile", payload: "PROFILE" },
            { content_type: "text", title: "↩️ Menu", payload: "MENU" }
          ]);
          continue;
        }

        if (user.state === "EDIT_BIO") {
          const newBio = rawText.trim();
          if (!newBio || newBio.length > 500) {
            send(psid, "⚠️ Bio must be between 1 and 500 characters. Please try again.");
            continue;
          }
          if ((user.profileEdits || 0) > 0 && user.coins < 20) {
            user.state = "IDLE";
            await saveUserToDB(psid);
            send(psid, "❌ Subsequent profile edits cost 20 coins. Your edit was not applied.");
            continue;
          }
          const previousProfile = JSON.parse(JSON.stringify(user));
          if ((user.profileEdits || 0) > 0) user.coins -= 20;
          user.bio = newBio;
          user.state = "IDLE";
          user.profileEdits = (user.profileEdits || 0) + 1;
          if (!await saveUserToDB(psid)) {
            db.users[psid] = previousProfile;
            user = db.users[psid];
            send(psid, "⚠️ Hindi na-save ang profile. Walang coins na ikakaltas.");
            continue;
          }
          send(psid, `✅ Bio updated successfully!\\n💬 "${user.bio}"`, [
            { content_type: "text", title: "👤 View Profile", payload: "PROFILE" },
            { content_type: "text", title: "↩️ Menu", payload: "MENU" }
          ]);
          continue;
        }

        // PROFILE LEVEL / XP STATUS
        if (["LEVEL", "XP", "MY LEVEL", "LEVEL STATUS"].includes(upperRaw.trim())) {
          const levelStats = getProfileLevelStats(user.xp);
          const xpBarFilled = Math.floor(levelStats.progress * 10);
          const xpBar = "🟩".repeat(xpBarFilled) + "⬜".repeat(10 - xpBarFilled);
          send(psid, `🌟 JOJOWORLD LEVEL STATUS\n━━━━━━━━━━━━━━━━━━━━\n🏆 Level: ${levelStats.level}\n✨ Total XP: ${levelStats.totalXp}\n📈 Progress: ${levelStats.currentXp} / ${levelStats.nextLevelXp} XP\n${xpBar}\n\n💬 Earn **5 XP** from eligible activity, with a 1-minute cooldown.\n🎯 Next level: ${levelStats.nextLevelXp - levelStats.currentXp} XP to go.`, [
            { content_type: "text", title: "👤 View Profile", payload: "PROFILE" },
            { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
          ]);
          continue;
        }


        // ACHIEVEMENTS / TROPHY SHOWCASE
        if (["ACHIEVEMENTS", "ACHIEVEMENT", "TROPHIES", "TROPHY", "MY BADGES"].includes(upperRaw.trim())) {
          const achievements = getProfileAchievements(user);
          const unlocked = achievements.filter(item => item.unlocked);
          const locked = achievements.filter(item => !item.unlocked);
          const showcase = unlocked.length
            ? unlocked.map(item => item.icon + " " + item.title).join("\n")
            : "Wala pang unlocked trophy — kaya mo 'yan, boss!";
          const nextGoals = locked.slice(0, 3).map(item => "🔒 " + item.title + " — " + item.description).join("\n");
          const message = "🏆 JOJOWORLD • TROPHY SHOWCASE\n━━━━━━━━━━━━━━━━━━━━\n✨ Unlocked: " + unlocked.length + " / " + achievements.length + "\n\n" + showcase + (nextGoals ? "\n\n🎯 NEXT TROPHIES\n" + nextGoals : "\n\n👑 Perfect collection! All trophies unlocked!");
          send(psid, message, [
            { content_type: "text", title: "🌟 My Level / XP", payload: "LEVEL" },
            { content_type: "text", title: "👤 View Profile", payload: "PROFILE" },
            { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
          ]);
          continue;
        }

        // MAIN MENU ROUTING
        if (cleanText === "menu" || upperRaw === "MENU") {
          const previousMenuState = { currentPage: user.currentPage, state: user.state, activeMatchPsid: user.activeMatchPsid };
          user.currentPage = "MENU";
          user.state = "IDLE";
          user.activeMatchPsid = null;
          // [FIXED] Do not report/menu-route successfully if the state change was not persisted.
          if (!await saveUserToDB(psid)) {
            Object.assign(user, previousMenuState);
            send(psid, "⚠️ Hindi ma-save ang pagbalik sa menu. Subukan ulit mamaya.");
            continue;
          }
          sendMenu(psid);
          continue;
        }

        // [UPGRADED V28] Visual-only profile: show equipped/purchased shop items on the profile image, not the legacy text wall.
        if (["profile", "me", "my"].includes(cleanText) || ["PROFILE", "ME", "MY"].includes(upperRaw)) {
          const previousViews = user.views || 0;
          user.views = previousViews + 1;
          // [FIXED] Do not proceed as if the view counter was saved when persistence fails.
          if (!await saveUserToDB(psid, { saveJackpot: false })) {
            user.views = previousViews;
            send(psid, "⚠️ Hindi ma-update ang profile ngayon. Subukan ulit mamaya.");
            continue;
          }
          try {
            const profileImage = await generateProfileCanvas({ ...user, id: psid });
            await sendImage(psid, profileImage, `👑✨ 𝐉𝐎𝐉𝐎𝐖𝐎𝐑𝐋𝐃 • 𝐕𝐈𝐒𝐔𝐀𝐋 𝐏𝐑𝐎𝐅𝐈𝐋𝐄 ✨👑\n💎 Your equipped shop items, proudly displayed.\n🌟 Type LEVEL to check your XP progress.\n⚡ Use the buttons below to customize your profile.`, [
              { content_type: "text", title: "✏️ Edit Profile", payload: "EDIT_PROFILE_MENU" },
              { content_type: "text", title: "♈ Set Zodiac", payload: "SET_ZODIAC_MENU" },
              { content_type: "text", title: "🎯 Set Goal", payload: "SET_GOAL_MENU" },
              { content_type: "text", title: "📸 Change Photo", payload: "SET_PROFILE_PHOTO" },
              { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
            ]);
          } catch (canvasError) {
            console.error("Visual profile generation failed:", canvasError.message);
            send(psid, "⚠️ Your visual profile could not be generated. Please try again.");
          }
          continue;
        }

        // [ADDED] Explicitly arm photo upload only from the profile's Change Photo button.
        if (upperRaw === "SET_PROFILE_PHOTO") {
          const wasAwaitingProfilePhoto = user.awaitingProfilePhoto;
          user.awaitingProfilePhoto = true;
          // [FIXED] Only confirm photo-upload mode if the flag was persisted.
          if (!await saveUserToDB(psid, { saveJackpot: false })) {
            if (wasAwaitingProfilePhoto === undefined) delete user.awaitingProfilePhoto;
            else user.awaitingProfilePhoto = wasAwaitingProfilePhoto;
            send(psid, "⚠️ Hindi ma-activate ang photo upload ngayon. Subukan ulit mamaya.");
            continue;
          }
          send(psid, "📸 Send a photo here to update your profile picture!", [
            { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
          ]);
          continue;
        }

        // EDIT PROFILE SUB-MENU
        if (upperRaw === "EDIT_PROFILE_MENU") {
          let editCostText = (user.profileEdits || 0) === 0 ? "FREE (1st Edit)" : "Costs 20 Coins";
          send(psid, `✏️ EDIT PROFILE MENU (${editCostText})\n━━━━━━━━━━━━━━━━━━━━\nChoose what you want to edit:`, [
            { content_type: "text", title: "✏️ Name & Age", payload: "REQ_EDIT_NAME_AGE" },
            { content_type: "text", title: "📍 Location", payload: "REQ_EDIT_LOCATION" },
            { content_type: "text", title: "💬 Bio", payload: "REQ_EDIT_BIO" },
            { content_type: "text", title: "↩️ Back to Profile", payload: "PROFILE" }
          ]);
          continue;
        }

        if (upperRaw.startsWith("REQ_EDIT_")) {
          if ((user.profileEdits || 0) > 0 && user.coins < 20) {
            send(psid, `❌ Insufficient coins! Subsequent profile edits cost 20 coins.`, [
              { content_type: "text", title: "💰 Top Up", payload: "TOP UP" }
            ]);
            continue;
          }

          if (upperRaw === "REQ_EDIT_NAME_AGE") {
            user.state = "EDIT_NAME_AGE";
            send(psid, `✏️ Enter your Name and Age separated by a comma:\nExample: *Maria, 22*`);
          } else if (upperRaw === "REQ_EDIT_LOCATION") {
            user.state = "EDIT_LOCATION";
            send(psid, `📍 Enter your new Location:\nExample: *Quezon City*`);
          } else if (upperRaw === "REQ_EDIT_BIO") {
            user.state = "EDIT_BIO";
            send(psid, `💬 Enter your new Bio message:`);
          }
          await saveUserToDB(psid);
          continue;
        }

        // [FIXED] Duplicate SET_PROFILE_PHOTO handler removed; the explicit upload-arming handler above is authoritative.

        // ZODIAC SELECTOR
        if (upperRaw === "SET_ZODIAC_MENU") {
          send(psid, `♈ SELECT YOUR ZODIAC SIGN:\n━━━━━━━━━━━━━━━━━━━━`, [
            { content_type: "text", title: "♈ Aries", payload: "ZODIAC_♈ Aries" },
            { content_type: "text", title: "♉ Taurus", payload: "ZODIAC_♉ Taurus" },
            { content_type: "text", title: "♊ Gemini", payload: "ZODIAC_♊ Gemini" },
            { content_type: "text", title: "♋ Cancer", payload: "ZODIAC_♋ Cancer" },
            { content_type: "text", title: "♌ Leo", payload: "ZODIAC_♌ Leo" },
            { content_type: "text", title: "♍ Virgo", payload: "ZODIAC_♍ Virgo" },
            { content_type: "text", title: "♎ Libra", payload: "ZODIAC_♎ Libra" },
            { content_type: "text", title: "♏ Scorpio", payload: "ZODIAC_♏ Scorpio" },
            { content_type: "text", title: "♐ Sagitt.", payload: "ZODIAC_♐ Sagittarius" },
            { content_type: "text", title: "♑ Capric.", payload: "ZODIAC_♑ Capricorn" }
          ]);
          continue;
        }

        if (upperRaw.startsWith("ZODIAC_")) {
          const previousZodiac = user.zodiac;
          user.zodiac = rawText.replace("ZODIAC_", "");
          // [FIXED] Roll back and report a failure instead of falsely confirming an unsaved zodiac.
          if (!await saveUserToDB(psid)) {
            user.zodiac = previousZodiac;
            send(psid, "⚠️ Hindi na-save ang zodiac. Subukan ulit mamaya.");
            continue;
          }
          send(psid, `✨ Zodiac set to **${user.zodiac}**!`, [{ content_type: "text", title: "👤 View Profile", payload: "PROFILE" }]);
          continue;
        }

        // [FIXED] RELATIONSHIP GOAL SELECTOR — show all choices together in one Messenger quick-reply set.
        if (upperRaw === "SET_GOAL_MENU") {
          send(psid, `🎯 CHOOSE YOUR GOAL
━━━━━━━━━━━━━━━━━━━━
Piliin ang goal na pinakaangkop sa iyo:`, [
            { content_type: "text", title: "💍 Serious Rel.", payload: "GOAL_💍 Serious Relationship" },
            { content_type: "text", title: "❤️ Long-Term", payload: "GOAL_❤️ Long-Term Relationship" },
            { content_type: "text", title: "💒 Marriage", payload: "GOAL_💒 Marriage" },
            { content_type: "text", title: "💕 Casual Dating", payload: "GOAL_💕 Casual Dating" },
            { content_type: "text", title: "☕ Coffee Dates", payload: "GOAL_☕ Coffee Dates" },
            { content_type: "text", title: "🎮 Gaming Buddy", payload: "GOAL_🎮 Gaming Buddy" },
            { content_type: "text", title: "✈️ Travel Partner", payload: "GOAL_✈️ Travel Partner" },
            { content_type: "text", title: "💬 Chat Buddy", payload: "GOAL_💬 Chat Buddy" },
            { content_type: "text", title: "👫 Friendship", payload: "GOAL_👫 Friendship" },
            { content_type: "text", title: "💖 New Friends", payload: "GOAL_💖 New Friends" },
            { content_type: "text", title: "↩️ Back to Profile", payload: "PROFILE" }
          ]);
          continue;
        }

        if (upperRaw.startsWith("GOAL_")) {
          const previousGoal = user.relationshipGoal;
          user.relationshipGoal = rawText.replace("GOAL_", "");
          // [FIXED] Roll back and report a failure instead of falsely confirming an unsaved goal.
          if (!await saveUserToDB(psid)) {
            user.relationshipGoal = previousGoal;
            send(psid, "⚠️ Hindi na-save ang relationship goal. Subukan ulit mamaya.");
            continue;
          }
          send(psid, `🎯 Relationship goal updated to **${user.relationshipGoal}**!`, [{ content_type: "text", title: "👤 View Profile", payload: "PROFILE" }]);
          continue;
        }

        // [FIXED] FIND MATCH opens its own page first; it never pairs users by itself.
        if (cleanText === "find match" || upperRaw === "FIND MATCH") {
          const previousPage = user.currentPage;
          user.currentPage = "FIND_MATCH";
          // [FIXED] Search Match depends on this page state, so stop if it cannot be persisted.
          if (!await saveUserToDB(psid)) {
            user.currentPage = previousPage;
            send(psid, "⚠️ Hindi mabuksan ang Find Match ngayon. Subukan ulit mamaya.");
            continue;
          }
          const matchCountCutoff = Date.now() - 15 * 60 * 1000;
          let availableMatchCount = 0;
          try {
            if (MONGODB_URI && mongoose.connection.readyState === 1) {
              availableMatchCount = await UserModel.countDocuments({
                psid: { $ne: psid },
                "data.state": "IDLE",
                "data.activeMatchPsid": null,
                "data.age": { $gte: 18, $lte: 99 },
                "data.lastActive": { $gte: matchCountCutoff }
              });
            } else {
              availableMatchCount = Object.keys(db.users).filter(candidateId =>
                candidateId !== psid &&
                db.users[candidateId]?.state === "IDLE" &&
                !db.users[candidateId]?.activeMatchPsid &&
                Number(db.users[candidateId]?.age) >= 18 &&
                Number(db.users[candidateId]?.age) <= 99 &&
                Number(db.users[candidateId]?.lastActive || 0) >= matchCountCutoff
              ).length;
            }
          } catch (error) {
            console.error("Available match count failed:", error.message);
          }
          send(psid, `💘 FIND YOUR MATCH ✨
━━━━━━━━━━━━━━━━━━━━
Ready to spark a new connection? 💖
Meet someone new, start a fun conversation, and see where it goes!

🟢 Available Matches: ${availableMatchCount}
💎 Search Fee: 10 Coins (charged only when a match is found)`, [
            { content_type: "text", title: "🔎 Search Match (10c)", payload: "SEARCH_MATCH" },
            { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
          ]);
          continue;
        }

        // [FIXED] Search/matching runs only after explicit confirmation on the Find Match page.
        if (upperRaw === "SEARCH_MATCH" || cleanText === "search match") {
          if (user.currentPage !== "FIND_MATCH") {
            send(psid, "⛔ Hindi nagsimula ang matching dahil wala ka sa Find Match page. Buksan muna ang Find Match mula sa menu.", [
              { content_type: "text", title: "💘 Open Find Match", payload: "FIND MATCH" },
              { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
            ]);
            continue;
          }
          const searchCutoff = Date.now() - 15 * 60 * 1000;
          let candidate = null;
          if (MONGODB_URI && mongoose.connection.readyState === 1) {
            try {
              candidate = await UserModel.findOne({
                psid: { $ne: psid },
                "data.state": "IDLE",
                "data.activeMatchPsid": null,
                "data.age": { $gte: 18, $lte: 99 },
                "data.lastActive": { $gte: searchCutoff }
              }).select("psid data").lean();
            } catch (error) {
              console.error("Match search failed:", error.message);
            }
          } else if (!MONGODB_URI) {
            const candidatePsid = Object.keys(db.users).find(candidateId =>
              candidateId !== psid &&
              db.users[candidateId]?.state === "IDLE" &&
              !db.users[candidateId]?.activeMatchPsid &&
              Number(db.users[candidateId]?.age) >= 18 &&
              Number(db.users[candidateId]?.age) <= 99 &&
              Number(db.users[candidateId]?.lastActive || 0) >= searchCutoff
            );
            if (candidatePsid) candidate = { psid: candidatePsid, data: db.users[candidatePsid] };
          }

          if (!candidate || !candidate.data) {
            send(psid, `😕 NO ACTIVE MATCHES RIGHT NOW
━━━━━━━━━━━━━━━━━━━━
There are currently no active users available to match with.

💰 No coins were deducted.
🟢 Available Matches: 0

Please try again in a little while!`, [
              { content_type: "text", title: "🔄 Refresh Matches", payload: "FIND MATCH" },
              { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
            ]);
            continue;
          }
          if (!Number.isFinite(user.coins) || user.coins < 10) {
            send(psid, "❌ Match search costs 10 coins. Kulang ang coins mo.", [
              { content_type: "text", title: "💰 Top Up", payload: "TOP UP" }
            ]);
            continue;
          }

          const previousCoins = user.coins;
          const previousPending = user.pendingMatchPsid || null;
          user.coins -= 10;
          user.pendingMatchPsid = candidate.psid;
          const saved = await saveUserToDB(psid);
          if (!saved) {
            user.coins = previousCoins;
            user.pendingMatchPsid = previousPending;
            send(psid, "⚠️ Hindi na-save ang match search. Walang coins na ikakaltas; subukan ulit mamaya.");
            continue;
          }

          const match = candidate.data;
          // [UPGRADED] Show the matched user's generated Visual Profile image instead of a text-only result.
          try {
            const matchProfileImage = await generateProfileCanvas({ ...match, id: candidate.psid });
            await sendImage(psid, matchProfileImage, `💘 REAL MATCH FOUND! • 10 coins deducted.\\n👑 Here's your match's Visual Profile.\\n💬 Unlock chat for 20 coins to connect.`, [
              { content_type: "text", title: "💬 Unlock Chat (20c)", payload: "UNLOCK_CHAT" },
              { content_type: "text", title: "⏭️ Next Match (10c)", payload: "FIND MATCH" },
              { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
            ]);
          } catch (matchProfileError) {
            console.error("[MATCH PROFILE] Visual profile generation failed:", matchProfileError.message);
            send(psid, "💘 Match found, pero hindi ma-generate ang Visual Profile ngayon. Subukan ulit mamaya.", [
              { content_type: "text", title: "💬 Unlock Chat (20c)", payload: "UNLOCK_CHAT" },
              { content_type: "text", title: "⏭️ Next Match (10c)", payload: "FIND MATCH" },
              { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
            ]);
          }
          continue;
        }

        // GIFTING SYSTEM
        if (upperRaw === "SEND_GIFT_MENU") {
          send(psid, `🎁 JOJOWORLD V26 GIFT HUB
━━━━━━━━━━━━━━━━━━━━
${renderGiftCatalog()}

🎯 Gifts can be sent only to your active chat partner.
🎁 Gift counts appear on the recipient's profile.`, [
            { content_type: "text", title: "🌹 Rose (25c)", payload: "GIFT_ROSE" },
            { content_type: "text", title: "☕ Coffee (60c)", payload: "GIFT_COFFEE" },
            { content_type: "text", title: "🧸 Bear (120c)", payload: "GIFT_BEAR" },
            { content_type: "text", title: "💍 Ring (250c)", payload: "GIFT_RING" },
            { content_type: "text", title: "🏎️ Car (750c)", payload: "GIFT_CAR" }
          ]);
          continue;
        }

        if (upperRaw.startsWith("GIFT_")) {
          const giftKey = upperRaw.replace("GIFT_", "");
          const recipientPsid = user.activeMatchPsid;

          if (!recipientPsid || recipientPsid === psid) {
            send(psid, "❌ You need an active chat partner before sending a gift. No coins were deducted.", [
              { content_type: "text", title: "💘 Find Match", payload: "FIND MATCH" },
              { content_type: "text", title: "↩️ Menu", payload: "MENU" }
            ]);
            continue;
          }

          const partner = await loadUserFromDB(recipientPsid);
          if (!partner || partner.activeMatchPsid !== psid || partner.state !== "CHATTING" || user.state !== "CHATTING") {
            send(psid, "❌ Your chat partner is no longer active. No coins were deducted.", [
              { content_type: "text", title: "💘 Find Match", payload: "FIND MATCH" },
              { content_type: "text", title: "↩️ Menu", payload: "MENU" }
            ]);
            continue;
          }

          const senderSnapshot = JSON.parse(JSON.stringify(user));
          const recipientSnapshot = JSON.parse(JSON.stringify(partner));
          let giftResult;
          try {
            giftResult = applyGift({
              senderPsid: psid,
              recipientPsid,
              sender: user,
              recipient: partner,
              giftKey
            });
          } catch (error) {
            if (error instanceof GiftHubError) {
              const help = error.code === "INSUFFICIENT_COINS"
                ? [{ content_type: "text", title: "💰 Top Up", payload: "TOP UP" }]
                : [];
              send(psid, `❌ ${error.message} No coins were deducted.`, help);
              continue;
            }
            throw error;
          }

          // Never report success unless both wallet/profile changes persist together.
          const giftSaved = await saveUserPair(psid, recipientPsid);
          if (!giftSaved) {
            db.users[psid] = senderSnapshot;
            db.users[recipientPsid] = recipientSnapshot;
            user = db.users[psid];
            send(psid, "❌ Hindi na-save ang gift transfer. Walang successful na gift na naitala; subukan ulit mamaya.");
            continue;
          }

          try {
            await send(recipientPsid, `🎁 SURPRISE! ${user.name || "Your match"} sent you ${giftResult.gift.name}! Bonus: +${giftResult.gift.bonus} coins. Total gifts received: ${partner.giftsCount}. ❤️`, [
              { content_type: "text", title: "👤 View Profile", payload: "PROFILE" }
            ]);
          } catch (notifyError) {
            console.log("Gift recipient notification failed:", notifyError.message);
          }

          send(psid, `🎉 GIFT SENT! You sent ${giftResult.gift.name} to ${partner.name || "your match"} for ${giftResult.gift.cost} coins. They received +${giftResult.gift.bonus} bonus coins! Your balance: ${user.coins} coins. ❤️`, [
            { content_type: "text", title: "🎁 Send Another Gift", payload: "SEND_GIFT_MENU" },
            { content_type: "text", title: "🔴 End Chat", payload: "END_CHAT" }
          ]);
          continue;
        }

        // UNLOCK CHAT & PAIR REAL USERS
        if (upperRaw === "UNLOCK_CHAT" || cleanText === "unlock_chat") {
          if (user.state === "CHATTING" && user.activeMatchPsid) {
            send(psid, "ℹ️ You are already connected to a match.", [
              { content_type: "text", title: "🎁 Send Gift", payload: "SEND_GIFT_MENU" },
              { content_type: "text", title: "🔴 End Chat", payload: "END_CHAT" }
            ]);
            continue;
          }
          if (!Number.isFinite(user.coins) || user.coins < 20) {
            send(psid, "❌ Unlocking chat costs 20 coins.", [
              { content_type: "text", title: "💰 Top Up", payload: "TOP UP" }
            ]);
            continue;
          }

          const originalUser = JSON.parse(JSON.stringify(user));
          const unlockCutoff = Date.now() - 15 * 60 * 1000;
          const pendingCandidatePsid = user.pendingMatchPsid || null;
          let partnerPsid = null;

          if (MONGODB_URI && mongoose.connection.readyState === 1) {
            try {
              // [UPGRADED V28] Atomically reserve only a recently active, eligible, idle partner.
              const candidateFilter = {
                psid: pendingCandidatePsid ? pendingCandidatePsid : { $ne: psid },
                "data.state": "IDLE",
                "data.activeMatchPsid": null,
                "data.age": { $gte: 18, $lte: 99 },
                "data.lastActive": { $gte: unlockCutoff }
              };
              if (!pendingCandidatePsid) candidateFilter.psid = { $ne: psid };
              const matchDoc = await UserModel.findOneAndUpdate(
                candidateFilter,
                { $set: { "data.state": "CHATTING", "data.activeMatchPsid": psid } },
                { new: true }
              );
              if (matchDoc) partnerPsid = matchDoc.psid;
            } catch (e) {
              console.error("Matchmaking query error:", e.message);
            }
          } else if (!MONGODB_URI) {
            const eligible = pId => {
              const candidateUser = db.users[pId];
              return pId !== psid &&
                candidateUser?.state === "IDLE" &&
                !candidateUser?.activeMatchPsid &&
                Number(candidateUser?.age) >= 18 &&
                Number(candidateUser?.age) <= 99 &&
                Number(candidateUser?.lastActive || 0) >= unlockCutoff;
            };
            partnerPsid = pendingCandidatePsid
              ? (eligible(pendingCandidatePsid) ? pendingCandidatePsid : null)
              : (Object.keys(db.users).find(eligible) || null);
          }

          if (!partnerPsid) {
            send(psid, "😕 Your selected match is no longer available. No unlock coins were deducted. Please refresh Find Your Match and try again.", [
              { content_type: "text", title: "🔄 Refresh Matches", payload: "FIND MATCH" },
              { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
            ]);
            continue;
          }

          user.coins -= 20;
          user.state = "CHATTING";
          user.activeMatchPsid = null;

          // [FIXED] partnerPsid is already checked above; retain the original state if no partner exists.
          const partner = await loadUserFromDB(partnerPsid);
          if (!partner || partnerPsid === psid) {
            Object.assign(user, originalUser);
            user.pendingMatchPsid = null;
            if (partner) {
              partner.state = "IDLE";
              partner.activeMatchPsid = null;
              partner.pendingMatchPsid = null;
              await saveUserToDB(partnerPsid);
            } else if (MONGODB_URI && mongoose.connection.readyState === 1) {
              await UserModel.updateOne(
                { psid: partnerPsid },
                { $set: { "data.state": "IDLE", "data.activeMatchPsid": null, "data.pendingMatchPsid": null } }
              );
            }
            await saveUserToDB(psid);
            send(psid, "⚠️ We could not confirm this match. No unlock coins were deducted. Please try again.");
            continue;
          }

          user.activeMatchPsid = partnerPsid;
          user.pendingMatchPsid = null;
          partner.activeMatchPsid = psid;
          partner.pendingMatchPsid = null;
          partner.state = "CHATTING";

          if (!await saveUserPair(psid, partnerPsid)) {
            Object.assign(user, originalUser);
            partner.state = "IDLE";
            partner.activeMatchPsid = null;
            partner.pendingMatchPsid = null;
            if (MONGODB_URI && mongoose.connection.readyState === 1) {
              await UserModel.updateOne(
                { psid: partnerPsid },
                { $set: { "data.state": "IDLE", "data.activeMatchPsid": null, "data.pendingMatchPsid": null } }
              );
            }
            await saveUserToDB(partnerPsid);
            await saveUserToDB(psid);
            send(psid, "⚠️ We could not save the chat connection. No unlock coins were deducted. Please try again.");
            continue;
          }

          send(psid, `🔓 CHAT UNLOCKED! You are now connected with **${partner.name || "your match"}**!\\n\\n💬 Type your message below to start chatting:`, [
            { content_type: "text", title: "🎁 Send Gift", payload: "SEND_GIFT_MENU" },
            { content_type: "text", title: "🔴 End Chat", payload: "END_CHAT" }
          ]);
          send(partnerPsid, `🎉 MATCH CONNECTED! **${user.name || "Your match"}** has unlocked a chat session with you!\\n\\n💬 Type your message below to reply:`, [
            { content_type: "text", title: "🎁 Send Gift", payload: "SEND_GIFT_MENU" },
            { content_type: "text", title: "🔴 End Chat", payload: "END_CHAT" }
          ]);
          continue;
        }

        // SCATTER SLOT WHEEL OF FORTUNE
        if (cleanText === "spin" || upperRaw === "SPIN") {
          if (user.coins < 10) {
            send(psid, `❌ Spin costs 10 coins! Balance: ${user.coins} coins.`, [{ content_type: "text", title: "💰 Top Up", payload: "TOP UP" }]);
            continue;
          }

          const spinSnapshot = { coins: user.coins, jackpotPool: db.jackpotPool };
          user.coins -= 10;
          db.jackpotPool += 5;

          let combos = [
            { visual: "💥 [ 💣 | ❌ | 💣 ]", win: 0, text: "Zonk! Better luck next time!" },
            { visual: "🪙 [ 🪙 | 🪙 | 🎁 ]", win: 20, text: "Small Win! +20 Coins!" },
            { visual: "💎 [ 💎 | 💎 | 💎 ]", win: 75, text: "BIG WIN! Multiplier +75 Coins!" },
            { visual: "👑 [ 👑 | 👑 | 👑 ]", win: db.jackpotPool, text: "🎉 GRAND JACKPOT WINNER!" }
          ];

          let rand = Math.random();
          let result = combos[0];
          if (rand < 0.025) {
            result = combos[3];
          } else if (rand < 0.22) {
            result = combos[2];
          } else if (rand < 0.58) {
            result = combos[1];
          }

          if (result.visual.includes("👑")) {
            user.coins += db.jackpotPool;
            let wonJackpot = db.jackpotPool;
            db.jackpotPool = 1500;
            if (!await saveUserToDB(psid, { saveJackpot: true })) {
              user.coins = spinSnapshot.coins;
              db.jackpotPool = spinSnapshot.jackpotPool;
              send(psid, "⚠️ Hindi na-save ang spin. Walang coins na ikakaltas; subukan ulit mamaya.");
              continue;
            }

            send(psid, `🎰 SCATTER SPIN WHEEL 🎰\n━━━━━━━━━━━━━━━━━━━━\n${result.visual}\n\n🏆 UNBELIEVABLE! YOU WON THE JACKPOT OF ${wonJackpot} COINS!\n💎 Balance: ${user.coins} coins`, [
              { content_type: "text", title: "🎰 Spin Again (-10c)", payload: "SPIN" },
              { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
            ]);
          } else {
            user.coins += result.win;
            if (!await saveUserToDB(psid, { saveJackpot: true })) {
              user.coins = spinSnapshot.coins;
              db.jackpotPool = spinSnapshot.jackpotPool;
              send(psid, "⚠️ Hindi na-save ang spin. Walang coins na ikakaltas; subukan ulit mamaya.");
              continue;
            }

            send(psid, `🎰 SCATTER SPIN WHEEL 🎰\n━━━━━━━━━━━━━━━━━━━━\n${result.visual}\n\n${result.text}\n🔥 Global Jackpot Pool: 🏆 ${db.jackpotPool} Coins\n💎 Balance: ${user.coins} coins`, [
              { content_type: "text", title: "🎰 Spin Again (-10c)", payload: "SPIN" },
              { content_type: "text", title: "💰 Top Up", payload: "TOP UP" },
              { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
            ]);
          }
          continue;
        }

        // TOP UP & PAYMONGO ROUTING
        if (cleanText === "top up" || upperRaw === "TOP UP") {
          sendTopupMenu(psid);
          continue;
        }

        if (upperRaw.startsWith("TOP UP ")) {
          const amountMatch = /^TOP UP\s+(\d+)$/.exec(upperRaw);
          const amt = amountMatch ? Number(amountMatch[1]) : NaN;
          let coins = TOPUP_RATES[amt];
          if (!coins) {
            send(psid, `❌ Invalid package. Choose from 20, 50, 80, 100, 200, 500.`);
            continue;
          }
          send(psid, `⏳ Generating secure PayMongo link for P${amt} = ${coins} coins...`);
          let link = await createPaymongoLink(amt, coins, psid);
          if (link) {
            send(psid, `💎 SECURE PAYMENT LINK\n━━━━━━━━━━━━━━━━━━━━\n💰 Package: P${amt} (${coins} Coins)\n🔒 Powered by PayMongo\n\n👇 Click link to pay:\n${link}`, [
              { content_type: "text", title: "↩️ Menu", payload: "MENU" }
            ]);
          } else {
            if (GCASH_NUM) {
              send(psid, `❌ Payment gateway is not configured or unavailable. If manual GCash payments are enabled, contact admin: ${GCASH_NUM}`);
            } else {
              send(psid, `❌ Payment gateway is not configured or is temporarily unavailable. Please try again later.`);
            }
          }
          continue;
        }

        // DAILY BONUS
        if (cleanText === "daily" || upperRaw === "DAILY") {
          let now = Date.now();
          if (now - user.lastDaily < 86400000) {
            let hoursLeft = Math.ceil((86400000 - (now - user.lastDaily)) / 3600000);
            send(psid, `🎁 Daily bonus already claimed! Come back in ${hoursLeft} hours.`, [{ content_type: "text", title: "↩️ Menu", payload: "MENU" }]);
          } else {
            const previousDailyState = { coins: user.coins, lastDaily: user.lastDaily };
            user.coins += 35;
            user.lastDaily = now;
            if (!await saveUserToDB(psid)) {
              user.coins = previousDailyState.coins;
              user.lastDaily = previousDailyState.lastDaily;
              send(psid, "⚠️ Hindi na-save ang daily bonus. Subukan ulit mamaya.");
              continue;
            }
            send(psid, `🎁 DAILY REWARD CLAIMED!\n💰 +35 Coins added!\n💎 Balance: ${user.coins} coins`, [
              { content_type: "text", title: "🎡 Scatter Spin", payload: "SPIN" },
              { content_type: "text", title: "↩️ Menu", payload: "MENU" }
            ]);
          }
          continue;
        }

        // [UPGRADED V28] Messenger shop with category buttons and direct purchase quick replies.
        // Messenger quick replies support up to 13 items, so the catalog is split into categories.
        if (upperRaw === 'SHOP_EFFECTS') {
          const previousPage = user.currentPage;
          user.currentPage = "SHOP";
          if (!await saveUserToDB(psid)) { user.currentPage = previousPage; send(psid, "⚠️ Hindi mabuksan ang Shop ngayon. Subukan ulit mamaya."); continue; }
          send(psid, "💎 JOJOWORLD SHOP — NAME EFFECTS (PAGE 1/2)\nPumili ng effect para makita ang visual preview at bumili.", [
            { content_type: "text", title: "🌈 Rainbow 5,000c", payload: "PREVIEW_rainbow" },
            { content_type: "text", title: "✨ Sparkle 10,000c", payload: "PREVIEW_sparkle" },
            { content_type: "text", title: "💖 Heart 2,500c", payload: "PREVIEW_heart" },
            { content_type: "text", title: "🔥 Fire 2,500c", payload: "PREVIEW_fire" },
            { content_type: "text", title: "❄️ Ice 2,500c", payload: "PREVIEW_ice" },
            { content_type: "text", title: "⚡ Neon 3,000c", payload: "PREVIEW_neon" },
            { content_type: "text", title: "🌸 Blossom 2,000c", payload: "PREVIEW_blossom" },
            { content_type: "text", title: "🖤 Dark 2,500c", payload: "PREVIEW_dark" },
            { content_type: "text", title: "🔴 Red 1,000c", payload: "PREVIEW_red" },
            { content_type: "text", title: "🔵 Blue 1,000c", payload: "PREVIEW_blue" },
            { content_type: "text", title: "➡️ More Effects", payload: "SHOP_EFFECTS_MORE" },
            { content_type: "text", title: "↩️ Back to Shop", payload: "SHOP" }
          ]);
          continue;
        }

        if (upperRaw === 'SHOP_EFFECTS_MORE') {
          const previousPage = user.currentPage;
          user.currentPage = "SHOP";
          if (!await saveUserToDB(psid)) { user.currentPage = previousPage; send(psid, "⚠️ Hindi mabuksan ang Shop ngayon. Subukan ulit mamaya."); continue; }
          send(psid, "💎 JOJOWORLD SHOP — NAME EFFECTS (PAGE 2/2)\nMore premium styles. Bawat effect ay may sariling visual preview.", [
            { content_type: "text", title: "🟢 Green 1,000c", payload: "PREVIEW_green" },
            { content_type: "text", title: "🟡 Yellow 1,000c", payload: "PREVIEW_yellow" },
            { content_type: "text", title: "👑 Gold 4,000c", payload: "PREVIEW_gold" },
            { content_type: "text", title: "😈 Demon 4,000c", payload: "PREVIEW_demon" },
            { content_type: "text", title: "↩️ Back to Effects", payload: "SHOP_EFFECTS" },
            { content_type: "text", title: "↩️ Back to Shop", payload: "SHOP" }
          ]);
          continue;
        }

        if (upperRaw === 'SHOP_HOUSES') {
          const previousPage = user.currentPage;
          user.currentPage = "SHOP";
          // [FIXED] Do not show the category when the page state cannot be saved.
          if (!await saveUserToDB(psid)) { user.currentPage = previousPage; send(psid, "⚠️ Hindi mabuksan ang Shop ngayon. Subukan ulit mamaya."); continue; }
          send(psid, "🏠 JOJOWORLD HOUSE SHOP\n━━━━━━━━━━━━━━━━━━━━\n[13] 🛖 Kubo — 1,500c\n[14] 🏡 Bahay — 5,000c (requires Kubo)\n[15] 🏰 Mansion — 15,000c (requires Bahay)\n[16] 🏢 Building — 40,000c (requires Mansion)\n\nHouse upgrades must be purchased in order. Tap the house you want below; your balance and requirements will be checked before any coins are deducted.", [
            { content_type: "text", title: "🛖 Kubo 1,500c", payload: "PREVIEW_HOUSE_KUBO" },
            { content_type: "text", title: "🏡 Bahay 5,000c", payload: "PREVIEW_HOUSE_BAHAY" },
            { content_type: "text", title: "🏰 Mansion 15k", payload: "PREVIEW_HOUSE_MANSION" },
            { content_type: "text", title: "🏢 Building 40k", payload: "PREVIEW_HOUSE_BUILDING" },
            { content_type: "text", title: "↩️ Back to Shop", payload: "SHOP" }
          ]);
          continue;
        }

        if (cleanText === "shop" || upperRaw === "SHOP") {
          const previousPage = user.currentPage;
          user.currentPage = "SHOP";
          // [FIXED] Do not open the Shop if its page state cannot be persisted.
          if (!await saveUserToDB(psid)) {
            user.currentPage = previousPage;
            send(psid, "⚠️ Hindi mabuksan ang Shop ngayon. Subukan ulit mamaya.");
            continue;
          }
          // [UPGRADED V28] Send a generated neon shop poster plus live Messenger purchase/category buttons.
          const shopImage = await generateShopCanvas();
          await sendImage(psid, shopImage, null, [
            { content_type: "text", title: "☑️ Verified VIP 1,000c", payload: "PREVIEW_VIP" },
            { content_type: "text", title: "👑 Royalty Frame 500c", payload: "PREVIEW_FRAME" },
            { content_type: "text", title: "💎 Name Effects", payload: "SHOP_EFFECTS" },
            { content_type: "text", title: "🏠 Houses", payload: "SHOP_HOUSES" },
            { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
          ]);
          continue;
        }
        if (upperRaw === "BUY_VIP") {
          // [FIXED] Duplicate VIP validation happens before deducting coins.
          if (user.vip || user.badge === "👑 VIP Elite") { sendShopResult(psid, "❌ Meron ka na VIP boss!"); continue; }
          if (user.coins < 1000) {
            sendShopResult(psid, `❌ Not enough coins! VIP Badge costs 1,000 coins.`);
          } else {
            const previousVipState = { coins: user.coins, badge: user.badge, vip: user.vip };
            user.coins -= 1000;
            user.vip = true;
            user.badge = "👑 VIP Elite";
            if (!await saveUserToDB(psid)) {
              user.coins = previousVipState.coins;
              user.badge = previousVipState.badge;
              user.vip = previousVipState.vip;
              sendShopResult(psid, "⚠️ Hindi na-save ang VIP purchase. Walang coins na ikakaltas.");
              continue;
            }
            sendShopResult(psid, `🎉 SUCCESS! You are now a VIP Elite member! 👑`);
          }
          continue;
        }

        if (upperRaw === "BUY_FRAME") {
          // [FIXED] Duplicate gold-frame validation happens before deducting coins.
          if (user.royalFrame || user.goldFrame || String(user.frame || "").toLowerCase().includes("royal") || String(user.frame || "").toLowerCase().includes("gold")) { sendShopResult(psid, "❌ Meron ka na Royalty Frame boss!"); continue; }
          if (user.coins < 500) {
            sendShopResult(psid, `❌ Not enough coins! Royalty Frame costs 500 coins.`);
          } else {
            const previousFrameState = { coins: user.coins, frame: user.frame, goldFrame: user.goldFrame, royalFrame: user.royalFrame };
            user.coins -= 500;
            user.goldFrame = true;
            user.royalFrame = true;
            user.frame = "👑 Royalty Frame";
            if (!await saveUserToDB(psid)) {
              user.coins = previousFrameState.coins;
              user.frame = previousFrameState.frame;
              user.goldFrame = previousFrameState.goldFrame;
              user.royalFrame = previousFrameState.royalFrame;
              sendShopResult(psid, "⚠️ Hindi na-save ang frame purchase. Walang coins na ikakaltas.");
              continue;
            }
            sendShopResult(psid, `🎉 SUCCESS! Royalty Frame unlocked! 👑`);
          }
          continue;
        }

        // [UPGRADED V28] Image-only leaderboard: no text caption or text fallback.
        if (["leaderboard", "lb", "top"].includes(cleanText) || ["LEADERBOARD", "LB", "TOP"].includes(upperRaw)) {
          try {
            const leaderboardImage = await generateLeaderboardCanvas(await getLeaderboardUsers());
            // [FIXED] Send leaderboard image with only the Exit quick reply attached; no separate text message.
            const sent = await sendImage(psid, leaderboardImage, null, [{ content_type: 'text', title: '🚪 Exit', payload: 'MENU' }]);
            if (!sent) console.error('[FIXED] Leaderboard image could not be sent; check Messenger API logs.');
          } catch (leaderboardError) {
            console.error('[FIXED] Leaderboard canvas failed:', leaderboardError.message);
          }
          continue;
        }

        // REFERRAL MESSENGER DIRECT LINK
        if (cleanText === "invite" || upperRaw === "INVITE") {
          let messengerLink = `https://m.me/${PAGE_USERNAME}?ref=REF_${psid}`;
          send(psid, `🔗 REFERRAL & INVITE PROGRAM\n━━━━━━━━━━━━━━━━━━━━\n🎁 Share your unique Messenger link below to earn rewards!\n\n👇 Your Referral Link:\n${messengerLink}\n\n👥 Total Successful Invites: ${user.refCount || 0}\n💰 Earn +100 Coins for every friend who joins!`, [{ content_type: "text", title: "↩️ Menu", payload: "MENU" }]);
          continue;
        }

        // DEFAULT FALLBACK -> MAIN MENU
        sendMenu(psid);
        } finally {
          releaseUserQueue();
          if (messengerUserQueues.get(psid) === currentUserQueue) {
            messengerUserQueues.delete(psid);
          }
        }
      }
    }
  } catch (e) {
    console.error("Messenger webhook processing error:", e.message);
    // [FIXED] Do not acknowledge a failed webhook as successful; release the current message reservation so Meta can retry.
    if (activeWebhookMessageId) {
      if (MONGODB_URI && mongoose.connection.readyState === 1) {
        try {
          await ProcessedMessengerMessageModel.deleteOne({ messageId: activeWebhookMessageId });
        } catch (releaseError) {
          console.error("[FIXED] Could not release failed Messenger message reservation:", releaseError.message);
        }
      } else {
        processedMessengerMessages.delete(activeWebhookMessageId);
      }
    }
    return res.sendStatus(500);
  }
  return res.sendStatus(200);
});

app.get('/', (req, res) => res.status(200).json({
  service: 'JojoWorld V26 Ultimate Evolution',
  status: 'running',
  health: '/health',
  readiness: '/ready'
}));

// Liveness probe: confirms the Node.js process and HTTP server are responding.
app.get('/health', (req, res) => res.status(200).json({
  status: 'ok',
  service: 'JojoWorld V26 Ultimate Evolution',
  uptimeSeconds: Math.floor(process.uptime())
}));

// Readiness probe: distinguishes a live process from a configured Messenger bot.
app.get('/ready', (req, res) => {
  const checks = {
    pageToken: Boolean(PAGE_TOKEN),
    verifyToken: Boolean(VERIFY_TOKEN),
    mongodb: Boolean(MONGODB_URI),
    mongodbConnected: !MONGODB_URI || mongoose.connection.readyState === 1,
    aiNameArtPersistentCache: Boolean(MONGODB_URI && mongoose.connection.readyState === 1),
    metaAppSecret: Boolean(META_APP_SECRET),
    aiNameArt: isAINameArtConfigured(),
    paymongoSecret: Boolean(PAYMONGO_SECRET),
    paymongoWebhookSecret: Boolean(PAYMONGO_WEBHOOK_SECRET)
  };
  const messengerReady = checks.pageToken && checks.verifyToken && checks.metaAppSecret && checks.mongodbConnected;
  const paymentsReady = checks.paymongoSecret && checks.paymongoWebhookSecret && checks.mongodb && checks.mongodbConnected;
  res.status(messengerReady ? 200 : 503).json({
    status: messengerReady ? 'ready' : 'needs_configuration',
    messengerReady,
    paymentsReady,
    persistentStorageConfigured: checks.mongodb,
    checks
  });
});

app.listen(process.env.PORT || 10000, () => console.log("JojoWorld V26 Ultimate Evolution server listening on port " + (process.env.PORT || 10000)));
