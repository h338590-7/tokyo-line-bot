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

// --- 時間計算輔助函數 ---
function addMinutes(timeStr, minsToAdd) {
  let [h, m] = timeStr.split(':').map(Number);
  let date = new Date();
  date.setHours(h, m, 0, 0);
  date.setMinutes(date.getMinutes() + Math.round(minsToAdd));
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
}

// --- 向 Google Maps 查詢大眾運輸車程 ---
async function getTransitTime(origin, dest) {
  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&mode=transit&key=${apiKey}`;
    const res = await axios.get(url);
    if (res.data.routes && res.data.routes.length > 0) {
      const leg = res.data.routes[0].legs[0];
      return Math.ceil(leg.duration.value / 60); // 將秒數轉換為分鐘
    }
    return 30; // 如果找不到路線，預設給 30 分鐘緩衝
  } catch (error) {
    console.error("Google Maps API 呼叫失敗", error);
    return 30; 
  }
}

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

  // --- 🌟 終極自動排程功能：抓取表單並計算時間 ---
  if (userText.toUpperCase().startsWith('DAY')) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: 'A2:E50', // 從第二列開始抓，避開標題
      });
      
      const allRows = response.data.values || [];
      // 篩選出符合使用者輸入天數 (例如 Day1) 的行程
      const dayRows = allRows.filter(r => r[0] && r[0].toUpperCase() === userText.toUpperCase());

      if (dayRows.length > 0) {
        replyText = `【📅 TOKYO SYNC - ${userText.toUpperCase()} 自動排程】\n\n`;
        let currentTime = dayRows[0][1]; // 取得當天第一站的起始時間 (如 09:00)

        for (let i = 0; i < dayRows.length; i++) {
          const place = dayRows[i][2];
          const stayHours = parseFloat(dayRows[i][3]) || 1; // 預設停留 1 小時
          const note = dayRows[i][4] || '';

          replyText += `📍 ${currentTime}｜${place}\n`;
          if (note) replyText += `💡 ${note}\n`;

          // 計算離開時間
          currentTime = addMinutes(currentTime, stayHours * 60); 

          // 如果還有下一站，就計算交通時間並產生導航連結
          if (i < dayRows.length - 1) {
            const nextPlace = dayRows[i + 1][2];
            const transitMins = await getTransitTime(place, nextPlace); // 呼叫 AI 算車程
            const mapUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(nextPlace)}&travelmode=transit`;

            replyText += `   👇 (停留至 ${currentTime})\n`;
            replyText += `🚇 搭乘地鐵/大眾運輸約 ${transitMins} 分鐘\n`;
            replyText += `👉 導航：${mapUrl}\n\n`;

            // 將交通時間加上去，得到下一站的抵達時間
            currentTime = addMinutes(currentTime, transitMins);
          } else {
            replyText += `   👇 (預計 ${currentTime} 結束本站行程)\n`;
          }
        }
      } else {
        replyText = `目前資料庫裡還沒有 ${userText} 的行程喔！請先到 Google 試算表新增資料。`;
      }
    } catch (err) {
      replyText = `⚠️ 讀取行程失敗：${err.message}`;
    }
  }

  // --- 保留原有功能 ---
  else if (userText === '匯率') {
    try {
      const res = await axios.get('https://api.exchangerate-api.com/v4/latest/JPY');
      const rate = res.data.rates.TWD;
      replyText = `【即時匯率】\n1 日圓 ≒ ${rate} 台幣\n換算：10,000日圓約為 ${Math.round(10000 * rate)} 台幣。`;
    } catch (e) { replyText = '無法取得匯率，請稍後再試。'; }
  }
  
  else {
    replyText = `超七秘助理為您服務！\n\n▶ 輸入「Day1」：自動產生含交通時間的專屬行程表！\n▶ 輸入「匯率」：看即時日幣匯率`;
  }

  return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Bot is running on port ${port}`));
