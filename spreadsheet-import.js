import { inflateRawSync } from "node:zlib";


const XLSX_ENTRY_LIMIT = 12 * 1024 * 1024;
const XLSX_TOTAL_LIMIT = 24 * 1024 * 1024;
const MAX_SHEET_ROWS = 20000;
const MAX_SHEET_COLUMNS = 128;


function decodeXml(value) {
  return value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}


function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("不是有效的 XLSX/ZIP 文件：缺少中央目录。");
}


function readZipEntries(buffer) {
  const endOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  let offset = buffer.readUInt32LE(endOffset + 16);
  const entries = new Map();
  let totalSize = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("XLSX 中央目录损坏。");
    }
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");

    if (uncompressedSize > XLSX_ENTRY_LIMIT) throw new Error(`XLSX 条目过大：${name}`);
    totalSize += uncompressedSize;
    if (totalSize > XLSX_TOTAL_LIMIT) throw new Error("XLSX 解压后内容超过安全限制。");
    if (!name.endsWith("/")) {
      if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error(`XLSX 本地条目损坏：${name}`);
      }
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > buffer.length) throw new Error(`XLSX 条目越界：${name}`);
      const compressed = buffer.subarray(dataStart, dataEnd);
      let content;
      if (compression === 0) content = Buffer.from(compressed);
      else if (compression === 8) content = inflateRawSync(compressed, { maxOutputLength: XLSX_ENTRY_LIMIT });
      else throw new Error(`XLSX 使用了不支持的压缩方式：${compression}`);
      if (content.length !== uncompressedSize) throw new Error(`XLSX 条目长度不一致：${name}`);
      entries.set(name.replace(/\\/g, "/"), content);
    }
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}


function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((match) => (
    [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)]
      .map((part) => decodeXml(part[1]))
      .join("")
  ));
}


function columnIndex(reference) {
  const letters = String(reference).match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? "A";
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, result - 1);
}


function cellValue(cellXml, type, sharedStrings) {
  if (type === "inlineStr") {
    return [...cellXml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)]
      .map((match) => decodeXml(match[1]))
      .join("");
  }
  const raw = cellXml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] ?? "";
  if (type === "s") return sharedStrings[Number.parseInt(raw, 10)] ?? "";
  return decodeXml(raw);
}


function parseWorksheet(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    if (rows.length >= MAX_SHEET_ROWS) throw new Error(`表格行数超过 ${MAX_SHEET_ROWS} 行限制。`);
    const row = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const reference = cellMatch[1].match(/\br="([^"]+)"/i)?.[1] ?? "A1";
      const type = cellMatch[1].match(/\bt="([^"]+)"/i)?.[1] ?? "";
      const index = columnIndex(reference);
      if (index >= MAX_SHEET_COLUMNS) continue;
      row[index] = cellValue(cellMatch[2], type, sharedStrings).trim();
    }
    rows.push(row.map((value) => value ?? ""));
  }
  return rows;
}


function parseXlsx(buffer) {
  const entries = readZipEntries(buffer);
  const sheetName = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
  if (!sheetName) throw new Error("XLSX 中没有可读取的工作表。");
  const shared = parseSharedStrings(entries.get("xl/sharedStrings.xml")?.toString("utf8") ?? "");
  return parseWorksheet(entries.get(sheetName).toString("utf8"), shared);
}


function detectDelimiter(text, filename) {
  if (/\.tsv$/i.test(filename)) return "\t";
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const candidates = ["\t", ",", ";"];
  return candidates
    .map((delimiter) => ({ delimiter, count: firstLine.split(delimiter).length - 1 }))
    .sort((a, b) => b.count - a.count)[0]?.count > 0
    ? candidates
      .map((delimiter) => ({ delimiter, count: firstLine.split(delimiter).length - 1 }))
      .sort((a, b) => b.count - a.count)[0].delimiter
    : "\n";
}


function parseDelimited(text, delimiter) {
  const normalized = text.replace(/^\uFEFF/, "");
  if (delimiter === "\n") return normalized.split(/\r?\n/).map((line) => [line.trim()]);
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (quoted) {
      if (char === '"' && normalized[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(field.trim());
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, "").trim());
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  row.push(field.replace(/\r$/, "").trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}


function normalizeHeader(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}


function targetColumn(rows, targetType) {
  const headers = (rows[0] ?? []).map(normalizeHeader);
  const preferred = targetType === "group"
    ? ["chatid", "groupid", "targetid", "id"]
    : ["userid", "user", "targetid", "id"];
  for (const name of preferred) {
    const index = headers.indexOf(name);
    if (index >= 0) return { index, hasHeader: true, header: rows[0][index] };
  }
  return { index: 0, hasHeader: false, header: "第一列" };
}


export function parseTargetSpreadsheet(buffer, filename, targetType, maxTargets = 500) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("上传文件不能为空。");
  const safeName = String(filename ?? "").trim();
  let rows;
  if (/\.xlsx$/i.test(safeName)) rows = parseXlsx(buffer);
  else if (/\.(csv|tsv|txt)$/i.test(safeName)) {
    const text = buffer.toString("utf8");
    rows = parseDelimited(text, detectDelimiter(text, safeName));
  } else {
    throw new Error("仅支持 .xlsx、.csv、.tsv 或 .txt 表格文件。");
  }

  if (rows.length === 0) throw new Error("表格中没有数据。");
  const selected = targetColumn(rows, targetType);
  const start = selected.hasHeader ? 1 : 0;
  const ids = [];
  const seen = new Set();
  for (let index = start; index < rows.length; index += 1) {
    const id = String(rows[index]?.[selected.index] ?? "").trim();
    if (!id || seen.has(id)) continue;
    if (id.length > 256 || /[\r\n]/.test(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length > maxTargets) throw new Error(`目标数量超过 ${maxTargets} 个限制。`);
  }
  if (ids.length === 0) throw new Error(`未在“${selected.header}”列读取到有效 ID。`);
  return {
    ids,
    target_column: selected.header,
    row_count: rows.length - start,
    duplicate_or_empty_count: Math.max(0, rows.length - start - ids.length),
  };
}
