const express = require('express');
const cors = require('cors');
const { TonClient, WalletContractV4, internal, Cell } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');

const app = express();
app.use(express.json());
app.use(cors());

// Токен бота
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
    usersDb[strId] = { balance: 0, totalDeposited: 0, totalWagered: 0 };
  }
  return usersDb[strId];
}

// 1. Создание заказа на покупку Stars через внутренний API Fragment
async function createFragmentStarsOrder(username, starsCount) {
  const cookie = process.env.FRAGMENT_COOKIE || 'stel_token=50e875dfc79236503aabd60f38ff94fe50e875c450e8706c5890a7214cfe752224666';
  const cleanUser = username.replace('@', '').trim();

  // 1 этап: Инициализация заявки
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
    throw new Error(initData.error || 'Ошибка инициализации ордера на Fragment (проверьте stel_token)');
  }

  // 2 этап: Получение смарт-контракта и транзакции для оплаты
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
    throw new Error(linkData.error || 'Не удалось сформировать транзакцию оплаты Stars');
  }

  return linkData.transaction;
}

// 2. Исполнение транзакции оплаты смарт-контракта горячим TON-кошельком
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

  // Проверяем баланс на оплату контракта + 0.02 TON на сетевой газ
  if (balance < requiredNano + 20000000n) {
    throw new Error(`Недостаточно TON на казначейском кошельке бота. Баланс: ${(Number(balance) / 1e9).toFixed(3)} TON`);
  }

  const seqno = await contract.getSeqno();

  // Транслируем транзакцию в смарт-контракт Fragment
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

// 3. Создание инвойса Stars для депозита
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

// 4. Получение баланса
app.get('/api/user/:id', (req, res) => {
  res.json(getUser(req.params.id));
});

// 5. Запись отыгрыша (вейджер)
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

// 6. АВТОМАТИЧЕСКИЙ ВЫВОД STARS ЧЕРЕЗ FRAGMENT НА АККАУНТ ИГРОКА (ОТ 50 ⭐)
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

    if (user.totalWagered < user.totalDeposited) {
      return res.status(400).json({ 
        error: `Вейджер не отыгран на 100%! Отыграно: ${user.totalWagered}/${user.totalDeposited} ⭐` 
      });
    }

    // Расчет суммы (Fragment принимает покупки с шагом или от 50 штук)
    const fee = Math.floor(withdrawAmount * 0.15);
    let toPayoutStars = withdrawAmount - fee;
    if (toPayoutStars < 50) {
      toPayoutStars = 50; 
    }

    // Списываем звёзды перед отправкой транзакции
    user.balance -= withdrawAmount;

    console.log(`Покупка ${toPayoutStars} Stars через Fragment для @${username}...`);

    let txInfo = null;
    try {
      const fragmentTx = await createFragmentStarsOrder(username, toPayoutStars);
      txInfo = await payFragmentInvoice(fragmentTx);
      console.log(`Транзакция отправлена в блокчейн TON. Seqno: ${txInfo.seqno}`);
    } catch (orderErr) {
      user.balance += withdrawAmount; // Откат списания при сбое
      console.error('Ошибка вывода через Fragment:', orderErr.message);
      return res.status(500).json({ error: orderErr.message });
    }

    // Сообщение пользователю в боте
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

    // Уведомление администратора
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        parse_mode: 'HTML',
        text: `⚡ <b>Автовывод Stars исполнен!</b>\n\n` +
              `👤 Игрок: @${username} (ID: <code>${userId}</code>)\n` +
              `⭐ Начислено: <b>${toPayoutStars} Stars</b>\n` +
              `💎 Оплачено с казначейства: ~${txInfo.tonPaid} TON`
      })
    }).catch(() => {});

    res.json({ success: true, newBalance: user.balance, toPayoutStars });
  } catch (err) {
    console.error('Критическая ошибка вывода:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// 7. Polling депозитов Stars
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
