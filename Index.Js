// JOJOWORLD V12 WORLDWIDE - FINAL FIXED + BUTTONS
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

let db = { users: {}, groups: {}, pendings: {} };
if (fs.existsSync('./db.json')) db = JSON.parse(fs.readFileSync('./db.json'));
function save(){ fs.writeFileSync('./db.json', JSON.stringify(db,null,2)); }

// CITY COORDS FOR DISTANCE
const CITY_COORDS = {
  "manila": [14.5995,120.9842], "quezon city": [14.6760,121.0437], "cebu": [10.3157,123.8854],
  "davao": [7.1907,125.4553], "tokyo": [35.6762,139.6503], "osaka": [34.6937,135.5023],
  "seoul": [37.5665,126.9780], "beijing": [39.9042,116.4074], "shanghai": [31.2304,121.4737],
  "hong kong": [22.3193,114.1694], "singapore": [1.3521,103.8198], "bangkok": [13.7563,100.5018],
  "kuala lumpur": [3.1390,101.6869], "jakarta": [6.2088,106.8456], "dubai": [25.2048,55.2708],
  "london": [51.5074,-0.1278], "new york": [40.7128,-74.0060], "los angeles": [34.0522,-118.2437],
  "paris": [48.8566,2.3522], "berlin": [52.5200,13.4050], "rome": [41.9028,12.4964],
  "sydney": [33.8688,151.2093], "toronto": [43.6532,-79.3832], "mexico city": [19.4326,-99.1332]
};

function getDistance(loc1, loc2){
  const c1 = CITY_COORDS[loc1?.toLowerCase()] || [14.5995,120.9842];
  const c2 = CITY_COORDS[loc2?.toLowerCase()] || [14.5995,120.9842];
  const R=6371; const dLat=(c2[0]-c1[0])*Math.PI/180; const dLon=(c2[1]-c1[1])*Math.PI/180;
  const a=Math.sin(dLat/2)**2 + Math.cos(c1[0]*Math.PI/180)*Math.cos(c2[0]*Math.PI/180)*Math.sin(dLon/2)**2;
  return (R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))).toFixed(1);
}
function zodiac(m,d){
  if((m==3&&d>=21)||(m==4&&d<=19))return "♈ Aries"; if((m==4&&d>=20)||(m==5&&d<=20))return "♉ Taurus";
  if((m==5&&d>=21)||(m==6&&d<=20))return "♊ Gemini"; if((m==6&&d>=21)||(m==7&&d<=22))return "♋ Cancer";
  if((m==7&&d>=23)||(m==8&&d<=22))return "♌ Leo"; if((m==8&&d>=23)||(m==9&&d<=22))return "♍ Virgo";
  if((m==9&&d>=23)||(m==10&&d<=22))return "♎ Libra"; if((m==10&&d>=23)||(m==11&&d<=21))return "♏ Scorpio";
  if((m==11&&d>=22)||(m==12&&d<=21))return "♐ Sagittarius"; if((m==12&&d>=22)||(m==1&&d<=19))return "♑ Capricorn";
  if((m==1&&d>=20)||(m==2&&d<=18))return "♒ Aquarius"; return "♓ Pisces";
}
function send(id, text, quick_replies=null){
  const body={ recipient:{id}, message:{ text } };
  if(quick_replies) body.message.quick_replies = quick_replies;
  fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`,{
    method:"POST", headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
}
function sendButtons(id, text){
  // TOP UP BUTTONS + MENU BUTTONS
  if(text==="TOPUP_MENU"){
    return send(id, "💰 TOP UP - Pindot lang boss para madali:",[
      {content_type:"text", title:"GCash P50=300c", payload:"TOPUP GCASH 50"},
      {content_type:"text", title:"GCash P100=700c", payload:"TOPUP GCASH 100"},
      {content_type:"text", title:"GCash P200=1600c", payload:"TOPUP GCASH 200"},
      {content_type:"text", title:"GCash P500=4500c", payload:"TOPUP GCASH 500"},
      {content_type:"text", title:"PayPal $5=700c", payload:"TOPUP PAYPAL 5"},
      {content_type:"text", title:"PayPal $10=1600c", payload:"TOPUP PAYPAL 10"},
      {content_type:"text", title:"📋 Rates", payload:"TOP UP RATES"},
      {content_type:"text", title:"📦 Pending", payload:"MY PENDING"}
    ]);
  }
  if(text==="MAIN_MENU"){
    return send(id, "📋 JOJOWORLD MENU - Pindot ka lang:",[
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
}

app.get('/webhook', (req,res)=>{
  if(req.query['hub.verify_token']===VERIFY_TOKEN) res.send(req.query['hub.challenge']);
  else res.send('Error');
});

app.post('/webhook', async (req,res)=>{
  const entry = req.body.entry?.[0]?.messaging?.[0];
  if(!entry) return res.sendStatus(200);
  const sender = entry.sender.id;
  let text = entry.message?.text || entry.message?.quick_reply?.payload || "";
  text = text.trim();
  const upText = text.toUpperCase();

  if(!db.users[sender]){
    db.users[sender] = { id:sender, step:"new", coins:0, pics:[], match:null, group:null, rating:5, votes:0, badges:[], streak:0, lastDaily:null, bio:"Wala pa", interests:"Wala pa", status:"Single", birthday:null, zodiac:"", location:"Manila
