#!/usr/bin/env node
// Ghi cookie Base vào config.json rồi gọi thử Base để kiểm tra cookie còn sống.
// Cách dùng:
//   1. Copy giá trị header `cookie` trong DevTools (Network > request tới booking.base.vn).
//   2. node set-cookie.js            (macOS: đọc từ clipboard)
//      hoặc: pbpaste | node set-cookie.js -    (đọc từ stdin, dùng được trên mọi hệ điều hành)
// Script không in cookie ra màn hình.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const CONFIG_PATH = path.join(__dirname, "config.json");
const EXAMPLE_PATH = path.join(__dirname, "config.example.json");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function fail(msg) {
  console.error("Lỗi: " + msg);
  process.exit(1);
}

function readInput() {
  if (process.argv[2] === "-" || !process.stdin.isTTY) return fs.readFileSync(0, "utf8");
  if (process.platform === "darwin") return execFileSync("pbpaste", { encoding: "utf8" });
  fail("Hệ điều hành này không có pbpaste. Hãy đưa cookie qua stdin: <lệnh dán clipboard> | node set-cookie.js -");
}

function mergeSetCookie(cookie, setCookies) {
  const jar = new Map(
    cookie.split(/;\s*/).filter(Boolean).map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i), kv.slice(i + 1)];
    })
  );
  for (const sc of setCookies) {
    const kv = sc.split(";")[0];
    const i = kv.indexOf("=");
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

// Base đổi basessid bằng 302 + Set-Cookie về chính URL đó, nên phải tự follow redirect và giữ cookie mới.
async function check(baseUrl, cookie) {
  let url = baseUrl.replace(/\/$/, "") + "/home";
  for (let i = 0; i < 6; i++) {
    const res = await fetch(url, { headers: { cookie, "user-agent": UA }, redirect: "manual" });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (setCookies.length) cookie = mergeSetCookie(cookie, setCookies);
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location"), url).toString();
      if (/account\.base\.vn\/a\/login/.test(url)) return { ok: false, cookie };
      continue;
    }
    const html = await res.text();
    return { ok: html.includes('"resources":'), cookie };
  }
  return { ok: false, cookie };
}

(async () => {
  let cookie = readInput().trim().replace(/^cookie:\s*/i, "").replace(/[\r\n]+/g, "");
  if (!cookie) fail("Không có gì để đọc. Hãy copy giá trị header `cookie` trước khi chạy.");
  if (!/(^|;\s*)basessid=[^;]+/.test(cookie))
    fail("Nội dung vừa dán không có `basessid=`. Hãy copy đúng giá trị header `cookie` của một request tới booking.base.vn.");

  const cfg = JSON.parse(fs.readFileSync(fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_PATH, "utf8"));

  let result;
  try {
    result = await check(cfg.base_url || "https://booking.base.vn", cookie);
  } catch (e) {
    fail(`Không gọi được Base (${e.message}). Kiểm tra mạng rồi chạy lại. Chưa ghi gì vào config.json.`);
  }
  if (!result.ok)
    fail("Base không nhận cookie này (trang trả về không có dữ liệu). Hãy đăng nhập lại Base trong trình duyệt, copy cookie mới rồi chạy lại. Chưa ghi gì vào config.json.");

  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...cfg, cookie: result.cookie }, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(CONFIG_PATH, 0o600);
  console.log("Cookie hợp lệ, đã ghi vào " + CONFIG_PATH + ".");
  console.log("Bước tiếp theo: restart Claude Code, hoặc gõ /mcp rồi reconnect base-booking.");
})();
