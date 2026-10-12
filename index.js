app.post('/webhook', async (req,res)=>{
  const messaging = req.body.entry?.[0]?.messaging?.[0];
  if(!messaging) return res.sendStatus(200);

  // FIX #1 - IGNORE DELIVERY AT READ PARA HINDI MAG SPAM
  if(messaging.delivery || messaging.read) return res.sendStatus(200);

  const sender = messaging.sender.id;
  let text = messaging.message?.text || messaging.message?.quick_reply?.payload || messaging.postback?.payload || "";
  text = text.trim();
  const upText = text.toUpperCase();

  if(!db.users[sender]){
    db.users[sender] = { id:sender, step:"new", coins:100, pics:[], match:null, group:null, rating:5, votes:0, badges:[], streak:0, lastDaily:null, bio:"Wala pa", interests:"Wala pa", status:"Single", birthday:null, zodiac:"", location:"Manila" };
    save();
  }

  // TOP UP
  if(upText.includes("TOP UP") || upText==="TOPUP" || upText==="TOP UP RATES"){
    sendButtons(sender,"TOPUP_MENU");
    return res.sendStatus(200);
  }
  // MENU
  if(upText==="MENU" || upText==="MAIN MENU"){
    sendButtons(sender,"MAIN_MENU");
    return res.sendStatus(200);
  }
  // PROFILE
  if(upText==="PROFILE"){
    const u = db.users[sender];
    send(sender,`👤 PROFILE\nCoins: ${u.coins}\nLocation: ${u.location}\nBio: ${u.bio}\nZodiac: ${u.zodiac||"Wala pa"}\n\nType MENU para bumalik`);
    return res.sendStatus(200);
  }
  // WALLET
  if(upText==="WALLET"){
    send(sender,`💼 Wallet: ${db.users[sender].coins} coins\nGCash: ${GCASH_NUM}\nPayPal: ${PAYPAL_EMAIL}`);
    return res.sendStatus(200);
  }
  // DAILY
  if(upText==="DAILY"){
    db.users[sender].coins += 20;
    save();
    send(sender,`🎁 Daily reward! +20 coins! Total: ${db.users[sender].coins}`);
    return res.sendStatus(200);
  }
  // TOPUP GCASH/PAYPAL
  if(upText.startsWith("TOPUP GCASH") || upText.startsWith("TOPUP PAYPAL")){
    send(sender,`✅ Pending Top Up: ${text}\nSend payment to:\nGCash: ${GCASH_NUM}\nPayPal: ${PAYPAL_EMAIL}\nTapos send mo screenshot kay Admin.`);
    return res.sendStatus(200);
  }

  // FIX #2 - DAGDAG YUNG MGA KULANG!
  if(upText==="NEAR ME"){
    const u = db.users[sender];
    send(sender,`💘 NEAR ME - Malapit sayo sa ${u.location}:\n\n👩 Anna - 0.5km (${getDistance(u.location,"manila")}km)\n👩 Liza - 1.2km away\n👨 Mark - 2km away\n\nType MENU para bumalik`);
    return res.sendStatus(200);
  }
  if(upText==="NEAR WORLD"){
    send(sender,`🌍 NEAR WORLD - WORLDWIDE:\n\n🌏 Tokyo - Yuki - 0.3km\n🌏 Seoul - Jisoo online\n🌏 USA - Jessica online\n\nType MENU`);
    return res.sendStatus(200);
  }
  if(upText==="NEAR GROUP"){
    send(sender,`👥 NEAR GROUP:\n\n1. San Jose Singles (12 online)\n2. JojoWorld Tambayan (45 online)\n\nType MENU`);
    return res.sendStatus(200);
  }
  if(upText==="LEADERBOARD"){
    send(sender,`🏆 LEADERBOARD TOP 5:\n1. Anna - 5⭐\n2. Liza - 4.9⭐\n3. Mark - 4.8⭐\n\nType MENU`);
    return res.sendStatus(200);
  }

  // DEFAULT MENU
  sendButtons(sender,"MAIN_MENU");
  return res.sendStatus(200);
});
