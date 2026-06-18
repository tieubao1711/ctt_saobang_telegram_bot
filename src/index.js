require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { loadConfig } = require("./config");
const { BankinClient } = require("./bankin");
const { PayinStore } = require("./store");

const config = loadConfig();
const bot = new Telegraf(config.botToken);
const bankin = new BankinClient({
  baseUrl: config.bankinApiBaseUrl,
  apiKey: config.bankinApiKey,
  pin: config.bankinPin
});
const store = new PayinStore(path.join(__dirname, "..", "data", "payins.json"));

const pendingRequests = new Map();

function formatMoney(amount) {
  return new Intl.NumberFormat("vi-VN").format(amount);
}

function parseAmount(text) {
  const [, rawAmount] = text.trim().split(/\s+/, 2);

  if (!rawAmount) {
    return null;
  }

  const amount = Number(rawAmount.replace(/[^\d]/g, ""));

  if (!Number.isSafeInteger(amount) || amount < 1000 || amount > 1000000000) {
    return null;
  }

  return amount;
}

function makeRequestId(userId) {
  return `${userId}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function bankButton(bank) {
  const label = `${bank.bankCode || "BANK"} - ${bank.bank_name || bank.bankName || bank.bankAccountNumber}`;
  return Markup.button.callback(label.slice(0, 64), `payin_bank:${bank.bankId}`);
}

function paymentMessage(payment) {
  return [
    "Thong tin thanh toan:",
    "",
    `Ngan hang: ${payment.bankName || payment.bankCode}`,
    `So tai khoan: ${payment.bankAccountNumber}`,
    `Chu tai khoan: ${payment.bankAccountName}`,
    `So tien: ${formatMoney(payment.amount)} VND`,
    `Noi dung CK: ${payment.code}`,
    "",
    "Vui long chuyen dung so tien va noi dung de he thong xac nhan tu dong."
  ].join("\n");
}

function makeVietQrUrl(payment) {
  const bankCode = payment.bankCode;
  const accountNumber = payment.bankAccountNumber;

  if (!bankCode || !accountNumber) {
    return null;
  }

  const template = encodeURIComponent(config.vietqrTemplate);
  const url = new URL(`https://img.vietqr.io/image/${encodeURIComponent(bankCode)}-${encodeURIComponent(accountNumber)}-${template}.png`);

  url.searchParams.set("amount", String(payment.amount));
  url.searchParams.set("addInfo", payment.code || "");
  url.searchParams.set("accountName", payment.bankAccountName || "");

  return url.toString();
}

async function sendPaymentInfo(ctx, payment) {
  const message = paymentMessage(payment);
  const qrUrl = makeVietQrUrl(payment);

  if (!qrUrl) {
    return ctx.reply(message);
  }

  try {
    return await ctx.replyWithPhoto(qrUrl, { caption: message });
  } catch (error) {
    console.error("Unable to send VietQR image", error);
    return ctx.reply(`${message}\n\nQR: ${qrUrl}`);
  }
}

function groupSuccessMessage(payin, callback) {
  return [
    "NAP TIEN THANH CONG",
    "",
    `User: ${payin.userName || "unknown"} (${payin.userId})`,
    `Amount: ${formatMoney(callback.amount)} VND`,
    `Request ID: ${callback.requestId}`,
    `Trans ID: ${callback.transId}`,
    `Date: ${callback.date || "N/A"}`,
    "",
    `${config.successGroupCommand} ${payin.userId} ${callback.amount}`
  ].join("\n");
}

bot.start((ctx) => {
  return ctx.reply("Gui /naptien <so_tien> de tao yeu cau nap tien.");
});

bot.command("naptien", async (ctx) => {
  const amount = parseAmount(ctx.message.text);

  if (!amount) {
    return ctx.reply("Cu phap: /naptien <so_tien>. So tien tu 1.000 den 1.000.000.000 VND.");
  }

  const banks = await bankin.getActiveBanks();

  if (!Array.isArray(banks) || banks.length === 0) {
    return ctx.reply("Hien chua co ngan hang kha dung. Vui long thu lai sau.");
  }

  const requestId = makeRequestId(ctx.from.id);
  pendingRequests.set(String(ctx.from.id), {
    amount,
    banks,
    requestId,
    chatId: ctx.chat.id,
    userId: ctx.from.id,
    userName: ctx.from.username ? `@${ctx.from.username}` : [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ")
  });

  const keyboard = banks.map((bank) => [bankButton(bank)]);

  return ctx.reply(`Chon ngan hang de nap ${formatMoney(amount)} VND:`, Markup.inlineKeyboard(keyboard));
});

bot.action(/^payin_bank:(\d+)$/, async (ctx) => {
  const bankId = Number(ctx.match[1]);
  const pending = pendingRequests.get(String(ctx.from.id));

  if (!pending) {
    await ctx.answerCbQuery("Yeu cau da het han. Gui lai /naptien <so_tien>.");
    return;
  }

  const bank = pending.banks.find((item) => Number(item.bankId) === bankId);

  if (!bank) {
    await ctx.answerCbQuery("Ngan hang khong hop le.");
    return;
  }

  await ctx.answerCbQuery("Dang tao yeu cau thanh toan...");

  const payment = await bankin.requestPayIn({
    requestId: pending.requestId,
    bankId,
    amount: pending.amount
  });

  if (Number(payment.errorCode) !== 1) {
    return ctx.reply(`Tao yeu cau that bai: ${payment.message || "Khong ro ly do"}`);
  }

  await store.create({
    requestId: pending.requestId,
    status: "pending",
    userId: pending.userId,
    userName: pending.userName,
    chatId: pending.chatId,
    amount: pending.amount,
    bankId,
    bankCode: payment.bankCode,
    bankName: payment.bankName,
    bankAccountNumber: payment.bankAccountNumber,
    bankAccountName: payment.bankAccountName,
    transferCode: payment.code,
    tHash: payment.tHash,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  pendingRequests.delete(String(ctx.from.id));

  return sendPaymentInfo(ctx, payment);
});

bot.catch((error, ctx) => {
  console.error("Bot error", error);
  return ctx.reply("Co loi xay ra. Vui long thu lai sau.").catch(() => {});
});

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/bankin/callback", async (req, res) => {
  const callback = req.body || {};
  const requestId = callback.requestId;

  if (!bankin.verifyCallbackSignature({
    requestId,
    transId: callback.transId,
    signature: callback.signature
  })) {
    return res.status(400).json({ ok: false, message: "Invalid signature" });
  }

  const payin = await store.findByRequestId(requestId);

  if (!payin) {
    return res.status(404).json({ ok: false, message: "Request not found" });
  }

  if (payin.status === "success") {
    return res.json({ ok: true, message: "Already processed" });
  }

  if (Number(callback.status) !== 1 || callback.type !== "IN") {
    await store.updateByRequestId(requestId, {
      status: "failed",
      callback
    });

    return res.json({ ok: true, message: "Callback recorded" });
  }

  const updated = await store.updateByRequestId(requestId, {
    status: "success",
    transId: callback.transId,
    paidAmount: Number(callback.amount),
    paidAt: callback.date || new Date().toISOString(),
    callback
  });

  await bot.telegram.sendMessage(config.groupChatId, groupSuccessMessage(updated, callback));

  return res.json({ ok: true });
});

async function main() {
  await bot.launch();
  app.listen(config.port, () => {
    console.log(`Bot is running. Callback URL: http://localhost:${config.port}/bankin/callback`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
