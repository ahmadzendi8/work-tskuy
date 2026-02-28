var MAX_HISTORY = 1441;
var MAX_USD_HISTORY = 11;
var TREASURY_WS_URL = "wss://ws-ap1.pusher.com/app/52e99bd2c3c42e577e13?protocol=7&client=js&version=7.0.3&flash=false";
var ALARM_INTERVAL = 3000;
var HEARTBEAT_INTERVAL = 15000;

export class GoldRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Set();
    this.history = [];
    this.usdIdrHistory = [];
    this.lastBuy = null;
    this.shownUpdates = new Set();
    this.limitBulan = 888;
    this.treasuryWs = null;
    this.lastHeartbeat = 0;
    this.lastUsdFetch = 0;
    this.cachedPayload = null;
    this.payloadDirty = true;

    this.state.blockConcurrencyWhile(async () => {
      var stored = await this.state.storage.get([
        "history",
        "usdIdrHistory",
        "lastBuy",
        "shownUpdates",
        "limitBulan",
      ]);
      if (stored.get("history")) this.history = stored.get("history");
      if (stored.get("usdIdrHistory")) this.usdIdrHistory = stored.get("usdIdrHistory");
      if (stored.get("lastBuy") !== undefined && stored.get("lastBuy") !== null) this.lastBuy = stored.get("lastBuy");
      if (stored.get("shownUpdates")) this.shownUpdates = new Set(stored.get("shownUpdates"));
      if (stored.get("limitBulan") !== undefined) this.limitBulan = stored.get("limitBulan");
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL);
    });
  }

  async alarm() {
    this.connectTreasuryWs();

    var now = Date.now();

    if (now - this.lastUsdFetch >= 3000) {
      this.lastUsdFetch = now;
      await this.fetchUsdIdr();
    }

    if (this.clients.size > 0 && now - this.lastHeartbeat >= HEARTBEAT_INTERVAL) {
      this.lastHeartbeat = now;
      this.broadcast('{"ping":true}');
    }

    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL);
  }

  async saveState() {
    var updates = this.shownUpdates.size > 5000
      ? [...this.shownUpdates].slice(-1000)
      : [...this.shownUpdates];

    await this.state.storage.put({
      history: this.history,
      usdIdrHistory: this.usdIdrHistory,
      lastBuy: this.lastBuy,
      shownUpdates: updates,
      limitBulan: this.limitBulan,
    });
  }

  invalidatePayload() {
    this.payloadDirty = true;
    this.cachedPayload = null;
  }

  getStatePayload() {
    if (!this.payloadDirty && this.cachedPayload) return this.cachedPayload;

    var historyData = [];
    for (var i = 0; i < this.history.length; i++) {
      historyData.push(this.buildSingleItem(this.history[i]));
    }

    var usdData = [];
    for (var j = 0; j < this.usdIdrHistory.length; j++) {
      usdData.push({ price: this.usdIdrHistory[j].price, time: this.usdIdrHistory[j].time });
    }

    this.cachedPayload = JSON.stringify({
      history: historyData,
      usd_idr_history: usdData,
      limit_bulan: this.limitBulan,
    });

    this.payloadDirty = false;
    return this.cachedPayload;
  }

  buildSingleItem(h) {
    var buyFmt = this.formatRupiah(h.buying_rate);
    var sellFmt = this.formatRupiah(h.selling_rate);
    var diffDisplay = this.formatDiff(h.diff || 0, h.status);
    return {
      buying_rate: buyFmt,
      selling_rate: sellFmt,
      buying_rate_raw: h.buying_rate,
      selling_rate_raw: h.selling_rate,
      waktu_display: this.getTimeOnly(h.created_at) + h.status,
      diff_display: diffDisplay,
      transaction_display: "Beli: " + buyFmt + "<br>Jual: " + sellFmt + "<br>" + diffDisplay,
      created_at: h.created_at,
      jt10: this.calcProfit(h, 10000000, 9669000),
      jt30: this.calcProfit(h, 30000000, 29004000),
      jt40: this.calcProfit(h, 40000000, 38672000),
      jt50: this.calcProfit(h, 50000000, 48340000),
      jt60: this.calcProfit(h, 60000000, 58005000),
    };
  }

  formatRupiah(n) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  getTimeOnly(dateStr) {
    try {
      var dt = new Date(dateStr.replace(" ", "T") + "+07:00");
      if (isNaN(dt.getTime())) return dateStr;
      var h = dt.getUTCHours() + 7;
      if (h >= 24) h -= 24;
      var m = dt.getUTCMinutes();
      var s = dt.getUTCSeconds();
      return (h < 10 ? "0" + h : h) + ":" + (m < 10 ? "0" + m : m) + ":" + (s < 10 ? "0" + s : s);
    } catch (e) {
      return dateStr;
    }
  }

  formatDiff(diff, status) {
    if (status === "\u{1F680}") return "\u{1F680}+" + this.formatRupiah(diff);
    if (status === "\u{1F53B}") return "\u{1F53B}-" + this.formatRupiah(Math.abs(diff));
    return "\u2796tetap";
  }

  calcProfit(h, modal, pokok) {
    try {
      var gram = modal / h.buying_rate;
      var val = Math.floor(gram * h.selling_rate - pokok);
      var gramStr = gram.toFixed(4).replace(".", ",");
      if (val > 0) return "+" + this.formatRupiah(val) + "\u{1F7E2}" + gramStr + "gr";
      if (val < 0) return "-" + this.formatRupiah(Math.abs(val)) + "\u{1F534}" + gramStr + "gr";
      return this.formatRupiah(0) + "\u2796" + gramStr + "gr";
    } catch (e) {
      return "-";
    }
  }

  parseNumber(value) {
    if (typeof value === "string") {
      return parseInt(value.replace(/\./g, "").replace(/,/g, ""), 10);
    }
    return Math.floor(Number(value));
  }

  broadcast(message) {
    var dead = [];
    for (var ws of this.clients) {
      try {
        ws.send(message);
      } catch (e) {
        dead.push(ws);
      }
    }
    for (var i = 0; i < dead.length; i++) {
      this.clients.delete(dead[i]);
    }
  }

  broadcastState() {
    if (this.clients.size === 0) return;
    this.broadcast(this.getStatePayload());
  }

  async processTreasuryData(data) {
    var buy = data.buying_rate;
    var sell = data.selling_rate;
    var upd = data.created_at;

    if (!buy || !sell || !upd) return;
    if (this.shownUpdates.has(upd)) return;

    var buyNum = this.parseNumber(buy);
    var sellNum = this.parseNumber(sell);

    var diff = 0;
    var status = "\u2796";
    if (this.lastBuy !== null) {
      diff = buyNum - this.lastBuy;
      if (buyNum > this.lastBuy) status = "\u{1F680}";
      else if (buyNum < this.lastBuy) status = "\u{1F53B}";
    }

    this.history.push({
      buying_rate: buyNum,
      selling_rate: sellNum,
      status: status,
      diff: diff,
      created_at: upd,
    });

    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }

    this.lastBuy = buyNum;
    this.shownUpdates.add(upd);

    if (this.shownUpdates.size > 5000) {
      this.shownUpdates = new Set([upd]);
    }

    this.invalidatePayload();
    this.broadcastState();
    await this.saveState();
  }

  connectTreasuryWs() {
    if (this.treasuryWs) return;

    var self = this;
    try {
      var ws = new WebSocket(TREASURY_WS_URL);
      this.treasuryWs = ws;

      ws.addEventListener("open", function () {
        ws.send(JSON.stringify({
          event: "pusher:subscribe",
          data: { channel: "gold-rate" },
        }));
      });

      ws.addEventListener("message", async function (event) {
        try {
          var message = JSON.parse(event.data);
          if (message.event === "gold-rate-event") {
            var innerData = typeof message.data === "string"
              ? JSON.parse(message.data)
              : message.data;
            await self.processTreasuryData(innerData);
          }
        } catch (e) {}
      });

      ws.addEventListener("close", function () {
        self.treasuryWs = null;
      });

      ws.addEventListener("error", function () {
        try { ws.close(); } catch (e) {}
        self.treasuryWs = null;
      });
    } catch (e) {
      this.treasuryWs = null;
    }
  }

  async fetchUsdIdr() {
    try {
      var resp = await fetch("https://www.google.com/finance/quote/USD-IDR", {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "text/html,application/xhtml+xml",
          Cookie: "CONSENT=YES+cb.20231208-04-p0.en+FX+410",
        },
      });

      if (!resp.ok) return;

      var text = await resp.text();
      var match = text.match(/class="YMlKec fxKbKc"[^>]*>([^<]+)</);
      if (!match) return;

      var price = match[1].trim();
      var shouldUpdate = this.usdIdrHistory.length === 0 ||
        this.usdIdrHistory[this.usdIdrHistory.length - 1].price !== price;

      if (shouldUpdate) {
        var d = new Date(Date.now() + 7 * 60 * 60 * 1000);
        var h = d.getUTCHours();
        var m = d.getUTCMinutes();
        var s = d.getUTCSeconds();
        var timeStr = (h < 10 ? "0" + h : h) + ":" + (m < 10 ? "0" + m : m) + ":" + (s < 10 ? "0" + s : s);

        this.usdIdrHistory.push({ price: price, time: timeStr });
        if (this.usdIdrHistory.length > MAX_USD_HISTORY) {
          this.usdIdrHistory = this.usdIdrHistory.slice(-MAX_USD_HISTORY);
        }
        this.invalidatePayload();
        this.broadcastState();
        await this.saveState();
      }
    } catch (e) {}
  }

  async setLimit(value) {
    this.limitBulan = value;
    this.invalidatePayload();
    this.broadcastState();
    await this.saveState();
  }

  async fetch(request) {
    var url = new URL(request.url);

    if (url.pathname === "/ws") {
      var upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      var pair = new WebSocketPair();
      var client = pair[0];
      var server = pair[1];

      this.state.acceptWebSocket(server);
      this.clients.add(server);

      this.connectTreasuryWs();

      server.send(this.getStatePayload());

      var self = this;

      server.addEventListener("message", function (event) {
        if (event.data === "ping") {
          try { server.send('{"pong":true}'); } catch (e) {}
        }
      });

      server.addEventListener("close", function () {
        self.clients.delete(server);
      });

      server.addEventListener("error", function () {
        self.clients.delete(server);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/api/state") {
      return new Response(this.getStatePayload(), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/set-limit") {
      var value2 = parseInt(url.searchParams.get("value") || "0", 10);
      await this.setLimit(value2);
      return new Response(JSON.stringify({ status: "ok", limit_bulan: this.limitBulan }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  webSocketMessage(ws, message) {
    if (message === "ping") {
      try { ws.send('{"pong":true}'); } catch (e) {}
    }
  }

  webSocketClose(ws) {
    this.clients.delete(ws);
  }

  webSocketError(ws) {
    this.clients.delete(ws);
  }
}
