const line = require('@line/bot-sdk');
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');

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
  console.error("Google 憑證載入失敗", error);
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

  // --- 核心功能：動態讀取試算表行程 ---
  // 支援輸入 day1, Day 1, DAY1 等各種格式
  const formattedInput = userText.toUpperCase().replace(/\s+/g, ''); 
  
  if (formattedInput.startsWith('DAY')) {
    try {
      // 抓取第2列到第50列的資料 (標題列不要抓)
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: 'A2:D50', 
      });
      const rows = response.data.values;
      
      if (!rows || rows.length === 0) {
        replyText = `目前試算表裡面還沒有建立行程喔！趕快去新增吧！`;
      } else {
        // 篩選出符合使用者輸入天數 (例如 DAY1) 的行程
        const daySchedule = rows.filter(row => row[0] && row[0].toUpperCase().replace(/\s+/g, '') === formattedInput);
        
        if (daySchedule.length === 0) {
           replyText = `找不到 ${formattedInput} 的行程，請確認你的試算表 A 欄有沒有填寫這一天喔！`;
        } else {
           replyText = `【📅 TOKYO SYNC - ${formattedInput} 行程】\n\n`;
           daySchedule.forEach(row => {
             const time = row[1] || '時間未定';
             const place = row[2] || '';
             const note = row[3] || '';
             
             if (place) {
               // 自動生成該景點的 Google Maps 大眾運輸導航連結
               const googleMapUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(place)}&travelmode=transit`;
               replyText += `📍 ${time}｜${place}\n`;
               if (note) replyText += `💡 ${note}\n`;
               replyText += `👉 導航：${googleMapUrl}\n\n`;
             }
           });
           replyText += `(行程可隨時在 Google 試算表即時更新)`;
        }
      }
    } catch (err) {
      replyText = `讀取行程失敗，請檢查連線狀態：${err.message}`;
    }
  }
  
  // --- 其他功能保留 ---
  else if (userText === '匯率') {
    try {
      const res = await axios.get('https://api.exchangerate-api.com/v4/latest/JPY');
      const rate = res.data.rates.TWD;
      replyText = `【即時匯率】\n1 日圓 ≒ ${rate} 台幣\n換算：10,000日圓約為 ${Math.round(10000 * rate)} 台幣。`;
    } catch (e) { replyText = '無法取得匯率，請稍後再試。'; }
  }

  else if (userText === '迪士尼') {
    const hours = new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' });
    const tokyoHour = new Date(hours).getHours();

    if (tokyoHour >= 21 || tokyoHour < 8) {
      replyText = '【🏰 東京迪士尼】\n目前樂園已休園 🌙\n表定營業時間為 09:00 - 21:00（日本時間）。';
    } else {
      try {
        const res = await axios.get('https://api.themeparks.wiki/v1/entity/7ead8e6d-ca51-4905-905b-cb3053099491/live');
        const rides = res.data.liveData.filter(r => ['Enchanted Tale of Beauty and the Beast', 'Space Mountain'].includes(r.name));
        replyText = '【🏰 東京迪士尼即時排隊】\n';
        rides.forEach(r => {
          let statusText = r.status === 'OPERATING' && r.queue?.STANDBY ? `${r.queue.STANDBY.waitTime} 分鐘` : '無數據/維修中';
          let nameCN = r.name.includes('Beast') ? '美女與野獸' : '太空山';
          replyText += `📍${nameCN}：${statusText}\n`;
        });
      } catch (e) { replyText = '資料載入中，請稍後再試。'; }
    }
  }

  else if (userText === '東京交通' || userText === '地鐵') {
    replyText = `【🚉 東京鐵道即時情報】\n1. Yahoo! 乘換案內：\nhttps://transit.yahoo.co.jp/diainfo/area/4\n2. 東京地鐵官方：\nhttps://www.tokyometro.jp/unten/index.html`;
  }

  else {
    replyText = `超七秘助理為您服務！\n\n您可以輸入：\n▶ 「Day1」或「Day 2」：讀取每日行程與導航\n▶ 「匯率」：看即時日幣匯率\n▶ 「迪士尼」：看樂園排隊時間\n▶ 「東京交通」：看地鐵運行狀況`;
  }

  return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Bot is running on port ${port}`));
