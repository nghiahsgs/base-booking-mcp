// Base Timeoff — đọc quỹ phép và đề xuất nghỉ của tài khoản hiện tại.
// Cố ý chỉ đọc: không tạo, duyệt, từ chối, sửa, xóa hay hủy đề xuất.

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "config.json");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const STATUS_NAMES = { 0: "Đang chờ duyệt", 10: "Đã phê duyệt", "-10": "Đã từ chối", "-20": "Đã hủy" };

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function timeoffUrl() {
  return loadConfig().timeoff_url || "https://timeoff.base.vn";
}

function basessid() {
  const m = loadConfig().cookie.match(/basessid=([^;]+)/);
  return m ? m[1] : "";
}

const COOKIE_DEAD =
  "Cookie Base đã hết hạn. Lấy cookie mới từ DevTools > Network > request tới timeoff.base.vn > Request Headers > cookie, " +
  `rồi cập nhật trường "cookie" trong ${CONFIG_PATH}.`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(urlPath, options = {}) {
  const cfg = loadConfig();
  let response;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(timeoffUrl() + urlPath, {
        ...options,
        headers: {
          cookie: cfg.cookie,
          "user-agent": UA,
          ...(options.headers || {}),
        },
        redirect: "follow",
      });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await sleep(400 * (attempt + 1));
    }
  }
  if (lastError) {
    throw new Error(`Không gọi được timeoff.base.vn (${lastError.message}) sau 3 lần thử. ${COOKIE_DEAD}`);
  }
  const text = await response.text();
  if (
    response.url.includes("account.base.vn") ||
    text.includes("<title>Đăng nhập - Base Account</title>")
  ) {
    throw new Error(COOKIE_DEAD);
  }
  return { response, text };
}

function extractBalancedJson(source, start) {
  const opening = source[start];
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === opening) depth++;
    else if (char === closing) {
      depth--;
      if (depth === 0) return JSON.parse(source.slice(start, i + 1));
    }
  }
  throw new Error("JSON nhúng trong trang Timeoff bị thiếu dấu đóng.");
}

function extractClient(html) {
  const marker = "var Client=";
  const markerAt = html.indexOf(marker);
  if (markerAt < 0) throw new Error("Không đọc được dữ liệu Client từ Timeoff. Base có thể đã đổi layout.");
  const start = html.indexOf("{", markerAt + marker.length);
  return extractBalancedJson(html, start);
}

function extractPageData(html) {
  const marker = "Client.pageData";
  let from = 0;
  let best = null;
  while (true) {
    const markerAt = html.indexOf(marker, from);
    if (markerAt < 0) break;
    const equalsAt = html.indexOf("=", markerAt + marker.length);
    const start = html.indexOf("{", equalsAt + 1);
    if (equalsAt < 0 || start < 0 || start - equalsAt > 10) {
      from = markerAt + marker.length;
      continue;
    }
    try {
      const value = extractBalancedJson(html, start);
      if (Array.isArray(value.timeoffs)) return value;
      if (!best) best = value;
    } catch {}
    from = start + 1;
  }
  return best || {};
}

function extractToken(html, key) {
  const match = html.match(new RegExp(`"${key}":"([a-f0-9]{32})"`));
  return match ? match[1] : null;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);?/g, (_, number) => String.fromCharCode(Number(number)))
    .replace(/\r/g, "")
    .trim();
}

function noAccent(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

function fmtDate(unix) {
  if (!unix || Number(unix) <= 0) return "-";
  const date = new Date((Number(unix) + 7 * 3600) * 1000);
  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
}

function fmtDateTime(unix) {
  if (!unix || Number(unix) <= 0) return "-";
  const date = new Date((Number(unix) + 7 * 3600) * 1000);
  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function statusName(status) {
  return STATUS_NAMES[String(status)] || `Trạng thái ${status}`;
}

function shiftLines(timeoff) {
  return (timeoff.shifts || []).map((day) => {
    const shifts = (day.shifts || []).map((shift) => shift.value || shift.time).filter(Boolean).join(", ");
    const leave = (day.shifts || []).reduce((sum, shift) => sum + Number(shift.num_leave || 0), 0);
    return `  - ${fmtDate(day.datetime)}${shifts ? `: ${shifts}` : ""}${leave ? ` (${leave} ngày phép)` : ""}`;
  });
}

let homeCache = null;
let homeInflight = null;
const HOME_TTL_MS = 30 * 1000;

async function fetchHome({ fresh = false } = {}) {
  if (!fresh && homeCache && Date.now() - homeCache.at < HOME_TTL_MS) return homeCache.value;
  if (!fresh && homeInflight) return homeInflight;
  homeInflight = (async () => {
    const { text: html } = await request("/");
    const value = { html, client: extractClient(html), pageData: extractPageData(html) };
    homeCache = { at: Date.now(), value };
    return value;
  })();
  try {
    return await homeInflight;
  } finally {
    homeInflight = null;
  }
}

async function postFromHome(urlPath, data) {
  let home = await fetchHome();
  for (let attempt = 0; attempt < 2; attempt++) {
    const code = extractToken(home.html, "code");
    const otp = extractToken(home.html, "otp");
    if (!code || !otp) throw new Error("Không lấy được CSRF token từ Timeoff. Cookie có thể sắp hết hạn.");
    const body = new URLSearchParams({
      ...data,
      __code: code,
      __sessionid: basessid(),
      __otp: otp,
    });
    const result = await request(urlPath, {
      method: "POST",
      headers: {
        origin: timeoffUrl(),
        referer: timeoffUrl() + "/",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
      },
      body: body.toString(),
    });
    let parsed;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      throw new Error(`Timeoff trả về dữ liệu không phải JSON (HTTP ${result.response.status}).`);
    }
    if (Number(parsed.code) === 1) return parsed;
    if (attempt === 0) {
      homeCache = null;
      home = await fetchHome({ fresh: true });
      continue;
    }
    throw new Error(`Timeoff từ chối yêu cầu (code ${parsed.code}, message ${parsed.message}).`);
  }
}

async function toolGetMyBalance() {
  const { client } = await fetchHome();
  const types = new Map((client.timeoff_types || []).map((type) => [type.code, type.name]));
  const current = (client.ptos || []).filter((pto) => String(pto.is_current) === "1");
  const lines = current.map((pto) => {
    const name = types.get(pto.to_type_code) || pto.to_type_code || pto.name;
    const yearly = Number(pto.yearly_allowance || 0);
    const carry = Number(pto.carry || 0);
    return `- ${name}: còn ${Number(pto.balance || 0)} ngày` +
      `${yearly ? `; định mức năm ${yearly} ngày` : ""}` +
      `${carry ? `; chuyển từ kỳ trước ${carry} ngày` : ""}`;
  });
  const groups = (client.groups || [])
    .filter((group) => String(group.status) === "0")
    .map((group) => `- ${group.name} — group id ${group.id}`);
  return [
    `Quỹ nghỉ của ${client.viewer?.name || client.viewer?.username || "tài khoản hiện tại"}:`,
    ...(lines.length ? lines : ["- Không có quỹ nghỉ nào đang hiệu lực."]),
    "",
    "Nhóm đề xuất có thể dùng:",
    ...(groups.length ? groups : ["- Không có nhóm đề xuất nào."]),
  ].join("\n");
}

async function toolListMyRequests({ status, query } = {}) {
  const { pageData } = await fetchHome();
  let timeoffs = pageData.timeoffs || [];
  if (status) {
    const wanted = noAccent(status);
    timeoffs = timeoffs.filter((timeoff) => noAccent(statusName(timeoff.status)).includes(wanted));
  }
  if (query) {
    const wanted = noAccent(query);
    timeoffs = timeoffs.filter((timeoff) =>
      noAccent(`${timeoff.name || ""} ${decodeHtml(timeoff.content || "")}`).includes(wanted)
    );
  }
  if (!timeoffs.length) return "Không có đề xuất nghỉ nào khớp bộ lọc.";
  const rows = timeoffs.map((timeoff) => {
    const dates = shiftLines(timeoff);
    return [
      `- ${timeoff.name} — id ${timeoff.id}`,
      `  Trạng thái: ${statusName(timeoff.status)}`,
      `  Khoảng ngày: ${fmtDate(timeoff.start_date)} đến ${fmtDate(timeoff.end_date)}`,
      ...(dates.length ? ["  Các ca:", ...dates] : []),
      `  Tạo: ${fmtDateTime(timeoff.since)} · Cập nhật: ${fmtDateTime(timeoff.last_update)}`,
    ].join("\n");
  });
  return `Đề xuất nghỉ của tôi: ${timeoffs.length}/${pageData.num_items || timeoffs.length}\n${rows.join("\n")}`;
}

async function toolGetRequest({ request_id }) {
  if (!request_id) throw new Error("Thiếu request_id.");
  const data = await postFromHome("/ajax/timeoffs/show", { id: String(request_id) });
  const timeoff = data.timeoff;
  if (!timeoff || !timeoff.id) throw new Error(`Không đọc được đề xuất ${request_id}, hoặc tài khoản không có quyền xem.`);
  const approvers = (timeoff.owners || []).map(
    (owner) => `${owner.username}${Number(owner.approved) ? " (đã duyệt)" : " (chưa duyệt)"}`
  );
  const history = (timeoff.results || []).map(
    (result) => `- ${fmtDateTime(result.since)}: ${decodeHtml(result.note || result.name)}`
  );
  const balance = data.balance_detail || {};
  return [
    `${timeoff.name} — id ${timeoff.id}`,
    `Nhóm: ${data.group?.name || timeoff.group_id}`,
    `Trạng thái: ${statusName(timeoff.status)}`,
    `Người tạo: ${timeoff.username || timeoff.creator_username}`,
    `Khoảng ngày: ${fmtDate(timeoff.start_date)} đến ${fmtDate(timeoff.end_date)}`,
    "Các ca nghỉ:",
    ...(shiftLines(timeoff).length ? shiftLines(timeoff) : ["  - Không có dữ liệu ca."]),
    `Nội dung: ${decodeHtml(timeoff.content) || "-"}`,
    `Người duyệt: ${approvers.join(", ") || "-"}`,
    `Quyền hiện tại: xóa=${Number(timeoff.acl?.remove || 0) ? "có" : "không"}, hủy=${Number(timeoff.acl?.cancel || 0) ? "có" : "không"}`,
    `Số phép khả dụng theo nhóm này: ${Number(data.balance || 0)} ngày` +
      ` (phép năm ${Number(balance.annual || 0)}, nghỉ bù ${Number(balance.compensatory || 0)})`,
    `Tạo: ${fmtDateTime(timeoff.since)} · Cập nhật: ${fmtDateTime(timeoff.last_update)}`,
    ...(history.length ? ["Lịch sử:", ...history] : []),
  ].join("\n");
}

const TIMEOFF_TOOLS = [
  {
    name: "timeoff_get_my_balance",
    description:
      "Xem số ngày phép/nghỉ bù còn lại của tài khoản hiện tại và các nhóm đề xuất nghỉ có thể dùng trên Base Timeoff. Chỉ đọc.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: toolGetMyBalance,
  },
  {
    name: "timeoff_list_my_requests",
    description:
      "Liệt kê các đề xuất nghỉ của tài khoản hiện tại trên Base Timeoff, gồm ngày, ca và trạng thái duyệt. Chỉ đọc.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Lọc theo trạng thái, vd 'chờ duyệt', 'đã phê duyệt', 'đã từ chối', 'đã hủy'." },
        query: { type: "string", description: "Lọc theo từ khóa trong tên hoặc nội dung đề xuất." },
      },
      required: [],
    },
    handler: toolListMyRequests,
  },
  {
    name: "timeoff_get_request",
    description:
      "Xem chi tiết một đề xuất nghỉ trên Base Timeoff: ca nghỉ, trạng thái, người duyệt, lịch sử và số phép khả dụng. Chỉ đọc.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "Id đề xuất lấy từ timeoff_list_my_requests." },
      },
      required: ["request_id"],
    },
    handler: toolGetRequest,
  },
];

module.exports = { TIMEOFF_TOOLS };
