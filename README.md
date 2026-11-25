# base-vn-mcp

MCP server nói chuyện với Base (base.vn), đăng ký global (user scope) cho Claude Code và OpenCode. Ba mảng:

- **Booking** — đặt phòng họp trên https://booking.base.vn (Base Wework).
- **Hiring** — đọc job, pipeline, báo cáo tuần, lịch phỏng vấn, ứng viên / CV / bình luận trên https://hiring.base.vn (chỉ đọc, không ghi).
- **Timeoff** — đọc quỹ phép và đề xuất nghỉ trên https://timeoff.base.vn (chỉ đọc, không ghi).

Dùng chung 1 cookie: Base set cookie ở domain `.base.vn` nên `basessid` dùng được cho cả 2 app.

## Tools — booking

- `list_rooms` — liệt kê phòng + sức chứa (chỉ phòng account có quyền book)
- `check_room_schedule` — lịch 1 phòng trong 1 ngày
- `book_room` — đặt phòng (tự check trùng giờ trước, Base cho phép booking chồng nhau nên phải check; `force=true` để book đè)
- `cancel_booking` — huỷ booking theo id

## Tools — hiring (chỉ đọc)

Báo cáo tuyển dụng:

- `hiring_list_openings` — danh sách job: tên, mã job, công ty, trạng thái, deadline, tổng ứng viên, số đang xử lý / offer / đã tuyển / bị loại, số ứng viên ở từng vòng. Lọc `status` (`open` mặc định = mọi job chưa Closed, `public`, `internal`, `closed`, `all`) và `company`.
- `hiring_pipeline` — pipeline của một job (`opening`: id, mã job, hoặc một phần tên) hoặc gộp mọi job của một công ty (`company`). Liệt kê ứng viên đang xử lý (không gồm Rejected) nhóm theo vòng, mỗi người có tên, vị trí hiện tại, nguồn, ngày nộp, ngày cập nhật cuối. Đánh dấu hồ sơ **đọng** (không cập nhật quá `stale_days`, mặc định 7) và job đã đóng nhưng còn ứng viên chưa chuyển sang Rejected.
- `hiring_weekly_report` — báo cáo tuần (thứ Hai đến Chủ nhật, giờ VN) cho mọi job đang mở hoặc một `company`: hồ sơ mới, chuyển vòng, offer, tuyển được, bị loại, lịch phỏng vấn trong tuần, hồ sơ đọng. Trả markdown không có bảng để dán thẳng vào email hoặc Teams. `week_of` chọn tuần khác. Một người nộp nhiều job trong tuần được đếm là nhiều hồ sơ nhưng một người, và tên hiển thị thống nhất một cách viết (ưu tiên bản có dấu). Hồ sơ đọng gom theo job: mỗi job liệt kê `stale_per_job` hồ sơ đọng lâu nhất (mặc định 5, 0 = hết), phần còn lại gom một dòng tổng.
- `hiring_interview_schedule` — lịch phỏng vấn theo khoảng ngày (`from`, `to`, mặc định 7 ngày từ hôm nay): ứng viên, job, vòng hiện tại, giờ, hình thức, người phỏng vấn, địa điểm.

Ứng viên:

- `hiring_list_candidates` — danh sách ứng viên được chia sẻ với tài khoản này (tab CHIA SẺ, đọc đủ mọi trang): tên, id, tin tuyển dụng, vòng hiện tại, nguồn, số file, số bình luận. Lọc theo `opening` / `stage` / `query`.
- `hiring_get_candidate` — hồ sơ 1 ứng viên: vòng, nguồn, file đính kèm (kèm index), lịch sử chuyển vòng.
- `hiring_read_cv` — tải file đính kèm rồi tách text (PDF, DOCX). Mặc định lấy PDF đầu tiên, chọn file khác bằng `file_index`. `save_file=true` lưu file ra thư mục tạm và trả đường dẫn để Claude đọc trực tiếp (dùng cho PDF scan hoặc máy không tách được text).
- `hiring_get_comments` — bình luận nội bộ về ứng viên (ai viết, lúc nào, nội dung).

Loại job khỏi báo cáo (ví dụ job kho hồ sơ chung): truyền `exclude_openings` (mảng id, mã job, hoặc một phần tên) cho `hiring_weekly_report` / `hiring_pipeline`. Muốn loại cố định, thêm vào `config.json`:

```json
"hiring_report_exclude": ["Career at Scandinavian Software Park"]
```

Gọi đích danh một job bằng `opening` thì job đó không bị loại.

Tham số `candidate` nhận id (vd `123456`) hoặc tên (không cần dấu, vd `nguyen van a`). Ba tool `hiring_get_candidate`, `hiring_read_cv`, `hiring_get_comments` tìm ứng viên ở mọi job tài khoản xem được: tab Chia sẻ trước, rồi các job đang mở, rồi các job đã đóng. Thêm `opening` để giới hạn một job.

Ví dụ câu hỏi: "Đang có mấy job mở, mỗi job bao nhiêu ứng viên?", "Pipeline của công ty X thế nào, hồ sơ nào bị đọng?", "Tuần này có những buổi phỏng vấn nào?", "Làm báo cáo tuyển dụng tuần này để gửi sếp."

⚠️ **Thông tin liên hệ ẩn theo mặc định.** Email và số điện thoại của ứng viên chỉ trả về khi gọi với `include_contact=true` (`hiring_list_candidates`, `hiring_get_candidate`, `hiring_pipeline`). CCCD, token và các trường khác của Base không bao giờ trả về. Thay đổi so với bản 1.0: trước đây `hiring_list_candidates` và `hiring_get_candidate` luôn in email và số điện thoại.

⚠️ **`hiring_read_cv` trả nguyên văn nội dung CV**, mà CV thường có sẵn email, số điện thoại, địa chỉ của ứng viên. `include_contact` chỉ điều khiển các trường liên hệ của Base, không che nội dung file.

⚠️ **Số "phỏng vấn" trong `hiring_list_openings` là tổng từ trước đến nay của job** (`stats.interviews.total`), không phải số buổi của một tuần. `hiring_interview_schedule` chỉ liệt kê các buổi rơi vào khoảng ngày được hỏi, và luôn ghi kèm Base đã trả bao nhiêu buổi, từ ngày nào đến ngày nào, để biết tool đã đọc được lịch thật.

⚠️ **Phạm vi phụ thuộc quyền của tài khoản.** Tài khoản HR hoặc người phụ trách job thấy được trang Job (`/openings`, `/opening/{id}`) thì các tool đọc toàn bộ. Tài khoản chỉ được share ứng viên (trang Job rỗng) thì các tool tự lùi về tab Chia sẻ: vẫn có danh sách job và số đếm theo vòng của cả job, nhưng pipeline, báo cáo tuần và lịch phỏng vấn chỉ tính trên các ứng viên được chia sẻ. Kết quả luôn ghi rõ khi đang ở chế độ này.

⚠️ **Đánh giá (evaluation) chưa đọc được:** `api/evaluation/get` trả `code:0 message:998`. **998 = `INVALID_DATA`** trong bảng `AP.error.code` của Base (997 CONFLICT_DATA, 999 INCOMPLETE_DATA, 1001 INVALID_USER, 1002 INVALID_AUTHENTICATION), tức là **sai tham số phía mình, không phải thiếu quyền** — đừng lặp lại kết luận sai này. Đã thử 9 tên tham số (candidate_id, hid, contact_id, application_id…), urlencoded + multipart + GET, đều 998; GET thì trả `BAD_XCODE` nên `__code` chỉ nhận qua POST. Endpoint có thật (không 404). Chưa làm tool cho phần này.

⚠️ **Không ghi gì lên Base Hiring** (không post comment, không đổi vòng). Cố ý.

## Tools — timeoff (chỉ đọc)

- `timeoff_get_my_balance` — số ngày phép/nghỉ bù còn lại và các nhóm đề xuất có thể dùng.
- `timeoff_list_my_requests` — danh sách đề xuất nghỉ của tài khoản hiện tại; lọc theo trạng thái hoặc từ khóa.
- `timeoff_get_request` — chi tiết một đề xuất: ca nghỉ, trạng thái, người duyệt, lịch sử và số phép khả dụng.

⚠️ **Không tạo, duyệt, từ chối, sửa, xóa hoặc hủy đề xuất Timeoff.** Các thao tác này ảnh hưởng công và lương nên MCP chỉ đọc.

## Khi cookie hết hạn

Tool sẽ báo lỗi "Cookie Base có vẻ đã hết hạn". Cách thay:

1. Mở https://booking.base.vn/home trong Chrome (đang đăng nhập).
2. DevTools > Network > chọn request bất kỳ tới booking.base.vn > Request Headers > copy toàn bộ giá trị header `cookie`.
3. Chạy `node set-cookie.js`. Script tự đọc cookie từ clipboard (macOS `pbpaste`, Windows PowerShell `Get-Clipboard`, Linux `wl-paste` / `xclip` / `xsel`), gọi thử Base, cookie sống thì mới ghi vào `config.json`. Không đọc được clipboard thì dán qua stdin, vd `xclip -o -selection clipboard | node set-cookie.js -`.
4. Restart Claude Code (hoặc `/mcp` > reconnect).

Script không in cookie ra màn hình. Muốn làm tay thì dán cookie vào trường `"cookie"` trong `config.json`.

CSRF token (`__code`, `__otp`) không cần cập nhật — server tự fetch fresh từ HTML mỗi lần gọi.

Bên hiring lỗi hiện rõ hơn: cookie chết thì hiring.base.vn redirect sang `account.base.vn/a/login`, tool báo đúng câu đó (khác booking — booking tự redirect về chính nó nên khó bắt).

## Kỹ thuật (reverse-engineered 07/08/2026)

- Danh sách phòng: JSON `"resources":[...]` embed trong HTML của `/home`. `acl.book === 1` = được phép đặt.
- Lịch phòng theo tuần: `GET /<room-path>?ts=<unix seconds>` — trả về HTML embed `"bookings":[...]` của tuần chứa `ts`.
- CSRF: `"code":"<32 hex>"` và `"otp":"<32 hex>"` nằm trong HTML mọi trang; `__sessionid` = cookie `basessid`.
- Tạo booking: POST multipart `/ajax/api/booking/create` với `name`, `start-date`/`end-date` (DD/MM/YYYY), `start-time`/`end-time` (HH:MM), `resource_id`, `purpose_id=0`, `__code`, `__otp`, `__sessionid`, `__via=__frame`.
- Huỷ: POST urlencoded `/ajax/api/booking/remove` với `id` + bộ CSRF như trên.
- Verify sau khi book/huỷ: fetch lại lịch phòng, đối chiếu tên/id — không tin response thô.
- ⚠️ **Không tự huỷ được booking đã duyệt:** có phòng duyệt tự động, xong thì người đặt mất quyền xoá/sửa (`acl: {own:1, edit:0, remove:0}`, API remove trả `message: 1002`). Muốn huỷ phải nhờ admin phòng (owners của phòng hoặc IT support). → **Book cẩn thận ngay từ đầu**, đặt nhầm là phải đi nhờ người xoá.
- Giờ tính theo Asia/Ho_Chi_Minh (+07, không DST).

## Kỹ thuật — hiring (reverse-engineered 16/09/2026)

Code chia 4 file: `hiring-data.js` (gọi trang, đọc `Client.pageData`, chuẩn hoá dữ liệu, cache), `hiring-reports.js` (4 tool báo cáo), `hiring.js` (4 tool ứng viên), `cv-text.js` (tách text CV). `server.js` chỉ nối `...HIRING_TOOLS` vào mảng `TOOLS`.

- Nguồn dữ liệu chính: `GET /candidates/shared` — HTML nhúng `Client.pageData={...}` chứa `candidates[]` (66 field/ứng viên: liên hệ, `opening_export`, `stage_id`, `uploaded_files`, `changelogs`, `stats`), `stages_maps` (map `opening_id` -> danh sách vòng, để dịch `stage_id` -> tên vòng, vd "Rejected"), `total`.
- Parse: quét ngoặc cân bằng từ `Client.pageData=`. Có 2 lần gán trong trang, lần đầu là `{}` — lấy lần nào parse ra có `candidates`.
- Trang này nặng ~280KB và mọi tool đều cần -> cache 60s trong process + gộp request song song. Không cache thì gọi 4 tool cùng lúc là Base rớt kết nối (`fetch failed`). `getHiring` cũng retry 3 lần.
- CV: `uploaded_files[].full_url` (data-gcdn.basecdn.net) tải được bằng chính cookie đó. Cookie chỉ được gửi tới host `*.base.vn` và `*.basecdn.net`. Tách text (`cv-text.js`): PDF thử `pdftotext -layout` trước (thử `/opt/homebrew/bin`, `/usr/local/bin`, rồi PATH — MCP process không chắc có homebrew trong PATH), không có thì dùng thư viện JS `pdf-parse` (tuỳ chọn, cài bằng `npm install`, chạy được trên Windows). DOCX tự đọc zip bằng `zlib` của Node, không cần cài gì. DOC / RTF chỉ tách được trên macOS (`textutil`). Không tách được thì tool hướng dẫn gọi lại với `save_file=true`.
- Bình luận: POST urlencoded `/ajax/api/comment/load` với `hid` + `token` của ứng viên (có sẵn trong candidate object) + bộ CSRF `__code`/`__otp`/`__sessionid`. Trả `{code:1, origin:<candidate>, comments:[...]}`. Content là HTML -> phải decode entity (`&gt;`, `&#9794` không có dấu `;`) và strip tag.
- `stats.comments` trên candidate có thể lớn hơn số comment API trả (vd counter 2, đọc được 1). Không phải phân trang — thử `method=older/all` đều trả `code:0`, comment không có reply. Nhiều khả năng counter tính cả comment đã xoá. Tool nói rõ chỗ chênh thay vì giấu.
- Cookie chết: `GET` bất kỳ trên hiring.base.vn redirect (`res.url`) sang `account.base.vn/a/login?app=hiring&return=...`, trang có `<title>Đăng nhập - Base Account</title>`.
- Trang Job (thêm 25/11/2026): `GET /openings` có `pageData.openings[]` (`id`, `name`, `codename`, `status`: 10 Public, 7 Internal, -1 Closed, `deadline`, `group_export.name` = công ty, `stats`) và `opening_requests[]`. `GET /opening/{id}` có `pageData.candidates[]` và `pageData.stages[]`. `GET /interviews` có `pageData.interviews[]` (giờ, hình thức, `followers` = người phỏng vấn, `opening_id`, `candidate_id`), gồm cả buổi đã qua, phân trang bằng `?page=N` và không báo tổng số trang (đọc tới khi trang mới không thêm buổi nào). `/interviews/upcoming` chỉ trả buổi sắp tới.
- Khối `Client.pageData` đầu tiên của các trang này là `{}`. Phải chọn khối có đúng mảng cần đọc (`pickPageData(html, "openings")`), không lấy khối đầu.
- Tab Chia sẻ phân trang 20 người / trang, đọc tiếp bằng `?page=N` (`total_pages` trong pageData). `?p=`, `?per_page=` không có tác dụng.
- Phân loại ứng viên theo `state` của vòng (`active`, `offered`, `hired`, `failed`), không theo tên vòng vì mỗi job đặt tên một kiểu. Số đếm theo vòng nằm ở `stats` (trang Job) hoặc `xstats` (tab Chia sẻ), cùng một dạng: `{total, stages:[{id,name,total,state}], interviews:{total}}`.
- Sự kiện trong tuần lấy từ `changelogs[]` của ứng viên: bản ghi có `data.stage_in` là một lần vào vòng, có thêm `data.stage_out` là chuyển vòng, `data.stage_in_state` cho biết offer / hired / failed.
- ⚠️ **Phần đã kiểm chứng và phần chưa.** Tài khoản dùng để viết các tool này không có quyền xem trang Job (`/openings` rỗng, `/opening/{id}` báo "You cannot view this opening"). Đường lùi về tab Chia sẻ và `/interviews` đã chạy với dữ liệu thật. Đường đi chính (`/openings`, `/opening/{id}`) viết theo mô tả của người dùng có quyền HR, test bằng dữ liệu giả (`node --test`), và đã được một tài khoản HR chạy thật trên Windows ngày 25/11/2026 (số liệu khớp với Base). Chưa rõ `/opening/{id}` có phân trang hay không: tool đọc tiếp `?page=N` nếu Base báo `total_pages`, và ghi chú khi số ứng viên đọc được ít hơn `stats.total`.
- Mọi request tới Base trong các tool hiring xếp hàng chạy lần lượt (cách nhau 200ms), vì Base rớt kết nối khi bị gọi song song và báo cáo tuần phải đọc mỗi job một trang.
- Bảo mật: pageData của Base chứa nhiều thứ thừa (tài khoản người dùng kèm hash password, email / phone / CCCD / token của ứng viên). Mọi dữ liệu ra khỏi tool đều đi qua các hàm `normalize*` trong `hiring-data.js`, chỉ lấy đúng trường cần dùng. Thêm trường mới thì thêm ở đó, không trả object gốc.
- Endpoint khác đã thử và bỏ: `api/evaluation/get` (code 0 / 998 = INVALID_DATA, chưa tìm ra tham số đúng), `/candidates`, `/candidates/search`, `/opening/<id>/candidates` (đều trả 0 ứng viên với account này).

## Kỹ thuật — timeoff (reverse-engineered 12/10/2026)

- Trang `/` nhúng `var Client={...}` chứa `viewer`, `groups`, `ptos`, `timeoff_types`, `timesheet`; `Client.pageData={...}` chứa `timeoffs` của tài khoản hiện tại.
- Trạng thái: `0` chờ duyệt, `10` đã phê duyệt, `-10` bị từ chối, `-20` đã hủy.
- Chi tiết đề xuất: POST `/ajax/timeoffs/show` với `id` và bộ CSRF `__code` / `__otp` / `__sessionid`.
- Quỹ phép nằm trong `Client.ptos[]`; `to_type_code=annual` là phép năm, `compensatory` là nghỉ bù.
- Cố ý không nối các endpoint ghi như create/approve/reject/remove/cancel.

## Cài đặt

Cần Node 18+ (dùng `fetch` có sẵn). Server chạy được ngay, không bắt buộc cài gì thêm. Để `hiring_read_cv` đọc được PDF: chạy `npm install` (cài `pdf-parse`, dùng được trên Windows, Linux, macOS) hoặc cài poppler (macOS: `brew install poppler`). Chạy test: `npm test`.

1. `git clone` repo này.
2. Đăng nhập https://booking.base.vn/home, copy giá trị header `cookie` trong DevTools (xem mục "Khi cookie hết hạn"), rồi chạy `node set-cookie.js`. Script tự tạo `config.json`.
3. Đăng ký với Claude Code: `claude mcp add base-vn --scope user -- node /đường/dẫn/tới/server.js`.

`config.json` chứa cookie đăng nhập nên đã nằm trong `.gitignore`. Không commit file này.
