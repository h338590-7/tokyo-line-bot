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

  // --- 功能 1：真實匯率抓取 ---
  if (userText === '匯率') {
    try {
      const res = await axios.get('https://api.exchangerate-api.com/v4/latest/JPY');
      const rate = res.data.rates.TWD;
      replyText = `【即時匯率】\n1 日圓 ≒ ${rate} 台幣\n換算：10,000日圓約為 ${Math.round(10000 * rate)} 台幣。`;
    } catch (e) { replyText = '無法取得匯率，請稍後再試。'; }
  }

  // --- 功能 2：真實迪士尼排隊時間 (以東京迪士尼樂園為例) ---
  else if (userText === '迪士尼') {
    try {
      // 串接開源 ThemeParks Wiki API (Tokyo Disneyland)
      const res = await axios.get('https://api.themeparks.wiki/v1/entity/7ead8e6d-ca51-4905-905b-cb3053099491/live');
      const rides = res.data.liveData;
      
      // 篩選出幾個熱門設施
      const highlights = rides.filter(r => 
        ['Enchanted Tale of Beauty and the Beast', 'Space Mountain', 'Pooh\'s Hunny Hunt'].includes(r.name)
      );

      let disneyInfo = '【🏰 東京迪士尼即時排隊】\n';
      highlights.forEach(r => {
        const status = r.status === 'OPERATING' ? `${r.queue.STANDBY.waitTime} 分鐘` : '暫停營運';
        const nameCN = r.name.replace('Enchanted Tale of Beauty and the Beast', '美女與野獸')
                              .replace('Space Mountain', '太空山')
                              .replace('Pooh\'s Hunny Hunt', '小熊維尼獵蜜記');
        disneyInfo += `📍${nameCN}：${status}\n`;
      });
      replyText = disneyInfo + '\n(資料來源：ThemeParks Wiki)';
    } catch (e) { 
      replyText = '【東京迪士尼】\n目前官方資料載入中，請稍後再試。'; 
    }
  }

  // --- 功能 3：路線規劃與東京即時交通 ---
  else if (userText.startsWith('去')) {
    const destination = userText.replace('去', '').trim();
    if (destination) {
      const googleMapUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=transit`;
      replyText = `【🗺️ 路線規劃：前往 ${destination}】\n\n已為您規劃最佳地鐵/鐵路路線，請點擊下方連結查看即時導航與票價：\n${googleMapUrl}`;
    }
  }

  else if (userText === '東京交通' || userText === '地鐵') {
    replyText = `【🚉 東京鐵道即時情報】\n\n1. Yahoo! 乘換案內 (即時延誤情報)：\nhttps://transit.yahoo.co.jp/diainfo/area/4\n\n2. 東京地鐵官方運行狀況：\nhttps://www.tokyometro.jp/unten/index.html\n\n💡 提示：輸入「去 [目的地]」我可以直接幫您規劃路線喔！`;
  }

  // --- 預設回覆 ---
  else {
    replyText = `超七秘助理為您服務！\n\n您可以輸入：\n▶ 「匯率」：看即時日幣匯率\n▶ 「迪士尼」：看樂園排隊時間\n▶ 「東京交通」：看地鐵運行狀況\n▶ 「去 淺草寺」：自動規劃導航路線`;
  }

  return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Bot is running on ${port}`));
