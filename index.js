const express = require('express');
const bodyParser = require('body-parser');
const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = "jojoworld_verify_2024";

app.get('/', (req,res)=>{
  res.send('JojoWorld V12 is Live! Ready for Webhook!');
});

app.get('/webhook', (req,res)=>{
  if(req.query['hub.verify_token']===VERIFY_TOKEN){
    res.send(req.query['hub.challenge']);
  }else{ res.send('Error'); }
});

app.post('/webhook', (req,res)=>{
  console.log('Message received!');
  res.status(200).send('EVENT_RECEIVED');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>{ console.log('Live on '+PORT); });
