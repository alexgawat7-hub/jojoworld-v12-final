// JOJOWORLD V22 - ENGLISH PROFESSIONAL - FOR J'S
// Monggo Only, Locked QR, No PayPal Email
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
 try{
   db = JSON.parse(fs.readFileSync('./db.json'));
   if(!db.likes) db.likes={};
   if(!db.topup) db.topup={};
 }catch(e){ db = { users: {}, groups: {}, pendings: {}, likes: {}, topup: {} }; }
}
function save(){ fs.writeFileSync('./db.json', JSON.stringify(db,null,2)); }

const TOPUP_RATES = { 20:120, 50:300, 80:500, 100:700, 200:1600, 500:4500 };

const CITY_COORDS = {
  "manila":[14.5995,120.9842], "quezon city":[14.6760,121.0437],
  "cebu":[10.3157,123.8854], "davao":[7.1907,125.4553],
  "tokyo":[35.6762,139.6503], "seoul":[37.5665,126.9780], "singapore":[1.3521,103.8198]
};
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
 fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`,{
   method:"POST", headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
 }).catch(e=>console.log(e.message));
}
function sendImage(id,url){
 fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`,{
   method:"POST", headers:{'Content-Type':'application/json'},
   body:JSON.stringify({ recipient:{id}, message:{ attachment:{ type:"image", payload:{ url, is_reusable:true } } } })
 });
}
function sendButtons(id,type){
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
   return send(id, `💘 NEARBY IN ${u.location.toUpperCase()}
━━━━━━━━━━━━━━━━━━━━
👩 Anna, 22 • 0.5km away
📍 Quezon City • ⭐ 5.0 (128 votes)
💬 "Coffee lover, travel enthusiast. Looking for genuine connection."
🎂 Single • ♒ Aquarius • 💼 Coffee & Travel
This is a demo profile. More users coming soon!
What would you like to do?`, [
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
});

app.post('/webhook/paymongo', express.json(), (req,res)=>{
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

Thank you for topping up!`);
   }
 }
 res.sendStatus(200);
});

app.post('/webhook', async (req,res)=>{
 const messaging = req.body.entry?.[0]?.messaging?.[0];
 if(!messaging) return res.sendStatus(200);
 const sender = messaging.sender.id;
 const text = messaging.message?.text || messaging.postback?.payload || "";
 const upText = text.toUpperCase().trim();
 if(!db.users[sender]) db.users[sender]={ coins:0, rating:5.0, votes:0, photos:[], name:"" };
 const u = db.users[sender];

 if(upText==="PROFILE"){ sendProfile(sender); return res.sendStatus(200); }
 if(upText==="MENU"){ sendButtons(sender,"MENU"); return res.sendStatus(200); }
 if(upText==="WALLET"){ send(sender, `💼 WALLET OVERVIEW\n━━━━━━━━━━━━━━━━━━━━\n💰 Balance: ${u.coins}c\n📛 Account: ${u.name}\n⭐ Premium Member`); return res.sendStatus(200); }
 if(upText==="TOP UP" || upText==="TOPUP_MENU"){ sendButtons(sender,"TOPUP_MENU"); return res.sendStatus(200); }
 if(upText.startsWith("TOP UP")){
   let amt = parseInt(upText.replace(/[^0-9]/g,''))||0;
   if(!TOPUP_RATES[amt]){ send(sender, `❌ Invalid Package. Please select from locked price list:\nP20=120c, P50=300c, P80=500c, P100=700c, P200=1600c, P500=4500c`); return res.sendStatus(200); }
   const coins = TOPUP_RATES[amt];
   const ref = "JW-"+Math.random().toString(36).substring(2,6).toUpperCase()+"-"+Date.now().toString().slice(-4);
   if(PAYMONGO_SECRET){
     try{
       const r = await fetch('https://api.paymongo.com/v1/links',{
         method:'POST',
         headers:{ 'Authorization':'Basic '+Buffer.from(PAYMONGO_SECRET+':').toString('base64'), 'Content-Type':'application/json' },
         body: JSON.stringify({ data:{ attributes:{ amount:amt*100, description:`JojoWorld ${coins} Coins - ${ref}`, remarks:ref } } })
       });
       const j = await r.json();
       const url = j.data.attributes.checkout_url;
       const qr = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(url)}`;
       db.topup[ref]={ userId:sender, amount:amt, coins, status:"PENDING" };
       save();
       send(sender, `💰 TOP-UP ORDER - P${amt} = ${coins} Coins\n━━━━━━━━━━━━━━━━━━━━\n🔒 Locked Amount: P${amt}\n💳 Payment Link: ${url}\n📋 Reference: ${ref}\n\nPlease complete payment. Coins will be added automatically within 5 seconds after payment.`);
       sendImage(sender,qr);
     }catch(e){ send(sender,"⚠️ Error generating payment link. Please try again."); }
   }else{
     const qr = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=GCash-${GCASH_NUM}-P${amt}-Ref-${ref}-LOCKED`;
     db.topup[ref]={ userId:sender, amount:amt, coins, status:"PENDING_MANUAL" };
     save();
     send(sender, `💰 TOP-UP ORDER - P${amt} = ${coins} Coins\n━━━━━━━━━━━━━━━━━━━━\n🔒 Locked Amount: P${amt}\n💳 GCash: ${GCASH_NUM}\n📋 Reference: ${ref}\n\nPlease send P${amt} exactly and submit your screenshot with reference number.`);
     sendImage(sender,qr);
   }
   return res.sendStatus(200);
 }
 res.sendStatus(200);
});

app.listen(process.env.PORT||10000, ()=>console.log("V22 English Professional Live"));
