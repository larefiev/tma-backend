const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());
app.use(cors());

// Точный токен бота из BotFather
const BOT_TOKEN = '8926794376:AAEsqPjnTtX13uLSueKhGb8Qz7UMophdGnk';
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const usersDb = {};

function getUser(id) {
  const strId = String(id);
  if (!usersDb[strId]) {
    usersDb[strId] = { balance: 0, totalDeposited: 0, totalWagered: 0 };
  }
  return usersDb[strId];
}

// 1. Создание инвойса Stars
app.post('/api/create-stars-invoice', async (req, res) => {
  try {
    const { userId, starsAmount } = req.body;
    const amount = parseInt(starsAmount);

    if (!userId || isNaN(amount) || amount < 1) {
      return res.status(400).json({ error: 'Неверные параметры' });
    }

    const payload = JSON.stringify({ userId: String(userId), amount: amount, time: Date.now() });

    // Прямой вызов Telegram Bot API для генерации ссылки Stars
    const invoiceLink = await bot.createInvoiceLink(
      'Пополнение Stars',
      `Пополнение игрового баланса на ${amount} ⭐`,
      payload,
      '',      // Пустая строка: для XTR провайдер не нужен
      'XTR',   // Валюта звезд
      [{ label: `${amount} Stars`, amount: amount }]
    );

    console.log(`Инвойс успешно создан для пользователя ${userId}: ${invoiceLink}`);
    res.json({ invoiceLink });
  } catch (err) {
    console.error('Ошибка создания инвойса в Telegram:', err.response ? err.response.body : err.message);
    res.status(500).json({ error: 'Не удалось создать инвойс' });
  }
});

// 2. Получение баланса
app.get('/api/user/:id', (req, res) => {
  res.json(getUser(req.params.id));
});

// 3. Предварительная проверка оплаты
bot.on('pre_checkout_query', async (query) => {
  try {
    await bot.answerPreCheckoutQuery(query.id, true);
  } catch (e) {
    console.error('Ошибка pre_checkout:', e);
  }
});

// 4. Успешный платеж
bot.on('successful_payment', async (msg) => {
  try {
    const payload = JSON.parse(msg.successful_payment.invoice_payload);
    const userId = payload.userId;
    const starsPaid = msg.successful_payment.total_amount;
    const chatId = msg.chat.id;

    const user = getUser(userId);
    user.balance += starsPaid;
    user.totalDeposited += starsPaid;

    await bot.sendMessage(
      chatId,
      `🎉 <b>Успешное пополнение!</b>\n\n` +
      `⭐ Зачислено: <b>+${starsPaid} Stars</b>\n` +
      `💰 Текущий баланс: <b>${user.balance} Stars</b>\n\n` +
      `<i>Удачной игры! 🚀</i>`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error('Ошибка обработки successful_payment:', e);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер бота запущен на порту ${PORT}`);
});
