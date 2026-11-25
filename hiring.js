// Base Hiring (hiring.base.vn) — tool về ứng viên: danh sách chia sẻ, hồ sơ, CV, bình luận. CHỈ ĐỌC.
// Dùng chung cookie với booking.base.vn (cookie set ở domain .base.vn).
// Tầng dữ liệu: hiring-data.js. Tool báo cáo (job, pipeline, báo cáo tuần, lịch phỏng vấn): hiring-reports.js.

const fs = require("fs");
const os = require("os");
const path = require("path");
const D = require("./hiring-data.js");
const { noAccent, fmtTime, decodeHtml } = D;
const { extractText } = require("./cv-text.js");
const { HIRING_REPORT_TOOLS } = require("./hiring-reports.js");

const CONTACT_HINT = "ẩn (gọi lại với include_contact=true nếu người dùng hỏi thông tin liên hệ)";

function contactLine(c, include) {
  if (!include) return `Liên hệ: ${CONTACT_HINT}`;
  return `Email: ${c.contact.email || "không có"} · Điện thoại: ${c.contact.phone || "không có"}`;
}

// ---- tìm ứng viên ở mọi nơi tài khoản có quyền xem ----

// Trả { raw, c, html, path }: raw = object gốc của Base (không trả thẳng ra ngoài), c = bản đã chuẩn hoá,
// html/path = trang chứa ứng viên, dùng để lấy CSRF khi đọc bình luận.
// Thứ tự tìm: tab Chia sẻ -> các job đang mở -> các job đã đóng (chỉ khi chưa thấy ai).
async function findCandidate(query, openingQuery) {
  const s = String(query).trim();
  const n = noAccent(s);
  const isId = /^\d+$/.test(s);
  const test = (c) =>
    isId ? String(c.id) === s : noAccent(c.name).includes(n) || noAccent(c.email || "").includes(n);
  const hits = new Map();

  const shared = await D.fetchShared();
  for (const raw of shared.candidates) {
    if (!test(raw)) continue;
    const ex = raw.opening_export || {};
    const opening = { id: String(raw.opening_id), name: String(ex.name || ""), code: String(ex.codename || "") };
    if (openingQuery && !D.matchOpening(opening, openingQuery)) continue;
    const stages = D.normalizeStages(shared.stagesMaps[opening.id]);
    hits.set(String(raw.id), { raw, c: D.normalizeCandidate(raw, stages, opening), html: shared.html, path: shared.path });
  }

  let scanned = 0;
  const info = await D.fetchOpenings();
  if (info.source === "openings" && !(isId && hits.size)) {
    const pool = openingQuery ? info.openings.filter((o) => D.matchOpening(o, openingQuery)) : info.openings;
    const scan = async (list) => {
      for (const o of list) {
        let data;
        try {
          data = await D.fetchOpening(o);
        } catch {
          continue; // job không mở được -> bỏ qua, tìm ở job khác
        }
        scanned++;
        data.raw.forEach((raw, i) => {
          if (test(raw) && !hits.has(String(raw.id)))
            hits.set(String(raw.id), { raw, c: data.candidates[i], html: data.html, path: data.path });
        });
        if (isId && hits.size) return;
      }
    };
    await scan(pool.filter((o) => !o.closed));
    if (!hits.size) await scan(pool.filter((o) => o.closed));
  }

  const found = [...hits.values()];
  if (found.length === 1) return found[0];
  if (found.length > 1)
    throw new Error(
      `"${query}" khớp nhiều ứng viên: ${found.map((h) => `${h.c.name} (id ${h.c.id}, job ${h.c.openingName || h.c.openingId})`).join("; ")}. Gọi lại bằng id.`
    );
  throw new Error(
    `Không tìm thấy ứng viên "${query}"` +
      (openingQuery ? ` trong job khớp "${openingQuery}"` : "") +
      `. Đã tìm ở tab Chia sẻ (${shared.candidates.length} người)` +
      (info.source === "openings"
        ? ` và ${scanned} job tài khoản này xem được.`
        : ". Tài khoản này không mở được trang Job nên chỉ đọc được ứng viên được chia sẻ.")
  );
}

// ---- tools ----

async function toolListCandidates({ opening, query, stage, include_contact } = {}) {
  const shared = await D.fetchShared();
  let list = shared.candidates.map((raw) => {
    const ex = raw.opening_export || {};
    const o = { id: String(raw.opening_id), name: String(ex.name || ""), code: String(ex.codename || "") };
    return D.normalizeCandidate(raw, D.normalizeStages(shared.stagesMaps[o.id]), o);
  });
  const all = list.length;
  if (opening) {
    const o = noAccent(opening);
    list = list.filter((c) => noAccent(c.openingName).includes(o));
  }
  if (stage) {
    const s = noAccent(stage);
    list = list.filter((c) => noAccent(c.stageName).includes(s));
  }
  if (query) {
    const q = noAccent(query);
    list = list.filter((c) => noAccent(c.name).includes(q) || noAccent(c.title).includes(q));
  }
  if (!list.length) return "Không có ứng viên nào khớp bộ lọc.";
  const head =
    `Ứng viên được chia sẻ với tài khoản này: ${list.length}/${all}\n` +
    `(Chỉ gồm tab Chia sẻ. Xem toàn bộ ứng viên của một job: hiring_pipeline.)`;
  const rows = list.map(
    (c) =>
      `- ${c.name} — id ${c.id}\n` +
      `  Tin tuyển dụng: ${c.openingName || "?"}\n` +
      `  Vòng: ${c.stageName}\n` +
      `  Hiện tại: ${c.title || "-"}` +
      (include_contact === true ? ` · ${c.contact.email || "-"} · ${c.contact.phone || "-"}` : "") +
      `\n  Nguồn: ${c.source || "-"} · Nộp: ${fmtTime(c.applied)} · File: ${c.files} · Bình luận: ${c.comments}`
  );
  return head + "\n" + rows.join("\n");
}

function filesOf(raw) {
  return raw.uploaded_files || raw.files || [];
}

async function toolGetCandidate({ candidate, opening, include_contact } = {}) {
  if (!candidate) throw new Error("Thiếu tham số candidate (id hoặc tên).");
  const { raw, c } = await findCandidate(candidate, opening);
  const files = filesOf(raw);
  const logs = (raw.changelogs || []).slice(-8);
  return [
    `${c.name} — id ${c.id}`,
    `Tin tuyển dụng: ${c.openingName || "?"} (opening ${c.openingId})`,
    `Vòng hiện tại: ${c.stageName}`,
    contactLine(c, include_contact === true),
    `Vị trí hiện tại: ${c.title || "-"}`,
    `Nguồn: ${c.source || "-"} · Người tạo: ${raw.username || "-"} · Nộp: ${fmtTime(c.applied)}`,
    `Cập nhật cuối: ${fmtTime(c.lastUpdate)}`,
    c.interview ? `Lịch phỏng vấn gần nhất: ${fmtTime(c.interview.time)} (${c.interview.type || "?"})` : "",
    `Bình luận: ${c.comments} (đọc bằng hiring_get_comments)`,
    "",
    files.length ? "File đính kèm:" : "File đính kèm: không có",
    ...files.map((f, i) => `  [${i}] ${f.name} (${Math.round((f.size || 0) / 1024)} KB, up bởi ${f.username}, ${fmtTime(f.since)})`),
    "",
    logs.length ? "Lịch sử gần đây:" : "",
    // dòng lịch sử của Base có thể chứa email ứng viên -> che khi không bật include_contact
    ...logs.map((l) => {
      const line = decodeHtml(l.name);
      return `  ${fmtTime(l.since)} — ${include_contact === true ? line : line.replace(/\s*\(?[\w.+-]+@[\w-]+(\.[\w-]+)+\)?/g, "")}`;
    }),
  ]
    .filter((x) => x !== "")
    .join("\n");
}

async function loadComments(hit) {
  const code = D.extractToken(hit.html, "code");
  const otp = D.extractToken(hit.html, "otp");
  if (!code || !otp) throw new Error("Không lấy được CSRF token từ trang hiring — cookie có thể sắp hết hạn.");
  if (!hit.raw.hid || !hit.raw.token)
    throw new Error("Base không trả `hid` / `token` cho ứng viên này ở trang job, nên không đọc được bình luận.");
  const cfg = D.loadConfig();
  const body = new URLSearchParams({
    hid: hit.raw.hid,
    token: hit.raw.token,
    __code: code,
    __sessionid: D.basessid(),
    __otp: otp,
  });
  // Endpoint này chỉ ĐỌC bình luận (comment/load), không ghi gì lên Base.
  const res = await fetch(D.hiringUrl() + "/ajax/api/comment/load", {
    method: "POST",
    headers: {
      cookie: cfg.cookie,
      "user-agent": D.UA,
      origin: D.hiringUrl(),
      referer: D.hiringUrl() + hit.path,
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

async function toolGetComments({ candidate, opening } = {}) {
  if (!candidate) throw new Error("Thiếu tham số candidate (id hoặc tên).");
  let hit = await findCandidate(candidate, opening);
  let data = await loadComments(hit);
  // CSRF trong cache có thể đã cũ -> bỏ cache, lấy trang mới, thử lại đúng 1 lần
  if (!data || Number(data.code) !== 1) {
    D.dropCache();
    hit = await findCandidate(candidate, opening);
    data = await loadComments(hit);
  }
  if (!data || Number(data.code) !== 1)
    throw new Error(`Base từ chối đọc bình luận (code ${data && data.code}, message ${data && data.message}).`);
  const c = hit.c;
  const comments = data.comments || [];
  const note =
    c.comments > comments.length
      ? `\n(Base đếm ${c.comments} bình luận nhưng API chỉ trả ${comments.length} — phần chênh thường là bình luận đã xoá.)`
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

// Chỉ gửi cookie tới máy chủ của Base.
function isBaseHost(url) {
  try {
    const h = new URL(url).hostname;
    return /(^|\.)base\.vn$/.test(h) || /(^|\.)basecdn\.net$/.test(h);
  } catch {
    return false;
  }
}

async function toolReadCv({ candidate, opening, file_index, max_chars, save_file } = {}) {
  if (!candidate) throw new Error("Thiếu tham số candidate (id hoặc tên).");
  const { raw, c } = await findCandidate(candidate, opening);
  const files = filesOf(raw);
  if (!files.length) return `${c.name} (id ${c.id}): không có file đính kèm nào.`;

  let f;
  if (file_index !== undefined && file_index !== null && file_index !== "") {
    f = files[Number(file_index)];
    if (!f) throw new Error(`file_index ${file_index} không tồn tại (có ${files.length} file, index 0..${files.length - 1}).`);
  } else {
    f = files.find((x) => /\.pdf$/i.test(x.name || "")) || files[0];
  }
  if (!isBaseHost(f.full_url)) throw new Error("Link file không nằm trên máy chủ của Base, không tải.");

  const res = await fetch(f.full_url, {
    headers: { cookie: D.loadConfig().cookie, "user-agent": D.UA },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Tải file thất bại (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());

  const others = files.length > 1
    ? `\nFile khác: ${files.map((x, i) => `[${i}] ${x.name}`).filter((_, i) => files[i] !== f).join(", ")} (đọc bằng file_index)`
    : "";
  const header = `CV của ${c.name} (id ${c.id}) — file "${f.name}", ${Math.round((f.size || buf.length) / 1024)} KB${others}\n${"-".repeat(60)}\n`;

  if (save_file === true) {
    const dir = path.join(os.tmpdir(), "base-hiring-cv");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const out = path.join(dir, `${c.id}-${String(f.name || "file").replace(/[^\w.-]/g, "_")}`);
    fs.writeFileSync(out, buf, { mode: 0o600 });
    return header + `Đã lưu file tại: ${out}\nĐọc file này bằng tool đọc file. Đây là CV của ứng viên: xoá file sau khi đọc xong.`;
  }

  const text = await extractText(buf, f.name);
  if (!text || !text.trim()) {
    return (
      header +
      "Không tách được text từ file này trên máy đang chạy.\n" +
      "Cách xử lý, chọn một:\n" +
      "- Gọi lại với save_file=true để lưu file ra máy rồi đọc trực tiếp (dùng được trên mọi hệ điều hành, kể cả PDF scan).\n" +
      "- PDF: chạy `npm install` trong thư mục MCP để cài pdf-parse (Windows, Linux, macOS), hoặc cài poppler (macOS: `brew install poppler`).\n" +
      "- File .doc / .rtf chỉ tách được trên macOS."
    );
  }
  const limit = Number(max_chars) > 0 ? Number(max_chars) : 25000;
  const clean = text.replace(/\n{3,}/g, "\n\n").trim();
  return header + (clean.length > limit ? clean.slice(0, limit) + `\n\n[... cắt bớt, còn ${clean.length - limit} ký tự. Tăng max_chars để đọc tiếp]` : clean);
}

const CANDIDATE_DESC = "Id ứng viên (vd '123456') hoặc tên (vd 'Nguyen Van A')";
const OPENING_DESC = "Tuỳ chọn: giới hạn tìm trong một job (id, mã job, hoặc một phần tên). Dùng khi tên bị trùng hoặc muốn tìm nhanh hơn.";

const HIRING_TOOLS = [
  {
    name: "hiring_list_candidates",
    description:
      "Liệt kê ứng viên trên Base Hiring mà tài khoản này được chia sẻ (tab CHIA SẺ) — tên, id, tin tuyển dụng, vòng hiện tại, nguồn, số file, số bình luận. Lọc được theo tin tuyển dụng / vòng / tên. Muốn xem mọi ứng viên của một job thì dùng hiring_pipeline. Mặc định không trả email / số điện thoại.",
    inputSchema: {
      type: "object",
      properties: {
        opening: { type: "string", description: "Lọc theo tên tin tuyển dụng, vd 'AI-First', 'Cyber Security'" },
        stage: { type: "string", description: "Lọc theo vòng, vd 'Rejected', 'Technical Interview'" },
        query: { type: "string", description: "Lọc theo tên ứng viên hoặc công ty hiện tại" },
        include_contact: { type: "boolean", description: "true = trả thêm email và số điện thoại. Chỉ bật khi người dùng hỏi." },
      },
      required: [],
    },
    handler: toolListCandidates,
  },
  {
    name: "hiring_get_candidate",
    description:
      "Xem hồ sơ một ứng viên trên Base Hiring, ở bất kỳ job nào tài khoản có quyền xem (không chỉ tab Chia sẻ): tin tuyển dụng, vòng hiện tại, nguồn, danh sách file đính kèm (kèm index để đọc CV), lịch sử chuyển vòng. Mặc định không trả email / số điện thoại.",
    inputSchema: {
      type: "object",
      properties: {
        candidate: { type: "string", description: CANDIDATE_DESC },
        opening: { type: "string", description: OPENING_DESC },
        include_contact: { type: "boolean", description: "true = trả thêm email và số điện thoại. Chỉ bật khi người dùng hỏi." },
      },
      required: ["candidate"],
    },
    handler: toolGetCandidate,
  },
  {
    name: "hiring_read_cv",
    description:
      "Đọc nội dung CV của một ứng viên trên Base Hiring, ở bất kỳ job nào tài khoản có quyền xem — tải file đính kèm rồi tách text (PDF, DOCX). Mặc định lấy file PDF đầu tiên. Không tách được text (PDF scan, máy thiếu công cụ) thì gọi lại với save_file=true để lấy đường dẫn file rồi đọc trực tiếp.",
    inputSchema: {
      type: "object",
      properties: {
        candidate: { type: "string", description: CANDIDATE_DESC },
        opening: { type: "string", description: OPENING_DESC },
        file_index: { type: "number", description: "Index file cần đọc (xem hiring_get_candidate). Bỏ trống = file PDF đầu tiên." },
        max_chars: { type: "number", description: "Số ký tự tối đa trả về, mặc định 25000" },
        save_file: { type: "boolean", description: "true = không tách text, lưu file vào thư mục tạm và trả đường dẫn để đọc trực tiếp." },
      },
      required: ["candidate"],
    },
    handler: toolReadCv,
  },
  {
    name: "hiring_get_comments",
    description:
      "Đọc các bình luận (nhận xét nội bộ) về một ứng viên trên Base Hiring, ở bất kỳ job nào tài khoản có quyền xem — ai viết, lúc nào, nội dung.",
    inputSchema: {
      type: "object",
      properties: {
        candidate: { type: "string", description: CANDIDATE_DESC },
        opening: { type: "string", description: OPENING_DESC },
      },
      required: ["candidate"],
    },
    handler: toolGetComments,
  },
  ...HIRING_REPORT_TOOLS,
];

module.exports = { HIRING_TOOLS, findCandidate };
