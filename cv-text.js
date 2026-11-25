// Tách text từ file CV, chạy được trên macOS, Linux và Windows.
// Thứ tự thử:
//   PDF : pdftotext (poppler, giữ layout) -> thư viện JS `pdf-parse` (tuỳ chọn: `npm install pdf-parse`)
//   DOCX: tự đọc zip bằng zlib có sẵn của Node, không cần cài gì
//   DOC / RTF / HTML: textutil (chỉ macOS)
// Không tách được thì trả null, bên gọi tự quyết định báo gì cho người dùng.

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

const MAX = 32 * 1024 * 1024;

function withTempFile(buf, name, fn) {
  const tmp = path.join(os.tmpdir(), `base-hiring-${process.pid}-${Date.now()}-${String(name || "file").replace(/[^\w.-]/g, "_")}`);
  fs.writeFileSync(tmp, buf, { mode: 0o600 });
  try {
    return fn(tmp);
  } finally {
    // luôn xoá file tạm: đây là CV của ứng viên, không để rơi lại trong thư mục tạm
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

function pdftotext(buf, name) {
  const bins =
    process.platform === "win32"
      ? ["pdftotext.exe", "pdftotext"]
      : ["/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext", "pdftotext"];
  return withTempFile(buf, name, (tmp) => {
    for (const bin of bins) {
      try {
        return execFileSync(bin, ["-layout", tmp, "-"], { encoding: "utf8", maxBuffer: MAX, windowsHide: true });
      } catch (e) {
        if (e && (e.code === "ENOENT" || e.code === 127)) continue;
        return null; // có pdftotext nhưng lỗi với file này -> để pdf-parse thử
      }
    }
    return null;
  });
}

async function pdfParse(buf) {
  let mod;
  try {
    mod = require("pdf-parse");
  } catch {
    return null; // chưa cài
  }
  try {
    if (typeof mod === "function") return (await mod(buf)).text; // pdf-parse v1
    if (mod && typeof mod.PDFParse === "function") {
      // pdf-parse v2
      const parser = new mod.PDFParse({ data: buf });
      try {
        return (await parser.getText()).text;
      } finally {
        if (typeof parser.destroy === "function") await parser.destroy();
      }
    }
  } catch {}
  return null;
}

function textutil(buf, name) {
  if (process.platform !== "darwin") return null;
  return withTempFile(buf, name, (tmp) => {
    try {
      return execFileSync("/usr/bin/textutil", ["-convert", "txt", "-stdout", tmp], { encoding: "utf8", maxBuffer: MAX });
    } catch {
      return null;
    }
  });
}

// Đọc một entry trong file zip (đủ dùng cho .docx: không zip64, không mã hoá).
function zipEntry(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (name === wanted) {
      if (buf.readUInt32LE(local) !== 0x04034b50) return null;
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX });
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function docxText(buf) {
  let xml;
  try {
    xml = zipEntry(buf, "word/document.xml");
  } catch {
    return null;
  }
  if (!xml) return null;
  return xml
    .toString("utf8")
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:(br|cr)\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

// Trả text hoặc null.
async function extractText(buf, name) {
  const fileName = String(name || "");
  // Có file Base trả về dư vài byte trước "%PDF" (đã gặp với một CV thật),
  // nên dò chữ ký trong 1KB đầu thay vì so khớp đúng offset 0.
  const pdfAt = buf.subarray(0, 1024).toString("latin1").indexOf("%PDF");
  if (pdfAt >= 0) return pdftotext(buf, fileName) || (await pdfParse(pdfAt ? buf.subarray(pdfAt) : buf));
  if (/\.docx$/i.test(fileName)) return docxText(buf) || textutil(buf, fileName);
  if (/\.(doc|rtf|html?)$/i.test(fileName)) return textutil(buf, fileName);
  if (/\.(txt|md)$/i.test(fileName)) return buf.toString("utf8");
  return null;
}

module.exports = { extractText, docxText, zipEntry, pdfParse, pdftotext };
