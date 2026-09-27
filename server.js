const express = require('express');

const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

const BOT_TOKEN = '8926794376:AAEsqPjnTtXl3uLSueKhGb8Qz7UMophdGnk';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const ADMIN_CHAT_ID = '944873428';

const usersDb = {};

function getUser(id) {
  const strId = String(id);
  if (!usersDb[strId]) {
    usersDb[strId] = { balance: 0, totalDeposited: 0, totalWagered: 0 };
  }
  return usersDb[strId];
}

app.get('/', (req, res) => {
  res.send('Server is running');
});

// Начисление звёзд через панель модератора
app.post('/api/admin/give-stars', (req, res) => {
  try {
    const { adminId, targetUserId, amount } = req.body;

    if (String(adminId) !== ADMIN_CHAT_ID) {
      return res.status(403).json({ error: 'Доступ запрещен. Вы не администратор.' });
    }

    const stars = parseInt(amount);
    if (isNaN(stars) || stars <= 0) {
      return res.status(400).json({ error: 'Укажите корректную сумму' });
    }

    const target = getUser(targetUserId || adminId);
    target.balance += stars;

    res.json({
      success: true,
      addedStars: stars,
      newBalance: target.balance
    });
  } catch (err) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Создание инвойса для пополнения через Telegram Stars
app.post('/api/create-stars-invoice', async (req, res) => {
  try {
    const { userId, starsAmount } = req.body;
    const amount = parseInt(starsAmount);

    if (!userId || isNaN(amount) || amount < 1) {
      return res.status(400).json({ error: 'Неверные параметры суммы' });
    }

    const payload = JSON.stringify({ userId: String(userId), amount: amount, time: Date.now() });

    const tgRes = await fetch(`${TELEGRAM_API}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Пополнение игрового баланса',
        description: `Пополнение баланса на ${amount} ⭐ Stars`,
        payload: payload,
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: `${amount} Stars`, amount: amount }]
      })
    });

    const tgData = await tgRes.json();
    if (!tgData.ok) {
      console.error('Ошибка Telegram API при создании счета:', tgData);
      return res.status(500).json({ error: tgData.description || 'Не удалось сформировать счёт' });
    }

    res.json({ invoiceLink: tgData.result });
  } catch (err) {
    console.error('Ошибка в create-stars-invoice:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/user/:id', (req, res) => {
  res.json(getUser(req.params.id));
});

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

// Ручной вывод Stars: списание с баланса + отправка ссылки админу в Telegram
app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, amount, username, totalWageredClient } = req.body;
    const withdrawAmount = parseInt(amount);

    if (isNaN(withdrawAmount) || withdrawAmount < 50) {
      return res.status(400).json({ error: 'Минимальный вывод звёзд через Fragment — 50 ⭐' });
    }

    if (!username) {
      return res.status(400).json({ 
        error: 'Для отправки звёзд необходим публичный @username в Telegram! Установите его в профиле Telegram.' 
      });
    }

    const user = getUser(userId);

    if (totalWageredClient && totalWageredClient > user.totalWagered) {
      user.totalWagered = totalWageredClient;
    }

    if (user.balance < withdrawAmount) {
      return res.status(400).json({ error: 'Недостаточно звёзд на балансе' });
    }

    if (String(userId) !== ADMIN_CHAT_ID && user.totalWagered < user.totalDeposited) {
      return res.status(400).json({ 
        error: `Вейджер не отыгран на 100%! Отыграно: ${user.totalWagered}/${user.totalDeposited} ⭐` 
      });
    }

    const fee = Math.floor(withdrawAmount * 0.15);
    let toPayoutStars = withdrawAmount - fee;
    if (toPayoutStars < 50) {
      toPayoutStars = 50;
    }

    // Списываем баланс игрока
    user.balance -= withdrawAmount;

    const rawUser = username.trim().replace(/^@+/, '');
    const fragmentDirectUrl = `https://fragment.com/stars?recipient=${rawUser}&quantity=${toPayoutStars}`;

    // Отправляем заявку администратору с удобной кнопкой
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        parse_mode: 'HTML',
        text: `⚡ <b>Новая заявка на вывод звёзд!</b>\n\n` +
              `👤 Игрок: @${rawUser} (ID: <code>${userId}</code>)\n` +
              `⭐ Сумма к выплате: <b>${toPayoutStars} Stars</b>\n` +
              `💰 Списано с баланса: <b>${withdrawAmount} Stars</b>\n\n` +
              `<i>Нажмите на кнопку ниже, чтобы купить Stars в 1 клик на Fragment:</i>`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: `⭐ Отправить ${toPayoutStars} Stars на Fragment`, url: fragmentDirectUrl }
            ]
          ]
        }
      })
    }).catch((e) => console.error('Ошибка отправки админу:', e));

    // Уведомление игроку
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: userId,
        parse_mode: 'HTML',
        text: `⏳ <b>Заявка на вывод принята!</b>\n\n` +
              `⭐ Сумма: <b>${toPayoutStars} Stars</b>\n` +
              `👤 Получатель: @${rawUser}\n\n` +
              `<i>Звёзды поступят на ваш аккаунт в течение пары минут.</i>`
      })
    }).catch(() => {});

    res.json({ success: true, newBalance: user.balance, toPayoutStars });
  } catch (err) {
    console.error('Ошибка вывода:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Polling подтверждения платежей
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
    console.error('Polling error:', e.message);
  } finally {
    setTimeout(pollTelegramUpdates, 1000);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  pollTelegramUpdates();
});
