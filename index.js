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

// --- 向 Google Maps 查詢詳細大眾運輸資訊 ---
async function getTransitInfo(origin, dest) {
  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&mode=transit&language=zh-TW&key=${apiKey}`;
    const res = await axios.get(url);
    
    if (res.data.routes && res.data.routes.length > 0) {
      const route = res.data.routes[0];
      const leg = route.legs[0];
      const durationMins = Math.ceil(leg.duration.value / 60);
      
      let fareText = '依實際刷卡為準';
      if (route.fare) {
        fareText = route.fare.text;
      }

      let transitDetails = '';
      const transitSteps = leg.steps.filter(step => step.travel_mode === 'TRANSIT');
      
      if (transitSteps.length > 0) {
        transitSteps.forEach(step => {
          const t = step.transit_details;
          const lineName = t.line.short_name || t.line.name;
          transitDetails += `   🚆 [${lineName}] ${t.departure_stop.name} ➔ ${t.arrival_stop.name}\n`;
        });
      } else {
        transitDetails = `   🚶 步行或無直達地鐵路線\n`;
      }

      return { duration: durationMins, fare: fareText, details: transitDetails };
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

  // --- 1. 自動排程功能 ---
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

  // --- 2. 迪士尼排隊時間 ---
  else if (userText === '迪士尼') {
    const tokyoTimeStr = new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' });
    const tokyoDate = new Date(tokyoTimeStr);
    const hours = tokyoDate.getHours();

    if (hours >= 21 || hours < 8) {
      replyText = '【🏰 東京迪士尼】\n目前樂園已休園 🌙\n\n表定營業時間通常為 09:00 - 21:00（日本時間）。\n設施排隊資訊請於明天開園後再來查詢喔！';
    } else {
      try {
        const res = await axios.get('https://api.themeparks.wiki/v1/entity/7ead8e6d-ca51-4905-905b-cb3053099491/live');
        const rides = res.data.liveData;
        
        const highlights = rides.filter(r => 
          ['Enchanted Tale of Beauty and the Beast', 'Space Mountain', 'Pooh\'s Hunny Hunt'].includes(r.name)
        );

        let disneyInfo = '【🏰 東京迪士尼即時排隊】\n';
        highlights.forEach(r => {
          let statusText = '';
          if (r.status === 'OPERATING') {
            statusText = (r.queue && r.queue.STANDBY) ? `${r.queue.STANDBY.waitTime} 分鐘` : '目前無數據';
          } else if (r.status === 'CLOSED') {
            statusText = '🔴 本日已關閉';
          } else if (r.status === 'DOWN') {
            statusText = '⚠️ 維修/暫停營運中';
          } else {
            statusText = '狀態未知';
          }

          const nameCN = r.name.replace('Enchanted Tale of Beauty and the Beast', '美女與野獸')
                                .replace('Space Mountain', '太空山')
                                .replace('Pooh\'s Hunny Hunt', '小熊維尼獵蜜記');
          disneyInfo += `📍${nameCN}：${statusText}\n`;
        });
        replyText = disneyInfo + '\n(資料來源：ThemeParks Wiki)';
      } catch (e) { 
        replyText = '【🏰 東京迪士尼】\n目前無法連線到第三方伺服器抓取即時數據，這可能是伺服器維護中，請稍後再試喔！'; 
      }
    }
  }

  // --- 3. 東京交通延誤情報 ---
  else if (userText === '東京交通' || userText === '地鐵') {
    replyText = `【🚉 東京鐵道即時情報】\n\n1. Yahoo! 乘換案內 (即時延誤情報)：\nhttps://transit.yahoo.co.jp/diainfo/area/4\n\n2. 東京地鐵官方運行狀況：\nhttps://www.tokyometro.jp/unten/index.html`;
  }

  // --- 4. 基礎匯率查詢 ---
  else if (userText === '匯率') {
    try {
      const res = await axios.get('https://api.exchangerate-api.com/v4/latest/JPY');
      const rate = res.data.rates.TWD;
      replyText = `【即時匯率】\n目前 1 日圓 ≒ ${rate} 台幣\n💡 提示：您可以直接在群組輸入數字（如 15000），我會自動幫您換算喔！`;
    } catch (e) { replyText = '無法取得匯率，請稍後再試。'; }
  }

  // --- 🌟 5. 新增：純數字自動偵測與換算台幣 ---
  // 使用正則表達式，如果輸入的字串全部都是數字或逗號（例如 10000 或 10,000），就會觸發
  else if (/^[0-9,]+$/.test(userText)) {
    try {
      // 把可能有的逗號拔掉，轉成純數字
      const jpyAmount = parseInt(userText.replace(/,/g, ''), 10); 
      
      // 抓取即時匯率
      const res = await axios.get('https://api.exchangerate-api.com/v4/latest/JPY');
      const rate = res.data.rates.TWD;
      
      // 計算台幣並四捨五入
      const twdAmount = Math.round(jpyAmount * rate);

      // toLocaleString() 會幫數字自動加上千分位逗號，看起來更清楚
      replyText = `🛍️ 【購物換算機】\n${jpyAmount.toLocaleString()} 日圓 ≒ ${twdAmount.toLocaleString()} 台幣\n(當前匯率：${rate})`;
    } catch (e) {
      // 若抓不到匯率就不吵人，保持安靜
      return Promise.resolve(null);
    }
  }

  // --- 6. 群組防洗版機制 (聽不懂的話就安靜) ---
  else {
    return Promise.resolve(null);
  }

  // 確保有文字才回傳
  if (replyText !== '') {
    return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
  } else {
    return Promise.resolve(null);
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Bot is running on port ${port}`));
