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

// --- 🌟 升級版：向 Google Maps 查詢詳細大眾運輸資訊 ---
async function getTransitInfo(origin, dest) {
  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    // 加上 language=zh-TW 讓回傳的站名跟路線盡量顯示中文漢字
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&mode=transit&language=zh-TW&key=${apiKey}`;
    const res = await axios.get(url);
    
    if (res.data.routes && res.data.routes.length > 0) {
      const route = res.data.routes[0];
      const leg = route.legs[0];
      
      // 1. 取得總分鐘數
      const durationMins = Math.ceil(leg.duration.value / 60);
      
      // 2. 取得票價 (日本交通通常會有，若無則顯示未知)
      let fareText = '依實際刷卡為準';
      if (route.fare) {
        fareText = route.fare.text; // 例如回傳 "¥200"
      }

      // 3. 解析詳細轉乘路線
      let transitDetails = '';
      const transitSteps = leg.steps.filter(step => step.travel_mode === 'TRANSIT');
      
      if (transitSteps.length > 0) {
        transitSteps.forEach(step => {
          const t = step.transit_details;
          const lineName = t.line.short_name || t.line.name; // 路線名稱 (ex: 銀座線)
          transitDetails += `   🚆 [${lineName}] ${t.departure_stop.name} ➔ ${t.arrival_stop.name}\n`;
        });
      } else {
        transitDetails = `   🚶 步行或無直達地鐵路線\n`;
      }

      return {
        duration: durationMins,
        fare: fareText,
        details: transitDetails
      };
    }
    return { duration: 30, fare: '未知', details: '   ⚠️ 無法解析詳細路線，請點擊導航查看\n' };
  } catch (error) {
    console.error("Google Maps API 呼叫失敗", error);
    return { duration: 30, fare: '未知', details: '   ⚠️ 路線讀取失敗\n' };
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

  // --- 排程功能 ---
  if (userText.toUpperCase().startsWith('DAY')) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: 'A2:E50', 
      });
      
      const allRows = response.data.values || [];
      const dayRows = allRows.filter(r => r[0] && r[0].toUpperCase() === userText.toUpperCase());

      if (dayRows.length > 0) {
        replyText = `【📅 TOKYO SYNC - ${userText.toUpperCase()} 自動排程】\n\n`;
        let currentTime = dayRows[0][1]; 

        for (let i = 0; i < dayRows.length; i++) {
          const place = dayRows[i][2];
          const stayHours = parseFloat(dayRows[i][3]) || 1; 
          const note = dayRows[i][4] || '';

          replyText += `📍 ${currentTime}｜${place}\n`;
          if (note) replyText += `💡 ${note}\n`;

          currentTime = addMinutes(currentTime, stayHours * 60); 

          if (i < dayRows.length - 1) {
            const nextPlace = dayRows[i + 1][2];
            // 使用新的 API 呼叫函數，取得詳細資訊
            const transitInfo = await getTransitInfo(place, nextPlace); 
            const mapUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(nextPlace)}&travelmode=transit`;

            replyText += `   👇 (停留至 ${currentTime})\n`;
            replyText += `⏱️ 總車程：約 ${transitInfo.duration} 分鐘 (💰票價: ${transitInfo.fare})\n`;
            replyText += `${transitInfo.details}`;
            replyText += `👉 導航：${mapUrl}\n\n`;

            currentTime = addMinutes(currentTime, transitInfo.duration);
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

  // --- 匯率 ---
  else if (userText === '匯率') {
    try {
      const res = await axios.get('https://api.exchangerate-api.com/v4/latest/JPY');
      const rate = res.data.rates.TWD;
      replyText = `【即時匯率】\n1 日圓 ≒ ${rate} 台幣\n換算：10,000日圓約為 ${Math.round(10000 * rate)} 台幣。`;
    } catch (e) { replyText = '無法取得匯率，請稍後再試。'; }
  }
  
  // --- 群組防洗版機制 ---
  else {
    return Promise.resolve(null);
  }

  if (replyText !== '') {
    return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
  } else {
    return Promise.resolve(null);
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Bot is running on port ${port}`));
