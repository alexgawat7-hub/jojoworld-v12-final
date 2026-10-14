// ============================================================================
// JOJOWORLD V24 ULTIMATE - MASTER CHECKLIST FIXED (ALL 8 POINTS INTEGRATED)
// ============================================================================
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const mongoose = require('mongoose');
const axios = require('axios');
const app = express();
app.use(bodyParser.json());

const ADMIN_ID = process.env.ADMIN_ID || "100064525073153";
const GCASH_NUM = process.env.GCASH_NUM || "09517080795";
const PAYMONGO_SECRET = process.env.PAYMONGO_SECRET;
const PAGE_TOKEN = process.env.PAGE_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "jojoworld_v24";
const MONGODB_URI = process.env.MONGODB_URI;

// PAGE NAME FOR MESSENGER LINK (Palitan ayon sa Facebook Page username)
const PAGE_USERNAME = process.env.PAGE_USERNAME || "Princelucky";

// ================= MONGODB SETUP =================
if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log("✅ MongoDB OK"))
    .catch(e => console.log("❌ MongoDB Error:", e.message));
}

const UserSchema = new mongoose.Schema({ psid: String, data: Object }, { strict: false });
const UserModel = mongoose.models.JUser || mongoose.model('JUser', UserSchema);

const JackpotSchema = new mongoose.Schema({ id: String, amount: Number }, { strict: false });
const JackpotModel = mongoose.models.JJackpot || mongoose.model('JJackpot', JackpotSchema);

let db = { users: {}, jackpotPool: 1000 };

if (fs.existsSync('./db.json')) {
  try {
    const localDb = JSON.parse(fs.readFileSync('./db.json'));
    if (localDb.users) db.users = localDb.users;
    if (localDb.jackpotPool) db.jackpotPool = localDb.jackpotPool;
  } catch (e) {}
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
  try {
    fs.writeFileSync('./db.json', JSON.stringify(db, null, 2));
  } catch (e) {}

  if (MONGODB_URI && mongoose.connection.readyState === 1) {
    try {
      if (db.users[psid]) {
        await UserModel.findOneAndUpdate(
          { psid },
          { psid, data: db.users[psid] },
          { upsert: true, new: true }
        );
      }
      await JackpotModel.findOneAndUpdate(
        { id: "global" },
        { id: "global", amount: db.jackpotPool },
        { upsert: true }
      );
    } catch (e) {
      console.log("Error saving DB:", e.message);
    }
  }
}

const TOPUP_RATES = { 20: 120, 50: 300, 80: 500, 100: 700, 200: 1600, 500: 4500 };

// GIFTS CONFIG
const GIFTS = {
  ROSE: { name: "🌹 Red Rose", cost: 10, bonus: 5 },
  COFFEE: { name: "☕ Coffee Cup", cost: 25, bonus: 12 },
  BEAR: { name: "🧸 Teddy Bear", cost: 50, bonus: 25 },
  RING: { name: "💍 Diamond Ring", cost: 100, bonus: 50 },
  CAR: { name: "🏎️ Sports Car", cost: 300, bonus: 150 }
};

// INSTANT REPLY WITH TYPING INDICATOR
async function send(id, text, qr = null) {
  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`, {
      recipient: { id },
      sender_action: "typing_on"
    });
  } catch (e) {}

  setTimeout(async () => {
    const body = { recipient: { id }, message: { text } };
    if (qr) body.message.quick_replies = qr;
    try {
      await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`, body);
    } catch (e) {}
  }, 300);
}

function sanitizeInput(text) {
  if (!text) return "";
  let clean = text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '');
  clean = clean.toLowerCase().trim();

  if (["1", "isa", "one", "uno", "menu", "main menu"].some(x => clean === x)) return "MENU";
  if (["2", "dalawa", "two", "dos", "profile"].some(x => clean === x)) return "PROFILE";
  if (["3", "tatlo", "three", "tres", "find match"].some(x => clean === x)) return "FIND MATCH";
  if (["4", "apat", "four", "cuatro", "top up"].some(x => clean === x)) return "TOP UP";
  if (["5", "lima", "five", "cinco", "daily"].some(x => clean === x)) return "DAILY";
  if (["6", "anim", "six", "spin"].some(x => clean === x)) return "SPIN";
  if (["7", "pito", "seven", "shop"].some(x => clean === x)) return "SHOP";
  if (["8", "walo", "eight", "leaderboard"].some(x => clean === x)) return "LEADERBOARD";
  if (["9", "siyam", "nine", "referral", "invite"].some(x => clean === x)) return "INVITE";

  return clean;
}

async function createPaymongoLink(amount, coins, psid) {
  try {
    const res = await axios.post('https://api.paymongo.com/v1/links', {
      data: { attributes: { amount: amount * 100, description: `${coins} Coins JojoWorld`, remarks: psid.toString() } }
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
  send(id, `✨ JOJOWORLD V24 ULTIMATE ✨
━━━━━━━━━━━━━━━━━━━━
🔥 LIMITED TIME: +20% Bonus Coins
💘 Find match & connect worldwide
🎁 Daily bonuses & Spin rewards

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

app.post('/paymongo-webhook', async (req, res) => {
  try {
    const ev = req.body.data;
    if (!ev) return res.sendStatus(200);
    const attr = ev.attributes?.data?.attributes || ev.attributes;
    if (attr.status === 'paid' && attr.remarks) {
      let amt = Math.round(attr.amount / 100);
      let coins = TOPUP_RATES[amt] || 0;
      let psid = attr.remarks;

      let user = await loadUserFromDB(psid);
      if (coins > 0 && user) {
        user.coins = (user.coins || 0) + coins;
        await saveUserToDB(psid);
        await send(psid, `✅ PAYMENT SUCCESSFUL!\n💰 +${coins} Coins added to your account!\n💎 New Balance: ${user.coins} coins\n\nEnjoy JojoWorld! 🚀`);
      }
    }
  } catch (e) {}
  res.sendStatus(200);
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

        // LOAD FRESH DATA FROM MONGODB (CHECKLIST POINT #2)
        let user = await loadUserFromDB(psid);

        if (!user) {
          db.users[psid] = {
            coins: 150,
            location: "Manila",
            rating: 5.0,
            bio: "Hello JojoWorld!",
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
                user.coins += 50; // Bonus for new user
                referrer.coins += 100; // Reward for referrer
                referrer.refCount = (referrer.refCount || 0) + 1;
                await saveUserToDB(referrerPsid);
                send(referrerPsid, `🎉 REFERRAL SUCCESS!\nA new user joined using your link! 🎁\n💰 +100 Coins credited to your wallet!`);
              }
            }
          }
        }

        user.lastActive = Date.now();

        let rawText = "";
        if (ev.message && ev.message.quick_reply) rawText = ev.message.quick_reply.payload;
        else if (ev.message && ev.message.text) rawText = ev.message.text;
        else if (ev.postback && ev.postback.payload) rawText = ev.postback.payload;

        let cleanText = sanitizeInput(rawText);
        let upperRaw = rawText.toUpperCase();

        // -------------------------------------------------------------
        // ACTIVE CHAT STATE LOOP FIX (CHECKLIST POINT #3)
        // -------------------------------------------------------------
        if (user.state === "CHATTING") {
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
                send(partnerPsid, `🔴 The active chat session has been ended by your match.`, [
                  { content_type: "text", title: "💘 Find New Match", payload: "FIND MATCH" },
                  { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
                ]);
              }
            }
            send(psid, `🔴 Chat ended successfully.`, [
              { content_type: "text", title: "💘 Find New Match", payload: "FIND MATCH" },
              { content_type: "text", title: "↩️ Main Menu", payload: "MENU" }
            ]);
            continue;
          }

          // Forward chat message if matched with live user
          if (user.activeMatchPsid) {
            send(user.activeMatchPsid, `💬 Match: ${rawText}`);
            send(psid, `✉️ Message sent!`, [{ content_type: "text", title: "🔴 End Chat", payload: "END_CHAT" }]);
          } else {
            send(psid, `💬 Match Reply: "That sounds awesome! Tell me more 😊"`, [
              { content_type: "text", title: "🎁 Send Gift", payload: "SEND_GIFT_MENU" },
              { content_type: "text", title: "🔴 End Chat", payload: "END_CHAT" }
            ]);
          }
          await saveUserToDB(psid);
          continue;
        }

        // -------------------------------------------------------------
        // PROFILE EDITING HANDLERS (CHECKLIST POINT #4)
        // -------------------------------------------------------------
        if (user.state === "EDIT_NAME_AGE") {
          let parts = rawText.split(",");
          if (parts.length < 2 || isNaN(parts[1].trim())) {
            send(psid, `⚠️ Invalid format! Please type Name and Age separated by a comma.\nExample: *Juan, 24*`);
            continue;
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

        // -------------------------------------------------------------
        // MAIN MENU ROUTING
        // -------------------------------------------------------------
        if (cleanText === "menu" || cleanText === "start" || upperRaw === "MENU") {
          user.state = "IDLE";
          await saveUserToDB(psid);
          sendMenu(psid);
          continue;
        }

        // VIEW PROFILE
        if (cleanText === "profile" || cleanText === "1" || upperRaw === "PROFILE") {
          let giftSummary = Object.entries(user.giftsReceived || {})
            .map(([k, v]) => `${GIFTS[k]?.name || k} x${v}`)
            .join(" | ") || "None yet 🎁";

          send(psid, `👤 YOUR PROFILE & STATS
━━━━━━━━━━━━━━━━━━━━
📛 Name: ${user.name} (${user.age})
📍 Location: ${user.location}
♈ Zodiac: ${user.zodiac}
🎯 Goal: ${user.relationshipGoal}
💬 Bio: "${user.bio}"
💎 Coins: ${user.coins} | 👁️ Views: ${user.views}
🌟 Badge: ${user.badge} | 🖼️ Frame: ${user.frame}
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

        // EDIT PROFILE SUB-MENU (CHECKLIST POINT #4)
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

        // CHECK EDIT ECONOMY RULE
        if (upperRaw.startsWith("REQ_EDIT_")) {
          if ((user.profileEdits || 0) > 0 && user.coins < 20) {
            send(psid, `❌ Insufficient coins! Subsequent profile edits cost 20 coins.`, [
              { content_type: "text", title: "💰 Top Up", payload: "TOP UP" }
            ]);
            continue;
          }

          if ((user.profileEdits || 0) > 0) {
            user.coins -= 20;
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

        // ZODIAC SELECTOR (CHECKLIST POINT #5)
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

        // RELATIONSHIP GOAL SELECTOR (CHECKLIST POINT #5)
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
        if (cleanText === "find match" || cleanText === "2" || upperRaw === "FIND MATCH") {
          if (user.coins < 10) {
            send(psid, `❌ Insufficient coins! Searching costs 10 coins.`, [{ content_type: "text", title: "💰 Top Up", payload: "TOP UP" }]);
            continue;
          }
          user.coins -= 10;
          await saveUserToDB(psid);

          send(psid, `💘 DISCOVER MATCH NEARBY (-10 coins)
━━━━━━━━━━━━━━━━━━━━
👩 Sarah, 22 • 0.8km away (🟢 Online)
📍 Manila • ♈ Zodiac: ♌ Leo
🎯 Goal: ☕ Coffee Dates
💬 "Looking for awesome friends and coffee dates!"`, [
            { content_type: "text", title: "❤️ Like", payload: "LIKE" },
            { content_type: "text", title: "🎁 Send Gift", payload: "SEND_GIFT_MENU" },
            { content_type: "text", title: "💬 Unlock Chat (20c)", payload: "UNLOCK_CHAT" },
            { content_type: "text", title: "⏭️ Next Match (10c)", payload: "FIND MATCH" }
          ]);
          continue;
        }

        // GIFTING SYSTEM (CHECKLIST POINT #6)
        if (upperRaw === "SEND_GIFT_MENU") {
          send(psid, `🎁 SELECT A GIFT TO SEND:
━━━━━━━━━━━━━━━━━━━━
🌹 Red Rose - 10c (+5c bonus to receiver)
☕ Coffee Cup - 25c (+12c bonus to receiver)
🧸 Teddy Bear - 50c (+25c bonus to receiver)
💍 Diamond Ring - 100c (+50c bonus to receiver)
🏎️ Sports Car - 300c (+150c bonus to receiver)`, [
            { content_type: "text", title: "🌹 Rose (10c)", payload: "GIFT_ROSE" },
            { content_type: "text", title: "☕ Coffee (25c)", payload: "GIFT_COFFEE" },
            { content_type: "text", title: "🧸 Bear (50c)", payload: "GIFT_BEAR" },
            { content_type: "text", title: "💍 Ring (100c)", payload: "GIFT_RING" },
            { content_type: "text", title: "🏎️ Car (300c)", payload: "GIFT_CAR" }
          ]);
          continue;
        }

        if (upperRaw.startsWith("GIFT_")) {
          let giftKey = upperRaw.replace("GIFT_", "");
          let gift = GIFTS[giftKey];

          if (!gift) continue;
          if (user.coins < gift.cost) {
            send(psid, `❌ Insufficient coins to send ${gift.name}!`, [{ content_type: "text", title: "💰 Top Up", payload: "TOP UP" }]);
            continue;
          }

          user.coins -= gift.cost;
          if (!user.giftsReceived) user.giftsReceived = {};
          user.giftsReceived[giftKey] = (user.giftsReceived[giftKey] || 0) + 1;
          user.giftsCount = (user.giftsCount || 0) + 1;
          await saveUserToDB(psid);

          send(psid, `🎉 GIFT SENT! You sent ${gift.name}! Your match appreciated it so much! ❤️`, [
            { content_type: "text", title: "💬 Unlock Chat (20c)", payload: "UNLOCK_CHAT" },
            { content_type: "text", title: "↩️ Menu", payload: "MENU" }
          ]);
          continue;
        }

        // UNLOCK CHAT
        if (upperRaw === "UNLOCK_CHAT" || cleanText === "unlock_chat") {
          if (user.coins < 20) {
            send(psid, `❌ Unlocking chat costs 20 coins.`, [{ content_type: "text", title: "💰 Top Up", payload: "TOP UP" }]);
            continue;
          }
          user.coins -= 20;
          user.state = "CHATTING"; // SET CHATTING STATE (CHECKLIST POINT #3)
          await saveUserToDB(psid);

          send(psid, `🔓 CHAT UNLOCKED! You are now connected with your match!\n\n💬 Type your message below to start chatting:`, [
            { content_type: "text", title: "🎁 Send Gift", payload: "SEND_GIFT_MENU" },
            { content_type: "text", title: "🔴 End Chat", payload: "END_CHAT" }
          ]);
          continue;
        }

        // SCATTER SLOT WHEEL OF FORTUNE (CHECKLIST POINT #7 & #8)
        if (cleanText === "spin" || cleanText === "5" || upperRaw === "SPIN") {
          if (user.coins < 10) {
            send(psid, `❌ Spin costs 10 coins! Balance: ${user.coins} coins.`, [{ content_type: "text", title: "💰 Top Up", payload: "TOP UP" }]);
            continue;
          }

          user.coins -= 10;
          db.jackpotPool += 3; // Add 3 coins to progressive jackpot pool

          let combos = [
            { visual: "💥 [ 💣 | ❌ | 💣 ]", win: 0, text: "Zonk! Better luck next time!" },
            { visual: "🪙 [ 🪙 | 🪙 | 🎁 ]", win: 15, text: "Small Win! +15 Coins!" },
            { visual: "💎 [ 💎 | 💎 | 💎 ]", win: 50, text: "BIG WIN! Multiplier +50 Coins!" },
            { visual: "👑 [ 👑 | 👑 | 👑 ]", win: db.jackpotPool, text: "🎉 GRAND JACKPOT WINNER!" }
          ];

          let rand = Math.random();
          let result = combos[0];
          if (rand < 0.02) {
            result = combos[3]; // Jackpot 2% chance
          } else if (rand < 0.20) {
            result = combos[2]; // Big Win 18% chance
          } else if (rand < 0.55) {
            result = combos[1]; // Small Win 35% chance
          }

          if (result.visual.includes("👑")) {
            user.coins += db.jackpotPool;
            let wonJackpot = db.jackpotPool;
            db.jackpotPool = 1000; // Reset Jackpot
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
        if (cleanText === "top up" || cleanText === "4" || upperRaw === "TOP UP") {
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
            send(psid, `❌ Gateway error. Direct manual GCash transfer to admin: ${GCASH_NUM}`);
          }
          continue;
        }

        // DAILY BONUS
        if (cleanText === "daily" || cleanText === "4" || upperRaw === "DAILY") {
          let now = Date.now();
          if (now - user.lastDaily < 86400000) {
            let hoursLeft = Math.ceil((86400000 - (now - user.lastDaily)) / 3600000);
            send(psid, `🎁 Daily bonus already claimed! Come back in ${hoursLeft} hours.`, [{ content_type: "text", title: "↩️ Menu", payload: "MENU" }]);
          } else {
            user.coins += 25;
            user.lastDaily = now;
            await saveUserToDB(psid);
            send(psid, `🎁 DAILY REWARD CLAIMED!\n💰 +25 Coins added!\n💎 Balance: ${user.coins} coins`, [
              { content_type: "text", title: "🎡 Scatter Spin", payload: "SPIN" },
              { content_type: "text", title: "↩️ Menu", payload: "MENU" }
            ]);
          }
          continue;
        }

        // SHOP & THEMES
        if (cleanText === "shop" || cleanText === "6" || upperRaw === "SHOP") {
          send(psid, `🛍️ JOJOWORLD PROFILE SHOP
━━━━━━━━━━━━━━━━━━━━
[1] 👑 VIP Verified Badge - 200 coins
[2] 💎 Gold Profile Frame - 150 coins`, [
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
        if (cleanText === "leaderboard" || cleanText === "7" || upperRaw === "LEADERBOARD") {
          send(psid, `🏆 JOJOWORLD LEADERBOARD
━━━━━━━━━━━━━━━━━━━━
🔥 Global Jackpot Pool: 🏆 ${db.jackpotPool} Coins

🥇 1. Jojo_Master — 4,850 coins
🥈 2. You (${user.name}) — ${user.coins} coins`, [
            { content_type: "text", title: "🎰 Spin Scatter Slot", payload: "SPIN" },
            { content_type: "text", title: "💰 Top Up", payload: "TOP UP" },
            { content_type: "text", title: "↩️ Menu", payload: "MENU" }
          ]);
          continue;
        }

        // REFERRAL MESSENGER DIRECT LINK (CHECKLIST POINT #1)
        if (cleanText === "invite" || cleanText === "8" || upperRaw === "INVITE") {
          let messengerLink = `https://m.me/${PAGE_USERNAME}?start=REF_${psid}`;
          send(psid, `🔗 REFERRAL & INVITE PROGRAM
━━━━━━━━━━━━━━━━━━━━
🎁 Share your unique Messenger link below to earn rewards!

👇 Your Referral Link:
${messengerLink}

👥 Total Successful Invites: ${user.refCount || 0}
💰 Earn +100 Coins for every friend who joins!`, [{ content_type: "text", title: "↩️ Menu", payload: "MENU" }]);
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

app.get('/', (req, res) => res.send('JojoWorld V24 ULTIMATE Running - All 8 Checklist Points Live!'));
app.listen(process.env.PORT || 10000, () => console.log("V24 Ultimate Server Running"));
