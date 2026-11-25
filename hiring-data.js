// Base Hiring (hiring.base.vn) — tầng dữ liệu dùng chung: gọi trang, đọc Client.pageData,
// chuẩn hoá job / vòng / ứng viên. Chỉ GET, không ghi gì lên Base.
//
// QUAN TRỌNG (bảo mật): pageData của Base chứa rất nhiều thứ thừa (tài khoản người dùng kèm hash
// password, email / phone / CCCD của ứng viên, token). Không tool nào được trả nguyên object của Base.
// Mọi thứ đi ra ngoài phải qua các hàm normalize* ở đây (chỉ lấy đúng trường cần dùng).

const fs = require("fs");
const path = require("path");

// BASE_VN_CONFIG: đường dẫn config khác (dùng cho test).
const CONFIG_PATH = process.env.BASE_VN_CONFIG || path.join(__dirname, "config.json");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const TZ = 7 * 3600; // Asia/Ho_Chi_Minh, không có DST
const DAY = 86400;

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
  "Cookie Base đã hết hạn (hiring.base.vn đẩy về trang login của account.base.vn). " +
  "Lấy cookie mới: DevTools > Network > request bất kỳ tới base.vn > Request Headers > cookie, " +
  "rồi chạy `node set-cookie.js` (hoặc dán vào trường \"cookie\" trong " + CONFIG_PATH + ") và reconnect MCP.";

// ---- HTTP ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rawGet(urlPath) {
  const cfg = loadConfig();
  let res, lastErr;
  // Base hay rớt kết nối -> thử lại 2 lần
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
      await sleep(500 * (attempt + 1));
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

// Base rớt kết nối khi bị gọi song song, mà báo cáo tuần phải đọc N trang job
// -> mọi request xếp hàng chạy lần lượt, cách nhau 200ms.
let chain = Promise.resolve();
function getHiring(urlPath) {
  const p = chain.then(() => rawGet(urlPath));
  chain = p.then(
    () => sleep(200),
    () => sleep(200)
  );
  return p;
}

// ---- Client.pageData ----

// Trang nào cũng có vài khối `Client.pageData={...}`, khối đầu thường rỗng.
// Quét ngoặc cân bằng (bỏ qua chuỗi) để lấy hết các khối parse được.
function pageDataBlocks(html) {
  const out = [];
  const re = /Client\.pageData\s*=\s*\{/g;
  let m;
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
    try {
      out.push(JSON.parse(html.slice(start, i + 1)));
    } catch {}
  }
  return out;
}

// Lấy khối pageData có mảng `key`. Không có -> null.
function pickPageData(html, key) {
  return pageDataBlocks(html).find((b) => Array.isArray(b[key])) || null;
}

function extractToken(html, key) {
  const m = html.match(new RegExp(`"${key}":"([a-f0-9]{32})"`));
  return m ? m[1] : null;
}

// ---- tiện ích ----

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function noAccent(s) {
  return String(s == null ? "" : s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

const p2 = (n) => String(n).padStart(2, "0");

function vn(unix) {
  return new Date((num(unix) + TZ) * 1000);
}

function fmtDate(unix) {
  if (num(unix) <= 0) return "";
  const d = vn(unix);
  return `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

function fmtTime(unix) {
  if (num(unix) <= 0) return "";
  const d = vn(unix);
  return `${fmtDate(unix)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

const WEEKDAYS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
function weekday(unix) {
  return WEEKDAYS[vn(unix).getUTCDay()];
}

// 00:00 (giờ VN) của ngày chứa `unix`
function dayStart(unix) {
  return Math.floor((num(unix) + TZ) / DAY) * DAY - TZ;
}

// [thứ Hai 00:00, thứ Hai tuần sau 00:00) theo giờ VN
function weekRange(unix) {
  const start = dayStart(unix);
  const dow = (vn(start).getUTCDay() + 6) % 7; // T2 = 0
  const from = start - dow * DAY;
  return { from, to: from + 7 * DAY };
}

// "DD/MM/YYYY" hoặc "YYYY-MM-DD" -> unix của 00:00 giờ VN
function parseDate(s) {
  const str = String(s).trim();
  let y, mo, d;
  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) [y, mo, d] = [m[1], m[2], m[3]].map(Number);
  else if ((m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) [d, mo, y] = [m[1], m[2], m[3]].map(Number);
  else throw new Error(`Ngày "${s}" không đúng định dạng DD/MM/YYYY hoặc YYYY-MM-DD.`);
  return Math.floor(Date.UTC(y, mo - 1, d) / 1000) - TZ;
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
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

// ---- chuẩn hoá ----

// Vòng của Base có `state`: active | offered | hired | failed. Tên vòng mỗi job đặt một kiểu,
// nên phân loại luôn dựa vào state, không dựa vào tên.
function bucket(state) {
  const s = String(state || "").toLowerCase();
  if (s === "failed" || s === "rejected") return "rejected";
  if (s === "hired") return "hired";
  if (s === "offered") return "offered";
  return "active";
}

function normalizeStages(list) {
  const arr = Array.isArray(list) ? list : list && typeof list === "object" ? Object.values(list) : [];
  return arr
    .filter((s) => s && typeof s === "object")
    .map((s) => ({ id: String(s.id), name: String(s.name || `stage ${s.id}`), state: String(s.state || "") }));
}

// /openings trả `stats`, tab Chia sẻ trả `xstats` — cùng một dạng. Đọc cái nào có dữ liệu.
function normalizeStats(...sources) {
  const src = sources.find((s) => s && typeof s === "object" && (s.stages || s.total !== undefined));
  if (!src) return null;
  const stages = normalizeStages(src.stages).map((s, i) => {
    const raw = (Array.isArray(src.stages) ? src.stages : Object.values(src.stages))[i] || {};
    return { ...s, total: num(raw.total) };
  });
  const hasStates = stages.some((s) => s.state);
  const sum = (b) => stages.filter((s) => bucket(s.state) === b).reduce((a, s) => a + s.total, 0);
  const pick = (b, field) => (hasStates ? sum(b) : num(src[field]));
  const out = {
    stages,
    active: pick("active", "active"),
    offered: pick("offered", "offered"),
    hired: pick("hired", "hired"),
    rejected: pick("rejected", "rejected"),
    interviews: num(src.interviews && src.interviews.total),
  };
  out.total = src.total !== undefined ? num(src.total) : out.active + out.offered + out.hired + out.rejected;
  return out;
}

const STATUS_LABEL = { 10: "Public", 7: "Internal", "-1": "Closed" };

function normalizeOpening(o) {
  const status = num(o.status);
  return {
    id: String(o.id),
    name: String(o.name || ""),
    code: String(o.codename || ""),
    company: String((o.group_export && o.group_export.name) || o.group_name || ""),
    status,
    statusLabel: STATUS_LABEL[String(status)] || String(o.status_txt || `status ${o.status}`),
    closed: status === -1,
    deadline: num(o.deadline),
    positions: num(o.num_positions),
    stats: normalizeStats(o.stats, o.xstats),
    // chỉ tên trường, để báo lỗi rõ khi Base đổi layout — không lộ dữ liệu
    statsKeys: Object.keys(o.stats || o.xstats || {}),
  };
}

// Lịch sử chuyển vòng của một ứng viên, chỉ giữ thời điểm + tên vòng.
function normalizeMoves(changelogs) {
  return (Array.isArray(changelogs) ? changelogs : [])
    .filter((l) => l && l.data && l.data.stage_in !== undefined)
    .map((l) => ({
      time: num(l.data.time) || num(l.since) || num(l.time),
      from: l.data.stage_out_name ? String(l.data.stage_out_name) : "",
      fromState: String(l.data.stage_out_state || ""),
      to: String(l.data.stage_in_name || `stage ${l.data.stage_in}`),
      toState: String(l.data.stage_in_state || ""),
      init: l.data.stage_out === undefined,
    }))
    .sort((a, b) => a.time - b.time);
}

// Whitelist trường của ứng viên. `contact` chỉ được in ra khi người dùng yêu cầu (include_contact).
function normalizeCandidate(c, stages, opening) {
  const moves = normalizeMoves(c.changelogs);
  const st = (stages || []).find((s) => s.id === String(c.stage_id));
  const last = moves[moves.length - 1];
  const since = num(c.since);
  const iv = c.interview && typeof c.interview === "object" && c.interview.id ? c.interview : null;
  return {
    id: String(c.id),
    name: String(c.name || ""),
    title: String(c.title || ""),
    source: String(c.source || ""),
    since,
    applied: since || num(c.time_apply),
    lastUpdate: num(c.last_update) || (last && last.time) || since,
    stageId: String(c.stage_id || ""),
    stageName: st ? st.name : last ? last.to : `stage ${c.stage_id}`,
    state: st ? st.state : last ? last.toState : "",
    openingId: String(c.opening_id || (opening && opening.id) || ""),
    openingName: (opening && opening.name) || String((c.opening_export && c.opening_export.name) || ""),
    moves,
    interview: iv
      ? { id: String(iv.id), time: num(iv.time), type: String(iv.metatype || ""), location: String(iv.location || "") }
      : null,
    files: (c.uploaded_files || c.files || []).length,
    comments: num(c.stats && c.stats.comments),
    contact: { email: String(c.email || ""), phone: String(c.phone || "") },
  };
}

function normalizeInterview(iv) {
  return {
    id: String(iv.id),
    time: num(iv.time),
    duration: num(iv.est_duration),
    type: String(iv.metatype || ""),
    title: String(iv.name || ""),
    candidateId: String(iv.candidate_id || ""),
    candidateName: String(iv.candidate_name || (iv.candidate_export && iv.candidate_export.name) || ""),
    openingId: String(iv.opening_id || ""),
    openingName: String(iv.opening_name || ""),
    createdBy: String(iv.username || ""),
    interviewers: (Array.isArray(iv.followers) ? iv.followers : []).map(String).filter(Boolean),
    location: String(iv.location || ""),
  };
}

// ---- cache ----

const TTL_MS = 60 * 1000;
const cache = new Map(); // key -> { at, value } ; inflight: key -> Promise
const inflight = new Map();

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    return value;
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

function dropCache(key) {
  if (key) cache.delete(key);
  else cache.clear();
}

// ---- nguồn 1: tab Chia sẻ (/candidates/shared) ----

// Tab này phân trang 20 ứng viên / trang (?page=N). Đọc hết các trang.
function fetchShared() {
  return cached("shared", async () => {
    const html = await getHiring("/candidates/shared");
    const pd = pickPageData(html, "candidates");
    if (!pd) throw new Error("Không đọc được Client.pageData từ /candidates/shared — Base có thể đã đổi layout.");
    const byId = new Map(pd.candidates.map((c) => [String(c.id), c]));
    const stagesMaps = { ...(pd.stages_maps || {}) };
    const openings = new Map((Array.isArray(pd.openings) ? pd.openings : []).map((o) => [String(o.id), o]));
    const pages = Math.min(num(pd.total_pages) || 1, 50);
    for (let page = 2; page <= pages; page++) {
      const more = pickPageData(await getHiring(`/candidates/shared?page=${page}`), "candidates");
      if (!more || !more.candidates.length) break;
      for (const c of more.candidates) byId.set(String(c.id), c);
      Object.assign(stagesMaps, more.stages_maps || {});
      for (const o of Array.isArray(more.openings) ? more.openings : []) openings.set(String(o.id), o);
    }
    return {
      html, // để lấy CSRF khi đọc bình luận
      path: "/candidates/shared",
      total: num(pd.total),
      candidates: [...byId.values()], // object gốc của Base — KHÔNG trả thẳng ra ngoài
      stagesMaps,
      openings: [...openings.values()],
    };
  });
}

// ---- nguồn 2: danh sách job (/openings) ----

// Trả { source, openings }.
//   source = "openings": tài khoản thấy được trang job (HR / người phụ trách job).
//   source = "shared":   /openings rỗng với tài khoản này -> dùng các job suy ra từ tab Chia sẻ.
function fetchOpenings() {
  return cached("openings", async () => {
    const html = await getHiring("/openings");
    const pd = pickPageData(html, "openings");
    if (!pd)
      throw new Error("Không thấy `openings` trong Client.pageData của /openings — Base có thể đã đổi layout.");
    if (pd.openings.length)
      return {
        source: "openings",
        openings: pd.openings.map(normalizeOpening),
        requests: Array.isArray(pd.opening_requests) ? pd.opening_requests.length : 0,
      };
    const shared = await fetchShared();
    return { source: "shared", openings: shared.openings.map(normalizeOpening), requests: 0 };
  });
}

// ---- nguồn 3: một job (/opening/{id}) ----

// Trả { opening, stages, candidates (đã chuẩn hoá), raw (object gốc), html, path, partial, notes }.
//   partial = true: tài khoản không mở được trang job, chỉ thấy các ứng viên được chia sẻ.
function fetchOpening(opening) {
  return cached(`opening:${opening.id}`, async () => {
    const urlPath = `/opening/${opening.id}`;
    const html = await getHiring(urlPath);
    const pd = pickPageData(html, "candidates");
    const notes = [];

    if (pd) {
      const byId = new Map(pd.candidates.map((c) => [String(c.id), c]));
      // Chưa xác nhận được trang job có phân trang hay không. Nếu Base báo nhiều trang thì đọc tiếp
      // bằng ?page=N, dừng khi trang mới không thêm ai.
      const pages = Math.min(num(pd.total_pages) || 1, 50);
      for (let page = 2; page <= pages; page++) {
        const more = pickPageData(await getHiring(`${urlPath}?page=${page}`), "candidates");
        const fresh = more ? more.candidates.filter((c) => !byId.has(String(c.id))) : [];
        if (!fresh.length) break;
        for (const c of fresh) byId.set(String(c.id), c);
      }
      const raw = [...byId.values()];
      let stages = normalizeStages(pd.stages);
      if (!stages.length && opening.stats) stages = opening.stats.stages.map(({ id, name, state }) => ({ id, name, state }));
      if (opening.stats && raw.length < opening.stats.total)
        notes.push(
          `Base báo job có ${opening.stats.total} ứng viên nhưng trang job chỉ trả ${raw.length}. Số liệu chi tiết có thể thiếu.`
        );
      return {
        opening,
        stages,
        raw,
        candidates: raw.map((c) => normalizeCandidate(c, stages, opening)),
        html,
        path: urlPath,
        partial: false,
        notes,
      };
    }

    // Không mở được trang job -> chỉ còn các ứng viên được chia sẻ riêng với tài khoản này.
    const shared = await fetchShared();
    const raw = shared.candidates.filter((c) => String(c.opening_id) === opening.id);
    if (!raw.length)
      throw new Error(
        `Tài khoản này không xem được job "${opening.name}" (id ${opening.id}) và cũng không có ứng viên nào của job này ở tab Chia sẻ.`
      );
    const stages = normalizeStages(shared.stagesMaps[opening.id]);
    notes.push(
      `Tài khoản không mở được trang job, chỉ thấy ${raw.length} ứng viên được chia sẻ` +
        (opening.stats ? ` trên tổng ${opening.stats.total}` : "") +
        "."
    );
    return {
      opening,
      stages,
      raw,
      candidates: raw.map((c) => normalizeCandidate(c, stages, opening)),
      html: shared.html,
      path: shared.path,
      partial: true,
      notes,
    };
  });
}

// ---- nguồn 4: lịch phỏng vấn (/interviews) ----

function fetchInterviews() {
  return cached("interviews", async () => {
    const pd = pickPageData(await getHiring("/interviews"), "interviews");
    if (!pd) throw new Error("Không thấy `interviews` trong Client.pageData của /interviews — Base có thể đã đổi layout.");
    return pd.interviews.map(normalizeInterview);
  });
}

// ---- chọn job theo bộ lọc ----

function matchCompany(o, company) {
  const q = noAccent(company);
  if (!q) return true;
  if (noAccent(o.company).includes(q)) return true;
  // job không gắn công ty (hoặc tài khoản không thấy trường này) -> thử khớp theo tên / mã job
  return !o.company && (noAccent(o.name).includes(q) || noAccent(o.code).includes(q));
}

function matchOpening(o, query) {
  const q = noAccent(query);
  return o.id === String(query).trim() || noAccent(o.code) === q || noAccent(o.name).includes(q) || noAccent(o.code).includes(q);
}

const STATUS_FILTERS = {
  open: (o) => !o.closed,
  all: () => true,
  public: (o) => o.status === 10,
  internal: (o) => o.status === 7,
  closed: (o) => o.closed,
};

function filterByStatus(openings, status) {
  const key = noAccent(status || "open");
  const fn = STATUS_FILTERS[key];
  if (!fn) throw new Error(`status "${status}" không hợp lệ. Dùng: open (mặc định), public, internal, closed, all.`);
  return openings.filter(fn);
}

module.exports = {
  CONFIG_PATH,
  UA,
  DAY,
  loadConfig,
  hiringUrl,
  basessid,
  getHiring,
  pageDataBlocks,
  pickPageData,
  extractToken,
  num,
  noAccent,
  fmtDate,
  fmtTime,
  weekday,
  dayStart,
  weekRange,
  parseDate,
  nowUnix,
  decodeHtml,
  bucket,
  normalizeStages,
  normalizeStats,
  normalizeOpening,
  normalizeMoves,
  normalizeCandidate,
  normalizeInterview,
  dropCache,
  fetchShared,
  fetchOpenings,
  fetchOpening,
  fetchInterviews,
  matchCompany,
  matchOpening,
  filterByStatus,
};
