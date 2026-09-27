const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Токен бота строго из BotFather
const BOT_TOKEN = '8926794376:AAEsqPjnTtX13uLSueKhGb8Qz7UMophdGnk';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const usersDb = {};

function getUser(id) {
  const strId = String(id);
  if (!usersDb[strId]) {
    usersDb[strId] = { balance: 0, totalDeposited: 0, totalWagered: 0 };
  }
  return usersDb[strId];
}

// 1. Создание инвойса Stars через прямой вызов Bot API
app.post('/api/create-stars-invoice', async (req, res) => {
  try {
    const { userId, starsAmount } = req.body;
    const amount = parseInt(starsAmount);

    if (!userId || isNaN(amount) || amount < 1) {
      return res.status(400).json({ error: 'Неверные параметры' });
    }

    const payload = JSON.stringify({ userId: String(userId), amount: amount, time: Date.now() });

    // Прямой запрос к Telegram Bot API методом createInvoiceLink
    const tgRes = await fetch(`${TELEGRAM_API}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Пополнение игрового баланса',
        description: `Пополнение баланса на ${amount} ⭐ Stars`,
        payload: payload,
        currency: 'XTR',
        prices: [{ label: `${amount} Stars`, amount: amount }]
      })
    });

    const tgData = await tgRes.json();
    console.log('Ответ от Telegram Bot API:', tgData);

    if (!tgData.ok) {
      return res.status(500).json({ 
        error: 'Telegram API Error', 
        details: tgData.description 
      });
    }

    res.json({ invoiceLink: tgData.result });
  } catch (err) {
    console.error('Ошибка сервера:', err);
    res.status(500).json({ error: err.message });
  }
});

// 2. Получение баланса
app.get('/api/user/:id', (req, res) => {
  res.json(getUser(req.params.id));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
