const express = require('express');
const { TonClient, WalletContractV4, internal, Cell } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');

const app = express();

// Ручная настройка CORS: гарантирует пропуск запросов из Safari / WebKit на macOS
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

const BOT_TOKEN = '8926794376:AAEsqPjnTtX13uLSueKhGb8Qz7UMophdGnk';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const ADMIN_CHAT_ID = '944873428';

// Инициализация TON клиента (Mainnet)
const tonClient = new TonClient({
  endpoint: 'https://toncenter.com/api/v2/jsonRPC'
});

const usersDb = {};

function getUser(id) {
  const strId = String(id);
  if (!usersDb[strId]) {
    usersDb[strId] = { balance: 0, totalDeposited: 0, totalWagered: 0, usedPromos: [] };
  }
  if (!usersDb[strId].usedPromos) {
    usersDb[strId].usedPromos = [];
  }
  return usersDb[strId];
}

// Список доступных промокодов
const PROMO_CODES = {
  'BONUS100': 100,
  'START100': 100
};

// 1. Создание инвойса на покупку Stars через API Fragment
async function createFragmentStarsOrder(username, starsCount) {
  const cookie = process.env.FRAGMENT_COOKIE || 'stel_token=50e875dfc79236503aabd60f38ff94fe50e875c450e8706c5890a7214cfe752224666';
  const cleanUser = username.replace('@', '').trim();

  const initRes = await fetch('https://fragment.com/api?hash=', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Cookie': cookie,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: new URLSearchParams({
      method: 'initBuyStarsRequest',
      recipient: cleanUser,
      quantity: String(starsCount)
    })
  });

  const initData = await initRes.json();
  if (!initData.ok || !initData.req_id) {
    throw new Error(initData.error || 'Ошибка создания заказа Fragment. Проверьте stel_token');
  }

  const linkRes = await fetch('https://fragment.com/api?hash=', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Cookie': cookie,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: new URLSearchParams({
      method: 'getBuyStarsLink',
      req_id: initData.req_id
    })
  });

  const linkData = await linkRes.json();
  if (!linkData.ok || !linkData.transaction) {
    throw new Error(linkData.error || 'Не удалось получить данные транзакции Fragment');
  }

  return linkData.transaction;
}

// 2. Исполнение транзакции смарт-контракта горячим кошельком TON
async function payFragmentInvoice(tx) {
  const mnemonic = process.env.TON_MNEMONIC;
  if (!mnemonic) {
    throw new Error('Переменная TON_MNEMONIC не настроена в Railway Variables');
  }

  const keyPair = await mnemonicToPrivateKey(mnemonic.trim().split(/\s+/));
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
  const contract = tonClient.open(wallet);

  const balance = await contract.getBalance();
  const requiredNano = BigInt(tx.value);

  if (balance < requiredNano + 20000000n) {
    throw new Error(`Недостаточно TON на казначейском кошельке. Баланс: ${(Number(balance) / 1e9).toFixed(3)} TON`);
  }

  const seqno = await contract.getSeqno();

  await contract.sendTransfer({
    seqno: seqno,
    secretKey: keyPair.secretKey,
    messages: [
      internal({
        to: tx.to,
        value: requiredNano,
        body: Cell.fromBase64(tx.body),
        bounce: true
      })
    ]
  });

  return { seqno, tonPaid: (Number(requiredNano) / 1e9).toFixed(3) };
}

// 3. Health check (проверка работы сервера)
app.get('/', (req, res) => {
  res.send('Server is running');
});

// 4. Создание инвойса Stars для депозита
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
    res.status(500).json({ error: err.message });
  }
});

// 5. Активация промокода
app.post('/api/activate-promo', (req, res) => {
  try {
    const { userId, promoCode } = req.body;

    if (!userId || !promoCode) {
      return res.status(400).json({ error: 'Укажите промокод' });
    }

    const code = promoCode.trim().toUpperCase();
    const bonusAmount = PROMO_CODES[code];

    if (!bonusAmount) {
      return res.status(400).json({ error: 'Неверный или недействительный промокод' });
    }

    const user = getUser(userId);

    if (user.usedPromos.includes(code)) {
      return res.status(400).json({ error: 'Вы уже активировали этот промокод!' });
    }

    user.balance += bonusAmount;
    user.totalDeposited += bonusAmount;
    user.usedPromos.push(code);

    res.json({
      success: true,
      bonusAmount: bonusAmount,
      newBalance: user.balance,
      totalDeposited: user.totalDeposited
    });
  } catch (err) {
    console.error('Ошибка промокода:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// 6. Получение баланса и профиля
app.get('/api/user/:id', (req, res) => {
  res.json(getUser(req.params.id));
});

// 7. Запись отыгрыша
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

// 8. Автоматический вывод Stars через Fragment (от 50 ⭐)
app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, amount, username, totalWageredClient } = req.body;
    const withdrawAmount = parseInt(amount);

    if (isNaN(withdrawAmount) || withdrawAmount < 50) {
      return res.status(400).json({ error: 'Минимальный вывод звёзд через Fragment — 50 ⭐' });
    }

    if (!username) {
      return res.status(400).json({ 
        error: 'Для отправки звёзд необходим публичный @username в Telegram! Установите его в настройках Telegram.' 
      });
    }

    const user = getUser(userId);

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
    let toPayoutStars = withdrawAmount - fee;
    if (toPayoutStars < 50) {
      toPayoutStars = 50;
    }

    user.balance -= withdrawAmount;

    console.log(`Покупка ${toPayoutStars} Stars через Fragment для @${username}...`);

    let txInfo = null;
    try {
      const fragmentTx = await createFragmentStarsOrder(username, toPayoutStars);
      txInfo = await payFragmentInvoice(fragmentTx);
      console.log(`Транзакция отправлена в сеть TON. Seqno: ${txInfo.seqno}`);
    } catch (orderErr) {
      user.balance += withdrawAmount;
      console.error('Ошибка вывода через Fragment:', orderErr.message);
      return res.status(500).json({ error: orderErr.message });
    }

    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: userId,
        parse_mode: 'HTML',
        text: `⭐ <b>Звёзды успешно отправлены!</b>\n\n` +
              `🎁 Начислено: <b>${toPayoutStars} Stars</b> через Fragment\n` +
              `👤 Получатель: @${username}\n\n` +
              `<i>Средства зачислятся на ваш личный аккаунт Telegram в течение 1–2 минут.</i>`
      })
    }).catch(() => {});

    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        parse_mode: 'HTML',
        text: `⚡ <b>Автовывод Stars исполнен!</b>\n\n` +
              `👤 Игрок: @${username} (ID: <code>${userId}</code>)\n` +
              `⭐ Начислено: <b>${toPayoutStars} Stars</b>\n` +
              `💎 Оплачено с горячего кошелька: ~${txInfo.tonPaid} TON`
      })
    }).catch(() => {});

    res.json({ success: true, newBalance: user.balance, toPayoutStars });
  } catch (err) {
    console.error('Критическая ошибка вывода:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// 9. Polling депозитов Stars
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
  } catch (e) {} finally {
    setTimeout(pollTelegramUpdates, 500);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  pollTelegramUpdates();
});
