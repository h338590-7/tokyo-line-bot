const line = require('@line/bot-sdk');
const express = require('express');

// 設定 LINE 的金鑰，會從雲端主機的安全環境變數中讀取
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();

// 這是接收 LINE 訊息的「收發室」
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// 這裡是機器人的「大腦判斷邏輯」
function handleEvent(event) {
  // 如果使用者傳的不是文字，就不理他
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userText = event.message.text;
  let replyText = '';

  // 關鍵字判斷區 (你可以隨意修改這裡的文字)
  if (userText === '/匯率') {
    replyText = '目前的日圓匯率大約是 0.213 喔！(此為測試資料)';
  } else if (userText === '/迪士尼') {
    replyText = '【東京迪士尼即時動態】\n🏰 美女與野獸：120 分鐘\n🚀 太空山：45 分鐘\n(未來可串接爬蟲抓真實資料)';
  } else {
    replyText = `你剛剛說了：「${userText}」\n試著輸入 /匯率 或 /迪士尼 看看我的反應！`;
  }

  // 將組合好的文字傳送回 LINE
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: replyText
  });
}

// 啟動伺服器
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`LINE Bot is running on port ${port}`);
});
