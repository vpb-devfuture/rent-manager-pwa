// lib/excel-import.js — Parse Excel to import rooms & tenants
// Uses SheetJS bundled locally (lib/xlsx.full.min.js) — no CDN needed.
//
// Expected Excel columns (flexible naming, accent-insensitive):
// | Mã phòng* | Đại diện | Số người | Giá phòng | Chỉ số ĐH ban đầu | Người ở (cách nhau ;) |
//
// * = required

const XLSX_LOCAL_PATH = chrome.runtime.getURL('lib/xlsx.full.min.js');

let _XLSX = null;
async function getXLSX() {
  if (_XLSX) return _XLSX;
  await new Promise((res, rej) => {
    // Load from bundled local file (works in extension context)
    const s = document.createElement('script');
    s.src = XLSX_LOCAL_PATH;
    s.onload = () => { _XLSX = window.XLSX; res(); };
    s.onerror = () => rej(new Error('Không tải được SheetJS từ extension'));
    document.head.appendChild(s);
  });
  return _XLSX;
}

// ── Column matching ──────────────────────────────────────
// Order matters: specific first to avoid false matches
const COL_ALIASES = {
  price: [
    'giá phòng', 'gia phong', 'tiền phòng', 'tien phong',
    'price', 'rent', 'giá thuê', 'gia thue', 'gia tien'
  ],
  representative: [
    'đại diện', 'dai dien', 'representative',
    'chủ phòng', 'chu phong', 'nguoi dai dien', 'ten nguoi thue'
  ],
  occupants: [
    'số người', 'so nguoi', 'occupants', 'số ng', 'so ng',
    'so luong nguoi', 'nguoi o'
  ],
  code: [
    'mã phòng', 'ma phong', 'room code', 'room', 'code',
    'mã', 'phòng số', 'phong so', 'so phong'
  ],
  initialElectricity: [
    'chỉ số đh', 'chi so dh', 'chỉ số ban đầu', 'chi so ban dau',
    'initial', 'chỉ số điện ban đầu', 'dong ho', 'đồng hồ',
    'chi so dong ho', 'chi so dien'
  ],
  people: [
    'danh sách người ở', 'danh sach nguoi o', 'people',
    'tenant', 'người ở', 'nguoi o', 'members', 'danh sach'
  ]
};

function normalize(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '').trim();
}

function matchCol(header) {
  const n = normalize(header);
  if (!n) return null;
  // Exact match pass first
  for (const [field, aliases] of Object.entries(COL_ALIASES)) {
    if (aliases.some(a => n === normalize(a))) return field;
  }
  // Partial match pass second
  for (const [field, aliases] of Object.entries(COL_ALIASES)) {
    if (aliases.some(a => {
      const na = normalize(a);
      return na.length >= 4 && (n.includes(na) || na.includes(n));
    })) return field;
  }
  return null;
}

function parsePrice(s) {
  // Handle: "3.000.000", "3,000,000", "3000000đ", "3.5tr"
  const str = String(s || '').trim().toLowerCase();
  if (str.includes('tr')) {
    return Math.round(parseFloat(str) * 1_000_000);
  }
  return parseInt(str.replace(/[^0-9]/g, ''), 10) || 0;
}

// ── Public: parse file ───────────────────────────────────
/**
 * Parse Excel file (Blob / File).
 * Returns { rows, errors, warnings, headers }
 */
export async function parseExcelFile(file) {
  const XLSX = await getXLSX();
  const arrayBuf = await file.arrayBuffer();

  let workbook;
  try {
    workbook = XLSX.read(arrayBuf, { type: 'array' });
  } catch (e) {
    return { rows: [], errors: ['File Excel không hợp lệ: ' + e.message], warnings: [], headers: [] };
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return { rows: [], errors: ['File Excel không có sheet nào.'], warnings: [], headers: [] };
  }

  const sheet = workbook.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  if (raw.length < 2) {
    return { rows: [], errors: ['File cần ít nhất 1 hàng header + 1 hàng dữ liệu.'], warnings: [], headers: [] };
  }

  const headerRow = raw[0].map(h => String(h).trim());
  const colMap = {}; // index → fieldName
  const unmapped = [];

  for (let i = 0; i < headerRow.length; i++) {
    const field = matchCol(headerRow[i]);
    if (field) colMap[i] = field;
    else if (headerRow[i]) unmapped.push(headerRow[i]);
  }

  const errors = [], warnings = [];

  if (!Object.values(colMap).includes('code')) {
    errors.push(
      'Không tìm thấy cột "Mã phòng" (bắt buộc).\n' +
      `Các cột trong file: ${headerRow.filter(Boolean).join(', ')}\n` +
      'Tên cột hợp lệ: "Mã phòng", "Room Code", "Mã", "Phòng số"'
    );
    return { rows: [], errors, warnings, headers: headerRow };
  }

  if (unmapped.length) {
    warnings.push(`Bỏ qua cột không nhận dạng được: ${unmapped.join(', ')}`);
  }

  const rows = [];
  const seenCodes = new Set();

  for (let i = 1; i < raw.length; i++) {
    const row = raw[i];
    if (row.every(cell => !String(cell).trim())) continue; // blank row

    const obj = {};
    for (const [idx, field] of Object.entries(colMap)) {
      obj[field] = String(row[idx] ?? '').trim();
    }

    if (!obj.code) {
      warnings.push(`Hàng ${i + 1}: bỏ qua vì không có mã phòng.`);
      continue;
    }
    const codeUpper = obj.code.toUpperCase();
    if (seenCodes.has(codeUpper)) {
      warnings.push(`Hàng ${i + 1}: mã phòng "${obj.code}" bị trùng, bỏ qua.`);
      continue;
    }
    seenCodes.add(codeUpper);

    const people = obj.people
      ? obj.people.split(/[;,|]/).map(s => s.trim()).filter(Boolean)
      : [];

    rows.push({
      code: obj.code,
      representative: obj.representative || (people[0] || ''),
      occupants: parseInt(obj.occupants) || 1,
      price: parsePrice(obj.price),
      initialElectricity: parseFloat(obj.initialElectricity) || 0,
      people,
      active: true
    });
  }

  if (!errors.length && rows.length === 0) {
    errors.push('Không tìm thấy dữ liệu phòng hợp lệ trong file.');
  }

  return { rows, errors, warnings, headers: headerRow };
}

// ── Public: generate template ────────────────────────────
/**
 * Generate and immediately download a sample Excel template.
 */
export async function downloadTemplate() {
  const XLSX = await getXLSX();

  const data = [
    // Header row
    ['Mã phòng', 'Đại diện', 'Số người', 'Giá phòng', 'Chỉ số ĐH ban đầu', 'Danh sách người ở'],
    // Sample rows
    ['P101', 'Nguyễn Văn An', 2, 3000000, 1170, 'Nguyễn Văn An; Trần Thị B'],
    ['P102', 'Lê Thị Cúc',   3, 3500000,  845, 'Lê Thị Cúc; Hoàng C; Phạm D'],
    ['P103', '',             1, 2500000,    0, ''],
    ['P201', 'Phạm Văn Dũng', 2, 3200000,  750, 'Phạm Văn Dũng; Trần E'],
    ['P202', 'Hoàng Thị Em',  1, 2800000,    0, 'Hoàng Thị Em'],
  ];

  const ws = XLSX.utils.aoa_to_sheet(data);

  // Column widths
  ws['!cols'] = [
    { wch: 12 }, { wch: 20 }, { wch: 10 }, { wch: 14 }, { wch: 20 }, { wch: 40 }
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Danh sách phòng');

  // Write and trigger download
  const arrayBuf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const blob = new Blob([arrayBuf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });

  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), {
    href: url,
    download: 'mau-danh-sach-phong.xlsx'
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
