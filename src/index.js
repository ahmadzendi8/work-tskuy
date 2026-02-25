import { HTML_TEMPLATE } from "./html.js";
export { GoldRoom } from "./goldDurable.js";

var SUSPICIOUS_PATHS = [
  "/admin", "/login", "/wp-admin", "/phpmyadmin", "/.env", "/config",
  "/api/admin", "/administrator", "/wp-login", "/backup", "/.git",
  "/shell", "/cmd", "/exec", "/eval", "/system", "/passwd", "/etc",
];

var rateLimitMap = new Map();
var blockedIps = new Map();
var failedAttempts = new Map();

var RATE_LIMIT_WINDOW = 60000;
var RATE_LIMIT_MAX = 60;
var RATE_LIMIT_STRICT = 120;
var BLOCK_DURATION = 300000;
var MAX_FAILED = 5;
var RATE_LIMIT_SECONDS = 5000;
var MIN_LIMIT = 0;
var MAX_LIMIT = 88888;

var lastSuccessfulCall = 0;
var lastCleanup = 0;

var RATE_LIMITED_HTML = "<!DOCTYPE html><html><head><title>429</title></head><body><h1>Too Many Requests</h1><p>Silakan coba lagi nanti.</p></body></html>";

function getClientIp(request) {
  return request.headers.get("CF-Connecting-IP") ||
    (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    "unknown";
}

function cleanupOldEntries(now) {
  if (now - lastCleanup < 30000) return;
  lastCleanup = now;

  var ipsToDelete = [];
  rateLimitMap.forEach(function (timestamps, ip) {
    var filtered = timestamps.filter(function (t) { return now - t < RATE_LIMIT_WINDOW; });
    if (filtered.length === 0) ipsToDelete.push(ip);
    else rateLimitMap.set(ip, filtered);
  });
  for (var i = 0; i < ipsToDelete.length; i++) rateLimitMap.delete(ipsToDelete[i]);

  var blockedToDelete = [];
  blockedIps.forEach(function (until, ip) {
    if (now >= until) {
      blockedToDelete.push(ip);
    }
  });
  for (var j = 0; j < blockedToDelete.length; j++) {
    blockedIps.delete(blockedToDelete[j]);
    failedAttempts.delete(blockedToDelete[j]);
  }
}

function isBlocked(ip) {
  var until = blockedIps.get(ip);
  if (!until) return false;
  if (Date.now() < until) return true;
  blockedIps.delete(ip);
  failedAttempts.delete(ip);
  return false;
}

function blockIp(ip, duration) {
  blockedIps.set(ip, Date.now() + (duration || BLOCK_DURATION));
}

function recordFailed(ip, weight) {
  var w = weight || 1;
  var now = Date.now();
  var attempts = failedAttempts.get(ip) || [];
  for (var i = 0; i < w; i++) attempts.push(now);
  attempts = attempts.filter(function (t) { return now - t < 60000; });
  failedAttempts.set(ip, attempts);
  if (attempts.length >= MAX_FAILED) blockIp(ip);
}

function checkRateLimit(ip) {
  var now = Date.now();
  cleanupOldEntries(now);

  var timestamps = rateLimitMap.get(ip) || [];
  timestamps = timestamps.filter(function (t) { return now - t < RATE_LIMIT_WINDOW; });

  if (timestamps.length >= RATE_LIMIT_STRICT) {
    rateLimitMap.set(ip, timestamps);
    blockIp(ip, 600000);
    return "blocked";
  }

  if (timestamps.length >= RATE_LIMIT_MAX) {
    rateLimitMap.set(ip, timestamps);
    return "limited";
  }

  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  return "ok";
}

function isSuspicious(path) {
  var lower = path.toLowerCase();
  for (var i = 0; i < SUSPICIOUS_PATHS.length; i++) {
    if (lower.indexOf(SUSPICIOUS_PATHS[i]) !== -1) return true;
  }
  return false;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  var result = 0;
  for (var i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}

function htmlResponse(content, status) {
  return new Response(content, {
    status: status || 200,
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}

function rateLimitedResponse() {
  return new Response(RATE_LIMITED_HTML, {
    status: 429,
    headers: { "Content-Type": "text/html", "Retry-After": "60" },
  });
}

function getGoldRoomStub(env) {
  var id = env.GOLD_ROOM.idFromName("main");
  return env.GOLD_ROOM.get(id);
}

export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    var path = url.pathname;
    var ip = getClientIp(request);

    if (isBlocked(ip)) {
      return rateLimitedResponse();
    }

    if (isSuspicious(path)) {
      recordFailed(ip, 3);
      return jsonResponse({ error: "forbidden" }, 403);
    }

    if (path === "/") {
      var rlStatus = checkRateLimit(ip);
      if (rlStatus !== "ok") return rateLimitedResponse();
      return htmlResponse(HTML_TEMPLATE);
    }

    if (path === "/ws") {
      var stub = getGoldRoomStub(env);
      return stub.fetch(request);
    }

    if (path === "/api/state") {
      var stub2 = getGoldRoomStub(env);
      return stub2.fetch(new Request(url.toString(), { method: "GET" }));
    }

    if (path.startsWith("/aturTS")) {
      var rlStatus2 = checkRateLimit(ip);
      if (rlStatus2 !== "ok") return rateLimitedResponse();

      var parts = path.split("/").filter(Boolean);

      if (parts.length < 2) {
        recordFailed(ip);
        return jsonResponse({ error: "Parameter tidak lengkap" }, 400);
      }

      var value = parts[1];
      var key = url.searchParams.get("key");

      if (!key) {
        recordFailed(ip, 2);
        return jsonResponse({ error: "Parameter key diperlukan" }, 400);
      }

      if (!timingSafeEqual(key, env.ADMIN_SECRET || "indonesia")) {
        recordFailed(ip);
        return jsonResponse({ error: "Akses ditolak" }, 403);
      }

      var intValue = parseInt(value, 10);
      if (isNaN(intValue)) {
        recordFailed(ip);
        return jsonResponse({ error: "Nilai harus berupa angka" }, 400);
      }

      var now = Date.now();
      if (now - lastSuccessfulCall < RATE_LIMIT_SECONDS) {
        return jsonResponse({ error: "Terlalu cepat, tunggu beberapa detik" }, 429);
      }

      if (intValue < MIN_LIMIT || intValue > MAX_LIMIT) {
        return jsonResponse({ error: "Nilai harus " + MIN_LIMIT + "-" + MAX_LIMIT }, 400);
      }

      lastSuccessfulCall = now;

      var stub3 = getGoldRoomStub(env);
      return stub3.fetch(new Request(url.origin + "/set-limit?value=" + intValue, { method: "GET" }));
    }

    if (path.toLowerCase().indexOf("atur") !== -1 || path.toLowerCase().indexOf("admin") !== -1 || path.toLowerCase().indexOf("config") !== -1) {
      recordFailed(ip, 2);
      return jsonResponse({ error: "Akses ditolak" }, 403);
    }

    recordFailed(ip);
    return jsonResponse({ error: "Halaman tidak ditemukan" }, 404);
  },
};
