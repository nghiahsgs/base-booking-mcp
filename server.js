#!/usr/bin/env node
// MCP server: đặt phòng họp trên booking.base.vn
// Config (cookie) nằm ở config.json cùng thư mục — cookie hết hạn thì thay dòng "cookie" rồi restart Claude Code.
// CSRF (__code/__otp) được fetch fresh từ HTML mỗi lần gọi, không cần cập nhật.

const fs = require("fs");
const path = require("path");
const { HIRING_TOOLS } = require("./hiring.js");
const { TIMEOFF_TOOLS } = require("./timeoff.js");

const CONFIG_PATH = path.join(__dirname, "config.json");
const TZ_OFFSET_H = 7; // Asia/Ho_Chi_Minh, không có DST

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

// Base rotate basessid bằng 302 + Set-Cookie về chính URL đó; fetch của Node không giữ cookie
// qua redirect nên lặp vô hạn ("fetch failed"). Tự follow redirect, merge cookie mới và lưu lại config.json.
function mergeSetCookie(cookie, setCookies) {
  const jar = new Map(cookie.split(/;\s*/).filter(Boolean).map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  for (const sc of setCookies) {
    const kv = sc.split(";")[0];
    const i = kv.indexOf("=");
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function get(urlPath) {
  const cfg = loadConfig();
  let url = cfg.base_url + urlPath;
  let cookie = cfg.cookie;
  let res;
  for (let hop = 0; hop < 10; hop++) {
    res = await fetch(url, { headers: { cookie, "user-agent": UA }, redirect: "manual" });
    const setCookies = res.headers.getSetCookie();
    if (setCookies.length) cookie = mergeSetCookie(cookie, setCookies);
    if (res.status < 300 || res.status >= 400) break;
    url = new URL(res.headers.get("location"), url).toString();
  }
  if (cookie !== cfg.cookie) fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...cfg, cookie }, null, 2) + "\n");
  const html = await res.text();
  if (!html.includes('"resources":[') && !html.includes('"bookings":[')) {
    throw new Error(
      "Cookie Base có vẻ đã hết hạn (trang trả về không có dữ liệu). Cập nhật trường \"cookie\" trong " +
        CONFIG_PATH +
        " (copy từ DevTools > Network > request bất kỳ tới booking.base.vn > Request Headers > cookie) rồi thử lại."
    );
  }
  return html;
}

// Trích mảng JSON `"key":[...]` từ HTML bằng cách quét ngoặc cân bằng
function extractArray(html, key) {
  const marker = `"${key}":[`;
  const i = html.indexOf(marker);
  if (i < 0) return null;
  let depth = 0,
    j = i + marker.length - 1,
    inStr = false,
    esc = false;
  for (; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  return JSON.parse(html.slice(i + marker.length - 1, j + 1));
}

function extractToken(html, key) {
  const m = html.match(new RegExp(`"${key}":"([a-f0-9]{32})"`));
  return m ? m[1] : null;
}

function basessid() {
  const m = loadConfig().cookie.match(/basessid=([a-z0-9]+)/);
  return m ? m[1] : "";
}

// "10/08/2026" + "09:30" (giờ VN) -> unix seconds
function toUnix(dateDDMMYYYY, timeHHMM) {
  const [d, mo, y] = dateDDMMYYYY.split("/").map(Number);
  const [h, mi] = (timeHHMM || "12:00").split(":").map(Number);
  return Math.floor(Date.UTC(y, mo - 1, d, h - TZ_OFFSET_H, mi) / 1000);
}

function fmtVN(unix) {
  const d = new Date((Number(unix) + TZ_OFFSET_H * 3600) * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function normalizeDate(s) {
  // chấp nhận DD/MM/YYYY hoặc YYYY-MM-DD
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
  throw new Error(`Ngày "${s}" không đúng định dạng DD/MM/YYYY hoặc YYYY-MM-DD`);
}

async function fetchRooms() {
  const html = await get("/home");
  const rooms = (extractArray(html, "resources") || []).map((r) => {
    const cap = r.name.match(/\((\d+)p\)/);
    return {
      id: r.id,
      name: r.name,
      capacity: cap ? Number(cap[1]) : null,
      path: "/" + r.path,
      bookable: r.acl && r.acl.book === 1,
    };
  });
  return rooms;
}

async function resolveRoom(roomQuery) {
  const rooms = await fetchRooms();
  const q = String(roomQuery).toLowerCase().trim();
  let room = rooms.find((r) => r.id === q);
  if (!room) {
    const matches = rooms.filter((r) => r.name.toLowerCase().includes(q));
    if (matches.length === 1) room = matches[0];
    else if (matches.length > 1)
      throw new Error(
        `"${roomQuery}" khớp nhiều phòng: ${matches.map((r) => r.name).join(", ")}. Nói rõ hơn.`
      );
  }
  if (!room)
    throw new Error(
      `Không tìm thấy phòng "${roomQuery}". Các phòng: ${rooms.map((r) => r.name).join(", ")}`
    );
  return room;
}

async function fetchRoomBookings(room, dateDDMMYYYY) {
  const ts = toUnix(dateDDMMYYYY, "12:00");
  const html = await get(`${room.path}?ts=${ts}`);
  const bookings = extractArray(html, "bookings") || [];
  return { html, bookings };
}

function bookingsOnDate(bookings, roomId, dateDDMMYYYY) {
  const dayStart = toUnix(dateDDMMYYYY, "00:00");
  const dayEnd = dayStart + 86400;
  return bookings
    .filter(
      (b) =>
        String(b.resource_id) === String(roomId) &&
        Number(b.etime) > dayStart &&
        Number(b.stime) < dayEnd
    )
    .map((b) => ({
      id: b.id,
      name: b.name,
      by: b.username,
      start: fmtVN(b.stime),
      end: fmtVN(b.etime),
      status: b.status,
    }));
}

// ---- tools ----

async function toolListRooms() {
  const rooms = await fetchRooms();
  return (
    "Các phòng đặt được trên Base Booking:\n" +
    rooms
      .filter((r) => r.bookable)
      .map((r) => `- ${r.name} — id ${r.id}${r.capacity ? `, sức chứa ${r.capacity} người` : ""}`)
      .join("\n")
  );
}

async function toolCheckRoom({ room: roomQuery, date }) {
  date = normalizeDate(date);
  const room = await resolveRoom(roomQuery);
  const { bookings } = await fetchRoomBookings(room, date);
  const day = bookingsOnDate(bookings, room.id, date);
  if (!day.length)
    return `${room.name} trống cả ngày ${date} (chưa có booking nào).`;
  return (
    `Lịch ${room.name} ngày ${date}:\n` +
    day.map((b) => `- ${b.start} → ${b.end}: "${b.name}" (bởi ${b.by}, id ${b.id})`).join("\n")
  );
}

async function toolBookRoom({ room: roomQuery, date, start_time, end_time, title, content, force }) {
  date = normalizeDate(date);
  if (!/^\d{2}:\d{2}$/.test(start_time) || !/^\d{2}:\d{2}$/.test(end_time))
    throw new Error("start_time/end_time phải dạng HH:MM, ví dụ 09:30");
  const room = await resolveRoom(roomQuery);

  // lấy trang phòng đúng tuần: vừa lấy CSRF fresh, vừa check trùng giờ
  const { html, bookings } = await fetchRoomBookings(room, date);
  const s = toUnix(date, start_time);
  const e = toUnix(date, end_time);
  if (e <= s) throw new Error("end_time phải sau start_time");

  const conflicts = bookings.filter(
    (b) => String(b.resource_id) === String(room.id) && Number(b.etime) > s && Number(b.stime) < e
  );
  if (conflicts.length && !force) {
    return (
      `KHÔNG book: ${room.name} bị trùng giờ ngày ${date}:\n` +
      conflicts.map((b) => `- ${fmtVN(b.stime)} → ${fmtVN(b.etime)}: "${b.name}" (bởi ${b.username})`).join("\n") +
      `\nMuốn book đè (Base cho phép trùng) thì gọi lại với force=true.`
    );
  }

  const code = extractToken(html, "code");
  const otp = extractToken(html, "otp");
  if (!code || !otp) throw new Error("Không lấy được CSRF token từ trang — cookie có thể sắp hết hạn.");

  const cfg = loadConfig();
  const fd = new FormData();
  fd.append("name", title);
  fd.append("start-date", date);
  fd.append("start-time", start_time);
  fd.append("end-date", date);
  fd.append("end-time", end_time);
  fd.append("followers", "");
  fd.append("content", content || "");
  fd.append("resource_ids", "");
  fd.append("purpose_id", "0");
  fd.append("__code", code);
  fd.append("resource_id", room.id);
  fd.append("postback", "");
  fd.append("__sessionid", basessid());
  fd.append("__otp", otp);
  fd.append("__via", "__frame");

  const res = await fetch(cfg.base_url + "/ajax/api/booking/create", {
    method: "POST",
    headers: {
      cookie: cfg.cookie,
      "user-agent": UA,
      origin: cfg.base_url,
      referer: cfg.base_url + room.path,
    },
    body: fd,
  });
  const respText = await res.text();

  // xác nhận bằng cách fetch lại lịch phòng
  const after = await fetchRoomBookings(room, date);
  const mine = bookingsOnDate(after.bookings, room.id, date).filter((b) => b.name === title);
  if (mine.length) {
    const b = mine[mine.length - 1];
    return `ĐÃ BOOK: "${title}" — ${room.name}, ${b.start} → ${b.end} (booking id ${b.id}).`;
  }
  const errMatch = respText.match(/"message":"([^"]+)"/);
  throw new Error(
    `Gửi request xong nhưng không thấy booking xuất hiện trên lịch phòng. ` +
      (errMatch ? `Server báo: ${JSON.parse(`"${errMatch[1]}"`)}` : `HTTP ${res.status}. Response (500 ký tự đầu): ${respText.slice(0, 500)}`)
  );
}

async function toolCancelBooking({ booking_id, room: roomQuery, date }) {
  date = normalizeDate(date);
  const room = await resolveRoom(roomQuery);
  const { html } = await fetchRoomBookings(room, date);
  const code = extractToken(html, "code");
  const otp = extractToken(html, "otp");
  const cfg = loadConfig();
  const body = new URLSearchParams({
    id: String(booking_id),
    resource_id: String(room.id),
    remove_repeated_bookings: "0",
    __code: code,
    __sessionid: basessid(),
    __otp: otp,
  });
  const res = await fetch(cfg.base_url + "/ajax/api/booking/remove", {
    method: "POST",
    headers: {
      cookie: cfg.cookie,
      "user-agent": UA,
      origin: cfg.base_url,
      referer: cfg.base_url + room.path,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const respText = await res.text();
  const after = await fetchRoomBookings(room, date);
  const still = (after.bookings || []).some((b) => String(b.id) === String(booking_id));
  if (!still) return `Đã huỷ booking id ${booking_id}.`;
  // 1002 = không có quyền: Base tự duyệt booking xong thì người đặt mất quyền xoá (acl.remove=0)
  if (respText.includes('"message":1002')) {
    const det = await fetch(cfg.base_url + "/ajax/api/booking/get", {
      method: "POST",
      headers: {
        cookie: cfg.cookie,
        "user-agent": UA,
        origin: cfg.base_url,
        referer: cfg.base_url + room.path,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ id: String(booking_id), resource_id: String(room.id), __code: code, __sessionid: basessid(), __otp: otp }).toString(),
    })
      .then((r) => r.json())
      .catch(() => null);
    const bk = det?.data || det?.booking || det || {};
    const owners = (bk.owners || []).concat(bk.assign_to_username || []).join(", ") || "admin phòng";
    throw new Error(
      `Không có quyền huỷ booking ${booking_id}: Base duyệt tự động xong thì người đặt mất quyền xoá (acl.remove=0). Nhờ admin phòng xoá giúp (owners: ${owners}).`
    );
  }
  throw new Error(`Huỷ không thành công — booking ${booking_id} vẫn trên lịch. Response: ${respText.slice(0, 300)}`);
}

// ---- MCP stdio plumbing ----

const TOOLS = [
  {
    name: "list_rooms",
    description:
      "Liệt kê các phòng họp đặt được trên Base Booking (tên, id, sức chứa). Tên phòng dạng '19A - Loki (8p)' nghĩa là tầng 19A, 8 chỗ.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: toolListRooms,
  },
  {
    name: "check_room_schedule",
    description:
      "Xem lịch một phòng họp trong một ngày cụ thể — trả về các booking đã có (để biết khung giờ nào trống).",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Tên phòng (vd 'loki', '19A - Loki') hoặc id (vd '1234')" },
        date: { type: "string", description: "Ngày DD/MM/YYYY hoặc YYYY-MM-DD" },
      },
      required: ["room", "date"],
    },
    handler: toolCheckRoom,
  },
  {
    name: "book_room",
    description:
      "Đặt phòng họp trên Base Booking. Tự check trùng giờ trước khi book (Base cho phép booking chồng nhau nên phải check). Giờ theo múi giờ Việt Nam.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Tên phòng (vd 'loki') hoặc id" },
        date: { type: "string", description: "Ngày DD/MM/YYYY hoặc YYYY-MM-DD" },
        start_time: { type: "string", description: "Giờ bắt đầu HH:MM, vd 09:30" },
        end_time: { type: "string", description: "Giờ kết thúc HH:MM, vd 11:00" },
        title: { type: "string", description: "Tên booking, vd 'Team A — Workshop #1 [OFFLINE]'" },
        content: { type: "string", description: "Mô tả (tuỳ chọn)" },
        force: { type: "boolean", description: "true = book kể cả khi trùng giờ với booking khác" },
      },
      required: ["room", "date", "start_time", "end_time", "title"],
    },
    handler: toolBookRoom,
  },
  {
    name: "cancel_booking",
    description: "Huỷ một booking CHƯA được Base duyệt. Booking đã duyệt (phòng duyệt tự động ngay khi đặt, ví dụ 19A Loki) thì người đặt mất quyền xoá và tool này luôn trả lỗi quyền: khi dời lịch hãy book giờ mới rồi nhờ admin phòng (Giang Trần) xoá booking cũ, đừng gọi tool này. Id lấy từ check_room_schedule hoặc kết quả book_room.",
    inputSchema: {
      type: "object",
      properties: {
        booking_id: { type: "string", description: "Id booking cần huỷ" },
        room: { type: "string", description: "Phòng của booking đó (để lấy CSRF + verify)" },
        date: { type: "string", description: "Ngày của booking đó, DD/MM/YYYY" },
      },
      required: ["booking_id", "room", "date"],
    },
    handler: toolCancelBooking,
  },
  ...HIRING_TOOLS,
  ...TIMEOFF_TOOLS,
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(line);
  }
});

async function handle(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "base-vn", version: "1.0.0" },
      },
    });
  } else if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
    });
  } else if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) {
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
      return;
    }
    try {
      const text = await tool.handler(params?.arguments || {});
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: false } });
    } catch (e) {
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `Lỗi: ${e.message}` }], isError: true },
      });
    }
  } else if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
  // notifications (no id) are ignored
}
