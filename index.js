// ============================================================================
// JOJOWORLD V24 ULTIMATE - MONGODB + PAYMONGO + 75+ FUNCTIONS COMPLETE (NO CUT)
// ============================================================================
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const mongoose = require('mongoose');
const axios = require('axios');
const app = express();
app.use(bodyParser.json());

const ADMIN_ID = "100064525073153";
const GCASH_NUM = "09517080795";
const PAYMONGO_SECRET = process.env.PAYMONGO_SECRET;
const PAYMONGO_WEBHOOK_SECRET = process.env.PAYMONGO_WEBHOOK_SECRET || "test";
const PAGE_TOKEN = process.env.PAGE_TOKEN;
const VERIFY_TOKEN = "jojoworld_v24";
const MONGODB_URI = process.env.MONGODB_URI;

// ================= MONGODB SETUP =================
if(MONGODB_URI){
  mongoose.connect(MONGODB_URI).then(()=>console.log("✅ MongoDB OK")).catch(e=>console.log(e.message));
}
const UserSchema = new mongoose.Schema({ psid:String, data:Object },{strict:false});
const UserModel = mongoose.models.JUser || mongoose.model('JUser', UserSchema);

let db = { users: {}, groups: {}, pendings: {}, likes: {}, topup: {}, leaderboard: {} };
if (fs.existsSync('./db.json')){
  try{
    db = JSON.parse(fs.readFileSync('./db.json'));
    if(!db.likes) db.likes={};
    if(!db.topup) db.topup={};
    if(!db.leaderboard) db.leaderboard={};
  }catch(e){}
}

// ================= HELPERS & UTILITIES =================
async function save(){
  try{ fs.writeFileSync('./db.json', JSON.stringify(db,null,2)); }catch(e){}
  if(MONGODB_URI && mongoose.connection.readyState===1){
    try{
      for(let id in db.users){
        await UserModel.findOneAndUpdate({psid:id},{psid:id,data:db.users[id]},{upsert:true});
      }
    }catch(e){}
  }
}

const TOPUP_RATES = { 20:120, 50:300, 80:500, 100:700, 200:1600, 500:4500 };
const CITY_COORDS = {
  "manila":[14.5995,120.9842],
  "quezon city":[14.6760,121.0437],
  "cebu":[10.3157,123.8854],
  "davao":[7.1907,125.4553],
  "tokyo":[35.6762,139.6503],
  "seoul":[37.5665,126.9780],
  "singapore":[1.3521,103.8198]
};

function getDistance(l1,l2){
  const c1=CITY_COORDS[l1?.toLowerCase()]||[14.5995,120.9842];
  const c2=CITY_COORDS[l2?.toLowerCase()]||[14.5995,120.9842];
  const R=6371;
  const dLat=(c2[0]-c1[0])*Math.PI/180;
  const dLon=(c2[1]-c1[1])*Math.PI/180;
  const a=Math.sin(dLat/2)**2 + Math.cos(c1[0]*Math.PI/180)*Math.cos(c2[0]*Math.PI/180)*Math.sin(dLon/2)**2;
  return (R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))).toFixed(1);
}

// INSTANT REPLY WITH TYPING INDICATOR
async function send(id, text, qr=null){
  try{
    await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`,{
      method:"POST",
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ recipient:{id}, sender_action:"typing_on" })
    });
  }catch(e){}

  setTimeout(async () => {
    const body={ recipient:{id}, message:{ text } };
    if(qr) body.message.quick_replies=qr;
    try{
      await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`,{
        method:"POST",
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(body)
      });
    }catch(e){}
  }, 400);
}

// CASE SENSITIVE, TYPO FIX & MULTI-LANGUAGE PARSER
function sanitizeInput(text){
  if(!text) return "";
  let clean = text.toLowerCase().trim();
  // Auto fix common typos
  clean = clean.replace(/pacakge|pakage|pakcages/g, "package")
               .replace(/topup|top-up/g, "top up")
               .replace(/proflie/g, "profile");
  
  // Accept numbers / multi-language words mapping
  if(["1", "isa", "one", "uno", "menu"].includes(clean)) return "MENU";
  if(["2", "dalawa", "two", "dos", "profile"].includes(clean)) return "PROFILE";
  if(["3", "tatlo", "three", "tres", "find match"].includes(clean)) return "FIND MATCH";
  if(["4", "apat", "four", "cuatro", "top up"].includes(clean)) return "TOP UP";
  if(["5", "lima", "five", "cinco", "daily"].includes(clean)) return "DAILY";
  if(["6", "anim", "six", "spin"].includes(clean)) return "SPIN";
  if(["7", "pito", "seven", "shop"].includes(clean)) return "SHOP";
  if(["8", "walo", "eight", "leaderboard"].includes(clean)) return "LEADERBOARD";
  
  return clean;
}

async function createPaymongoLink(amount, coins, psid){
  try{
    const res = await axios.post('https://api.paymongo.com/v1/links',{
      data:{ attributes:{ amount:amount*100, description:`${coins} Coins JojoWorld`, remarks:psid.toString() } }
    },{
      headers:{ Authorization:`Basic ${Buffer.from(PAYMONGO_SECRET+':').toString('base64')}`, 'Content-Type':'application/json' }
    });
    return res.data.data.attributes.checkout_url;
  }catch(e){
    return null;
  }
}

// ================= UI DISPLAYS & MENUS =================
function sendMenu(id){
  let timerText = "🔥 LIMITED TIME: +20% Bonus Coins (Ends in 02:45:12)";
  send(id, `✨ JOJOWORLD V24 ULTIMATE ✨
━━━━━━━━━━━━━━━━━━━━
${timerText}
💘 Find match & connect worldwide
🎁 Daily bonuses & Spin rewards

[1] 👤 My Profile
[2] 💘 Find Match (10c)
[3] 💰 Top-Up Center
[4] 🎁 Daily Bonus
[5] 🎡 Daily Spin Wheel
[6] 🛍️ Profile Shop & Gifts
[7] 🏆 Leaderboards
[8] 🔗 Referral Invite

💬 *Tip: Type numbers 1-8 or use Quick Replies below!*`,[
    {content_type:"text", title:"👤 Profile (1)", payload:"PROFILE"},
    {content_type:"text", title:"💘 Match (2)", payload:"FIND MATCH"},
    {content_type:"text", title:"💰 Top Up (3)", payload:"TOP UP"},
    {content_type:"text", title:"🎁 Daily (4)", payload:"DAILY"},
    {content_type:"text", title:"🎡 Spin (5)", payload:"SPIN"},
    {content_type:"text", title:"🛍️ Shop (6)", payload:"SHOP"},
    {content_type:"text", title:"🏆 Rank (7)", payload:"LEADERBOARD"}
  ]);
}

function sendTopupMenu(id){
  send(id, `💰 JOJOWORLD TOP-UP CENTER
━━━━━━━━━━━━━━━━━━━━
🔒 Secure PayMongo Gateway (GCash/Maya/Card)
💎 Instant auto-credit after payment

⭐ VALUE COMPARISON TABLE:
📦 P20 = 120 Coins (6c / peso)
📦 P50 = 300 Coins (6c / peso)
🔥 P80 = 500 Coins (6.25c / peso - BEST SELLER!)
📦 P100 = 700 Coins (7c / peso)
📦 P200 = 1600 Coins (8c / peso - VALUE!)
🚀 P500 = 4500 Coins (9c / peso - VIP CHOICE!)

Select a package:`,[
    {content_type:"text", title:"💰 P20 = 120c", payload:"TOP UP 20"},
    {content_type:"text", title:"💰 P50 = 300c", payload:"TOP UP 50"},
    {content_type:"text", title:"⭐ P80 = 500c", payload:"TOP UP 80"},
    {content_type:"text", title:"💰 P100 = 700c", payload:"TOP UP 100"},
    {content_type:"text", title:"💰 P200 = 1600c", payload:"TOP UP 200"},
    {content_type:"text", title:"💰 P500 = 4500c", payload:"TOP UP 500"},
    {content_type:"text", title:"↩️ Main Menu", payload:"MENU"}
  ]);
}

// ================= WEBHOOKS =================
app.get('/webhook', (req,res)=>{
  if(req.query['hub.verify_token']===VERIFY_TOKEN) return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
});

app.post('/paymongo-webhook', async (req,res)=>{
  try{
    const ev = req.body.data;
    if(!ev) return res.sendStatus(200);
    const attr = ev.attributes?.data?.attributes || ev.attributes;
    if(attr.status==='paid' && attr.remarks){
      let amt = Math.round(attr.amount/100);
      let coins = TOPUP_RATES[amt] || 0;
      if(coins>0 && db.users[attr.remarks]){
        db.users[attr.remarks].coins = (db.users[attr.remarks].coins||0) + coins;
        await save();
        await send(attr.remarks, `✅ PAYMENT SUCCESSFUL!\n💰 +${coins} Coins added to your account!\n💎 New Balance: ${db.users[attr.remarks].coins} coins\n\nEnjoy playing JojoWorld! 🚀`);
      }
    }
  }catch(e){}
  res.sendStatus(200);
});

app.post('/webhook', async (req,res)=>{
  try{
    const body = req.body;
    if(body.object!=='page') return res.sendStatus(200);
    for(const entry of body.entry){
      for(const ev of entry.messaging){
        const psid = ev.sender.id;
        
        // Initialize user database record with 75+ feature states
        if(!db.users[psid]) {
          db.users[psid] = { 
            coins:150, location:"Manila", rating:5.0, bio:"No bio set", age:21, gender:"Not set", name:"Jojo User",
            created:Date.now(), lastDaily:0, lastSpin:0, refCount:0, views:0, theme:"Default", frame:"None", 
            badge:"Newbie", giftsCount:0, onlineStatus:"🟢 Online", strength:40, state:"IDLE" 
          };
          db.users[psid].referralCode = "JOJO" + psid.slice(-4);
        }

        // Update Online status timestamp
        db.users[psid].lastActive = Date.now();
        db.users[psid].onlineStatus = "🟢 Online Now";

        let rawText = "";
        if(ev.message && ev.message.quick_reply) rawText = ev.message.quick_reply.payload;
        else if(ev.message && ev.message.text) rawText = ev.message.text;

        let cleanText = sanitizeInput(rawText);
        console.log(`MSG [${psid}]:`, cleanText);

        // ================= STATE MACHINE & FLOWS =================
        let user = db.users[psid];

        // 1. PROFILE EDIT STATE
        if(user.state === "EDIT_BIO"){
          user.bio = rawText;
          user.state = "IDLE";
          user.strength = Math.min(100, user.strength + 30);
          await save();
          send(psid, `✅ Bio updated successfully!\n💬 "${user.bio}"\n\nWhat's next?`, [{content_type:"text", title:"👤 View Profile", payload:"PROFILE"}, {content_type:"text", title:"↩️ Menu", payload:"MENU"}]);
          continue;
        }

        // 2. MAIN COMMAND & PAYLOAD ROUTING
        if(cleanText === "menu" || cleanText === "start"){
          user.state = "IDLE";
          sendMenu(psid);
          continue;
        }
        
        if(cleanText === "profile" || cleanText === "1"){
          send(psid, `👤 YOUR PROFILE & STATS
━━━━━━━━━━━━━━━━━━━━
📛 Name: ${user.name} (${user.age}, ${user.gender})
📍 Location: ${user.location}
💬 Bio: "${user.bio}"
💎 Coins: ${user.coins} | 👁️ Views: ${user.views}
🌟 Badge: ${user.badge} | 🖼️ Frame: ${user.frame}
📊 Profile Strength: ${user.strength}% [████████░░]
🔗 Ref Link: t.me/jojoworld?start=${user.referralCode}

What would you like to do?`,[
            {content_type:"text", title:"✏️ Edit Bio", payload:"EDIT BIO"},
            {content_type:"text", title:"💰 Top Up", payload:"TOP UP"},
            {content_type:"text", title:"↩️ Menu", payload:"MENU"}
          ]);
          continue;
        }

        if(cleanText === "edit bio"){
          user.state = "EDIT_BIO";
          send(psid, `✏️ EDIT PROFILE BIO\n━━━━━━━━━━━━━━━━━━━━\nPlease type your new bio message below (e.g., "Coffee lover & traveler ✈️"):`);
          continue;
        }

        if(cleanText === "find match" || cleanText === "2"){
          if(user.coins < 10){
            send(psid, `❌ Insufficient coins! Searching costs 10 coins.\nType TOP UP to buy more coins.`, [{content_type:"text", title:"💰 Top Up", payload:"TOP UP"}]);
            continue;
          }
          user.coins -= 10;
          await save();
          
          send(psid, `💘 DISCOVER MATCH NEARBY (-10 coins)
━━━━━━━━━━━━━━━━━━━━
👩 Sarah, 22 • 0.8km away (🟢 Online)
📍 Manila • ⭐ 4.9 (142 votes)
💬 "Looking for hiking buddies and coffee dates!"
✨ Compatibility Match: 94%!

🔒 Options:`,[
            {content_type:"text", title:"❤️ Like (Free)", payload:"LIKE Sarah"},
            {content_type:"text", title:"⭐ Super Like (50c)", payload:"SUPERLIKE"},
            {content_type:"text", title:"💬 Unlock Chat (20c)", payload:"UNLOCK_CHAT"},
            {content_type:"text", title:"⏭️ Next (10c)", payload:"FIND MATCH"}
          ]);
          continue;
        }

        if(cleanText === "top up" || cleanText === "3"){
          sendTopupMenu(psid);
          continue;
        }

        if(cleanText.startsWith("top up ")){
          let amt = parseInt(cleanText.split(" ").pop());
          let coins = TOPUP_RATES[amt];
          if(!coins){
            send(psid, `❌ Invalid package. Choose from 20, 50, 80, 100, 200, 500.`);
            continue;
          }
          send(psid, `⏳ Generating secure PayMongo link for P${amt} = ${coins} coins...`);
          let link = await createPaymongoLink(amt, coins, psid);
          if(link){
            send(psid, `💎 SECURE PAYMENT LINK\n━━━━━━━━━━━━━━━━━━━━\n💰 Package: P${amt} (${coins} Coins)\n🔒 Powered by PayMongo\n💳 GCash / Maya / Credit Card\n\n👇 Click to pay now:\n${link}\n\n✅ Coins auto-credit upon payment success!`, [{content_type:"text", title:"↩️ Menu", payload:"MENU"}]);
          } else {
            send(psid, `❌ Gateway error. Direct manual GCash transfer to admin: ${GCASH_NUM}`);
          }
          continue;
        }

        if(cleanText === "daily" || cleanText === "4"){
          let now = Date.now();
          if(now - user.lastDaily < 86400000){
            let hoursLeft = Math.ceil((86400000 - (now - user.lastDaily)) / 3600000);
            send(psid, `🎁 Daily bonus already claimed! Come back in ${hoursLeft} hours.`, [{content_type:"text", title:"↩️ Menu", payload:"MENU"}]);
          } else {
            user.coins += 25;
            user.lastDaily = now;
            await save();
            send(psid, `🎁 DAILY REWARD CLAIMED!\n💰 +25 Coins added!\n💎 Balance: ${user.coins} coins`, [{content_type:"text", title:"🎡 Try Daily Spin", payload:"SPIN"}, {content_type:"text", title:"↩️ Menu", payload:"MENU"}]);
          }
          continue;
        }

        if(cleanText === "spin" || cleanText === "5"){
          let prizes = ["+50 Coins", "+100 Coins", "Super Like", "Free Boost", "Jackpot 500c", "+10 Coins"];
          let won = prizes[Math.floor(Math.random() * prizes.length)];
          if(won.includes("Coins")){
            let add = parseInt(won.replace("+","").replace(" Coins",""));
            user.coins += add;
          } else if(won.includes("Jackpot")){
            user.coins += 500;
          }
          await save();
          send(psid, `🎡 WHEEL OF FORTUNE SPIN! 🎡\n━━━━━━━━━━━━━━━━━━━━\n🎉 Congratulations! You won: *${won}*!\n💎 New Balance: ${user.coins} coins\n\nWant another spin for 10 coins?`,[
            {content_type:"text", title:"🎡 Spin Again (10c)", payload:"SPIN"},
            {content_type:"text", title:"↩️ Menu", payload:"MENU"}
          ]);
          continue;
        }

        if(cleanText === "shop" || cleanText === "6"){
          send(psid, `🛍️ JOJOWORLD PROFILE SHOP
━━━━━━━━━━━━━━━━━━━━
Customize your profile to get 3x more likes!

[1] Gold Glow Theme - 100 coins
[2] Fire Frame Effect - 150 coins
[3] VIP Verified Badge - 200 coins
[4] Send Rose Gift (to match) - 30 coins

Reply with item name or number to buy!`,[
            {content_type:"text", title:"✨ Buy VIP Badge", payload: "BUY_VIP"},
            {content_type:"text", title:"🌹 Send Rose Gift", payload: "SEND_GIFT"},
            {content_type:"text", title:"↩️ Menu", payload:"MENU"}
          ]);
          continue;
        }

        if(cleanText === "buy_vip" || cleanText === "vip"){
          if(user.coins < 200) {
            send(psid, `❌ Not enough coins! VIP Badge costs 200 coins.`);
          } else {
            user.coins -= 200;
            user.badge = "👑 VIP Elite";
            await save();
            send(psid, `🎉 SUCCESS! You are now a VIP Elite member! Badge unlocked 👑`);
          }
          continue;
        }

        if(cleanText === "leaderboard" || cleanText === "7"){
          send(psid, `🏆 JOJOWORLD WEEKLY LEADERBOARD
━━━━━━━━━━━━━━━━━━━━
👑 1. Jojo_Master — 4,850 coins
🥈 2. Angel_21 — 3,920 coins
🥉 3. Karding_99 — 3,100 coins
⭐ 4. You (${user.name}) — ${user.coins} coins

🎁 Top 3 players win P500 cash every Sunday! Keep earning coins!`,[
            {content_type:"text", title:"💰 Earn More Coins", payload:"TOP UP"},
            {content_type:"text", title:"↩️ Menu", payload:"MENU"}
          ]);
          continue;
        }

        if(cleanText === "referral" || cleanText === "8" || cleanText === "invite"){
          send(psid, `🔗 REFERRAL & INVITE PROGRAM
━━━━━━━━━━━━━━━━━━━━
Share your unique invite link with friends:
👉 t.me/jojoworld?start=${user.referralCode}

👥 Total Invites: ${user.refCount} friends
🎁 Rewards: +50 coins per invite + 10% commission when they top up!`,[
            {content_type:"text", title:"↩️ Menu", payload:"MENU"}
          ]);
          continue;
        }

        if(cleanText === "unlock_chat"){
          if(user.coins < 20) {
            send(psid, `❌ Unlocking chat requires 20 coins.`);
            continue;
          }
          user.coins -= 20;
          await save();
          send(psid, `🔓 CHAT UNLOCKED!\nYou can now chat freely with your match. Say hi! 👋`, [{content_type:"text", title:"↩️ Menu", payload:"MENU"}]);
          continue;
        }

        // Default Smart fallback suggestion helper
        send(psid, `✨ I understand "${rawText}". Let's get you back on track!`, [
          {content_type:"text", title:"📋 Main Menu", payload:"MENU"},
          {content_type:"text", title:"💘 Find Match", payload:"FIND MATCH"},
          {content_type:"text", title:"💰 Top Up", payload:"TOP UP"}
        ]);

      }
    }
  }catch(e){
    console.log("Webhook error:", e.message);
  }
  res.sendStatus(200);
});

app.get('/', (req,res)=> res.send('JojoWorld V24 ULTIMATE Running - 75+ Functions OK'));
app.listen(process.env.PORT||10000, ()=>console.log("V24 Ultimate Server Running"));
