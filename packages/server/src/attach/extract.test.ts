import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractFile, MAX_PDF_PAGES, MAX_TEXT_CHARS } from "./extract";
import { readEntry, readZip } from "./zip";

/** A zip archive made by hand: stored (0) or deflated (8). The reader does not check CRCs, so they are left 0. */
function makeZip(files: Record<string, string>, method: 0 | 8 = 8): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, "utf8");
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nameB = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameB.length, 26);
    const local = Buffer.concat([lh, nameB, data]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, nameB]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A PDF of one or more pages, each with one line of text (or none). */
function makePdf(line: string, pages = 1): Buffer {
  const stream = line ? `BT /F1 18 Tf 20 100 Td (${line}) Tj ET` : "";
  const kids = Array.from({ length: pages }, (_, i) => `${5 + i} 0 R`).join(" ");
  const objs: (string | null)[] = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", null];
  for (let i = 0; i < pages; i++) objs.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 3 0 R >> >> >>");
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o === null ? `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream` : o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

const text = async (name: string, bytes: Buffer | string) => {
  const r = await extractFile(name, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  if (!r.ok || r.kind !== "text") throw new Error(JSON.stringify(r).slice(0, 200));
  return r.text;
};

describe("plain text", () => {
  it("reads text and code files, and a file with a byte order mark", async () => {
    expect(await text("notes.md", "# Title\nhello")).toBe("# Title\nhello");
    expect(await text("a.ts", "const x = 1;")).toBe("const x = 1;");
    expect(await text("w.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("with bom")]))).toBe("with bom");
    expect(await text("u.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("utf16", "utf16le")]))).toBe("utf16");
  });
  it("reads a file with an unknown ending when it is text, and refuses one that is not", async () => {
    expect(await text("data.xyz", "just words")).toBe("just words");
    expect(await extractFile("blob.bin", Buffer.from([1, 2, 0, 3, 4]))).toMatchObject({ ok: false, error: expect.stringMatching(/cannot read/) });
    expect(await extractFile("fake.txt", Buffer.from([1, 2, 0, 3, 4]))).toMatchObject({ ok: false, error: expect.stringMatching(/not text/) });
    expect(await extractFile("empty.txt", Buffer.from("  \n"))).toMatchObject({ ok: false, error: expect.stringMatching(/no text/) });
  });
  it("cuts a huge file and says so", async () => {
    const t = await text("big.txt", "x".repeat(MAX_TEXT_CHARS + 10));
    expect(t.length).toBeLessThan(MAX_TEXT_CHARS + 200);
    expect(t).toMatch(/the rest of the file is not shown/);
  });
  it("turns a web page into its text, without scripts or tags", async () => {
    const t = await text("page.html", "<html><head><title>T</title><style>p{}</style></head><body><h1>Hi &amp; bye</h1><script>alert(1)</script><p>one</p><p>two</p></body></html>");
    expect(t).toBe("Hi & bye\none\ntwo");
  });
});

describe("Word, Excel and PowerPoint", () => {
  it("reads the text of a Word document, with its paragraphs, tabs and table cells, and leaves out deleted text and field codes", async () => {
    const xml = `<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t xml:space="preserve">world &amp; co</w:t></w:r></w:p><w:p><w:r><w:instrText> PAGE </w:instrText></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:r><w:t>Second</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
    const t = await text("report.docx", makeZip({ "word/document.xml": xml }));
    expect(t).toContain("Hello\tworld & co");
    expect(t).toContain("Second");
    expect(t).not.toMatch(/gone|PAGE/);
    expect(t).toMatch(/A\s+B/);
  });

  it("reads every sheet of an Excel file as rows, with shared and inline strings, numbers, booleans and empty cells", async () => {
    const files = {
      "xl/workbook.xml": `<workbook><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; more" sheetId="2" r:id="rId2"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
      "xl/sharedStrings.xml": `<sst><si><t>Item</t></si><si><r><t>Pri</t></r><r><t>ce</t></r></si><si><t>Pen</t></si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>4.5</v></c></row></sheetData></worksheet>`,
      "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>inline</t></is></c><c r="B1" t="b"><v>1</v></c></row></sheetData></worksheet>`,
    };
    const t = await text("sales.xlsx", makeZip(files));
    expect(t).toBe("## Sheet: Sales\nItem\tPrice\nPen\t\t4.5\n\n## Sheet: Notes & more\ninline\tTRUE");
  });

  it("reads the slides of a PowerPoint file in order", async () => {
    const slide = (s: string) => `<p:sld><a:p><a:r><a:t>${s}</a:t></a:r></a:p></p:sld>`;
    const t = await text("deck.pptx", makeZip({ "ppt/slides/slide10.xml": slide("Ten"), "ppt/slides/slide2.xml": slide("Two"), "ppt/slides/slide1.xml": slide("One") }));
    expect(t).toBe("## Slide 1\nOne\n\n## Slide 2\nTwo\n\n## Slide 3\nTen");
  });

  it("works with stored (not compressed) archives too, and refuses a file that is not what its ending says, and the old formats", async () => {
    expect(await text("s.docx", makeZip({ "word/document.xml": "<w:p><w:t>stored</w:t></w:p>" }, 0))).toBe("stored");
    expect(await extractFile("fake.docx", Buffer.from("not a zip"))).toMatchObject({ ok: false });
    expect(await extractFile("empty.xlsx", makeZip({ "other.xml": "x" }))).toMatchObject({ ok: false });
    expect(await extractFile("old.doc", Buffer.from("x"))).toMatchObject({ ok: false, error: expect.stringMatching(/old DOC.*docx/) });
  });

  it("will not unpack an archive whose file is far larger than it says (a zip bomb)", () => {
    const zip = makeZip({ "word/document.xml": "a".repeat(200_000) });
    const entries = readZip(zip);
    const e = entries.get("word/document.xml")!;
    expect(() => readEntry(zip, e, 1000)).toThrow(/too large/);
    expect(() => readEntry(zip, { ...e, size: 10 }, 1000)).toThrow(); // it claims 10 bytes, but unpacks to more than the limit
  });
});

describe("PDF and pictures", () => {
  it("reads the text of a PDF page by page", async () => {
    const t = await text("paper.pdf", makePdf("Hello PDF world"));
    expect(t).toContain("--- page 1 ---");
    expect(t).toContain("Hello PDF world");
  });

  it("says a PDF with no text (a scan) has none, and that a damaged one cannot be read", async () => {
    expect(await extractFile("scan.pdf", makePdf(""))).toMatchObject({ ok: false, error: expect.stringMatching(/no text/) });
    expect(await extractFile("broken.pdf", Buffer.from("%PDF-1.4 garbage"))).toMatchObject({ ok: false, error: expect.stringMatching(/could not read/) });
  });

  it("hands a picture over as a picture, and refuses one that is too large", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(await extractFile("shot.PNG", png)).toEqual({ ok: true, kind: "image", mime: "image/png", data: png.toString("base64") });
    expect(await extractFile("big.jpg", Buffer.alloc(6 * 1024 * 1024))).toMatchObject({ ok: false, error: expect.stringMatching(/too big/) });
  });
});

describe("a crafted file cannot use up the PC", () => {
  it("does not send a text file named .png on as a picture, or a picture that is not what its ending says", async () => {
    expect(await extractFile("fake.png", Buffer.from("<html>not a picture</html>"))).toMatchObject({ ok: false, error: expect.stringMatching(/not a real \.png/) });
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("body")]);
    expect(await extractFile("a.jpg", jpeg)).toMatchObject({ ok: true, kind: "image", mime: "image/jpeg" });
    expect(await extractFile("a.png", jpeg)).toMatchObject({ ok: false });
    expect(await extractFile("a.gif", Buffer.from("GIF89a-body"))).toMatchObject({ ok: true, mime: "image/gif" });
    expect(await extractFile("a.webp", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]))).toMatchObject({ ok: true, mime: "image/webp" });
  });

  it("shows only the first sheets of a workbook that has hundreds", async () => {
    const sheets = Array.from({ length: 80 }, (_, i) => `<sheet name="S${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
    const rels = Array.from({ length: 80 }, (_, i) => `<Relationship Id="rId${i + 1}" Type="x" Target="worksheets/sheet${i + 1}.xml"/>`).join("");
    const files: Record<string, string> = { "xl/workbook.xml": `<workbook><sheets>${sheets}</sheets></workbook>`, "xl/_rels/workbook.xml.rels": `<Relationships>${rels}</Relationships>` };
    for (let i = 1; i <= 80; i++) files[`xl/worksheets/sheet${i}.xml`] = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>v${i}</t></is></c></row></sheetData></worksheet>`;
    const t = await text("many.xlsx", makeZip(files));
    expect(t).toContain("## Sheet: S50");
    expect(t).not.toContain("## Sheet: S51");
    expect(t).toMatch(/only the first 50 sheets/);
  });

  it("refuses a document that unpacks to far more than its size, and an archive that lists thousands of files", async () => {
    const big = "a".repeat(20 * 1024 * 1024);
    const files: Record<string, string> = { "xl/workbook.xml": `<workbook><sheets>${Array.from({ length: 8 }, (_, i) => `<sheet name="S${i}" r:id="rId${i}"/>`).join("")}</sheets></workbook>`, "xl/_rels/workbook.xml.rels": `<Relationships>${Array.from({ length: 8 }, (_, i) => `<Relationship Id="rId${i}" Target="worksheets/s${i}.xml"/>`).join("")}</Relationships>` };
    for (let i = 0; i < 8; i++) files[`xl/worksheets/s${i}.xml`] = `<worksheet>${big}</worksheet>`;
    expect(await extractFile("bomb.xlsx", makeZip(files))).toMatchObject({ ok: false, error: expect.stringMatching(/too large or too complex/) });
    const many: Record<string, string> = {};
    for (let i = 0; i < 5100; i++) many[`f${i}.txt`] = "x";
    expect(await extractFile("many.docx", makeZip(many, 0))).toMatchObject({ ok: false });
  });

  it("reads only the first pages of a very long PDF, and says so", async () => {
    const t = await text("long.pdf", makePdf("Page text", 305));
    expect(t).toContain(`--- page ${MAX_PDF_PAGES} ---`);
    expect(t).not.toContain(`--- page ${MAX_PDF_PAGES + 1} ---`);
    expect(t).toMatch(/only the first 300 of 305 pages/);
  });
});
