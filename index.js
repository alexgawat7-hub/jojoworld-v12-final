// JOJOWORLD V12 FINAL WITH MATCHING
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const app = express();
app.use(bodyParser.json());

const ADMIN_ID = "100064525073153";
const GCASH_NUM = "09517080795";
const PAYPAL_EMAIL = "alexgawat7@gmail.com";
const PAGE_TOKEN = process.env.PAGE_TOKEN;
const VERIFY_TOKEN = "jojoworld_v12";

let db = { users: {}, groups: {}, pendings: {}, likes: {} };
if (fs.existsSync('./db.json')){
  try{ db = JSON.parse(fs.readFileSync('./db.json')); if(!db.likes) db.likes={}; }catch(e){ db = { users: {}, groups: {}, pendings: {}, likes: {} }; }
}
function save(){ fs.writeFileSync('./db.json', JSON.stringify(db,null,2)); }

const CITY_COORDS = {
  "manila": [14.5995,120.9842], "quezon city": [14.6760,121.0437], "cebu": [10.3157,123.8854], "davao": [7.1907,125.4553],
  "tokyo": [35.6762,139.6503], "seoul": [37.5665,126.9780], "singapore": [1.3521,103.8198]
};
function getDistance(loc1, loc2){
  const c1 = CITY_COORDS[loc1?.toLowerCase()] || [14.5995,120.9842];
  const c2 = CITY_COORDS[loc2?.toLowerCase()] || [14.5995,120.9842];
  const R=6371; const dLat=(c2[0]-c1[0])*Math.PI/180; const dLon=(c2[1]-c1[1])*Math.PI/180;
  const a=Math.sin(dLat/2)**2 + Math.cos(c1[0]*Math.PI/180)*Math.cos(c2[0]*Math.PI/180)*Math.sin(dLon/2)**2;
  return (R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))).toFixed(1);
}

function send(id, text, quick_replies=null){
  const body={ recipient:{id}, message:{ text } };
  if(quick_replies) body.message.quick_replies = quick_replies;
  fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`,{ method:"POST", headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
}
function sendButtons(id, type){
  if(type==="TOPUP_MENU"){
    return send(id, "💰 TOP UP - Pindot lang boss:",[
      {content_type:"text", title:"GCash P50=300c", payload:"TOPUP GCASH 50"},
      {content_type:"text", title:"GCash P100=700c", payload:"TOPUP GCASH 100"},
      {content_type:"text", title:"Rates", payload:"TOP UP RATES"}
    ]);
  }
  return send(id, "📋 JOJOWORLD MENU:",[
    {content_type:"text", title:"👤 Profile", payload:"PROFILE"},
    {content_type:"text", title:"💘 Near Me", payload:"NEAR ME"},
    {content_type:"text", title:"🌍 Near World", payload:"NEAR WORLD"},
    {content_type:"text", title:"👥 Near Group", payload:"NEAR GROUP"},
    {content_type:"text", title:"🏆 Top", payload:"LEADERBOARD"},
    {content_type:"text", title:"💰 Top Up", payload:"TOP UP"},
    {content_type:"text", title:"🎁 Daily", payload:"DAILY"},
    {content_type:"text", title:"💼 Wallet", payload:"WALLET"}
  ]);
}
function sendNearMe(id, targetId){
  const u = db.users[id];
  const target = db.users[targetId];
  if(!target){ return send(id, `💘 NEAR ME sa ${u.location}:\n\n👩 Anna - 0.5km\n👩 Liza - 1.2km\n\n(Wala pang real users, demo lang)\n`, [{content_type:"text", title:"❤️ Like Anna", payload:"LIKE Anna"}, {content_type:"text", title:"Next ➡️", payload:"NEAR ME"}, {content_type:"text", title:"Menu", payload:"MENU"}]); }
  const dist = getDistance(u.location, target.location);
  send(id, `💘 NEAR ME:\n\n👤 ${targetId.slice(0,5)} - ${dist}km\n📍 ${target.location}\n⭐ ${target.rating} rating\nBio: ${target.bio}\n\nGusto mo ba?`, [
    {content_type:"text", title:"❤️ Like", payload:"LIKE "+targetId},
    {content_type:"text", title:"Next ➡️", payload:"NEAR ME"},
    {content_type:"text", title:"Menu", payload:"MENU"}
  ]);
}

app.get('/', (req,res)=>{ res.send('JojoWorld V12 Live with Matching!'); });
app.get('/webhook', (req,res)=>{ if(req.query['hub.verify_token']===VERIFY_TOKEN) res.send(req.query['hub.challenge']); else res.send('Error'); });

app.post('/webhook', async (req,res)=>{
  const messaging = req.body.entry?.[0]?.messaging?.[0];
  if(!messaging) return res.sendStatus(200);
  if(messaging.delivery || messaging.read || messaging.message?.is_echo) return res.sendStatus(200);

  const sender = messaging.sender.id;
  let text = messaging.message?.quick_reply?.payload || messaging.postback?.payload || messaging.message?.text || "";
  text = text.trim();
  const upText = text.toUpperCase();

  if(!db.users[sender]){
    db.users[sender] = { id:sender, step:"new", coins:100, pics:[], match:null, group:null, rating:5, votes:0, badges:[], streak:0, lastDaily:null, bio:"Wala pa", interests:"Wala pa", status:"Single", birthday:null, zodiac:"", location:"Manila", likes:[], likedBy:[] };
    save();
  }
  if(!db.likes[sender]) db.likes[sender]=[];

  // MENU
  if(upText.includes("MENU")){ sendButtons(sender,"MAIN_MENU"); return res.sendStatus(200); }
  if(upText.includes("TOP UP")){ sendButtons(sender,"TOPUP_MENU"); return res.sendStatus(200); }
  if(upText.includes("PROFILE")){ const u=db.users[sender]; send(sender,`👤 PROFILE\nID: ${sender.slice(0,6)}\nCoins: ${u.coins}\nLocation: ${u.location}\nBio: ${u.bio}\nMatches: ${u.match? "May ka-match ❤️" : "Wala pa"}`); return res.sendStatus(200); }
  if(upText.includes("WALLET")){ send(sender,`💼 Wallet: ${db.users[sender].coins} coins\nGCash: ${GCASH_NUM}\nPayPal: ${PAYPAL_EMAIL}`); return res.sendStatus(200); }
  if(upText.includes("DAILY")){ db.users[sender].coins+=20; save(); send(sender,`🎁 +20 coins! Total: ${db.users[sender].coins}`); return res.sendStatus(200); }
  if(upText.includes("GCASH")||upText.includes("PAYPAL")){ send(sender,`✅ Pending: ${text}\nGCash: ${GCASH_NUM}\nPayPal: ${PAYPAL_EMAIL}`); return res.sendStatus(200); }

  // NEAR ME WITH MATCHING
  if(upText==="NEAR ME" || upText.includes("NEAR ME")){
    const allUsers = Object.keys(db.users).filter(id=>id!==sender);
    if(allUsers.length===0){
      sendNearMe(sender, null);
    } else {
      const randomId = allUsers[Math.floor(Math.random()*allUsers.length)];
      sendNearMe(sender, randomId);
    }
    return res.sendStatus(200);
  }

  // LIKE SYSTEM
  if(upText.startsWith("LIKE ")){
    const likedId = text.split(" ")[1];
    if(likedId==="Anna"){ send(sender,`❤️ You liked Anna! Kapag nagustuhan ka din niya, MATCH kayo! 🎉\n\nType NEAR ME para sa iba pa.`); return res.sendStatus(200); }
    if(!db.users[likedId]){ send(sender,`User not found. Type NEAR ME ulit.`); return res.sendStatus(200); }

    if(!db.likes[sender].includes(likedId)){ db.likes[sender].push(likedId); }
    if(!db.users[likedId].likedBy) db.users[likedId].likedBy=[];
    if(!db.users[likedId].likedBy.includes(sender)) db.users[likedId].likedBy.push(sender);
    save();

    // CHECK MATCH
    if(db.likes[likedId] && db.likes[likedId].includes(sender)){
      db.users[sender].match = likedId;
      db.users[likedId].match = sender;
      save();
      send(sender,`🎉 MATCH! ❤️❤️\n\nYou and ${likedId.slice(0,5)} liked each other!\nChat na kayo! Type: HI ${likedId.slice(0,5)}`);
      send(likedId,`🎉 MATCH! ❤️❤️❤️\n\nYou and ${sender.slice(0,5)} liked each other!\nChat na kayo!`);
    } else {
      send(sender,`❤️ Liked ${likedId.slice(0,5)}! Kapag nilike ka din niya, MATCH kayo! 😉`, [{content_type:"text", title:"Next ➡️", payload:"NEAR ME"}, {content_type:"text", title:"Menu", payload:"MENU"}]);
    }
    return res.sendStatus(200);
  }

  if(upText.includes("NEAR WORLD")){ send(sender,`🌍 NEAR WORLD:\n🌏 Tokyo - Yuki online\n🌏 Seoul - Jisoo online\n\nType NEAR ME para maghanap`); return res.sendStatus(200); }
  if(upText.includes("NEAR GROUP")){ send(sender,`👥 NEAR GROUP:\n1. San Jose Singles (12 online)\n2. Tambayan (45 online)`); return res.sendStatus(200); }
  if(upText.includes("LEADERBOARD")||upText.includes("TOP")){ send(sender,`🏆 TOP 5:\n1. Anna - 5⭐\n2. Liza - 4.9⭐`); return res.sendStatus(200); }

  sendButtons(sender,"MAIN_MENU");
  return res.sendStatus(200);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>{ console.log('Live on '+PORT); });
