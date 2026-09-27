const express = require('express');
const cors = require('cors');
const { TonClient, WalletContractV4, internal, toNano, Cell } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');

const app = express();
app.use(express.json());
app.use(cors());

// Токен бота
const BOT_TOKEN = '8926794376:AAEsqPjnTtX13uLSueKhGb8Qz7UMophdGnk';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const ADMIN_CHAT_ID = '944873428';

// Инициализация TON Mainnet клиента
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

// 1. Инициализация и отправка транзакции с горячего кошелька сервера
async function executeTonTransfer(recipientAddress, amountInTon, memoComment = '') {
  const mnemonic = process.env.TON_MNEMONIC;
  if (!mnemonic) {
    throw new Error('Переменная TON_MNEMONIC не настроена в Railway Variables');
  }

  const keyPair = await mnemonicToPrivateKey(mnemonic.trim().split(/\s+/));
  const workchain = 0;
  const wallet = WalletContractV4.create({ workchain, publicKey: keyPair.publicKey });
  const contract = tonClient.open(wallet);

  // Проверка баланса кошелька казначейства
  const contractBalance = await contract.getBalance();
  const requiredNano = toNano(amountInTon.toString());
  
  if (contractBalance < requiredNano + toNano('0.02')) {
    throw new Error(`Недостаточно TON на балансе сервера. Баланс: ${(Number(contractBalance) / 1e9).toFixed(3)} TON`);
  }

  const seqno = await contract.getSeqno();

  // Отправка транзакции в сеть TON
  await contract.sendTransfer({
    seqno: seqno,
    secretKey: keyPair.secretKey,
    messages: [
      internal({
        to: recipientAddress,
        value: requiredNano,
        body: memoComment,
        bounce: false
      })
    ]
  });

  return { seqno, senderAddress: wallet.address.toString() };
}

// 2. Создание инвойса Stars (Пополнение)
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

// 3. Получение баланса
app.get('/api/user/:id', (req, res) => {
  res.json(getUser(req.params.id));
});

// 4. Синхронизация ставок
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

// 5. АВТОМАТИЧЕСКИЙ ВЫВОД ЧЕРЕЗ ГОРЯЧИЙ КОШЕЛЁК
app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, amount, username, targetWallet, totalWageredClient } = req.body;
    const withdrawAmount = parseInt(amount);

    if (!userId || isNaN(withdrawAmount) || withdrawAmount < 10) {
      return res.status(400).json({ error: 'Минимальный вывод — 10 ⭐' });
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
    const toPayoutStars = withdrawAmount - fee;

    // Конвертация Stars в TON (1 Star ≈ 0.0025 TON, 100 Stars = 0.25 TON)
    const TON_RATE = 0.0025;
    const tonAmount = parseFloat((toPayoutStars * TON_RATE).toFixed(4));

    // Списываем баланс перед отправкой транзакции
    user.balance -= withdrawAmount;

    let destination = targetWallet;
    
    // Если игрок указал TON-адрес из Telegram Wallet, отправляем напрямую на него
    if (destination && (destination.startsWith('UQ') || destination.startsWith('EQ'))) {
      try {
        console.log(`Отправка автовывода ${tonAmount} TON на ${destination}...`);
        await executeTonTransfer(destination, tonAmount, `Payout for @${username || userId}`);
      } catch (txErr) {
        user.balance += withdrawAmount; // Откат баланса при сбое
        console.error('Ошибка транзакции в TON:', txErr.message);
        return res.status(500).json({ error: txErr.message });
      }
    } else {
      // Если адрес не указан, уведомляем админа с прямой ссылкой Fragment на аккаунт
      const fragmentUrl = `https://fragment.com/stars?recipient=${username || ''}`;
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: ADMIN_CHAT_ID,
          parse_mode: 'HTML',
          text: `🚨 <b>Заявка на покупку Stars через Fragment!</b>\n\n` +
                `👤 Игрок: @${username || 'не указан'} (ID: <code>${userId}</code>)\n` +
                `⭐ К начислению: <b>${toPayoutStars} Stars</b>\n\n` +
                `👉 <a href="${fragmentUrl}">Купить Stars для @${username} в 1 клик</a>`
        })
      });
    }

    // Оповещение игрока в боте
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: userId,
        parse_mode: 'HTML',
        text: `💎 <b>Заявка на вывод обработана!</b>\n\n` +
              `⭐ Списано: <b>${withdrawAmount} Stars</b>\n` +
              `💰 К выплате: <b>${toPayoutStars} Stars</b> (${tonAmount} TON)\n` +
              `🚀 Выплата отправлена.`
      })
    }).catch(() => {});

    res.json({ success: true, newBalance: user.balance, toPayoutStars, tonAmount });
  } catch (err) {
    console.error('Ошибка вывода:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// 6. Polling для подтверждения Stars
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
