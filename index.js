const line = require('@line/bot-sdk');
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis'); // 引入 Google API

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();

// --- 準備 Google Sheets 連線 ---
let sheets;
try {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  sheets = google.sheets({ version: 'v4', auth });
} catch (error) {
  console.error("Google 憑證載入失敗，請檢查 Render 環境變數", error);
}
// ------------------------------

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userText = event.message.text.trim();
  let replyText = '';

  // --- 新增：測試表單連線 ---
  if (userText === '測試表單') {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: 'A1:D1', // 只抓取第一列的標題來測試
      });
      const rows = response.data.values;
      
      if (rows && rows.length > 0) {
        replyText = `🎉 太棒了！成功連線到你的試算表！\n\n我抓到的標題是：\n[ ${rows[0].join(', ')} ]\n\n這代表大腦跟資料庫已經完全打通囉！`;
      } else {
        replyText = `有連上試算表，但裡面沒有資料喔！`;
      }
    } catch (err) {
      replyText = `⚠️ 連線失敗：${err.message}\n請檢查 Render 的環境變數，或是確認試算表有共用給服務帳戶的 Email！`;
    }
  }
  
  // --- 保留原本的功能 ---
  else if (userText === '匯率') {
    try {
      const res = await axios.get('https://api.exchangerate-api.com/v4/latest/JPY');
      const rate = res.data.rates.TWD;
      replyText = `【即時匯率】\n1 日圓 ≒ ${rate} 台幣\n換算：10,000日圓約為 ${Math.round(10000 * rate)} 台幣。`;
    } catch (e) { replyText = '無法取得匯率，請稍後再試。'; }
  }
  
  else {
    replyText = `超七秘助理為您服務！\n\n請輸入「測試表單」來確認資料庫是否連線成功！`;
  }

  return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Bot is running on port ${port}`));
