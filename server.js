{\rtf1\ansi\ansicpg1251\cocoartf2820
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;}
{\colortbl;\red255\green255\blue255;}
{\*\expandedcolortbl;;}
\margl1440\margr1440\vieww11520\viewh8400\viewkind0
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0

\f0\fs24 \cf0 const express = require('express');\
const cors = require('cors');\
const TelegramBot = require('node-telegram-bot-api');\
\
const app = express();\
app.use(express.json());\
app.use(cors());\
\
// \uc0\u1058 \u1086 \u1082 \u1077 \u1085  \u1073 \u1086 \u1090 \u1072  \u1086 \u1090  @BotFather\
const BOT_TOKEN = '8926794376:AAEsqPjnTIXI3uLSueKkIGb8Qz7UMophdGnk';
const bot = new TelegramBot(BOT_TOKEN, \{ polling: true \});\
\
// \uc0\u1041 \u1072 \u1079 \u1072  \u1076 \u1072 \u1085 \u1085 \u1099 \u1093  \u1074  \u1087 \u1072 \u1084 \u1103 \u1090 \u1080  (\u1076 \u1083 \u1103  \u1089 \u1086 \u1093 \u1088 \u1072 \u1085 \u1077 \u1085 \u1080 \u1103  \u1073 \u1072 \u1083 \u1072 \u1085 \u1089 \u1072  \u1080  \u1086 \u1090 \u1099 \u1075 \u1088 \u1099 \u1096 \u1072 )\
const usersDb = \{\};\
\
function getUser(id) \{\
  if (!usersDb[id]) \{\
    usersDb[id] = \{ balance: 0, totalDeposited: 0, totalWagered: 0 \};\
  \}\
  return usersDb[id];\
\}\
\
// 1. \uc0\u1069 \u1085 \u1076 \u1087 \u1086 \u1080 \u1085 \u1090  \u1075 \u1077 \u1085 \u1077 \u1088 \u1072 \u1094 \u1080 \u1080  \u1086 \u1092 \u1080 \u1094 \u1080 \u1072 \u1083 \u1100 \u1085 \u1086 \u1075 \u1086  \u1089 \u1095 \u1077 \u1090 \u1072  \u1085 \u1072  \u1086 \u1087 \u1083 \u1072 \u1090 \u1091  Telegram Stars\
app.post('/api/create-stars-invoice', async (req, res) => \{\
  try \{\
    const \{ userId, starsAmount \} = req.body;\
    if (!userId || !starsAmount || starsAmount < 1) \{\
      return res.status(400).json(\{ error: '\uc0\u1053 \u1077 \u1074 \u1077 \u1088 \u1085 \u1099 \u1077  \u1087 \u1072 \u1088 \u1072 \u1084 \u1077 \u1090 \u1088 \u1099 ' \});\
    \}\
\
    // \uc0\u1044 \u1083 \u1103  Telegram Stars \u1074 \u1072 \u1083 \u1102 \u1090 \u1072  \u1089 \u1090 \u1088 \u1086 \u1075 \u1086  'XTR', \u1072  provider_token \u1087 \u1091 \u1089 \u1090 \u1086 \u1081  ('')\
    const invoiceLink = await bot.createInvoiceLink(\
      '\uc0\u1055 \u1086 \u1087 \u1086 \u1083 \u1085 \u1077 \u1085 \u1080 \u1077  \u1080 \u1075 \u1088 \u1086 \u1074 \u1086 \u1075 \u1086  \u1073 \u1072 \u1083 \u1072 \u1085 \u1089 \u1072 ',\
      `\uc0\u1055 \u1086 \u1087 \u1086 \u1083 \u1085 \u1077 \u1085 \u1080 \u1077  \u1085 \u1072  $\{starsAmount\} Stars \u1076 \u1083 \u1103  \u1072 \u1082 \u1082 \u1072 \u1091 \u1085 \u1090 \u1072 `,\
      JSON.stringify(\{ userId, starsAmount, timestamp: Date.now() \}),\
      '', // provider_token \uc0\u1089 \u1090 \u1088 \u1086 \u1075 \u1086  \u1087 \u1091 \u1089 \u1090 \u1072 \u1103  \u1089 \u1090 \u1088 \u1086 \u1082 \u1072  \u1076 \u1083 \u1103  Stars!\
      'XTR',\
      [\{ label: `$\{starsAmount\} Stars`, amount: starsAmount \}]\
    );\
\
    res.json(\{ invoiceLink \});\
  \} catch (err) \{\
    console.error('\uc0\u1054 \u1096 \u1080 \u1073 \u1082 \u1072  \u1089 \u1086 \u1079 \u1076 \u1072 \u1085 \u1080 \u1103  \u1080 \u1085 \u1074 \u1086 \u1081 \u1089 \u1072 :', err);\
    res.status(500).json(\{ error: '\uc0\u1053 \u1077  \u1091 \u1076 \u1072 \u1083 \u1086 \u1089 \u1100  \u1089 \u1086 \u1079 \u1076 \u1072 \u1090 \u1100  \u1089 \u1095 \u1077 \u1090  \u1085 \u1072  \u1086 \u1087 \u1083 \u1072 \u1090 \u1091 ' \});\
  \}\
\});\
\
// 2. \uc0\u1055 \u1086 \u1083 \u1091 \u1095 \u1077 \u1085 \u1080 \u1077  \u1073 \u1072 \u1083 \u1072 \u1085 \u1089 \u1072  \u1080 \u1075 \u1088 \u1086 \u1082 \u1072 \
app.get('/api/user/:id', (req, res) => \{\
  const user = getUser(req.params.id);\
  res.json(user);\
\});\
\
// 3. \uc0\u1055 \u1088 \u1077 \u1076 \u1074 \u1072 \u1088 \u1080 \u1090 \u1077 \u1083 \u1100 \u1085 \u1086 \u1077  \u1087 \u1086 \u1076 \u1090 \u1074 \u1077 \u1088 \u1078 \u1076 \u1077 \u1085 \u1080 \u1077  \u1087 \u1083 \u1072 \u1090 \u1077 \u1078 \u1072  Telegram (\u1086 \u1073 \u1103 \u1079 \u1072 \u1090 \u1077 \u1083 \u1100 \u1085 \u1086 !)\
bot.on('pre_checkout_query', async (query) => \{\
  await bot.answerPreCheckoutQuery(query.id, true);\
\});\
\
// 4. \uc0\u1040 \u1042 \u1058 \u1054 \u1052 \u1040 \u1058 \u1048 \u1063 \u1045 \u1057 \u1050 \u1040 \u1071  \u1054 \u1041 \u1056 \u1040 \u1041 \u1054 \u1058 \u1050 \u1040  \u1059 \u1057 \u1055 \u1045 \u1064 \u1053 \u1054 \u1049  \u1054 \u1055 \u1051 \u1040 \u1058 \u1067  \u1048  \u1054 \u1058 \u1055 \u1056 \u1040 \u1042 \u1050 \u1040  \u1057 \u1054 \u1054 \u1041 \u1065 \u1045 \u1053 \u1048 \u1071 \
bot.on('successful_payment', async (msg) => \{\
  try \{\
    const payload = JSON.parse(msg.successful_payment.invoice_payload);\
    const userId = payload.userId;\
    const starsPaid = msg.successful_payment.total_amount;\
    const chatId = msg.chat.id;\
\
    // \uc0\u1053 \u1072 \u1095 \u1080 \u1089 \u1083 \u1103 \u1077 \u1084  \u1073 \u1072 \u1083 \u1072 \u1085 \u1089 \
    const user = getUser(userId);\
    user.balance += starsPaid;\
    user.totalDeposited += starsPaid;\
\
    console.log(`[\uc0\u1054 \u1055 \u1051 \u1040 \u1058 \u1040  \u1059 \u1057 \u1055 \u1045 \u1064 \u1053 \u1040 ] \u1055 \u1086 \u1083 \u1100 \u1079 \u1086 \u1074 \u1072 \u1090 \u1077 \u1083 \u1100  $\{userId\} \u1086 \u1087 \u1083 \u1072 \u1090 \u1080 \u1083  $\{starsPaid\} \u11088 `);\
\
    // \uc0\u1040 \u1074 \u1090 \u1086 \u1084 \u1072 \u1090 \u1080 \u1095 \u1077 \u1089 \u1082 \u1072 \u1103  \u1086 \u1090 \u1087 \u1088 \u1072 \u1074 \u1082 \u1072  \u1089 \u1086 \u1086 \u1073 \u1097 \u1077 \u1085 \u1080 \u1103  \u1074  \u1095 \u1072 \u1090  \u1087 \u1086 \u1083 \u1100 \u1079 \u1086 \u1074 \u1072 \u1090 \u1077 \u1083 \u1102 \
    await bot.sendMessage(\
      chatId,\
      `\uc0\u55356 \u57225  <b>\u1059 \u1089 \u1087 \u1077 \u1096 \u1085 \u1086 \u1077  \u1087 \u1086 \u1087 \u1086 \u1083 \u1085 \u1077 \u1085 \u1080 \u1077 !</b>\\n\\n` +\
      `\uc0\u11088  \u1047 \u1072 \u1095 \u1080 \u1089 \u1083 \u1077 \u1085 \u1086 : <b>+$\{starsPaid\} Stars</b>\\n` +\
      `\uc0\u55357 \u56496  \u1058 \u1077 \u1082 \u1091 \u1097 \u1080 \u1081  \u1073 \u1072 \u1083 \u1072 \u1085 \u1089 : <b>$\{user.balance\} Stars</b>\\n\\n` +\
      `<i>\uc0\u1046 \u1077 \u1083 \u1072 \u1077 \u1084  \u1087 \u1088 \u1080 \u1103 \u1090 \u1085 \u1086 \u1081  \u1080 \u1075 \u1088 \u1099  \u1080  \u1082 \u1088 \u1091 \u1087 \u1085 \u1099 \u1093  \u1080 \u1082 \u1089 \u1086 \u1074  \u1074  Crush! \u55357 \u56960 </i>`,\
      \{ parse_mode: 'HTML' \}\
    );\
  \} catch (e) \{\
    console.error('\uc0\u1054 \u1096 \u1080 \u1073 \u1082 \u1072  \u1087 \u1088 \u1080  \u1086 \u1073 \u1088 \u1072 \u1073 \u1086 \u1090 \u1082 \u1077  \u1087 \u1083 \u1072 \u1090 \u1077 \u1078 \u1072 :', e);\
  \}\
\});\
\
const PORT = process.env.PORT || 3000;\
app.listen(PORT, () => \{\
  console.log(`\uc0\u1057 \u1077 \u1088 \u1074 \u1077 \u1088  \u1073 \u1086 \u1090 \u1072  \u1079 \u1072 \u1087 \u1091 \u1097 \u1077 \u1085  \u1085 \u1072  \u1087 \u1086 \u1088 \u1090 \u1091  $\{PORT\}`);\
\});}
