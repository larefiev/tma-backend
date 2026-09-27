const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Токен бота
const BOT_TOKEN = '8926794376:AAEsqPjnTtX13uLSueKhGb8Qz7UMophdGnk';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Укажите свой числовой ID чата/аккаунта Telegram для получения заявок
const ADMIN_CHAT_ID = '944873428'; 

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
    if (!tgData.ok) {
      return res.status(500).json({ error: tgData.description });
    }

    res.json({ invoiceLink: tgData.result });
  } catch (err) {
    console.error('Ошибка создания инвойса:', err);
    res.status(500).json({ error: err.message });
  }
});

// 2. Получение баланса
app.get('/api/user/:id', (req, res) => {
  res.json(getUser(req.params.id));
});

// 3. Обработка заявки на вывод Stars
app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, amount, username } = req.body;
    const withdrawAmount = parseInt(amount);

    if (!userId || isNaN(withdrawAmount) || withdrawAmount < 10) {
      return res.status(400).json({ error: 'Минимальная сумма вывода — 10 ⭐' });
    }

    const user = getUser(userId);

    if (user.balance < withdrawAmount) {
      return res.status(400).json({ error: 'Недостаточно звёзд на балансе' });
    }

    if (user.totalWagered < user.totalDeposited) {
      return res.status(400).json({ error: 'Вейджер не отыгран на 100%' });
    }

    const fee = Math.floor(withdrawAmount * 0.15);
    const toPayout = withdrawAmount - fee;

    // Списываем баланс на сервере
    user.balance -= withdrawAmount;

    // Оповещение администратора (если задан ADMIN_CHAT_ID)
    if (ADMIN_CHAT_ID) {
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: ADMIN_CHAT_ID,
          parse_mode: 'HTML',
          text: `🚨 <b>Заявка на вывод Stars</b>\n\n` +
                `👤 Игрок: @${username || 'не указан'} (ID: <code>${userId}</code>)\n` +
                `⭐ Запрошено: <b>${withdrawAmount} Stars</b>\n` +
                `📉 Комиссия (15%): <b>${fee} Stars</b>\n` +
                `💰 К выплате: <b>${toPayout} Stars</b>\n\n` +
                `<i>Баланс игрока успешно списан.</i>`
        })
      }).catch(err => console.error('Ошибка отправки сообщения админу:', err));
    }

    res.json({ success: true, newBalance: user.balance, toPayout });
  } catch (err) {
    console.error('Ошибка вывода:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// 4. Автоматическое подтверждение платежей через Long Polling
let lastUpdateId = 0;
async function pollTelegramUpdates() {
  try {
    const res = await fetch(`${TELEGRAM_API}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`);
    const data = await res.json();

    if (data.ok && data.result.length > 0) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;

        // Подтверждение перед списанием
        if (update.pre_checkout_query) {
          const preQueryId = update.pre_checkout_query.id;
          await fetch(`${TELEGRAM_API}/answerPreCheckoutQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pre_checkout_query_id: preQueryId,
              ok: true
            })
          });
          console.log(`PreCheckout ${preQueryId} подтвержден.`);
        }

        // Зачисление успешной оплаты
        if (update.message && update.message.successful_payment) {
          const sp = update.message.successful_payment;
          const payload = JSON.parse(sp.invoice_payload);
          const userId = payload.userId;
          const starsPaid = sp.total_amount;
          const chatId = update.message.chat.id;

          const user = getUser(userId);
          user.balance += starsPaid;
          user.totalDeposited += starsPaid;

          await fetch(`${TELEGRAM_API}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              parse_mode: 'HTML',
              text: `🎉 <b>Успешное пополнение!</b>\n\n` +
                    `⭐ Зачислено: <b>+${starsPaid} Stars</b>\n` +
                    `💰 Текущий баланс: <b>${user.balance} Stars</b>\n\n` +
                    `<i>Удачной игры! 🚀</i>`
            })
          });
          console.log(`Платеж ${starsPaid} Stars зачислен игроку ${userId}`);
        }
      }
    }
  } catch (e) {
    console.error('Ошибка в цикле обновлений Telegram:', e.message);
  } finally {
    setTimeout(pollTelegramUpdates, 500);
  }
}

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  pollTelegramUpdates();
});
