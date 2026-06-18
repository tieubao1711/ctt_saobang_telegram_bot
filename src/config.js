const required = ["BOT_TOKEN", "GROUP_CHAT_ID", "BANKIN_API_KEY", "BANKIN_PIN"];

function loadConfig() {
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  return {
    botToken: process.env.BOT_TOKEN,
    groupChatId: process.env.GROUP_CHAT_ID,
    bankinApiBaseUrl: process.env.BANKIN_API_BASE_URL || "http://207.148.121.241:6999/api",
    bankinApiKey: process.env.BANKIN_API_KEY,
    bankinPin: process.env.BANKIN_PIN,
    successGroupCommand: process.env.SUCCESS_GROUP_COMMAND || "/congtien",
    vietqrTemplate: process.env.VIETQR_TEMPLATE || "compact2",
    port: Number(process.env.PORT || 3000)
  };
}

module.exports = { loadConfig };
