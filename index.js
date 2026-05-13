const line = require('@line/bot-sdk');
const express = require('express');
const axios = require('axios');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();

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

  if (userText === '匯率') {
    try {
      const res = await axios.get('https://api.exchangerate-api.com/v4/latest/JPY');
      const rate = res.data.rates.TWD;
      replyText = `【即時匯率】\n1 日圓 ≒ ${rate} 台幣\n換算：10,000日圓約為 ${Math.round(10000 * rate)} 台幣。`;
    } catch (e) { replyText = '無法取得匯率，請稍後再試。'; }
  }

  // --- 進化版：具備時間感知與精準狀態判斷的迪士尼模組 ---
  else if (userText === '迪士尼') {
    // 1. 取得目前日本東京的當地時間
    const tokyoTimeStr = new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' });
    const tokyoDate = new Date(tokyoTimeStr);
    const hours = tokyoDate.getHours();

    // 2. 判斷是否為休園時間 (設定為晚上 21:00 到 早上 08:00)
    if (hours >= 21 || hours < 8) {
      replyText = '【🏰 東京迪士尼】\n目前樂園已休園 🌙\n\n表定營業時間通常為 09:00 - 21:00（日本時間）。\n設施排隊資訊請於明天開園後再來查詢喔！';
    } else {
      // 3. 營業時間內，正常抓取 API
      try {
        const res = await axios.get('https://api.themeparks.wiki/v1/entity/7ead8e6d-ca51-4905-905b-cb3053099491/live');
        const rides = res.data.liveData;
        
        const highlights = rides.filter(r => 
          ['Enchanted Tale of Beauty and the Beast', 'Space Mountain', 'Pooh\'s Hunny Hunt'].includes(r.name)
        );

        let disneyInfo = '【🏰 東京迪士尼即時排隊】\n';
        highlights.forEach(r => {
          let statusText = '';
          
          // 4. 精準判斷設施的各種真實狀態
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
        // 只有在 API 真的當機時才會出現這個訊息
        replyText = '【🏰 東京迪士尼】\n目前無法連線到第三方伺服器抓取即時數據，這可能是伺服器維護中，請稍後再試喔！'; 
      }
    }
  }

  else if (userText.startsWith('去')) {
    const destination = userText.replace('去', '').trim();
    if (destination) {
      const googleMapUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=transit`;
      replyText = `【🗺️ 專屬導航：前往 ${destination}】\n\n已為您生成導航路線！點擊下方連結，Google 會自動定位您的「當下位置」開始導航：\n${googleMapUrl}\n\n💡 乘車與付款提示：\n1. 點開連結即可查看「精準車資」與「建議車廂」。\n2. 東京市區地鐵皆可直接刷 Apple Pay (需綁定數位 Suica/Pasmo) 或實體西瓜卡進站。`;
    }
  }

  else if (userText === '東京交通' || userText === '地鐵') {
    replyText = `【🚉 東京鐵道即時情報】\n\n1. Yahoo! 乘換案內 (即時延誤情報)：\nhttps://transit.yahoo.co.jp/diainfo/area/4\n\n2. 東京地鐵官方運行狀況：\nhttps://www.tokyometro.jp/unten/index.html\n\n💡 提示：輸入「去 [目的地]」我可以直接幫您規劃路線喔！`;
  }

  else {
    replyText = `超七秘助理為您服務！\n\n您可以輸入：\n▶ 「匯率」：看即時日幣匯率\n▶ 「迪士尼」：看樂園排隊時間\n▶ 「東京交通」：看地鐵運行狀況\n▶ 「去 淺草寺」：自動規劃導航路線`;
  }

  return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Bot is running on ${port}`));
