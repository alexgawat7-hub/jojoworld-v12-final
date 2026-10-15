// ============================================================================
// JOJOWORLD V26 ULTIMATE EVOLUTION - MESSENGER BOT
// ============================================================================
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const mongoose = require('mongoose');
const axios = require('axios');
const { verifyPayMongoSignature } = require('./v26/src/security/paymongo');
const { GIFT_CATALOG, GiftHubError, sendGift: applyGift, renderGiftCatalog } = require('./v26/src/services/gifts');

const app = express();

// Body-parser rawBody configuration para sa PayMongo Webhook HMAC signature
app.use(bodyParser.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

const ADMIN_ID = process.env.ADMIN_ID;
const GCASH_NUM = process.env.GCASH_NUM;
const PAYMONGO_SECRET = process.env.PAYMONGO_SECRET;
const PAYMONGO_WEBHOOK_SECRET = process.env.PAYMONGO_WEBHOOK_SECRET;
const PAGE_TOKEN = process.env.PAGE_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;

// PAGE NAME FOR MESSENGER LINK
const PAGE_USERNAME = process.env.PAGE_USERNAME || "Princelucky";

const UserSchema = new mongoose.Schema({ psid: String, data: Object }, { strict: false });
const UserModel = mongoose.models.JUser || mongoose.model('JUser', UserSchema);

const JackpotSchema = new mongoose.Schema({ id: String, amount: Number }, { strict: false });
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

let db = { users: {}, jackpotPool: 1500 };

if (fs.existsSync('./db.json')) {
  try {
    const localDb = JSON.parse(fs.readFileSync('./db.json'));
    if (localDb.users) db.users = localDb.users;
    if (localDb.jackpotPool) db.jackpotPool = localDb.jackpotPool;
  } catch (e) {}
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

async function saveUserToDB(psid) {
  // If MongoDB was configured, do not silently pretend a disconnected database saved data.
  if (MONGODB_URI) {
    if (mongoose.connection.readyState !== 1) {
      console.error("Database save skipped: MongoDB is configured but not connected.");
      return false;
    }
    try {
      await JackpotModel.findOneAndUpdate(
        { id: "global" },
        { $set: { id: "global", amount: db.jackpotPool } },
        { upsert: true, runValidators: true }
      );
      if (db.users[psid]) {
        await UserModel.findOneAndUpdate(
          { psid },
          { $set: { psid, data: db.users[psid] } },
          { upsert: true, new: true, runValidators: true }
        );
      }
    } catch (e) {
      console.error("Error saving MongoDB data:", e.message);
      return false;
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

// Persist both sides of a gift transfer together to prevent one-sided wallet updates.
async function saveGiftTransfer(senderPsid, recipientPsid) {
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

// ASYNC SAFE SEND FUNCTION WITH TYPING INDICATOR
async function send(id, text, qr = null) {
  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`, {
      recipient: { id },
      sender_action: "typing_on"
    });
    
    await new Promise(resolve => setTimeout(resolve, 350));

    const body = { recipient: { id }, message: { text } };
    if (qr) body.message.quick_replies = qr;
    
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`, body);
  } catch (e) {
    console.log(`❌ Send Error (PSID: ${id}):`, e.response?.data?.error?.message || e.message);
    throw e;
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
  if (!PAYMONGO_SECRET || !PAYMONGO_WEBHOOK_SECRET) return null;
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
  send(id, `✨ JOJOWORLD V25 ULTIMATE ✨
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
  try {
    const body = req.body;
    if (body.object !== 'page') return res.sendStatus(200);

    for (const entry of body.entry) {
      for (const ev of entry.messaging) {
        const psid = ev.sender.id;

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
            coins: 200,
            location: "Manila",
            rating: 5.0,
            bio: "Hello JojoWorld V25!",
            age: 21,
            gender: "Not set",
            name: "Jojo Member",
            created: Date.now(),
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
            relationshipGoal: "☕ Coffee Dates",
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
                user.coins += 50; 
                referrer.coins += 100; 
                referrer.refCount = (referrer.refCount || 0) + 1;
                await saveUserToDB(referrerPsid);
                send(referrerPsid, `🎉 REFERRAL SUCCESS!\nA new user joined using your link! 🎁\n💰 +100 Coins credited to your wallet!`);
              }
            }
          }

          await saveUserToDB(psid);
        }

        user.lastActive = Date.now();

        let rawText = "";
        if (ev.message && ev.message.quick_reply) rawText = ev.message.quick_reply.payload;
        else if (ev.message && ev.message.text) rawText = ev.message.text;
        else if (ev.postback && ev.postback.payload) rawText = ev.postback.payload;

        let cleanText = sanitizeInput(rawText);
        let upperRaw = rawText.toUpperCase();

        // ADMIN COMMAND SUITE
        if (psid === ADMIN_ID && upperRaw.startsWith("ADMIN_ADDCOINS_")) {
          let parts = upperRaw.replace("ADMIN_ADDCOINS_", "").split("_");
          let targetPsid = parts[0];
          let addAmt = parseInt(parts[1]) || 1000;
          let targetUser = await loadUserFromDB(targetPsid);
          if (targetUser) {
            targetUser.coins += addAmt;
            await saveUserToDB(targetPsid);
            send(psid, `👑 [ADMIN] Added ${addAmt} coins to user ${targetPsid}.`);
          } else {
            send(psid, `❌ [ADMIN] User not found.`);
          }
          continue;
        }

        // ================= ACTIVE CHAT STATE LOOP (1-ON-1 RELAY) =================
        if (user.state === "CHATTING" && !upperRaw.startsWith("GIFT_") && upperRaw !== "SEND_GIFT_MENU") {
          if (upperRaw === "END_CHAT" || cleanText === "end chat") {
            let partnerPsid = user.activeMatchPsid;
            user.state = "IDLE";
            user.activeMatchPsid = null;
            await saveUserToDB(psid);

            if (partnerPsid) {
              let partner = await loadUserFromDB(partnerPsid);
              if (partner) {
                partner.state = "IDLE";
                partner.activeMatchPsid = null;
                await saveUserToDB(partnerPsid);
                try {
                  send(partnerPsid, `🔴 The active chat session has been ended by your match.`, [
                    { content_type: "text", title: "💘 Find New Match", payload: "FIND MATCH" },
                    { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
                  ]);
                } catch(e) {}
              }
            }
            send(psid, `🔴 Chat ended successfully.`, [
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
                await send(user.activeMatchPsid, `💬 ${user.name}: ${rawText}`);
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
          let parts = rawText.split(",");
          if (parts.length < 2 || isNaN(parts[1].trim())) {
            send(psid, `⚠️ Invalid format! Please type Name and Age separated by a comma.\nExample: *Juan, 24*`);
            continue;
          }

          if ((user.profileEdits || 0) > 0) {
            user.coins -= 20;
          }

          user.name = parts[0].trim();
          user.age = parseInt(parts[1].trim());
          user.state = "IDLE";
          user.profileEdits = (user.profileEdits || 0) + 1;
          await saveUserToDB(psid);
          send(psid, `✅ Profile Name & Age updated to **${user.name}, ${user.age}**!`, [
            { content_type: "text", title: "👤 View Profile", payload: "PROFILE" },
            { content_type: "text", title: "↩️ Menu", payload: "MENU" }
          ]);
          continue;
        }

        if (user.state === "EDIT_LOCATION") {
          if ((user.profileEdits || 0) > 0) {
            user.coins -= 20;
          }

          user.location = rawText.trim();
          user.state = "IDLE";
          user.profileEdits = (user.profileEdits || 0) + 1;
          await saveUserToDB(psid);
          send(psid, `✅ Location updated to **${user.location}**!`, [
            { content_type: "text", title: "👤 View Profile", payload: "PROFILE" },
            { content_type: "text", title: "↩️ Menu", payload: "MENU" }
          ]);
          continue;
        }

        if (user.state === "EDIT_BIO") {
          if ((user.profileEdits || 0) > 0) {
            user.coins -= 20;
          }

          user.bio = rawText.trim();
          user.state = "IDLE";
          user.profileEdits = (user.profileEdits || 0) + 1;
          await saveUserToDB(psid);
          send(psid, `✅ Bio updated successfully!\n💬 "${user.bio}"`, [
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
        if (cleanText === "profile" || upperRaw === "PROFILE") {
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

        // FIND MATCH
        if (cleanText === "find match" || upperRaw === "FIND MATCH") {
          if (user.coins < 10) {
            send(psid, `❌ Insufficient coins! Searching costs 10 coins.`, [{ content_type: "text", title: "💰 Top Up", payload: "TOP UP" }]);
            continue;
          }
          user.coins -= 10;
          await saveUserToDB(psid);

          send(psid, `💘 DISCOVER MATCH NEARBY (-10 coins)
━━━━━━━━━━━━━━━━━━━━
👩 Princess, 21 • 0.5km away (🟢 Online)
📍 Manila • ♈ Zodiac: ♎ Libra
🎯 Goal: ☕ Coffee Dates
💬 "Looking for meaningful conversations and good coffee!"`, [
            { content_type: "text", title: "❤️ Like", payload: "LIKE" },
            { content_type: "text", title: "🎁 Send Gift", payload: "SEND_GIFT_MENU" },
            { content_type: "text", title: "💬 Unlock Chat (20c)", payload: "UNLOCK_CHAT" },
            { content_type: "text", title: "⏭️ Next Match (10c)", payload: "FIND MATCH" }
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
          const giftSaved = await saveGiftTransfer(psid, recipientPsid);
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
              const matchDoc = await UserModel.findOneAndUpdate(
                { psid: { $ne: psid }, "data.state": "IDLE" },
                { $set: { "data.state": "CHATTING", "data.activeMatchPsid": psid } },
                { new: true }
              );
              if (matchDoc) partnerPsid = matchDoc.psid;
            } catch (e) {
              console.error("Matchmaking query error:", e.message);
            }
          } else if (!MONGODB_URI) {
            partnerPsid = Object.keys(db.users).find(pId =>
              pId !== psid && db.users[pId]?.state === "IDLE"
            ) || null;
          }

          if (!partnerPsid) {
            Object.assign(user, originalUser);
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
            if (partner) {
              partner.state = "IDLE";
              partner.activeMatchPsid = null;
              await saveUserToDB(partnerPsid);
            }
            await saveUserToDB(psid);
            send(psid, "⚠️ Hindi ma-confirm ang match. Walang coins na ikakaltas; subukan ulit mamaya.");
            continue;
          }

          user.activeMatchPsid = partnerPsid;
          partner.activeMatchPsid = psid;
          partner.state = "CHATTING";

          const userSaved = await saveUserToDB(psid);
          const partnerSaved = await saveUserToDB(partnerPsid);
          if (!userSaved || !partnerSaved) {
            Object.assign(user, originalUser);
            partner.state = "IDLE";
            partner.activeMatchPsid = null;
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
            await saveUserToDB(psid);

            send(psid, `🎰 SCATTER SPIN WHEEL 🎰\n━━━━━━━━━━━━━━━━━━━━\n${result.visual}\n\n🏆 UNBELIEVABLE! YOU WON THE JACKPOT OF ${wonJackpot} COINS!\n💎 Balance: ${user.coins} coins`, [
              { content_type: "text", title: "🎰 Spin Again (-10c)", payload: "SPIN" },
              { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
            ]);
          } else {
            user.coins += result.win;
            await saveUserToDB(psid);

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
          let amt = parseInt(upperRaw.split(" ").pop());
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
            user.coins += 35;
            user.lastDaily = now;
            await saveUserToDB(psid);
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
          if (user.coins < 200) {
            send(psid, `❌ Not enough coins! VIP Badge costs 200 coins.`);
          } else {
            user.coins -= 200;
            user.badge = "👑 VIP Elite";
            await saveUserToDB(psid);
            send(psid, `🎉 SUCCESS! You are now a VIP Elite member! 👑`);
          }
          continue;
        }

        if (upperRaw === "BUY_FRAME") {
          if (user.coins < 150) {
            send(psid, `❌ Not enough coins! Gold Frame costs 150 coins.`);
          } else {
            user.coins -= 150;
            user.frame = "💎 Gold Frame";
            await saveUserToDB(psid);
            send(psid, `🎉 SUCCESS! Gold Frame unlocked! 💎`);
          }
          continue;
        }

        // LEADERBOARD
        if (cleanText === "leaderboard" || upperRaw === "LEADERBOARD") {
          send(psid, `🏆 JOJOWORLD V25 LEADERBOARD\n━━━━━━━━━━━━━━━━━━━━\n🔥 Global Jackpot Pool: 🏆 ${db.jackpotPool} Coins\n\n🥇 1. Jojo_Master — 5,200 coins\n🥈 2. Elite_Prenz — 4,100 coins\n🥉 3. You (${user.name}) — ${user.coins} coins`, [
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
    console.log("Webhook error:", e.message);
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
    paymongoSecret: Boolean(PAYMONGO_SECRET),
    paymongoWebhookSecret: Boolean(PAYMONGO_WEBHOOK_SECRET)
  };
  const messengerReady = checks.pageToken && checks.verifyToken;
  const paymentsReady = checks.paymongoSecret && checks.paymongoWebhookSecret;
  res.status(messengerReady ? 200 : 503).json({
    status: messengerReady ? 'ready' : 'needs_configuration',
    messengerReady,
    paymentsReady,
    persistentStorageConfigured: checks.mongodb,
    checks
  });
});

app.listen(process.env.PORT || 10000, () => console.log("JojoWorld V26 Ultimate Evolution server listening on port " + (process.env.PORT || 10000)));
