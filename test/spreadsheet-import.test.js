import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import { parseTargetSpreadsheet } from "../spreadsheet-import.js";


function deflatedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const [name, value] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name, "utf8");
    const data = Buffer.from(value, "utf8");
    const compressed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(local, nameBuffer, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBuffer);
    localOffset += local.length + nameBuffer.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}


test("imports and deduplicates a userid CSV column", () => {
  const result = parseTargetSpreadsheet(
    Buffer.from("name,userid\n甲,user-1\n乙,user-2\n重复,user-1\n空,\n", "utf8"),
    "users.csv",
    "user",
  );

  assert.deepEqual(result.ids, ["user-1", "user-2"]);
  assert.equal(result.target_column, "userid");
  assert.equal(result.row_count, 4);
  assert.equal(result.duplicate_or_empty_count, 2);
});


test("imports a quoted chatid TSV column", () => {
  const result = parseTargetSpreadsheet(
    Buffer.from("label\tchat_id\n群一\t\"group-1\"\n群二\tgroup-2\n", "utf8"),
    "groups.tsv",
    "group",
  );

  assert.deepEqual(result.ids, ["group-1", "group-2"]);
  assert.equal(result.target_column, "chat_id");
});


test("imports the first worksheet from XLSX without third-party packages", () => {
  const worksheet = `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetData>
        <row r="1"><c r="A1" t="inlineStr"><is><t>userid</t></is></c></row>
        <row r="2"><c r="A2" t="inlineStr"><is><t>excel-user-1</t></is></c></row>
        <row r="3"><c r="A3" t="inlineStr"><is><t>excel-user-2</t></is></c></row>
      </sheetData>
    </worksheet>`;
  const workbook = deflatedZip({ "xl/worksheets/sheet1.xml": worksheet });
  const result = parseTargetSpreadsheet(workbook, "users.xlsx", "user");

  assert.deepEqual(result.ids, ["excel-user-1", "excel-user-2"]);
  assert.equal(result.target_column, "userid");
});


test("rejects unsupported upload formats", () => {
  assert.throws(
    () => parseTargetSpreadsheet(Buffer.from("id\nuser-1"), "users.xls", "user"),
    /仅支持/,
  );
});
