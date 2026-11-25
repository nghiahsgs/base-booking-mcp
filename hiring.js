// Base Hiring (hiring.base.vn) — đọc ứng viên, CV, bình luận.
// Dùng chung cookie với booking.base.vn (cookie set ở domain .base.vn).
// Cookie hết hạn -> hiring.base.vn redirect sang account.base.vn/a/login.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const CONFIG_PATH = path.join(__dirname, "config.json");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function hiringUrl() {
  return loadConfig().hiring_url || "https://hiring.base.vn";
}

function basessid() {
  const m = loadConfig().cookie.match(/basessid=([a-z0-9]+)/);
  return m ? m[1] : "";
}

const COOKIE_DEAD =
  'Cookie Base đã hết hạn (hiring.base.vn đẩy về trang login của account.base.vn). ' +
  'Lấy cookie mới: DevTools > Network > request bất kỳ tới base.vn > Request Headers > cookie, ' +
  "rồi dán vào trường \"cookie\" trong " + CONFIG_PATH + " và restart Claude Code.";

// ---- lấy trang + parse Client.pageData ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getHiring(urlPath) {
  const cfg = loadConfig();
  let res, lastErr;
  // Base hay rớt kết nối khi nhiều request song song -> thử lại 2 lần
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(hiringUrl() + urlPath, {
        headers: { cookie: cfg.cookie, "user-agent": UA },
        redirect: "follow",
      });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      await sleep(400 * (attempt + 1));
    }
  }
  if (lastErr)
    throw new Error(
      `Không gọi được hiring.base.vn (${lastErr.message}) sau 3 lần thử. Mạng bình thường mà vẫn lỗi thì kiểm tra cookie trong ${CONFIG_PATH}.`
    );
  const html = await res.text();
  if (res.url.includes("account.base.vn") || html.includes("<title>Đăng nhập - Base Account</title>")) {
    throw new Error(COOKIE_DEAD);
  }
  return html;
}

// Client.pageData={...} — quét ngoặc cân bằng, bỏ qua chuỗi
function extractPageData(html) {
  const re = /Client\.pageData\s*=\s*\{/g;
  let m;
  let best = null;
  while ((m = re.exec(html))) {
    const start = m.index + m[0].length - 1;
    let depth = 0,
      i = start,
      inStr = false,
      esc = false;
    for (; i < html.length; i++) {
      const c = html[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    let obj;
    try {
      obj = JSON.parse(html.slice(start, i + 1));
    } catch {
      continue;
    }
    if (Array.isArray(obj.candidates)) return obj;
    if (!best) best = obj;
  }
  if (best) return best;
  throw new Error("Không đọc được Client.pageData từ trang hiring — Base có thể đã đổi layout.");
}

function extractToken(html, key) {
  const m = html.match(new RegExp(`"${key}":"([a-f0-9]{32})"`));
  return m ? m[1] : null;
}

// ---- tiện ích ----

function noAccent(s) {
  return String(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

function fmtTime(unix) {
  if (!unix || Number(unix) <= 0) return "";
  const d = new Date((Number(unix) + 7 * 3600) * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function decodeHtml(s) {
  return String(s || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&middot;/g, "·")
    .replace(/&#(\d+);?/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

function stageName(pd, c) {
  const maps = pd.stages_maps || {};
  const list = maps[String(c.opening_id)] || [];
  const st = list.find((s) => String(s.id) === String(c.stage_id));
  if (st) return st.name;
  const logs = c.changelogs || [];
  for (let i = logs.length - 1; i >= 0; i--) {
    const n = logs[i] && logs[i].data && logs[i].data.stage_in_name;
    if (n) return n;
  }
  return `stage ${c.stage_id}`;
}

// ---- nguồn dữ liệu: danh sách ứng viên được chia sẻ ----

// Trang /candidates/shared nặng ~280KB và mọi tool đều cần nó -> cache 60s trong process,
// tránh gọi song song nhiều lần làm Base rớt kết nối.
let sharedCache = null;
let sharedInflight = null;
const SHARED_TTL_MS = 60 * 1000;

async function fetchShared() {
  if (sharedCache && Date.now() - sharedCache.at < SHARED_TTL_MS) return sharedCache.value;
  if (sharedInflight) return sharedInflight;
  sharedInflight = (async () => {
    const html = await getHiring("/candidates/shared");
    const pd = extractPageData(html);
    const value = { html, pd, candidates: pd.candidates || [] };
    sharedCache = { at: Date.now(), value };
    return value;
  })();
  try {
    return await sharedInflight;
  } finally {
    sharedInflight = null;
  }
}

function resolveCandidate(candidates, q) {
  const s = String(q).trim();
  let c = candidates.find((x) => String(x.id) === s);
  if (c) return c;
  const n = noAccent(s);
  const matches = candidates.filter(
    (x) => noAccent(x.name).includes(n) || noAccent(x.email || "").includes(n)
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1)
    throw new Error(
      `"${q}" khớp nhiều ứng viên: ${matches.map((x) => `${x.name} (${x.id})`).join(", ")}. Nói rõ hơn.`
    );
  throw new Error(
    `Không tìm thấy ứng viên "${q}" trong danh sách được chia sẻ với tài khoản này (${candidates.length} người). ` +
      `Dùng hiring_list_candidates để xem danh sách. Ứng viên không được share thì tài khoản này không đọc được.`
  );
}

// ---- tools ----

async function toolListCandidates({ opening, query, stage } = {}) {
  const { pd, candidates } = await fetchShared();
  let list = candidates;
  if (opening) {
    const o = noAccent(opening);
    list = list.filter((c) => noAccent((c.opening_export || {}).name || "").includes(o));
  }
  if (stage) {
    const s = noAccent(stage);
    list = list.filter((c) => noAccent(stageName(pd, c)).includes(s));
  }
  if (query) {
    const q = noAccent(query);
    list = list.filter((c) => noAccent(c.name).includes(q) || noAccent(c.title || "").includes(q));
  }
  if (!list.length) return "Không có ứng viên nào khớp bộ lọc.";
  const head = `Ứng viên được chia sẻ với tài khoản này: ${list.length}/${candidates.length} (tổng trên Base: ${pd.total || "?"})`;
  const rows = list.map((c) => {
    const files = (c.uploaded_files || c.files || []).length;
    const cmts = (c.stats || {}).comments || 0;
    return (
      `- ${c.name} — id ${c.id}\n` +
      `  Tin tuyển dụng: ${(c.opening_export || {}).name || "?"}\n` +
      `  Vòng: ${stageName(pd, c)}\n` +
      `  Hiện tại: ${c.title || "-"} · ${c.email || "-"} · ${c.phone || "-"}\n` +
      `  Nguồn: ${c.source || "-"} · Nộp: ${fmtTime(c.since)} · File: ${files} · Bình luận: ${cmts}`
    );
  });
  return head + "\n" + rows.join("\n");
}

async function toolGetCandidate({ candidate }) {
  if (!candidate) throw new Error("Thiếu tham số candidate (id hoặc tên).");
  const { pd, candidates } = await fetchShared();
  const c = resolveCandidate(candidates, candidate);
  const files = c.uploaded_files || c.files || [];
  const logs = (c.changelogs || []).slice(-8);
  return [
    `${c.name} — id ${c.id}`,
    `Tin tuyển dụng: ${(c.opening_export || {}).name || "?"} (opening ${c.opening_id})`,
    `Vòng hiện tại: ${stageName(pd, c)}`,
    `Email: ${c.email || "-"} · Điện thoại: ${c.phone || "-"}`,
    `Vị trí hiện tại: ${c.title || "-"}`,
    `Nguồn: ${c.source || "-"} · Người tạo: ${c.username || "-"} · Nộp: ${fmtTime(c.since)}`,
    `Cập nhật cuối: ${fmtTime(c.last_update)}`,
    `Bình luận: ${(c.stats || {}).comments || 0} (đọc bằng hiring_get_comments)`,
    "",
    files.length ? "File đính kèm:" : "File đính kèm: không có",
    ...files.map((f, i) => `  [${i}] ${f.name} (${Math.round((f.size || 0) / 1024)} KB, up bởi ${f.username}, ${fmtTime(f.since)})`),
    "",
    logs.length ? "Lịch sử gần đây:" : "",
    ...logs.map((l) => `  ${fmtTime(l.since)} — ${decodeHtml(l.name)}`),
  ]
    .filter((x) => x !== "")
    .join("\n");
}

async function loadComments(c, html) {
  const code = extractToken(html, "code");
  const otp = extractToken(html, "otp");
  if (!code || !otp) throw new Error("Không lấy được CSRF token từ trang hiring — cookie có thể sắp hết hạn.");
  const cfg = loadConfig();
  const body = new URLSearchParams({
    hid: c.hid,
    token: c.token,
    __code: code,
    __sessionid: basessid(),
    __otp: otp,
  });
  const res = await fetch(hiringUrl() + "/ajax/api/comment/load", {
    method: "POST",
    headers: {
      cookie: cfg.cookie,
      "user-agent": UA,
      origin: hiringUrl(),
      referer: hiringUrl() + "/candidates/shared",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  try {
    return JSON.parse(await res.text());
  } catch {
    throw new Error(`Base trả về không phải JSON (HTTP ${res.status}) — cookie có thể đã hết hạn.`);
  }
}

async function toolGetComments({ candidate }) {
  if (!candidate) throw new Error("Thiếu tham số candidate (id hoặc tên).");
  let shared = await fetchShared();
  let c = resolveCandidate(shared.candidates, candidate);
  let data = await loadComments(c, shared.html);
  // CSRF trong cache có thể đã cũ -> bỏ cache, lấy trang mới, thử lại đúng 1 lần
  if (!data || Number(data.code) !== 1) {
    sharedCache = null;
    shared = await fetchShared();
    c = resolveCandidate(shared.candidates, candidate);
    data = await loadComments(c, shared.html);
  }
  if (!data || Number(data.code) !== 1)
    throw new Error(`Base từ chối đọc bình luận (code ${data && data.code}, message ${data && data.message}).`);
  const comments = data.comments || [];
  const counter = Number((c.stats || {}).comments || 0);
  const note =
    counter > comments.length
      ? `\n(Base đếm ${counter} bình luận nhưng API chỉ trả ${comments.length} — phần chênh thường là bình luận đã xoá.)`
      : "";
  if (!comments.length) return `${c.name} (id ${c.id}): chưa có bình luận nào.${note}`;
  return (
    `Bình luận về ${c.name} (id ${c.id}) — ${comments.length}:${note}\n` +
    comments
      .map((cm) => {
        const files = (cm.attachments || []).map((a) => a.name).join(", ");
        return (
          `- ${cm.username || cm.name || "?"} · ${fmtTime(cm.since)}\n  ${decodeHtml(cm.content).replace(/\n/g, "\n  ")}` +
          (files ? `\n  File: ${files}` : "")
        );
      })
      .join("\n")
  );
}

function pdftotext(file) {
  const bins = ["/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext", "pdftotext"];
  for (const bin of bins) {
    try {
      return execFileSync(bin, ["-layout", file, "-"], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (e) {
      if (e && (e.code === "ENOENT" || e.code === 127)) continue;
      throw new Error(`pdftotext lỗi: ${e.message}`);
    }
  }
  return null;
}

function textutil(file) {
  try {
    return execFileSync("/usr/bin/textutil", ["-convert", "txt", "-stdout", file], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

async function toolReadCv({ candidate, file_index, max_chars }) {
  if (!candidate) throw new Error("Thiếu tham số candidate (id hoặc tên).");
  const { candidates } = await fetchShared();
  const c = resolveCandidate(candidates, candidate);
  const files = c.uploaded_files || c.files || [];
  if (!files.length) return `${c.name} (id ${c.id}): không có file đính kèm nào.`;

  let f;
  if (file_index !== undefined && file_index !== null && file_index !== "") {
    f = files[Number(file_index)];
    if (!f) throw new Error(`file_index ${file_index} không tồn tại (có ${files.length} file, index 0..${files.length - 1}).`);
  } else {
    f = files.find((x) => /\.pdf$/i.test(x.name || "")) || files[0];
  }

  const cfg = loadConfig();
  const res = await fetch(f.full_url, {
    headers: { cookie: cfg.cookie, "user-agent": UA },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Tải file thất bại (HTTP ${res.status}). Link: ${f.download_url || f.full_url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = path.join(os.tmpdir(), `base-hiring-${c.id}-${(f.name || "file").replace(/[^\w.-]/g, "_")}`);
  fs.writeFileSync(tmp, buf);

  const others = files.length > 1
    ? `\nFile khác: ${files.map((x, i) => `[${i}] ${x.name}`).filter((_, i) => files[i] !== f).join(", ")} (đọc bằng file_index)`
    : "";
  const header = `CV của ${c.name} (id ${c.id}) — file "${f.name}", ${Math.round((f.size || buf.length) / 1024)} KB${others}\n${"-".repeat(60)}\n`;

  let text = null;
  try {
    // Có file Base trả về dư vài byte trước "%PDF" (đã gặp với một CV thật),
    // nên dò chữ ký trong 1KB đầu thay vì so khớp đúng offset 0.
    const isPdf = buf.slice(0, 1024).toString("latin1").includes("%PDF");
    if (isPdf) text = pdftotext(tmp);
    else if (/\.(docx?|rtf|txt|html?)$/i.test(f.name || "")) text = textutil(tmp);
  } finally {
    // luôn xoá file tạm: đây là CV của ứng viên, không để rơi lại trong /tmp
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }

  if (!text || !text.trim()) {
    return (
      header +
      `Không tách được text từ file này (không phải PDF text, hoặc thiếu pdftotext/textutil).\n` +
      `Cài pdftotext: brew install poppler\n` +
      `Tải trực tiếp: ${f.download_url || f.full_url}`
    );
  }
  const limit = Number(max_chars) > 0 ? Number(max_chars) : 25000;
  const clean = text.replace(/\n{3,}/g, "\n\n").trim();
  return header + (clean.length > limit ? clean.slice(0, limit) + `\n\n[... cắt bớt, còn ${clean.length - limit} ký tự. Tăng max_chars để đọc tiếp]` : clean);
}

const HIRING_TOOLS = [
  {
    name: "hiring_list_candidates",
    description:
      "Liệt kê ứng viên trên Base Hiring mà tài khoản này được chia sẻ (tab CHIA SẺ) — tên, id, tin tuyển dụng, vòng hiện tại, nguồn, số file, số bình luận. Lọc được theo tin tuyển dụng / vòng / tên.",
    inputSchema: {
      type: "object",
      properties: {
        opening: { type: "string", description: "Lọc theo tên tin tuyển dụng, vd 'AI-First', 'Cyber Security'" },
        stage: { type: "string", description: "Lọc theo vòng, vd 'Rejected', 'Technical Interview'" },
        query: { type: "string", description: "Lọc theo tên ứng viên hoặc công ty hiện tại" },
      },
      required: [],
    },
    handler: toolListCandidates,
  },
  {
    name: "hiring_get_candidate",
    description:
      "Xem hồ sơ một ứng viên trên Base Hiring: liên hệ, tin tuyển dụng, vòng hiện tại, nguồn, danh sách file đính kèm (kèm index để đọc CV), lịch sử chuyển vòng.",
    inputSchema: {
      type: "object",
      properties: {
        candidate: { type: "string", description: "Id ứng viên (vd '123456') hoặc tên (vd 'Nguyen Van A')" },
      },
      required: ["candidate"],
    },
    handler: toolGetCandidate,
  },
  {
    name: "hiring_read_cv",
    description:
      "Đọc nội dung CV của một ứng viên trên Base Hiring — tải file đính kèm rồi tách text (PDF qua pdftotext). Mặc định lấy file PDF đầu tiên.",
    inputSchema: {
      type: "object",
      properties: {
        candidate: { type: "string", description: "Id ứng viên hoặc tên" },
        file_index: { type: "number", description: "Index file cần đọc (xem hiring_get_candidate). Bỏ trống = file PDF đầu tiên." },
        max_chars: { type: "number", description: "Số ký tự tối đa trả về, mặc định 25000" },
      },
      required: ["candidate"],
    },
    handler: toolReadCv,
  },
  {
    name: "hiring_get_comments",
    description:
      "Đọc các bình luận (nhận xét nội bộ) về một ứng viên trên Base Hiring — ai viết, lúc nào, nội dung.",
    inputSchema: {
      type: "object",
      properties: {
        candidate: { type: "string", description: "Id ứng viên hoặc tên" },
      },
      required: ["candidate"],
    },
    handler: toolGetComments,
  },
];

module.exports = { HIRING_TOOLS };
