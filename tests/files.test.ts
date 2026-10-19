import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  colIndex, decodeText, docxFromZip, docxText, extractTasks, fitBudget, imageSize, kindOf, listZip, readFile, readFiles,
  truncationNote, unzipEntry, xlsxFromZip, xlsxSharedStrings, xlsxSheetRows, pptxFromZip, MAX_CHARS, type FileCard,
} from '../src/files.ts';

/** Собрать zip вручную: method 8 (deflate) или 0 (без сжатия). */
function makeZip(files: Record<string, string>, method: 0 | 8 = 8): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameB = enc.encode(name);
    const raw = enc.encode(text);
    const data = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(8, method, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, raw.length, true);
    lh.setUint16(26, nameB.length, true);
    locals.push(new Uint8Array(lh.buffer), nameB, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(10, method, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, raw.length, true);
    ch.setUint16(28, nameB.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const parts = [...locals, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const x of parts) {
    out.set(x, p);
    p += x.length;
  }
  return out;
}

const DOCX_XML = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Щит 600×800</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Мощность </w:t></w:r><w:r><w:t>1,5 кВт &amp; IP54</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Купить вентилятор</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Артикул</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Цена</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>EKF-150</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>Строка</w:t><w:br/><w:t>вторая</w:t></w:r></w:p>
</w:body></w:document>`;

test('zip: оглавление и распаковка (deflate и без сжатия)', async () => {
  for (const method of [8, 0] as const) {
    const z = makeZip({ 'a.txt': 'привет', 'dir/b.xml': '<x>1</x>'.repeat(50) }, method);
    const list = listZip(z);
    assert.deepEqual(list.map((e) => e.name), ['a.txt', 'dir/b.xml']);
    assert.equal(new TextDecoder().decode(await unzipEntry(z, list[0])), 'привет');
    assert.equal(new TextDecoder().decode(await unzipEntry(z, list[1])).length, 400);
  }
  assert.throws(() => listZip(new Uint8Array(100)), /zip/);
});

test('docx: заголовки, списки, таблицы, сущности', async () => {
  const t = docxText(DOCX_XML);
  assert.match(t, /^# Щит 600×800/);
  assert.match(t, /Мощность 1,5 кВт & IP54/);
  assert.match(t, /• Купить вентилятор/);
  assert.match(t, /Артикул \| Цена/);
  assert.match(t, /EKF-150 \|$/m);
  assert.match(t, /Строка\nвторая/);
  const z = makeZip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': DOCX_XML });
  assert.equal(await docxFromZip(z), t);
  await assert.rejects(docxFromZip(makeZip({ 'x.xml': '<a/>' })), /document\.xml/);
});

test('xlsx: общие строки, листы по порядку, пустые ячейки, числа', async () => {
  const shared = `<sst><si><t>Позиция</t></si><si><t>Кол-во</t></si><si><r><t>Вентилятор </t></r><r><t>EKF</t></r></si><si><t>Итого &lt;5</t></si></sst>`;
  const sheet1 = `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>2.5</v></c></row>
    <row r="3"><c r="A3" t="inlineStr"><is><t>прямо в ячейке</t></is></c><c r="B3" t="b"><v>1</v></c></row>
  </sheetData></worksheet>`;
  const sheet2 = `<worksheet><sheetData><row r="1"><c r="B1" t="s"><v>3</v></c></row></sheetData></worksheet>`;
  assert.deepEqual(xlsxSharedStrings(shared), ['Позиция', 'Кол-во', 'Вентилятор EKF', 'Итого <5']);
  assert.equal(colIndex('C7'), 2);
  assert.equal(colIndex('AA1'), 26);
  assert.deepEqual(xlsxSheetRows(sheet1, xlsxSharedStrings(shared)), [['Позиция', '', 'Кол-во'], ['Вентилятор EKF', '', '2,5'], ['прямо в ячейке', 'ИСТИНА']]);
  const z = makeZip({
    'xl/workbook.xml': `<workbook><sheets><sheet name="Сводка" sheetId="2" r:id="rId2"/><sheet name="Данные" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
    'xl/sharedStrings.xml': shared,
    'xl/worksheets/sheet1.xml': sheet1,
    'xl/worksheets/sheet2.xml': sheet2,
  });
  const r = await xlsxFromZip(z);
  assert.deepEqual(r.sheets, ['Сводка', 'Данные']);
  assert.ok(r.text.indexOf('Сводка') < r.text.indexOf('Данные'));
  assert.match(r.text, /Позиция\t\tКол-во/);
  assert.match(r.text, /\tИтого <5/);
  // без оглавления — по номерам листов
  const bare = await xlsxFromZip(makeZip({ 'xl/worksheets/sheet2.xml': sheet2, 'xl/worksheets/sheet1.xml': sheet1, 'xl/sharedStrings.xml': shared }));
  assert.deepEqual(bare.sheets, ['Лист1', 'Лист2']);
});

test('pptx: слайды по порядку', async () => {
  const slide = (t: string) => `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p><a:p><a:r><a:t>пункт</a:t></a:r></a:p></p:sld>`;
  const r = await pptxFromZip(makeZip({ 'ppt/slides/slide10.xml': slide('Десятый'), 'ppt/slides/slide2.xml': slide('Второй') }));
  assert.equal(r.slides, 2);
  assert.ok(r.text.indexOf('Второй') < r.text.indexOf('Десятый'));
});

test('readFile/readFiles: несколько файлов, бюджет и явное сообщение об обрезке', async () => {
  const docx = new File([makeZip({ 'word/document.xml': DOCX_XML }) as BlobPart], 'ТЗ.docx');
  const big = new File(['строка текста\n'.repeat(2000)], 'журнал.log');
  const small = new File(['a,b\n1,2\n'], 'табл.csv');
  const cards = await readFiles([docx, big, small]);
  assert.deepEqual(cards.map((c) => c.kind), ['docx', 'text', 'table']);
  assert.ok(cards.reduce((a, c) => a + c.text.length, 0) <= MAX_CHARS);
  assert.equal(cards[0].truncated, false);
  assert.equal(cards[2].text, 'a,b\n1,2');
  assert.equal(cards[1].truncated, true);
  assert.match(truncationNote(cards[1]), /только начало: \d[\d\s ]* из 27[\s ]?999 символов/);
  // неизвестный формат и картинка — карточки без исключений
  const other = await readFile(new File([new Uint8Array([1, 2, 3])], 'схема.dwg'));
  assert.equal(other.kind, 'other');
  assert.match(other.note!, /не читаю/);
  const broken = await readFile(new File(['не zip'], 'плохой.docx'));
  assert.match(broken.note!, /Не получилось прочитать/);
});

test('бюджет делится: короткие целиком, длинные поровну', () => {
  const mk = (n: number): FileCard => ({ id: String(n), name: 'x', size: n, mime: '', kind: 'text', text: '', full: 'x'.repeat(n), truncated: false });
  const cards = fitBudget([mk(5000), mk(100), mk(9000)], 3000);
  assert.equal(cards[1].text.length, 100);
  assert.equal(cards[0].text.length, 1450);
  assert.equal(cards[2].text.length, 1450);
  assert.ok(cards[0].truncated && cards[2].truncated && !cards[1].truncated);
});

test('кодировки, размеры картинок, типы', () => {
  const cp1251 = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // «Привет»
  assert.equal(decodeText(cp1251), 'Привет');
  assert.equal(decodeText(new TextEncoder().encode('ёжик')), 'ёжик');
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00])), 'AB');
  const png = new Uint8Array(32);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  png.set([0, 0, 2, 0], 16); // 512
  png.set([0, 0, 1, 0], 20); // 256
  assert.deepEqual(imageSize(png), { width: 512, height: 256 });
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 20, 0, 0]);
  assert.deepEqual(imageSize(gif), { width: 10, height: 20 });
  assert.equal(kindOf('отчёт.XLSX'), 'xlsx');
  assert.equal(kindOf('субтитры.srt'), 'text');
  assert.equal(kindOf('фото.jpeg'), 'image');
  assert.equal(kindOf('настройки.ini'), 'text');
  assert.equal(kindOf('архив.7z'), 'other');
});

test('задачи из файла: чек-листы, TODO, нумерация', () => {
  assert.deepEqual(extractTasks('# План\n- [ ] Купить кабель\n- [x] готово\n- [ ] Позвонить поставщику'), ['Купить кабель', 'Позвонить поставщику']);
  assert.deepEqual(extractTasks('код\nTODO: поправить экспорт\n// ещё\nНадо — проверить DXF'), ['поправить экспорт', 'проверить DXF']);
  assert.deepEqual(extractTasks('1. Первое\n2) Второе\nтекст'), ['Первое', 'Второе']);
  assert.deepEqual(extractTasks('просто текст без пунктов'), []);
});
