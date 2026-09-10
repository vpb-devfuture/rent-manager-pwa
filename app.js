// app.js — Full app controller v3
// Uses: DriveStore (drive-first storage), Store (business logic), fmtVND (format tiền)
import { Auth } from './lib/auth.js';
import { Store } from './lib/store.js';
import { DriveStore, fmtVND } from './lib/drive-storage.js';
import { ocrMeterImage } from './lib/ocr.js';
import { parseExcelFile, downloadTemplate } from './lib/excel-import.js';
import { Sharing } from './lib/sharing.js';
import { getImageUrl, hydrateImages, prefetch as prefetchImages, revokeAll as revokeAllImages } from './lib/image-cache.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ── Helpers ───────────────────────────────────────────────
function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function shiftPeriod(p, d) {
  const [y, m] = p.split('-').map(Number);
  const dt = new Date(y, m - 1 + d, 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}
// Hiển thị lùi 1 tháng so với period lưu trong dữ liệu (chỉ đổi hiển thị, không đổi logic/dữ liệu).
function displayPeriod(p) { return /^\d{4}-\d{2}$/.test(p) ? shiftPeriod(p, -1) : p; }
function roomTitle(room) {
  const rep = (room?.representative || '').trim();
  return escHtml(room?.code || '') + (rep ? ` (${escHtml(rep)})` : '');
}
function periodLabel(p) { const [y, m] = displayPeriod(p).split('-'); return `Tháng ${m}/${y}`; }
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg, kind = '') {
  const el = Object.assign(document.createElement('div'),
    { className: `toast ${kind ? 'toast-' + kind : ''}`, textContent: msg });
  $('#toast-container').appendChild(el);
  setTimeout(() => el.remove(), 2800);
}
function setLoading(el, loading, label = '') {
  if (!el) return;
  el.disabled = loading;
  if (label) el.textContent = loading ? '...' : label;
}
async function confirmDialog(title, message, opts = {}) {
  return new Promise(resolve => {
    const cancelLabel = opts.cancel === undefined ? 'Hủy' : opts.cancel;
    const cancelBtn = cancelLabel
      ? `<button class="btn btn-secondary" data-act="cancel">${cancelLabel}</button>`
      : '';
    openModal({
      title,
      body: `<p class="muted" style="line-height:1.7;white-space:pre-wrap">${escHtml(message)}</p>`,
      footer: `${cancelBtn}
               <button class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${opts.ok || 'Xác nhận'}</button>`,
      onAction(act, close) { close(); resolve(act === 'ok'); }
    });
  });
}

function triggerBadge() { chrome.runtime.sendMessage({ type: 'UPDATE_BADGE' }).catch(() => {}); }


// ── Lightbox ──────────────────────────────────────────────
function openLightbox(src, alt = '') {
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = `
    <button class="lightbox-close" title="Đóng">✕</button>
    <img src="${escHtml(src)}" alt="${escHtml(alt)}" referrerpolicy="no-referrer"
         draggable="false"/>
    <div class="lightbox-hint">Cuộn để zoom · Bấm ngoài để đóng</div>`;
  document.body.appendChild(lb);

  const img = lb.querySelector('img');
  let scale = 1, originX = 50, originY = 50;

  // Zoom bằng scroll
  lb.addEventListener('wheel', e => {
    e.preventDefault();
    scale = Math.min(5, Math.max(0.5, scale - e.deltaY * 0.002));
    img.style.transform = `scale(${scale})`;
  }, { passive: false });

  // Pan khi đã zoom
  let dragging = false, lastX = 0, lastY = 0, tx = 0, ty = 0;
  img.addEventListener('mousedown', e => {
    if (scale <= 1) return;
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    img.style.cursor = 'grabbing';
    e.stopPropagation();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    tx += e.clientX - lastX; ty += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    img.style.transform = `scale(${scale}) translate(${tx/scale}px, ${ty/scale}px)`;
  });
  window.addEventListener('mouseup', () => {
    dragging = false; img.style.cursor = 'default';
  });

  // Đóng
  const close = () => lb.remove();
  lb.querySelector('.lightbox-close').onclick = close;
  lb.addEventListener('click', e => { if (e.target === lb) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
}

// Delegate click trên ảnh có data-lightbox HOẶC data-img-lightbox-from-fileid
document.addEventListener('click', e => {
  const img = e.target.closest('img[data-lightbox], img[data-img-lightbox-from-fileid]');
  if (!img) return;
  // Ưu tiên data-lightbox đã được set bởi hydrateImages, fallback img.src
  const src = img.dataset.lightbox || img.src;
  if (src && !src.startsWith('data:image/svg')) openLightbox(src, img.alt);
});

// ── Modal ─────────────────────────────────────────────────
function openModal({ title, body, footer = '', onAction, lg = false }) {
  const root = $('#modal-root');
  const id = 'm' + Math.random().toString(36).slice(2, 7);
  root.innerHTML = `
    <div class="modal-backdrop" id="${id}">
      <div class="modal ${lg ? 'modal-lg' : ''}" role="dialog">
        <div class="modal-header">
          <div class="modal-title">${title}</div>
          <button class="btn-icon" data-act="close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-footer">${footer}</div>` : ''}
      </div>
    </div>`;
  const backdrop = $('#' + id);
  const close = () => backdrop.remove();
  // Lazy-load các <img data-img-fileid="..."> trong modal vừa mở
  try { hydrateImages(backdrop); } catch {}
  backdrop.addEventListener('click', e => {
    if (e.target === backdrop) return close();
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'close') return close();
    if (onAction) onAction(act, close, backdrop);
  });
  document.addEventListener('keydown', function esc(ev) {
    if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
  return { close, root: backdrop };
}

// ── Theme ─────────────────────────────────────────────────
function applyTheme(theme) {
  const t = theme === 'auto' ? (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light') : theme;
  document.documentElement.setAttribute('data-theme', t);
  const ti = $('#theme-icon');
  if (ti) ti.innerHTML = t === 'dark'
    ? '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
    : '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>';
  const tl = $('#theme-label');
  if (tl) tl.textContent = theme === 'auto' ? 'Tự động' : theme === 'dark' ? 'Tối' : 'Sáng';
}

// ── App State ─────────────────────────────────────────────
let UI = { tab: 'rooms', period: currentPeriod() };
if (location.hash === '#meter')   UI.tab = 'meter';
if (location.hash === '#payment') UI.tab = 'payment';

// ── Sign-in ───────────────────────────────────────────────
async function ensureSignedIn() {
  const profile = await Auth.getProfile();
  if (!profile) {
    $('#signin-overlay').style.display = 'flex';
    $('#signin-btn').onclick = async () => {
      const btn = $('#signin-btn'), lbl = $('#signin-btn-label');
      btn.disabled = true; lbl.textContent = 'Đang đăng nhập...';
      try {
        await Auth.signIn();
        try { await Store.pullAll(); } catch {}
        $('#signin-overlay').style.display = 'none';
        await renderAll();
      } catch (e) {
        if (e.isConfigError) {
          toast('⚠ ' + e.message, 'danger');
          console.error('[Auth config error]', e.message, '\nHint:', e.hint);
          setTimeout(() => toast(e.hint, 'warning'), 400);
        } else if (e.message === 'Đăng nhập bị hủy') {
          toast('Đã hủy đăng nhập', '');
        } else {
          toast('Đăng nhập thất bại: ' + e.message, 'danger');
        }
        btn.disabled = false; lbl.textContent = 'Đăng nhập với Google';
      }
    };
    return false;
  }
  const el = $('#user-email'); if (el) el.textContent = profile.email || '';
  return true;
}

// ── Shared data loader (called once per renderAll) ─────────
async function loadHouseData(houseId) {
  const [meta, rooms, readings, payments] = await Promise.all([
    DriveStore.readMeta(),
    Store.getRooms(houseId),
    Store.getMeterReadings(houseId),
    Store.getPayments(houseId)
  ]);
  const house = meta.houses.find(h => h.id === houseId);
  return { meta, house, rooms, readings, payments };
}

// ── Sidebar ───────────────────────────────────────────────
async function renderSidebar() {
  const meta = await DriveStore.readMeta();
  const period = UI.period;
  const list = $('#house-list');
  const sharedEntries = await Sharing.getSharedHouses().catch(() => []);

  if (!meta.houses.length && !sharedEntries.length) {
    list.innerHTML = `<div class="mute" style="font-size:12px;padding:8px 4px">Chưa có nhà trọ nào.</div>`;
    return;
  }

  // ── Nhà do user quản lý ──
  const ownItems = await Promise.all(meta.houses.map(async h => {
    const rooms = await Store.getRooms(h.id);
    const readings = await Store.getMeterReadings(h.id);
    const payments = await Store.getPayments(h.id);
    const active = rooms.filter(r => r.active !== false);
    const unmetered = active.filter(r => !readings.some(m => m.roomId === r.id && m.period === period)).length;
    const unpaid = active.filter(r => {
      const p = payments.find(x => x.roomId === r.id && x.period === period);
      return !p || p.status === 'pending';
    }).length;
    return { h, unmetered, unpaid };
  }));

  // SVG icons
  const ICON_HOUSE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg>';
  const ICON_LINK  = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

  const ownHtml = ownItems.map(({ h, unmetered, unpaid }) => `
    <div class="house-item ${h.id === meta.activeHouseId ? 'active' : ''}" data-id="${h.id}" data-kind="own" title="Nhà trọ của bạn">
      <div class="h-icon">${ICON_HOUSE}</div>
      <div class="h-name">${escHtml(h.name)}</div>
      <div class="h-badges">
        ${unmetered > 0 ? `<span class="badge badge-warning" style="font-size:10px">${unmetered}⚡</span>` : ''}
        ${unpaid > 0 ? `<span class="badge badge-danger" style="font-size:10px">${unpaid}💰</span>` : ''}
      </div>
    </div>`).join('');

  const sharedHtml = sharedEntries.map(e => `
    <div class="house-item house-item-shared" data-id="${e.id}" data-kind="shared" title="Nhà trọ được chia sẻ · chỉ xem">
      <div class="h-icon" style="color:var(--brand-500)">${ICON_LINK}</div>
      <div class="h-name">${escHtml(e.houseName)}</div>
      <div class="h-badges">
        <span class="mute" style="font-size:10px">share</span>
      </div>
    </div>`).join('');

  list.innerHTML = `
    ${ownHtml}
    ${ownHtml && sharedHtml ? '<div class="sidebar-divider"></div>' : ''}
    ${sharedHtml}
  `;

  $$('.house-item', list).forEach(el => {
    el.addEventListener('click', async () => {
      const kind = el.dataset.kind;
      const id = el.dataset.id;
      if (kind === 'shared') {
        // Mở read-only view
        openSharedHouseView(id);
      } else {
        await Store.setActiveHouseId(id);
        renderAll();
      }
    });
  });
}

// ── Tab bar ───────────────────────────────────────────────
function tabBarHtml(active) {
  return `<div class="tabs">${[
    { id: 'rooms',   icon: '🏠', label: 'Phòng' },
    { id: 'meter',   icon: '⚡', label: 'Chốt điện' },
    { id: 'payment', icon: '💰', label: 'Thu tiền' },
    { id: 'settings',icon: '⚙️', label: 'Cài đặt' },
  ].map(t => `<button class="tab ${t.id === active ? 'active' : ''}" data-tab="${t.id}">${t.icon} ${t.label}</button>`).join('')}</div>`;
}
function bindTabs() {
  $$('.tab[data-tab]').forEach(b => b.onclick = () => { UI.tab = b.dataset.tab; renderMain(); });
}

// ── Period bar ────────────────────────────────────────────
function periodBarHtml(rooms, readings, payments) {
  const period = UI.period;
  const active = rooms.filter(r => r.active !== false);
  const allMetered = Store.isAllMetered(active, readings, period);
  const paidCount = active.filter(r => payments.find(p => p.roomId === r.id && p.period === period && p.status === 'paid')).length;
  return `
    <div class="period-bar">
      <div class="period-nav">
        <button class="btn-icon" data-period="prev"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg></button>
        <div class="period-display">${periodLabel(period)}</div>
        <button class="btn-icon" data-period="next"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg></button>
        <button class="btn-icon" data-period="today" title="Tháng hiện tại"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg></button>
      </div>
      <div class="period-summary">
        <div class="stat-pair">${allMetered ? '<span style="color:var(--success)">✓ Đã chốt điện</span>' : '<span style="color:var(--warning)">⚡ Chưa chốt điện</span>'}</div>
        <div class="stat-pair"><span>Đã thu</span><span class="num">${paidCount}/${active.length}</span></div>
      </div>
    </div>`;
}
function bindPeriodNav() {
  $$('[data-period]').forEach(b => b.onclick = () => {
    const v = b.dataset.period;
    UI.period = v === 'prev' ? shiftPeriod(UI.period, -1) : v === 'next' ? shiftPeriod(UI.period, 1) : currentPeriod();
    renderMain();
  });
}

// ── Main dispatch ─────────────────────────────────────────
async function renderMain() {
  const meta = await DriveStore.readMeta();
  const main = $('#main-content');
  const theme = await DriveStore.getTheme();
  applyTheme(theme);

  if (!meta.houses.length) {
    main.innerHTML = `
      <div class="empty" style="padding:96px 24px">
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg>
        <div class="empty-title">Chưa có nhà trọ nào</div>
        <div class="empty-desc mb-16">Tạo nhà trọ đầu tiên để bắt đầu quản lý.</div>
        <button class="btn btn-primary" id="empty-create">+ Tạo nhà trọ</button>
      </div>`;
    $('#empty-create').onclick = openCreateHouseModal;
    return;
  }

  const houseId = meta.activeHouseId || meta.houses[0].id;
  const data = await loadHouseData(houseId);

  // Prefetch ảnh đồng hồ của period hiện tại + 1 tháng trước
  // (chạy song song với render, không block)
  const prevPeriod = shiftPeriod(UI.period, -1);
  const fileIdsToPrefetch = data.readings
    .filter(r => r.period === UI.period || r.period === prevPeriod)
    .map(r => r.imageFileId)
    .filter(Boolean);
  prefetchImages(fileIdsToPrefetch);

  if (UI.tab === 'rooms')    await renderRoomsView(data);
  else if (UI.tab === 'meter')    await renderMeterView(data);
  else if (UI.tab === 'payment')  await renderPaymentView(data);
  else if (UI.tab === 'settings') await renderSettingsView(data);

  // Lazy-load mọi <img data-img-fileid> trong view vừa render
  hydrateImages();
}

// ════════════════════════════════════════════════════════
// VIEW: Rooms overview
// ════════════════════════════════════════════════════════
async function renderRoomsView({ house, rooms, readings, payments }) {
  const period = UI.period;
  const main = $('#main-content');

  // Luôn recalculate payment cho TẤT CẢ phòng active mỗi lần render.
  // QUAN TRỌNG: đọc lại readings và payments từ cache TRƯỚC KHI tính toán
  // để đảm bảo dùng meter mới nhất vừa chốt (không dùng snapshot cũ từ loadHouseData).
  const active = rooms.filter(r => r.active !== false);
  if (active.length > 0) {
    // Re-read từ _memCache (đã có meter mới từ saveMeterReading)
    const freshReadings = await Store.getMeterReadings(house.id);
    const freshPayments = await Store.getPayments(house.id);
    await Promise.all(
      active.map(r =>
        Store.getOrCreatePayment(house.id, r, period, house, freshReadings, freshPayments)
          .catch(() => null)
      )
    );
    // Reload sau khi update
    readings = freshReadings;
    payments = await Store.getPayments(house.id);
  }

  main.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">${escHtml(house.name)}</h1>
        <div class="page-sub">${rooms.length} phòng · ${fmtVND(house.config.electricityPrice)}/số điện · ${fmtVND(house.config.waterPricePerPerson)}/người nước</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-secondary" id="import-excel-btn" title="Import từ Excel">📂 Import Excel</button>
        <button class="btn btn-secondary" id="add-room-btn">+ Thêm phòng</button>
      </div>
    </div>
    ${tabBarHtml('rooms')}
    ${periodBarHtml(rooms, readings, payments)}
    ${rooms.length === 0 ? `
      <div class="empty card">
        <div class="empty-title">Chưa có phòng nào</div>
        <div class="empty-desc mb-16">Thêm phòng thủ công hoặc Import từ file Excel.</div>
        <div class="row gap-8">
          <button class="btn btn-primary" id="empty-add">+ Thêm phòng</button>
          <button class="btn btn-secondary" id="empty-import">📂 Import Excel</button>
        </div>
      </div>` : `
      <div class="rooms-grid">${rooms.map(r => roomCardHtml(house, r, readings, payments, period)).join('')}</div>`}`;

  bindTabs(); bindPeriodNav();
  $('#add-room-btn').onclick = () => openRoomModal(house.id);
  $('#import-excel-btn').onclick = () => openImportExcelModal(house.id);
  $('#empty-add')?.addEventListener('click', () => openRoomModal(house.id));
  $('#empty-import')?.addEventListener('click', () => openImportExcelModal(house.id));
  $$('.room-card[data-id]').forEach(card => {
    card.onclick = e => {
      if (e.target.closest('[data-room-action]')) return;
      openRoomDetailModal(house, card.dataset.id, readings, payments, period);
    };
  });
  $$('[data-room-action="edit"]').forEach(b =>
    b.onclick = e => { e.stopPropagation(); openRoomModal(house.id, b.dataset.id); });
}

function roomCardHtml(house, room, readings, payments, period) {
  const meter = Store.getMeterForPeriod(readings, room.id, period);
  const prevMeter = Store.getPrevMeter(readings, room, period);
  const payment = payments.find(p => p.roomId === room.id && p.period === period);
  const status = !room.active ? 'skipped' : (payment?.status || 'pending');
  const meterOk = !!meter;
  const consumed = meter && prevMeter ? Math.max(0, meter.reading - prevMeter.reading) : null;
  const amountToShow = status === 'paid' ? payment.amountPaid : (payment?.amountDue || 0);

  const statusInfo = {
    paid:    { label: 'Đã thu',     cls: 'badge-success' },
    pending: { label: 'Chưa thu',   cls: 'badge-warning' },
    skipped: { label: 'Phòng trống', cls: 'badge-muted' }
  }[status];

  return `
    <div class="room-card ${status === 'paid' ? 'is-paid' : ''} ${status === 'skipped' ? 'is-skipped' : ''}" data-id="${room.id}">
      <div class="room-head">
        <div>
          <div class="room-code">${escHtml(room.code)}</div>
          <div class="room-name">${escHtml(room.representative || 'Chưa có người')}</div>
        </div>
        <div class="row gap-4">
          <span class="badge ${statusInfo.cls}">${statusInfo.label}</span>
          <button class="btn-icon" data-room-action="edit" data-id="${room.id}" title="Sửa phòng">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
        </div>
      </div>
      <div class="room-meta">
        <div class="meta-item"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg> ${room.occupants} người</div>
        <div class="meta-item" style="color:${meterOk ? 'var(--success)' : room.active !== false ? 'var(--warning)' : 'var(--text-mute)'}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
          ${meterOk ? `${meter.reading} số${consumed !== null ? ` (+${consumed})` : ''}` : room.active !== false ? 'Chưa chốt' : '—'}
        </div>
      </div>
      <div class="room-amount">
        <span class="room-amount-label">${status === 'skipped' ? '—' : status === 'paid' ? 'Đã thu' : 'Cần thu'}</span>
        <span class="room-amount-value">${status === 'skipped' ? '—' : fmtVND(amountToShow)}</span>
      </div>
    </div>`;
}

// Room detail modal
async function openRoomDetailModal(house, roomId, readings, payments, period) {
  const room = await Store.getRoom(roomId);
  if (!room || !room.active) { toast('Phòng trống', ''); return; }

  const p = await Store.getOrCreatePayment(house.id, room, period, house, readings, payments);
  const meter = Store.getMeterForPeriod(readings, room.id, period);
  const prevMeter = Store.getPrevMeter(readings, room, period);
  const consumed = meter && prevMeter ? Math.max(0, meter.reading - prevMeter.reading) : null;

  openModal({
    title: `Chi tiết · ${roomTitle(room)} · ${periodLabel(period)}`,
    body: `
      <div class="detail-grid">
        <div class="detail-section">
          <div class="detail-section-title">⚡ Điện</div>
          ${prevMeter ? `<div class="detail-row"><span>Tháng trước${prevMeter.synthetic ? ' (khởi đầu)' : ' (' + displayPeriod(prevMeter.period) + ')'}</span><span class="num">${prevMeter.reading}</span></div>` : `<div class="detail-row muted"><span>Tháng trước</span><span>—</span></div>`}
          ${meter ? `
            <div class="detail-row"><span>Tháng này</span><span class="num">${meter.reading}</span></div>
            <div class="detail-row"><span>Tiêu thụ</span><span class="num">${consumed ?? '?'} số</span></div>
            <div class="detail-row"><span>Tiền điện</span><span class="num">${fmtVND(p.electricity)}</span></div>
            ${meter.imageFileId ? `<div class="mt-8"><img data-img-fileid="${escHtml(meter.imageFileId)}" data-img-lightbox-from-fileid alt="Ảnh đồng hồ" style="width:100%;max-height:120px;object-fit:contain;border-radius:var(--radius);border:1px solid var(--border);cursor:zoom-in;background:var(--muted-bg)"/>
              ${meter.imageUrl ? `<a class="btn btn-secondary btn-sm mt-4" href="${escHtml(meter.imageUrl)}" target="_blank" rel="noopener">Xem ảnh gốc</a>` : ''}</div>` : ''}
          ` : `<div class="detail-row" style="color:var(--warning)"><span>Tháng này</span><span>⚠ Chưa chốt điện</span></div>`}
        </div>
        <div class="detail-section">
          <div class="detail-section-title">💰 Thanh toán</div>
          <div class="detail-row"><span>Tiền phòng</span><span class="num">${fmtVND(p.rent)}</span></div>
          <div class="detail-row"><span>Tiền nước (${room.occupants} người × ${fmtVND(house.config.waterPricePerPerson)})</span><span class="num">${fmtVND(p.water)}</span></div>
          <div class="detail-row"><span>Tiền điện</span><span class="num">${fmtVND(p.electricity)}</span></div>
          ${p.extraFee ? `<div class="detail-row"><span>Phụ phí${p.extraNote ? ' (' + escHtml(p.extraNote) + ')' : ''}</span><span class="num">${fmtVND(p.extraFee)}</span></div>` : ''}
          ${p.previousBalance !== 0 ? `<div class="detail-row" style="color:var(--${p.previousBalance > 0 ? 'success' : 'danger'})">
            <span>${p.previousBalance > 0 ? 'Dư trước' : 'Thiếu trước'}</span>
            <span class="num">${p.previousBalance > 0 ? '−' : '+'}${fmtVND(Math.abs(p.previousBalance))}</span></div>` : ''}
          <div class="detail-row" style="font-weight:600;border-top:1px solid var(--border);padding-top:10px;margin-top:6px">
            <span>Cần thu</span><span class="num" style="font-size:16px">${fmtVND(p.amountDue)}</span></div>
          <div class="detail-row mt-8"><span>Trạng thái</span>
            <span class="badge ${p.status === 'paid' ? 'badge-success' : 'badge-warning'}">${p.status === 'paid' ? `✓ Đã thu · ${new Date(p.paidAt).toLocaleDateString('vi-VN')}` : 'Chưa thu'}</span></div>
        </div>
      </div>`,
    footer: `<button class="btn btn-secondary" data-act="close">Đóng</button>
             ${!meter ? `<button class="btn btn-secondary" data-act="goto-meter">Đi chốt điện ⚡</button>` : ''}
             ${meter && p.status === 'pending' ? `<button class="btn btn-primary" data-act="goto-pay">Đi thu tiền 💰</button>` : ''}`,
    onAction(act, close) {
      close();
      if (act === 'goto-meter') { UI.tab = 'meter'; renderMain(); }
      if (act === 'goto-pay')   { UI.tab = 'payment'; renderMain(); }
    }
  });
}

// ════════════════════════════════════════════════════════
// VIEW: Chốt điện
// ════════════════════════════════════════════════════════
async function renderMeterView({ house, rooms, readings, payments }) {
  const period = UI.period;
  const main = $('#main-content');
  const active = rooms.filter(r => r.active !== false);
  const allDone = Store.isAllMetered(active, readings, period);

  main.innerHTML = `
    <div class="page-header">
      <div><h1 class="page-title">⚡ Chốt điện</h1>
        <div class="page-sub">${periodLabel(period)} · ${escHtml(house.name)}</div></div>
    </div>
    ${tabBarHtml('meter')}
    ${periodBarHtml(rooms, readings, payments)}
    ${allDone ? `<div class="success-banner">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>
      Đã chốt điện đầy đủ ${active.length} phòng!
      <button class="btn btn-secondary btn-sm" style="margin-left:12px" data-tab="payment">Đi thu tiền →</button></div>` : ''}
    <div class="meter-rooms-list">
      ${active.length === 0 ? '<div class="empty card"><div class="empty-desc">Không có phòng nào đang hoạt động.</div></div>'
        : active.map(r => meterRoomRowHtml(r, readings, period)).join('')}
    </div>`;

  bindTabs(); bindPeriodNav();
  $$('[data-tab="payment"]').forEach(b => b.onclick = () => { UI.tab = 'payment'; renderMain(); });
  $$('.meter-room-row').forEach(row => {
    const roomId = row.dataset.id;
    row.querySelector('.btn-meter-action')?.addEventListener('click', async () => {
      const room = await Store.getRoom(roomId);
      openMeterRecordModal(house, room, readings, period);
    });
  });
}

function meterRoomRowHtml(room, readings, period) {
  const meter = Store.getMeterForPeriod(readings, room.id, period);
  const prevMeter = Store.getPrevMeter(readings, room, period);
  const consumed = meter && prevMeter ? Math.max(0, meter.reading - prevMeter.reading) : null;
  const done = !!meter;
  return `
    <div class="meter-room-row ${done ? 'is-done' : ''}" data-id="${room.id}">
      <div class="meter-room-left">
        <div class="meter-room-status ${done ? 'status-done' : 'status-pending'}">
          ${done
            ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>`
            : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>`}
        </div>
        <div>
          <div class="meter-room-code">${escHtml(room.code)}</div>
          <div class="meter-room-rep">${escHtml(room.representative || '—')}</div>
        </div>
      </div>
      <div class="meter-room-reading">
        ${prevMeter ? `<div class="meter-prev">Tháng trước: <span class="num">${prevMeter.reading}</span></div>` : `<div class="meter-prev mute">Không có dữ liệu trước</div>`}
        ${done ? `<div class="meter-cur">Tháng này: <strong class="num">${meter.reading}</strong>${consumed !== null ? ` <span class="mute">(+${consumed} số)</span>` : ''}</div>
          ${meter.imageFileId ? `<img class="meter-thumb" data-img-fileid="${escHtml(meter.imageFileId)}" data-img-lightbox-from-fileid alt="Ảnh đồng hồ"/>` : ''}` : `<div class="meter-cur mute">Chưa chốt</div>`}
      </div>
      <button class="btn ${done ? 'btn-secondary' : 'btn-primary'} btn-sm btn-meter-action">
        ${done ? '✏ Sửa' : '📷 Chốt điện'}
      </button>
    </div>`;
}

async function openMeterRecordModal(house, room, allReadings, period) {
  const existing = Store.getMeterForPeriod(allReadings, room.id, period);
  const prevMeter = Store.getPrevMeter(allReadings, room, period);
  const geminiKey = await DriveStore.getGeminiKey();
  let uploadedImage = null;

  const modal = openModal({
    title: `Chốt điện · ${escHtml(room.code)} · ${periodLabel(period)}`,
    lg: true,
    body: `
      <div class="row gap-12 mb-16" style="flex-wrap:wrap">
        <div class="info-chip"><div class="info-chip-label">Phòng</div><div class="info-chip-value">${escHtml(room.code)} · ${escHtml(room.representative || '—')}</div></div>
        <div class="info-chip"><div class="info-chip-label">Chỉ số tháng trước</div><div class="info-chip-value num">${prevMeter ? prevMeter.reading : '<span class="mute">Chưa có</span>'}</div></div>
        ${existing ? `<div class="info-chip info-chip-done"><div class="info-chip-label">Đã chốt</div><div class="info-chip-value num">${existing.reading}</div></div>` : ''}
      </div>
      <div class="ocr-zone" id="ocr-zone">
        <div id="ocr-upload-area">
          <input type="file" id="meter-file" accept="image/*" capture="environment" style="display:none"/>
          <button type="button" class="meter-dropzone" id="meter-dropzone-btn">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
            <div><div class="meter-dropzone-title">Chụp / chọn ảnh đồng hồ điện</div>
              <div class="meter-dropzone-desc">Mobile: mở camera trực tiếp · jpg/png · max 8MB</div></div>
          </button>
        </div>
        <div id="ocr-preview" style="display:none">
          <div class="ocr-img-wrapper" id="ocr-img-wrapper">
            <img id="ocr-img" src="" alt="Ảnh đồng hồ điện" referrerpolicy="no-referrer"/>
          </div>
          <div class="ocr-zoom-bar">
            <button class="ocr-zoom-btn" id="btn-zoom-out" title="Thu nhỏ">−</button>
            <span class="ocr-zoom-level" id="zoom-level">100%</span>
            <button class="ocr-zoom-btn" id="btn-zoom-in" title="Phóng to">+</button>
            <button class="ocr-zoom-reset" id="btn-zoom-reset">↺ Đặt lại</button>
          </div>
          <div class="ocr-actions">
            <button class="btn btn-secondary btn-sm" id="btn-retake">📷 Chụp lại</button>
            <span class="ocr-hint">🖱 Cuộn zoom · Kéo pan</span>
          </div>
        </div>
        <div class="ocr-result" id="ocr-result" style="display:none">
          <div class="ocr-result-inner">
            <div class="ocr-result-label">🔍 OCR đọc được:</div>
            <div class="ocr-result-value" id="ocr-value">—</div>
            <div class="ocr-result-meta" id="ocr-meta"></div>
          </div>
        </div>
      </div>
      <div class="form-row mt-16">
        <label class="label">Chỉ số điện tháng này *
          ${geminiKey ? '<span style="color:var(--success)">✓ Gemini OCR</span>' : '<span class="mute">(Tesseract OCR — Gemini chính xác hơn nhưng cần admin cấu hình key)</span>'}
        </label>
        <input type="number" class="input input-mono" id="meter-reading" style="font-size:18px;height:48px"
          value="${existing ? existing.reading : ''}" placeholder="Nhập số hoặc để OCR tự điền…"/>
        ${prevMeter ? `<div class="hint">Phải ≥ ${prevMeter.reading} (chỉ số tháng trước)</div>` : ''}
      </div>
      <div id="meter-status" style="min-height:20px;font-size:12px;color:var(--text-mute)"></div>`,
    footer: `
      ${existing ? `<button class="btn btn-secondary" data-act="delete" style="margin-right:auto;color:var(--danger)">Xóa chỉ số</button>` : ''}
      <button class="btn btn-secondary" data-act="close">Hủy</button>
      <button class="btn btn-primary" data-act="save">💾 Lưu chỉ số</button>`,
    onAction: async (act, close, root) => {
      if (act === 'close') return close();
      if (act === 'delete') {
        if (!await confirmDialog('Xóa chỉ số', `Xóa chỉ số điện ${periodLabel(period).toLowerCase()} của phòng ${room.code}?`, { ok: 'Xóa', danger: true })) return;
        if (existing?.imageFileId) await DriveStore.deleteFile(existing.imageFileId).catch(() => {});
        await Store.deleteMeterReading(room.id, period);
        toast('Đã xóa chỉ số', 'success');
        close(); triggerBadge(); renderAll();
        return;
      }
      if (act === 'save') {
        const readingVal = Number($('#meter-reading', root).value);
        if (!readingVal || readingVal <= 0) return toast('Vui lòng nhập chỉ số điện', 'danger');
        if (prevMeter && readingVal < prevMeter.reading)
          return toast(`Chỉ số phải ≥ ${prevMeter.reading} (tháng trước)`, 'danger');

        const saveBtn = root.querySelector('[data-act="save"]');
        const statusEl = $('#meter-status', root);
        setLoading(saveBtn, true, 'Lưu chỉ số');

        try {
          let imageInfo = {};
          if (uploadedImage?.blob && !uploadedImage.fileId) {
            statusEl.textContent = '⬆ Đang tải ảnh lên Drive (rent-mng-datastorage)...';
            const ext = uploadedImage.blob.type.includes('png') ? 'png' : 'jpg';
            const fname = `meter_${room.code}_${period}_${Date.now()}.${ext}`;
            const result = await DriveStore.uploadMeterImage(house.name, uploadedImage.blob, fname);
            imageInfo = { fileId: result.id, url: result.webViewLink || '' };
          } else if (existing?.imageFileId) {
            imageInfo = { fileId: existing.imageFileId, url: existing.imageUrl };
          }
          statusEl.textContent = '💾 Đang lưu vào Drive (meter-readings.json)...';
          await Store.saveMeterReading(house.id, room.id, period, readingVal, imageInfo);
          toast(`✅ Đã chốt điện phòng ${room.code}: ${readingVal}`, 'success');
          close(); triggerBadge(); renderAll();
        } catch (e) {
          toast('Lưu thất bại: ' + e.message, 'danger');
          setLoading(saveBtn, false, '💾 Lưu chỉ số');
        }
      }
    }
  });

  // OCR wiring
  const fileInput     = $('#meter-file', modal.root);
  const dropBtn       = $('#meter-dropzone-btn', modal.root);
  const retakeBtn     = $('#btn-retake', modal.root);
  const ocrPreview    = $('#ocr-preview', modal.root);
  const ocrUploadArea = $('#ocr-upload-area', modal.root);
  const ocrResultEl   = $('#ocr-result', modal.root);
  const ocrValueEl    = $('#ocr-value', modal.root);
  const ocrMetaEl     = $('#ocr-meta', modal.root);
  const readingInput  = $('#meter-reading', modal.root);
  const statusEl      = $('#meter-status', modal.root);
  const imgContainer  = $('#ocr-img-wrapper', modal.root);
  const ocrImgEl      = $('#ocr-img', modal.root);
  const zoomLevelEl   = $('#zoom-level', modal.root);

  // ── Zoom & Pan state ──────────────────────────────────
  let _scale = 1, _tx = 0, _ty = 0;
  let _dragging = false, _lastX = 0, _lastY = 0;

  function applyTransform() {
    ocrImgEl.style.transform = `scale(${_scale}) translate(${_tx}px, ${_ty}px)`;
    if (zoomLevelEl) zoomLevelEl.textContent = Math.round(_scale * 100) + '%';
  }

  function resetZoom() {
    _scale = 1; _tx = 0; _ty = 0;
    applyTransform();
  }

  function changeZoom(delta) {
    _scale = Math.min(8, Math.max(0.5, _scale + delta));
    if (_scale <= 1) { _tx = 0; _ty = 0; }
    applyTransform();
  }

  // Zoom buttons
  $('#btn-zoom-in', modal.root)?.addEventListener('click', () => changeZoom(0.5));
  $('#btn-zoom-out', modal.root)?.addEventListener('click', () => changeZoom(-0.5));
  $('#btn-zoom-reset', modal.root)?.addEventListener('click', resetZoom);

  // Scroll to zoom
  imgContainer?.addEventListener('wheel', e => {
    e.preventDefault();
    changeZoom(e.deltaY < 0 ? 0.25 : -0.25);
  }, { passive: false });

  // Drag to pan
  imgContainer?.addEventListener('mousedown', e => {
    if (_scale <= 1) return;
    _dragging = true; _lastX = e.clientX; _lastY = e.clientY;
    imgContainer.classList.add('is-dragging');
  });
  window.addEventListener('mousemove', e => {
    if (!_dragging) return;
    _tx += (e.clientX - _lastX) / _scale;
    _ty += (e.clientY - _lastY) / _scale;
    _lastX = e.clientX; _lastY = e.clientY;
    applyTransform();
  });
  window.addEventListener('mouseup', () => {
    _dragging = false;
    imgContainer?.classList.remove('is-dragging');
  });

  // Touch pinch-to-zoom
  let _lastDist = 0;
  imgContainer?.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      _lastDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }
  }, { passive: true });
  imgContainer?.addEventListener('touchmove', e => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      if (_lastDist > 0) changeZoom((dist - _lastDist) * 0.01);
      _lastDist = dist;
    }
  }, { passive: false });

  // Revoke blob URL cũ khi không cần nữa
  let _currentBlobUrl = null;
  function revokeCurrent() {
    if (_currentBlobUrl && _currentBlobUrl.startsWith('blob:')) {
      URL.revokeObjectURL(_currentBlobUrl);
      _currentBlobUrl = null;
    }
  }

  function showImage(src) {
    revokeCurrent();
    _currentBlobUrl = src.startsWith('blob:') ? src : null;
    ocrImgEl.src = '';            // reset trước để force reload
    ocrImgEl.style.opacity = '0';
    resetZoom();
    ocrUploadArea.style.display = 'none';
    ocrPreview.style.display = 'flex';
    // Fade in ảnh khi đã load xong
    ocrImgEl.onload = () => {
      ocrImgEl.style.transition = 'opacity 0.25s ease';
      ocrImgEl.style.opacity = '1';
    };
    ocrImgEl.onerror = () => {
      ocrImgEl.style.opacity = '1';
      statusEl.textContent = '⚠ Không tải được ảnh. Thử chụp lại.';
    };
    ocrImgEl.src = src;
  }

  function showOcrLoading() {
    ocrResultEl.style.display = 'flex';
    ocrValueEl.innerHTML = `
      <div class="ocr-scanning">
        <div class="ocr-scan-bar"></div>
        <div class="ocr-scan-dots">
          <span></span><span></span><span></span>
        </div>
        <div class="ocr-scan-label">Đang nhận dạng số điện…</div>
      </div>`;
    ocrMetaEl.textContent = '';
  }

  function showOcrResult(result) {
    ocrResultEl.style.display = 'flex';
    if (result.reading !== null) {
      ocrValueEl.innerHTML = `
        <div class="ocr-found">
          <div class="ocr-found-number">${result.reading}</div>
          <div class="ocr-found-meta">
            ${result.source === 'gemini' ? '✨ Gemini AI' : '🔍 Tesseract'} · 
            Tin cậy ${Math.round((result.confidence || 0) * 100)}%
          </div>
        </div>`;
    } else {
      ocrValueEl.innerHTML = `
        <div class="ocr-fail">
          <div class="ocr-fail-icon">🔎</div>
          <div class="ocr-fail-msg">Không đọc được số</div>
          <div class="ocr-fail-hint">Ảnh mờ hoặc góc chụp không rõ</div>
        </div>`;
    }
    ocrMetaEl.textContent = '';
  }

  async function handleFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('Tệp phải là ảnh', 'danger'); return; }
    if (file.size > 8 * 1024 * 1024) { toast('Ảnh quá lớn (>8MB)', 'danger'); return; }

    const url = URL.createObjectURL(file);
    showImage(url);
    showOcrLoading();
    statusEl.textContent = '';
    uploadedImage = { blob: file, fileId: '', url: '', thumbnail: '' };

    try {
      const result = await ocrMeterImage(file, geminiKey);
      showOcrResult(result);
      if (result.reading !== null) {
        if ((result.confidence || 0) >= 0.6) {
          readingInput.value = result.reading;
          readingInput.style.borderColor = 'var(--success)';
          statusEl.textContent = '✅ Đã điền tự động từ OCR. Kiểm tra lại nếu cần.';
        } else {
          readingInput.style.borderColor = 'var(--warning)';
          statusEl.textContent = `⚠ Tin cậy thấp (${Math.round((result.confidence||0)*100)}%). Vui lòng xác nhận lại.`;
        }
      } else {
        statusEl.textContent = '❌ Nhập tay số điện vào ô bên dưới.';
      }
    } catch (e) {
      ocrValueEl.innerHTML = `<div class="ocr-fail"><div class="ocr-fail-icon">⚠</div><div class="ocr-fail-msg">${escHtml(e.message)}</div></div>`;
      statusEl.textContent = '';
    }
  }

  dropBtn.onclick = () => fileInput.click();
  fileInput.onchange = e => handleFile(e.target.files?.[0]);
  retakeBtn.onclick = () => {
    ocrUploadArea.style.display = 'block';
    ocrPreview.style.display = 'none';
    ocrResultEl.style.display = 'none';
    statusEl.textContent = '';
    fileInput.value = '';
    uploadedImage = null;
    resetZoom();
  };

  const dz = $('#ocr-zone', modal.root);
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.style.borderColor = 'var(--text)'; });
  dz.addEventListener('dragleave', () => { dz.style.borderColor = ''; });
  dz.addEventListener('drop', e => { e.preventDefault(); dz.style.borderColor = ''; handleFile(e.dataTransfer.files?.[0]); });

  if (existing?.imageFileId) {
    uploadedImage = { blob: null, fileId: existing.imageFileId, url: existing.imageUrl };
    ocrResultEl.style.display = 'none';
    statusEl.textContent = '⏳ Đang tải ảnh từ Drive...';
    ocrUploadArea.style.display = 'none';
    ocrPreview.style.display = 'flex';
    ocrImgEl.style.opacity = '0.3';

    getImageUrl(existing.imageFileId).then(url => {
      showImage(url);
      statusEl.textContent = 'Đã có ảnh từ lần chốt trước. Chụp lại nếu muốn thay.';
    }).catch(e => {
      console.warn('[meter modal] Failed to load image:', e.message);
      statusEl.textContent = '⚠ Không tải được ảnh. Chụp lại để cập nhật.';
      ocrImgEl.style.opacity = '1';
      ocrUploadArea.style.display = 'block';
      ocrPreview.style.display = 'none';
    });
  }
}

// ════════════════════════════════════════════════════════
// VIEW: Thu tiền
// ════════════════════════════════════════════════════════
async function renderPaymentView({ house, rooms, readings, payments }) {
  const period = UI.period;
  const main = $('#main-content');
  const active = rooms.filter(r => r.active !== false);
  const allMetered = Store.isAllMetered(active, readings, period);

  // Ensure payment records exist in parallel (write-through to Drive)
  await Promise.all(active.map(r =>
    Store.getOrCreatePayment(house.id, r, period, house, readings, payments).catch(() => null)
  ));
  // Re-read after mutations
  const freshPayments = await Store.getPayments(house.id);

  let totalDue = 0, totalPaid = 0, paidCount = 0, pendingCount = 0;
  for (const r of active) {
    const p = freshPayments.find(x => x.roomId === r.id && x.period === period);
    if (!p) continue;
    if (p.status === 'paid') { totalPaid += p.amountPaid; paidCount++; }
    else { totalDue += p.amountDue; pendingCount++; }
  }

  main.innerHTML = `
    <div class="page-header">
      <div><h1 class="page-title">💰 Thu tiền</h1>
        <div class="page-sub">${periodLabel(period)} · ${escHtml(house.name)}</div></div>
    </div>
    ${tabBarHtml('payment')}
    ${periodBarHtml(rooms, readings, freshPayments)}
    ${!allMetered ? `<div class="warn-banner">⚡ Một số phòng chưa chốt điện — tiền điện chưa tính.
      <button class="btn btn-secondary btn-sm" style="margin-left:12px" id="goto-meter-btn">Đi chốt điện →</button></div>` : ''}
    <div class="pay-summary-bar">
      <div class="pay-stat"><div class="pay-stat-val">${fmtVND(totalPaid)}</div><div class="pay-stat-lbl">Đã thu</div></div>
      <div class="pay-stat"><div class="pay-stat-val" style="color:var(--warning)">${fmtVND(totalDue)}</div><div class="pay-stat-lbl">Còn lại</div></div>
      <div class="pay-stat"><div class="pay-stat-val">${paidCount}</div><div class="pay-stat-lbl">Phòng đã thu</div></div>
      <div class="pay-stat"><div class="pay-stat-val" style="color:var(--warning)">${pendingCount}</div><div class="pay-stat-lbl">Phòng chờ</div></div>
    </div>
    <div class="payment-list">
      ${active.map(r => paymentRowHtml(house, r, readings, freshPayments, period)).join('')}
      ${rooms.filter(r => r.active === false).map(r => `
        <div class="payment-row is-skipped">
          <div class="pr-room"><span class="room-code">${escHtml(r.code)}</span></div>
          <div class="pr-name mute">${escHtml(r.representative || 'Phòng trống')}</div>
          <div></div><div></div>
          <span class="badge badge-muted">Phòng trống</span><div></div>
        </div>`).join('')}
    </div>`;

  bindTabs(); bindPeriodNav();
  $('#goto-meter-btn')?.addEventListener('click', () => { UI.tab = 'meter'; renderMain(); });

  $$('.payment-row.clickable').forEach(row => {
    // Click vào row (không phải button) → mở chi tiết
    row.onclick = e => {
      if (e.target.closest('button')) return;
      openPaymentDetailModal(house, row.dataset.id, readings, freshPayments, period);
    };
  });
  // Nút "Chi tiết" — phải wire riêng vì row.onclick bị cancel khi click button
  $$('.btn-detail').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const row = btn.closest('.payment-row');
      if (row) openPaymentDetailModal(house, row.dataset.id, readings, freshPayments, period);
    };
  });
  $$('.btn-quick-paid').forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation();
      const room = await Store.getRoom(btn.dataset.roomId);
      if (!await confirmDialog('Xác nhận đã thu', `Đánh dấu phòng ${room.code} đã nộp tiền?`, { ok: 'Đã thu' })) return;
      await Store.confirmPayment(btn.dataset.paymentId);
      toast('✅ Đã ghi nhận thu tiền', 'success');
      triggerBadge(); renderAll();
    };
  });
}

function paymentRowHtml(house, room, readings, payments, period) {
  const p = payments.find(x => x.roomId === room.id && x.period === period);
  if (!p) return '';
  const meter = Store.getMeterForPeriod(readings, room.id, period);
  const prevMeter = Store.getPrevMeter(readings, room, period);
  const consumed = meter && prevMeter ? Math.max(0, meter.reading - prevMeter.reading) : null;

  return `
    <div class="payment-row clickable ${p.status === 'paid' ? 'is-paid' : ''}" data-id="${room.id}">
      <div class="pr-room"><span class="room-code">${escHtml(room.code)}</span></div>
      <div class="pr-name">${escHtml(room.representative || '—')}</div>
      <div class="pr-breakdown">
        <div class="pr-line"><span class="mute">Phòng</span><span class="num">${fmtVND(p.rent)}</span></div>
        <div class="pr-line"><span class="mute">Điện ${consumed !== null ? `(${consumed}×${fmtVND(house.config.electricityPrice)})` : '—'}</span><span class="num">${fmtVND(p.electricity)}</span></div>
        <div class="pr-line"><span class="mute">Nước (${room.occupants}×${fmtVND(house.config.waterPricePerPerson)})</span><span class="num">${fmtVND(p.water)}</span></div>
      </div>
      <div class="pr-total">
        <div class="pr-total-val ${p.status === 'paid' ? 'paid-color' : ''}">${fmtVND(p.status === 'paid' ? p.amountPaid : p.amountDue)}</div>
        <div class="pr-total-lbl">${p.status === 'paid' ? 'Đã thu' : 'Cần thu'}</div>
      </div>
      <div class="pr-status"><span class="badge ${p.status === 'paid' ? 'badge-success' : 'badge-warning'}">${p.status === 'paid' ? '✓ Đã thu' : 'Chờ'}</span></div>
      <div class="pr-actions">
        <button class="btn btn-secondary btn-sm btn-detail" style="min-width:68px">Chi tiết</button>
        ${p.status !== 'paid' ? `<button class="btn btn-primary btn-sm btn-quick-paid" data-payment-id="${p.id}" data-room-id="${room.id}">✓ Thu</button>` : ''}
      </div>
    </div>`;
}

async function openPaymentDetailModal(house, roomId, readings, payments, period) {
  const room = await Store.getRoom(roomId);
  let p = payments.find(x => x.roomId === room.id && x.period === period);
  if (!p) { p = await Store.getOrCreatePayment(house.id, room, period, house, readings, payments); }
  const isPaid = p.status === 'paid';
  const meter = Store.getMeterForPeriod(readings, room.id, period);
  const prevMeter = Store.getPrevMeter(readings, room, period);
  const consumed = meter && prevMeter ? Math.max(0, meter.reading - prevMeter.reading) : null;

  const modal = openModal({
    title: `Thanh toán · ${escHtml(room.code)} · ${periodLabel(period)}`,
    lg: true,
    body: `
      <div class="mb-12">
        <span class="badge ${isPaid ? 'badge-success' : 'badge-warning'}">${isPaid ? `✓ Đã thu · ${new Date(p.paidAt).toLocaleDateString('vi-VN')}` : 'Chưa thu'}</span>
      </div>
      <div class="detail-grid">
        <div class="detail-section">
          <div class="detail-section-title">Cơ cấu tiền</div>
          <div class="detail-row"><span>Tiền phòng</span>
            <input type="number" class="input input-mono input-sm" id="d-rent" value="${p.rent}" ${isPaid ? 'disabled' : ''}/></div>
          <div class="detail-row"><span>Tiền điện
            <small class="mute">${consumed !== null ? `${prevMeter?.reading ?? '?'} → ${meter?.reading ?? '?'} = ${consumed} số` : 'chưa chốt'}</small></span>
            <input type="number" class="input input-mono input-sm" id="d-elec" value="${p.electricity}" ${isPaid ? 'disabled' : ''}/></div>
          <div class="detail-row"><span>Tiền nước <small class="mute">(${room.occupants} người)</small></span>
            <input type="number" class="input input-mono input-sm" id="d-water" value="${p.water}" ${isPaid ? 'disabled' : ''}/></div>
          <div class="detail-row"><span>Phụ phí</span>
            <input type="number" class="input input-mono input-sm" id="d-extra" value="${p.extraFee}" ${isPaid ? 'disabled' : ''}/></div>
          <div class="detail-row">
            <input type="text" class="input input-sm grow" id="d-extra-note" value="${escHtml(p.extraNote)}" placeholder="Ghi chú phụ phí" ${isPaid ? 'disabled' : ''} style="max-width:200px"/></div>
          <div class="detail-row"><span>Giảm trừ</span>
            <input type="number" class="input input-mono input-sm" id="d-discount" value="${p.discount}" ${isPaid ? 'disabled' : ''}/></div>
          <div class="detail-row ${p.previousBalance !== 0 ? (p.previousBalance > 0 ? 'ok-row' : 'warn-row') : ''}">
            <span>${p.previousBalance >= 0 ? 'Dư tháng trước' : 'Thiếu tháng trước'}</span>
            <input type="number" class="input input-mono input-sm" id="d-prev" value="${p.previousBalance}" ${isPaid ? 'disabled' : ''}/></div>
        </div>
        <div class="detail-section">
          <div class="detail-section-title">Tổng hợp</div>
          <div class="pay-summary" id="pay-summary">
            <div class="pay-summary-row"><span>Tiền phòng</span><span class="num" data-s="rent">${fmtVND(p.rent)}</span></div>
            <div class="pay-summary-row"><span>Tiền điện${consumed !== null ? ` (${consumed} số)` : ''}</span><span class="num" data-s="elec">${fmtVND(p.electricity)}</span></div>
            <div class="pay-summary-row"><span>Tiền nước (${room.occupants} ng)</span><span class="num" data-s="water">${fmtVND(p.water)}</span></div>
            <div class="pay-summary-row"><span>Phụ phí</span><span class="num" data-s="extra">${fmtVND(p.extraFee)}</span></div>
            <div class="pay-summary-row ${p.previousBalance > 0 ? 'discount-row' : p.previousBalance < 0 ? 'debt-row' : ''}">
              <span>${p.previousBalance >= 0 ? 'Dư trước' : 'Thiếu trước'}</span>
              <span class="num" data-s="prev">${(p.previousBalance >= 0 ? '−' : '+') + fmtVND(Math.abs(p.previousBalance))}</span></div>
            <div class="pay-summary-row discount-row"><span>Giảm trừ</span><span class="num" data-s="disc">−${fmtVND(p.discount)}</span></div>
            <div class="pay-summary-row due-row"><span>Cần thu</span><span class="num" data-s="due">${fmtVND(p.amountDue)}</span></div>
          </div>
          <div class="form-row mt-16">
            <label class="label">Số tiền thực thu</label>
            <input type="number" class="input input-mono" id="d-paid" value="${p.amountPaid}" ${isPaid ? 'disabled' : ''} style="font-size:16px;height:44px"/>
            <div class="hint">Mặc định = cần thu. Sửa nếu khác.</div>
          </div>
          ${meter?.imageFileId ? `<div class="mt-12">
            <div class="detail-section-title mb-8">Ảnh đồng hồ điện</div>
            <img data-img-fileid="${escHtml(meter.imageFileId)}" data-img-lightbox-from-fileid alt="Ảnh đồng hồ" style="width:100%;max-width:180px;border-radius:var(--radius);border:1px solid var(--border);cursor:zoom-in;background:var(--muted-bg)"/>
            ${meter.imageUrl ? `<br><a class="btn btn-secondary btn-sm mt-8" href="${escHtml(meter.imageUrl)}" target="_blank" rel="noopener">Xem ảnh gốc</a>` : ''}</div>` : ''}
        </div>
      </div>`,
    footer: `
      ${isPaid ? `<button class="btn btn-secondary" data-act="unpay" style="margin-right:auto">↩ Hủy đã thu</button>` : `<button class="btn btn-secondary" data-act="history" style="margin-right:auto">📋 Lịch sử</button>`}
      <button class="btn btn-secondary" data-act="close">Đóng</button>
      ${!isPaid ? `<button class="btn btn-secondary" data-act="save">💾 Lưu</button>
                   <button class="btn btn-primary" data-act="confirm">✓ Xác nhận đã thu</button>` : ''}`,
    onAction: async (act, close, root) => {
      if (act === 'close') return close();
      if (act === 'history') { close(); await openHistoryModal(room); return; }
      if (act === 'unpay') {
        if (!await confirmDialog('Hủy đã thu', 'Khoản này sẽ trở về trạng thái chờ thu.')) return;
        await Store.unconfirmPayment(p.id);
        toast('Đã hủy', 'success'); close(); triggerBadge(); renderAll(); return;
      }
      const patch = collectPatch(root);
      await Store.updatePayment(p.id, patch);
      if (act === 'save') { toast('✅ Đã lưu vào Drive', 'success'); close(); renderAll(); return; }
      if (act === 'confirm') {
        if (!await confirmDialog('Xác nhận đã thu', `Ghi nhận đã thu tiền phòng ${room.code}?`, { ok: 'Xác nhận' })) return;
        await Store.confirmPayment(p.id);
        toast('✅ Đã ghi nhận thu tiền', 'success');
        close(); triggerBadge(); renderAll();
      }
    }
  });

  if (!isPaid) {
    ['d-rent','d-elec','d-water','d-extra','d-discount','d-prev'].forEach(id => {
      $('#' + id, modal.root)?.addEventListener('input', () => {
        const patch = collectPatch(modal.root);
        const fakeP = { ...p, ...patch };
        fakeP.amountDue = Store.calcAmountDue(fakeP);
        const sum = $('#pay-summary', modal.root);
        if (!sum) return;
        ['rent','elec','water','extra'].forEach(k => {
          const el = sum.querySelector(`[data-s="${k}"]`);
          const val = k === 'rent' ? fakeP.rent : k === 'elec' ? fakeP.electricity : k === 'water' ? fakeP.water : fakeP.extraFee;
          if (el) el.textContent = fmtVND(val);
        });
        sum.querySelector('[data-s="prev"]').textContent = (fakeP.previousBalance >= 0 ? '−' : '+') + fmtVND(Math.abs(fakeP.previousBalance));
        sum.querySelector('[data-s="disc"]').textContent = '−' + fmtVND(fakeP.discount);
        sum.querySelector('[data-s="due"]').textContent = fmtVND(fakeP.amountDue);
        const paidEl = $('#d-paid', modal.root);
        if (paidEl && p._autoFilled) paidEl.value = fakeP.amountDue;
      });
    });
  }
}

function collectPatch(root) {
  return {
    rent:            Number($('#d-rent', root)?.value)        || 0,
    electricity:     Number($('#d-elec', root)?.value)        || 0,
    water:           Number($('#d-water', root)?.value)       || 0,
    extraFee:        Number($('#d-extra', root)?.value)       || 0,
    extraNote:       $('#d-extra-note', root)?.value          || '',
    discount:        Number($('#d-discount', root)?.value)    || 0,
    previousBalance: Number($('#d-prev', root)?.value)        || 0,
    amountPaid:      Number($('#d-paid', root)?.value)        || 0,
    _autoFilled: false
  };
}

// History modal
async function openHistoryModal(room) {
  const payments = await Store.getRoomHistory(room.id);
  openModal({
    title: `Lịch sử · ${escHtml(room.code)} · ${escHtml(room.representative || '—')}`,
    lg: true,
    body: `
      ${payments.length === 0 ? '<div class="empty"><div class="empty-desc">Chưa có lịch sử.</div></div>' : `
        <div class="card">
          <div class="history-row is-header"><div>Tháng</div><div>Trạng thái</div><div style="text-align:right">Cần thu</div><div style="text-align:right">Đã thu</div></div>
          ${payments.map(p => `
            <div class="history-row">
              <div class="history-period">${displayPeriod(p.period)}</div>
              <div><span class="badge ${p.status === 'paid' ? 'badge-success' : p.status === 'skipped' ? 'badge-muted' : 'badge-warning'}">${p.status === 'paid' ? 'Đã thu' : p.status === 'skipped' ? 'Trống' : 'Chờ'}</span></div>
              <div class="num" style="text-align:right">${fmtVND(p.amountDue)}</div>
              <div class="num" style="text-align:right">${p.status === 'paid' ? fmtVND(p.amountPaid) : '—'}</div>
            </div>`).join('')}
        </div>`}`,
    footer: `<button class="btn btn-secondary" data-act="close">Đóng</button>`,
    onAction: (act, close) => { if (act === 'close') close(); }
  });
}

// ════════════════════════════════════════════════════════
// VIEW: Settings
// ════════════════════════════════════════════════════════
// ── Share code modal ─────────────────────────────────────
function openShareCodeModal(shareCode, houseName) {
  openModal({
    title: '🔗 Mã chia sẻ nhà trọ',
    body: `
      <p class="muted mb-16" style="line-height:1.7">
        Gửi mã bên dưới cho người bạn muốn chia sẻ qua <strong>Zalo, SMS, email…</strong>
        Họ nhập mã vào mục "Nhà trọ được chia sẻ" trong Cài đặt để xem dữ liệu.
      </p>
      <div class="share-code-modal-box">
        <div class="share-code-mono" id="modal-share-code">${escHtml(shareCode)}</div>
        <button class="btn btn-primary" id="modal-copy-code">📋 Copy mã</button>
      </div>
      <div class="share-note mt-16">
        <div class="share-note-item">📖 Người được share chỉ <strong>xem được</strong>, không sửa được dữ liệu</div>
        <div class="share-note-item">🔄 Bấm "Cập nhật dữ liệu share" sau khi chốt điện để họ thấy số mới</div>
        <div class="share-note-item">🚫 Có thể hủy chia sẻ bất kỳ lúc nào trong Cài đặt</div>
      </div>`,
    footer: `<button class="btn btn-secondary" data-act="close">Đóng</button>`,
    onAction: (act, close) => close()
  });
  document.getElementById('modal-copy-code')?.addEventListener('click', () => {
    navigator.clipboard.writeText(shareCode)
      .then(() => toast('✅ Đã copy mã share', 'success'))
      .catch(() => {
        // Fallback: select text
        const el = document.getElementById('modal-share-code');
        const range = document.createRange();
        range.selectNodeContents(el);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
        toast('Đã chọn mã — bấm Ctrl+C để copy', '');
      });
  });
}

// ── View nhà trọ được share (read-only modal) ─────────────
async function openSharedHouseView(entryId) {
  const shared = await Sharing.getSharedHouses();
  const entry  = shared.find(s => s.id === entryId);
  if (!entry) return toast('Không tìm thấy', 'danger');

  const snap     = entry.snapshot;
  const house    = snap.house;
  const rooms    = snap.rooms   || [];
  const readings = snap.meters  || [];
  const payments = snap.payments || [];

  // Lấy tháng mới nhất có dữ liệu
  const periods = [...new Set([
    ...readings.map(m => m.period),
    ...payments.map(p => p.period)
  ])].sort().reverse();
  const period = periods[0] || currentPeriod();

  const activeRooms = rooms.filter(r => r.active !== false);
  let totalDue = 0, totalPaid = 0;
  activeRooms.forEach(r => {
    const p = payments.find(x => x.roomId === r.id && x.period === period);
    if (p?.status === 'paid') totalPaid += p.amountPaid || 0;
    else if (p) totalDue += p.amountDue || 0;
  });

  openModal({
    title: `👁 ${escHtml(house.name)} <span style="font-size:12px;font-weight:400;color:var(--text-mute)">(Chỉ xem · ${periodLabel(period)})</span>`,
    lg: true,
    body: `
      <div class="shared-view-header">
        <div class="shared-view-meta">
          Chủ: ${escHtml(entry.ownerEmail)} ·
          Giá điện: ${fmtVND(house.config.electricityPrice)}/số ·
          Cập nhật: ${new Date(entry.lastSyncAt).toLocaleDateString('vi-VN')}
        </div>
        <div class="shared-view-stats">
          <span class="stat-chip">🏠 ${activeRooms.length} phòng</span>
          <span class="stat-chip success">✓ Đã thu ${fmtVND(totalPaid)}</span>
          <span class="stat-chip warning">⏳ Còn ${fmtVND(totalDue)}</span>
        </div>
      </div>
      <div class="shared-rooms-grid">
        ${activeRooms.map(room => {
          const meter   = readings.find(m => m.roomId === room.id && m.period === period);
          const prevMeter = readings
            .filter(m => m.roomId === room.id && m.period < period)
            .sort((a,b) => b.period.localeCompare(a.period))[0]
            || (room.initialElectricity > 0 ? { reading: room.initialElectricity } : null);
          const payment = payments.find(p => p.roomId === room.id && p.period === period);
          const consumed = meter && prevMeter ? Math.max(0, meter.reading - prevMeter.reading) : null;
          const status   = payment?.status || 'pending';

          return `
            <div class="shared-room-card ${status === 'paid' ? 'is-paid' : ''}">
              <div class="shared-room-head">
                <span class="room-code">${escHtml(room.code)}</span>
                <span class="badge ${status === 'paid' ? 'badge-success' : 'badge-warning'}">${status === 'paid' ? 'Đã thu' : 'Chưa thu'}</span>
              </div>
              <div class="shared-room-name">${escHtml(room.representative || '—')}</div>
              <div class="shared-room-elec">
                ⚡ ${meter ? `${meter.reading}${consumed !== null ? ` (+${consumed})` : ''}` : '<span class="mute">Chưa chốt</span>'}
              </div>
              <div class="shared-room-amount">${fmtVND(status === 'paid' ? payment.amountPaid : (payment?.amountDue || 0))}</div>
            </div>`;
        }).join('')}
      </div>`,
    footer: `
      <button class="btn btn-secondary" data-act="leave" style="margin-right:auto;color:var(--danger)">✕ Rời khỏi</button>
      <button class="btn btn-secondary" data-act="refresh">🔄 Làm mới</button>
      <button class="btn btn-secondary" data-act="close">Đóng</button>`,
    onAction: async (act, close) => {
      if (act === 'close') return close();
      if (act === 'refresh') {
        try {
          await Sharing.refreshSharedHouse(entryId);
          close();
          toast('✅ Đã cập nhật', 'success');
          openSharedHouseView(entryId);
        } catch (e) { toast('Lỗi: ' + e.message, 'danger'); }
      }
      if (act === 'leave') {
        if (!await confirmDialog('Rời nhà trọ', `Xóa "${house.name}" khỏi danh sách nhà trọ được chia sẻ?`, { ok: 'Rời khỏi', danger: true })) return;
        await Sharing.leaveSharedHouse(entryId);
        close();
        toast('Đã rời khỏi nhà trọ', 'success');
        renderAll();
      }
    }
  });
}

async function renderSettingsView({ house }) {
  const main = $('#main-content');
  main.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">⚙ Cài đặt</h1><div class="page-sub">Cấu hình nhà trọ và ứng dụng</div></div></div>
    ${tabBarHtml('settings')}
    <div class="settings-grid">
      <div class="card settings-section">
        <h3>Thông tin nhà trọ</h3>
        <p class="section-desc">Tên hiển thị trong sidebar.</p>
        <div class="form-row"><label class="label">Tên nhà trọ</label>
          <input type="text" class="input" id="s-name" value="${escHtml(house.name)}"/></div>
        <button class="btn btn-primary btn-sm" id="save-name">Lưu</button>
      </div>
      <div class="card settings-section">
        <h3>Giá điện · nước</h3>
        <p class="section-desc">Dùng để tính tiền hàng tháng. Giá điện làm tròn lên hàng nghìn.</p>
        <div class="form-row"><label class="label">Giá điện (đ/số)</label>
          <input type="number" class="input input-mono" id="s-elec" value="${house.config.electricityPrice}"/></div>
        <div class="form-row"><label class="label">Giá nước (đ/người/tháng)</label>
          <input type="number" class="input input-mono" id="s-water" value="${house.config.waterPricePerPerson}"/></div>
        <button class="btn btn-primary btn-sm" id="save-config">Lưu</button>
      </div>

      <div class="card settings-section" id="sharing-section">
        <h3>🔗 Chia sẻ nhà trọ</h3>
        <p class="section-desc">
          Tạo mã chia sẻ để người khác có thể xem dữ liệu nhà trọ này (chỉ đọc).
          Dữ liệu lưu trên Google Drive của bạn — người được share không thể chỉnh sửa.
        </p>
        <div id="share-status-area">
          ${Sharing.isShared(house) ? `
            <div class="share-active-box">
              <div class="share-active-label">✅ Đang chia sẻ</div>
              <div class="share-code-display" id="share-code-display">
                <span class="share-code-text" id="share-code-text">Đang tải…</span>
                <button class="btn btn-secondary btn-sm" id="copy-share-code">📋 Copy</button>
              </div>
              <div class="share-hint">Gửi mã này cho người bạn muốn chia sẻ qua Zalo, SMS, email…</div>
              <div class="row gap-8 mt-8">
                <button class="btn btn-secondary btn-sm" id="refresh-share-btn">🔄 Cập nhật dữ liệu share</button>
                <button class="btn btn-secondary btn-sm" id="stop-share-btn" style="color:var(--danger)">🚫 Hủy chia sẻ</button>
              </div>
            </div>
          ` : `
            <button class="btn btn-primary btn-sm" id="start-share-btn">🔗 Tạo mã chia sẻ</button>
          `}
        </div>
      </div>

      <div class="card settings-section">
        <h3>Drive Storage</h3>
        <p class="section-desc">Tất cả dữ liệu lưu trong folder <strong>rent-mng-datastorage</strong> trên Google Drive của bạn.</p>
        <div class="reminder-info">
          <div class="reminder-item" style="font-size:12px;font-family:var(--font-mono);color:var(--text-soft)">
            📁 rent-mng-datastorage/<br>
            &nbsp;&nbsp;📄 meta.json &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;— Cấu hình nhà trọ<br>
            &nbsp;&nbsp;📄 rooms.json &nbsp;&nbsp;&nbsp;&nbsp;— Danh sách phòng<br>
            &nbsp;&nbsp;📄 meter-readings.json — Chỉ số điện<br>
            &nbsp;&nbsp;📄 payments.json &nbsp;— Thanh toán<br>
            &nbsp;&nbsp;🖼 meter_*.jpg &nbsp;&nbsp;&nbsp;— Ảnh đồng hồ điện
          </div>
        </div>
        <div class="row gap-8 mt-12">
          <button class="btn btn-secondary btn-sm" id="btn-pull">⬇ Kéo dữ liệu từ Drive</button>
          <button class="btn btn-secondary btn-sm" id="test-notif">🔔 Test notification</button>
        </div>
      </div>

      <div class="card settings-section">
        <h3>Nhắc nhở</h3>
        <p class="section-desc">Chrome Notifications + badge đỏ trên icon extension.</p>
        <div class="reminder-info">
          <div class="reminder-item"><span class="badge badge-warning">⚡ Chốt điện</span> Từ mùng 1–7, nhắc hàng ngày đến khi chốt đủ.</div>
          <div class="reminder-item"><span class="badge badge-danger">💰 Thu tiền</span> Từ mùng 5, nhắc hàng ngày nếu còn phòng chưa thu.</div>
        </div>
      </div>

      <div class="card settings-section">
        <h3 style="color:var(--danger)">Vùng nguy hiểm</h3>
        <p class="section-desc">Không thể hoàn tác.</p>
        <button class="btn btn-danger btn-sm" id="del-house">Xóa nhà trọ này</button>
      </div>
    </div>`;

  bindTabs();
  $('#save-name').onclick = async () => {
    const name = $('#s-name').value.trim();
    if (!name) return toast('Tên không được trống', 'danger');
    await Store.updateHouse(house.id, { name });
    toast('✅ Đã lưu vào Drive', 'success'); renderAll();
  };
  $('#save-config').onclick = async () => {
    const ep = Number($('#s-elec').value) || 0;
    const wp = Number($('#s-water').value) || 0;
    const newConfig = { ...house.config, electricityPrice: ep, waterPricePerPerson: wp };
    await Store.updateHouse(house.id, { config: newConfig });
    toast(`✅ Đã lưu: điện ${fmtVND(ep)}/số · nước ${fmtVND(wp)}/người`, 'success');
    renderAll();
  };
  $('#btn-pull').onclick = async () => {
    const btn = $('#btn-pull'); setLoading(btn, true, '⬇ Kéo dữ liệu');
    try { await DriveStore.pullAll(); toast('✅ Đã kéo dữ liệu từ Drive', 'success'); renderAll(); }
    catch (e) { toast('Lỗi: ' + e.message, 'danger'); setLoading(btn, false, '⬇ Kéo dữ liệu từ Drive'); }
  };
  $('#test-notif').onclick = () => {
    chrome.notifications.create('test-' + Date.now(), { type: 'basic', iconUrl: 'icons/icon128.png', title: '🏠 Rent Manager — Test', message: 'Notifications hoạt động!' });
    toast('Đã gửi test notification', 'success');
  };
  $('#del-house').onclick = async () => {
    if (!await confirmDialog('Xóa nhà trọ', `Xóa "${house.name}" và toàn bộ dữ liệu trên Drive?`, { ok: 'Xóa', danger: true })) return;
    await Store.deleteHouse(house.id);
    toast('Đã xóa', 'success'); renderAll();
  };

  // ── Sharing handlers ──────────────────────────────────
  // Hiển thị share code nếu đang share
  if (Sharing.isShared(house)) {
    const code = Sharing.getShareCode(house);
    const codeEl = $('#share-code-text');
    if (codeEl && code) codeEl.textContent = code;
    $('#copy-share-code')?.addEventListener('click', () => {
      navigator.clipboard.writeText(code || '').then(() => toast('✅ Đã copy mã share', 'success'));
    });
    $('#refresh-share-btn')?.addEventListener('click', async () => {
      const btn = $('#refresh-share-btn');
      setLoading(btn, true, 'Cập nhật…');
      try {
        await Sharing.updateSharedSnapshot(house.id);
        toast('✅ Đã cập nhật dữ liệu share lên Drive', 'success');
      } catch (e) { toast('Lỗi: ' + e.message, 'danger'); }
      finally { setLoading(btn, false, '🔄 Cập nhật dữ liệu share'); }
    });
    $('#stop-share-btn')?.addEventListener('click', async () => {
      if (!await confirmDialog('Hủy chia sẻ', 'Người được share sẽ không còn xem được dữ liệu. Tiếp tục?', { ok: 'Hủy chia sẻ', danger: true })) return;
      await Sharing.unshareHouse(house.id);
      toast('✅ Đã hủy chia sẻ', 'success'); renderAll();
    });
  } else {
    $('#start-share-btn')?.addEventListener('click', async () => {
      const btn = $('#start-share-btn');
      setLoading(btn, true, 'Đang tạo…');
      try {
        const { shareCode, shareFileId } = await Sharing.shareHouse(house.id);

        // Verify file thực sự download được (Drive API key giờ trong manifest)
        try {
          await Sharing.verifySharedFile(shareFileId);
        } catch (verr) {
          console.warn('[Sharing] Verify failed:', verr.message);
          toast('⚠ Tạo mã thành công nhưng chưa verify được. ' + verr.message, 'warning');
        }

        toast('✅ Đã tạo mã share', 'success');
        navigator.clipboard.writeText(shareCode).catch(() => {});
        renderAll();
        setTimeout(() => openShareCodeModal(shareCode, house.name), 300);
      } catch (e) { toast('Lỗi: ' + e.message, 'danger'); setLoading(btn, false, '🔗 Tạo mã chia sẻ'); }
    });
  }
}

// ════════════════════════════════════════════════════════
// House / Room modals
// ════════════════════════════════════════════════════════
function openCreateHouseModal() {
  const modal = openModal({
    title: 'Thêm nhà trọ',
    body: `
      <div class="ch-tabs" role="tablist">
        <button class="ch-tab ch-tab-active" data-tab="new" role="tab" type="button">
          🏠 Tạo nhà trọ mới
        </button>
        <button class="ch-tab" data-tab="join" role="tab" type="button">
          🔗 Tham gia chia sẻ
        </button>
      </div>

      <div class="ch-panel" data-panel="new">
        <p class="muted" style="font-size:12px;margin-bottom:12px">
          Tạo một nhà trọ mới, do bạn toàn quyền quản lý.
        </p>
        <div class="form-row"><label class="label">Tên nhà trọ *</label>
          <input type="text" class="input" id="ch-name" autofocus placeholder="VD: Nhà trọ Hoa Sữa"/></div>
        <div class="form-row row-pair">
          <div><label class="label">Giá điện (đ/số)</label>
            <input type="number" class="input input-mono" id="ch-elec" value="3500"/></div>
          <div><label class="label">Giá nước (đ/người)</label>
            <input type="number" class="input input-mono" id="ch-water" value="100000"/></div>
        </div>
      </div>

      <div class="ch-panel" data-panel="join" style="display:none">
        <p class="muted" style="font-size:12px;margin-bottom:12px">
          Dán mã chia sẻ <code>RMS1:...</code> từ chủ nhà trọ để xem dữ liệu (chỉ đọc).
        </p>
        <div class="form-row"><label class="label">Mã chia sẻ *</label>
          <input type="text" class="input" id="ch-join-code"
            placeholder="RMS1:..." style="font-family:var(--font-mono);font-size:13px"/></div>
      </div>
    `,
    footer: `<button class="btn btn-secondary" data-act="close">Hủy</button>
             <button class="btn btn-primary" data-act="ok" id="ch-submit-btn">Tạo</button>`,
    onAction: async (act, close, root) => {
      if (act !== 'ok') return close();
      const activeTab = root.querySelector('.ch-tab-active')?.dataset.tab || 'new';
      const btn = root.querySelector('[data-act="ok"]');

      if (activeTab === 'new') {
        const name = $('#ch-name', root).value.trim();
        if (!name) return toast('Cần điền tên nhà trọ', 'danger');
        setLoading(btn, true, 'Tạo');
        try {
          await Store.createHouse({ name,
            electricityPrice: Number($('#ch-elec', root).value) || 3500,
            waterPricePerPerson: Number($('#ch-water', root).value) || 100000
          });
          toast('✅ Đã tạo nhà trọ và lưu vào Drive', 'success');
          close(); renderAll();
        } catch (e) { toast('Lỗi: ' + e.message, 'danger'); setLoading(btn, false, 'Tạo'); }
      } else {
        // Join shared
        const code = $('#ch-join-code', root).value.trim();
        if (!code) return toast('Cần nhập mã chia sẻ', 'danger');
        setLoading(btn, true, 'Đang tham gia…');
        try {
          const entry = await Sharing.joinByCode(code);
          toast(`✅ Đã thêm "${entry.houseName}" (chỉ xem)`, 'success');
          close(); renderAll();
        } catch (e) {
          const msg = e.message || 'Lỗi không xác định';
          setLoading(btn, false, 'Tham gia');
          // Long error → confirmDialog, short → toast
          if (msg.length > 80 || msg.includes('\n')) {
            await confirmDialog('Không tham gia được', msg, { ok: 'Đã hiểu', cancel: '' });
          } else {
            toast(msg, 'danger');
          }
        }
      }
    }
  });

  // Tab switching
  const root = modal.root;
  const tabs = $$('.ch-tab', root);
  const submitBtn = $('#ch-submit-btn', root);
  tabs.forEach(t => t.addEventListener('click', () => {
    tabs.forEach(x => x.classList.toggle('ch-tab-active', x === t));
    $$('.ch-panel', root).forEach(p => {
      p.style.display = p.dataset.panel === t.dataset.tab ? '' : 'none';
    });
    submitBtn.textContent = t.dataset.tab === 'new' ? 'Tạo' : 'Tham gia';
    // Focus first input of the visible panel
    const visiblePanel = root.querySelector(`[data-panel="${t.dataset.tab}"]`);
    visiblePanel?.querySelector('input')?.focus();
  }));
}

async function openRoomModal(houseId, roomId) {
  const room = roomId ? await Store.getRoom(roomId) : null;
  const roomsDoc = await DriveStore.readRooms();
  const metersDoc = await DriveStore.readMeters();
  const hasHistory = room ? metersDoc.readings.some(m => m.roomId === room.id) : false;

  openModal({
    title: room ? `Sửa phòng · ${room.code}` : 'Thêm phòng mới',
    body: `
      <div class="form-row row-pair">
        <div><label class="label">Mã phòng *</label>
          <input type="text" class="input" id="r-code" value="${escHtml(room?.code || '')}" autofocus/></div>
        <div><label class="label">Đại diện phòng</label>
          <input type="text" class="input" id="r-rep" value="${escHtml(room?.representative || '')}"/></div>
      </div>
      <div class="form-row row-pair">
        <div><label class="label">Số người</label>
          <input type="number" class="input input-mono" id="r-occ" value="${room?.occupants || 1}"/></div>
        <div><label class="label">Giá phòng (đ/tháng)</label>
          <input type="number" class="input input-mono" id="r-price" value="${room?.price || 0}"/></div>
      </div>
      <div class="form-row">
        <label class="label">Chỉ số đồng hồ điện ban đầu ${hasHistory ? '<span class="mute">(đã có lịch sử)</span>' : ''}</label>
        <input type="number" class="input input-mono" id="r-init-elec" value="${room?.initialElectricity || 0}" ${hasHistory ? 'disabled' : ''}/>
        <div class="hint">Số trên đồng hồ lúc bắt đầu cho thuê. Các tháng sau tự lấy từ tháng trước.</div>
      </div>
      <div class="form-row">
        <label class="label">Danh sách người ở <span class="mute">(mỗi dòng 1 người)</span></label>
        <textarea class="input" id="r-people" rows="3">${escHtml((room?.people || []).join('\n'))}</textarea>
      </div>
      <div class="form-row">
        <label class="label" style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="r-active" ${room?.active === false ? '' : 'checked'}/>
          <span>Phòng đang có người ở (bỏ tick = phòng trống)</span>
        </label>
      </div>`,
    footer: `
      ${room ? `<button class="btn btn-secondary" data-act="delete" style="margin-right:auto;color:var(--danger)">Xóa phòng</button>` : ''}
      <button class="btn btn-secondary" data-act="close">Hủy</button>
      <button class="btn btn-primary" data-act="ok">${room ? 'Lưu' : 'Tạo phòng'}</button>`,
    onAction: async (act, close, root) => {
      if (act === 'close') return close();
      if (act === 'delete') {
        if (!await confirmDialog('Xóa phòng', `Xóa phòng ${room.code} và toàn bộ lịch sử?`, { ok: 'Xóa', danger: true })) return;
        await Store.deleteRoom(room.id);
        toast('✅ Đã xóa phòng', 'success'); close(); renderAll(); return;
      }
      const data = {
        code: $('#r-code', root).value.trim(),
        representative: $('#r-rep', root).value.trim(),
        occupants: Number($('#r-occ', root).value) || 1,
        price: Number($('#r-price', root).value) || 0,
        people: $('#r-people', root).value.split('\n').map(s => s.trim()).filter(Boolean),
        active: $('#r-active', root).checked,
        ...(!hasHistory ? { initialElectricity: Number($('#r-init-elec', root).value) || 0 } : {})
      };
      if (!data.code) return toast('Mã phòng không được trống', 'danger');
      const btn = root.querySelector('[data-act="ok"]');
      setLoading(btn, true, room ? 'Lưu' : 'Tạo phòng');
      try {
        if (room) await Store.updateRoom(room.id, data);
        else await Store.addRoom(houseId, data);
        toast(`✅ Đã ${room ? 'cập nhật' : 'thêm'} phòng vào Drive`, 'success');
        close(); renderAll();
      } catch (e) { toast('Lỗi: ' + e.message, 'danger'); setLoading(btn, false, room ? 'Lưu' : 'Tạo phòng'); }
    }
  });
}

// ════════════════════════════════════════════════════════
// Excel Import Modal
// ════════════════════════════════════════════════════════
function openImportExcelModal(houseId) {
  openModal({
    title: '📂 Import phòng từ Excel',
    lg: true,
    body: `
      <div class="import-instructions">
        <p class="muted mb-12" style="line-height:1.7">Upload file Excel (.xlsx) chứa danh sách phòng. Hệ thống sẽ đọc các cột: <strong>Mã phòng</strong>, Đại diện, Số người, Giá phòng, Chỉ số ĐH ban đầu, Danh sách người ở.</p>
        <button class="btn btn-secondary btn-sm" id="download-template">⬇ Tải file mẫu Excel</button>
      </div>
      <div class="import-dropzone" id="import-dropzone">
        <input type="file" id="import-file" accept=".xlsx,.xls" style="display:none"/>
        <div class="import-dropzone-inner" id="import-dropzone-inner">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--text-mute)"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
          <div class="import-dropzone-title">Kéo thả file Excel hoặc bấm để chọn</div>
          <div class="import-dropzone-desc">.xlsx · .xls</div>
        </div>
      </div>
      <div id="import-preview" style="display:none">
        <div id="import-summary" class="mb-12"></div>
        <div id="import-table-wrap" style="max-height:300px;overflow-y:auto"></div>
        <div id="import-warnings" class="mt-8"></div>
      </div>
      <div id="import-errors" style="display:none"></div>`,
    footer: `
      <button class="btn btn-secondary" data-act="close">Hủy</button>
      <button class="btn btn-primary" data-act="import" disabled id="btn-import-confirm">📥 Import ${0} phòng</button>`,
    onAction: async (act, close, root) => {
      if (act === 'close') return close();
      if (act === 'import') {
        const btn = root.querySelector('[data-act="import"]');
        setLoading(btn, true, 'Đang import...');
        try {
          const rows = JSON.parse(btn.dataset.rows || '[]');
          const results = await Store.upsertRoomsBatch(houseId, rows);
          const { created = [], updated = [] } = results;
          const parts = [];
          if (created.length) parts.push(`✅ Tạo mới ${created.length} phòng`);
          if (updated.length) parts.push(`🔄 Cập nhật ${updated.length} phòng`);
          toast(parts.join(' · ') || 'Không có thay đổi', 'success');
          close(); renderAll();
        } catch (e) {
          toast('Import thất bại: ' + e.message, 'danger');
          setLoading(btn, false, `📥 Import`);
        }
      }
    }
  });

  // Wire up file picker and drag-drop
  const fileInput  = document.getElementById('import-file');
  const dropzone   = document.getElementById('import-dropzone');
  const innerZone  = document.getElementById('import-dropzone-inner');
  const preview    = document.getElementById('import-preview');
  const errorsEl   = document.getElementById('import-errors');
  const confirmBtn = document.getElementById('btn-import-confirm');

  document.getElementById('download-template')?.addEventListener('click', async () => {
    try {
      await downloadTemplate();
      toast('✅ Đang tải file mẫu...', 'success');
    } catch(e) {
      toast('Lỗi tải file mẫu: ' + e.message, 'danger');
    }
  });

  async function handleImportFile(file) {
    if (!file) return;
    innerZone.textContent = `📄 ${file.name} — Đang phân tích...`;
    preview.style.display = 'none';
    errorsEl.style.display = 'none';

    try {
      const { rows, errors, warnings } = await parseExcelFile(file);

      if (errors.length) {
        errorsEl.innerHTML = errors.map(e => `<div class="toast toast-danger" style="margin-bottom:6px">${escHtml(e)}</div>`).join('');
        errorsEl.style.display = 'block';
        innerZone.textContent = '❌ File có lỗi — xem chi tiết bên dưới';
        confirmBtn.disabled = true;
        return;
      }

      // Show preview table
      document.getElementById('import-summary').innerHTML =
        `<span class="badge badge-success">✓ Tìm thấy ${rows.length} phòng hợp lệ</span>`;
      document.getElementById('import-table-wrap').innerHTML = `
        <table class="import-table">
          <thead><tr><th>Mã phòng</th><th>Đại diện</th><th>Số người</th><th>Giá phòng</th><th>Chỉ số ĐH</th><th>Người ở</th></tr></thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td class="num">${escHtml(r.code)}</td>
              <td>${escHtml(r.representative || '—')}</td>
              <td class="num">${r.occupants}</td>
              <td class="num">${fmtVND(r.price)}</td>
              <td class="num">${r.initialElectricity || 0}</td>
              <td class="mute" style="font-size:11px">${escHtml(r.people.slice(0,2).join(', ')) + (r.people.length > 2 ? ` +${r.people.length-2}` : '')}</td>
            </tr>`).join('')}
          </tbody>
        </table>`;

      if (warnings.length) {
        document.getElementById('import-warnings').innerHTML =
          warnings.map(w => `<div style="font-size:12px;color:var(--warning);margin-bottom:4px">⚠ ${escHtml(w)}</div>`).join('');
      }

      preview.style.display = 'block';
      // Check existing rooms for upsert preview
      const existingRoomsDoc = await DriveStore.readRooms().catch(() => ({ rooms: [] }));
      const existingCodes = new Set(
        existingRoomsDoc.rooms
          .filter(r => r.houseId === houseId)
          .map(r => r.code.toUpperCase())
      );
      const toCreate = rows.filter(r => !existingCodes.has(r.code.toUpperCase()));
      const toUpdate = rows.filter(r => existingCodes.has(r.code.toUpperCase()));
      const upsertInfo = [];
      if (toCreate.length) upsertInfo.push(`${toCreate.length} tạo mới`);
      if (toUpdate.length) upsertInfo.push(`${toUpdate.length} cập nhật`);

      confirmBtn.disabled = false;
      confirmBtn.textContent = `📥 Import (${upsertInfo.join(' + ')})`;
      confirmBtn.dataset.rows = JSON.stringify(rows);
      innerZone.textContent = `✅ ${file.name}`;
    } catch (e) {
      errorsEl.innerHTML = `<div class="toast toast-danger">${escHtml(e.message)}</div>`;
      errorsEl.style.display = 'block';
      innerZone.textContent = '❌ Lỗi đọc file';
    }
  }

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => handleImportFile(e.target.files?.[0]));
  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.style.borderColor = 'var(--text)'; });
  dropzone.addEventListener('dragleave', () => { dropzone.style.borderColor = ''; });
  dropzone.addEventListener('drop', e => { e.preventDefault(); dropzone.style.borderColor = ''; handleImportFile(e.dataTransfer.files?.[0]); });
}

// ── Wire-up global buttons ────────────────────────────────
$('#add-house-btn').onclick = openCreateHouseModal;
$('#theme-toggle').onclick = async () => {
  const cur = await DriveStore.getTheme();
  const next = cur === 'light' ? 'dark' : cur === 'dark' ? 'auto' : 'light';
  await DriveStore.setTheme(next); applyTheme(next);
};
$('#sync-btn').onclick = async () => {
  const btn = $('#sync-btn'); btn.disabled = true;
  try {
    await DriveStore.pullAll();
    toast('✅ Đã kéo dữ liệu mới nhất từ Drive', 'success'); renderAll();
  } catch (e) { toast('Lỗi sync: ' + e.message, 'danger'); }
  finally { btn.disabled = false; }
};
$('#signout-btn').onclick = async () => {
  // Hiện dialog với 2 lựa chọn
  const choice = await new Promise(resolve => {
    openModal({
      title: 'Tài khoản',
      body: `
        <div style="text-align:center;padding:8px 0">
          <div style="font-size:14px;margin-bottom:20px" id="signout-user-info"></div>
        </div>`,
      footer: `
        <button class="btn btn-secondary" data-act="cancel">Hủy</button>
        <button class="btn btn-secondary" data-act="switch">🔄 Đổi tài khoản</button>
        <button class="btn btn-danger"    data-act="signout">Đăng xuất</button>`,
      onAction(act, close) { close(); resolve(act); }
    });
    // Hiện email hiện tại
    Auth.getProfile().then(p => {
      const el = document.getElementById('signout-user-info');
      if (el && p) el.innerHTML = `<strong>${escHtml(p.name || '')}</strong><br><span class="muted">${escHtml(p.email || '')}</span>`;
    });
  });

  if (choice === 'cancel') return;
  if (choice === 'signout') {
    await Auth.signOut();
    location.reload();
    return;
  }
  if (choice === 'switch') {
    try {
      await Auth.switchAccount();
      location.reload();
    } catch (e) {
      if (e.isConfigError) {
        toast('⚠ ' + e.message, 'danger');
        console.error('[Auth config error]', e.message, '\nHint:', e.hint);
        setTimeout(() => toast(e.hint, 'warning'), 400);
      } else if (e.message === 'Đăng nhập bị hủy') {
        // User đóng popup khi đang switch — đã clear session cũ rồi,
        // reload để về màn signin
        location.reload();
      } else {
        toast('Lỗi: ' + e.message, 'danger');
      }
    }
  }
};

async function renderAll() {
  await renderSidebar();
  await renderMain(); // renderMain tự hydrate
}

// ── Boot ──────────────────────────────────────────────────
// Listen for background Drive write errors and show user-friendly toast
window.addEventListener('rm-drive-write-error', (e) => {
  const msg = e.detail?.error || '';
  if (msg.includes('Not authenticated') || msg.includes('bad client')) {
    // Show once, not spam
    if (!window._driveAuthWarnShown) {
      window._driveAuthWarnShown = true;
      toast('⚠ Chưa kết nối Drive — dữ liệu lưu local, sẽ đồng bộ khi đăng nhập', 'warning');
      setTimeout(() => { window._driveAuthWarnShown = false; }, 10000);
    }
  } else {
    toast('⚠ Lưu Drive thất bại: ' + msg.slice(0, 60), 'warning');
  }
});

(async () => {
  const theme = await DriveStore.getTheme();
  applyTheme(theme);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => {
    const t = await DriveStore.getTheme(); if (t === 'auto') applyTheme('auto');
  });
  const ok = await ensureSignedIn();
  if (ok) {
    // Migrate: strip base64 imageThumbnail cũ (chạy lặng lẽ, không block UI)
    Store.migrateMeterThumbnails().catch(e => console.warn('[migrate]', e.message));
    await renderAll();
    triggerBadge();
  }
})();

// Cleanup blob URLs khi extension đóng
window.addEventListener('beforeunload', () => { try { revokeAllImages(); } catch {} });
