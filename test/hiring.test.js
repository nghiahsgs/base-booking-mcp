// Chạy: node --test
// Mọi dữ liệu ở đây là GIẢ (tên, công ty, id). Không dán dữ liệu thật của Base vào file này: repo public.

const test = require("node:test");
const assert = require("node:assert");
const zlib = require("node:zlib");
const D = require("../hiring-data.js");
const R = require("../hiring-reports.js");
const { docxText } = require("../cv-text.js");

const NOW = D.parseDate("25/11/2026") + 15 * 3600; // thứ Tư 25/11/2026 15:00 giờ VN
const at = (date, hour = 9) => D.parseDate(date) + hour * 3600;

const STAGES = [
  { id: "1", name: "Apply", state: "active" },
  { id: "2", name: "Technical Interview", state: "active" },
  { id: "3", name: "Offered", state: "offered" },
  { id: "4", name: "Hired", state: "hired" },
  { id: "5", name: "Rejected", state: "failed" },
];

// Dạng job như trang /openings trả về (theo mô tả: `stats`, `group_export.name`), kèm trường thừa nhạy cảm.
function rawOpening(over = {}) {
  return {
    id: "100",
    name: "Backend Developer",
    codename: "ACME-001",
    status: "10",
    status_txt: "Công khai",
    deadline: String(at("31/12/2026")),
    group_export: { name: "Acme" },
    owners: [{ username: "hr", password: "HASH-KHONG-DUOC-LO" }],
    stats: {
      total: 6,
      stages: STAGES.map((s, i) => ({ ...s, total: String([2, 1, 1, 1, 1][i]) })),
      interviews: { total: "3" },
    },
    ...over,
  };
}

function move(time, from, to) {
  const data = { stage_in: to.id, stage_in_name: to.name, stage_in_state: to.state, time };
  if (from) Object.assign(data, { stage_out: from.id, stage_out_name: from.name, stage_out_state: from.state });
  return { since: time, action: from ? "change.stage" : "init.stage", data };
}

function rawCandidate(id, name, stage, since, lastUpdate, extra = {}) {
  return {
    id,
    name,
    title: "Dev tại Globex",
    source: "LinkedIn",
    email: `${id}@example.com`,
    phone: "0900000000",
    ssn: "012345678901",
    token: "SECRET-TOKEN",
    stage_id: stage.id,
    opening_id: "100",
    since: String(since),
    last_update: String(lastUpdate),
    changelogs: [move(since, null, STAGES[0])],
    interview: {},
    stats: { comments: 0 },
    files: [],
    ...extra,
  };
}

function openingData(openingOver = {}, candidates) {
  const opening = D.normalizeOpening(rawOpening(openingOver));
  const stages = D.normalizeStages(STAGES);
  const raw = candidates || [
    // mới trong tuần, còn ở vòng đầu
    rawCandidate("1", "Ứng Viên Mới", STAGES[0], at("24/11/2026"), at("24/11/2026")),
    // nộp từ tháng 10, đọng ở vòng đầu
    rawCandidate("2", "Ứng Viên Đọng", STAGES[0], at("20/10/2026"), at("01/11/2026")),
    // chuyển vòng trong tuần, có lịch phỏng vấn thứ Năm
    rawCandidate("3", "Ứng Viên Chuyển Vòng", STAGES[1], at("10/11/2026"), at("23/11/2026"), {
      changelogs: [move(at("10/11/2026"), null, STAGES[0]), move(at("23/11/2026"), STAGES[0], STAGES[1])],
      interview: { id: "900", metatype: "online", time: at("26/11/2026", 14), location: "Teams", link: "x", candidate_id: "3" },
    }),
    rawCandidate("4", "Ứng Viên Offer", STAGES[2], at("01/11/2026"), at("24/11/2026"), {
      changelogs: [move(at("01/11/2026"), null, STAGES[0]), move(at("24/11/2026"), STAGES[1], STAGES[2])],
    }),
    rawCandidate("5", "Ứng Viên Trúng Tuyển", STAGES[3], at("01/10/2026"), at("25/11/2026", 8), {
      changelogs: [move(at("01/10/2026"), null, STAGES[0]), move(at("25/11/2026", 8), STAGES[2], STAGES[3])],
    }),
    rawCandidate("6", "Ứng Viên Bị Loại", STAGES[4], at("05/11/2026"), at("23/11/2026"), {
      changelogs: [move(at("05/11/2026"), null, STAGES[0]), move(at("23/11/2026"), STAGES[0], STAGES[4])],
    }),
  ];
  return {
    opening,
    stages,
    raw,
    candidates: raw.map((c) => D.normalizeCandidate(c, stages, opening)),
    notes: [],
    partial: false,
  };
}

test("pickPageData bỏ qua khối pageData rỗng đứng đầu trang", () => {
  const html =
    `<script>Client.pageData={};</script>` +
    `<script>Client.pageData={"title":"a \\"}\\" b","openings":[{"id":"1","name":"x{"}]};</script>`;
  assert.deepStrictEqual(D.pickPageData(html, "openings").openings, [{ id: "1", name: "x{" }]);
  assert.strictEqual(D.pickPageData(html, "candidates"), null);
});

test("normalizeOpening: nhãn trạng thái, công ty, đếm theo state của vòng", () => {
  const o = D.normalizeOpening(rawOpening());
  assert.strictEqual(o.statusLabel, "Public");
  assert.strictEqual(o.company, "Acme");
  assert.deepStrictEqual(
    { total: o.stats.total, active: o.stats.active, offered: o.stats.offered, hired: o.stats.hired, rejected: o.stats.rejected, iv: o.stats.interviews },
    { total: 6, active: 3, offered: 1, hired: 1, rejected: 1, iv: 3 }
  );
  assert.strictEqual(D.normalizeOpening(rawOpening({ status: "7" })).statusLabel, "Internal");
  assert.ok(D.normalizeOpening(rawOpening({ status: "-1" })).closed);
});

test("normalizeOpening đọc được `xstats` (tab Chia sẻ) và báo null khi không có stats", () => {
  const { stats, ...rest } = rawOpening();
  assert.strictEqual(D.normalizeOpening({ ...rest, xstats: stats }).stats.total, 6);
  assert.strictEqual(D.normalizeOpening(rest).stats, null);
});

test("filterByStatus + matchCompany", () => {
  const list = [rawOpening(), rawOpening({ id: "101", status: "7" }), rawOpening({ id: "102", status: "-1" })].map(D.normalizeOpening);
  assert.deepStrictEqual(D.filterByStatus(list).map((o) => o.id), ["100", "101"]);
  assert.deepStrictEqual(D.filterByStatus(list, "closed").map((o) => o.id), ["102"]);
  assert.strictEqual(D.filterByStatus(list, "all").length, 3);
  assert.throws(() => D.filterByStatus(list, "xyz"));
  assert.ok(D.matchCompany(list[0], "acme"));
  assert.ok(!D.matchCompany(list[0], "globex"));
});

test("weekRange: thứ Hai 00:00 đến hết Chủ nhật, giờ VN", () => {
  const r = D.weekRange(NOW);
  assert.strictEqual(D.fmtTime(r.from), "23/11/2026 00:00");
  assert.strictEqual(D.fmtTime(r.to), "30/11/2026 00:00");
  assert.strictEqual(D.fmtTime(D.weekRange(D.parseDate("2026-11-29") + 23 * 3600).from), "23/11/2026 00:00");
});

test("hiring_list_openings: đủ số liệu, không lộ trường thừa", () => {
  const text = R.buildOpeningsList({ source: "openings", openings: [D.normalizeOpening(rawOpening())], requests: 2 });
  assert.match(text, /Backend Developer/);
  assert.match(text, /Mã: ACME-001 · id 100 · Công ty: Acme/);
  assert.match(text, /tổng 6 · đang xử lý 3 · offer 1 · đã tuyển 1 · bị loại 1/);
  assert.match(text, /Apply 2 \| Technical Interview 1/);
  assert.match(text, /Yêu cầu tuyển dụng chưa thành job: 2/);
  assert.doesNotMatch(text, /HASH|password/);
});

test("hiring_pipeline: nhóm theo vòng, bỏ Rejected, đánh dấu đọng, ẩn liên hệ", () => {
  const text = R.buildPipeline([openingData()], { staleDays: 7, now: NOW, source: "openings" });
  assert.match(text, /### Apply \(2\)/);
  assert.match(text, /### Technical Interview \(1\)/);
  assert.match(text, /### Offered \(1\)/);
  assert.match(text, /Ứng Viên Đọng \(id 2\) \[ĐỌNG 24 ngày\]/);
  assert.doesNotMatch(text, /Ứng Viên Mới \(id 1\) \[ĐỌNG/);
  assert.doesNotMatch(text, /Ứng Viên Bị Loại|Ứng Viên Trúng Tuyển/);
  assert.match(text, /Hồ sơ đọng \(không cập nhật quá 7 ngày\): 1/);
  assert.doesNotMatch(text, /example\.com|0900000000|012345678901|SECRET-TOKEN/);
  const withContact = R.buildPipeline([openingData()], { staleDays: 7, now: NOW, includeContact: true });
  assert.match(withContact, /Liên hệ: 1@example\.com, 0900000000/);
  assert.doesNotMatch(withContact, /012345678901|SECRET-TOKEN/);
});

test("vòng không có state: lấy state từ lần chuyển vòng gần nhất", () => {
  const nameOnly = D.normalizeStages(STAGES.map(({ id, name }) => ({ id, name })));
  const o = D.normalizeOpening(rawOpening());
  const rejected = rawCandidate("6", "Ứng Viên Bị Loại", STAGES[4], at("05/11/2026"), at("23/11/2026"), {
    changelogs: [move(at("05/11/2026"), null, STAGES[0]), move(at("23/11/2026"), STAGES[0], STAGES[4])],
  });
  const c = D.normalizeCandidate(rejected, nameOnly, o);
  assert.strictEqual(c.stageName, "Rejected");
  assert.strictEqual(D.bucket(c.state), "rejected");
  // không có cả changelog -> state rỗng, bên gọi phải ghi chú
  assert.strictEqual(D.normalizeCandidate({ ...rejected, changelogs: [] }, nameOnly, o).state, "");
});

test("hiring_pipeline: cảnh báo job đã đóng còn ứng viên treo", () => {
  const text = R.buildPipeline([openingData({ status: "-1" })], { now: NOW });
  assert.match(text, /CẢNH BÁO: job đã đóng nhưng còn 4 ứng viên chưa chuyển sang Rejected/);
});

test("hiring_weekly_report: đếm đúng sự kiện trong tuần, markdown không có bảng", () => {
  const d = openingData();
  const range = D.weekRange(NOW);
  const pageInterviews = [
    D.normalizeInterview({
      id: "900", name: "PV kỹ thuật", username: "hr", metatype: "online", time: String(at("26/11/2026", 14)), est_duration: 60,
      candidate_id: "3", candidate_name: "Ứng Viên Chuyển Vòng", candidate_email: "3@example.com", candidate_phone: "0900000000",
      opening_id: "100", opening_name: "Backend Developer", followers: ["interviewer.a"], location: "Teams",
    }),
    D.normalizeInterview({ id: "901", time: String(at("05/12/2026")), candidate_id: "1", opening_id: "100", followers: [] }),
  ];
  const interviews = R.collectInterviews(pageInterviews, [d], { ...range, openingIds: new Set(["100"]) });
  assert.strictEqual(interviews.length, 1);
  const text = R.buildWeeklyReport([d], interviews, { range, staleDays: 7, now: NOW, source: "openings" });
  assert.match(text, /^# Báo cáo tuyển dụng tuần 23\/11\/2026 đến 29\/11\/2026/);
  assert.match(text, /- Hồ sơ mới: 1\n- Chuyển vòng: 1\n- Offer: 1\n- Tuyển được: 1\n- Bị loại: 1/);
  assert.match(text, /Chuyển vòng: 1 \(Ứng Viên Chuyển Vòng: Apply sang Technical Interview\)/);
  assert.match(text, /T5 26\/11\/2026 14:00 \(online, 60 phút\): Ứng Viên Chuyển Vòng, job Backend Developer, vòng hiện tại: Technical Interview, người phỏng vấn: interviewer\.a, địa điểm: Teams/);
  assert.match(text, /- Backend Developer: 1 hồ sơ đọng\n  - Ứng Viên Đọng, vòng Apply: 24 ngày/);
  assert.doesNotMatch(text, /^\|/m); // không có bảng markdown
  assert.doesNotMatch(text, /example\.com|0900000000|SECRET-TOKEN/);
});

test("báo cáo tuần: một người nộp 2 job chỉ tính 1 người, tên viết một kiểu", () => {
  const a = openingData({}, [rawCandidate("1", "Nguyen Van Gia", STAGES[0], at("24/11/2026"), at("24/11/2026"), { email: "gia@example.com" })]);
  const b = openingData({ id: "101", name: "Frontend Developer", codename: "ACME-002" }, [
    rawCandidate("9", "Nguyễn Văn Giả", STAGES[0], at("25/11/2026"), at("25/11/2026"), { email: "GIA@example.com", opening_id: "101" }),
  ]);
  const text = R.buildWeeklyReport([a, b], [], { range: D.weekRange(NOW), now: NOW });
  assert.match(text, /- Hồ sơ mới: 2 hồ sơ của 1 người \(1 hồ sơ là của người đã nộp job khác trong tuần\)/);
  assert.strictEqual((text.match(/Hồ sơ mới: 1 \(Nguyễn Văn Giả\)/g) || []).length, 2);
  assert.doesNotMatch(text, /Nguyen Van Gia|example\.com/);
  // trùng tên nhưng email khác nhau -> hai người khác nhau
  const c = openingData({ id: "102", name: "QA" }, [
    rawCandidate("7", "Nguyễn Văn Giả", STAGES[0], at("25/11/2026"), at("25/11/2026"), { email: "khac@example.com", opening_id: "102" }),
  ]);
  assert.match(R.buildWeeklyReport([a, c], [], { range: D.weekRange(NOW), now: NOW }), /- Hồ sơ mới: 2\n/);
});

test("báo cáo tuần: hồ sơ đọng gom theo job, quá giới hạn thì gom 1 dòng tổng", () => {
  const many = Array.from({ length: 8 }, (_, i) =>
    rawCandidate(String(50 + i), `Hồ Sơ Kho ${i}`, STAGES[0], at("01/09/2026"), at("01/09/2026") + i * 86400)
  );
  const d = openingData({ name: "Kho hồ sơ chung", codename: "POOL" }, many);
  const text = R.buildWeeklyReport([d], [], { range: D.weekRange(NOW), now: NOW, stalePerJob: 3 });
  assert.match(text, /- Kho hồ sơ chung: 8 hồ sơ đọng/);
  assert.strictEqual((text.match(/^  - Hồ Sơ Kho/gm) || []).length, 3);
  assert.match(text, /Hồ Sơ Kho 0, vòng Apply/); // đọng lâu nhất đứng đầu
  assert.match(text, /Còn 5 hồ sơ khác\. Xem đủ bằng hiring_pipeline với opening="POOL"/);
  const all = R.buildWeeklyReport([d], [], { range: D.weekRange(NOW), now: NOW, stalePerJob: 0 });
  assert.strictEqual((all.match(/^  - Hồ Sơ Kho/gm) || []).length, 8);
});

test("interviewCoverage: nói rõ Base trả bao nhiêu buổi và trong khoảng nào", () => {
  const page = [D.normalizeInterview({ id: "1", time: String(at("13/10/2026")) }), D.normalizeInterview({ id: "2", time: String(at("28/08/2026")) })];
  const note = R.interviewCoverage(page, [openingData()]);
  assert.match(note, /trả 2 buổi mà tài khoản này thấy được, từ 28\/08\/2026 đến 13\/10\/2026/);
  assert.match(note, /1 ứng viên trong các job đang xét có gắn lịch phỏng vấn/);
});

test("collectInterviews: lấy lịch gắn trên ứng viên khi trang /interviews không có", () => {
  const list = R.collectInterviews([], [openingData()], D.weekRange(NOW));
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].candidate, "Ứng Viên Chuyển Vòng");
  assert.match(R.buildSchedule(list, { ...D.weekRange(NOW) }), /người phỏng vấn: Base không trả/);
});

test("docxText đọc được word/document.xml trong file zip", () => {
  const name = Buffer.from("word/document.xml");
  const xml = Buffer.from("<w:document><w:p><w:t>Xin chào</w:t></w:p><w:p><w:t>A &amp; B</w:t></w:p></w:document>");
  const data = zlib.deflateRawSync(xml);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(xml.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(xml.length, 24);
  central.writeUInt16LE(name.length, 28);
  const cdOffset = local.length + name.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  const zip = Buffer.concat([local, name, data, central, name, eocd]);
  assert.strictEqual(docxText(zip).trim(), "Xin chào\nA & B");
});
