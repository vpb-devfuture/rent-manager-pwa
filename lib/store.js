// lib/store.js — Business logic layer (CRUD on top of DriveStore)
// Every write goes to Drive immediately (write-through cache).

import { DriveStore, uid, roundUp1000 } from './drive-storage.js';
import { getUserKeys } from './storage-keys.js';
import { Auth } from './auth.js';

export const Store = {

  // ── Helpers ───────────────────────────────────────────
  calcElectricity(consumed, pricePerUnit) {
    return roundUp1000((consumed || 0) * (pricePerUnit || 0));
  },
  calcWater(occupants, pricePerPerson) {
    return roundUp1000((occupants || 0) * (pricePerPerson || 0));
  },
  calcAmountDue(p) {
    const raw = (p.rent || 0) + (p.electricity || 0) + (p.water || 0) +
      (p.extraFee || 0) - (p.previousBalance || 0) - (p.discount || 0);
    return roundUp1000(Math.max(0, raw));
  },

  // ── Active house ──────────────────────────────────────
  async getActiveHouseId() {
    const meta = await DriveStore.readMeta();
    return meta.activeHouseId || meta.houses[0]?.id || null;
  },
  async setActiveHouseId(id) {
    const meta = await DriveStore.readMeta();
    meta.activeHouseId = id;
    await DriveStore.saveMeta(meta);
  },

  // ── Houses ────────────────────────────────────────────
  async getHouses() {
    const meta = await DriveStore.readMeta();
    return meta.houses || [];
  },
  async getHouse(id) {
    const houses = await this.getHouses();
    return houses.find(h => h.id === id) || null;
  },

  async createHouse({ name, electricityPrice = 3500, waterPricePerPerson = 100000 }) {
    const profile = await Auth.getProfile();
    const meta = await DriveStore.readMeta();
    const house = {
      id: uid('h_'), name,
      ownerEmail: profile?.email || '',
      config: { electricityPrice, waterPricePerPerson, currency: 'VND' },
      members: [{ email: profile?.email || '', role: 'owner' }],
      createdAt: new Date().toISOString()
    };
    meta.houses.push(house);
    meta.activeHouseId = house.id;
    await DriveStore.saveMeta(meta);
    return house;
  },

  async updateHouse(houseId, patch) {
    const meta = await DriveStore.readMeta();
    const h = meta.houses.find(x => x.id === houseId);
    if (!h) throw new Error('House not found');
    Object.assign(h, patch);
    await DriveStore.saveMeta(meta);
    return h;
  },

  async deleteHouse(houseId) {
    const meta = await DriveStore.readMeta();
    meta.houses = meta.houses.filter(h => h.id !== houseId);
    if (meta.activeHouseId === houseId) meta.activeHouseId = meta.houses[0]?.id || null;
    await DriveStore.saveMeta(meta);

    // Also delete rooms/meters/payments for this house
    const roomsDoc = await DriveStore.readRooms();
    roomsDoc.rooms = roomsDoc.rooms.filter(r => r.houseId !== houseId);
    await DriveStore.saveRooms(roomsDoc);

    const metersDoc = await DriveStore.readMeters();
    metersDoc.readings = metersDoc.readings.filter(m => m.houseId !== houseId);
    await DriveStore.saveMeters(metersDoc);

    const paymentsDoc = await DriveStore.readPayments();
    paymentsDoc.payments = paymentsDoc.payments.filter(p => p.houseId !== houseId);
    await DriveStore.savePayments(paymentsDoc);
  },

  // ── Rooms ─────────────────────────────────────────────
  async getRooms(houseId) {
    const doc = await DriveStore.readRooms();
    return doc.rooms.filter(r => r.houseId === houseId);
  },
  async getRoom(roomId) {
    const doc = await DriveStore.readRooms();
    return doc.rooms.find(r => r.id === roomId) || null;
  },

  async addRoom(houseId, data) {
    const doc = await DriveStore.readRooms();
    const room = {
      id: uid('r_'), houseId,
      code: data.code,
      representative: data.representative || '',
      occupants: Number(data.occupants) || 1,
      price: Number(data.price) || 0,
      people: data.people || [],
      active: data.active !== false,
      initialElectricity: Number(data.initialElectricity) || 0,
      createdAt: new Date().toISOString()
    };
    doc.rooms.push(room);
    await DriveStore.saveRooms(doc);
    return room;
  },

  async upsertRoomsBatch(houseId, roomsData) {
    // Bulk create-or-update rooms from Excel import.
    // Match by code (case-insensitive) within the same houseId.
    const doc = await DriveStore.readRooms();
    const results = { created: [], updated: [], skipped: [] };

    for (const data of roomsData) {
      const codeUpper = (data.code || '').toUpperCase();
      const existing = doc.rooms.find(
        r => r.houseId === houseId && r.code.toUpperCase() === codeUpper
      );

      if (existing) {
        // UPDATE: merge new data into existing room
        existing.representative = data.representative || existing.representative;
        existing.occupants      = Number(data.occupants) || existing.occupants;
        existing.price          = Number(data.price) || existing.price;
        existing.people         = data.people?.length ? data.people : existing.people;
        if (data.initialElectricity > 0) {
          existing.initialElectricity = Number(data.initialElectricity);
        }
        existing.updatedAt = new Date().toISOString();
        results.updated.push(existing);
      } else {
        // CREATE
        const room = {
          id: uid('r_'), houseId,
          code: data.code,
          representative: data.representative || '',
          occupants: Number(data.occupants) || 1,
          price: Number(data.price) || 0,
          people: data.people || [],
          active: data.active !== false,
          initialElectricity: Number(data.initialElectricity) || 0,
          createdAt: new Date().toISOString()
        };
        doc.rooms.push(room);
        results.created.push(room);
      }
    }

    await DriveStore.saveRooms(doc);
    return results;
  },

  async updateRoom(roomId, patch) {
    const doc = await DriveStore.readRooms();
    const r = doc.rooms.find(x => x.id === roomId);
    if (!r) throw new Error('Room not found');
    // price stored as-is (no rounding on config values)
    Object.assign(r, patch);
    await DriveStore.saveRooms(doc);
    return r;
  },

  async deleteRoom(roomId) {
    const doc = await DriveStore.readRooms();
    doc.rooms = doc.rooms.filter(r => r.id !== roomId);
    await DriveStore.saveRooms(doc);

    const metersDoc = await DriveStore.readMeters();
    metersDoc.readings = metersDoc.readings.filter(m => m.roomId !== roomId);
    await DriveStore.saveMeters(metersDoc);

    const paymentsDoc = await DriveStore.readPayments();
    paymentsDoc.payments = paymentsDoc.payments.filter(p => p.roomId !== roomId);
    await DriveStore.savePayments(paymentsDoc);
  },

  // ── Meter Readings ────────────────────────────────────
  async getMeterReadings(houseId) {
    const doc = await DriveStore.readMeters();
    return doc.readings.filter(m => m.houseId === houseId);
  },
  getMeterForPeriod(readings, roomId, period) {
    return readings.find(m => m.roomId === roomId && m.period === period) || null;
  },
  getPrevMeter(readings, room, period) {
    // Most recent reading before this period
    const earlier = readings
      .filter(m => m.roomId === room.id && m.period < period)
      .sort((a, b) => b.period.localeCompare(a.period));
    if (earlier[0]) return earlier[0];
    // Fallback: initialElectricity
    if (room.initialElectricity > 0)
      return { roomId: room.id, period: 'initial', reading: room.initialElectricity, synthetic: true };
    return null;
  },
  isAllMetered(rooms, readings, period) {
    return rooms.filter(r => r.active !== false)
      .every(r => readings.some(m => m.roomId === r.id && m.period === period));
  },

  async saveMeterReading(houseId, roomId, period, reading, imageInfo = {}) {
    const profile = await Auth.getProfile();
    const doc = await DriveStore.readMeters();
    const idx = doc.readings.findIndex(m => m.roomId === roomId && m.period === period);
    const rec = {
      id: idx >= 0 ? doc.readings[idx].id : uid('m_'),
      houseId, roomId, period,
      reading: Number(reading),
      imageFileId: imageInfo.fileId || '',
      imageUrl: imageInfo.url || '',
      recordedAt: new Date().toISOString(),
      recordedBy: profile?.email || ''
    };
    if (idx >= 0) doc.readings[idx] = rec;
    else doc.readings.push(rec);
    await DriveStore.saveMeters(doc);
    return rec;
  },

  async deleteMeterReading(roomId, period) {
    const doc = await DriveStore.readMeters();
    doc.readings = doc.readings.filter(m => !(m.roomId === roomId && m.period === period));
    await DriveStore.saveMeters(doc);
  },

  // ── Payments ──────────────────────────────────────────
  async getPayments(houseId) {
    const doc = await DriveStore.readPayments();
    return doc.payments.filter(p => p.houseId === houseId);
  },

  getPrevBalance(payments, roomId, period) {
    const [y, m] = period.split('-').map(Number);
    const prevDate = new Date(y, m - 2, 1);
    const prev = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
    const prevP = payments.find(p => p.roomId === roomId && p.period === prev && p.status === 'paid');
    if (!prevP) return 0;
    return (prevP.amountPaid || 0) - (prevP.amountDue || 0);
  },

  async getOrCreatePayment(houseId, room, period, house, readings, payments) {
    // readings and payments are pre-fetched arrays (caller passes them for perf)
    let p = payments.find(x => x.roomId === room.id && x.period === period);
    const curMeter = this.getMeterForPeriod(readings, room.id, period);
    const prevMeter = this.getPrevMeter(readings, room, period);
    const consumed = curMeter && prevMeter ? Math.max(0, curMeter.reading - prevMeter.reading) : 0;
    const electricity = this.calcElectricity(consumed, house.config.electricityPrice);
    const water = this.calcWater(room.occupants, house.config.waterPricePerPerson);
    const previousBalance = this.getPrevBalance(payments, room.id, period);

    if (p) {
      if (p.status !== 'paid') {
        // Refresh computed fields
        const changed = p.electricity !== electricity || p.water !== water || p.previousBalance !== previousBalance;
        if (changed) {
          p.electricity = electricity;
          p.water = water;
          p.previousBalance = previousBalance;
          p.amountDue = this.calcAmountDue(p);
          if (p._autoFilled) p.amountPaid = p.amountDue;
          await this._updatePaymentInDoc(p);
        }
      }
      return p;
    }

    // Create new
    const rent = room.price || 0;
    p = {
      id: uid('p_'), houseId, roomId: room.id, period,
      rent, electricity, water,
      extraFee: 0, extraNote: '',
      previousBalance, discount: 0, discountNote: '',
      amountDue: 0, amountPaid: 0, _autoFilled: true,
      status: room.active === false ? 'skipped' : 'pending',
      paidAt: null, note: ''
    };
    p.amountDue = this.calcAmountDue(p);
    p.amountPaid = p.amountDue;
    const doc = await DriveStore.readPayments();
    doc.payments.push(p);
    await DriveStore.savePayments(doc);
    return p;
  },

  async _updatePaymentInDoc(p) {
    const doc = await DriveStore.readPayments();
    const idx = doc.payments.findIndex(x => x.id === p.id);
    if (idx >= 0) doc.payments[idx] = p;
    await DriveStore.savePayments(doc);
  },

  async updatePayment(paymentId, patch) {
    const doc = await DriveStore.readPayments();
    const p = doc.payments.find(x => x.id === paymentId);
    if (!p) throw new Error('Payment not found');
    // Round calculated amounts (not config prices)
    if (patch.electricity !== undefined) patch.electricity = roundUp1000(patch.electricity);
    if (patch.water !== undefined) patch.water = roundUp1000(patch.water);
    if (patch.extraFee !== undefined) patch.extraFee = roundUp1000(patch.extraFee);
    if (patch.discount !== undefined) patch.discount = roundUp1000(patch.discount);
    Object.assign(p, patch);
    if (patch.amountPaid === undefined) p._autoFilled = false; // user touched other fields
    p.amountDue = this.calcAmountDue(p);
    await DriveStore.savePayments(doc);
    return p;
  },

  async confirmPayment(paymentId) {
    const doc = await DriveStore.readPayments();
    const p = doc.payments.find(x => x.id === paymentId);
    if (!p) throw new Error('Payment not found');
    p.status = 'paid';
    p.paidAt = new Date().toISOString();
    await DriveStore.savePayments(doc);
    return p;
  },

  async unconfirmPayment(paymentId) {
    const doc = await DriveStore.readPayments();
    const p = doc.payments.find(x => x.id === paymentId);
    if (!p) throw new Error('Payment not found');
    p.status = 'pending';
    p.paidAt = null;
    await DriveStore.savePayments(doc);
    return p;
  },

  async getRoomHistory(roomId) {
    const doc = await DriveStore.readPayments();
    return doc.payments
      .filter(p => p.roomId === roomId)
      .sort((a, b) => b.period.localeCompare(a.period));
  },

  /**
   * Migration: strip trường `imageThumbnail` (base64) khỏi tất cả meter readings cũ.
   * Trả về số lượng record đã clean. No-op nếu không có gì để strip.
   * Gọi 1 lần khi load app, hoặc trong `pullAll`.
   */
  async migrateMeterThumbnails() {
    const doc = await DriveStore.readMeters();
    let changed = 0;
    for (const m of doc.readings) {
      if ('imageThumbnail' in m && m.imageThumbnail) {
        delete m.imageThumbnail;
        changed++;
      } else if ('imageThumbnail' in m) {
        delete m.imageThumbnail;
      }
    }
    if (changed > 0) {
      await DriveStore.saveMeters(doc);
      console.log(`[migrate] Stripped ${changed} imageThumbnail base64 fields`);
    }
    return changed;
  },

  // ── Reminder state ────────────────────────────────────
  async getReminderState() {
    const K_ = await getUserKeys();
    const d = await chrome.storage.local.get(K_.REMINDER);
    return d[K_.REMINDER] || {};
  },
  async setReminderState(patch) {
    const K_ = await getUserKeys();
    const cur = await this.getReminderState();
    await chrome.storage.local.set({ [K_.REMINDER]: { ...cur, ...patch } });
  },

  // ── Full pull from Drive ──────────────────────────────
  async pullAll() { return DriveStore.pullAll(); }
};
