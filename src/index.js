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
const pendingWithdraws = new Map();

function formatMoney(amount) {
  return new Intl.NumberFormat("vi-VN").format(amount);
}

function parseAmount(text, { min = 1000, max = 1000000000 } = {}) {
  const [, rawAmount] = text.trim().split(/\s+/, 2);

  if (!rawAmount) {
    return null;
  }

  const amount = Number(rawAmount.replace(/[^\d]/g, ""));

  if (!Number.isSafeInteger(amount) || amount < min || amount > max) {
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

function withdrawBankButton(bank) {
  const label = `${bank.shortBankName || "BANK"} - ${bank.bankName || bank.bankNo}`;
  return Markup.button.callback(label.slice(0, 64), `payout_bank:${bank.bankNo}`);
}

function normalizeAccountName(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^a-zA-Z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
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

function withdrawRequestMessage(withdraw) {
  return [
    "Yeu cau rut tien da duoc tao:",
    "",
    `Ngan hang: ${withdraw.bankName || withdraw.shortBankName || withdraw.bankNo}`,
    `So tai khoan: ${withdraw.accountNumber}`,
    `Chu tai khoan: ${withdraw.accountName}`,
    `So tien: ${formatMoney(withdraw.amount)} VND`,
    `Request ID: ${withdraw.requestId}`,
    "",
    "He thong se thong bao khi giao dich co ket qua."
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
  if (callback.type === "OUT") {
    return [
      "RUT TIEN THANH CONG",
      "",
      `User: ${payin.userName || "unknown"} (${payin.userId})`,
      `Amount: ${formatMoney(callback.amount)} VND`,
      `Bank: ${payin.bankName || payin.shortBankName || payin.bankNo || "N/A"}`,
      `Account: ${payin.accountNumber || "N/A"}`,
      `Account name: ${payin.accountName || "N/A"}`,
      `Request ID: ${callback.requestId}`,
      `Trans ID: ${callback.transId}`,
      `Date: ${callback.date || "N/A"}`,
      "",
      `${config.withdrawGroupCommand} ${payin.userId} ${callback.amount}`
    ].join("\n");
  }

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
  return ctx.reply("Gui /naptien <so_tien> de nap tien hoac /ruttien <so_tien> de rut tien.");
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
    type: "IN",
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

bot.command("ruttien", async (ctx) => {
  const amount = parseAmount(ctx.message.text, { min: 10000, max: 10000000 });

  if (!amount) {
    return ctx.reply("Cu phap: /ruttien <so_tien>. So tien rut tu 10.000 den 10.000.000 VND.");
  }

  const banks = await bankin.getWithdrawBanks();

  if (!Array.isArray(banks) || banks.length === 0) {
    return ctx.reply("Hien chua co ngan hang rut tien kha dung. Vui long thu lai sau.");
  }

  pendingWithdraws.set(String(ctx.from.id), {
    step: "select_bank",
    amount,
    banks,
    requestId: makeRequestId(ctx.from.id),
    chatId: ctx.chat.id,
    userId: ctx.from.id,
    userName: ctx.from.username ? `@${ctx.from.username}` : [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ")
  });

  const keyboard = banks.map((bank) => [withdrawBankButton(bank)]);

  return ctx.reply(`Chon ngan hang de rut ${formatMoney(amount)} VND:`, Markup.inlineKeyboard(keyboard));
});

bot.action(/^payout_bank:(\d+)$/, async (ctx) => {
  const bankNo = ctx.match[1];
  const pending = pendingWithdraws.get(String(ctx.from.id));

  if (!pending) {
    await ctx.answerCbQuery("Yeu cau da het han. Gui lai /ruttien <so_tien>.");
    return;
  }

  const bank = pending.banks.find((item) => String(item.bankNo) === bankNo);

  if (!bank) {
    await ctx.answerCbQuery("Ngan hang khong hop le.");
    return;
  }

  pendingWithdraws.set(String(ctx.from.id), {
    ...pending,
    step: "account_number",
    selectedBank: bank
  });

  await ctx.answerCbQuery("Da chon ngan hang.");

  return ctx.reply([
    `Rut ${formatMoney(pending.amount)} VND ve ${bank.shortBankName || bank.bankName}.`,
    "Nhap so tai khoan thu huong:"
  ].join("\n"));
});

bot.on("text", async (ctx, next) => {
  const pending = pendingWithdraws.get(String(ctx.from.id));

  if (!pending || ctx.message.text.startsWith("/")) {
    return next();
  }

  const text = ctx.message.text.trim();

  if (pending.step === "account_number") {
    const accountNumber = text.replace(/\s+/g, "");

    if (!/^\d{6,30}$/.test(accountNumber)) {
      return ctx.reply("So tai khoan khong hop le. Vui long nhap lai chi gom 6-30 chu so.");
    }

    pendingWithdraws.set(String(ctx.from.id), {
      ...pending,
      step: "account_name",
      accountNumber
    });

    return ctx.reply("Nhap ten chu tai khoan, bot se tu dong chuyen thanh IN HOA KHONG DAU:");
  }

  if (pending.step !== "account_name") {
    return next();
  }

  const accountName = normalizeAccountName(text);

  if (!accountName) {
    return ctx.reply("Ten chu tai khoan khong hop le. Vui long nhap lai.");
  }

  const bank = pending.selectedBank;
  const payout = await bankin.requestPayOut({
    requestId: pending.requestId,
    bankNo: bank.bankNo,
    accountNumber: pending.accountNumber,
    accountName,
    amount: pending.amount
  });

  if (Number(payout.status) !== 1) {
    return ctx.reply(`Tao yeu cau rut tien that bai: ${payout.message || "Khong ro ly do"}`);
  }

  const withdraw = await store.create({
    requestId: pending.requestId,
    type: "OUT",
    status: "pending",
    userId: pending.userId,
    userName: pending.userName,
    chatId: pending.chatId,
    amount: pending.amount,
    bankNo: bank.bankNo,
    bankName: bank.bankName,
    shortBankName: bank.shortBankName,
    accountNumber: pending.accountNumber,
    accountName,
    apiMessage: payout.message,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  pendingWithdraws.delete(String(ctx.from.id));

  await bot.telegram.sendMessage(config.groupChatId, [
    "YEU CAU RUT TIEN MOI",
    "",
    `User: ${withdraw.userName || "unknown"} (${withdraw.userId})`,
    `Amount: ${formatMoney(withdraw.amount)} VND`,
    `Bank: ${withdraw.bankName || withdraw.shortBankName}`,
    `Account: ${withdraw.accountNumber}`,
    `Account name: ${withdraw.accountName}`,
    `Request ID: ${withdraw.requestId}`
  ].join("\n"));

  return ctx.reply(withdrawRequestMessage(withdraw));
});

bot.catch((error, ctx) => {
  console.error("Bot error", error);
  return ctx.reply("Co loi xay ra. Vui long thu lai sau.").catch(() => {});
});

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "ctt-saobang-telegram-bot",
    callbackPath: "/bankin/callback"
  });
});

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
    return res.status(400).json({ errorCode: "1", errorDescription: "Invalid signature" });
  }

  const payin = await store.findByRequestId(requestId);

  if (!payin) {
    return res.status(404).json({ errorCode: "1", errorDescription: "Request not found" });
  }

  if (payin.status === "success") {
    return res.json({ errorCode: "0", errorDescription: "Already processed" });
  }

  if (!["IN", "OUT"].includes(callback.type)) {
    return res.status(400).json({ errorCode: "1", errorDescription: "Invalid callback type" });
  }

  if (Number(callback.status) !== 1) {
    await store.updateByRequestId(requestId, {
      status: "failed",
      callback
    });

    return res.json({ errorCode: "0", errorDescription: "Callback recorded" });
  }

  const updated = await store.updateByRequestId(requestId, {
    status: "success",
    transId: callback.transId,
    paidAmount: Number(callback.amount),
    paidAt: callback.date || new Date().toISOString(),
    callback
  });

  await bot.telegram.sendMessage(config.groupChatId, groupSuccessMessage(updated, callback));

  if (updated.chatId) {
    const successText = callback.type === "OUT"
      ? `Rut tien thanh cong: ${formatMoney(callback.amount)} VND. Ma giao dich: ${callback.transId}`
      : `Nap tien thanh cong: ${formatMoney(callback.amount)} VND. Ma giao dich: ${callback.transId}`;

    await bot.telegram.sendMessage(updated.chatId, successText).catch(() => {});
  }

  return res.json({ errorCode: "0", errorDescription: "Success" });
});

function startHttpServer() {
  const server = app.listen(config.port, config.host, () => {
    const address = server.address();
    const host = address.address === "::" || address.address === "0.0.0.0" ? "127.0.0.1" : address.address;

    console.log(`Bot is running. HTTP server listening on ${address.address}:${address.port}`);
    console.log(`Callback URL: http://${host}:${address.port}/bankin/callback`);
  });

  server.on("error", (error) => {
    console.error(`HTTP server failed to listen on ${config.host}:${config.port}`, error);
    process.exit(1);
  });

  return server;
}

async function main() {
  const server = startHttpServer();

  try {
    await bot.launch();
    console.log("Telegram bot launched");
  } catch (error) {
    server.close();
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
