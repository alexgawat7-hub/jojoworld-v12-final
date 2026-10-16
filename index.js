// ============================================================================
// JOJOWORLD V26 ULTIMATE EVOLUTION - MESSENGER BOT
// ============================================================================
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
// [ADDED] V28 canvas profile and leaderboard rendering.
const { createCanvas } = require('canvas');
const path = require('path');
const fsExtra = require('fs-extra');
const mongoose = require('mongoose');
const axios = require('axios');
const { verifyPayMongoSignature } = require('./v26/src/security/paymongo');
const { verifyMessengerSignature } = require('./v26/src/security/messenger');
const { GIFT_CATALOG, GiftHubError, sendGift: applyGift, renderGiftCatalog } = require('./v26/src/services/gifts');

// [ADDED] V28 cache directory for generated profile and leaderboard images.
const cacheDir = path.join(__dirname, 'cache');
fsExtra.ensureDirSync(cacheDir);
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

const ADMIN_ID = configuredValue(process.env.ADMIN_ID);
const GCASH_NUM = configuredValue(process.env.GCASH_NUM);
const PAYMONGO_SECRET = configuredValue(process.env.PAYMONGO_SECRET);
const PAYMONGO_WEBHOOK_SECRET = configuredValue(process.env.PAYMONGO_WEBHOOK_SECRET);
const PAGE_TOKEN = configuredValue(process.env.PAGE_TOKEN);
const VERIFY_TOKEN = configuredValue(process.env.VERIFY_TOKEN);
const META_APP_SECRET = configuredValue(process.env.META_APP_SECRET);
const MONGODB_URI = configuredValue(process.env.MONGODB_URI);

// PAGE NAME FOR MESSENGER LINK
const PAGE_USERNAME = configuredValue(process.env.PAGE_USERNAME) || "Princelucky";

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
const processedPaymentEvents = new Set();

// Messenger may retry delivery of the same message. Keep a unique message ID
// record so a wallet-changing command is not applied twice.
const ProcessedMessengerMessageSchema = new mongoose.Schema({
  messageId: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 }
});
const ProcessedMessengerMessageModel = mongoose.models.JProcessedMessengerMessage ||
  mongoose.model('JProcessedMessengerMessage', ProcessedMessengerMessageSchema);
const processedMessengerMessages = new Set();

// Serialize Messenger webhook handling in this process to reduce concurrent wallet races.
let messengerWebhookQueue = Promise.resolve();

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

async function saveUserToDB(psid, { saveJackpot = true } = {}) {
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
const GIFTS = GIFT_CATALOG;

// [ADDED] [UPGRADED V28] House tiers, values, flex labels, tax, and canvas helpers.
const HOUSE_CONFIG = {
  none: { tier: 0, value: 0, price: 0, tax: 0, badge: '' },
  kubo: { tier: 1, value: 1500, price: 1500, tax: 20, badge: '🛖' },
  bahay: { tier: 2, value: 6500, price: 5000, tax: 100, badge: '🏠' },
  mansion: { tier: 3, value: 21500, price: 15000, tax: 350, badge: '🏰' },
  building: { tier: 4, value: 61500, price: 40000, tax: 1000, badge: '🏢' }
};
const HOUSE_REQUIREMENTS = { kubo: 'none', bahay: 'kubo', mansion: 'bahay', building: 'mansion' };
const FLEX_BADGES = { rainbow: '🌈 [RARE]', sparkle: '✨ [MYTHIC]', heart: '💖 [LOVE]', fire: '🔥 [HOT]', ice: '❄️ [COLD]', neon: '⚡ [NEON]', blossom: '🌸 [CUTE]', dark: '🖤 [DARK]', red: '🔴', blue: '🔵', green: '🟢', yellow: '🟡' };
function getHouseTier(house = 'none') { return HOUSE_CONFIG[String(house).toLowerCase()]?.tier ?? 0; }
function getHouseValue(house = 'none') { return HOUSE_CONFIG[String(house).toLowerCase()]?.value ?? 0; }
function getNetWorth(user) { return Math.max(0, Number(user.coins) || 0) + getHouseValue(user.house); }
function getDisplayName(user) {
  const badges = [];
  if (HOUSE_CONFIG[user.house]?.badge) badges.push(HOUSE_CONFIG[user.house].badge);
  if (user.vip || user.badge === '👑 VIP Elite' || user.badge === 'VIP') badges.push('👑');
  if (user.goldFrame || String(user.frame || '').toLowerCase().includes('gold')) badges.push('🖼️');
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
function drawV28Canvas(title, width, height) {
  const canvas = createCanvas(width, height); const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0a0a0a'; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#FFD700'; ctx.lineWidth = 6; ctx.strokeRect(12, 12, width - 24, height - 24);
  ctx.fillStyle = '#FFD700'; ctx.font = 'bold 34px Sans'; ctx.fillText(title, 36, 62);
  ctx.strokeStyle = '#FFD700'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(36, 82); ctx.lineTo(width - 36, 82); ctx.stroke();
  return { canvas, ctx };
}
async function generateProfileCanvas(user) {
  const { canvas, ctx } = drawV28Canvas('JOJOWORLD V28 • PROFILE', 800, 850);
  const rows = [
    ['DISPLAY NAME', getDisplayName(user).slice(0, 35)],
    ['WEALTH', `Coins: ${Number(user.coins) || 0}  |  House value: ${getHouseValue(user.house)}`],
    ['NET WORTH', String(getNetWorth(user))], ['HOUSE TIER', `${String(user.house || 'none').toUpperCase()} • Tier ${getHouseTier(user.house)}`],
    ['VIEWS / GIFTS / SCATTER WINS', `${user.views || 0} / ${user.giftsCount || Object.values(user.giftsReceived || {}).reduce((a,b)=>a+(Number(b)||0),0)} / ${user.scatterWins || 0}`],
    ['IDENTITY', `${user.location || 'Nueva Ecija'} • ${user.zodiac || 'Not set'} • Age ${user.age || 25}`],
    ['GOAL', user.relationshipGoal || 'Serious Relationship'], ['BIO', user.bio || 'Hello JojoWorld V28!'],
    ['FLEX', `${user.nameEffect || 'none'} • VIP: ${user.vip ? 'YES' : 'NO'} • Gold Frame: ${user.goldFrame ? 'YES' : 'NO'}`]
  ];
  let y = 122;
  for (const [label, value] of rows) {
    ctx.fillStyle = '#FFD700'; ctx.font = 'bold 19px Sans'; ctx.fillText(label, 38, y);
    ctx.fillStyle = '#FFFFFF'; ctx.font = '20px Sans'; canvasText(ctx, value, 38, y + 28, 710, 25, label === 'BIO' ? 3 : 2); y += label === 'BIO' ? 84 : 72;
  }
  const file = path.join(cacheDir, `profile_${String(user.id || user.psid || 'user').replace(/[^a-zA-Z0-9_-]/g, '')}.png`);
  await fsExtra.writeFile(file, canvas.toBuffer('image/png')); return file;
}
async function generateLeaderboardCanvas(users) {
  const { canvas, ctx } = drawV28Canvas('JOJOWORLD V28 • TOP 10 RICHEST', 800, 1050);
  const top = Object.entries(users || {}).map(([id,u])=>({id,user:u,net:getNetWorth(u)})).sort((a,b)=>b.net-a.net).slice(0,10);
  let y = 132;
  top.forEach((item, i) => { const medal = ['🥇','🥈','🥉'][i] || `#${i+1}`; ctx.fillStyle = i < 3 ? '#FFD700' : '#FFFFFF'; ctx.font = 'bold 21px Sans'; ctx.fillText(`${medal} ${String(item.user.name || 'Jojo Member').slice(0,24)}`, 38, y); ctx.fillStyle = '#FFFFFF'; ctx.font = '18px Sans'; ctx.fillText(`Coins ${Number(item.user.coins)||0} • House ${getHouseValue(item.user.house)} • Net ${item.net}`, 60, y+29); y += 82; });
  const file = path.join(cacheDir, 'lb.png'); await fsExtra.writeFile(file, canvas.toBuffer('image/png')); return file;
}
// [ADDED] Messenger attachment upload for generated canvas images.
async function sendImage(id, imagePath, body) {
  if (!PAGE_TOKEN || !id) return false;
  try {
    const FormData = require('form-data'); const form = new FormData();
    form.append('recipient', JSON.stringify({ id }));
    form.append('message', JSON.stringify({ attachment: { type: 'image', payload: { is_reusable: false } } }));
    form.append('filedata', fs.createReadStream(imagePath), { contentType: 'image/png', filename: path.basename(imagePath) });
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`, form, { headers: form.getHeaders() });
    if (body) await send(id, body);
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
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`, {
      recipient: { id },
      sender_action: "typing_on"
    });

    await new Promise(resolve => setTimeout(resolve, 350));

    const body = { recipient: { id }, message: { text } };
    if (qr) body.message.quick_replies = qr;

    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`, body);
    return true;
  } catch (e) {
    console.error(`Messenger send failed (PSID: ${id}):`, e.response?.data?.error?.message || e.message);
    return false;
  }
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
    return res.data.data.attributes.checkout_url;
  } catch (e) {
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
  // Fail closed: never accept payment events if webhook verification is not configured.
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
    const paymentAttributes = eventAttributes.data?.attributes || eventAttributes;
    if (eventType && !['link.payment.paid', 'payment.paid'].includes(eventType)) {
      return res.sendStatus(200);
    }
    if (paymentAttributes.status !== 'paid') return res.sendStatus(200);

    const amountInPesos = Number(paymentAttributes.amount) / 100;
    if (!Number.isFinite(amountInPesos) || !Number.isInteger(amountInPesos)) {
      console.warn('PayMongo webhook ignored: invalid payment amount.');
      return res.sendStatus(400);
    }
    const coins = TOPUP_RATES[amountInPesos] || 0;
    const psid = String(paymentAttributes.remarks || '').trim();
    if (!coins || !/^\d{5,32}$/.test(psid)) {
      console.warn('PayMongo webhook ignored: unrecognized amount package or recipient.');
      return res.sendStatus(400);
    }

    // Reserve the event before applying credit. The unique MongoDB index blocks
    // concurrent duplicate deliveries; the in-memory set is only a local fallback.
    if (MONGODB_URI && mongoose.connection.readyState === 1) {
      try {
        await PaymentEventModel.create({ eventId: ev.id, status: 'processing', psid });
      } catch (error) {
        if (error.code === 11000) return res.sendStatus(200);
        throw error;
      }
    } else {
      if (processedPaymentEvents.has(ev.id)) return res.sendStatus(200);
      processedPaymentEvents.add(ev.id);
    }

    const user = await loadUserFromDB(psid);
    if (!user) {
      if (!MONGODB_URI || mongoose.connection.readyState !== 1) processedPaymentEvents.delete(ev.id);
      else await PaymentEventModel.deleteOne({ eventId: ev.id, status: 'processing' });
      return res.sendStatus(404);
    }

    const previousCoins = user.coins;
    user.coins = Number.isFinite(user.coins) && user.coins >= 0 ? user.coins + coins : coins;
    const saved = await saveUserToDB(psid);
    if (!saved) {
      user.coins = previousCoins;
      if (!MONGODB_URI || mongoose.connection.readyState !== 1) processedPaymentEvents.delete(ev.id);
      else await PaymentEventModel.deleteOne({ eventId: ev.id, status: 'processing' });
      return res.sendStatus(503);
    }
    if (MONGODB_URI && mongoose.connection.readyState === 1) {
      await PaymentEventModel.updateOne({ eventId: ev.id }, { $set: { status: 'processed' } });
    }
    try {
      await send(psid, `✅ PAYMENT SUCCESSFUL!\n💰 +${coins} Coins added to your account!\n💎 New Balance: ${user.coins} coins\n\nEnjoy JojoWorld V26! 🚀`);
    } catch (notifyError) {
      console.error('Payment credited but Messenger notification failed:', notifyError.message);
    }
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

  let releaseWebhookQueue;
  const previousWebhook = messengerWebhookQueue;
  messengerWebhookQueue = new Promise(resolve => { releaseWebhookQueue = resolve; });
  await previousWebhook;

  try {
    const body = req.body;
    if (!body || body.object !== 'page' || !Array.isArray(body.entry)) return res.sendStatus(200);

    for (const entry of body.entry) {
      for (const ev of (Array.isArray(entry.messaging) ? entry.messaging : [])) {
        if (!ev || !ev.sender || !ev.sender.id || (!ev.message && !ev.postback)) continue;
        const messageId = ev.message && ev.message.mid ? String(ev.message.mid) : null;
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

        // CHECK REFERRAL PARAMETER ON START
        let referralParam = null;
        if (ev.postback && ev.postback.referral) {
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

          // PROCESS REFERRAL REWARD
          if (referralParam && referralParam.startsWith("REF_")) {
            let referrerPsid = referralParam.replace("REF_", "");
            if (referrerPsid !== psid) {
              let referrer = await loadUserFromDB(referrerPsid);
              if (referrer) {
                const newUserSnapshot = JSON.parse(JSON.stringify(user));
                const referrerSnapshot = JSON.parse(JSON.stringify(referrer));
                const previousReferrerCoins = Number(referrer.coins);
                user.coins = (Number.isFinite(Number(user.coins)) ? Number(user.coins) : 0) + 50;
                referrer.coins = (Number.isFinite(previousReferrerCoins) && previousReferrerCoins >= 0 ? previousReferrerCoins : 0) + 100;
                referrer.refCount = (referrer.refCount || 0) + 1;
                const referralSaved = await saveUserPair(psid, referrerPsid);
                if (referralSaved) {
                  send(referrerPsid, `🎉 REFERRAL SUCCESS!
A new user joined using your link! 🎁
💰 +100 Coins credited to your wallet!`);
                } else {
                  db.users[psid] = newUserSnapshot;
                  db.users[referrerPsid] = referrerSnapshot;
                  user = db.users[psid];
                  send(psid, "⚠️ Hindi na-save ang referral reward. Hindi naibigay ang bonus; maaari ka pa ring magpatuloy.");
                }
              }
            }
          }

          await saveUserToDB(psid);
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
          send(psid, "⚠️ Hindi available ang database ngayon. Walang command na pinroseso; subukan ulit mamaya.");
          continue;
        }

        let rawText = "";
        if (ev.message && ev.message.quick_reply) rawText = ev.message.quick_reply.payload;
        else if (ev.message && ev.message.text) rawText = ev.message.text;
        else if (ev.postback && ev.postback.payload) rawText = ev.postback.payload;

        let cleanText = sanitizeInput(rawText);
        let upperRaw = rawText.toUpperCase();
        // [ADDED] [UPGRADED V28] V28 text commands. Existing command routing remains below.

        // ADMIN COMMAND SUITE
        if (psid === ADMIN_ID && upperRaw.startsWith("ADMIN_ADDCOINS_")) {
          let parts = upperRaw.replace("ADMIN_ADDCOINS_", "").split("_");
          const targetPsid = parts[0];
          const addAmt = parts[1] === undefined || parts[1] === "" ? 1000 : Number(parts[1]);
          if (!/^\d{5,32}$/.test(targetPsid) || !Number.isSafeInteger(addAmt) || addAmt < 1 || addAmt > 1000000) {
            send(psid, "❌ Invalid command. Use ADMIN_ADDCOINS_<PSID>_<positive amount up to 1000000>.");
            continue;
          }
          let targetUser = await loadUserFromDB(targetPsid);
          if (targetUser) {
            const previousCoins = Number(targetUser.coins);
            const safePreviousCoins = Number.isFinite(previousCoins) && previousCoins >= 0 ? previousCoins : 0;
            targetUser.coins = safePreviousCoins + addAmt;
            if (!await saveUserToDB(targetPsid)) {
              targetUser.coins = safePreviousCoins;
              send(psid, "❌ Coins were not added because the database save failed.");
              continue;
            }
            send(psid, `👑 [ADMIN] Added ${addAmt} coins to user ${targetPsid}.`);
          } else {
            send(psid, `❌ [ADMIN] User not found.`);
          }
          continue;
        }

        // [ADDED] V28 daily house tax check on incoming commands; save tax/downgrade changes.
        const houseTaxNotice = user ? checkHouseTax(user) : null;
        if (houseTaxNotice) { await saveUserToDB(psid, { saveJackpot: false }); send(psid, houseTaxNotice); }

        // [ADDED] [FIXED] V28 registration/name validation: "register Your Name".
        if (upperRaw.startsWith('REGISTER ')) {
          const cleanName = rawText.slice(9).replace(/[^\w\s]/gi, '').trim();
          if (cleanName.length < 3) { send(psid, '❌ Bawal emoji/symbols boss! Min 3 letters!'); continue; }
          if (user.registered === true) { send(psid, "❌ Registered ka na boss! Type 'profile'"); continue; }
          const old = { name: user.name, registered: user.registered };
          user.name = cleanName; user.registered = true; user.id = psid;
          if (!await saveUserToDB(psid)) { Object.assign(user, old); send(psid, '⚠️ Hindi na-save ang registration. Try ulit.'); continue; }
          send(psid, '✅ Registered ka na, boss! Type profile para makita ang profile mo.'); continue;
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
          if ((Number(user.coins)||0) < bet) { send(psid, `❌ Kulang coins! Need ${bet}c, meron ka lang ${user.coins}c.`); continue; }
          const snapshot = { coins:user.coins, lastScatter:user.lastScatter, scatterWins:user.scatterWins };
          const isWin = Math.random() < 0.30; user.coins = isWin ? user.coins - bet + Math.floor(bet*1.8) : user.coins - bet;
          user.lastScatter = Date.now(); if (isWin) user.scatterWins = (user.scatterWins||0)+1;
          if (!await saveUserToDB(psid)) { Object.assign(user,snapshot); send(psid,'⚠️ Hindi na-save ang scatter.'); continue; }
          send(psid, isWin ? `🎉 SCATTER WIN! +${Math.floor(bet*0.8)} net coins. Balance: ${user.coins}c` : `🎰 Scatter loss: -${bet}c. Balance: ${user.coins}c`); continue;
        }
        // [ADDED] V28 house purchase with prerequisite and duplicate checks before charging.
        if (upperRaw.trim().startsWith('BUY ')) {
          const parts = upperRaw.trim().split(/\s+/); const house = (parts[1]||'').toLowerCase(); const cfg = HOUSE_CONFIG[house];
          if (!cfg || house === 'none') { send(psid,'🏠 Use: buy kubo / bahay / mansion / building'); continue; }
          const required = HOUSE_REQUIREMENTS[house];
          if (String(user.house||'none').toLowerCase() === house) { send(psid,'❌ Meron ka na nyan boss!'); continue; }
          if (getHouseTier(user.house) + 1 !== cfg.tier || String(user.house||'none').toLowerCase() !== required) { send(psid,`❌ Requirement: ${required} muna bago ${house}.`); continue; }
          if ((Number(user.coins)||0) < cfg.price) { send(psid,`❌ Kulang coins! Need ${cfg.price}c, meron ka lang ${user.coins}c.`); continue; }
          const old = {coins:user.coins,house:user.house}; user.coins -= cfg.price; user.house=house;
          if (!await saveUserToDB(psid)) { Object.assign(user,old); send(psid,'⚠️ Hindi na-save ang house purchase. Walang coins na ikakaltas.'); continue; }
          send(psid,`🏠 Congratulations! Purchased ${house} for ${cfg.price}c. House value: ${cfg.value}c.`); continue;
        }
        // [ADDED] V28 flex effect purchase command, one active effect at a time.
        if (upperRaw.trim().startsWith('EFFECT ')) {
          const effect = upperRaw.trim().split(/\s+/)[1]?.toLowerCase(); const prices = {rainbow:5000,sparkle:10000,heart:2500,fire:2500,ice:2500,neon:3000,blossom:2000,dark:2500,red:1000,blue:1000,green:1000,yellow:1000};
          if (!FLEX_BADGES[effect]) { send(psid,'✨ Effects: rainbow, sparkle, heart, fire, ice, neon, blossom, dark, red, blue, green, yellow.'); continue; }
          if (user.nameEffect && user.nameEffect !== 'none') { send(psid,'❌ May effect ka na boss! Type unequip. Isa lang pwede!'); continue; }
          if (user.coins < prices[effect]) { send(psid,`❌ Kulang coins! Need ${prices[effect]}c, meron ka lang ${user.coins}c.`); continue; }
          const old = {coins:user.coins,nameEffect:user.nameEffect}; user.coins -= prices[effect]; user.nameEffect=effect;
          if (!await saveUserToDB(psid)) { Object.assign(user,old); send(psid,'⚠️ Hindi na-save ang effect.'); continue; }
          send(psid,`✨ Equipped ${FLEX_BADGES[effect]}! ${getDisplayName(user)}`); continue;
        }
        // [ADDED] V28 image commands. Existing textual profile command remains supported below.
        if (['ME','MY','PROFILE IMAGE'].includes(upperRaw.trim())) { user.views=(user.views||0)+1; if (!await saveUserToDB(psid)) { user.views--; send(psid,'⚠️ Hindi na-save ang profile view.'); continue; } const img=await generateProfileCanvas({...user,id:psid}); await sendImage(psid,img,`${getDisplayName(user)} • Black & Gold Profile`); continue; }
        if (['LB','TOP','LEADERBOARD IMAGE'].includes(upperRaw.trim())) { const img=await generateLeaderboardCanvas(db.users); await sendImage(psid,img,'🏆 JojoWorld V28 Top 10 Richest • Net Worth'); continue; }

        // ================= ACTIVE CHAT STATE LOOP (1-ON-1 RELAY) =================
        if (user.state === "CHATTING" && !upperRaw.startsWith("GIFT_") && upperRaw !== "SEND_GIFT_MENU") {
          if (upperRaw === "END_CHAT" || cleanText === "end chat") {
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

            send(psid, "🔴 Chat ended successfully.", [
              { content_type: "text", title: "💘 Find New Match", payload: "FIND MATCH" },
              { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
            ]);
            continue;
          }

          // Relay message to live paired partner if valid
          if (user.activeMatchPsid) {
            let partner = await loadUserFromDB(user.activeMatchPsid);
            if (partner && partner.state === "CHATTING") {
              try {
                const delivered = await send(user.activeMatchPsid, `💬 ${user.name}: ${rawText}`);
                if (!delivered) throw new Error("Messenger could not deliver the chat message");
                await send(psid, `✉️ Message sent!`, [{ content_type: "text", title: "🔴 End Chat", payload: "END_CHAT" }]);
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

        // MAIN MENU ROUTING
        if (cleanText === "menu" || upperRaw === "MENU") {
          user.state = "IDLE";
          user.activeMatchPsid = null;
          await saveUserToDB(psid);
          sendMenu(psid);
          continue;
        }

        // VIEW PROFILE
        if (["profile", "me", "my"].includes(cleanText) || ["PROFILE", "ME", "MY"].includes(upperRaw)) {
          // [UPGRADED V28] Keep legacy text profile command and include verified display name.
          user.views = (user.views || 0) + 1;
          await saveUserToDB(psid, { saveJackpot: false });
          // [ADDED] Canvas preview accompanies the legacy text profile to preserve old behavior.
          try { const profileImage = await generateProfileCanvas({ ...user, id: psid }); await sendImage(psid, profileImage, `${getDisplayName(user)} • Black Gold Profile`); } catch (canvasError) { console.error("Profile canvas generation failed:", canvasError.message); }
          const giftsReceived = user.giftsReceived && typeof user.giftsReceived === "object" ? user.giftsReceived : {};
          const giftEntries = Object.entries(giftsReceived)
            .filter(([, count]) => Number.isFinite(count) && count > 0);
          const totalGiftsReceived = giftEntries.reduce((total, [, count]) => total + count, 0);
          const giftSummary = giftEntries
            .map(([k, v]) => `${GIFTS[k]?.name || k} x${v}`)
            .join(" | ") || "None yet 🎁";

          send(psid, `👤 YOUR PROFILE & STATS (V26)
━━━━━━━━━━━━━━━━━━━━
📛 Name: ${user.name} (${user.age})
📍 Location: ${user.location}
♈ Zodiac: ${user.zodiac}
🎯 Goal: ${user.relationshipGoal}
💬 Bio: "${user.bio}"
💎 Coins: ${user.coins} | 👁️ Views: ${user.views}
🌟 Badge: ${user.badge} | 🖼️ Frame: ${user.frame}
🎁 Total Gifts Received: ${totalGiftsReceived}
🎁 Gifts Showcase: ${giftSummary}
🔗 Ref Link: https://m.me/${PAGE_USERNAME}?start=REF_${psid}

Choose an action below:`, [
            { content_type: "text", title: "✏️ Edit Profile", payload: "EDIT_PROFILE_MENU" },
            { content_type: "text", title: "♈ Set Zodiac", payload: "SET_ZODIAC_MENU" },
            { content_type: "text", title: "🎯 Set Goal", payload: "SET_GOAL_MENU" },
            { content_type: "text", title: "💰 Top Up", payload: "TOP UP" },
            { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
          ]);
          continue;
        }

        // EDIT PROFILE SUB-MENU
        if (upperRaw === "EDIT_PROFILE_MENU") {
          let editCostText = (user.profileEdits || 0) === 0 ? "FREE (1st Edit)" : "Costs 20 Coins";
          send(psid, `✏️ EDIT PROFILE MENU (${editCostText})\n━━━━━━━━━━━━━━━━━━━━\nSelect what you'd like to update:`, [
            { content_type: "text", title: "✏️ Name & Age", payload: "REQ_EDIT_NAME_AGE" },
            { content_type: "text", title: "📍 Location", payload: "REQ_EDIT_LOCATION" },
            { content_type: "text", title: "💬 Bio", payload: "REQ_EDIT_BIO" },
            { content_type: "text", title: "↩️ Profile", payload: "PROFILE" }
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
          user.zodiac = rawText.replace("ZODIAC_", "");
          await saveUserToDB(psid);
          send(psid, `✨ Zodiac set to **${user.zodiac}**!`, [{ content_type: "text", title: "👤 View Profile", payload: "PROFILE" }]);
          continue;
        }

        // RELATIONSHIP GOAL SELECTOR
        if (upperRaw === "SET_GOAL_MENU") {
          send(psid, `🎯 SELECT RELATIONSHIP GOAL:\n━━━━━━━━━━━━━━━━━━━━`, [
            { content_type: "text", title: "☕ Coffee Dates", payload: "GOAL_☕ Coffee Dates" },
            { content_type: "text", title: "💍 Serious Rel.", payload: "GOAL_💍 Serious Relationship" },
            { content_type: "text", title: "🎮 Gaming Buddy", payload: "GOAL_🎮 Gaming Buddy" },
            { content_type: "text", title: "✈️ Travel Buddy", payload: "GOAL_✈️ Travel Partner" }
          ]);
          continue;
        }

        if (upperRaw.startsWith("GOAL_")) {
          user.relationshipGoal = rawText.replace("GOAL_", "");
          await saveUserToDB(psid);
          send(psid, `🎯 Relationship goal updated to **${user.relationshipGoal}**!`, [{ content_type: "text", title: "👤 View Profile", payload: "PROFILE" }]);
          continue;
        }

        // FIND MATCH: only show a real, recently active account.
        if (cleanText === "find match" || upperRaw === "FIND MATCH") {
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
            send(psid, "😕 Wala pang available na active match ngayon. Walang coins na ikakaltas. Subukan ulit mamaya.", [
              { content_type: "text", title: "🔎 Search Again", payload: "FIND MATCH" },
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
          const candidateName = String(match.name || "Jojo Member").slice(0, 40);
          const candidateAge = Number.isFinite(Number(match.age)) ? Number(match.age) : "—";
          const candidateLocation = String(match.location || "Not set").slice(0, 50);
          const candidateBio = String(match.bio || "No bio yet.").slice(0, 180);
          send(psid, `💘 REAL MATCH FOUND (-10 coins)\\n━━━━━━━━━━━━━━━━━━━━\\n👤 ${candidateName}, ${candidateAge}\\n📍 ${candidateLocation}\\n💬 ${candidateBio}\\n\\nUnlock chat for 20 coins to connect.`, [
            { content_type: "text", title: "💬 Unlock Chat (20c)", payload: "UNLOCK_CHAT" },
            { content_type: "text", title: "⏭️ Next Match (10c)", payload: "FIND MATCH" },
            { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
          ]);
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
          user.coins -= 20;
          user.state = "CHATTING";
          user.activeMatchPsid = null;

          let partnerPsid = null;
          if (MONGODB_URI && mongoose.connection.readyState === 1) {
            try {
              // Atomically reserve an idle partner so two users cannot select the same row.
              const candidateFilter = {
                psid: user.pendingMatchPsid ? user.pendingMatchPsid : { $ne: psid },
                "data.state": "IDLE",
                "data.activeMatchPsid": null
              };
              if (!user.pendingMatchPsid) candidateFilter.psid = { $ne: psid };
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
            partnerPsid = user.pendingMatchPsid
              ? (db.users[user.pendingMatchPsid]?.state === "IDLE" && !db.users[user.pendingMatchPsid]?.activeMatchPsid ? user.pendingMatchPsid : null)
              : (Object.keys(db.users).find(pId =>
                  pId !== psid &&
                  db.users[pId]?.state === "IDLE" &&
                  !db.users[pId]?.activeMatchPsid &&
                  Number(db.users[pId]?.lastActive || 0) >= Date.now() - 15 * 60 * 1000
                ) || null);
          }

          if (!partnerPsid) {
            Object.assign(user, originalUser);
            user.pendingMatchPsid = null;
            await saveUserToDB(psid);
            send(psid, "😕 Wala pang available na totoong match ngayon. Walang coins na ikakaltas. Subukan ulit mamaya.", [
              { content_type: "text", title: "🔎 Find Match", payload: "FIND MATCH" },
              { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
            ]);
            continue;
          }

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
            send(psid, "⚠️ Hindi ma-confirm ang match. Walang coins na ikakaltas; subukan ulit mamaya.");
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
            send(psid, "⚠️ Hindi ma-save ang chat connection. Walang coins na ikakaltas; subukan ulit mamaya.");
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
            if (!await saveUserToDB(psid)) {
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
            if (!await saveUserToDB(psid)) {
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

        // SHOP & THEMES
        if (cleanText === "shop" || upperRaw === "SHOP") {
          send(psid, `🛍️ JOJOWORLD PROFILE SHOP\n━━━━━━━━━━━━━━━━━━━━\n[1] 👑 VIP Verified Badge - 200 coins\n[2] 💎 Gold Profile Frame - 150 coins`, [
            { content_type: "text", title: "👑 VIP Badge (200c)", payload: "BUY_VIP" },
            { content_type: "text", title: "💎 Gold Frame (150c)", payload: "BUY_FRAME" },
            { content_type: "text", title: "↩️ Menu", payload: "MENU" }
          ]);
          continue;
        }

        if (upperRaw === "BUY_VIP") {
          // [FIXED] Duplicate VIP validation happens before deducting coins.
          if (user.vip || user.badge === "👑 VIP Elite") { send(psid, "❌ Meron ka na VIP boss!"); continue; }
          if (user.coins < 200) {
            send(psid, `❌ Not enough coins! VIP Badge costs 200 coins.`);
          } else {
            const previousVipState = { coins: user.coins, badge: user.badge, vip: user.vip };
            user.coins -= 200;
            user.vip = true;
            user.badge = "👑 VIP Elite";
            if (!await saveUserToDB(psid)) {
              user.coins = previousVipState.coins;
              user.badge = previousVipState.badge;
              user.vip = previousVipState.vip;
              send(psid, "⚠️ Hindi na-save ang VIP purchase. Walang coins na ikakaltas.");
              continue;
            }
            send(psid, `🎉 SUCCESS! You are now a VIP Elite member! 👑`);
          }
          continue;
        }

        if (upperRaw === "BUY_FRAME") {
          // [FIXED] Duplicate gold-frame validation happens before deducting coins.
          if (user.goldFrame || String(user.frame || "").toLowerCase().includes("gold")) { send(psid, "❌ Meron ka na Gold Frame boss!"); continue; }
          if (user.coins < 150) {
            send(psid, `❌ Not enough coins! Gold Frame costs 150 coins.`);
          } else {
            const previousFrameState = { coins: user.coins, frame: user.frame, goldFrame: user.goldFrame };
            user.coins -= 150;
            user.goldFrame = true;
            user.frame = "💎 Gold Frame";
            if (!await saveUserToDB(psid)) {
              user.coins = previousFrameState.coins;
              user.frame = previousFrameState.frame;
              user.goldFrame = previousFrameState.goldFrame;
              send(psid, "⚠️ Hindi na-save ang frame purchase. Walang coins na ikakaltas.");
              continue;
            }
            send(psid, `🎉 SUCCESS! Gold Frame unlocked! 💎`);
          }
          continue;
        }

        // LEADERBOARD
        if (["leaderboard", "lb", "top"].includes(cleanText) || ["LEADERBOARD", "LB", "TOP"].includes(upperRaw)) {
          // [UPGRADED V28] Real leaderboard ordering by liquid coins + house value.
          const realTop = Object.entries(db.users).map(([id,u]) => ({id,u,net:getNetWorth(u)})).sort((a,b)=>b.net-a.net).slice(0,10);
          const realLines = realTop.map((x,i)=>`${["🥇","🥈","🥉"][i] || `#${i+1}`} ${getDisplayName(x.u)} — ${x.net} net worth`).join("\n");
          send(psid, `🏆 JOJOWORLD V28 LEADERBOARD\n━━━━━━━━━━━━━━━━━━━━\n🔥 Global Jackpot Pool: 🏆 ${db.jackpotPool} Coins\n\n${realLines || "No users yet"}`, [
            { content_type: "text", title: "🎰 Spin Scatter Slot", payload: "SPIN" },
            { content_type: "text", title: "💰 Top Up", payload: "TOP UP" },
            { content_type: "text", title: "↩️ Menu", payload: "MENU" }
          ]);
          continue;
        }

        // REFERRAL MESSENGER DIRECT LINK
        if (cleanText === "invite" || upperRaw === "INVITE") {
          let messengerLink = `https://m.me/${PAGE_USERNAME}?start=REF_${psid}`;
          send(psid, `🔗 REFERRAL & INVITE PROGRAM\n━━━━━━━━━━━━━━━━━━━━\n🎁 Share your unique Messenger link below to earn rewards!\n\n👇 Your Referral Link:\n${messengerLink}\n\n👥 Total Successful Invites: ${user.refCount || 0}\n💰 Earn +100 Coins for every friend who joins!`, [{ content_type: "text", title: "↩️ Menu", payload: "MENU" }]);
          continue;
        }

        // DEFAULT FALLBACK -> MAIN MENU
        sendMenu(psid);
      }
    }
  } catch (e) {
    console.error("Messenger webhook processing error:", e.message);
  } finally {
    releaseWebhookQueue();
  }
  res.sendStatus(200);
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
    metaAppSecret: Boolean(META_APP_SECRET),
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
