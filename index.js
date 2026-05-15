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

// --- Google Sheets 初始化 ---
let sheets;
try {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  sheets = google.sheets({ version: 'v4', auth });
} catch (error) {
  console.error("Google 憑證錯誤", error);
}

// --- 時間格式化工具 ---
function addMinutes(timeStr, minsToAdd) {
  let [h, m] = timeStr.split(':').map(Number);
  let date = new Date();
  date.setHours(h, m, 0, 0);
  date.setMinutes(date.getMinutes() + Math.round(minsToAdd));
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
}

// --- 🌟 核心功能：向 Google Maps 索取詳細交通資訊 ---
async function getTransitDetails(origin, destination) {
  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&mode=transit&language=zh-TW&key=${apiKey}`;
    const res = await axios.get(url);
    
    if (res.data.routes && res.data.routes.length > 0) {
      const leg = res.data.routes[0].legs[0];
      const duration = Math.ceil(leg.duration.value / 60);
      const fare = res.data.routes[0].fare ? res.data.routes[0].fare.text : '依現場為準';
      
      // 提取具體的搭乘路線
      let routeDescription = '';
      const steps = leg.steps.filter(s => s.travel_mode === 'TRANSIT');
      if (steps.length > 0) {
        steps.forEach(s => {
          const info = s.transit_details;
          routeDescription += `   🚆 [${info.line.short_name || info.line.name}] ${info.departure_stop.name} ➔ ${info.arrival_stop.name}\n`;
        });
      } else {
        routeDescription = '   🚶 步行或鄰近區域\n';
      }

      return { duration, fare, routeDescription };
    }
    return { duration: 30, fare: '未知', routeDescription: '   ⚠️ 無法取得詳細路線\n' };
  } catch (err) {
    return { duration: 30, fare: '未知', routeDescription: '   ⚠️ 交通 API 連線異常\n' };
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
  if (event.type !== 'message' || event.message.type !== 'text') return Promise.resolve(null);

  const userText = event.message.text.trim();
  let replyText = '';

  // 1. 排程處理邏輯
  if (userText.toUpperCase().startsWith('DAY')) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: 'A2:E50',
      });
      const rows = response.data.values || [];
      const dayData = rows.filter(r => r[0] && r[0].toUpperCase() === userText.toUpperCase());

      if (dayData.length > 0) {
        replyText = `【📅 TOKYO SYNC - ${userText.toUpperCase()} 行程】\n\n`;
        let currentTime = dayData[0][1]; // 起始時間

        for (let i = 0; i < dayData.length; i++) {
          const place = dayData[i][2];
          const stay = parseFloat(dayData[i][3]) || 1;
          const note = dayData[i][4] || '';

          replyText += `📍 ${currentTime}｜${place}\n`;
          if (note) replyText += `💡 ${note}\n`;

          currentTime = addMinutes(currentTime, stay * 60);

          if (i < dayData.length - 1) {
            const transit = await getTransitDetails(place, dayData[i+1][2]);
            const mapUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dayData[i+1][2])}&travelmode=transit`;

            replyText += `   👇 (停留至 ${currentTime})\n`;
            replyText += `⏱️ 車程約 ${transit.duration} 分鐘 (💰 票價: ${transit.fare})\n`;
            replyText += `${transit.routeDescription}`;
            replyText += `👉 導航: ${mapUrl}\n\n`;

            currentTime = addMinutes(currentTime, transit.duration);
          } else {
            replyText += `   👇 (預計 ${currentTime} 結束行程)\n`;
          }
        }
      } else {
        replyText = '資料庫中還沒有這天的行程喔！';
      }
    } catch (err) { replyText = `讀取失敗：${err.message}`; }
  }

  // 2. 購物換算邏輯
  else if (/^[0-9,]+$/.test(userText)) {
    try {
      const jpy = parseInt(userText.replace(/,/g, ''), 10);
      const res = await axios.get('https://api.exchangerate-api.com/v4/latest/JPY');
      const twd = Math.round(jpy * res.data.rates.TWD);
      replyText = `🛍️ 【購物換算】\n${jpy.toLocaleString()} 日圓 ≒ ${twd.toLocaleString()} 台幣\n(匯率：${res.data.rates.TWD})`;
    } catch (e) { return Promise.resolve(null); }
  }

  // 3. 迪士尼功能
  else if (userText === '迪士尼') {
    const hours = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' })).getHours();
    if (hours >= 21 || hours < 8) {
      replyText = '【🏰 東京迪士尼】\n目前休園中 🌙\n營業時間：09:00 - 21:00';
    } else {
      try {
        const res = await axios.get('https://api.themeparks.wiki/v1/entity/7ead8e6d-ca51-4905-905b-cb3053099491/live');
        const list = res.data.liveData.filter(r => ['Enchanted Tale of Beauty and the Beast', 'Space Mountain', 'Pooh\'s Hunny Hunt'].includes(r.name));
        replyText = '【🏰 迪士尼即時排隊】\n' + list.map(r => `📍${r.name.replace('Enchanted Tale of Beauty and the Beast', '美女與野獸').replace('Space Mountain', '太空山').replace('Pooh\'s Hunny Hunt', '小熊維尼')}：${r.queue?.STANDBY?.waitTime || 0} 分鐘`).join('\n');
      } catch (e) { replyText = '迪士尼 API 暫時離線。'; }
    }
  }

  // 其他指令
  else if (userText === '匯率') {
    try {
      const res = await axios.get('https://api.exchangerate-api.com/v4/latest/JPY');
      replyText = `【即時匯率】\n目前 1 日圓 ≒ ${res.data.rates.TWD} 台幣\n💡 直接輸入數字即可自動換算！`;
    } catch (e) { replyText = '無法取得匯率。'; }
  }

  else { return Promise.resolve(null); }

  return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Running on ${port}`));
