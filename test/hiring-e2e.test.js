// Chạy cả đường đi chính (tài khoản thấy được /openings và /opening/{id}) với `fetch` giả.
// Dữ liệu GIẢ. Không dán dữ liệu thật của Base vào đây: repo public.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "base-vn-test-")), "config.json");
fs.writeFileSync(cfgPath, JSON.stringify({ base_url: "https://booking.base.vn", hiring_url: "https://hiring.base.vn", cookie: "basessid=abc123" }));
process.env.BASE_VN_CONFIG = cfgPath;

const D = require("../hiring-data.js");
const { HIRING_TOOLS } = require("../hiring.js");
const call = (name, args = {}) => HIRING_TOOLS.find((t) => t.name === name).handler(args);

const now = D.nowUnix();
const DAY = 86400;
const stages = [
  { id: "1", name: "Apply", state: "active" },
  { id: "2", name: "Interview", state: "active" },
  { id: "9", name: "Rejected", state: "failed" },
];
const cand = (id, name, stage, sinceDaysAgo, updDaysAgo, extra = {}) => ({
  id, hid: "h" + id, token: "t" + id, name, title: "Dev", source: "Referral", email: id + "@example.com", phone: "0900000000", ssn: "0123",
  stage_id: stage, opening_id: "100", since: String(now - sinceDaysAgo * DAY), last_update: String(now - updDaysAgo * DAY),
  changelogs: [{ since: now - sinceDaysAgo * DAY, action: "init.stage", data: { stage_in: "1", stage_in_name: "Apply", stage_in_state: "active", time: now - sinceDaysAgo * DAY } }],
  interview: {}, stats: { comments: 0 }, files: [], ...extra,
});
const PAGES = {
  "/openings": {
    users: [{ username: "hr", password: "HASH-KHONG-DUOC-LO" }],
    opening_requests: [{ id: "r1" }],
    openings: [
      { id: "100", name: "Backend Developer", codename: "ACME-001", status: "10", status_txt: "Công khai", deadline: "0", group_export: { name: "Acme" },
        stats: { total: 3, stages: [{ ...stages[0], total: "1" }, { ...stages[1], total: "1" }, { ...stages[2], total: "1" }], interviews: { total: "1" } } },
      { id: "200", name: "Old Job", codename: "GLX-001", status: "-1", status_txt: "Đóng", deadline: "0", group_export: { name: "Globex" },
        stats: { total: 1, stages: [{ ...stages[0], total: "0" }, { ...stages[2], total: "1" }], interviews: { total: 0 } } },
    ],
  },
  "/opening/100": {
    // chỉ có id + tên, không có state: tool phải bù state từ stats của job
    stages: stages.map(({ id, name }) => ({ id, name })),
    candidates: [
      cand("11", "Nguyễn Văn Giả", "1", 30, 20),
      cand("12", "Trần Thị Thử", "2", 3, 1, { interview: { id: "500", metatype: "online", time: now + DAY, location: "Teams", candidate_id: "12" } }),
      cand("13", "Lê Văn Loại", "9", 40, 35),
    ],
  },
  "/candidates/shared": { total: "0", total_pages: 1, candidates: [], stages_maps: {}, openings: [] },
  "/interviews": {
    interviews: [{ id: "500", name: "PV", username: "hr", metatype: "online", time: String(now + DAY), est_duration: 45, candidate_id: "12",
      candidate_name: "Trần Thị Thử", candidate_email: "12@example.com", opening_id: "100", opening_name: "Backend Developer", followers: ["interviewer.a"], location: "Teams" }],
  },
};
const requested = [];
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  requested.push(`${opts.method || "GET"} ${u.pathname}`);
  const pd = PAGES[u.pathname];
  const html = pd
    ? `<html><script>Client.pageData={};</script><script>Client.pageData=${JSON.stringify(pd)};</script></html>`
    : "<html>Sorry. You cannot view this opening</html>";
  return { url: String(url), ok: true, status: 200, text: async () => html };
};

test("đường đi chính: 4 tool báo cáo + tìm ứng viên ngoài tab Chia sẻ", async () => {
  const list = await call("hiring_list_openings");
  assert.match(list, /Job tuyển dụng trên Base Hiring: 1/);
  assert.match(list, /Công ty: Acme/);
  assert.doesNotMatch(list, /Old Job|HASH/);
  assert.match(await call("hiring_list_openings", { status: "closed" }), /Old Job/);
  await assert.rejects(call("hiring_list_openings", { company: "khong-co" }), /Các công ty đang có job: Acme, Globex/);

  const pipe = await call("hiring_pipeline", { company: "acme" });
  assert.match(pipe, /Nguyễn Văn Giả \(id 11\) \[ĐỌNG 20 ngày\]/);
  assert.match(pipe, /### Interview \(1\)/);
  assert.doesNotMatch(pipe, /Lê Văn Loại|example\.com|0900000000/);

  const weekly = await call("hiring_weekly_report");
  assert.match(weekly, /Phạm vi: 1 job đang mở/);
  assert.match(weekly, /- Backend Developer: 1 hồ sơ đọng\n  - Nguyễn Văn Giả, vòng Apply: 20 ngày/);
  // loại job khỏi báo cáo
  const none = await call("hiring_weekly_report", { exclude_openings: ["backend"] });
  assert.match(none, /Phạm vi: 0 job đang mở/);
  assert.match(none, /Đã loại khỏi báo cáo: Backend Developer\./);
  // lịch phỏng vấn: khoảng ngày không có buổi nào thì vẫn nói rõ Base trả gì
  const empty = await call("hiring_interview_schedule", { from: "2020-01-01", to: "2020-01-07" });
  assert.match(empty, /0 buổi/);
  assert.match(empty, /trang Lịch phỏng vấn của Base trả 1 buổi/);

  const sched = await call("hiring_interview_schedule");
  assert.match(sched, /1 buổi/);
  assert.match(sched, /Trần Thị Thử, job Backend Developer, vòng hiện tại: Interview, người phỏng vấn: interviewer\.a/);
  assert.doesNotMatch(sched, /example\.com/);

  const got = await call("hiring_get_candidate", { candidate: "tran thi thu" });
  assert.match(got, /Trần Thị Thử — id 12/);
  assert.match(got, /Liên hệ: ẩn/);
  assert.match(await call("hiring_get_candidate", { candidate: "12", include_contact: true }), /Email: 12@example\.com/);
  await assert.rejects(call("hiring_get_candidate", { candidate: "999" }), /Không tìm thấy ứng viên/);

  // chỉ đọc: mọi request đều là GET
  assert.ok(requested.length > 0 && requested.every((r) => r.startsWith("GET ")), requested.join(", "));
});
