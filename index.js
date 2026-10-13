// JOJOWORLD V23 FINAL - MONGODB + PAYMONGO - FOR J'S
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
const VERIFY_TOKEN = "jojoworld_v22";
const MONGODB_URI = process.env.MONGODB_URI;

// MONGODB
if(MONGODB_URI){
  mongoose.connect(MONGODB_URI).then(()=>console.log("✅ MongoDB OK")).catch(e=>console.log(e.message));
}
const UserSchema = new mongoose.Schema({ psid:String, data:Object },{strict:false});
const UserModel = mongoose.models.JUser || mongoose.model('JUser', UserSchema);

let db = { users: {}, groups: {}, pendings: {}, likes: {}, topup: {} };
if (fs.existsSync('./db.json')){
  try{
    db = JSON.parse(fs.readFileSync('./db.json'));
    if(!db.likes) db.likes={};
    if(!db.topup) db.topup={};
  }catch(e){}
}

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
  "manila":[14.5995,120.9842], "quezon city":[14.6760,121.0437],
  "cebu":[10.3157,123.8854], "davao":[7.1907,125.4553],
  "tokyo":[35.6762,139.6503], "seoul":[37.5665,126.9780],
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

function send(id,text,qr=null){
  const body={ recipient:{id}, message:{ text } };
  if(qr) body.message.quick_replies=qr;
  fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`,{
    method:"POST", headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
  }).catch(()=>{});
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
    console.log(e.response?.data||e.message);
    return null;
  }
}// ===== PART B =====
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
    {content_type:"text", title:"💰 Top Up", payload:"TOP UP"},
    {content_type:"text", title:"🎁 Daily Bonus", payload:"DAILY"}
  ]);
}

function sendNearMe(id, targetId){
  const u = db.users[id];
  const target = db.users[targetId];
  if(!target){
    return send(id, `💘 NEARBY IN ${u?.location?.toUpperCase() || "MANILA"}
━━━━━━━━━━━━━━━━━━━━
👩 Anna, 22 • 0.5km away
📍 Quezon City • ⭐ 5.0 (128 votes)
💬 "Coffee lover, travel enthusiast."

This is a demo profile. More users coming soon!`,[
      {content_type:"text", title:"❤️ Like", payload:"LIKE Anna"},
      {content_type:"text", title:"⏭️ Next", payload:"NEAR ME"},
      {content_type:"text", title:"↩️ Menu", payload:"MENU"}
    ]);
  }
  const dist = getDistance(u.location, target.location);
  send(id, `💘 DISCOVER - ${target.location.toUpperCase()}
━━━━━━━━━━━━━━━━━━━━
👤 ID: ${targetId.slice(-6)} • ${dist}km away
📍 ${target.location} • ⭐ ${target.rating||5.0}
💬 "${target.bio||"No bio yet"}"`,[
    {content_type:"text", title:"❤️ Like", payload:"LIKE "+targetId},
    {content_type:"text", title:"⏭️ Next", payload:"NEAR ME"},
    {content_type:"text", title:"↩️ Menu", payload:"MENU"}
  ]);
              }// ===== PART C - MAIN WEBHOOK =====
app.get('/webhook', (req,res)=>{
  if(req.query['hub.verify_token']===VERIFY_TOKEN){
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/paymongo-webhook', async (req,res)=>{
  try{
    const ev = req.body.data;
    if(!ev) return res.sendStatus(200);
    const attr = ev.attributes?.data?.attributes || ev.attributes;
    const status = attr.status;
    const remarks = attr.remarks;
    const amount = attr.amount;
    console.log("PAYMONGO:", status, amount, remarks);
    if(status==='paid' && remarks){
      let amt = Math.round(amount/100);
      let coins = TOPUP_RATES[amt] || 0;
      if(coins>0 && db.users[remarks]){
        db.users[remarks].coins = (db.users[remarks].coins||0) + coins;
        await save();
        await send(remarks, `✅ PAYMENT RECEIVED!\n💰 +${coins} Coins Added!\n💎 Balance: ${db.users[remarks].coins} coins\n\nThanks boss! 🚀`);
      }
    }
  }catch(e){ console.log("webhook err", e.message); }
  res.sendStatus(200);
});

app.post('/webhook', async (req,res)=>{
  try{
    const body = req.body;
    if(body.object!=='page') return res.sendStatus(200);

    for(const entry of body.entry){
      for(const ev of entry.messaging){
        const psid = ev.sender.id;
        if(!db.users[psid]) db.users[psid] = { coins:100, location:"Manila", rating:5.0, bio:"No bio", created:Date.now() };

        // QUICK REPLY HANDLER
        if(ev.message && ev.message.quick_reply){
          let payload = ev.message.quick_reply.payload;
          console.log("QR:", payload, psid);

          if(payload.startsWith("TOP UP")){
            let amt = parseInt(payload.split(" ").pop());
            let coins = TOPUP_RATES[amt];
            if(!coins){ send(psid, "Invalid package"); continue; }
            send(psid, `⏳ Creating secure link for P${amt} = ${coins} coins...`);
            let link = await createPaymongoLink(amt, coins, psid);
            if(link){
              send(psid, `💎 JOJOWORLD PAYMENT\n━━━━━━━━━━━━\n💰 P${amt} = ${coins} Coins\n🔒 PayMongo Secure\n💳 GCash / Card / Maya\n\n👇 Click to Pay:\n${link}\n\n✅ Auto coins after pay!`, [{content_type:"text", title:"↩️ Menu", payload:"MENU"}]);
            }else{
              send(psid, `❌ Failed to create link. Contact admin ${GCASH_NUM}`);
            }
            continue;
          }

          if(payload==="TOP UP"){ sendButtons(psid, "TOPUP_MENU"); continue; }
          if(payload==="MENU"){ sendButtons(psid, "MENU"); continue; }
          if(payload==="NEAR ME"){ sendNearMe(psid, null); continue; }
          if(payload==="DAILY"){
            let last = db.users[psid].lastDaily||0;
            if(Date.now()-last < 86400000){ send(psid, `🎁 Already claimed! Come back tomorrow.`); }
            else{ db.users[psid].coins+=20; db.users[psid].lastDaily=Date.now(); save(); send(psid, `🎁 Daily +20 coins! Balance: ${db.users[psid].coins}`); }
            continue;
          }
          if(payload==="PROFILE"){
            let u = db.users[psid];
            send(psid, `👤 YOUR PROFILE\nCoins: ${u.coins}\nLocation: ${u.location||"Not set"}\n\nType: coins to check balance`);
            continue;
          }
        }

        // TEXT HANDLER
        if(ev.message && ev.message.text){
          let text = ev.message.text.toLowerCase().trim();
          console.log("TEXT:", text);

          if(text==="menu" || text==="start"){ sendButtons(psid, "MENU"); continue; }
          if(text==="top up" || text==="topup" || text==="top-up"){ sendButtons(psid, "TOPUP_MENU"); continue; }
          if(text.startsWith("buy ")){
            let amt = parseInt(text.split(" ")[1]);
            let coins = TOPUP_RATES[amt];
            if(!coins){ send(psid, `Available: 20,50,80,100,200,500`); continue; }
            let link = await createPaymongoLink(amt, coins, psid);
            if(link) send(psid, `💰 P${amt} = ${coins} coins\n👇 ${link}`);
            continue;
          }
          if(text==="coins" || text==="balance"){
            send(psid, `💰 Balance: ${db.users[psid].coins} coins\nType TOP UP to buy!`);
            continue;
          }
          // default
          if(!ev.message.quick_reply){
             sendButtons(psid, "MENU");
          }
        }
      }
    }
  }catch(e){ console.log(e.message); }
  res.sendStatus(200);
});

app.get('/', (req,res)=> res.send('JojoWorld V23 Running - MongoDB + PayMongo OK'));
app.listen(process.env.PORT||10000, ()=>console.log("V23 Running"));
