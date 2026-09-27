const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Токен бота
const BOT_TOKEN = '8926794376:AAEsqPjnTtXl3uLSueKHGb8Qz7UMophdGnk';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Ваш Telegram ID из @userinfobot
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

// 3. Синхронизация отыгрыша (ставок) с сервера
app.post('/api/record-wager', (req, res) => {
  const { userId, amount } = req.body;
  const wagerVal = parseInt(amount) || 0;
  if (userId && wagerVal > 0) {
    const user = getUser(userId);
    user.totalWagered += wagerVal;
    return res.json({ success: true, totalWagered: user.totalWagered });
  }
  res.status(400).json({ error: 'Неверные параметры' });
});

// 4. Обработка заявки на вывод Stars
app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, amount, username, totalWageredClient } = req.body;
    const withdrawAmount = parseInt(amount);

    if (!userId || isNaN(withdrawAmount) || withdrawAmount < 10) {
      return res.status(400).json({ error: 'Минимальная сумма вывода — 10 ⭐' });
    }

    const user = getUser(userId);

    // Синхронизируем ставку отыгрыша, если клиент передал актуальный прогресс
    if (totalWageredClient && totalWageredClient > user.totalWagered) {
      user.totalWagered = totalWageredClient;
    }

    if (user.balance < withdrawAmount) {
      return res.status(400).json({ error: 'Недостаточно звёзд на балансе' });
    }

    if (user.totalWagered < user.totalDeposited) {
      return res.status(400).json({ 
        error: `Вейджер не отыгран на 100%! Отыграно: ${user.totalWagered}/${user.totalDeposited} ⭐` 
      });
    }

    const fee = Math.floor(withdrawAmount * 0.15);
    const toPayout = withdrawAmount - fee;

    // Списываем баланс
    user.balance -= withdrawAmount;

    // Отправляем уведомление администратору в Telegram
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        parse_mode: 'HTML',
        text: `🚨 <b>Новая заявка на вывод Stars!</b>\n\n` +
              `👤 Игрок: @${username || 'не указан'} (ID: <code>${userId}</code>)\n` +
              `⭐ Запрошено: <b>${withdrawAmount} Stars</b>\n` +
              `📉 Комиссия (15%): <b>${fee} Stars</b>\n` +
              `💰 К выплате: <b>${toPayout} Stars</b>\n\n` +
              `<i>Баланс игрока успешно списан.</i>`
      })
    }).catch(err => console.error('Ошибка отправки админу:', err));

    res.json({ success: true, newBalance: user.balance, toPayout });
  } catch (err) {
    console.error('Ошибка вывода:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// 5. Автоматическое подтверждение платежей через Long Polling
let lastUpdateId = 0;
async function pollTelegramUpdates() {
  try {
    const res = await fetch(`${TELEGRAM_API}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`);
    const data = await res.json();

    if (data.ok && data.result.length > 0) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;

        if (update.pre_checkout_query) {
          await fetch(`${TELEGRAM_API}/answerPreCheckoutQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pre_checkout_query_id: update.pre_checkout_query.id,
              ok: true
            })
          });
        }

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
                    `💰 Баланс: <b>${user.balance} Stars</b>`
            })
          });
        }
      }
    }
  } catch (e) {
    console.error('Ошибка в цикле обновлений Telegram:', e.message);
  } finally {
    setTimeout(pollTelegramUpdates, 500);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  pollTelegramUpdates();
});
