# base-mcp

MCP server nói chuyện với Base (base.vn), đăng ký global (user scope) cho Claude Code và OpenCode. Ba mảng:

- **Booking** — đặt phòng họp trên https://booking.base.vn (Base Wework).
- **Hiring** — đọc ứng viên / CV / bình luận trên https://hiring.base.vn (chỉ đọc, không ghi).
- **Timeoff** — đọc quỹ phép và đề xuất nghỉ trên https://timeoff.base.vn (chỉ đọc, không ghi).

Dùng chung 1 cookie: Base set cookie ở domain `.base.vn` nên `basessid` dùng được cho cả 2 app.

## Tools — booking

- `list_rooms` — liệt kê phòng + sức chứa (chỉ phòng account có quyền book)
- `check_room_schedule` — lịch 1 phòng trong 1 ngày
- `book_room` — đặt phòng (tự check trùng giờ trước, Base cho phép booking chồng nhau nên phải check; `force=true` để book đè)
- `cancel_booking` — huỷ booking theo id

## Tools — hiring (chỉ đọc)

- `hiring_list_candidates` — danh sách ứng viên được chia sẻ với tài khoản này (tab CHIA SẺ): tên, id, tin tuyển dụng, vòng hiện tại, nguồn, số file, số bình luận. Lọc theo `opening` / `stage` / `query`.
- `hiring_get_candidate` — hồ sơ 1 ứng viên: liên hệ, vòng, nguồn, file đính kèm (kèm index), lịch sử chuyển vòng.
- `hiring_read_cv` — tải file đính kèm rồi tách text (PDF qua `pdftotext`, doc/docx/rtf qua `textutil`). Mặc định lấy PDF đầu tiên, chọn file khác bằng `file_index`.
- `hiring_get_comments` — bình luận nội bộ về ứng viên (ai viết, lúc nào, nội dung).

Tham số `candidate` nhận id (vd `123456`) hoặc tên (không cần dấu, vd `nguyen van a`).

⚠️ **Phạm vi = ứng viên được share với account này**. Tab TẤT CẢ trả về rỗng vì account không có quyền xem toàn bộ, không phải lỗi tool.

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
3. Chạy `node set-cookie.js`. Script đọc cookie từ clipboard (macOS), gọi thử Base, cookie sống thì mới ghi vào `config.json`. Hệ điều hành khác: dán qua stdin, vd `xclip -o -selection clipboard | node set-cookie.js -`.
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

Code ở `hiring.js`, `server.js` chỉ nối `...HIRING_TOOLS` vào mảng `TOOLS`.

- Nguồn dữ liệu chính: `GET /candidates/shared` — HTML nhúng `Client.pageData={...}` chứa `candidates[]` (66 field/ứng viên: liên hệ, `opening_export`, `stage_id`, `uploaded_files`, `changelogs`, `stats`), `stages_maps` (map `opening_id` -> danh sách vòng, để dịch `stage_id` -> tên vòng, vd "Rejected"), `total`.
- Parse: quét ngoặc cân bằng từ `Client.pageData=`. Có 2 lần gán trong trang, lần đầu là `{}` — lấy lần nào parse ra có `candidates`.
- Trang này nặng ~280KB và mọi tool đều cần -> cache 60s trong process + gộp request song song. Không cache thì gọi 4 tool cùng lúc là Base rớt kết nối (`fetch failed`). `getHiring` cũng retry 3 lần.
- CV: `uploaded_files[].full_url` (data-gcdn.basecdn.net) tải được bằng chính cookie đó. Tách text bằng `pdftotext -layout` (thử `/opt/homebrew/bin`, `/usr/local/bin`, rồi PATH — MCP process không chắc có homebrew trong PATH). Thiếu `pdftotext` thì tool trả `download_url` thay vì throw. Cài: `brew install poppler`.
- Bình luận: POST urlencoded `/ajax/api/comment/load` với `hid` + `token` của ứng viên (có sẵn trong candidate object) + bộ CSRF `__code`/`__otp`/`__sessionid`. Trả `{code:1, origin:<candidate>, comments:[...]}`. Content là HTML -> phải decode entity (`&gt;`, `&#9794` không có dấu `;`) và strip tag.
- `stats.comments` trên candidate có thể lớn hơn số comment API trả (vd counter 2, đọc được 1). Không phải phân trang — thử `method=older/all` đều trả `code:0`, comment không có reply. Nhiều khả năng counter tính cả comment đã xoá. Tool nói rõ chỗ chênh thay vì giấu.
- Cookie chết: `GET` bất kỳ trên hiring.base.vn redirect (`res.url`) sang `account.base.vn/a/login?app=hiring&return=...`, trang có `<title>Đăng nhập - Base Account</title>`.
- Endpoint khác đã thử và bỏ: `api/evaluation/get` (code 0 / 998 = INVALID_DATA, chưa tìm ra tham số đúng), `/candidates`, `/candidates/search`, `/opening/<id>/candidates` (đều trả 0 ứng viên với account này).

## Kỹ thuật — timeoff (reverse-engineered 12/10/2026)

- Trang `/` nhúng `var Client={...}` chứa `viewer`, `groups`, `ptos`, `timeoff_types`, `timesheet`; `Client.pageData={...}` chứa `timeoffs` của tài khoản hiện tại.
- Trạng thái: `0` chờ duyệt, `10` đã phê duyệt, `-10` bị từ chối, `-20` đã hủy.
- Chi tiết đề xuất: POST `/ajax/timeoffs/show` với `id` và bộ CSRF `__code` / `__otp` / `__sessionid`.
- Quỹ phép nằm trong `Client.ptos[]`; `to_type_code=annual` là phép năm, `compensatory` là nghỉ bù.
- Cố ý không nối các endpoint ghi như create/approve/reject/remove/cancel.

## Cài đặt

Cần Node 18+ (dùng `fetch` có sẵn, không có dependency). `hiring_read_cv` cần thêm `pdftotext` (`brew install poppler`).

1. `git clone` repo này.
2. Đăng nhập https://booking.base.vn/home, copy giá trị header `cookie` trong DevTools (xem mục "Khi cookie hết hạn"), rồi chạy `node set-cookie.js`. Script tự tạo `config.json`.
3. Đăng ký với Claude Code: `claude mcp add base --scope user -- node /đường/dẫn/tới/server.js`.

`config.json` chứa cookie đăng nhập nên đã nằm trong `.gitignore`. Không commit file này.
