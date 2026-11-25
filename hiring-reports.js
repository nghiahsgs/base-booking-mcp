// Base Hiring — nhóm tool báo cáo tuyển dụng (CHỈ ĐỌC): danh sách job, pipeline, báo cáo tuần, lịch phỏng vấn.
// Không tool nào ở đây chuyển vòng hay sửa gì trên Base.
// Các hàm build* là hàm thuần (nhận dữ liệu đã chuẩn hoá, trả text) để test bằng fixture: `node --test`.

const D = require("./hiring-data.js");
const { DAY, bucket, fmtDate, fmtTime, weekday, noAccent } = D;

const SHARED_NOTE =
  "Tài khoản này không thấy job nào ở trang Job của Base, nên số liệu dưới đây chỉ dựa trên các ứng viên được chia sẻ (tab Chia sẻ).";

const inProgress = (c) => bucket(c.state) === "active" || bucket(c.state) === "offered";

function staleDaysOf(c, now) {
  return Math.floor((now - c.lastUpdate) / DAY);
}

function isStale(c, now, staleDays) {
  return inProgress(c) && c.lastUpdate > 0 && now - c.lastUpdate > staleDays * DAY;
}

function jobLabel(o) {
  const bits = [o.code, o.company].filter(Boolean).join(", ");
  return bits ? `${o.name} (${bits})` : o.name;
}

function contactOf(c) {
  return [c.contact.email, c.contact.phone].filter(Boolean).join(", ") || "không có";
}

function parseStaleDays(v) {
  if (v === undefined || v === null || v === "") return 7;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error("stale_days phải là số ngày >= 0.");
  return n;
}

// ---- chọn job + nạp dữ liệu ----

async function selectOpenings({ opening, company, status }) {
  const info = await D.fetchOpenings();
  let list = info.openings;
  if (opening) {
    const q = noAccent(opening);
    const exact = list.filter((o) => o.id === String(opening).trim() || noAccent(o.code) === q);
    list = exact.length ? exact : list.filter((o) => D.matchOpening(o, opening));
    if (!list.length)
      throw new Error(
        `Không tìm thấy job "${opening}". Các job tài khoản này thấy: ${info.openings.map((o) => `${o.name} [${o.code || o.id}]`).join("; ") || "không có"}.`
      );
  } else {
    list = D.filterByStatus(list, status);
  }
  if (company) {
    list = list.filter((o) => D.matchCompany(o, company));
    if (!list.length) {
      const names = [...new Set(info.openings.map((o) => o.company).filter(Boolean))];
      throw new Error(
        `Không có job nào khớp công ty "${company}"` +
          (names.length ? `. Các công ty đang có job: ${names.join(", ")}.` : ". Tài khoản này không thấy tên công ty của job nào.")
      );
    }
  }
  return { source: info.source, requests: info.requests, openings: list };
}

// Đọc lần lượt từng job. Job nào lỗi thì ghi chú lại, không làm hỏng cả báo cáo.
async function loadOpenings(openings) {
  const datas = [];
  const errors = [];
  for (const o of openings) {
    try {
      datas.push(await D.fetchOpening(o));
    } catch (e) {
      errors.push(`${o.name}: ${e.message}`);
    }
  }
  return { datas, errors };
}

// ---- 1. hiring_list_openings ----

function buildOpeningsList({ source, openings, requests }, { status, company } = {}) {
  if (!openings.length) return "Không có job nào khớp bộ lọc.";
  const head = [`Job tuyển dụng trên Base Hiring: ${openings.length}` + (company ? ` (công ty khớp "${company}")` : "")];
  head.push(`Bộ lọc trạng thái: ${status || "open (mọi job chưa Closed)"}`);
  if (source === "shared") head.push(`Lưu ý: ${SHARED_NOTE} Số đếm theo vòng vẫn là số của cả job.`);
  if (requests) head.push(`Yêu cầu tuyển dụng chưa thành job: ${requests}`);
  const rows = openings.map((o) => {
    const lines = [
      `- ${o.name}`,
      `  Mã: ${o.code || "không có"} · id ${o.id} · Công ty: ${o.company || "không rõ"}`,
      `  Trạng thái: ${o.statusLabel} · Deadline: ${fmtDate(o.deadline) || "không đặt"}`,
    ];
    const s = o.stats;
    if (!s) {
      lines.push(
        `  Số liệu: không đọc được (Base không trả stats cho job này` +
          (o.statsKeys.length ? `, các trường có: ${o.statsKeys.join(", ")}` : "") +
          `)`
      );
    } else {
      lines.push(
        `  Ứng viên: tổng ${s.total} · đang xử lý ${s.active} · offer ${s.offered} · đã tuyển ${s.hired} · bị loại ${s.rejected}` +
          (s.interviews ? ` · phỏng vấn đã lên lịch ${s.interviews}` : "")
      );
      if (s.stages.length) lines.push(`  Theo vòng: ${s.stages.map((st) => `${st.name} ${st.total}`).join(" | ")}`);
    }
    return lines.join("\n");
  });
  return head.join("\n") + "\n\n" + rows.join("\n");
}

async function toolListOpenings({ status, company } = {}) {
  const sel = await selectOpenings({ status, company });
  return buildOpeningsList(sel, { status, company });
}

// ---- 2. hiring_pipeline ----

function buildPipeline(datas, { staleDays = 7, includeContact = false, now, source, errors = [] } = {}) {
  const out = [];
  if (source === "shared") out.push(`Lưu ý: ${SHARED_NOTE}`, "");
  let staleTotal = 0;
  let shown = 0;
  for (const d of datas) {
    const o = d.opening;
    const live = d.candidates.filter(inProgress);
    if (o.closed && !live.length && datas.length > 1) continue; // job đã đóng và sạch -> không cần nhắc
    shown++;
    const count = (b) => d.candidates.filter((c) => bucket(c.state) === b).length;
    out.push(`## ${jobLabel(o)}`);
    out.push(`Trạng thái: ${o.statusLabel} · Deadline: ${fmtDate(o.deadline) || "không đặt"} · id ${o.id}`);
    out.push(`Đang xử lý: ${live.length} · Đã tuyển: ${count("hired")} · Bị loại: ${count("rejected")}`);
    for (const n of d.notes) out.push(`Lưu ý: ${n}`);
    if (o.closed && live.length)
      out.push(`CẢNH BÁO: job đã đóng nhưng còn ${live.length} ứng viên chưa chuyển sang Rejected.`);
    if (!live.length) {
      out.push("Không có ứng viên nào đang xử lý.", "");
      continue;
    }
    // nhóm theo vòng, giữ đúng thứ tự vòng của job
    const order = d.stages.map((s) => s.id);
    const groups = new Map();
    for (const c of live) {
      if (!groups.has(c.stageId)) groups.set(c.stageId, { name: c.stageName, list: [] });
      groups.get(c.stageId).list.push(c);
    }
    const idx = (id) => (order.indexOf(id) < 0 ? 999 : order.indexOf(id));
    for (const [, g] of [...groups].sort((a, b) => idx(a[0]) - idx(b[0]))) {
      out.push(`### ${g.name} (${g.list.length})`);
      for (const c of g.list.sort((a, b) => a.lastUpdate - b.lastUpdate)) {
        const stale = isStale(c, now, staleDays);
        if (stale) staleTotal++;
        out.push(
          `- ${c.name} (id ${c.id})` + (stale ? ` [ĐỌNG ${staleDaysOf(c, now)} ngày]` : ""),
          `  Hiện tại: ${c.title || "không rõ"} · Nguồn: ${c.source || "không rõ"}`,
          `  Nộp: ${fmtDate(c.applied) || "không rõ"} · Cập nhật cuối: ${fmtTime(c.lastUpdate) || "không rõ"}`
        );
        if (includeContact) out.push(`  Liên hệ: ${contactOf(c)}`);
      }
    }
    out.push("");
  }
  if (!shown) out.push("Không có job nào còn ứng viên đang xử lý.", "");
  out.push(`Hồ sơ đọng (không cập nhật quá ${staleDays} ngày): ${staleTotal}`);
  for (const e of errors) out.push(`Không đọc được: ${e}`);
  return out.join("\n");
}

async function toolPipeline({ opening, company, stale_days, include_contact } = {}) {
  const staleDays = parseStaleDays(stale_days);
  // Lọc theo công ty thì lấy cả job đã đóng, để bắt job đóng mà còn ứng viên treo.
  const sel = await selectOpenings({ opening, company, status: company ? "all" : "open" });
  // Job đã đóng mà stats báo không còn ai đang xử lý -> khỏi tải trang job.
  const todo = sel.openings.filter(
    (o) => opening || !o.closed || !o.stats || o.stats.active + o.stats.offered > 0
  );
  const { datas, errors } = await loadOpenings(todo);
  return buildPipeline(datas, {
    staleDays,
    includeContact: include_contact === true,
    now: D.nowUnix(),
    source: sel.source,
    errors,
  });
}

// ---- lịch phỏng vấn (dùng chung cho báo cáo tuần và hiring_interview_schedule) ----

// Gộp 2 nguồn: trang /interviews (đủ người phỏng vấn, thời lượng) và trường `interview` trên từng ứng viên.
function collectInterviews(pageInterviews, datas, { from, to, openingIds } = {}) {
  const inRange = (t) => t >= from && t < to;
  const byCandidate = new Map();
  for (const d of datas) for (const c of d.candidates) byCandidate.set(c.id, c);
  const map = new Map();
  for (const iv of pageInterviews || []) {
    if (!inRange(iv.time)) continue;
    if (openingIds && !openingIds.has(iv.openingId)) continue;
    const c = byCandidate.get(iv.candidateId);
    map.set(iv.id, {
      time: iv.time,
      duration: iv.duration,
      type: iv.type,
      candidate: iv.candidateName || (c && c.name) || "?",
      opening: iv.openingName || (c && c.openingName) || "?",
      stage: c ? c.stageName : "",
      interviewers: iv.interviewers.length ? iv.interviewers : iv.createdBy ? [iv.createdBy] : [],
      location: iv.location,
    });
  }
  for (const d of datas) {
    for (const c of d.candidates) {
      const iv = c.interview;
      if (!iv || !inRange(iv.time) || map.has(iv.id)) continue;
      map.set(iv.id, {
        time: iv.time,
        duration: 0,
        type: iv.type,
        candidate: c.name,
        opening: c.openingName,
        stage: c.stageName,
        interviewers: [],
        location: iv.location,
      });
    }
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

function interviewLine(iv) {
  const meta = [iv.type, iv.duration ? `${iv.duration} phút` : ""].filter(Boolean).join(", ");
  const loc = iv.location.length > 80 ? iv.location.slice(0, 77) + "..." : iv.location;
  return (
    `- ${weekday(iv.time)} ${fmtTime(iv.time)}${meta ? ` (${meta})` : ""}: ${iv.candidate}, job ${iv.opening}` +
    (iv.stage ? `, vòng hiện tại: ${iv.stage}` : "") +
    `, người phỏng vấn: ${iv.interviewers.join(", ") || "Base không trả"}` +
    (loc ? `, địa điểm: ${loc}` : "")
  );
}

// ---- 3. hiring_weekly_report ----

function weekEvents(d, { from, to }) {
  const inRange = (t) => t >= from && t < to;
  const ev = { fresh: [], moved: [], offered: [], hired: [], rejected: [] };
  for (const c of d.candidates) {
    if (inRange(c.applied)) ev.fresh.push(c.name);
    for (const m of c.moves) {
      if (m.init || !inRange(m.time)) continue;
      const b = bucket(m.toState);
      if (b === "offered") ev.offered.push(c.name);
      else if (b === "hired") ev.hired.push(c.name);
      else if (b === "rejected") ev.rejected.push(`${c.name} (từ vòng ${m.from || "?"})`);
      else ev.moved.push(`${c.name}: ${m.from || "?"} sang ${m.to}`);
    }
  }
  return ev;
}

// Markdown, không dùng bảng (bảng vỡ khi dán vào Outlook / Teams).
function buildWeeklyReport(datas, interviews, { range, staleDays = 7, now, company, source, errors = [], interviewNote } = {}) {
  const last = range.to - DAY;
  const out = [`# Báo cáo tuyển dụng tuần ${fmtDate(range.from)} đến ${fmtDate(last)}`, ""];
  out.push(`Phạm vi: ${datas.length} job đang mở` + (company ? `, công ty khớp "${company}"` : "") + ".");
  if (source === "shared") out.push(`Lưu ý: ${SHARED_NOTE}`);
  out.push("");

  const per = datas.map((d) => ({ d, ev: weekEvents(d, range) }));
  const sum = (k) => per.reduce((a, x) => a + x.ev[k].length, 0);
  const live = datas.reduce((a, d) => a + d.candidates.filter(inProgress).length, 0);
  out.push(
    "## Tổng quan",
    `- Hồ sơ mới: ${sum("fresh")}`,
    `- Chuyển vòng: ${sum("moved")}`,
    `- Offer: ${sum("offered")}`,
    `- Tuyển được: ${sum("hired")}`,
    `- Bị loại: ${sum("rejected")}`,
    `- Hồ sơ đang xử lý tính đến hiện tại: ${live}`,
    ""
  );

  out.push("## Theo job");
  for (const { d, ev } of per) {
    const o = d.opening;
    out.push(`### ${jobLabel(o)}`);
    out.push(`- Trạng thái: ${o.statusLabel}, deadline: ${fmtDate(o.deadline) || "không đặt"}, đang xử lý: ${d.candidates.filter(inProgress).length}`);
    const line = (label, arr) => out.push(`- ${label}: ${arr.length}` + (arr.length ? ` (${arr.join("; ")})` : ""));
    line("Hồ sơ mới", ev.fresh);
    line("Chuyển vòng", ev.moved);
    line("Offer", ev.offered);
    line("Tuyển được", ev.hired);
    line("Bị loại", ev.rejected);
    for (const n of d.notes) out.push(`- Lưu ý: ${n}`);
  }
  out.push("");

  out.push("## Lịch phỏng vấn trong tuần");
  if (interviews.length) out.push(...interviews.map(interviewLine));
  else out.push("- Không có buổi nào Base trả về trong tuần này.");
  if (interviewNote) out.push(`- Lưu ý: ${interviewNote}`);
  out.push("");

  const stale = [];
  for (const d of datas) for (const c of d.candidates) if (isStale(c, now, staleDays)) stale.push({ c, o: d.opening });
  stale.sort((a, b) => a.c.lastUpdate - b.c.lastUpdate);
  out.push(`## Hồ sơ đọng cần xử lý (không cập nhật quá ${staleDays} ngày)`);
  if (stale.length)
    out.push(
      ...stale.map(
        ({ c, o }) =>
          `- ${c.name}, job ${o.name}, vòng ${c.stageName}: ${staleDaysOf(c, now)} ngày, cập nhật cuối ${fmtDate(c.lastUpdate)}`
      )
    );
  else out.push("- Không có.");

  if (errors.length) out.push("", "## Job không đọc được", ...errors.map((e) => `- ${e}`));
  return out.join("\n");
}

async function loadInterviewsSafe() {
  try {
    return { list: await D.fetchInterviews(), note: "" };
  } catch (e) {
    return { list: [], note: `Không đọc được trang lịch phỏng vấn của Base (${e.message}). Chỉ còn lịch gắn trên từng ứng viên.` };
  }
}

async function toolWeeklyReport({ company, week_of, stale_days } = {}) {
  const staleDays = parseStaleDays(stale_days);
  const now = D.nowUnix();
  const range = D.weekRange(week_of ? D.parseDate(week_of) : now);
  const sel = await selectOpenings({ company, status: "open" });
  const { datas, errors } = await loadOpenings(sel.openings);
  const iv = await loadInterviewsSafe();
  const interviews = collectInterviews(iv.list, datas, {
    from: range.from,
    to: range.to,
    openingIds: new Set(sel.openings.map((o) => o.id)),
  });
  return buildWeeklyReport(datas, interviews, {
    range,
    staleDays,
    now,
    company,
    source: sel.source,
    errors,
    interviewNote: iv.note,
  });
}

// ---- 4. hiring_interview_schedule ----

function buildSchedule(interviews, { from, to, source, note, errors = [] } = {}) {
  const out = [`Lịch phỏng vấn từ ${fmtDate(from)} đến ${fmtDate(to - DAY)}: ${interviews.length} buổi`];
  if (source === "shared") out.push(`Lưu ý: ${SHARED_NOTE}`);
  if (note) out.push(`Lưu ý: ${note}`);
  out.push("");
  if (interviews.length) out.push(...interviews.map(interviewLine));
  else out.push("Không có buổi phỏng vấn nào Base trả về trong khoảng này.");
  for (const e of errors) out.push(`Không đọc được: ${e}`);
  return out.join("\n");
}

async function toolInterviewSchedule({ from, to, company, opening } = {}) {
  const start = from ? D.parseDate(from) : D.dayStart(D.nowUnix());
  const end = (to ? D.parseDate(to) : start + 6 * DAY) + DAY; // `to` tính cả ngày đó
  if (end <= start) throw new Error("`to` phải bằng hoặc sau `from`.");
  const filtered = Boolean(company || opening);
  const sel = await selectOpenings({ opening, company, status: filtered ? "all" : "open" });
  const { datas, errors } = await loadOpenings(sel.openings);
  const iv = await loadInterviewsSafe();
  const interviews = collectInterviews(iv.list, datas, {
    from: start,
    to: end,
    // không lọc job/công ty -> giữ mọi buổi trên trang lịch, kể cả của job đã đóng
    openingIds: filtered ? new Set(sel.openings.map((o) => o.id)) : null,
  });
  return buildSchedule(interviews, { from: start, to: end, source: sel.source, note: iv.note, errors });
}

// ---- khai báo tool ----

const COMPANY_DESC = "Lọc theo công ty khách hàng của job, vd 'Caspeco'. Không phân biệt hoa thường, dấu.";

const HIRING_REPORT_TOOLS = [
  {
    name: "hiring_list_openings",
    description:
      "Liệt kê các job tuyển dụng trên Base Hiring (chỉ đọc): tên, mã job, công ty, trạng thái, deadline, tổng ứng viên, số đang xử lý / offer / đã tuyển / bị loại và số ứng viên ở từng vòng. Dùng cho câu hỏi 'đang mở mấy job, mỗi job bao nhiêu ứng viên'.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "public", "internal", "closed", "all"],
          description: "Lọc trạng thái. Mặc định 'open' = mọi job chưa Closed (Public + Internal).",
        },
        company: { type: "string", description: COMPANY_DESC },
      },
      required: [],
    },
    handler: toolListOpenings,
  },
  {
    name: "hiring_pipeline",
    description:
      "Xem pipeline của một job, hoặc gộp mọi job của một công ty (chỉ đọc): ứng viên đang xử lý (không gồm Rejected) nhóm theo vòng, mỗi người có tên, vị trí hiện tại, nguồn, ngày nộp, ngày cập nhật cuối. Đánh dấu hồ sơ ĐỌNG (không cập nhật quá N ngày) và job đã đóng nhưng còn ứng viên chưa chuyển sang Rejected. Không truyền gì = mọi job đang mở. Mặc định không trả email / số điện thoại.",
    inputSchema: {
      type: "object",
      properties: {
        opening: { type: "string", description: "Job cần xem: id, mã job, hoặc một phần tên" },
        company: { type: "string", description: COMPANY_DESC + " Gộp cả job đã đóng còn ứng viên treo." },
        stale_days: { type: "number", description: "Số ngày không cập nhật thì coi là đọng. Mặc định 7." },
        include_contact: {
          type: "boolean",
          description: "true = trả thêm email và số điện thoại. Chỉ bật khi người dùng hỏi thông tin liên hệ.",
        },
      },
      required: [],
    },
    handler: toolPipeline,
  },
  {
    name: "hiring_weekly_report",
    description:
      "Báo cáo tuyển dụng theo tuần (thứ Hai đến Chủ nhật, giờ VN) cho mọi job đang mở hoặc một công ty (chỉ đọc): hồ sơ mới, chuyển vòng, offer, tuyển được, bị loại, lịch phỏng vấn trong tuần, danh sách hồ sơ đọng. Trả markdown không có bảng, dán thẳng vào email hoặc Teams được.",
    inputSchema: {
      type: "object",
      properties: {
        company: { type: "string", description: COMPANY_DESC },
        week_of: {
          type: "string",
          description: "Một ngày bất kỳ trong tuần cần báo cáo, DD/MM/YYYY hoặc YYYY-MM-DD. Mặc định tuần hiện tại.",
        },
        stale_days: { type: "number", description: "Số ngày không cập nhật thì coi là đọng. Mặc định 7." },
      },
      required: [],
    },
    handler: toolWeeklyReport,
  },
  {
    name: "hiring_interview_schedule",
    description:
      "Lịch phỏng vấn trên Base Hiring theo khoảng ngày (chỉ đọc): ứng viên, job, vòng hiện tại của ứng viên, giờ (giờ VN), hình thức, người phỏng vấn, địa điểm. Mặc định 7 ngày tính từ hôm nay. Base chỉ trả các buổi tài khoản này được thấy.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Ngày bắt đầu, DD/MM/YYYY hoặc YYYY-MM-DD. Mặc định hôm nay." },
        to: { type: "string", description: "Ngày kết thúc (tính cả ngày này). Mặc định from + 6 ngày." },
        company: { type: "string", description: COMPANY_DESC },
        opening: { type: "string", description: "Lọc theo job: id, mã job, hoặc một phần tên" },
      },
      required: [],
    },
    handler: toolInterviewSchedule,
  },
];

module.exports = {
  HIRING_REPORT_TOOLS,
  selectOpenings,
  loadOpenings,
  buildOpeningsList,
  buildPipeline,
  buildWeeklyReport,
  buildSchedule,
  collectInterviews,
  weekEvents,
};
