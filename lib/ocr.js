// lib/ocr.js — OCR cho đồng hồ điện Việt Nam
//
// Đồng hồ điện VN có 2 vùng số:
//   ■ Ô TRẮNG/ĐEN: số nguyên kWh cần đọc  (vd: 5184)
//   ■ Ô ĐỎ/CAM:   chữ số thập phân (x0.1 kWh) → BỎ QUA
//
// Approach: PRE-PROCESS ảnh trước khi gửi cho BẤT KỲ engine nào
//   1. Detect vùng pixel đỏ/cam → flood-fill trắng toàn bộ ô đó
//   2. Crop an toàn: bỏ 20% bên phải (vị trí thường của ô đỏ)
//   3. Gửi ảnh đã xử lý cho Gemini / Tesseract

const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js';

// ─────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────
export async function ocrMeterImage(imageBlob, geminiApiKey = '') {
  // Bước 1: pre-process ảnh (bỏ ô đỏ) → dùng cho CẢ HAI engine
  const cleanedBlob = await removeRedDigitBox(imageBlob);

  if (geminiApiKey && geminiApiKey.trim()) {
    try { return await ocrWithGemini(cleanedBlob, geminiApiKey.trim()); }
    catch (e) { console.warn('[OCR] Gemini failed, fallback:', e.message); }
  }
  return await ocrWithTesseract(cleanedBlob);
}

// ─────────────────────────────────────────────────────────
// Pre-processing: loại bỏ ô số đỏ
// ─────────────────────────────────────────────────────────

/**
 * Loại bỏ ô số đỏ/cam trên đồng hồ điện bằng cách:
 * 1. Scan pixel: tìm vùng có màu đỏ/cam nổi bật
 * 2. Xác định bounding box của vùng đó
 * 3. Flood-fill toàn bộ bounding box (+ padding) thành trắng
 * 4. Fallback: luôn crop bỏ 20% bên phải
 */
async function removeRedDigitBox(blob) {
  const img = await loadImage(blob);

  // Scale để xử lý nhanh hơn nếu ảnh quá lớn
  const MAX_W = 1600;
  const scale = img.width > MAX_W ? MAX_W / img.width : 1;
  const w = Math.round(img.width  * scale);
  const h = Math.round(img.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);

  const id = ctx.getImageData(0, 0, w, h);
  const d  = id.data;

  // ── Bước 1: tìm tất cả pixel đỏ/cam ─────────────────
  // Điều kiện: R là kênh mạnh nhất, G và B thấp
  let minX = w, maxX = 0, minY = h, maxY = 0;
  let redCount = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = d[i], g = d[i+1], b = d[i+2];

      // Pixel đỏ: R mạnh nhất, G < 90 (phân biệt với cam sáng/vàng),
      // R phải gấp đôi G và B. Threshold G < 90 để không nhầm cam tươi.
      const isRed = r > 120 && g < 90 && b < 90 && r > g * 2.0 && r > b * 2.0;
      if (isRed) {
        redCount++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  // ── Bước 2: xóa vùng đỏ nếu tìm thấy đủ pixel ───────
  const MIN_RED_PIXELS = 50; // ít nhất 50 pixel đỏ mới xử lý
  if (redCount >= MIN_RED_PIXELS) {
    // Expand bounding box thêm padding để bao trọn ô
    const padX = Math.round((maxX - minX) * 0.15) + 4;
    const padY = Math.round((maxY - minY) * 0.15) + 4;
    const x0 = Math.max(0, minX - padX);
    const y0 = Math.max(0, minY - padY);
    const x1 = Math.min(w - 1, maxX + padX);
    const y1 = Math.min(h - 1, maxY + padY);

    // Fill vùng đỏ → trắng
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1);

    console.log(`[OCR] Removed red box: (${x0},${y0})-(${x1},${y1}), ${redCount} red pixels`);
  } else {
    // Không tìm thấy vùng đỏ rõ ràng → crop 20% bên phải làm safety
    console.log(`[OCR] No red box found (${redCount} red pixels), cropping right 20%`);
  }

  // ── Bước 3: crop bỏ 20% bên phải (safety net) ────────
  // Dù có hay không tìm thấy ô đỏ, luôn crop phần này
  // vì ô đỏ LUÔN nằm bên phải nhất
  const cropW = Math.round(w * 0.80);
  const result = document.createElement('canvas');
  result.width = cropW; result.height = h;
  result.getContext('2d').drawImage(canvas, 0, 0, cropW, h, 0, 0, cropW, h);

  return blobFromCanvas(result);
}

// ─────────────────────────────────────────────────────────
// Gemini Vision (nhận ảnh đã clean)
// ─────────────────────────────────────────────────────────
async function ocrWithGemini(cleanedBlob, apiKey) {
  const base64  = await blobToBase64(cleanedBlob);
  const mimeType = 'image/png'; // sau khi pre-process luôn là PNG

  // Prompt ngắn gọn — ảnh đã được bỏ ô đỏ rồi, chỉ còn số đen
  const prompt = `Đây là ảnh đồng hồ điện. Đọc các chữ số hiển thị trên đồng hồ và trả về số kWh nguyên.
Chỉ trả về JSON, không có gì khác:
{"reading": <số nguyên>, "raw": "<chuỗi số>", "confidence": <0.0-1.0>}
Nếu không đọc được: {"reading": null, "raw": "", "confidence": 0}`;

  const body = {
    contents: [{ parts: [
      { inlineData: { mimeType, data: base64 } },
      { text: prompt }
    ]}],
    generationConfig: { temperature: 0, maxOutputTokens: 64 }
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text().catch(()=>'')}`);

  const data   = await res.json();
  const rawText = (data.candidates?.[0]?.content?.parts?.[0]?.text || '')
    .replace(/```json|```/g, '').trim();

  const parsed = JSON.parse(rawText);
  return {
    reading:    parsed.reading != null ? Math.round(Math.abs(parsed.reading)) : null,
    raw:        parsed.raw || '',
    source:     'gemini',
    confidence: parsed.confidence ?? 1
  };
}

// ─────────────────────────────────────────────────────────
// Tesseract.js (nhận ảnh đã clean)
// ─────────────────────────────────────────────────────────
let _worker = null;

async function getTesseractWorker() {
  if (_worker) return _worker;
  const { createWorker } = await import(TESSERACT_CDN);
  _worker = await createWorker('eng', 1, {
    logger:      () => {},
    workerPath:  'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
    corePath:    'https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core.wasm.js',
    langPath:    'https://tessdata.projectnaptha.com/4.0.0'
  });
  await _worker.setParameters({
    tessedit_char_whitelist: '0123456789',
    tessedit_pageseg_mode:   '7'  // single line
  });
  return _worker;
}

async function ocrWithTesseract(cleanedBlob) {
  const worker    = await getTesseractWorker();
  const enhanced  = await enhanceForTesseract(cleanedBlob);
  const { data }  = await worker.recognize(enhanced);

  const raw     = (data.text || '').replace(/\s+/g, '').trim();
  const nums    = raw.match(/\d+/g) || [];
  const longest = nums.reduce((a, b) => b.length > a.length ? b : a, '');
  const reading = longest ? parseInt(longest, 10) : null;

  return {
    reading,
    raw,
    source:     'tesseract',
    confidence: reading ? (data.confidence || 0) / 100 : 0
  };
}

// Tăng contrast cho Tesseract sau khi đã bỏ ô đỏ
async function enhanceForTesseract(blob) {
  const img = await loadImage(blob);
  const canvas = document.createElement('canvas');
  canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const id = ctx.getImageData(0, 0, img.width, img.height);
  const d  = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const gray = Math.round(0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2]);
    // Aggressive contrast boost
    const v = gray < 128 ? Math.max(0, gray - 40) : Math.min(255, gray + 40);
    d[i] = d[i+1] = d[i+2] = v;
  }
  ctx.putImageData(id, 0, 0);
  return blobFromCanvas(canvas);
}

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────
function loadImage(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload  = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Cannot load image')); };
    img.src = url;
  });
}

function blobFromCanvas(canvas) {
  return new Promise(res => canvas.toBlob(res, 'image/png'));
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result.split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

export function terminateTesseract() {
  if (_worker) { _worker.terminate(); _worker = null; }
}
