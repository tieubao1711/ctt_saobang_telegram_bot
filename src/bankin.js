const crypto = require("crypto");

function md5(value) {
  return crypto.createHash("md5").update(value).digest("hex");
}

function toUrl(baseUrl, path, params) {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}/`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  return url;
}

class BankinClient {
  constructor({ baseUrl, apiKey, pin }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.pin = pin;
  }

  async requestJson(url) {
    const response = await fetch(url);
    const body = await response.text();

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error(`Bank API returned non-JSON response: ${body.slice(0, 200)}`);
    }

    if (!response.ok) {
      throw new Error(`Bank API HTTP ${response.status}: ${JSON.stringify(payload)}`);
    }

    return payload;
  }

  getActiveBanks() {
    return this.requestJson(toUrl(this.baseUrl, "GET_ACTIVE_BANKS", {
      api_key: this.apiKey
    }));
  }

  requestPayIn({ requestId, bankId, amount }) {
    return this.requestJson(toUrl(this.baseUrl, "B_REQUEST_PAY_IN", {
      api_key: this.apiKey,
      request_id: requestId,
      bid: bankId,
      amount,
      signature: md5(`${this.apiKey}${requestId}${this.pin}`)
    }));
  }

  getWithdrawBanks() {
    return this.requestJson(toUrl(this.baseUrl, "B_REQUEST_BANK_LIST", {
      api_key: this.apiKey
    }));
  }

  requestPayOut({ requestId, bankNo, accountNumber, accountName, amount }) {
    return this.requestJson(toUrl(this.baseUrl, "B_REQUEST_PAY_OUT", {
      api_key: this.apiKey,
      request_id: requestId,
      bankno: bankNo,
      account_number: accountNumber,
      account_name: accountName,
      amount,
      signature: md5(`${this.apiKey}${requestId}${this.pin}`)
    }));
  }

  verifyCallbackSignature({ requestId, transId, signature }) {
    if (!requestId || !transId || !signature) {
      return false;
    }

    return md5(`${requestId}${transId}${this.pin}`).toLowerCase() === String(signature).toLowerCase();
  }
}

module.exports = { BankinClient, md5 };
