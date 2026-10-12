// JOJOWORLD V22 - ENGLISH PROFESSIONAL - FOR J'S
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const app = express();
app.use(bodyParser.json());
const ADMIN_ID = "100064525073153";
const GCASH_NUM = "09517080795";
const PAYMONGO_SECRET = process.env.PAYMONGO_SECRET;
const PAGE_TOKEN = process.env.PAGE_TOKEN;
const VERIFY_TOKEN = "jojoworld_v22";
let db = { users: {}, groups: {}, pendings: {}, likes: {}, topup: {} };
if (fs.existsSync('./db.json')){
 try{ db = JSON.parse(fs.readFileSync('./db.json')); if(!db.likes) db.likes={}; if(!db.topup) db.topup={}; }catch(e){ db = { users: {}, groups: {}, pendings: {}, likes: {}, topup: {} }; }
}
function save(){ fs.writeFileSync('./db.json', JSON.stringify(db,null,2)); }
const TOPUP_RATES = { 20:120, 50:300, 80:500, 100:700, 200:1600, 500:4500 };
const CITY_COORDS = { "manila":[14.5995,120.9842], "quezon city":[14.6760,121.0437], "cebu":[10.3157,123.8854], "davao":[7.1907,125.4553], "tokyo":[35.6762,139.6503], "seoul":[37.5665,126.9780], "singapore":[1.3521,103.8198] };
function getDistance(l1,l2){
 const c1=CITY_COORDS[l1?.toLowerCase()]||[14.5995,120.9842];
 const c2=CITY_COORDS[l2?.toLowerCase()]||[14.5995,120.9842];
 const R=6371; const dLat=(c2[0]-c1[0])*Math.PI/180; const dLon=(c2[1]-c1[1])*Math.PI/180;
 const a=Math.sin(dLat/2)**2 + Math.cos(c1[0]*Math.PI/180)*Math.cos(c2[0]*Math.PI/180)*Math.sin(dLon/2)**2;
 return (R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))).toFixed(1);
}
function send(id,text,qr=null){
 const body={ recipient:{id}, message:{ text } };
 if(qr) body.message.quick_replies=qr;
 fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`,{ method:"POST", headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }).catch(()=>{});
}
function sendImage(id,url){
 fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`,{ method:"POST", headers:{'Content-Type':'application/json'}, body:JSON.stringify({ recipient:{id}, message:{ attachment:{ type:"image", payload:{ url, is_reusable:true } } } }) }).catch(()=>{});
}function sendButtons(id,type){
 if(type==="TOPUP_MENU"){
   return send(id, `💰 JOJOWORLD TOP-UP CENTER
━━━━━━━━━━━━━━━━━━━━
🔒 Locked Amount - Secure Payment
💎 Instant Coins After Payment

Available Packages:
💰 P20 = 120 Coins
💰 P50 = 300 Coins
💰 P80 = 500 Coins ⭐ Best Seller
💰 P100 = 700 Coins
💰 P200 = 1600 Coins
💰 P500 = 4500 Coins

Select a package:`,[
     {content_type:"text", title:"💰 P20 = 120c", payload:"TOP UP 20"},
     {content_type:"text", title:"💰 P50 = 300c", payload:"TOP UP 50"},
     {content_type:"text", title:"⭐ P80 = 500c", payload:"TOP UP 80"},
     {content_type:"text", title:"💰 P100 = 700c", payload:"TOP UP 100"},
     {content_type:"text", title:"💰 P200 = 1600c", payload:"TOP UP 200"},
     {content_type:"text", title:"💰 P500 = 4500c", payload:"TOP UP 500"},
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
   return send(id, `💘 NEARBY IN ${u.location? u.location.toUpperCase() : "MANILA"}
━━━━━━━━━━━━━━━━━━━━
👩 Anna, 22 • 0.5km away
📍 Quezon City • ⭐ 5.0 (128 votes)
💬 "Coffee lover, travel enthusiast. Looking for genuine connection."
🎂 Single • ♒ Aquarius • 💼 Coffee & Travel

This is a demo profile. More users coming soon!`, [
     {content_type:"text", title:"❤️ Like", payload:"LIKE Anna"},
     {content_type:"text", title:"⏭️ Next", payload:"NEAR ME"},
     {content_type:"text", title:"↩️ Menu", payload:"MENU"}
   ]);
 }
 const dist = getDistance(u.location, target.location);
 send(id, `💘 DISCOVER - ${target.location.toUpperCase()}
━━━━━━━━━━━━━━━━━━━━
👤 ID: ${targetId.slice(-6)} • ${dist}km away
📍 ${target.location} • ⭐ ${target.rating} (${target.votes||0} votes)
💬 "${target.bio||"No bio yet"}"
💼 Interests: ${target.interests||"Not set"}
🎂 ${target.status||"Single"} • ♒ ${target.zodiac||"Aquarius"}

Interested?`, [
   {content_type:"text", title:"❤️ Like", payload:"LIKE "+targetId},
   {content_type:"text", title:"💬 Message", payload:"CHAT "+targetId},
   {content_type:"text", title:"⏭️ Next", payload:"NEAR ME"},
   {content_type:"text", title:"↩️ Menu", payload:"MENU"}
 ]);
}
function sendProfile(id){
 const u = db.users[id];
 send(id, `👤 YOUR PROFILE
━━━━━━━━━━━━━━━━━━━━
📛 Name: ${u.name||"Not set"}
📍 Location: ${u.location||"Not set"}
💬 Bio: ${u.bio||"No bio yet"}
💼 Interests: ${u.interests||"Not set"}
🎂 Status: ${u.status||"Single"}
♒ Zodiac: ${u.zodiac||"Not set"}
💰 Coins: ${u.coins||0}c
⭐ Rating: ${u.rating||5.0} (${u.votes||0} votes)
📸 Photos: ${u.photos?.length||0}/3

Professional Dating Profile`,[
   {content_type:"text", title:"✏️ Edit Bio", payload:"EDIT BIO"},
   {content_type:"text", title:"📍 Edit Location", payload:"EDIT LOCATION"},
   {content_type:"text", title:"💰 Wallet", payload:"WALLET"},
   {content_type:"text", title:"↩️ Menu", payload:"MENU"}
 ]);
}
app.get('/', (req,res)=>{ res.send('JojoWorld V22 Professional English - Live!'); });
app.get('/webhook', (req,res)=>{
 if(req.query['hub.verify_token']===VERIFY_TOKEN) res.send(req.query['hub.challenge']);
 else res.send('Error');
});app.post('/webhook/paymongo', express.json(), (req,res)=>{
 const ev = req.body;
 if(ev.data?.attributes?.type==="link" && ev.data?.attributes?.data?.attributes?.status==="paid"){
   const amt = ev.data.attributes.data.attributes.amount/100;
   const ref = ev.data.attributes.data.attributes.remarks;
   if(db.topup[ref] && db.topup[ref].status==="PENDING" && db.topup[ref].amount===amt){
     db.topup[ref].status="PAID";
     db.users[db.topup[ref].userId].coins += db.topup[ref].coins;
     save();
     send(db.topup[ref].userId, `🎉 PAYMENT CONFIRMED!
━━━━━━━━━━━━━━━━━━━━
✅ Amount Paid: P${amt} (Locked & Verified)
💰 Coins Added: +${db.topup[ref].coins}c
💼 New Balance: ${db.users[db.topup[ref].userId].coins}c
📋 Reference: ${ref}
Thank you!`);
   }
 }
 res.sendStatus(200);
});

app.post('/webhook', async (req,res)=>{
 const entry = req.body.entry?.[0];
 const messaging = entry?.messaging?.[0];
 if(!messaging) return res.sendStatus(200);
 const sender = messaging.sender.id;
 const text = messaging.message?.text || messaging.postback?.payload || "";
 const upText = text.toUpperCase().trim();
 if(!db.users[sender]) db.users[sender]={ coins:100, rating:5.0, votes:0, photos:[], name:"User", location:"Manila", bio:"No bio yet", interests:"Not set", status:"Single", zodiac:"Aquarius" };
 const u = db.users[sender];

 if(u.step==="EDIT_BIO"){
   if(text.length>100){ send(sender,"❌ Bio too long! Max 100 chars. Try again:"); return res.sendStatus(200); }
   const free=!u.bioEdited;
   if(!free && (u.coins||0)<10){ send(sender,"❌ Need 10c to edit bio."); return res.sendStatus(200); }
   u.bio=text; u.step=null; if(!free) u.coins-=10; else u.bioEdited=true; save();
   send(sender, `✅ Bio updated!\n💬 "${u.bio}"\n💰 Balance: ${u.coins}c`); sendProfile(sender); return res.sendStatus(200);
 }
 if(u.step==="EDIT_LOCATION"){ u.location=text; u.step=null; save(); send(sender, `✅ Location updated to ${u.location}!`); sendProfile(sender); return res.sendStatus(200); }

 const t = upText;
 if(t.includes("PROFILE")){ sendProfile(sender); return res.sendStatus(200); }
 if(t.includes("MENU")){ sendButtons(sender,"MENU"); return res.sendStatus(200); }
 if(t.includes("WALLET")){ send(sender, `💼 WALLET OVERVIEW\n━━━━━━━━━━━━━━━━━━━━\n💰 Balance: ${u.coins||0}c\n📛 Account: ${u.name}\n⭐ Premium Member`); return res.sendStatus(200); }
 if(t.includes("DAILY")){
   const now=new Date(); const last=u.lastDaily?new Date(u.lastDaily):null;
   if(last && (now-last)/1000/3600<24){ send(sender, `⏰ Daily bonus already claimed! Come back after 24h.\n💰 Balance: ${u.coins}c`); return res.sendStatus(200); }
   u.coins=(u.coins||0)+20; u.lastDaily=now.toISOString(); save();
   send(sender, `🎁 DAILY BONUS CLAIMED!\n━━━━━━━━━━━━━━━━━━━━\n✅ +20 Coins Added!\n💰 New Balance: ${u.coins}c\nCome back tomorrow!`); return res.sendStatus(200);
 }
 if(t.includes("FIND MATCH")){ send(sender, `💘 FINDING YOUR MATCH...\n━━━━━━━━━━━━━━━━━━━━\n🔍 Searching nearby...\n📍 Location: ${u.location||"Manila"}\nPlease wait...`); setTimeout(()=>{ sendNearMe(sender, "demo_anna"); },1500); return res.sendStatus(200); }
 if(t.includes("NEAR ME") &&!t.includes("GROUP") &&!t.includes("WORLD")){ sendNearMe(sender, "demo_anna"); return res.sendStatus(200); }
 if(t.includes("NEAR WORLD") || t==="WORLD" || t.includes("WORLD")){ send(sender, `🌍 WORLD DISCOVERY\n━━━━━━━━━━━━━━━━━━━━\n👩 Sakura, 23 • Tokyo - 3000km away\n📍 Tokyo • ⭐ 4.9 (89 votes)\n💬 "Looking for friends worldwide!"\nInterested?`,[ {content_type:"text", title:"❤️ Like", payload:"LIKE Sakura"}, {content_type:"text", title:"⏭️ Next", payload:"NEAR WORLD"}, {content_type:"text", title:"↩️ Menu", payload:"MENU"} ]); return res.sendStatus(200); }
 if(t.includes("NEAR GROUP") || t.includes("GROUPS")){ send(sender, `👥 GROUPS\n━━━━━━━━━━━━━━━━━━━━\n📍 Manila Singles - 1.2k members\n📍 Cebu Friends - 800 members\n\nJoin a group?`,[ {content_type:"text", title:"👥 Join Manila", payload:"JOIN MANILA"}, {content_type:"text", title:"↩️ Menu", payload:"MENU"} ]); return res.sendStatus(200); }
 if(t.includes("LEADERBOARD")){ send(sender, `🏆 LEADERBOARD\n━━━━━━━━━━━━━━━━━━━━\n1. Anna - ⭐ 5.0 (128 votes)\n2. Sakura - ⭐ 4.9 (89 votes)\n3. You - ⭐ ${u.rating||5.0} (${u.votes||0})\n\nKeep getting likes!`); return res.sendStatus(200); }
 if(t.includes("EDIT BIO")){ u.step="EDIT_BIO"; save(); send(sender, `✏️ EDIT BIO\n━━━━━━━━━━━━━━━━━━━━\nCurrent: ${u.bio||"No bio"}\nSend your new bio (max 100 chars):\nFirst edit FREE, next 10c`); return res.sendStatus(200); }
 if(t.includes("EDIT LOCATION") || t.includes("EDIT LOC")){ u.step="EDIT_LOCATION"; save(); send(sender, `📍 EDIT LOCATION\n━━━━━━━━━━━━━━━━━━━━\nCurrent: ${u.location||"Not set"}\nSend new location (e.g., Manila, Cebu, Tokyo):`); return res.sendStatus(200); }
 if(t==="TOP UP" || t==="TOPUP" || t.includes("TOP UP MENU")){ sendButtons(sender,"TOPUP_MENU"); return res.sendStatus(200); }
 if(t.startsWith("TOP UP")){
   let amt=parseInt(t.replace(/[^0-9]/g,''))||0;
   if(!TOPUP_RATES[amt]){ send(sender, `❌ Invalid Package. Locked list only:\nP20=120c, P50=300c, P80=500c, P100=700c, P200=1600c, P500=4500c`); return res.sendStatus(200); }
   const coins=TOPUP_RATES[amt]; const ref="JW-"+Math.random().toString(36).substring(2,6).toUpperCase()+"-"+Date.now().toString().slice(-4);
   if(PAYMONGO_SECRET){
     try{
       const r=await fetch('https://api.paymongo.com/v1/links',{ method:'POST', headers:{ 'Authorization':'Basic '+Buffer.from(PAYMONGO_SECRET+':').toString('base64'), 'Content-Type':'application/json' }, body: JSON.stringify({ data:{ attributes:{ amount:amt*100, description:`JojoWorld ${coins} Coins - ${ref}`, remarks:ref } } }) });
       const j=await r.json(); const url=j.data.attributes.checkout_url; const qr=`https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(url)}`;
       db.topup[ref]={ userId:sender, amount:amt, coins, status:"PENDING" }; save();
       send(sender, `💰 TOP-UP ORDER - P${amt} = ${coins} Coins\n━━━━━━━━━━━━━━━━━━━━\n🔒 Locked Amount: P${amt}\n💳 Payment Link: ${url}\n📋 Reference: ${ref}\nPlease complete payment. Coins auto-added.`); sendImage(sender,qr);
     }catch(e){ send(sender,"⚠️ Error generating payment link. Please try again."); }
   }else{
     const qr=`https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=GCash-${GCASH_NUM}-P${amt}-Ref-${ref}-LOCKED`;
     db.topup[ref]={ userId:sender, amount:amt, coins, status:"PENDING_MANUAL" }; save();
     send(sender, `💰 TOP-UP ORDER - P${amt} = ${coins} Coins\n━━━━━━━━━━━━━━━━━━━━\n🔒 Locked Amount: P${amt}\n💳 GCash: ${GCASH_NUM}\n📋 Reference: ${ref}\nPlease send P${amt} exactly and submit screenshot.`); sendImage(sender,qr);
   }
   return res.sendStatus(200);
 }
 sendButtons(sender,"MENU");
 res.sendStatus(200);
});
app.listen(process.env.PORT||10000, ()=>console.log("V22 Professional English Live - All Buttons Fixed"));
