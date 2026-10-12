// JOJOWORLD V15 - PROFESSIONAL ENGLISH EDITION
// Fixes: Menu, Find Match Animation, Edit Bio with Fee, Unified Top-Up, 100% English

const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const app = express();
app.use(bodyParser.json());

const ADMIN_ID = "100064525073153";
const GCASH_NUM = "09517080795";
const PAYPAL_EMAIL = "alexgawat7@gmail.com";
const PAGE_TOKEN = process.env.PAGE_TOKEN;
const VERIFY_TOKEN = "jojoworld_v15";

// Database
let db = { users: {}, groups: {}, pendings: {}, likes: {} };
if (fs.existsSync('./db.json')){
  try{
    db = JSON.parse(fs.readFileSync('./db.json'));
    if(!db.likes) db.likes={};
  }catch(e){
    db = { users: {}, groups: {}, pendings: {}, likes: {} };
  }
}
function save(){ fs.writeFileSync('./db.json', JSON.stringify(db,null,2)); }

// Location coordinates for distance calculation
const CITY_COORDS = {
  "manila": [14.5995,120.9842], "quezon city": [14.6760,121.0437],
  "cebu": [10.3157,123.8854], "davao": [7.1907,125.4553],
  "tokyo": [35.6762,139.6503], "seoul": [37.5665,126.9780], "singapore": [1.3521,103.8198]
};

function getDistance(loc1, loc2){
  const c1 = CITY_COORDS[loc1?.toLowerCase()] || [14.5995,120.9842];
  const c2 = CITY_COORDS[loc2?.toLowerCase()] || [14.5995,120.9842];
  const R=6371;
  const dLat=(c2[0]-c1[0])*Math.PI/180;
  const dLon=(c2[1]-c1[1])*Math.PI/180;
  const a=Math.sin(dLat/2)**2 + Math.cos(c1[0]*Math.PI/180)*Math.cos(c2[0]*Math.PI/180)*Math.sin(dLon/2)**2;
  return (R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))).toFixed(1);
}

function send(id, text, quick_replies=null){
  const body={ recipient:{id}, message:{ text } };
  if(quick_replies) body.message.quick_replies = quick_replies;
  fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`,{
    method:"POST",
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  }).catch(e=>console.log("Send error:", e.message));
}

function sendButtons(id, type){
  if(type==="TOPUP_MENU"){
    return send(id, `💰 JOJOWORLD TOP-UP
━━━━━━━━━━━━━━━━━━━━
💎 Same price for GCash & PayPal
💎 Instant coins after verification

Select package:`,[
      {content_type:"text", title:"💰 P50 = 300c", payload:"TOPUP 50"},
      {content_type:"text", title:"💰 P100 = 700c", payload:"TOPUP 100"},
      {content_type:"text", title:"💰 P200 = 1600c", payload:"TOPUP 200"},
      {content_type:"text", title:"💰 P500 = 4500c", payload:"TOPUP 500"},
      {content_type:"text", title:"📊 View Rates", payload:"RATES"},
      {content_type:"text", title:"↩️ Menu", payload:"MENU"}
    ]);
  }
  return send(id, `✨ WELCOME TO JOJOWORLD ✨
━━━━━━━━━━━━━━━━━━━━
💘 Find your perfect match nearby
🌍 Connect with people worldwide
🎁 Daily rewards available

Choose an option:`,[
    {content_type:"text", title:"👤 My Profile", payload:"PROFILE"},
    {content_type:"text", title:"💘 Find Match", payload:"FIND MATCH"},
    {content_type:"text", title:"📍 Near Me", payload:"NEAR ME"},
    {content_type:"text", title:"🌍 World", payload:"NEAR WORLD"},
    {content_type:"text", title:"👥 Groups", payload:"NEAR GROUP"},
    {content_type:"text", title:"🏆 Leaderboard", payload:"LEADERBOARD"},
    {content_type:"text", title:"💰 Top Up", payload:"TOP UP"},
    {content_type:"text", title:"🎁 Daily Bonus", payload:"DAILY"}
  ]);
}

function sendNearMe(id, targetId){
  const u = db.users[id];
  const target = db.users[targetId];

  if(!target){
    return send(id, `💘 NEARBY IN ${u.location.toUpperCase()}
━━━━━━━━━━━━━━━━━━━━
👩 Anna, 22 • 0.5km away
📍 Quezon City • ⭐ 5.0 (128 votes)
💬 "Coffee lover, travel enthusiast. Looking for genuine connection."
🎂 Single • ♒ Aquarius • 💼 Coffee & Travel

This is a demo profile. More users coming soon!

What would you like to do?`,
    [
      {content_type:"text", title:"❤️ Like", payload:"LIKE Anna"},
      {content_type:"text", title:"⏭️ Next", payload:"NEAR ME"},
      {content_type:"text", title:"↩️ Menu", payload:"MENU"}
    ]);
  }

  const dist = getDistance(u.location, target.location);
  const zodiac = target.zodiac || "Aquarius";
  const bio = target.bio || "No bio yet";
  const interests = target.interests || "Not set";

  send(id, `💘 DISCOVER - ${target.location.toUpperCase()}
━━━━━━━━━━━━━━━━━━━━
👤 ID: ${targetId.slice(-6)} • ${dist}km away
📍 ${target.location} • ⭐ ${target.rating} (${target.votes||0} votes)
💬 "${bio}"
💼 Interests: ${interests}
🎂 ${target.status||"Single"} • ♒ ${zodiac}

Interested in this person?`, [
    {content_type:"text", title:"❤️ Like", payload:"LIKE "+targetId},
    {content_type:"text", title:"💬 Message", payload:"CHAT "+targetId},
    {content_type:"text", title:"⏭️ Next", payload:"NEAR ME"},
    {content_type:"text", title:"↩️ Menu", payload:"MENU"}
  ]);
}

app.get('/', (req,res)=>{ res.send('JojoWorld V15 Professional - Live!'); });
app.get('/webhook', (req,res)=>{
  if(req.query['hub.verify_token']===VERIFY_TOKEN) res.send(req.query['hub.challenge']);
  else res.send('Verification failed');
});

app.post('/webhook', async (req,res)=>{
  const messaging = req.body.entry?.[0]?.messaging?.[0];
  if(!messaging) return res.sendStatus(200);
  if(messaging.delivery || messaging.read || messaging.message?.is_echo) return res.sendStatus(200);

  const sender = messaging.sender.id;
  let text = messaging.message?.quick_reply?.payload || messaging.postback?.payload || messaging.message?.text || "";
  text = text.trim();
  const upText = text.toUpperCase();

  if(!db.users[sender]){
    db.users[sender] = {
      id:sender, step:"new", coins:100, pics:[], match:null, group:null,
      rating:5, votes:0, badges:[], streak:0, lastDaily:null,
      bio:"No bio yet", interests:"Not set", status:"Single",
      birthday:null, zodiac:"", location:"Manila", likes:[], likedBy:[], bioEdits:0
    };
    save();
  }
  if(!db.likes[sender]) db.likes[sender]=[];

  // GLOBAL MENU
  if(upText.includes("MENU") &&!upText.includes("TOPUP")){
    db.users[sender].step="new"; save();
    sendButtons(sender,"MAIN_MENU");
    return res.sendStatus(200);
  }
  if(upText.includes("TOP UP") || upText==="TOPUP" || upText==="TOP_UP" || upText==="TOP UP MENU"){
    sendButtons(sender,"TOPUP_MENU");
    return res.sendStatus(200);
  }

  // PROFILE - PROFESSIONAL
  if(upText.includes("PROFILE")){
    const u=db.users[sender];
    const matchText = u.match? `❤️ Matched with: ${u.match.slice(-6)}` : "💔 No match yet";
    send(sender,`👤 YOUR PROFILE
━━━━━━━━━━━━━━━━━━━━
🆔 ID: ${sender.slice(-6)}
💰 Coins: ${u.coins}
📍 Location: ${u.location}
⭐ Rating: ${u.rating} (${u.votes} votes)
💬 Bio: ${u.bio}
💼 Interests: ${u.interests}
💘 Status: ${u.status}
♒ Zodiac: ${u.zodiac||"Not set"}
${matchText}
━━━━━━━━━━━━━━━━━━━━
Edit your profile to get more matches!`, [
      {content_type:"text", title:"✏️ Edit Bio", payload:"EDIT_BIO"},
      {content_type:"text", title:"📍 Edit Location", payload:"EDIT_LOCATION"},
      {content_type:"text", title:"💼 Wallet", payload:"WALLET"},
      {content_type:"text", title:"↩️ Menu", payload:"MENU"}
    ]);
    return res.sendStatus(200);
  }

  if(upText.includes("WALLET")){
    const u=db.users[sender];
    send(sender,`💼 WALLET
━━━━━━━━━━━━━━━━━━━━
💰 Balance: ${u.coins} coins
━━━━━━━━━━━━━━━━━━━━
Payment Methods:
💚 GCash: ${GCASH_NUM}
💳 PayPal: ${PAYPAL_EMAIL}

💡 Tip: Claim daily bonus for +20 coins daily!`,
    [{content_type:"text", title:"💰 Top Up", payload:"TOP UP"}, {content_type:"text", title:"↩️ Menu", payload:"MENU"}]);
    return res.sendStatus(200);
  }

  if(upText.includes("DAILY")){
    const u=db.users[sender];
    const today = new Date().toDateString();
    if(u.lastDaily===today){
      send(sender,`🎁 Daily bonus already claimed today!\n💰 Balance: ${u.coins} coins\nCome back tomorrow for more!`,
      [{content_type:"text", title:"💘 Find Match", payload:"FIND MATCH"}, {content_type:"text", title:"↩️ Menu", payload:"MENU"}]);
      return res.sendStatus(200);
    }
    u.coins+=20; u.lastDaily=today; u.streak=(u.streak||0)+1; save();
    send(sender,`🎁 DAILY BONUS CLAIMED!
━━━━━━━━━━━━━━━━━━━━
✅ +20 coins added!
🔥 Streak: ${u.streak} days
💰 Total Balance: ${u.coins} coins

See you tomorrow!`,
    [{content_type:"text", title:"💘 Find Match", payload:"FIND MATCH"}, {content_type:"text", title:"↩️ Menu", payload:"MENU"}]);
    return res.sendStatus(200);
  }

  // EDIT BIO WITH FEE - PROFESSIONAL
  if(upText.includes("EDIT BIO") || upText==="EDIT_BIO"){
    const u=db.users[sender];
    if(!u.bioEdits) u.bioEdits=0;
    if(u.bioEdits===0){
      u.step="edit_bio"; save();
      send(sender,`✏️ EDIT BIO - FREE FIRST EDIT
━━━━━━━━━━━━━━━━━━━━
Current bio: "${u.bio}"

Please type your new bio (3-150 characters):
Example: "Coffee lover, gym enthusiast, single from Manila looking for genuine connection."`);
    } else {
      if(u.coins < 10){
        send(sender,`❌ Insufficient coins!

Editing bio requires 10 coins for subsequent edits.
Your balance: ${u.coins} coins

Please claim daily bonus or top up to continue.`,
        [{content_type:"text", title:"🎁 Daily Bonus", payload:"DAILY"}, {content_type:"text", title:"💰 Top Up", payload:"TOP UP"}]);
      } else {
        u.step="edit_bio_pay"; save();
        send(sender,`✏️ EDIT BIO - PAID EDIT
━━━━━━━━━━━━━━━━━━━━
Current: "${u.bio}"
Fee: 10 coins
Balance: ${u.coins} coins

Type YES to continue or CANCEL to abort.`);
      }
    }
    return res.sendStatus(200);
  }

  if(db.users[sender].step==="edit_bio" || db.users[sender].step==="edit_bio_pay" || db.users[sender].step==="edit_bio_confirm"){
    const u=db.users[sender];
    if(upText==="CANCEL" || upText==="MENU"){ u.step="new"; save(); sendButtons(sender,"MAIN_MENU"); return res.sendStatus(200); }
    if(u.step==="edit_bio_pay" && upText==="YES"){ send(sender,`Please type your new bio now (3-150 characters):`); u.step="edit_bio_confirm"; save(); return res.sendStatus(200); }
    if(u.step==="edit_bio_pay") return res.sendStatus(200);
    if(text.length < 3){ send(sender,`❌ Bio too short! Minimum 3 characters. Please try again:`); return res.sendStatus(200); }
    if(text.length > 150){ send(sender,`❌ Bio too long! Maximum 150 characters. Please make it shorter:`); return res.sendStatus(200); }
    if(u.bioEdits>0 || u.step==="edit_bio_confirm"){ if(u.coins < 10){ send(sender,`Insufficient coins!`); return res.sendStatus(200); } u.coins -= 10; }
    u.bio = text; u.bioEdits = (u.bioEdits||0)+1; u.step="new"; save();
    const feeText = u.bioEdits===1? "FREE - First edit bonus!" : "10 coins deducted.";
    send(sender,`✅ BIO UPDATED SUCCESSFULLY! ${feeText}
━━━━━━━━━━━━━━━━━━━━
New bio:
💬 "${u.bio}"

💰 Balance: ${u.coins} coins
✏️ Total edits: ${u.bioEdits}

Your profile looks amazing! More matches coming!`, [
      {content_type:"text", title:"👤 View Profile", payload:"PROFILE"},
      {content_type:"text", title:"💘 Find Match", payload:"FIND MATCH"},
      {content_type:"text", title:"↩️ Menu", payload:"MENU"}
    ]);
    return res.sendStatus(200);
  }

  // FIND MATCH WITH FINDING + CONNECTING ANIMATION
  if(upText.includes("FIND MATCH") || upText==="MATCH" || upText==="FIND" || upText==="SEARCH"){
    send(sender,`🔍 FINDING MATCH...
━━━━━━━━━━━━━━━━━━━━
📡 Searching near ${db.users[sender].location}...
⏳ Please wait, looking for someone perfect for you...`);
    setTimeout(()=>{
      const allUsers = Object.keys(db.users).filter(id=>id!==sender);
      if(allUsers.length===0){ sendNearMe(sender, null); }
      else {
        const randomId = allUsers[Math.floor(Math.random()*allUsers.length)];
        send(sender,`✅ CONNECTING...
━━━━━━━━━━━━━━━━━━━━
💘 Match found! Preparing profile...`);
        setTimeout(()=>{ sendNearMe(sender, randomId); }, 1000);
      }
    }, 1500);
    return res.sendStatus(200);
  }

  if(upText==="NEAR ME" || upText.includes("NEAR ME")){
    send(sender,`🔍 SEARCHING NEARBY...
━━━━━━━━━━━━━━━━━━━━
📡 Location: ${db.users[sender].location}...
⏳ Scanning nearby users...`);
    setTimeout(()=>{
      const allUsers = Object.keys(db.users).filter(id=>id!==sender);
      if(allUsers.length===0){ sendNearMe(sender, null); }
      else { const randomId = allUsers[Math.floor(Math.random()*allUsers.length)]; sendNearMe(sender, randomId); }
    }, 1200);
    return res.sendStatus(200);
  }

  // LIKE SYSTEM
  if(upText.startsWith("LIKE ")){
    const likedId = text.split(" ").slice(1).join(" ").trim();
    if(likedId.toUpperCase()==="ANNA"){
      send(sender,`❤️ You liked Anna! 💘\n\nIf she likes you back, you'll get a MATCH! 🎉\nKeep discovering!`,
      [{content_type:"text", title:"⏭️ Next Profile", payload:"NEAR ME"}, {content_type:"text", title:"↩️ Menu", payload:"MENU"}]);
      return res.sendStatus(200);
    }
    if(!db.users[likedId]){ send(sender,`❌ User not found. Please try searching again.`, [{content_type:"text", title:"💘 Find Match", payload:"FIND MATCH"}]); return res.sendStatus(200); }
    if(!db.likes[sender].includes(likedId)) db.likes[sender].push(likedId);
    if(!db.users[likedId].likedBy) db.users[likedId].likedBy=[];
    if(!db.users[likedId].likedBy.includes(sender)) db.users[likedId].likedBy.push(sender);
    save();
    if(db.likes[likedId] && db.likes[likedId].includes(sender)){
      db.users[sender].match = likedId; db.users[likedId].match = sender; save();
      send(sender,`🎉 IT'S A MATCH! ❤️❤️❤️
━━━━━━━━━━━━━━━━━━━━
You and ${likedId.slice(-6)} liked each other!

💬 Start chatting now!`);
      send(likedId,`🎉 IT'S A MATCH! ❤️❤️❤️
━━━━━━━━━━━━━━━━━━━━
You and ${sender.slice(-6)} liked each other!

💬 They liked you back! Start chatting!`);
    } else {
      send(sender,`💌 You liked ${likedId.slice(-6)}! 😉\n\nIf they like you back, you'll match! Keep exploring!`,
      [{content_type:"text", title:"⏭️ Next Profile", payload:"NEAR ME"}, {content_type:"text", title:"↩️ Menu", payload:"MENU"}]);
    }
    return res.sendStatus(200);
  }

  // TOP-UP - UNIFIED PROFESSIONAL
  if(upText.startsWith("TOPUP ")){
    const amount = text.split(" ")[1];
    let coins = "300";
    if(amount=="100") coins="700";
    if(amount=="200") coins="1600";
    if(amount=="500") coins="4500";
    if(amount=="50") coins="300";
    send(sender,`✅ TOP-UP ORDER: P${amount} = ${coins} COINS
━━━━━━━━━━━━━━━━━━━━
💰 Package: P${amount} = ${coins} coins
━━━━━━━━━━━━━━━━━━━━
💚 GCash: ${GCASH_NUM}
   Please send P${amount} to this number

💳 PayPal: ${PAYPAL_EMAIL}
   Please send P${amount} to this email

━━━━━━━━━━━━━━━━━━━━
💡 Same price for both methods!
After payment, please send screenshot to admin with your ID: ${sender.slice(-6)}

Type MENU to return to main menu.`);
    return res.sendStatus(200);
  }

  if(upText==="RATES"){
    send(sender,`📊 TOP-UP RATES - GCash & PayPal Same Price
━━━━━━━━━━━━━━━━━━━━
💰 P50 = 300 coins
💰 P100 = 700 coins (Most Popular!)
💰 P200 = 1600 coins (Best Value!)
💰 P500 = 4500 coins (Super Value!)

💚 GCash: ${GCASH_NUM}
💳 PayPal: ${PAYPAL_EMAIL}

One-click purchase - Same price for both!`,[
      {content_type:"text", title:"💰 P50=300c", payload:"TOPUP 50"},
      {content_type:"text", title:"💰 P100=700c", payload:"TOPUP 100"},
      {content_type:"text", title:"💰 P200=1600c", payload:"TOPUP 200"},
      {content_type:"text", title:"↩️ Menu", payload:"MENU"}
    ]);
    return res.sendStatus(200);
  }

  if(upText.includes("NEAR WORLD")){
    send(sender,`🌍 WORLDWIDE DISCOVERY
━━━━━━━━━━━━━━━━━━━━
🇯🇵 Tokyo - Yuki • 0.3km • Online Now
🇰🇷 Seoul - Jisoo • 1.2km • Online Now
🇺🇸 USA - Jessica • 2.5km • Online Now
🇸🇬 Singapore - Mei • 0.8km • Online Now

Type NEAR ME to search locally or FIND MATCH to discover!`,
    [{content_type:"text", title:"💘 Find Match", payload:"FIND MATCH"}, {content_type:"text", title:"↩️ Menu", payload:"MENU"}]);
    return res.sendStatus(200);
  }
  if(upText.includes("NEAR GROUP")){
    send(sender,`👥 NEARBY GROUPS
━━━━━━━━━━━━━━━━━━━━
1. San Jose Singles - 12 online 💘
2. JojoWorld Community - 45 online 🔥
3. Manila Connections - 28 online 💋

Join groups to meet more people!
Type NEAR ME to discover individuals`,
    [{content_type:"text", title:"💘 Find Match", payload:"FIND MATCH"}, {content_type:"text", title:"↩️ Menu", payload:"MENU"}]);
    return res.sendStatus(200);
  }
  if(upText.includes("LEADERBOARD")||upText.includes("TOP")){
    send(sender,`🏆 TOP USERS - LEADERBOARD
━━━━━━━━━━━━━━━━━━━━
1. 👩 Anna - 5.0⭐ (210 votes) 👑 Premium
2. 👩 Liza - 4.9⭐ (180 votes) ⭐ Top Rated
3. 👨 Mark - 4.8⭐ (165 votes) 🔥 Popular

Get more votes and likes to climb the rank!
Complete your profile for better visibility!`,
    [{content_type:"text", title:"💘 Find Match", payload:"FIND MATCH"}, {content_type:"text", title:"↩️ Menu", payload:"MENU"}]);
    return res.sendStatus(200);
  }

  sendButtons(sender,"MAIN_MENU");
  return res.sendStatus(200);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>{ console.log('JojoWorld V15 Professional Live on '+PORT); });
