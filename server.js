const express = require('express');
const { TonClient, WalletContractV4, internal, Cell } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');

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

const BOT_TOKEN = '8926794376:AAEsqPjnTtXl3uLSueKHGb8Qz7UMophdGnk';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const ADMIN_CHAT_ID = '944873428';

const tonClient = new TonClient({
  endpoint: 'https://toncenter.com/api/v2/jsonRPC'
});

const usersDb = {};

function getUser(id) {
  const strId = String(id);
  if (!usersDb[strId]) {
    usersDb[strId] = { balance: 0, totalDeposited: 0, totalWagered: 0 };
  }
  return usersDb[strId];
}

// 1. Создание инвойса на покупку Stars через API Fragment
async function createFragmentStarsOrder(username, starsCount) {
  const cookie = process.env.FRAGMENT_COOKIE || 'stel_token=50e875dfc79236503aabd60f38ff94fe50e875c450e8706c5890a7214cfe752224666';
  
  // Для поиска Fragment обязательно нужен '@', а для recipient — без '@'
  const rawUser = username.trim().replace(/^@+/, '');
  const searchUser = `@${rawUser}`;

  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

  let apiHash = '';
  try {
    const pageRes = await fetch('https://fragment.com/stars', {
      headers: { 'Cookie': cookie, 'User-Agent': userAgent }
    });
    const pageHtml = await pageRes.text();
    const hashMatch = pageHtml.match(/Tgc\.initApi\s*\(\s*["']\/api\?hash=([^"']+)["']/i) 
                   || pageHtml.match(/\/api\?hash=([a-f0-9]+)/i);
    if (hashMatch) apiHash = hashMatch[1];
  } catch(e) {}

  const apiUrl = `https://fragment.com/api?hash=${apiHash}`;
  console.log(`[FRAGMENT] URL: ${apiUrl} | Поиск пользователя: ${searchUser}`);

  const commonHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Cookie': cookie,
    'User-Agent': userAgent,
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': 'https://fragment.com/stars'
  };

  // Шаг 1: Поиск пользователя с префиксом @
  const stateRes = await fetch(apiUrl, {
    method: 'POST',
    headers: commonHeaders,
    body: new URLSearchParams({
      method: 'updateStarsBuyState',
      query: searchUser,
      quantity: String(starsCount)
    })
  });

  const stateText = await stateRes.text();
  console.log('[FRAGMENT updateStarsBuyState]:', stateText);

  let stateData;
  try {
    stateData = JSON.parse(stateText);
  } catch (err) {
    throw new Error('Fragment вернул некорректный ответ при поиске');
  }

  if (!stateData.ok) {
    throw new Error(stateData.error || 'Пользователь не найден на Fragment');
  }

  // Получаем точный recipient из результата поиска
  const recipient = (stateData.recipient && stateData.recipient.username) ? stateData.recipient.username : rawUser;

  // Шаг 2: Инициализация заказа
  const initRes = await fetch(apiUrl, {
    method: 'POST',
    headers: commonHeaders,
    body: new URLSearchParams({
      method: 'initBuyStarsRequest',
      recipient: recipient,
      quantity: String(starsCount)
    })
  });

  const initText = await initRes.text();
  console.log('[FRAGMENT initBuyStarsRequest]:', initText);

  let initData;
  try {
    initData = JSON.parse(initText);
  } catch (err) {
    throw new Error('Fragment вернул некорректный ответ: ' + initText.substring(0, 80));
  }

  if (!initData.ok || !initData.req_id) {
    throw new Error(initData.error || 'Ошибка инициализации Fragment');
  }

  // Шаг 3: Получение транзакции для смарт-контракта
  const linkRes = await fetch(apiUrl, {
    method: 'POST',
    headers: commonHeaders,
    body: new URLSearchParams({
      method: 'getBuyStarsLink',
      req_id: initData.req_id
    })
  });

  const linkData = await linkRes.json();
  console.log('[FRAGMENT getBuyStarsLink]:', linkData);

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

app.get('/', (req, res) => {
  res.send('Server is running');
});

// Начисление админу
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

// Создание инвойса Stars
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
      return res.status(500).json({ error: tgData.description || 'Не удалось сформировать инвойс' });
    }

    res.json({ invoiceLink: tgData.result });
  } catch (err) {
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

// Вывод Stars через Fragment
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

// Polling депозитов Stars
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
