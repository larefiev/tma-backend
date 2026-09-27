const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());
app.use(cors());

// Токен бота с валидными кавычками
const BOT_TOKEN = '8926794376:AAEsqPjnTrx13uLSueKh0b8Qz7UMophdGnk';
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const usersDb = {};

function getUser(id) {
  if (!usersDb[id]) {
    usersDb[id] = { balance: 0, totalDeposited: 0, totalWagered: 0 };
  }
  return usersDb[id];
}

// 1. Создание инвойса Stars
app.post('/api/create-stars-invoice', async (req, res) => {
  try {
    const { userId, starsAmount } = req.body;
    if (!userId || !starsAmount || starsAmount < 1) {
      return res.status(400).json({ error: 'Неверные параметры' });
    }

    const invoiceLink = await bot.createInvoiceLink(
      'Пополнение игрового баланса',
      `Пополнение на ${starsAmount} Stars`,
      JSON.stringify({ userId, starsAmount, timestamp: Date.now() }),
      '', // provider_token строго пустой для XTR
      'XTR',
      [{ label: `${starsAmount} Stars`, amount: starsAmount }]
    );

    res.json({ invoiceLink });
  } catch (err) {
    console.error('Ошибка создания инвойса:', err);
    res.status(500).json({ error: 'Не удалось создать инвойс' });
  }
});

// 2. Получение баланса
app.get('/api/user/:id', (req, res) => {
  res.json(getUser(req.params.id));
});

// 3. Подтверждение платежа
bot.on('pre_checkout_query', async (query) => {
  try {
    await bot.answerPreCheckoutQuery(query.id, true);
  } catch (e) {
    console.error(e);
  }
});

// 4. Успешный платеж и авто-сообщение
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
      `<i>Удачной игры в Crush! 🚀</i>`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error('Ошибка обработки оплаты:', e);
  }
});

// Запуск сервера с биндингом на 0.0.0.0 для Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер бота запущен на порту ${PORT}`);
});
