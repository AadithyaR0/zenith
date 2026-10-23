/**
 * ============================================================================
 * ZENITH — MINDFUL STRENGTH & LONGEVITY TRACKER (app.js)
 * Zero-Dependency, Offline-First iOS Safari Progressive Web App Engine
 * Features:
 *  - Dual-Layer Offline Vault (IndexedDB + Synchronous localStorage Mirror)
 *  - Persistent Storage Request (navigator.storage.persist)
 *  - Tiny Card-Top Micro-Toggles: Resize (Full / Mid / Mini) & Reorder (↑ / ↓)
 *  - Dual-Mode Backup & Restore: Compact Simple Mode + Nerdy Explain-Everything Mode
 *  - True OLED Black Topographic Theme + Editorial Serif / Mono Typography
 *  - Animated High-DPI Retina Canvas Chart (Raw Scale vs. 7-Day EMA Signal)
 *  - Subtle Translucent 7-Day Habit Strips, 28-Day Heatmap & Info (ⓘ) Popups
 *  - Simple Food Entry + Multi-Ingredient Meal Builder + Smart Food Memory
 *  - Hardened Security (XSS Sanitization, Prototype Pollution Guard, Checksums)
 * ============================================================================
 */

(function () {
  'use strict';
  if (window.__ZENITH_BOOTSTRAPPED__) return;
  window.__ZENITH_BOOTSTRAPPED__ = true;

  /* ------------------------------------------------------------------------
     1. CONSTANTS & DEFAULT CONFIGURATION
     ------------------------------------------------------------------------ */
  const DB_NAME = 'ZenithOfflineVaultDB';
  const DB_VERSION = 2;
  const SCHEMA_VERSION = 2;
  const APP_VERSION = '2.5.0';
  const KG_TO_LBS = 2.20462262185;
  const MAX_BACKUP_BYTES = 15 * 1024 * 1024; // 15 MB DoS guard
  const STORAGE_MIRROR_KEY = 'zenith_offline_vault_mirror_v2';
  const ROLLBACK_STORAGE_KEY = 'zenith_pre_restore_rollback_v2';

  const DEFAULT_DASHBOARD_ORDER = ['fastlog', 'macros', 'habits', 'snapshot'];
  const DEFAULT_DASHBOARD_SIZES = {
    fastlog: 'expanded',
    macros: 'expanded',
    habits: 'expanded',
    snapshot: 'expanded'
  };
  const VALID_SIZES = ['expanded', 'compact', 'summary'];
  const SIZE_MICRO_LABELS = {
    expanded: 'Full',
    compact: 'Mid',
    summary: 'Mini'
  };
  const SIZE_TOAST_LABELS = {
    expanded: 'Expanded (Full)',
    compact: 'Compact (Mid)',
    summary: 'Short Summary (Mini)'
  };

  const STOIC_SUBTITLES = [
    'Consistency compounds quietly.',
    'Signal over noise. Honor the daily rep.',
    'Recovery is where adaptation lives.',
    'Strength is built in unhurried decades.',
    'Calm execution. Let the trendline speak.',
    'Nourish the tissue. Respect the rest day.'
  ];

  const HABIT_THEMES = {
    terracotta: { icon: '🏋️', color: 'terracotta', hex: '#FF7B5A' },
    teal:       { icon: '💧', color: 'teal',       hex: '#56CFE1' },
    sage:       { icon: '🚶', color: 'sage',       hex: '#48D69D' },
    amber:      { icon: '🧘', color: 'amber',      hex: '#F7B955' },
    violet:     { icon: '⚡', color: 'violet',     hex: '#A68EFF' }
  };

  const DEFAULT_FOOD_MEMORY = [
    { name: 'Whey Isolate (1 scoop)', calories: 120, protein: 25, count: 8 },
    { name: 'Whole Eggs (2 large)', calories: 145, protein: 13, count: 7 },
    { name: 'Chicken Breast (150g cooked)', calories: 248, protein: 46, count: 7 },
    { name: 'Cooked Jasmine Rice (150g)', calories: 195, protein: 4, count: 6 },
    { name: 'Greek Yogurt 0% (200g)', calories: 120, protein: 20, count: 6 },
    { name: 'Sirloin Steak (200g)', calories: 410, protein: 54, count: 5 },
    { name: 'Rolled Oats (60g)', calories: 230, protein: 8, count: 5 },
    { name: 'Olive Oil (1 tbsp)', calories: 119, protein: 0, count: 4 },
    { name: 'Sourdough Toast (2 slices)', calories: 220, protein: 8, count: 4 },
    { name: 'Banana (1 medium)', calories: 105, protein: 1, count: 3 }
  ];

  const DEFAULT_SETTINGS = {
    calorieTarget: 2450,
    proteinTarget: 185,
    unit: 'kg', // 'kg' | 'lbs'
    goalWeightKg: 80.0,
    theme: 'dark', // 'auto' | 'light' | 'dark'
    instantTapFuel: false,
    vaultViewMode: 'simple', // 'simple' | 'nerdy'
    lastBackupDate: null,
    comebackStartDate: null,
    archivedComebacksCount: 0,
    shieldMonth: '', // 'YYYY-MM'
    shieldsRemaining: 2,
    shieldsUsedDates: [],
    foodMemory: DEFAULT_FOOD_MEMORY.slice(),
    dashboardOrder: DEFAULT_DASHBOARD_ORDER.slice(),
    dashboardSizes: Object.assign({}, DEFAULT_DASHBOARD_SIZES)
  };

  /* ------------------------------------------------------------------------
     2. SECURITY UTILITIES (XSS, PROTOTYPE POLLUTION, SCHEMA VALIDATION)
     ------------------------------------------------------------------------ */

  function escapeHTML(input) {
    if (input === null || input === undefined) return '';
    return String(input)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeJsonParse(rawString) {
    if (typeof rawString !== 'string' || rawString.length > MAX_BACKUP_BYTES) {
      throw new Error('Backup payload exceeds safe size limits or is invalid.');
    }
    return JSON.parse(rawString, function (key, value) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return undefined;
      }
      return value;
    });
  }

  function computeIntegrityHash(payloadObj) {
    const str = JSON.stringify({
      w: (payloadObj.weight_logs || []).length,
      f: (payloadObj.food_logs || []).length,
      h: (payloadObj.habits || []).length,
      s: payloadObj.user_settings ? payloadObj.user_settings.calorieTarget : 0
    });
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return 'fnv1a-' + (hash >>> 0).toString(16).padStart(8, '0');
  }

  function clampNumber(val, min, max, fallback) {
    const num = Number(val);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
  }

  function cleanText(str, maxLen = 120) {
    if (typeof str !== 'string') return '';
    return str.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, maxLen);
  }

  function isValidDateStr(dateStr) {
    return typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
  }

  /* ------------------------------------------------------------------------
     3. MICRO-INTERACTIONS: PARTICLE BURST
     ------------------------------------------------------------------------ */

  function spawnParticleBurst(originEl, customHex = '#48D69D') {
    if (!originEl || typeof originEl.getBoundingClientRect !== 'function') return;
    let layer = document.getElementById('particleBurstLayer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'particleBurstLayer';
      layer.className = 'particle-burst-layer';
      document.body.appendChild(layer);
    }

    const rect = originEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const palette = [customHex, '#F7B955', '#FF7B5A', '#48D69D', '#56CFE1'];

    for (let i = 0; i < 12; i++) {
      const dot = document.createElement('span');
      dot.className = 'burst-dot';
      const angle = (Math.PI * 2 * i) / 12 + (Math.random() - 0.5) * 0.35;
      const dist = 24 + Math.random() * 38;
      const tx = Math.cos(angle) * dist;
      const ty = Math.sin(angle) * dist;
      const size = 4.5 + Math.random() * 4.5;

      dot.style.width = `${size}px`;
      dot.style.height = `${size}px`;
      dot.style.left = `${cx - size / 2}px`;
      dot.style.top = `${cy - size / 2}px`;
      dot.style.background = palette[i % palette.length];
      dot.style.boxShadow = `0 0 6px ${palette[i % palette.length]}`;
      dot.style.setProperty('--tx', `${tx.toFixed(1)}px`);
      dot.style.setProperty('--ty', `${ty.toFixed(1)}px`);

      layer.appendChild(dot);
      setTimeout(() => {
        if (dot.parentNode) dot.parentNode.removeChild(dot);
      }, 720);
    }
  }

  /* ------------------------------------------------------------------------
     4. LOCAL DATE & UNIT HELPERS
     ------------------------------------------------------------------------ */

  function getLocalDateStr(dateObj = new Date()) {
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function getCurrentMonthStr(dateObj = new Date()) {
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }

  function shiftDateStr(baseDateStr, deltaDays) {
    const parts = baseDateStr.split('-').map(Number);
    const d = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
    d.setDate(d.getDate() + deltaDays);
    return getLocalDateStr(d);
  }

  function daysBetweenDateStrs(startStr, endStr) {
    const [y1, m1, d1] = startStr.split('-').map(Number);
    const [y2, m2, d2] = endStr.split('-').map(Number);
    const t1 = new Date(y1, m1 - 1, d1, 12, 0, 0).getTime();
    const t2 = new Date(y2, m2 - 1, d2, 12, 0, 0).getTime();
    return Math.round((t2 - t1) / 86400000);
  }

  function getStartOfISOWeekStr(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d, 12, 0, 0);
    const day = dt.getDay(); // 0 (Sun) to 6 (Sat)
    const diffToMonday = day === 0 ? -6 : 1 - day;
    dt.setDate(dt.getDate() + diffToMonday);
    return getLocalDateStr(dt);
  }

  function formatDisplayDate(dateStr) {
    if (!isValidDateStr(dateStr)) return dateStr;
    const today = getLocalDateStr();
    const yesterday = shiftDateStr(today, -1);
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d, 12, 0, 0);
    const shortFormatted = dt.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric'
    });
    if (dateStr === today) return `Today, ${shortFormatted}`;
    if (dateStr === yesterday) return `Yesterday, ${shortFormatted}`;
    return dt.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    });
  }

  function formatTimeFromTimestamp(ts) {
    const d = new Date(Number(ts) || Date.now());
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function kgToDisplay(kgVal, unit) {
    const n = Number(kgVal) || 0;
    return unit === 'lbs' ? Number((n * KG_TO_LBS).toFixed(1)) : Number(n.toFixed(1));
  }

  function displayToKg(displayVal, unit) {
    const n = Number(displayVal) || 0;
    return unit === 'lbs' ? Number((n / KG_TO_LBS).toFixed(3)) : Number(n.toFixed(3));
  }

  function formatWeight(kgVal, unit, includeUnit = true) {
    if (kgVal === null || kgVal === undefined || !Number.isFinite(Number(kgVal))) {
      return '--';
    }
    const converted = kgToDisplay(kgVal, unit).toFixed(1);
    return includeUnit ? `${converted} ${unit}` : converted;
  }

  function generateId(prefix = 'id') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /* ------------------------------------------------------------------------
     5. CROSS-VERSION RECORD SANITIZERS & DASHBOARD LAYOUT SANITIZER
     ------------------------------------------------------------------------ */

  function sanitizeWeightRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    let rawWeight = raw.weightKg !== undefined ? raw.weightKg : (raw.weight !== undefined ? raw.weight : raw.value);
    if (raw.unit === 'lbs' && raw.weightKg === undefined) {
      rawWeight = Number(rawWeight) / KG_TO_LBS;
    }
    const weightKg = clampNumber(rawWeight, 20, 400, null);
    if (weightKg === null) return null;

    let dateStr = raw.date;
    if (!isValidDateStr(dateStr)) {
      if (raw.timestamp) {
        dateStr = getLocalDateStr(new Date(Number(raw.timestamp)));
      } else {
        dateStr = getLocalDateStr();
      }
    }

    return {
      id: cleanText(raw.id || `w_${dateStr}`, 64),
      date: dateStr,
      weightKg: Number(weightKg.toFixed(3)),
      note: cleanText(raw.note || '', 80),
      timestamp: clampNumber(raw.timestamp, 946684800000, 4102444800000, Date.now())
    };
  }

  function sanitizeFoodSubItem(item) {
    if (!item || typeof item !== 'object') return null;
    const name = cleanText(item.name || 'Ingredient', 80);
    const calories = Math.round(clampNumber(item.calories, 0, 15000, 0));
    const protein = Math.round(clampNumber(item.protein, 0, 1000, 0));
    if (calories === 0 && protein === 0) return null;
    return { name, calories, protein };
  }

  function sanitizeFoodRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const calories = Math.round(
      clampNumber(raw.calories !== undefined ? raw.calories : raw.kcal, 0, 20000, 0)
    );
    const protein = Math.round(
      clampNumber(raw.protein !== undefined ? raw.protein : raw.proteinG, 0, 1500, 0)
    );
    if (calories === 0 && protein === 0) return null;

    const timestamp = clampNumber(raw.timestamp || raw.createdAt, 946684800000, 4102444800000, Date.now());
    const dateStr = isValidDateStr(raw.date) ? raw.date : getLocalDateStr(new Date(timestamp));
    const items = Array.isArray(raw.items) ? raw.items.map(sanitizeFoodSubItem).filter(Boolean) : [];

    return {
      id: cleanText(raw.id || generateId('food'), 64),
      date: dateStr,
      timestamp,
      calories,
      protein,
      note: cleanText(raw.note || raw.name || 'Food Entry', 120),
      items
    };
  }

  function sanitizeHabitRecord(raw, indexHint = 0) {
    if (!raw || typeof raw !== 'object') return null;
    const name = cleanText(raw.name || raw.title, 48);
    if (!name) return null;
    const weeklyTarget = Math.round(clampNumber(raw.weeklyTarget || raw.targetPerWeek || 4, 1, 7, 4));

    const themeKeys = Object.keys(HABIT_THEMES);
    const defaultColor = themeKeys[indexHint % themeKeys.length];
    const color = HABIT_THEMES[raw.color] ? raw.color : defaultColor;
    const icon = cleanText(raw.icon || HABIT_THEMES[color].icon, 8);

    const completedDates = Array.isArray(raw.completedDates)
      ? Array.from(new Set(raw.completedDates.filter(isValidDateStr))).sort()
      : [];
    const restDates = Array.isArray(raw.restDates)
      ? Array.from(new Set(raw.restDates.filter(isValidDateStr))).sort()
      : [];

    return {
      id: cleanText(raw.id || generateId('habit'), 64),
      name,
      weeklyTarget,
      color,
      icon,
      completedDates,
      restDates,
      createdAt: clampNumber(raw.createdAt, 946684800000, 4102444800000, Date.now())
    };
  }

  function sanitizeFoodMemoryItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = cleanText(raw.name, 80);
    if (!name) return null;
    const calories = Math.round(clampNumber(raw.calories, 0, 15000, 0));
    const protein = Math.round(clampNumber(raw.protein, 0, 1000, 0));
    if (calories === 0 && protein === 0) return null;
    return {
      name,
      calories,
      protein,
      count: Math.round(clampNumber(raw.count, 1, 9999, 1))
    };
  }

  function sanitizeDashboardOrder(rawOrder) {
    if (!Array.isArray(rawOrder)) return DEFAULT_DASHBOARD_ORDER.slice();
    const valid = rawOrder.filter((id) => DEFAULT_DASHBOARD_ORDER.includes(id));
    return Array.from(new Set([...valid, ...DEFAULT_DASHBOARD_ORDER]));
  }

  function sanitizeDashboardSizes(rawSizes) {
    const out = Object.assign({}, DEFAULT_DASHBOARD_SIZES);
    if (rawSizes && typeof rawSizes === 'object') {
      DEFAULT_DASHBOARD_ORDER.forEach((key) => {
        if (VALID_SIZES.includes(rawSizes[key])) {
          out[key] = rawSizes[key];
        }
      });
    }
    return out;
  }

  function sanitizeSettingsRecord(raw) {
    const merged = Object.assign({}, DEFAULT_SETTINGS, raw && typeof raw === 'object' ? raw : {});
    const currentMonth = getCurrentMonthStr();
    let shieldsRemaining = clampNumber(merged.shieldsRemaining, 0, 2, 2);
    let shieldsUsedDates = Array.isArray(merged.shieldsUsedDates)
      ? merged.shieldsUsedDates.filter(isValidDateStr)
      : [];

    if (merged.shieldMonth !== currentMonth) {
      shieldsRemaining = 2;
    }

    const rawMem = Array.isArray(merged.foodMemory) && merged.foodMemory.length > 0
      ? merged.foodMemory
      : DEFAULT_FOOD_MEMORY;
    const foodMemory = rawMem.map(sanitizeFoodMemoryItem).filter(Boolean).slice(0, 120);

    return {
      calorieTarget: Math.round(clampNumber(merged.calorieTarget, 800, 12000, 2450)),
      proteinTarget: Math.round(clampNumber(merged.proteinTarget, 30, 600, 185)),
      unit: merged.unit === 'lbs' ? 'lbs' : 'kg',
      goalWeightKg: Number(clampNumber(merged.goalWeightKg, 30, 350, 80.0).toFixed(2)),
      theme: ['auto', 'light', 'dark'].includes(merged.theme) ? merged.theme : 'dark',
      instantTapFuel: Boolean(merged.instantTapFuel),
      vaultViewMode: merged.vaultViewMode === 'nerdy' ? 'nerdy' : 'simple',
      lastBackupDate: isValidDateStr(merged.lastBackupDate) ? merged.lastBackupDate : null,
      comebackStartDate: isValidDateStr(merged.comebackStartDate) ? merged.comebackStartDate : null,
      archivedComebacksCount: Math.round(clampNumber(merged.archivedComebacksCount, 0, 999, 0)),
      shieldMonth: currentMonth,
      shieldsRemaining,
      shieldsUsedDates,
      foodMemory,
      dashboardOrder: sanitizeDashboardOrder(merged.dashboardOrder),
      dashboardSizes: sanitizeDashboardSizes(merged.dashboardSizes)
    };
  }

  /* ------------------------------------------------------------------------
     6. OFFLINE DATABASE ENGINE (INDEXEDDB + LOCALSTORAGE FALLBACK MIRROR)
     ------------------------------------------------------------------------ */

  const VaultDB = {
    db: null,
    usingFallback: false,
    isPersistent: false,

    readMirror() {
      try {
        const raw = window.localStorage.getItem(STORAGE_MIRROR_KEY);
        if (!raw) return null;
        return safeJsonParse(raw);
      } catch (e) {
        return null;
      }
    },

    writeMirror(stateSnapshot) {
      try {
        const payload = {
          schemaVersion: SCHEMA_VERSION,
          updatedAt: Date.now(),
          weight_logs: stateSnapshot.weightLogs,
          food_logs: stateSnapshot.foodLogs,
          habits: stateSnapshot.habits,
          user_settings: stateSnapshot.settings
        };
        window.localStorage.setItem(STORAGE_MIRROR_KEY, JSON.stringify(payload));
      } catch (e) {
        // Ignore quota or sandboxed iframe storage blocks
      }
    },

    async requestPersistence() {
      try {
        if (navigator.storage && navigator.storage.persist) {
          const granted = await navigator.storage.persist();
          this.isPersistent = Boolean(granted);
          return this.isPersistent;
        }
      } catch (e) {
        this.isPersistent = false;
      }
      return false;
    },

    async open() {
      await this.requestPersistence();

      if (!('indexedDB' in window)) {
        this.usingFallback = true;
        return null;
      }

      return new Promise((resolve) => {
        try {
          const req = window.indexedDB.open(DB_NAME, DB_VERSION);

          req.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('weight_logs')) {
              const wStore = db.createObjectStore('weight_logs', { keyPath: 'id' });
              wStore.createIndex('date', 'date', { unique: false });
            }
            if (!db.objectStoreNames.contains('food_logs')) {
              const fStore = db.createObjectStore('food_logs', { keyPath: 'id' });
              fStore.createIndex('date', 'date', { unique: false });
              fStore.createIndex('timestamp', 'timestamp', { unique: false });
            }
            if (!db.objectStoreNames.contains('habits')) {
              db.createObjectStore('habits', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('user_settings')) {
              db.createObjectStore('user_settings', { keyPath: 'key' });
            }
          };

          req.onsuccess = (event) => {
            this.db = event.target.result;
            this.usingFallback = false;
            resolve(this.db);
          };

          req.onerror = () => {
            this.usingFallback = true;
            resolve(null);
          };

          req.onblocked = () => {
            this.usingFallback = true;
            resolve(null);
          };
        } catch (err) {
          this.usingFallback = true;
          resolve(null);
        }
      });
    },

    async getAllFromStore(storeName) {
      if (!this.db || this.usingFallback) return null;
      return new Promise((resolve) => {
        try {
          const tx = this.db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve(null);
        } catch (e) {
          resolve(null);
        }
      });
    },

    async putRecord(storeName, record) {
      if (!this.db || this.usingFallback) return false;
      return new Promise((resolve) => {
        try {
          const tx = this.db.transaction(storeName, 'readwrite');
          const store = tx.objectStore(storeName);
          store.put(record);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        } catch (e) {
          resolve(false);
        }
      });
    },

    async deleteRecord(storeName, id) {
      if (!this.db || this.usingFallback) return false;
      return new Promise((resolve) => {
        try {
          const tx = this.db.transaction(storeName, 'readwrite');
          const store = tx.objectStore(storeName);
          store.delete(id);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        } catch (e) {
          resolve(false);
        }
      });
    },

    async replaceAllStores(stateSnapshot) {
      this.writeMirror(stateSnapshot);
      if (!this.db || this.usingFallback) return true;

      return new Promise((resolve) => {
        try {
          const tx = this.db.transaction(
            ['weight_logs', 'food_logs', 'habits', 'user_settings'],
            'readwrite'
          );
          const wStore = tx.objectStore('weight_logs');
          const fStore = tx.objectStore('food_logs');
          const hStore = tx.objectStore('habits');
          const sStore = tx.objectStore('user_settings');

          wStore.clear();
          fStore.clear();
          hStore.clear();
          sStore.clear();

          stateSnapshot.weightLogs.forEach((item) => wStore.put(item));
          stateSnapshot.foodLogs.forEach((item) => fStore.put(item));
          stateSnapshot.habits.forEach((item) => hStore.put(item));
          sStore.put({ key: 'profile', value: stateSnapshot.settings });

          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        } catch (e) {
          resolve(false);
        }
      });
    }
  };

  /* ------------------------------------------------------------------------
     7. APPLICATION STATE & SEED DATA
     ------------------------------------------------------------------------ */

  const AppState = {
    activeTab: 'today',
    fuelSelectedDay: 'today', // 'today' | 'yesterday'
    mealLoggerMode: 'simple', // 'simple' | 'builder'
    sheetMealLoggerMode: 'simple', // 'simple' | 'builder'
    builderIngredients: [], // [{ name, calories, protein }]
    sheetBuilderIngredients: [], // [{ name, calories, protein }]
    chartTimeframeDays: 30,
    restoreMode: 'merge', // 'merge' | 'replace'
    weightLogs: [],
    foodLogs: [],
    habits: [],
    settings: Object.assign({}, DEFAULT_SETTINGS),
    chartPointsCache: [],
    chartAnimProgress: 1,
    chartAnimFrame: null,
    pendingConfirmAction: null
  };

  function buildDefaultSeedState() {
    const today = getLocalDateStr();
    const yesterday = shiftDateStr(today, -1);

    const baseOffsets = [
      -24, -22, -21, -20, -19, -18, -17, -16, -15, -14, -13, -12,
      -11, -10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0
    ];
    const rawWeights = [
      83.6, 83.4, 83.8, 83.3, 83.1, 83.5, 83.0, 82.9, 83.2, 82.8, 82.6, 82.9,
      82.5, 82.4, 82.7, 82.3, 82.1, 82.4, 82.0, 81.9, 82.2, 81.8, 81.7, 81.6
    ];
    const sampleNotes = [
      'Morning fasted', 'Post leg day', 'High carb refeed', 'Morning fasted',
      'Rest day', 'Sodium meal', 'Morning fasted', 'Good sleep 8h'
    ];

    const weightLogs = baseOffsets.map((offset, idx) => {
      const dateStr = shiftDateStr(today, offset);
      return {
        id: `w_${dateStr}`,
        date: dateStr,
        weightKg: rawWeights[idx],
        note: sampleNotes[idx % sampleNotes.length],
        timestamp: Date.now() + offset * 86400000
      };
    });

    const now = Date.now();
    const foodLogs = [
      {
        id: generateId('food'),
        date: yesterday,
        timestamp: now - 86400000 - 3600000 * 8,
        calories: 680,
        protein: 52,
        note: 'Eggs, sourdough & black coffee',
        items: [
          { name: 'Whole Eggs (3 large)', calories: 215, protein: 19 },
          { name: 'Sourdough Toast (2 slices)', calories: 220, protein: 8 },
          { name: 'Whey Isolate (1 scoop)', calories: 245, protein: 25 }
        ]
      },
      {
        id: generateId('food'),
        date: yesterday,
        timestamp: now - 86400000 - 3600000 * 4,
        calories: 920,
        protein: 74,
        note: 'Grilled chicken lunch bowl',
        items: []
      },
      {
        id: generateId('food'),
        date: yesterday,
        timestamp: now - 86400000 - 3600000 * 1,
        calories: 790,
        protein: 60,
        note: 'Sirloin steak, roasted potatoes & Greek yogurt',
        items: []
      },
      {
        id: generateId('food'),
        date: today,
        timestamp: now - 3600000 * 5,
        calories: 570,
        protein: 53,
        note: 'Morning Protein Oats',
        items: [
          { name: 'Rolled Oats (60g)', calories: 230, protein: 8 },
          { name: 'Whey Isolate (1.5 scoops)', calories: 180, protein: 37 },
          { name: 'Greek Yogurt (150g)', calories: 160, protein: 8 }
        ]
      },
      {
        id: generateId('food'),
        date: today,
        timestamp: now - 3600000 * 2,
        calories: 762,
        protein: 66,
        note: 'Post-Lift Lunch Bowl',
        items: [
          { name: 'Chicken Breast (200g)', calories: 330, protein: 62 },
          { name: 'Cooked Jasmine Rice (200g)', calories: 260, protein: 4 },
          { name: 'Olive Oil (1.5 tbsp)', calories: 172, protein: 0 }
        ]
      }
    ];

    const recentCompletedGym = [-18, -16, -13, -11, -9, -7, -5, -3, -1, 0].map((d) => shiftDateStr(today, d));
    const recentRestGym = [-12, -10, -6, -4, -2].map((d) => shiftDateStr(today, d));
    const recentHydration = [-14, -12, -10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0].map((d) => shiftDateStr(today, d));
    const recentWalk = [-11, -9, -8, -7, -5, -4, -3, -2, -1].map((d) => shiftDateStr(today, d));
    const recentMobility = [-10, -7, -6, -5, -4, -3, -2, -1, 0].map((d) => shiftDateStr(today, d));

    const habits = [
      {
        id: 'habit_gym',
        name: 'Gym / Heavy Lifting',
        weeklyTarget: 4,
        color: 'terracotta',
        icon: '🏋️',
        completedDates: recentCompletedGym,
        restDates: recentRestGym,
        createdAt: now - 86400000 * 30
      },
      {
        id: 'habit_hydration',
        name: 'Hydration (3.5L + Electrolytes)',
        weeklyTarget: 7,
        color: 'teal',
        icon: '💧',
        completedDates: recentHydration,
        restDates: [],
        createdAt: now - 86400000 * 30
      },
      {
        id: 'habit_walk',
        name: 'Daily Walk (8k+ Steps)',
        weeklyTarget: 6,
        color: 'sage',
        icon: '🚶',
        completedDates: recentWalk,
        restDates: [shiftDateStr(today, -6)],
        createdAt: now - 86400000 * 30
      },
      {
        id: 'habit_mobility',
        name: 'Creatine & Mobility Flow',
        weeklyTarget: 7,
        color: 'amber',
        icon: '🧘',
        completedDates: recentMobility,
        restDates: [],
        createdAt: now - 86400000 * 30
      }
    ];

    return {
      weightLogs,
      foodLogs,
      habits,
      settings: sanitizeSettingsRecord(DEFAULT_SETTINGS)
    };
  }

  async function loadInitialData() {
    await VaultDB.open();

    const [idbWeights, idbFoods, idbHabits, idbSettingsArr] = await Promise.all([
      VaultDB.getAllFromStore('weight_logs'),
      VaultDB.getAllFromStore('food_logs'),
      VaultDB.getAllFromStore('habits'),
      VaultDB.getAllFromStore('user_settings')
    ]);

    const mirror = VaultDB.readMirror();

    const hasIdbData =
      (Array.isArray(idbWeights) && idbWeights.length > 0) ||
      (Array.isArray(idbFoods) && idbFoods.length > 0) ||
      (Array.isArray(idbHabits) && idbHabits.length > 0);

    if (hasIdbData) {
      AppState.weightLogs = (idbWeights || []).map(sanitizeWeightRecord).filter(Boolean);
      AppState.foodLogs = (idbFoods || []).map(sanitizeFoodRecord).filter(Boolean);
      AppState.habits = (idbHabits || []).map((h, i) => sanitizeHabitRecord(h, i)).filter(Boolean);
      const profileSetting = (idbSettingsArr || []).find((s) => s.key === 'profile');
      AppState.settings = sanitizeSettingsRecord(profileSetting ? profileSetting.value : DEFAULT_SETTINGS);
      syncPastFoodsIntoMemory();
      VaultDB.writeMirror(AppState);
      return;
    }

    if (mirror && (mirror.weight_logs || mirror.food_logs || mirror.habits)) {
      AppState.weightLogs = (mirror.weight_logs || []).map(sanitizeWeightRecord).filter(Boolean);
      AppState.foodLogs = (mirror.food_logs || []).map(sanitizeFoodRecord).filter(Boolean);
      AppState.habits = (mirror.habits || []).map((h, i) => sanitizeHabitRecord(h, i)).filter(Boolean);
      AppState.settings = sanitizeSettingsRecord(mirror.user_settings);
      syncPastFoodsIntoMemory();
      await VaultDB.replaceAllStores(AppState);
      return;
    }

    const seeded = buildDefaultSeedState();
    AppState.weightLogs = seeded.weightLogs;
    AppState.foodLogs = seeded.foodLogs;
    AppState.habits = seeded.habits;
    AppState.settings = seeded.settings;
    syncPastFoodsIntoMemory();
    await VaultDB.replaceAllStores(AppState);
  }

  async function persistAllState() {
    VaultDB.writeMirror(AppState);
    await VaultDB.replaceAllStores(AppState);
  }

  /* ------------------------------------------------------------------------
     8. TINY CARD-TOP RESIZE (FULL/MID/MINI) & REORDER (↑/↓) ENGINE
     ------------------------------------------------------------------------ */

  const WIDGET_DOM_ID_MAP = {
    fastlog: 'widgetFastLog',
    macros: 'widgetMacros',
    habits: 'widgetHabits',
    snapshot: 'widgetSnapshot'
  };

  function applyDashboardLayoutToDOM() {
    const stackEl = document.getElementById('dashboardWidgetsStack');
    if (!stackEl) return;

    const order = sanitizeDashboardOrder(AppState.settings.dashboardOrder);
    const sizes = sanitizeDashboardSizes(AppState.settings.dashboardSizes);
    AppState.settings.dashboardOrder = order;
    AppState.settings.dashboardSizes = sizes;

    order.forEach((widgetKey, idx) => {
      const domId = WIDGET_DOM_ID_MAP[widgetKey];
      const widgetEl = document.getElementById(domId);
      if (!widgetEl) return;

      const sizeVal = sizes[widgetKey] || 'expanded';
      widgetEl.setAttribute('data-size', sizeVal);
      stackEl.appendChild(widgetEl);

      // Update tiny resize toggle label (Full / Mid / Mini)
      const resizeLabel = widgetEl.querySelector('.micro-size-label');
      if (resizeLabel) {
        resizeLabel.textContent = SIZE_MICRO_LABELS[sizeVal] || 'Full';
      }

      // Enable/disable tiny Up & Down buttons at boundaries
      const upBtn = widgetEl.querySelector('.micro-move-btn[data-dir="-1"]');
      const downBtn = widgetEl.querySelector('.micro-move-btn[data-dir="1"]');
      if (upBtn) upBtn.disabled = idx === 0;
      if (downBtn) downBtn.disabled = idx === order.length - 1;
    });
  }

  async function cycleWidgetSize(widgetKey) {
    if (!DEFAULT_DASHBOARD_ORDER.includes(widgetKey)) return;
    const sizes = sanitizeDashboardSizes(AppState.settings.dashboardSizes);
    const current = sizes[widgetKey] || 'expanded';
    const nextIdx = (VALID_SIZES.indexOf(current) + 1) % VALID_SIZES.length;
    const nextSize = VALID_SIZES[nextIdx];

    sizes[widgetKey] = nextSize;
    AppState.settings.dashboardSizes = sizes;
    applyDashboardLayoutToDOM();

    await VaultDB.putRecord('user_settings', { key: 'profile', value: AppState.settings });
    VaultDB.writeMirror(AppState);
    showToast(`Card view: ${SIZE_TOAST_LABELS[nextSize]}`);
  }

  async function moveDashboardWidget(widgetKey, directionDelta) {
    const order = sanitizeDashboardOrder(AppState.settings.dashboardOrder);
    const idx = order.indexOf(widgetKey);
    if (idx < 0) return;
    const targetIdx = idx + directionDelta;
    if (targetIdx < 0 || targetIdx >= order.length) return;

    const temp = order[idx];
    order[idx] = order[targetIdx];
    order[targetIdx] = temp;

    AppState.settings.dashboardOrder = order;
    applyDashboardLayoutToDOM();

    const movedDom = document.getElementById(WIDGET_DOM_ID_MAP[widgetKey]);
    if (movedDom) {
      movedDom.classList.remove('pulse-confirm');
      void movedDom.offsetWidth;
      movedDom.classList.add('pulse-confirm');
    }

    await VaultDB.putRecord('user_settings', { key: 'profile', value: AppState.settings });
    VaultDB.writeMirror(AppState);
  }

  async function resetDashboardLayout() {
    AppState.settings.dashboardOrder = DEFAULT_DASHBOARD_ORDER.slice();
    AppState.settings.dashboardSizes = Object.assign({}, DEFAULT_DASHBOARD_SIZES);
    applyDashboardLayoutToDOM();
    await VaultDB.putRecord('user_settings', { key: 'profile', value: AppState.settings });
    VaultDB.writeMirror(AppState);
    showToast('Dashboard cards reset to default');
  }

  /* ------------------------------------------------------------------------
     9. SMART FOOD MEMORY & SEARCH AUTOCOMPLETE ENGINE
     ------------------------------------------------------------------------ */

  function rememberFoodItem(nameStr, caloriesVal, proteinVal) {
    const cleanName = cleanText(nameStr, 80);
    if (!cleanName || /^Quick \+/i.test(cleanName) || /^Food Entry/i.test(cleanName)) return;
    const calories = Math.round(clampNumber(caloriesVal, 0, 15000, 0));
    const protein = Math.round(clampNumber(proteinVal, 0, 1000, 0));
    if (calories === 0 && protein === 0) return;

    if (!Array.isArray(AppState.settings.foodMemory)) {
      AppState.settings.foodMemory = DEFAULT_FOOD_MEMORY.slice();
    }

    const lower = cleanName.toLowerCase();
    const existing = AppState.settings.foodMemory.find((m) => m.name.toLowerCase() === lower);
    if (existing) {
      existing.calories = calories;
      existing.protein = protein;
      existing.count = (existing.count || 1) + 1;
    } else {
      AppState.settings.foodMemory.unshift({
        name: cleanName,
        calories,
        protein,
        count: 2
      });
    }

    AppState.settings.foodMemory.sort((a, b) => (b.count || 1) - (a.count || 1));
    AppState.settings.foodMemory = AppState.settings.foodMemory.slice(0, 120);
  }

  function syncPastFoodsIntoMemory() {
    AppState.foodLogs.forEach((f) => {
      if (f.note) rememberFoodItem(f.note, f.calories, f.protein);
      if (Array.isArray(f.items)) {
        f.items.forEach((it) => rememberFoodItem(it.name, it.calories, it.protein));
      }
    });
  }

  function searchFoodMemory(queryStr, limit = 6) {
    const mem = AppState.settings.foodMemory || DEFAULT_FOOD_MEMORY;
    const q = (queryStr || '').trim().toLowerCase();
    if (!q) {
      return mem.slice(0, limit);
    }
    return mem
      .filter((item) => item.name.toLowerCase().includes(q))
      .slice(0, limit);
  }

  function renderMemorySuggestionTray(trayId, queryStr, onSelectCallback) {
    const tray = document.getElementById(trayId);
    if (!tray) return;
    tray.innerHTML = '';

    const matches = searchFoodMemory(queryStr, 6);
    matches.forEach((item) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'suggestion-chip';
      const macroParts = [];
      if (item.calories > 0) macroParts.push(`${item.calories} kcal`);
      if (item.protein > 0) macroParts.push(`${item.protein}g P`);

      chip.innerHTML = `
        <span>${escapeHTML(item.name)}</span>
        <span class="suggestion-chip-macros num">${escapeHTML(macroParts.join(' • '))}</span>
      `;
      chip.addEventListener('click', () => onSelectCallback(item, chip));
      tray.appendChild(chip);
    });
  }

  function renderAllFoodMemoryTrays() {
    const simpleSearch = document.getElementById('fuelNoteInput');
    renderMemorySuggestionTray(
      'fuelMemoryTray',
      simpleSearch ? simpleSearch.value : '',
      (item, chipEl) => {
        spawnParticleBurst(chipEl, '#FF7B5A');
        document.getElementById('fuelNoteInput').value = item.name;
        document.getElementById('fuelCalInput').value = item.calories || '';
        document.getElementById('fuelProInput').value = item.protein || '';
        renderAllFoodMemoryTrays();
      }
    );

    const builderSearch = document.getElementById('builderIngNameInput');
    renderMemorySuggestionTray(
      'builderMemoryTray',
      builderSearch ? builderSearch.value : '',
      (item, chipEl) => {
        spawnParticleBurst(chipEl, '#48D69D');
        AppState.builderIngredients.push({
          name: item.name,
          calories: item.calories,
          protein: item.protein
        });
        document.getElementById('builderIngNameInput').value = '';
        document.getElementById('builderIngCalInput').value = '';
        document.getElementById('builderIngProInput').value = '';
        renderMealBuilderDrafts(false);
        renderAllFoodMemoryTrays();
      }
    );

    const sheetSimpleSearch = document.getElementById('sheetFuelNoteInput');
    renderMemorySuggestionTray(
      'sheetMemoryTray',
      sheetSimpleSearch ? sheetSimpleSearch.value : '',
      (item, chipEl) => {
        spawnParticleBurst(chipEl, '#FF7B5A');
        document.getElementById('sheetFuelNoteInput').value = item.name;
        document.getElementById('sheetFuelCalInput').value = item.calories || '';
        document.getElementById('sheetFuelProInput').value = item.protein || '';
        renderAllFoodMemoryTrays();
      }
    );

    const sheetBuilderSearch = document.getElementById('sheetBuilderIngNameInput');
    renderMemorySuggestionTray(
      'sheetBuilderMemoryTray',
      sheetBuilderSearch ? sheetBuilderSearch.value : '',
      (item, chipEl) => {
        spawnParticleBurst(chipEl, '#48D69D');
        AppState.sheetBuilderIngredients.push({
          name: item.name,
          calories: item.calories,
          protein: item.protein
        });
        document.getElementById('sheetBuilderIngNameInput').value = '';
        document.getElementById('sheetBuilderIngCalInput').value = '';
        document.getElementById('sheetBuilderIngProInput').value = '';
        renderMealBuilderDrafts(true);
        renderAllFoodMemoryTrays();
      }
    );
  }

  function renderMealBuilderDrafts(inSheet = false) {
    const listId = inSheet ? 'sheetBuilderIngredientList' : 'builderIngredientList';
    const countId = inSheet ? 'sheetBuilderSumCountText' : 'builderSumCountText';
    const sumId = inSheet ? 'sheetBuilderSumMacrosText' : 'builderSumMacrosText';
    const items = inSheet ? AppState.sheetBuilderIngredients : AppState.builderIngredients;

    const listEl = document.getElementById(listId);
    const countEl = document.getElementById(countId);
    const sumEl = document.getElementById(sumId);

    const totalCal = items.reduce((s, i) => s + (i.calories || 0), 0);
    const totalPro = items.reduce((s, i) => s + (i.protein || 0), 0);

    if (countEl) {
      countEl.textContent = `${items.length} ${items.length === 1 ? 'ingredient' : 'ingredients'}`;
    }
    if (sumEl) {
      sumEl.textContent = `Total: ${totalCal.toLocaleString()} kcal • ${totalPro}g P`;
    }

    if (!listEl) return;
    listEl.innerHTML = '';

    items.forEach((ing, idx) => {
      const row = document.createElement('div');
      row.className = 'ingredient-draft-row';
      row.innerHTML = `
        <span class="ingredient-draft-name">${escapeHTML(ing.name)}</span>
        <div class="ingredient-draft-right">
          <span class="ingredient-draft-macros num">${ing.calories} kcal • ${ing.protein}g P</span>
          <button type="button" class="mini-action-btn spring-btn dup-ing-btn" title="Add another portion (+1x)" aria-label="Duplicate ingredient" style="width:28px;height:28px;font-size:0.72rem;font-weight:700;">+1</button>
          <button type="button" class="mini-action-btn delete-btn spring-btn rem-ing-btn" title="Remove ingredient" aria-label="Remove ingredient" style="width:28px;height:28px;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      `;

      row.querySelector('.dup-ing-btn').addEventListener('click', () => {
        items.push({ name: ing.name, calories: ing.calories, protein: ing.protein });
        renderMealBuilderDrafts(inSheet);
      });
      row.querySelector('.rem-ing-btn').addEventListener('click', () => {
        items.splice(idx, 1);
        renderMealBuilderDrafts(inSheet);
      });

      listEl.appendChild(row);
    });
  }

  /* ------------------------------------------------------------------------
     10. 7-DAY EXPONENTIAL MOVING AVERAGE (EMA) & TREND ANALYTICS ENGINE
     ------------------------------------------------------------------------ */

  function computeWeightSeriesWithEMA() {
    const byDateMap = new Map();
    for (const item of AppState.weightLogs) {
      const existing = byDateMap.get(item.date);
      if (!existing || item.timestamp >= existing.timestamp) {
        byDateMap.set(item.date, item);
      }
    }

    const sorted = Array.from(byDateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    const alpha = 2 / (7 + 1); // 0.25 smoothing constant for 7-day EMA
    let runningEma = null;
    let prevDate = null;

    return sorted.map((entry) => {
      if (runningEma === null) {
        runningEma = entry.weightKg;
      } else {
        const gapDays = Math.max(1, Math.min(14, daysBetweenDateStrs(prevDate, entry.date)));
        for (let d = 0; d < gapDays; d++) {
          runningEma = alpha * entry.weightKg + (1 - alpha) * runningEma;
        }
      }
      prevDate = entry.date;
      const emaKg = Number(runningEma.toFixed(3));
      const deltaFromEmaKg = Number((entry.weightKg - emaKg).toFixed(3));
      return Object.assign({}, entry, {
        emaKg,
        deltaFromEmaKg
      });
    });
  }

  function computeWeightAnalytics(series) {
    if (!series || series.length === 0) {
      return {
        latest: null,
        weeklyRateKg: null,
        zoneLabel: 'Log 3+ days for trend',
        goalTrajectoryText: 'Log weight to project'
      };
    }

    const latest = series[series.length - 1];
    let weeklyRateKg = null;

    if (series.length >= 2) {
      let anchor = series[0];
      for (let i = series.length - 2; i >= 0; i--) {
        const span = daysBetweenDateStrs(series[i].date, latest.date);
        anchor = series[i];
        if (span >= 7) break;
      }
      const spanDays = Math.max(1, daysBetweenDateStrs(anchor.date, latest.date));
      const emaDiff = latest.emaKg - anchor.emaKg;
      weeklyRateKg = Number(((emaDiff / spanDays) * 7).toFixed(2));
    }

    let zoneLabel = 'True tissue signal';
    if (weeklyRateKg !== null) {
      if (Math.abs(weeklyRateKg) < 0.08) {
        zoneLabel = 'Steady Maintenance';
      } else if (weeklyRateKg < 0 && weeklyRateKg >= -0.65) {
        zoneLabel = 'Sustainable Cut Pace';
      } else if (weeklyRateKg < -0.65) {
        zoneLabel = 'Aggressive Deficit';
      } else if (weeklyRateKg > 0 && weeklyRateKg <= 0.35) {
        zoneLabel = 'Controlled Lean Gain';
      } else {
        zoneLabel = 'Surplus / Glycogen Fill';
      }
    }

    const goalKg = AppState.settings.goalWeightKg;
    const distKg = goalKg - latest.emaKg;
    let goalTrajectoryText = 'At Goal Weight';

    if (Math.abs(distKg) < 0.25) {
      goalTrajectoryText = 'Target zone achieved';
    } else if (weeklyRateKg === null || Math.abs(weeklyRateKg) < 0.04) {
      const unit = AppState.settings.unit;
      const absDist = formatWeight(Math.abs(distKg), unit, true);
      goalTrajectoryText = `${absDist} ${distKg < 0 ? 'to lose' : 'to gain'}`;
    } else {
      const movingTowardGoal = (distKg < 0 && weeklyRateKg < 0) || (distKg > 0 && weeklyRateKg > 0);
      if (movingTowardGoal) {
        const weeksLeft = Math.min(99, Math.max(1, Math.round(Math.abs(distKg / weeklyRateKg))));
        const estDateStr = shiftDateStr(latest.date, weeksLeft * 7);
        const [y, m, d] = estDateStr.split('-').map(Number);
        const estDateFormatted = new Date(y, m - 1, d).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric'
        });
        goalTrajectoryText = `~${weeksLeft}w (${estDateFormatted})`;
      } else {
        const unit = AppState.settings.unit;
        const absDist = formatWeight(Math.abs(distKg), unit, true);
        goalTrajectoryText = `${absDist} from target`;
      }
    }

    return {
      latest,
      weeklyRateKg,
      zoneLabel,
      goalTrajectoryText
    };
  }

  /* ------------------------------------------------------------------------
     11. ANIMATED HIGH-DPI RETINA CANVAS CHART ENGINE
     ------------------------------------------------------------------------ */

  function animateWeightTrendChart() {
    if (AppState.chartAnimFrame) {
      cancelAnimationFrame(AppState.chartAnimFrame);
    }
    const start = performance.now();
    const duration = 520;

    function frame(now) {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / duration);
      AppState.chartAnimProgress = 1 - Math.pow(1 - t, 3);
      renderWeightTrendChart(null);
      if (t < 1) {
        AppState.chartAnimFrame = requestAnimationFrame(frame);
      }
    }
    AppState.chartAnimFrame = requestAnimationFrame(frame);
  }

  function renderWeightTrendChart(scrubIndex = null) {
    const canvas = document.getElementById('weightTrendCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const cssWidth = Math.max(260, rect.width || 320);
    const cssHeight = Math.max(180, rect.height || 220);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);

    if (canvas.width !== Math.round(cssWidth * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const computedStyle = getComputedStyle(document.documentElement);
    const colorTerracotta = computedStyle.getPropertyValue('--accent-terracotta').trim() || '#FF7B5A';
    const colorSage = computedStyle.getPropertyValue('--accent-sage').trim() || '#48D69D';
    const colorAmber = computedStyle.getPropertyValue('--accent-amber').trim() || '#F7B955';
    const colorMuted = computedStyle.getPropertyValue('--text-muted').trim() || '#6E7A8A';
    const colorPrimary = computedStyle.getPropertyValue('--text-primary').trim() || '#F5F2EB';
    const colorBorder = computedStyle.getPropertyValue('--border-subtle').trim() || 'rgba(255,255,255,0.08)';

    const fullSeries = computeWeightSeriesWithEMA();
    const todayStr = getLocalDateStr();
    const cutoffStr = shiftDateStr(todayStr, -AppState.chartTimeframeDays + 1);
    const filtered = fullSeries.filter((item) => item.date >= cutoffStr);
    const points = filtered.length > 0 ? filtered : fullSeries.slice(-Math.min(10, fullSeries.length));

    const countEl = document.getElementById('chartPointCountText');
    if (countEl) {
      countEl.textContent = `${points.length} ${points.length === 1 ? 'entry' : 'entries'}`;
    }

    if (points.length === 0) {
      ctx.fillStyle = colorMuted;
      ctx.font = '600 13px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Log your first scale weight to visualize your 7-day EMA curve.', cssWidth / 2, cssHeight / 2);
      ctx.restore();
      AppState.chartPointsCache = [];
      return;
    }

    const unit = AppState.settings.unit;
    const goalDisplay = kgToDisplay(AppState.settings.goalWeightKg, unit);

    const rawValues = points.map((p) => kgToDisplay(p.weightKg, unit));
    const emaValues = points.map((p) => kgToDisplay(p.emaKg, unit));
    const allVals = [...rawValues, ...emaValues];
    if (Math.abs(goalDisplay - allVals[allVals.length - 1]) <= (unit === 'lbs' ? 18 : 8)) {
      allVals.push(goalDisplay);
    }

    let minVal = Math.min(...allVals);
    let maxVal = Math.max(...allVals);
    if (maxVal - minVal < 1.2) {
      minVal -= 0.8;
      maxVal += 0.8;
    } else {
      const pad = (maxVal - minVal) * 0.18;
      minVal -= pad;
      maxVal += pad;
    }

    const padLeft = 44;
    const padRight = 16;
    const padTop = 18;
    const padBottom = 28;
    const plotW = cssWidth - padLeft - padRight;
    const plotH = cssHeight - padTop - padBottom;

    const getX = (idx) => {
      if (points.length === 1) return padLeft + plotW / 2;
      return padLeft + (idx / (points.length - 1)) * plotW;
    };
    const getY = (val) => {
      const ratio = (val - minVal) / (maxVal - minVal || 1);
      return padTop + plotH - ratio * plotH;
    };

    const gridSteps = 3;
    ctx.lineWidth = 1;
    ctx.font = '600 10.5px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let i = 0; i <= gridSteps; i++) {
      const val = minVal + ((maxVal - minVal) * i) / gridSteps;
      const y = getY(val);
      ctx.strokeStyle = colorBorder;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(cssWidth - padRight, y);
      ctx.stroke();

      ctx.fillStyle = colorMuted;
      ctx.fillText(val.toFixed(1), padLeft - 8, y);
    }

    if (goalDisplay >= minVal && goalDisplay <= maxVal) {
      const goalY = getY(goalDisplay);
      ctx.save();
      ctx.strokeStyle = colorAmber;
      ctx.lineWidth = 1.4;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(padLeft, goalY);
      ctx.lineTo(cssWidth - padRight, goalY);
      ctx.stroke();
      ctx.restore();
    }

    const coords = points.map((p, idx) => ({
      x: getX(idx),
      rawY: getY(rawValues[idx]),
      emaY: getY(emaValues[idx]),
      rawVal: rawValues[idx],
      emaVal: emaValues[idx],
      date: p.date,
      note: p.note
    }));
    AppState.chartPointsCache = coords;

    const revealW = padLeft + plotW * (AppState.chartAnimProgress || 1) + padRight;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, revealW, cssHeight);
    ctx.clip();

    if (coords.length > 1) {
      ctx.save();
      ctx.strokeStyle = colorTerracotta;
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      coords.forEach((pt, idx) => {
        if (idx === 0) ctx.moveTo(pt.x, pt.rawY);
        else ctx.lineTo(pt.x, pt.rawY);
      });
      ctx.stroke();
      ctx.restore();
    }

    if (coords.length > 1) {
      const grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
      grad.addColorStop(0, 'rgba(72, 214, 157, 0.30)');
      grad.addColorStop(1, 'rgba(72, 214, 157, 0.0)');

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(coords[0].x, coords[0].emaY);
      for (let i = 0; i < coords.length - 1; i++) {
        const curr = coords[i];
        const next = coords[i + 1];
        const midX = (curr.x + next.x) / 2;
        const midY = (curr.emaY + next.emaY) / 2;
        ctx.quadraticCurveTo(curr.x, curr.emaY, midX, midY);
      }
      const last = coords[coords.length - 1];
      ctx.lineTo(last.x, last.emaY);

      ctx.strokeStyle = colorSage;
      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = 'rgba(72, 214, 157, 0.40)';
      ctx.shadowBlur = 8;
      ctx.stroke();

      ctx.shadowBlur = 0;
      ctx.lineTo(last.x, padTop + plotH);
      ctx.lineTo(coords[0].x, padTop + plotH);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
    }

    coords.forEach((pt, idx) => {
      ctx.beginPath();
      ctx.arc(pt.x, pt.rawY, coords.length > 40 ? 2.4 : 3.6, 0, Math.PI * 2);
      ctx.fillStyle = colorTerracotta;
      ctx.fill();

      if (idx === coords.length - 1 || idx === scrubIndex) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.emaY, 5.5, 0, Math.PI * 2);
        ctx.fillStyle = colorSage;
        ctx.fill();
        ctx.lineWidth = 2.2;
        ctx.strokeStyle = '#FFFFFF';
        ctx.stroke();
      }
    });

    ctx.restore();

    ctx.fillStyle = colorMuted;
    ctx.font = '600 10px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.textBaseline = 'top';
    const labelIndices = coords.length === 1
      ? [0]
      : coords.length <= 4
      ? [0, coords.length - 1]
      : [0, Math.floor((coords.length - 1) / 2), coords.length - 1];

    labelIndices.forEach((idx, pos) => {
      const pt = coords[idx];
      const [y, m, d] = pt.date.split('-').map(Number);
      const label = new Date(y, m - 1, d).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric'
      });
      ctx.textAlign = pos === 0 ? 'left' : pos === labelIndices.length - 1 ? 'right' : 'center';
      ctx.fillText(label, pt.x, padTop + plotH + 8);
    });

    if (scrubIndex !== null && coords[scrubIndex]) {
      const activePt = coords[scrubIndex];
      ctx.save();
      ctx.strokeStyle = colorPrimary;
      ctx.globalAlpha = 0.32;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(activePt.x, padTop);
      ctx.lineTo(activePt.x, padTop + plotH);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  /* ------------------------------------------------------------------------
     12. TRANSPARENT HABIT ADHERENCE & INFO (ⓘ) EXPLAINER ENGINE
     ------------------------------------------------------------------------ */

  const DAY_SHORT_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  function getHabitWeeklyStatus(habit, referenceDateStr = getLocalDateStr()) {
    const mondayStr = getStartOfISOWeekStr(referenceDateStr);
    let completedThisWeek = 0;
    let restThisWeek = 0;
    const weekDays = [];

    for (let i = 0; i < 7; i++) {
      const dStr = shiftDateStr(mondayStr, i);
      const isDone = habit.completedDates.includes(dStr);
      const isRest = !isDone && habit.restDates.includes(dStr);
      if (isDone) completedThisWeek++;
      if (isRest) restThisWeek++;
      weekDays.push({
        dateStr: dStr,
        shortLabel: DAY_SHORT_LABELS[i],
        isToday: dStr === referenceDateStr,
        isDone,
        isRest
      });
    }

    const completedToday = habit.completedDates.includes(referenceDateStr);
    const isRestToday = habit.restDates.includes(referenceDateStr);
    const allowedRestDays = Math.max(0, 7 - habit.weeklyTarget);

    return {
      completedThisWeek,
      restThisWeek,
      weeklyTarget: habit.weeklyTarget,
      completedToday,
      isRestToday,
      allowedRestDays,
      targetMetThisWeek: completedThisWeek >= habit.weeklyTarget,
      weekDays
    };
  }

  function computeConsistencyDetails(windowDays) {
    if (!AppState.habits || AppState.habits.length === 0) {
      return {
        scorePct: 100,
        totalEarned: 0,
        totalExpected: 0,
        effectiveDays: windowDays,
        perHabitBreakdown: []
      };
    }

    const todayStr = getLocalDateStr();
    let earliestHabitDate = todayStr;
    AppState.habits.forEach((h) => {
      if (h.completedDates.length > 0 && h.completedDates[0] < earliestHabitDate) {
        earliestHabitDate = h.completedDates[0];
      }
    });
    const historySpan = Math.max(7, daysBetweenDateStrs(earliestHabitDate, todayStr) + 1);
    let effectiveDays = Math.min(windowDays, historySpan);

    if (AppState.settings.comebackStartDate) {
      const daysSinceComeback = Math.max(1, daysBetweenDateStrs(AppState.settings.comebackStartDate, todayStr) + 1);
      effectiveDays = Math.min(windowDays, daysSinceComeback);
    }

    const startStr = shiftDateStr(todayStr, -effectiveDays + 1);
    const shieldBonus = (AppState.settings.shieldsUsedDates || []).filter(
      (d) => d >= startStr && d <= todayStr
    ).length;

    let totalEarnedPoints = 0;
    let totalExpectedPoints = 0;
    const perHabitBreakdown = [];

    for (const habit of AppState.habits) {
      const expectedInWindow = Math.max(1, Number(((habit.weeklyTarget / 7) * effectiveDays).toFixed(1)));
      totalExpectedPoints += expectedInWindow;

      let completedInWindow = 0;
      for (let i = 0; i < effectiveDays; i++) {
        const dStr = shiftDateStr(startStr, i);
        if (habit.completedDates.includes(dStr)) {
          completedInWindow++;
        }
      }

      const earned = Math.min(
        expectedInWindow,
        completedInWindow + shieldBonus
      );
      totalEarnedPoints += earned;

      const habitPct = Math.min(100, Math.round((earned / expectedInWindow) * 100));
      perHabitBreakdown.push({
        name: habit.name,
        weeklyTarget: habit.weeklyTarget,
        completed: completedInWindow,
        expected: Math.round(expectedInWindow),
        pct: habitPct
      });
    }

    const scorePct = totalExpectedPoints > 0
      ? Math.min(100, Math.max(0, Math.round((totalEarnedPoints / totalExpectedPoints) * 100)))
      : 100;

    return {
      scorePct,
      totalEarned: Math.round(totalEarnedPoints),
      totalExpected: Math.round(totalExpectedPoints),
      effectiveDays,
      perHabitBreakdown
    };
  }

  function openInfoModal(topicKey) {
    const titleEl = document.getElementById('infoSheetTitle');
    const bodyEl = document.getElementById('infoSheetBody');
    if (!titleEl || !bodyEl) return;

    const unit = AppState.settings.unit;
    const series = computeWeightSeriesWithEMA();
    const analytics = computeWeightAnalytics(series);
    const latest = analytics.latest;

    if (topicKey === 'habit-adherence') {
      const d30 = computeConsistencyDetails(30);
      const rowsHtml = d30.perHabitBreakdown
        .map(
          (h) => `
          <div class="info-breakdown-row">
            <span><strong>${escapeHTML(h.name)}</strong> (${h.weeklyTarget}x/wk)</span>
            <span class="num" style="color:var(--accent-sage);font-weight:700;">${h.completed} / ${h.expected} sessions (${h.pct}%)</span>
          </div>
        `
        )
        .join('');

      titleEl.textContent = 'How Habit Adherence Is Computed';
      bodyEl.innerHTML = `
        <p>Unlike fragile daily streak counters that reset to zero if you take a rest day, Zenith measures <strong>Weekly Target Adherence</strong> across your active window (${d30.effectiveDays} days).</p>
        <div class="info-formula-box">
          <strong>The Math:</strong>
          For each habit, your expected sessions over ${d30.effectiveDays} days is prorated from your weekly target. Built-in rest days (${7} minus your weekly target) are automatically excluded from the denominator so recovery days never penalize you.
          <code class="info-formula-code">Adherence % = (Completed Sessions + Shields) ÷ ((Weekly Target ÷ 7) × Active Days)</code>
        </div>
        <div style="font-weight:700;color:var(--text-primary);margin-top:8px;">Live 30-Day Breakdown (${d30.totalEarned} / ${d30.totalExpected} target sessions = ${d30.scorePct}%):</div>
        <div class="info-breakdown-list">${rowsHtml}</div>
      `;
    } else if (topicKey === 'ema-signal') {
      const rawTxt = latest ? formatWeight(latest.weightKg, unit, true) : '--';
      const emaTxt = latest ? formatWeight(latest.emaKg, unit, true) : '--';
      titleEl.textContent = '7-Day EMA Trend vs. Raw Scale';
      bodyEl.innerHTML = `
        <p>Daily scale weight fluctuates by 1–3% due to glycogen water binding, sodium intake, and gut content. The <strong>7-Day Exponential Moving Average (EMA)</strong> acts as a low-pass filter to reveal true tissue change.</p>
        <div class="info-formula-box">
          <strong>The Smoothing Formula (α = 2 ÷ (7 + 1) = 0.25):</strong>
          Each new weigh-in contributes 25% to the trendline, while 75% carries forward from yesterday's smoothed EMA.
          <code class="info-formula-code">EMA_today = (0.25 × Scale_today) + (0.75 × EMA_yesterday)</code>
        </div>
        <div class="info-breakdown-list">
          <div class="info-breakdown-row">
            <span>Latest Raw Scale</span>
            <strong class="num">${escapeHTML(rawTxt)}</strong>
          </div>
          <div class="info-breakdown-row">
            <span>Smoothed 7-Day EMA Signal</span>
            <strong class="num" style="color:var(--accent-sage);">${escapeHTML(emaTxt)}</strong>
          </div>
        </div>
      `;
    } else if (topicKey === 'weekly-velocity') {
      const rateTxt =
        analytics.weeklyRateKg !== null
          ? `${kgToDisplay(analytics.weeklyRateKg, unit) > 0 ? '+' : ''}${kgToDisplay(analytics.weeklyRateKg, unit).toFixed(2)} ${unit}/wk`
          : 'Need 2+ logs';
      titleEl.textContent = 'Weekly Velocity Computation';
      bodyEl.innerHTML = `
        <p>Weekly Velocity measures how fast your <strong>smoothed 7-day EMA weight</strong> is moving per 7-day week—ignoring single-day scale spikes.</p>
        <div class="info-formula-box">
          <strong>The Formula:</strong>
          Compares your latest EMA against your EMA anchor ~7 days prior, normalized to a 7-day rate:
          <code class="info-formula-code">Velocity = ((EMA_latest − EMA_anchor) ÷ Days_Elapsed) × 7</code>
        </div>
        <div class="info-breakdown-list">
          <div class="info-breakdown-row">
            <span>Current Weekly Rate</span>
            <strong class="num" style="color:var(--accent-sage);">${escapeHTML(rateTxt)}</strong>
          </div>
          <div class="info-breakdown-row">
            <span>Detected Zone</span>
            <strong>${escapeHTML(analytics.zoneLabel)}</strong>
          </div>
        </div>
      `;
    } else if (topicKey === 'goal-trajectory') {
      titleEl.textContent = 'Goal Trajectory Projection';
      bodyEl.innerHTML = `
        <p>Projects how many weeks remain until your <strong>7-Day EMA Trend</strong> reaches your Goal Weight (${escapeHTML(formatWeight(AppState.settings.goalWeightKg, unit, true))}) at your current weekly velocity.</p>
        <div class="info-formula-box">
          <strong>The Formula:</strong>
          <code class="info-formula-code">Weeks Remaining = |Goal_Weight − Current_EMA| ÷ |Weekly_Velocity|</code>
        </div>
      `;
    } else if (topicKey === 'streak-shields') {
      titleEl.textContent = 'Streak Shields & Comeback Protocol';
      bodyEl.innerHTML = `
        <p>Real life includes travel, deloads, and illness. Zenith gives you two tools so a break never turns into quitting:</p>
        <div class="info-formula-box">
          <strong>1. Monthly Streak Shields (2 / month):</strong>
          Applying a Shield credits +1 protected day across all habits in your 30-day and 90-day adherence calculation. Replenishes to 2 on the 1st of every month.
        </div>
        <div class="info-formula-box">
          <strong>2. Comeback Protocol ("Day 1 Starts Today"):</strong>
          Resets the start date of your adherence window to today without deleting any weight or food history, giving you an immediate 100% clean slate.
        </div>
      `;
    } else if (topicKey === 'protein-per-kg') {
      const todayStr = getLocalDateStr();
      const todayPro = AppState.foodLogs
        .filter((f) => f.date === todayStr)
        .reduce((s, f) => s + f.protein, 0);
      const refKg = latest ? latest.emaKg : AppState.settings.goalWeightKg;
      const ratio = refKg > 0 ? (todayPro / refKg).toFixed(2) : '--';

      titleEl.textContent = 'Protein per Kilogram (g/kg)';
      bodyEl.innerHTML = `
        <p>Divides today's protein intake by your smoothed <strong>7-Day EMA bodyweight in kilograms</strong> (${refKg.toFixed(1)} kg). Sports nutrition research supports <strong>1.6–2.2 g/kg</strong> for optimal muscle retention and hypertrophy.</p>
        <div class="info-formula-box">
          <code class="info-formula-code">Protein / kg = Today_Protein_Grams (${todayPro}g) ÷ EMA_Weight_kg (${refKg.toFixed(1)} kg) = ${ratio} g/kg</code>
        </div>
      `;
    }

    openSheet('infoSheetBackdrop');
  }

  function createRichHabitCardElement(habit, todayStr, includeManagementActions = false) {
    const status = getHabitWeeklyStatus(habit, todayStr);
    const themeInfo = HABIT_THEMES[habit.color] || HABIT_THEMES.sage;
    const card = document.createElement('div');
    card.className = `habit-card${status.completedToday ? ' completed-today' : ''}`;
    card.setAttribute('data-color', themeInfo.color);
    card.setAttribute('data-habit-id', habit.id);

    const statusLine = status.completedToday
      ? 'Completed today • On track'
      : status.isRestToday
      ? 'Intentional Recovery Day • Protected'
      : status.targetMetThisWeek
      ? 'Weekly target met • Rest or bonus rep'
      : `${habit.weeklyTarget}x/wk target • ${status.allowedRestDays} rest days built in`;

    const weekOrbsHtml = status.weekDays
      .map(
        (d) => `
        <button type="button" class="habit-day-orb spring-btn${d.isDone ? ' done' : d.isRest ? ' rest' : ''}${d.isToday ? ' is-today' : ''}" data-date="${escapeHTML(d.dateStr)}" title="${escapeHTML(d.dateStr)}">
          <span>${escapeHTML(d.shortLabel)}</span>
          <span class="orb-dot"></span>
        </button>
      `
      )
      .join('');

    card.innerHTML = `
      <div class="habit-card-top">
        <div class="habit-card-left">
          <span class="habit-icon-badge" aria-hidden="true">${escapeHTML(habit.icon || themeInfo.icon)}</span>
          <div class="habit-title-wrap">
            <span class="habit-name">${escapeHTML(habit.name)}</span>
            <span class="habit-sub">${escapeHTML(statusLine)}</span>
          </div>
        </div>
        <div class="habit-card-right">
          <span class="habit-cadence-pill num">${status.completedThisWeek}/${habit.weeklyTarget} wk</span>
          ${
            includeManagementActions
              ? `<button type="button" class="mini-action-btn spring-btn rest-toggle-btn" title="Mark Intentional Rest Day Today" aria-label="Mark Intentional Rest Day" style="${status.isRestToday ? 'background:var(--accent-amber-soft);color:var(--accent-amber);border-color:var(--accent-amber-border);' : ''}">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                  </svg>
                </button>`
              : ''
          }
          <button type="button" class="habit-check-trigger spring-btn" aria-label="Toggle habit completion for today">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 6 9 17l-5-5"/>
            </svg>
          </button>
          ${
            includeManagementActions
              ? `<button type="button" class="mini-action-btn delete-btn spring-btn del-habit-btn" title="Delete habit" aria-label="Delete habit">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>`
              : ''
          }
        </div>
      </div>
      <div class="habit-week-strip" role="group" aria-label="Weekly completion strip">
        ${weekOrbsHtml}
      </div>
    `;

    const checkBtn = card.querySelector('.habit-check-trigger');
    if (checkBtn) {
      checkBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willBeDone = !habit.completedDates.includes(todayStr);
        if (willBeDone) spawnParticleBurst(checkBtn, themeInfo.hex);
        toggleHabitOnDate(habit.id, todayStr);
      });
    }

    card.querySelectorAll('.habit-day-orb').forEach((orb) => {
      orb.addEventListener('click', (e) => {
        e.stopPropagation();
        const dStr = orb.getAttribute('data-date');
        if (!dStr) return;
        const willBeDone = !habit.completedDates.includes(dStr);
        if (willBeDone) spawnParticleBurst(orb, themeInfo.hex);
        toggleHabitOnDate(habit.id, dStr);
      });
    });

    const restBtn = card.querySelector('.rest-toggle-btn');
    if (restBtn) {
      restBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleHabitRestDayToday(habit.id);
      });
    }

    const delBtn = card.querySelector('.del-habit-btn');
    if (delBtn) {
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteHabit(habit.id);
      });
    }

    return card;
  }

  /* ------------------------------------------------------------------------
     13. UI RENDERING & DOM SYNCHRONIZATION
     ------------------------------------------------------------------------ */

  function applyTheme(themePref) {
    const root = document.documentElement;
    root.setAttribute('data-theme', themePref || 'dark');

    const isDark =
      themePref === 'dark' ||
      (themePref === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);

    const metaTheme = document.getElementById('metaThemeColor');
    if (metaTheme) {
      metaTheme.setAttribute('content', isDark ? '#040507' : '#F5F0E6');
    }
  }

  function updateDynamicHeader() {
    const now = new Date();
    const hour = now.getHours();
    let greeting = 'Good evening';
    if (hour >= 5 && hour < 12) greeting = 'Good morning';
    else if (hour >= 12 && hour < 17) greeting = 'Good afternoon';

    const greetingEl = document.getElementById('headerGreeting');
    const dateEl = document.getElementById('headerDateText');
    const subEl = document.getElementById('headerSubtitle');

    if (greetingEl) greetingEl.textContent = greeting;
    if (dateEl) {
      dateEl.textContent = now.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'short',
        day: 'numeric'
      });
    }
    if (subEl) {
      const dayIndex = (now.getDate() + hour) % STOIC_SUBTITLES.length;
      subEl.textContent = STOIC_SUBTITLES[dayIndex];
    }

    const statusText = document.getElementById('offlineStatusText');
    if (statusText) {
      statusText.textContent = navigator.onLine ? 'Offline Ready' : '100% Offline';
    }
  }

  function showToast(message) {
    const toast = document.getElementById('toastBanner');
    const textEl = document.getElementById('toastMessageText');
    if (!toast || !textEl) return;
    textEl.textContent = message;
    toast.classList.add('visible');
    if (showToast._timer) clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      toast.classList.remove('visible');
    }, 2200);
  }

  function triggerConfirmPulse(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.classList.remove('pulse-confirm');
    void el.offsetWidth;
    el.classList.add('pulse-confirm');
  }

  function renderTodayTab() {
    applyDashboardLayoutToDOM();

    const todayStr = getLocalDateStr();
    const unit = AppState.settings.unit;
    const weightSeries = computeWeightSeriesWithEMA();
    const latestWeight = weightSeries.length > 0 ? weightSeries[weightSeries.length - 1] : null;

    const fastWeightVal = document.getElementById('fastWeightVal');
    const fastWeightCompactVal = document.getElementById('fastWeightCompactVal');
    const fastWeightSub = document.getElementById('fastWeightSub');

    const weightDisp = latestWeight ? formatWeight(latestWeight.weightKg, unit, true) : `-- ${unit}`;
    if (fastWeightVal) fastWeightVal.textContent = weightDisp;
    if (fastWeightCompactVal) fastWeightCompactVal.textContent = weightDisp;
    if (fastWeightSub) {
      if (latestWeight) {
        fastWeightSub.textContent =
          latestWeight.date === todayStr
            ? `EMA ${formatWeight(latestWeight.emaKg, unit, true)}`
            : `Last: ${formatDisplayDate(latestWeight.date)}`;
      } else {
        fastWeightSub.textContent = 'Tap for 1-sec pre-fill';
      }
    }

    const todayFoods = AppState.foodLogs.filter((f) => f.date === todayStr);
    const totalCal = todayFoods.reduce((acc, f) => acc + f.calories, 0);
    const totalPro = todayFoods.reduce((acc, f) => acc + f.protein, 0);

    const fastFuelVal = document.getElementById('fastFuelVal');
    const fastFuelCompactVal = document.getElementById('fastFuelCompactVal');
    const fastFuelSub = document.getElementById('fastFuelSub');
    if (fastFuelVal) fastFuelVal.textContent = `${totalCal.toLocaleString()} kcal`;
    if (fastFuelCompactVal) fastFuelCompactVal.textContent = `${totalCal.toLocaleString()} kcal`;
    if (fastFuelSub) {
      fastFuelSub.textContent = `${totalPro}g protein • ${todayFoods.length} ${todayFoods.length === 1 ? 'meal' : 'meals'}`;
    }

    // Short Summary for Quick Log Widget
    const summaryFastLogText = document.getElementById('summaryFastLogText');
    if (summaryFastLogText) {
      summaryFastLogText.textContent = `Scale: ${weightDisp} • Food: ${totalCal.toLocaleString()} kcal (${totalPro}g P)`;
    }

    const calTarget = AppState.settings.calorieTarget;
    const proTarget = AppState.settings.proteinTarget;
    const circumference = 2 * Math.PI * 48; // 301.59

    const calRatio = Math.min(1, Math.max(0, totalCal / (calTarget || 1)));
    const proRatio = Math.min(1, Math.max(0, totalPro / (proTarget || 1)));

    const calRing = document.getElementById('calRingCircle');
    const proRing = document.getElementById('proRingCircle');
    if (calRing) {
      calRing.style.strokeDashoffset = (circumference * (1 - calRatio)).toFixed(2);
    }
    if (proRing) {
      proRing.style.strokeDashoffset = (circumference * (1 - proRatio)).toFixed(2);
    }

    const calActualEl = document.getElementById('todayCalActual');
    const calTargetEl = document.getElementById('todayCalTargetText');
    const calPillFill = document.getElementById('calPillFill');
    const calRemEl = document.getElementById('todayCalRemaining');

    const remCal = calTarget - totalCal;
    const remCalText =
      remCal >= 0 ? `${remCal.toLocaleString()} kcal left` : `+${Math.abs(remCal).toLocaleString()} kcal over`;

    if (calActualEl) calActualEl.textContent = totalCal.toLocaleString();
    if (calTargetEl) calTargetEl.textContent = `/ ${calTarget.toLocaleString()} kcal`;
    if (calPillFill) calPillFill.style.width = `${Math.round(calRatio * 100)}%`;
    if (calRemEl) calRemEl.textContent = remCalText;

    const proActualEl = document.getElementById('todayProActual');
    const proTargetEl = document.getElementById('todayProTargetText');
    const proPillFill = document.getElementById('proPillFill');
    const proRemEl = document.getElementById('todayProRemaining');

    const remPro = proTarget - totalPro;
    const remProText = remPro > 0 ? `${remPro}g remaining` : `Goal hit (+${Math.abs(remPro)}g)`;

    if (proActualEl) proActualEl.textContent = `${totalPro}g`;
    if (proTargetEl) proTargetEl.textContent = `/ ${proTarget}g pro`;
    if (proPillFill) proPillFill.style.width = `${Math.round(proRatio * 100)}%`;
    if (proRemEl) proRemEl.textContent = remProText;

    // Compact & Short Summary for Nutrition Widget
    const compactCalVal = document.getElementById('compactCalVal');
    const compactCalFill = document.getElementById('compactCalFill');
    const compactCalRem = document.getElementById('compactCalRem');
    const compactProVal = document.getElementById('compactProVal');
    const compactProFill = document.getElementById('compactProFill');
    const compactProRem = document.getElementById('compactProRem');

    if (compactCalVal) compactCalVal.textContent = `${totalCal.toLocaleString()} / ${calTarget.toLocaleString()}`;
    if (compactCalFill) compactCalFill.style.width = `${Math.round(calRatio * 100)}%`;
    if (compactCalRem) compactCalRem.textContent = remCalText;

    if (compactProVal) compactProVal.textContent = `${totalPro}g / ${proTarget}g`;
    if (compactProFill) compactProFill.style.width = `${Math.round(proRatio * 100)}%`;
    if (compactProRem) compactProRem.textContent = remProText;

    const summaryMacrosText = document.getElementById('summaryMacrosText');
    const summaryMacrosRemPill = document.getElementById('summaryMacrosRemPill');
    if (summaryMacrosText) {
      summaryMacrosText.textContent = `${totalCal.toLocaleString()} / ${calTarget.toLocaleString()} kcal • ${totalPro}g / ${proTarget}g P`;
    }
    if (summaryMacrosRemPill) {
      summaryMacrosRemPill.textContent = remCalText;
    }

    // Habits Widget: Expanded, Compact, and Short Summary
    const capsuleList = document.getElementById('todayHabitCapsuleList');
    const compactGrid = document.getElementById('todayHabitCompactGrid');
    const weekSummaryEl = document.getElementById('todayHabitWeekSummary');
    let habitsCompletedToday = 0;

    if (capsuleList) capsuleList.innerHTML = '';
    if (compactGrid) compactGrid.innerHTML = '';

    AppState.habits.forEach((habit) => {
      const status = getHabitWeeklyStatus(habit, todayStr);
      if (status.completedToday || status.isRestToday) habitsCompletedToday++;

      if (capsuleList) {
        const cardEl = createRichHabitCardElement(habit, todayStr, false);
        capsuleList.appendChild(cardEl);
      }

      if (compactGrid) {
        const themeInfo = HABIT_THEMES[habit.color] || HABIT_THEMES.sage;
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = `compact-habit-pill spring-btn${status.completedToday ? ' done' : ''}`;
        pill.innerHTML = `
          <div class="compact-habit-left">
            <span>${escapeHTML(habit.icon || themeInfo.icon)}</span>
            <span class="compact-habit-name">${escapeHTML(habit.name)}</span>
          </div>
          <span class="habit-cadence-pill num" style="padding:3px 7px;font-size:0.66rem;">${status.completedThisWeek}/${habit.weeklyTarget}</span>
        `;
        pill.addEventListener('click', () => {
          const willBeDone = !habit.completedDates.includes(todayStr);
          if (willBeDone) spawnParticleBurst(pill, themeInfo.hex);
          toggleHabitOnDate(habit.id, todayStr);
        });
        compactGrid.appendChild(pill);
      }
    });

    if (weekSummaryEl) {
      weekSummaryEl.textContent = `${habitsCompletedToday}/${AppState.habits.length}`;
    }

    const d30 = computeConsistencyDetails(30);
    const summaryHabitsText = document.getElementById('summaryHabitsText');
    const summaryHabitsScorePill = document.getElementById('summaryHabitsScorePill');
    if (summaryHabitsText) {
      summaryHabitsText.textContent = `${habitsCompletedToday} / ${AppState.habits.length} habits completed today`;
    }
    if (summaryHabitsScorePill) {
      summaryHabitsScorePill.textContent = `${d30.scorePct}% 30d`;
    }

    // Snapshot Widget: Expanded, Compact, and Short Summary
    const eodCal = document.getElementById('eodTotalCalories');
    const eodPro = document.getElementById('eodTotalProtein');
    const eodProPerKg = document.getElementById('eodProteinPerKg');
    const eodConsistencyText = document.getElementById('eodConsistencyText');
    const eodEmaDeltaText = document.getElementById('eodEmaDeltaText');

    const refKg = latestWeight ? latestWeight.emaKg : AppState.settings.goalWeightKg;
    const gPerKg = refKg > 0 ? (totalPro / refKg).toFixed(1) : '--';
    const emaDisplayStr = latestWeight ? formatWeight(latestWeight.emaKg, unit, true) : '--';

    if (eodCal) eodCal.textContent = `${totalCal.toLocaleString()} kcal`;
    if (eodPro) eodPro.textContent = `${totalPro} g`;
    if (eodProPerKg) eodProPerKg.textContent = `${gPerKg} g/kg`;

    if (eodConsistencyText) {
      if (totalPro >= proTarget * 0.9) {
        eodConsistencyText.textContent = `Protein goal locked • ${d30.scorePct}% 30d adherence`;
      } else if (totalCal > 0) {
        eodConsistencyText.textContent = `Active day • ${d30.scorePct}% 30d adherence`;
      } else {
        eodConsistencyText.textContent = `Ready for today's logs • ${d30.scorePct}% 30d score`;
      }
    }
    if (eodEmaDeltaText) {
      eodEmaDeltaText.textContent = latestWeight ? `EMA ${emaDisplayStr}` : 'EMA: --';
    }

    const compactEodCal = document.getElementById('compactEodCal');
    const compactEodPro = document.getElementById('compactEodPro');
    const compactEodRatio = document.getElementById('compactEodRatio');
    if (compactEodCal) compactEodCal.textContent = `${totalCal.toLocaleString()} kcal`;
    if (compactEodPro) compactEodPro.textContent = `${totalPro} g`;
    if (compactEodRatio) compactEodRatio.textContent = `${gPerKg} g/kg`;

    const summarySnapshotText = document.getElementById('summarySnapshotText');
    const summarySnapshotBadge = document.getElementById('summarySnapshotBadge');
    if (summarySnapshotText) {
      summarySnapshotText.textContent = `Protein: ${gPerKg} g/kg • EMA: ${emaDisplayStr}`;
    }
    if (summarySnapshotBadge) {
      summarySnapshotBadge.textContent = `${d30.scorePct}% 30d`;
    }
  }

  function renderFuelTab() {
    const todayStr = getLocalDateStr();
    const yesterdayStr = shiftDateStr(todayStr, -1);
    const activeDateStr = AppState.fuelSelectedDay === 'yesterday' ? yesterdayStr : todayStr;
    const isYesterday = AppState.fuelSelectedDay === 'yesterday';

    const todayBtn = document.getElementById('fuelDayTodayBtn');
    const yesterdayBtn = document.getElementById('fuelDayYesterdayBtn');
    if (todayBtn && yesterdayBtn) {
      todayBtn.classList.toggle('active', !isYesterday);
      todayBtn.setAttribute('aria-selected', String(!isYesterday));
      yesterdayBtn.classList.toggle('active', isYesterday);
      yesterdayBtn.setAttribute('aria-selected', String(isYesterday));
    }

    const dayEntries = AppState.foodLogs
      .filter((f) => f.date === activeDateStr)
      .sort((a, b) => b.timestamp - a.timestamp);

    const dayCal = dayEntries.reduce((sum, f) => sum + f.calories, 0);
    const dayPro = dayEntries.reduce((sum, f) => sum + f.protein, 0);
    const calTarget = AppState.settings.calorieTarget;
    const proTarget = AppState.settings.proteinTarget;

    const bankTitle = document.getElementById('fuelBankTitle');
    const mealsCount = document.getElementById('fuelMealsLoggedCount');
    const bankCalRem = document.getElementById('bankCalRemaining');
    const bankCalSub = document.getElementById('bankCalSub');
    const bankProRem = document.getElementById('bankProRemaining');
    const bankProSub = document.getElementById('bankProSub');

    if (bankTitle) {
      bankTitle.textContent = isYesterday ? "Yesterday's Macro Totals" : 'Daily Macro Bank';
    }
    if (mealsCount) {
      mealsCount.textContent = `${dayEntries.length} ${dayEntries.length === 1 ? 'meal' : 'meals'}`;
    }

    const remCal = calTarget - dayCal;
    const remPro = proTarget - dayPro;

    if (bankCalRem) {
      bankCalRem.textContent = remCal >= 0 ? remCal.toLocaleString() : `+${Math.abs(remCal).toLocaleString()}`;
    }
    if (bankCalSub) {
      bankCalSub.textContent = `${dayCal.toLocaleString()} / ${calTarget.toLocaleString()} kcal logged`;
    }
    if (bankProRem) {
      bankProRem.textContent = remPro >= 0 ? `${remPro}g` : `+${Math.abs(remPro)}g`;
    }
    if (bankProSub) {
      bankProSub.textContent = `${dayPro}g / ${proTarget}g protein logged`;
    }

    const instantBtn = document.getElementById('instantTapModeBtn');
    if (instantBtn) {
      instantBtn.textContent = `1-Tap Instant: ${AppState.settings.instantTapFuel ? 'ON' : 'OFF'}`;
    }

    renderAllFoodMemoryTrays();
    renderMealBuilderDrafts(false);
    renderMealBuilderDrafts(true);

    const timelineTitle = document.getElementById('fuelTimelineHeaderTitle');
    if (timelineTitle) {
      timelineTitle.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
        ${isYesterday ? "Yesterday's Food Log" : "Today's Food Log"}
      `;
    }

    const listEl = document.getElementById('fuelTimelineList');
    if (!listEl) return;
    listEl.innerHTML = '';

    if (dayEntries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = isYesterday
        ? 'No food entries were logged yesterday.'
        : 'No food logged yet today. Tap a remembered food chip above or build a multi-item meal.';
      listEl.appendChild(empty);
      return;
    }

    dayEntries.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'timeline-item';
      row.setAttribute('data-food-id', entry.id);

      const timeStr = formatTimeFromTimestamp(entry.timestamp);
      const subItemsHtml =
        Array.isArray(entry.items) && entry.items.length > 0
          ? `<div class="timeline-subitems">${entry.items
              .map((it) => `${escapeHTML(it.name)} (${it.calories} kcal, ${it.protein}g P)`)
              .join(' + ')}</div>`
          : '';

      row.innerHTML = `
        <div class="timeline-left">
          <span class="timeline-time num">${escapeHTML(timeStr)}</span>
          <span class="timeline-note">${escapeHTML(entry.note || 'Food Entry')}</span>
          ${subItemsHtml}
        </div>
        <div class="timeline-right">
          <div class="timeline-macros num">
            <span class="timeline-kcal">${entry.calories} kcal</span>
            <span class="timeline-pro">${entry.protein}g pro</span>
          </div>
          <div class="entry-actions">
            ${
              isYesterday
                ? `<button type="button" class="mini-action-btn spring-btn copy-today-btn" title="Copy meal to Today" aria-label="Copy entry to Today">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                   </button>`
                : ''
            }
            <button type="button" class="mini-action-btn spring-btn edit-food-btn" title="Edit entry" aria-label="Edit entry">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
              </svg>
            </button>
            <button type="button" class="mini-action-btn delete-btn spring-btn del-food-btn" title="Delete entry" aria-label="Delete entry">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
      `;

      let touchStartX = 0;
      row.addEventListener('touchstart', (e) => {
        if (e.touches && e.touches[0]) touchStartX = e.touches[0].clientX;
      }, { passive: true });
      row.addEventListener('touchend', (e) => {
        if (e.changedTouches && e.changedTouches[0]) {
          const dx = e.changedTouches[0].clientX - touchStartX;
          if (dx < -40) row.classList.add('swiped-left');
          else if (dx > 25) row.classList.remove('swiped-left');
        }
      }, { passive: true });

      const copyBtn = row.querySelector('.copy-today-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => copyFoodEntryToToday(entry));
      }
      const editBtn = row.querySelector('.edit-food-btn');
      if (editBtn) {
        editBtn.addEventListener('click', () => populateFoodFormForEdit(entry));
      }
      const delBtn = row.querySelector('.del-food-btn');
      if (delBtn) {
        delBtn.addEventListener('click', () => deleteFoodEntry(entry.id));
      }

      listEl.appendChild(row);
    });
  }

  function renderWeightTab(preFillInputs = false) {
    const unit = AppState.settings.unit;
    const kgBtn = document.getElementById('unitKgBtn');
    const lbsBtn = document.getElementById('unitLbsBtn');
    if (kgBtn && lbsBtn) {
      kgBtn.classList.toggle('active', unit === 'kg');
      lbsBtn.classList.toggle('active', unit === 'lbs');
    }

    const series = computeWeightSeriesWithEMA();
    const analytics = computeWeightAnalytics(series);
    const latest = analytics.latest;

    const weightInput = document.getElementById('weightValInput');
    const dateInput = document.getElementById('weightDateInput');
    const editIdInput = document.getElementById('weightEditIdInput');
    if (weightInput && (preFillInputs || !weightInput.value) && (!editIdInput || !editIdInput.value)) {
      const refKg = latest ? latest.weightKg : AppState.settings.goalWeightKg;
      weightInput.value = kgToDisplay(refKg, unit).toFixed(1);
    }
    if (dateInput && !dateInput.value) {
      dateInput.value = getLocalDateStr();
    }

    const curWeightEl = document.getElementById('metricCurrentWeight');
    const curDateEl = document.getElementById('metricCurrentDate');
    const emaWeightEl = document.getElementById('metricEmaWeight');
    const emaDeltaEl = document.getElementById('metricEmaDelta');
    const weeklyRateEl = document.getElementById('metricWeeklyRate');
    const weeklyZoneEl = document.getElementById('metricWeeklyZone');
    const goalWeightEl = document.getElementById('metricGoalWeight');
    const goalTrajEl = document.getElementById('metricGoalTrajectory');

    if (latest) {
      if (curWeightEl) curWeightEl.textContent = formatWeight(latest.weightKg, unit, true);
      if (curDateEl) curDateEl.textContent = formatDisplayDate(latest.date);
      if (emaWeightEl) emaWeightEl.textContent = formatWeight(latest.emaKg, unit, true);
      if (emaDeltaEl) {
        const diff = kgToDisplay(latest.deltaFromEmaKg, unit);
        const sign = diff > 0 ? '+' : '';
        emaDeltaEl.textContent =
          Math.abs(diff) < 0.05
            ? 'Aligned with scale'
            : `Scale ${sign}${diff.toFixed(1)} ${unit} vs EMA`;
      }
    } else {
      if (curWeightEl) curWeightEl.textContent = '--';
      if (curDateEl) curDateEl.textContent = 'No logs yet';
      if (emaWeightEl) emaWeightEl.textContent = '--';
      if (emaDeltaEl) emaDeltaEl.textContent = 'True tissue signal';
    }

    if (weeklyRateEl) {
      if (analytics.weeklyRateKg !== null) {
        const rateDisp = kgToDisplay(analytics.weeklyRateKg, unit);
        const sign = rateDisp > 0 ? '+' : '';
        weeklyRateEl.textContent = `${sign}${rateDisp.toFixed(2)} ${unit}/wk`;
      } else {
        weeklyRateEl.textContent = '--';
      }
    }
    if (weeklyZoneEl) {
      weeklyZoneEl.textContent = analytics.zoneLabel;
    }

    if (goalWeightEl) {
      goalWeightEl.textContent = formatWeight(AppState.settings.goalWeightKg, unit, true);
    }
    if (goalTrajEl) {
      goalTrajEl.textContent = analytics.goalTrajectoryText;
    }

    renderWeightTrendChart();

    const historyList = document.getElementById('weightHistoryList');
    if (!historyList) return;
    historyList.innerHTML = '';

    const reversed = series.slice().reverse();
    if (reversed.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No weight logs recorded yet.';
      historyList.appendChild(empty);
      return;
    }

    reversed.slice(0, 35).forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'timeline-item';
      const rawDisp = formatWeight(entry.weightKg, unit, true);
      const emaDisp = formatWeight(entry.emaKg, unit, true);

      row.innerHTML = `
        <div class="timeline-left">
          <span class="timeline-time num">${escapeHTML(formatDisplayDate(entry.date))}</span>
          <span class="timeline-note">${escapeHTML(entry.note || 'Scale check-in')}</span>
        </div>
        <div class="timeline-right">
          <div class="timeline-macros num">
            <span class="timeline-kcal">${escapeHTML(rawDisp)}</span>
            <span class="timeline-pro">EMA ${escapeHTML(emaDisp)}</span>
          </div>
          <div class="entry-actions">
            <button type="button" class="mini-action-btn spring-btn edit-weight-btn" title="Edit weight log" aria-label="Edit weight log">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
              </svg>
            </button>
            <button type="button" class="mini-action-btn delete-btn spring-btn del-weight-btn" title="Delete weight log" aria-label="Delete weight log">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
      `;

      row.querySelector('.edit-weight-btn').addEventListener('click', () => populateWeightFormForEdit(entry));
      row.querySelector('.del-weight-btn').addEventListener('click', () => deleteWeightEntry(entry.id));
      historyList.appendChild(row);
    });
  }

  function renderHabitHeatmap(todayStr) {
    const grid = document.getElementById('habitHeatmapGrid');
    if (!grid) return;
    grid.innerHTML = '';

    const totalHabits = Math.max(1, AppState.habits.length);
    for (let i = 27; i >= 0; i--) {
      const dStr = shiftDateStr(todayStr, -i);
      const isShielded = (AppState.settings.shieldsUsedDates || []).includes(dStr);
      let count = 0;
      AppState.habits.forEach((h) => {
        if (h.completedDates.includes(dStr) || h.restDates.includes(dStr)) count++;
      });

      const ratio = count / totalHabits;
      let lvlClass = '';
      if (isShielded) lvlClass = ' shielded';
      else if (ratio >= 0.75) lvlClass = ' lvl-3';
      else if (ratio >= 0.4) lvlClass = ' lvl-2';
      else if (ratio > 0) lvlClass = ' lvl-1';

      const cell = document.createElement('div');
      cell.className = `heatmap-cell${lvlClass}`;
      cell.title = `${formatDisplayDate(dStr)}: ${count}/${AppState.habits.length} habits`;
      grid.appendChild(cell);
    }
  }

  function applyVaultViewModeToDOM() {
    const isNerdy = AppState.settings.vaultViewMode === 'nerdy';
    const simpleBtn = document.getElementById('vaultModeSimpleBtn');
    const nerdyBtn = document.getElementById('vaultModeNerdyBtn');
    const simpleView = document.getElementById('vaultSimpleView');
    const nerdyView = document.getElementById('vaultNerdyView');

    if (simpleBtn && nerdyBtn) {
      simpleBtn.classList.toggle('active', !isNerdy);
      simpleBtn.setAttribute('aria-selected', String(!isNerdy));
      nerdyBtn.classList.toggle('active', isNerdy);
      nerdyBtn.setAttribute('aria-selected', String(isNerdy));
    }
    if (simpleView) simpleView.style.display = isNerdy ? 'none' : 'block';
    if (nerdyView) nerdyView.style.display = isNerdy ? 'block' : 'none';
  }

  function renderVaultTab() {
    applyVaultViewModeToDOM();

    const todayStr = getLocalDateStr();
    const d30 = computeConsistencyDetails(30);
    const d90 = computeConsistencyDetails(90);

    const score30El = document.getElementById('score30DayVal');
    const score90El = document.getElementById('score90DayVal');
    const score30Sub = document.getElementById('score30DaySub');
    const score90Sub = document.getElementById('score90DaySub');

    if (score30El) score30El.textContent = `${d30.scorePct}%`;
    if (score90El) score90El.textContent = `${d90.scorePct}%`;
    if (score30Sub) {
      score30Sub.textContent = AppState.settings.comebackStartDate
        ? `Clean slate since ${formatDisplayDate(AppState.settings.comebackStartDate)}`
        : `${d30.totalEarned}/${d30.totalExpected} target sessions (${d30.effectiveDays}d)`;
    }
    if (score90Sub) {
      score90Sub.textContent =
        AppState.settings.archivedComebacksCount > 0
          ? `${AppState.settings.archivedComebacksCount} past chapter(s) archived`
          : `${d90.totalEarned}/${d90.totalExpected} target sessions`;
    }

    renderHabitHeatmap(todayStr);

    const comebackBanner = document.getElementById('comebackActiveBanner');
    if (comebackBanner) {
      if (AppState.settings.comebackStartDate) {
        const dayNum = Math.max(1, daysBetweenDateStrs(AppState.settings.comebackStartDate, todayStr) + 1);
        comebackBanner.style.display = 'block';
        comebackBanner.textContent = `Comeback Protocol Active — Day ${dayNum} starts today. Past logs are safely archived; focus only on today's rep.`;
      } else {
        comebackBanner.style.display = 'none';
      }
    }

    const shieldCountBadge = document.getElementById('shieldCountBadge');
    const shieldStatusSub = document.getElementById('shieldStatusSub');
    const applyShieldBtn = document.getElementById('applyShieldBtn');
    const shieldsLeft = AppState.settings.shieldsRemaining;

    if (shieldCountBadge) {
      shieldCountBadge.textContent = `${shieldsLeft} / 2 Monthly Streak Shields`;
    }
    if (shieldStatusSub) {
      const usedToday = (AppState.settings.shieldsUsedDates || []).includes(todayStr);
      shieldStatusSub.textContent = usedToday
        ? 'Shield active for today — streak & consistency protected'
        : 'Protects adherence during travel, illness, or life events';
    }
    if (applyShieldBtn) {
      const usedToday = (AppState.settings.shieldsUsedDates || []).includes(todayStr);
      applyShieldBtn.disabled = shieldsLeft <= 0 || usedToday;
      applyShieldBtn.textContent = usedToday ? 'Shield Active' : shieldsLeft > 0 ? 'Use Shield' : '0 Left';
    }

    const vaultHabitList = document.getElementById('vaultHabitList');
    if (vaultHabitList) {
      vaultHabitList.innerHTML = '';
      AppState.habits.forEach((habit) => {
        const cardEl = createRichHabitCardElement(habit, todayStr, true);
        vaultHabitList.appendChild(cardEl);
      });
    }

    const warningBadge = document.getElementById('vaultBackupWarningBadge');
    const warningText = document.getElementById('vaultBackupWarningText');
    const lastBackup = AppState.settings.lastBackupDate;
    if (warningBadge && warningText) {
      if (!lastBackup) {
        warningBadge.style.display = 'flex';
        warningText.textContent =
          'No backup saved within the last 30 days. Save a quick backup file to keep your history safe.';
      } else {
        const daysSinceBackup = daysBetweenDateStrs(lastBackup, todayStr);
        if (daysSinceBackup > 30) {
          warningBadge.style.display = 'flex';
          warningText.textContent = `Last backup was ${daysSinceBackup} days ago (${lastBackup}). Save a fresh backup to Files.`;
        } else {
          warningBadge.style.display = 'none';
        }
      }
    }

    // Simple Mode Status
    const simpleLastBackupEl = document.getElementById('vaultSimpleLastBackupText');
    const simpleStatusLabel = document.getElementById('vaultSimpleStatusLabel');
    const total = AppState.weightLogs.length + AppState.foodLogs.length + AppState.habits.length;
    if (simpleStatusLabel) {
      simpleStatusLabel.textContent = `Saved on iPhone (${total} logs)`;
    }
    if (simpleLastBackupEl) {
      simpleLastBackupEl.textContent = lastBackup
        ? `Backed up: ${formatDisplayDate(lastBackup)}`
        : 'Not backed up yet';
    }

    // Undo Restore button
    const undoRestoreBtn = document.getElementById('undoRestoreBtn');
    if (undoRestoreBtn) {
      let hasRollback = false;
      try {
        hasRollback = Boolean(window.localStorage.getItem(ROLLBACK_STORAGE_KEY));
      } catch (e) {
        hasRollback = false;
      }
      undoRestoreBtn.style.display = hasRollback ? 'inline-flex' : 'none';
    }

    // Nerdy Mode Telemetry
    const payloadObj = buildBackupPayloadObject();
    const serialized = JSON.stringify(payloadObj);
    const kbSize = (serialized.length / 1024).toFixed(1);

    const persistStatus = document.getElementById('vaultPersistStatus');
    const engineStatus = document.getElementById('vaultEngineStatus');
    const lastBackupText = document.getElementById('vaultLastBackupText');
    const totalRecordsText = document.getElementById('vaultTotalRecordsText');
    const hashText = document.getElementById('vaultHashText');
    const nerdyBadge = document.getElementById('nerdyChecksumBadge');
    const bytesText = document.getElementById('vaultPayloadBytesText');

    if (persistStatus) {
      persistStatus.textContent = VaultDB.isPersistent ? 'Granted (Protected)' : 'Active (Standard WebKit)';
    }
    if (engineStatus) {
      engineStatus.textContent = VaultDB.usingFallback ? 'localStorage Mirror' : 'IndexedDB v2 + Mirror';
    }
    if (hashText) hashText.textContent = payloadObj.integrityHash;
    if (nerdyBadge) nerdyBadge.textContent = payloadObj.integrityHash;
    if (bytesText) bytesText.textContent = `${kbSize} KB (${serialized.length.toLocaleString()} B)`;
    if (lastBackupText) {
      lastBackupText.textContent = lastBackup ? formatDisplayDate(lastBackup) : 'Not exported yet';
    }
    if (totalRecordsText) {
      const memCount = (AppState.settings.foodMemory || []).length;
      totalRecordsText.textContent = `${AppState.weightLogs.length}W • ${AppState.foodLogs.length}F • ${AppState.habits.length}H • ${memCount}M`;
    }
  }

  function renderAll() {
    updateDynamicHeader();
    renderTodayTab();
    renderFuelTab();
    renderWeightTab(false);
    renderVaultTab();
  }

  /* ------------------------------------------------------------------------
     14. USER ACTIONS: WEIGHT, SIMPLE/MULTI-ITEM MEALS, HABITS & COMEBACK
     ------------------------------------------------------------------------ */

  async function saveWeightLog(displayVal, dateStr, noteStr, existingId = '', triggerBtnEl = null) {
    const unit = AppState.settings.unit;
    const weightKg = displayToKg(displayVal, unit);
    if (!Number.isFinite(weightKg) || weightKg < 20 || weightKg > 400) {
      showToast(`Enter a valid weight (${unit === 'lbs' ? '45–880 lbs' : '20–400 kg'})`);
      return false;
    }

    const cleanDate = isValidDateStr(dateStr) ? dateStr : getLocalDateStr();
    const record = sanitizeWeightRecord({
      id: existingId || `w_${cleanDate}`,
      date: cleanDate,
      weightKg,
      note: noteStr,
      timestamp: Date.now()
    });

    if (!record) return false;

    const idx = AppState.weightLogs.findIndex((w) => w.id === record.id || w.date === record.date);
    if (idx >= 0) {
      record.id = AppState.weightLogs[idx].id;
      AppState.weightLogs[idx] = record;
    } else {
      AppState.weightLogs.push(record);
    }

    await VaultDB.putRecord('weight_logs', record);
    VaultDB.writeMirror(AppState);

    if (triggerBtnEl) spawnParticleBurst(triggerBtnEl, '#48D69D');
    renderAll();
    triggerConfirmPulse('todayFastLogWrapperCard');
    triggerConfirmPulse('weightLoggerCard');
    showToast(`Logged ${formatWeight(record.weightKg, unit, true)} to vault`);
    return true;
  }

  async function deleteWeightEntry(id) {
    AppState.weightLogs = AppState.weightLogs.filter((w) => w.id !== id);
    await VaultDB.deleteRecord('weight_logs', id);
    VaultDB.writeMirror(AppState);
    renderAll();
    showToast('Weight log removed');
  }

  function populateWeightFormForEdit(entry) {
    const unit = AppState.settings.unit;
    const valInput = document.getElementById('weightValInput');
    const dateInput = document.getElementById('weightDateInput');
    const noteInput = document.getElementById('weightNoteInput');
    const editIdInput = document.getElementById('weightEditIdInput');
    const submitText = document.getElementById('weightSubmitBtnText');

    if (valInput) valInput.value = kgToDisplay(entry.weightKg, unit).toFixed(1);
    if (dateInput) dateInput.value = entry.date;
    if (noteInput) noteInput.value = entry.note || '';
    if (editIdInput) editIdInput.value = entry.id;
    if (submitText) submitText.textContent = 'Update Scale Weight';

    const card = document.getElementById('weightLoggerCard');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function saveFoodLog(caloriesVal, proteinVal, noteStr, existingId = '', triggerBtnEl = null, subItems = []) {
    const calories = Math.round(clampNumber(caloriesVal, 0, 20000, 0));
    const protein = Math.round(clampNumber(proteinVal, 0, 1500, 0));

    if (calories <= 0 && protein <= 0) {
      showToast('Enter calories and/or protein before saving');
      return false;
    }

    const todayStr = getLocalDateStr();
    const yesterdayStr = shiftDateStr(todayStr, -1);
    const targetDate = AppState.fuelSelectedDay === 'yesterday' ? yesterdayStr : todayStr;

    let timestamp = Date.now();
    let dateStr = targetDate;

    if (existingId) {
      const existing = AppState.foodLogs.find((f) => f.id === existingId);
      if (existing) {
        timestamp = existing.timestamp;
        dateStr = existing.date;
      }
    }

    const defaultLabel =
      noteStr && noteStr.trim()
        ? noteStr.trim()
        : protein > 0 && calories === 0
        ? `Quick +${protein}g Protein`
        : calories > 0 && protein === 0
        ? `Quick +${calories} kcal`
        : `Meal (${calories} kcal • ${protein}g P)`;

    const record = sanitizeFoodRecord({
      id: existingId || generateId('food'),
      date: dateStr,
      timestamp,
      calories,
      protein,
      note: defaultLabel,
      items: subItems
    });

    if (!record) return false;

    const idx = AppState.foodLogs.findIndex((f) => f.id === record.id);
    if (idx >= 0) {
      AppState.foodLogs[idx] = record;
    } else {
      AppState.foodLogs.push(record);
    }

    rememberFoodItem(record.note, record.calories, record.protein);
    if (Array.isArray(record.items)) {
      record.items.forEach((it) => rememberFoodItem(it.name, it.calories, it.protein));
    }

    await VaultDB.putRecord('food_logs', record);
    await VaultDB.putRecord('user_settings', { key: 'profile', value: AppState.settings });
    VaultDB.writeMirror(AppState);

    if (triggerBtnEl) spawnParticleBurst(triggerBtnEl, '#FF7B5A');
    renderAll();
    triggerConfirmPulse('todayMacroCard');
    triggerConfirmPulse('fuelBankCard');

    const summaryParts = [];
    if (record.calories > 0) summaryParts.push(`+${record.calories} kcal`);
    if (record.protein > 0) summaryParts.push(`+${record.protein}g protein`);
    showToast(`Logged ${summaryParts.join(' / ')}`);
    return true;
  }

  function addIngredientDraft(inSheet = false) {
    const nameId = inSheet ? 'sheetBuilderIngNameInput' : 'builderIngNameInput';
    const calId = inSheet ? 'sheetBuilderIngCalInput' : 'builderIngCalInput';
    const proId = inSheet ? 'sheetBuilderIngProInput' : 'builderIngProInput';

    const nameEl = document.getElementById(nameId);
    const calEl = document.getElementById(calId);
    const proEl = document.getElementById(proId);

    const calories = Math.round(clampNumber(parseInt(calEl.value, 10) || 0, 0, 15000, 0));
    const protein = Math.round(clampNumber(parseInt(proEl.value, 10) || 0, 0, 1000, 0));
    if (calories <= 0 && protein <= 0) {
      showToast('Enter calories and/or protein for this ingredient');
      return;
    }

    const name = cleanText(nameEl.value, 80) || `Ingredient (${calories} kcal)`;
    const targetList = inSheet ? AppState.sheetBuilderIngredients : AppState.builderIngredients;
    targetList.push({ name, calories, protein });

    rememberFoodItem(name, calories, protein);

    nameEl.value = '';
    calEl.value = '';
    proEl.value = '';

    renderMealBuilderDrafts(inSheet);
    renderAllFoodMemoryTrays();
  }

  async function saveBuiltMultiIngredientMeal(inSheet = false, btnEl = null) {
    const targetList = inSheet ? AppState.sheetBuilderIngredients : AppState.builderIngredients;
    const nameInId = inSheet ? 'sheetBuilderIngNameInput' : 'builderIngNameInput';
    const calInId = inSheet ? 'sheetBuilderIngCalInput' : 'builderIngCalInput';
    const proInId = inSheet ? 'sheetBuilderIngProInput' : 'builderIngProInput';
    const titleId = inSheet ? 'sheetBuilderMealTitleInput' : 'builderMealTitleInput';

    const pendingCal = parseInt(document.getElementById(calInId).value, 10) || 0;
    const pendingPro = parseInt(document.getElementById(proInId).value, 10) || 0;
    if (pendingCal > 0 || pendingPro > 0) {
      const pendingName = cleanText(document.getElementById(nameInId).value, 80) || 'Ingredient';
      targetList.push({ name: pendingName, calories: pendingCal, protein: pendingPro });
      document.getElementById(nameInId).value = '';
      document.getElementById(calInId).value = '';
      document.getElementById(proInId).value = '';
    }

    if (targetList.length === 0) {
      showToast('Add at least one ingredient to build the meal');
      return false;
    }

    const totalCal = targetList.reduce((s, i) => s + (i.calories || 0), 0);
    const totalPro = targetList.reduce((s, i) => s + (i.protein || 0), 0);
    const rawTitle = cleanText(document.getElementById(titleId).value, 80);
    const mealTitle = rawTitle || `Combined Meal (${targetList.length} items)`;

    const ok = await saveFoodLog(
      totalCal,
      totalPro,
      mealTitle,
      '',
      btnEl,
      targetList.slice()
    );

    if (ok) {
      if (inSheet) {
        AppState.sheetBuilderIngredients = [];
      } else {
        AppState.builderIngredients = [];
      }
      document.getElementById(titleId).value = '';
      renderMealBuilderDrafts(inSheet);
    }
    return ok;
  }

  async function copyFoodEntryToToday(entry) {
    const copy = sanitizeFoodRecord({
      id: generateId('food'),
      date: getLocalDateStr(),
      timestamp: Date.now(),
      calories: entry.calories,
      protein: entry.protein,
      note: entry.note,
      items: entry.items || []
    });
    if (!copy) return;
    AppState.foodLogs.push(copy);
    await VaultDB.putRecord('food_logs', copy);
    VaultDB.writeMirror(AppState);
    AppState.fuelSelectedDay = 'today';
    renderAll();
    showToast('Copied meal to Today');
  }

  function populateFoodFormForEdit(entry) {
    setMealLoggerMode('simple', false);
    const calIn = document.getElementById('fuelCalInput');
    const proIn = document.getElementById('fuelProInput');
    const noteIn = document.getElementById('fuelNoteInput');
    const editId = document.getElementById('fuelEditIdInput');
    const btnText = document.getElementById('fuelSubmitBtnText');

    if (calIn) calIn.value = entry.calories;
    if (proIn) proIn.value = entry.protein;
    if (noteIn) noteIn.value = entry.note || '';
    if (editId) editId.value = entry.id;
    if (btnText) btnText.textContent = 'Update Food Entry';

    const formCard = document.getElementById('fuelInlineFormCard');
    if (formCard) formCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function deleteFoodEntry(id) {
    AppState.foodLogs = AppState.foodLogs.filter((f) => f.id !== id);
    await VaultDB.deleteRecord('food_logs', id);
    VaultDB.writeMirror(AppState);
    renderAll();
    showToast('Food entry removed');
  }

  async function toggleHabitOnDate(habitId, targetDateStr = getLocalDateStr()) {
    const habit = AppState.habits.find((h) => h.id === habitId);
    if (!habit) return;

    const idx = habit.completedDates.indexOf(targetDateStr);
    if (idx >= 0) {
      habit.completedDates.splice(idx, 1);
      showToast(`${habit.name} unmarked (${formatDisplayDate(targetDateStr)})`);
    } else {
      habit.completedDates.push(targetDateStr);
      habit.completedDates.sort();
      habit.restDates = habit.restDates.filter((d) => d !== targetDateStr);
      showToast(`${habit.name} completed ✓`);
    }

    await VaultDB.putRecord('habits', habit);
    VaultDB.writeMirror(AppState);
    renderAll();
  }

  async function toggleHabitRestDayToday(habitId) {
    const todayStr = getLocalDateStr();
    const habit = AppState.habits.find((h) => h.id === habitId);
    if (!habit) return;

    const rIdx = habit.restDates.indexOf(todayStr);
    if (rIdx >= 0) {
      habit.restDates.splice(rIdx, 1);
      showToast(`Removed rest marker for ${habit.name}`);
    } else {
      habit.restDates.push(todayStr);
      habit.completedDates = habit.completedDates.filter((d) => d !== todayStr);
      showToast(`Logged intentional recovery day for ${habit.name}`);
    }

    await VaultDB.putRecord('habits', habit);
    VaultDB.writeMirror(AppState);
    renderAll();
  }

  async function addNewHabit(nameStr, targetPerWeek, themeKey = 'sage') {
    const chosenTheme = HABIT_THEMES[themeKey] || HABIT_THEMES.sage;
    const record = sanitizeHabitRecord(
      {
        id: generateId('habit'),
        name: nameStr,
        weeklyTarget: targetPerWeek,
        color: chosenTheme.color,
        icon: chosenTheme.icon,
        completedDates: [],
        restDates: [],
        createdAt: Date.now()
      },
      AppState.habits.length
    );
    if (!record) {
      showToast('Enter a habit name');
      return;
    }
    AppState.habits.push(record);
    await VaultDB.putRecord('habits', record);
    VaultDB.writeMirror(AppState);
    renderAll();
    showToast(`Added "${record.name}" (${record.weeklyTarget}x/wk)`);
  }

  async function deleteHabit(habitId) {
    if (AppState.habits.length <= 1) {
      showToast('Keep at least one active habit');
      return;
    }
    AppState.habits = AppState.habits.filter((h) => h.id !== habitId);
    await VaultDB.deleteRecord('habits', habitId);
    VaultDB.writeMirror(AppState);
    renderAll();
    showToast('Habit removed');
  }

  async function applyMonthlyStreakShield(btnEl) {
    const todayStr = getLocalDateStr();
    if (AppState.settings.shieldsRemaining <= 0) {
      showToast('No monthly shields remaining this month');
      return;
    }
    if (!Array.isArray(AppState.settings.shieldsUsedDates)) {
      AppState.settings.shieldsUsedDates = [];
    }
    if (AppState.settings.shieldsUsedDates.includes(todayStr)) {
      showToast('Streak Shield already active for today');
      return;
    }
    AppState.settings.shieldsRemaining = Math.max(0, AppState.settings.shieldsRemaining - 1);
    AppState.settings.shieldsUsedDates.push(todayStr);
    await VaultDB.putRecord('user_settings', { key: 'profile', value: AppState.settings });
    VaultDB.writeMirror(AppState);
    if (btnEl) spawnParticleBurst(btnEl, '#F7B955');
    renderAll();
    showToast('Streak Shield activated — consistency protected');
  }

  async function executeComebackProtocol() {
    const todayStr = getLocalDateStr();
    AppState.settings.comebackStartDate = todayStr;
    AppState.settings.archivedComebacksCount = (AppState.settings.archivedComebacksCount || 0) + 1;
    AppState.settings.shieldsRemaining = 2;

    AppState.habits.forEach((h) => {
      h.completedDates = h.completedDates.filter((d) => d === todayStr);
      h.restDates = h.restDates.filter((d) => d === todayStr);
    });

    await persistAllState();
    renderAll();
    showToast('Day 1 starts today. Welcome back.');
  }

  /* ------------------------------------------------------------------------
     15. BACKUP & RESTORE ENGINE (SIMPLE MODE + NERDY EXPLAIN-EVERYTHING MODE)
     ------------------------------------------------------------------------ */

  function buildBackupPayloadObject() {
    const todayStr = getLocalDateStr();
    const rawPayload = {
      app: 'Zenith Mindful Health & Fitness Tracker',
      schemaVersion: SCHEMA_VERSION,
      appVersion: APP_VERSION,
      exportedAt: new Date().toISOString(),
      exportDate: todayStr,
      weight_logs: AppState.weightLogs,
      food_logs: AppState.foodLogs,
      habits: AppState.habits,
      user_settings: AppState.settings
    };
    rawPayload.integrityHash = computeIntegrityHash(rawPayload);
    return rawPayload;
  }

  async function setVaultViewMode(mode) {
    AppState.settings.vaultViewMode = mode === 'nerdy' ? 'nerdy' : 'simple';
    applyVaultViewModeToDOM();
    await VaultDB.putRecord('user_settings', { key: 'profile', value: AppState.settings });
    VaultDB.writeMirror(AppState);
    showToast(
      AppState.settings.vaultViewMode === 'nerdy'
        ? 'Nerdy Vault Mode: Full telemetry & architecture unlocked'
        : 'Simple Vault Mode: Clean 2-button view'
    );
  }

  async function exportBackupToFile() {
    const todayStr = getLocalDateStr();
    AppState.settings.lastBackupDate = todayStr;
    await VaultDB.putRecord('user_settings', { key: 'profile', value: AppState.settings });
    VaultDB.writeMirror(AppState);

    const payload = buildBackupPayloadObject();
    const jsonString = JSON.stringify(payload, null, 2);
    const filename = `vault-backup-${todayStr}.json`;
    const blob = new Blob([jsonString], { type: 'application/json' });

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    renderVaultTab();
    showToast(`Saved ${filename}`);
  }

  async function shareBackupViaNativeSheet() {
    const todayStr = getLocalDateStr();
    AppState.settings.lastBackupDate = todayStr;
    await VaultDB.putRecord('user_settings', { key: 'profile', value: AppState.settings });
    VaultDB.writeMirror(AppState);

    const payload = buildBackupPayloadObject();
    const jsonString = JSON.stringify(payload, null, 2);
    const filename = `vault-backup-${todayStr}.json`;

    try {
      if (navigator.canShare && window.File) {
        const file = new File([jsonString], filename, { type: 'application/json' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({
            title: `Zenith Vault Backup (${todayStr})`,
            text: 'Zenith offline health & fitness vault backup.',
            files: [file]
          });
          renderVaultTab();
          showToast('Shared via iOS Share Sheet');
          return;
        }
      }
      if (navigator.share) {
        await navigator.share({
          title: `Zenith Vault Backup (${todayStr})`,
          text: jsonString
        });
        renderVaultTab();
        showToast('Shared backup data');
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }

    await exportBackupToFile();
  }

  async function copyBackupToClipboard() {
    const todayStr = getLocalDateStr();
    AppState.settings.lastBackupDate = todayStr;
    await VaultDB.putRecord('user_settings', { key: 'profile', value: AppState.settings });
    VaultDB.writeMirror(AppState);

    const payload = buildBackupPayloadObject();
    const jsonString = JSON.stringify(payload);

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(jsonString);
        renderVaultTab();
        showToast('Portable backup JSON copied to clipboard');
        return;
      }
    } catch (e) {
      // Fallback below
    }

    const tempArea = document.createElement('textarea');
    tempArea.value = jsonString;
    tempArea.style.position = 'fixed';
    tempArea.style.opacity = '0';
    document.body.appendChild(tempArea);
    tempArea.select();
    try {
      document.execCommand('copy');
      renderVaultTab();
      showToast('Portable backup JSON copied to clipboard');
    } catch (e) {
      showToast('Could not copy automatically — use Save Backup');
    }
    document.body.removeChild(tempArea);
  }

  async function restoreFromBackupJsonString(rawJsonText) {
    let parsed;
    try {
      parsed = safeJsonParse(rawJsonText);
    } catch (err) {
      showToast('Invalid JSON backup file');
      return false;
    }

    if (!parsed || typeof parsed !== 'object') {
      showToast('Backup structure not recognized');
      return false;
    }

    const rootObj = parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;

    const rawWeights = Array.isArray(rootObj.weight_logs)
      ? rootObj.weight_logs
      : Array.isArray(rootObj.weights)
      ? rootObj.weights
      : [];
    const rawFoods = Array.isArray(rootObj.food_logs)
      ? rootObj.food_logs
      : Array.isArray(rootObj.nutrition_logs)
      ? rootObj.nutrition_logs
      : [];
    const rawHabits = Array.isArray(rootObj.habits) ? rootObj.habits : [];
    const rawSettings = rootObj.user_settings || rootObj.settings || {};

    const incomingWeights = rawWeights.map(sanitizeWeightRecord).filter(Boolean);
    const incomingFoods = rawFoods.map(sanitizeFoodRecord).filter(Boolean);
    const incomingHabits = rawHabits.map((h, i) => sanitizeHabitRecord(h, i)).filter(Boolean);

    if (
      incomingWeights.length === 0 &&
      incomingFoods.length === 0 &&
      incomingHabits.length === 0 &&
      Object.keys(rawSettings).length === 0
    ) {
      showToast('No valid health records found in backup');
      return false;
    }

    try {
      const rollbackPayload = buildBackupPayloadObject();
      window.localStorage.setItem(ROLLBACK_STORAGE_KEY, JSON.stringify(rollbackPayload));
    } catch (e) {
      // Ignore storage quota limits
    }

    if (AppState.restoreMode === 'replace') {
      AppState.weightLogs = incomingWeights;
      AppState.foodLogs = incomingFoods;
      AppState.habits = incomingHabits.length > 0 ? incomingHabits : AppState.habits;
      AppState.settings = sanitizeSettingsRecord(
        Object.assign({}, rawSettings, { lastBackupDate: getLocalDateStr() })
      );
    } else {
      const weightByDate = new Map();
      AppState.weightLogs.forEach((w) => weightByDate.set(w.date, w));
      incomingWeights.forEach((w) => {
        const existing = weightByDate.get(w.date);
        if (!existing || w.timestamp >= existing.timestamp) {
          weightByDate.set(w.date, w);
        }
      });
      AppState.weightLogs = Array.from(weightByDate.values());

      const foodById = new Map();
      AppState.foodLogs.forEach((f) => foodById.set(f.id, f));
      incomingFoods.forEach((f) => foodById.set(f.id, f));
      AppState.foodLogs = Array.from(foodById.values());

      const habitById = new Map();
      AppState.habits.forEach((h) => habitById.set(h.id, h));
      incomingHabits.forEach((h) => {
        const existing = habitById.get(h.id);
        if (existing) {
          existing.completedDates = Array.from(
            new Set([...existing.completedDates, ...h.completedDates])
          ).sort();
          existing.restDates = Array.from(new Set([...existing.restDates, ...h.restDates])).sort();
          existing.weeklyTarget = h.weeklyTarget || existing.weeklyTarget;
        } else {
          habitById.set(h.id, h);
        }
      });
      AppState.habits = Array.from(habitById.values());

      AppState.settings = sanitizeSettingsRecord(
        Object.assign({}, AppState.settings, rawSettings, { lastBackupDate: getLocalDateStr() })
      );
    }

    syncPastFoodsIntoMemory();
    applyTheme(AppState.settings.theme);
    await persistAllState();
    renderAll();
    showToast(
      `Vault restored (${AppState.restoreMode === 'merge' ? 'Smart Merged' : 'Full Replaced'})`
    );
    return true;
  }

  async function undoLastRestore() {
    try {
      const rawRollback = window.localStorage.getItem(ROLLBACK_STORAGE_KEY);
      if (!rawRollback) {
        showToast('No rollback snapshot found');
        return;
      }
      const prevMode = AppState.restoreMode;
      AppState.restoreMode = 'replace';
      await restoreFromBackupJsonString(rawRollback);
      AppState.restoreMode = prevMode;
      window.localStorage.removeItem(ROLLBACK_STORAGE_KEY);
      renderVaultTab();
      showToast('Reverted to pre-restore vault snapshot');
    } catch (e) {
      showToast('Could not undo restore');
    }
  }

  /* ------------------------------------------------------------------------
     16. MODAL SHEETS, NAVIGATION & EVENT WIRING
     ------------------------------------------------------------------------ */

  function openSheet(backdropId) {
    const backdrop = document.getElementById(backdropId);
    if (!backdrop) return;
    backdrop.classList.add('open');
    backdrop.setAttribute('aria-hidden', 'false');
  }

  function closeSheet(backdropId) {
    const backdrop = document.getElementById(backdropId);
    if (!backdrop) return;
    backdrop.classList.remove('open');
    backdrop.setAttribute('aria-hidden', 'true');
  }

  function openConfirmModal(title, bodyText, confirmLabel, onConfirm) {
    const titleEl = document.getElementById('confirmSheetTitle');
    const bodyEl = document.getElementById('confirmSheetBody');
    const proceedBtn = document.getElementById('confirmProceedBtn');

    if (titleEl) titleEl.textContent = title;
    if (bodyEl) bodyEl.textContent = bodyText;
    if (proceedBtn) proceedBtn.textContent = confirmLabel || 'Confirm';

    AppState.pendingConfirmAction = onConfirm;
    openSheet('confirmSheetBackdrop');
  }

  function setMealLoggerMode(mode, inSheet = false) {
    const isBuilder = mode === 'builder';
    if (inSheet) {
      AppState.sheetMealLoggerMode = mode;
      document.getElementById('sheetMealModeSimpleBtn').classList.toggle('active', !isBuilder);
      document.getElementById('sheetMealModeBuilderBtn').classList.toggle('active', isBuilder);
      document.getElementById('sheetSimpleModeBox').style.display = isBuilder ? 'none' : 'block';
      document.getElementById('sheetBuilderModeBox').style.display = isBuilder ? 'block' : 'none';
      renderMealBuilderDrafts(true);
    } else {
      AppState.mealLoggerMode = mode;
      document.getElementById('mealModeSimpleBtn').classList.toggle('active', !isBuilder);
      document.getElementById('mealModeBuilderBtn').classList.toggle('active', isBuilder);
      document.getElementById('simpleMealModeBox').style.display = isBuilder ? 'none' : 'block';
      document.getElementById('builderMealModeBox').style.display = isBuilder ? 'block' : 'none';
      renderMealBuilderDrafts(false);
    }
    renderAllFoodMemoryTrays();
  }

  function switchTab(tabName) {
    const validTabs = ['today', 'fuel', 'weight', 'vault'];
    const target = validTabs.includes(tabName) ? tabName : 'today';
    AppState.activeTab = target;

    validTabs.forEach((t) => {
      const view = document.getElementById(`view-${t}`);
      if (view) view.classList.toggle('active', t === target);
    });

    document.querySelectorAll('.nav-tab').forEach((btn) => {
      const isMatch = btn.getAttribute('data-tab') === target;
      btn.classList.toggle('active', isMatch);
    });

    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (target === 'weight') {
      renderWeightTab(true);
      animateWeightTrendChart();
    } else if (target === 'fuel') {
      renderFuelTab();
    } else if (target === 'vault') {
      renderVaultTab();
    } else {
      renderTodayTab();
    }
  }

  function adjustInputStepper(inputId, delta) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const unit = AppState.settings.unit;
    const fallback = kgToDisplay(AppState.settings.goalWeightKg, unit);
    const current = parseFloat(input.value);
    const base = Number.isFinite(current) ? current : fallback;
    const next = Math.max(20, Math.min(600, base + delta));
    input.value = next.toFixed(1);
  }

  async function handleQuickMacroIncrement(calDelta, proDelta, inSheet = false, btnEl = null) {
    if (!inSheet && AppState.settings.instantTapFuel) {
      await saveFoodLog(calDelta, proDelta, '', '', btnEl);
      return;
    }

    if (btnEl) spawnParticleBurst(btnEl, calDelta > 0 ? '#FF7B5A' : '#48D69D');

    const calInputId = inSheet ? 'sheetFuelCalInput' : 'fuelCalInput';
    const proInputId = inSheet ? 'sheetFuelProInput' : 'fuelProInput';
    const calEl = document.getElementById(calInputId);
    const proEl = document.getElementById(proInputId);

    if (calEl && calDelta > 0) {
      const curCal = parseInt(calEl.value, 10) || 0;
      calEl.value = curCal + calDelta;
    }
    if (proEl && proDelta > 0) {
      const curPro = parseInt(proEl.value, 10) || 0;
      proEl.value = curPro + proDelta;
    }
  }

  function setupEventListeners() {
    // 1. Bottom Navigation Tabs
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        switchTab(tab);
      });
    });

    const goToHabitsBtn = document.getElementById('goToHabitsTabBtn');
    if (goToHabitsBtn) {
      goToHabitsBtn.addEventListener('click', () => switchTab('vault'));
    }

    // 2. Tiny Card-Top Resize (Full / Mid / Mini) & Move (↑ / ↓) Micro-Toggles
    document.querySelectorAll('.micro-resize-btn[data-cycle-widget]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wKey = btn.getAttribute('data-cycle-widget');
        if (wKey) cycleWidgetSize(wKey);
      });
    });

    document.querySelectorAll('.micro-move-btn[data-move-widget]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wKey = btn.getAttribute('data-move-widget');
        const dir = parseInt(btn.getAttribute('data-dir'), 10) || 0;
        if (wKey && dir !== 0) {
          moveDashboardWidget(wKey, dir);
        }
      });
    });

    const resetOrderSettingsBtn = document.getElementById('resetDashboardOrderSettingsBtn');
    if (resetOrderSettingsBtn) {
      resetOrderSettingsBtn.addEventListener('click', async () => {
        await resetDashboardLayout();
        closeSheet('settingsSheetBackdrop');
      });
    }

    // 3. Info (ⓘ) Explainer Buttons
    document.querySelectorAll('.info-trigger-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const topic = btn.getAttribute('data-info');
        if (topic) openInfoModal(topic);
      });
    });

    // 4. Header Theme Toggle & Settings Button
    const themeToggleBtn = document.getElementById('themeToggleBtn');
    if (themeToggleBtn) {
      themeToggleBtn.addEventListener('click', async () => {
        const order = ['dark', 'light', 'auto'];
        const nextIdx = (order.indexOf(AppState.settings.theme) + 1) % order.length;
        AppState.settings.theme = order[nextIdx];
        applyTheme(AppState.settings.theme);
        await VaultDB.putRecord('user_settings', { key: 'profile', value: AppState.settings });
        VaultDB.writeMirror(AppState);
        renderWeightTrendChart();
        showToast(`Appearance: ${AppState.settings.theme.toUpperCase()}`);
      });
    }

    const openSettingsHandler = () => {
      const unit = AppState.settings.unit;
      document.getElementById('settingCalTarget').value = AppState.settings.calorieTarget;
      document.getElementById('settingProTarget').value = AppState.settings.proteinTarget;
      document.getElementById('settingGoalWeight').value = kgToDisplay(
        AppState.settings.goalWeightKg,
        unit
      ).toFixed(1);
      document.getElementById('settingGoalWeightLabel').textContent = `Goal Weight (${unit})`;
      document.getElementById('settingThemeSelect').value = AppState.settings.theme;
      document.getElementById('pasteRestoreContainer').style.display = 'none';
      openSheet('settingsSheetBackdrop');
    };

    const settingsBtn = document.getElementById('openSettingsSheetBtn');
    const editTargetsQuickBtn = document.getElementById('editTargetsQuickBtn');
    if (settingsBtn) settingsBtn.addEventListener('click', openSettingsHandler);
    if (editTargetsQuickBtn) editTargetsQuickBtn.addEventListener('click', openSettingsHandler);

    // 5. Today Tab Fast-Log Sheet Triggers (Full, Mid & Mini Buttons)
    const openFastWeightSheet = () => {
      const series = computeWeightSeriesWithEMA();
      const latest = series.length > 0 ? series[series.length - 1] : null;
      const refKg = latest ? latest.weightKg : AppState.settings.goalWeightKg;
      const sheetInput = document.getElementById('sheetWeightInput');
      const sheetNote = document.getElementById('sheetWeightNote');
      if (sheetInput) {
        sheetInput.value = kgToDisplay(refKg, AppState.settings.unit).toFixed(1);
      }
      if (sheetNote) sheetNote.value = '';
      openSheet('weightSheetBackdrop');
    };

    const openFastFoodSheet = () => {
      document.getElementById('sheetFuelCalInput').value = '';
      document.getElementById('sheetFuelProInput').value = '';
      document.getElementById('sheetFuelNoteInput').value = '';
      renderAllFoodMemoryTrays();
      renderMealBuilderDrafts(true);
      openSheet('fuelSheetBackdrop');
    };

    ['fastLogWeightBtn', 'fastLogWeightCompactBtn', 'summaryQuickWeightBtn'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', openFastWeightSheet);
    });

    ['fastLogFuelBtn', 'fastLogFuelCompactBtn', 'summaryQuickFoodBtn'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', openFastFoodSheet);
    });

    // 6. Close Sheet Buttons & Backdrop Taps
    [
      ['closeWeightSheetBtn', 'weightSheetBackdrop'],
      ['closeFuelSheetBtn', 'fuelSheetBackdrop'],
      ['closeSettingsSheetBtn', 'settingsSheetBackdrop'],
      ['closeConfirmSheetBtn', 'confirmSheetBackdrop'],
      ['confirmCancelBtn', 'confirmSheetBackdrop'],
      ['closeInfoSheetBtn', 'infoSheetBackdrop'],
      ['infoGotItBtn', 'infoSheetBackdrop']
    ].forEach(([btnId, backdropId]) => {
      const btn = document.getElementById(btnId);
      if (btn) btn.addEventListener('click', () => closeSheet(backdropId));
    });

    [
      'weightSheetBackdrop',
      'fuelSheetBackdrop',
      'settingsSheetBackdrop',
      'confirmSheetBackdrop',
      'infoSheetBackdrop'
    ].forEach((backdropId) => {
      const bd = document.getElementById(backdropId);
      if (bd) {
        bd.addEventListener('click', (e) => {
          if (e.target === bd) closeSheet(backdropId);
        });
      }
    });

    const confirmProceedBtn = document.getElementById('confirmProceedBtn');
    if (confirmProceedBtn) {
      confirmProceedBtn.addEventListener('click', async () => {
        closeSheet('confirmSheetBackdrop');
        if (typeof AppState.pendingConfirmAction === 'function') {
          const fn = AppState.pendingConfirmAction;
          AppState.pendingConfirmAction = null;
          await fn();
        }
      });
    }

    // 7. Fast Weight Sheet Steppers & Save
    document.getElementById('sheetWeightDownBig').addEventListener('click', () => adjustInputStepper('sheetWeightInput', -0.5));
    document.getElementById('sheetWeightDownSmall').addEventListener('click', () => adjustInputStepper('sheetWeightInput', -0.1));
    document.getElementById('sheetWeightUpSmall').addEventListener('click', () => adjustInputStepper('sheetWeightInput', 0.1));
    document.getElementById('sheetWeightUpBig').addEventListener('click', () => adjustInputStepper('sheetWeightInput', 0.5));

    const sheetWeightSaveBtn = document.getElementById('sheetWeightSaveBtn');
    sheetWeightSaveBtn.addEventListener('click', async () => {
      const val = parseFloat(document.getElementById('sheetWeightInput').value);
      const note = document.getElementById('sheetWeightNote').value;
      const ok = await saveWeightLog(val, getLocalDateStr(), note, '', sheetWeightSaveBtn);
      if (ok) closeSheet('weightSheetBackdrop');
    });

    // 8. Meal Logger Mode Switchers & Search Input Listeners
    document.getElementById('mealModeSimpleBtn').addEventListener('click', () => setMealLoggerMode('simple', false));
    document.getElementById('mealModeBuilderBtn').addEventListener('click', () => setMealLoggerMode('builder', false));
    document.getElementById('sheetMealModeSimpleBtn').addEventListener('click', () => setMealLoggerMode('simple', true));
    document.getElementById('sheetMealModeBuilderBtn').addEventListener('click', () => setMealLoggerMode('builder', true));

    ['fuelNoteInput', 'builderIngNameInput', 'sheetFuelNoteInput', 'sheetBuilderIngNameInput'].forEach(
      (inputId) => {
        const el = document.getElementById(inputId);
        if (el) {
          el.addEventListener('input', () => renderAllFoodMemoryTrays());
        }
      }
    );

    document.getElementById('addIngredientToMealBtn').addEventListener('click', () => addIngredientDraft(false));
    document.getElementById('sheetAddIngredientBtn').addEventListener('click', () => addIngredientDraft(true));

    const saveBuiltMealBtn = document.getElementById('saveBuiltMealBtn');
    saveBuiltMealBtn.addEventListener('click', async () => {
      await saveBuiltMultiIngredientMeal(false, saveBuiltMealBtn);
    });

    const sheetSaveBuiltMealBtn = document.getElementById('sheetSaveBuiltMealBtn');
    sheetSaveBuiltMealBtn.addEventListener('click', async () => {
      const ok = await saveBuiltMultiIngredientMeal(true, sheetSaveBuiltMealBtn);
      if (ok) closeSheet('fuelSheetBackdrop');
    });

    // 9. Fast Food Sheet Pills & Save
    const s250 = document.getElementById('sheetPill250Cal');
    const s500 = document.getElementById('sheetPill500Cal');
    const s25p = document.getElementById('sheetPill25Pro');
    const s50p = document.getElementById('sheetPill50Pro');

    s250.addEventListener('click', () => handleQuickMacroIncrement(250, 0, true, s250));
    s500.addEventListener('click', () => handleQuickMacroIncrement(500, 0, true, s500));
    s25p.addEventListener('click', () => handleQuickMacroIncrement(0, 25, true, s25p));
    s50p.addEventListener('click', () => handleQuickMacroIncrement(0, 50, true, s50p));

    document.getElementById('sheetFuelResetBtn').addEventListener('click', () => {
      document.getElementById('sheetFuelCalInput').value = '';
      document.getElementById('sheetFuelProInput').value = '';
      document.getElementById('sheetFuelNoteInput').value = '';
      renderAllFoodMemoryTrays();
    });

    const sheetFuelSaveBtn = document.getElementById('sheetFuelSaveBtn');
    sheetFuelSaveBtn.addEventListener('click', async () => {
      const cal = parseInt(document.getElementById('sheetFuelCalInput').value, 10) || 0;
      const pro = parseInt(document.getElementById('sheetFuelProInput').value, 10) || 0;
      const note = document.getElementById('sheetFuelNoteInput').value;
      const ok = await saveFoodLog(cal, pro, note, '', sheetFuelSaveBtn);
      if (ok) closeSheet('fuelSheetBackdrop');
    });

    // 10. Tab 2: Food & Nutrition Controls
    document.getElementById('fuelDayTodayBtn').addEventListener('click', () => {
      AppState.fuelSelectedDay = 'today';
      renderFuelTab();
    });
    document.getElementById('fuelDayYesterdayBtn').addEventListener('click', () => {
      AppState.fuelSelectedDay = 'yesterday';
      renderFuelTab();
    });

    document.getElementById('instantTapModeBtn').addEventListener('click', async () => {
      AppState.settings.instantTapFuel = !AppState.settings.instantTapFuel;
      await VaultDB.putRecord('user_settings', { key: 'profile', value: AppState.settings });
      VaultDB.writeMirror(AppState);
      renderFuelTab();
      showToast(
        AppState.settings.instantTapFuel
          ? '1-Tap Instant Mode ON: Pills log immediately'
          : '1-Tap Instant Mode OFF: Pills stack in form'
      );
    });

    const p250 = document.getElementById('pillAdd250Cal');
    const p500 = document.getElementById('pillAdd500Cal');
    const p25p = document.getElementById('pillAdd25Pro');
    const p50p = document.getElementById('pillAdd50Pro');

    p250.addEventListener('click', () => handleQuickMacroIncrement(250, 0, false, p250));
    p500.addEventListener('click', () => handleQuickMacroIncrement(500, 0, false, p500));
    p25p.addEventListener('click', () => handleQuickMacroIncrement(0, 25, false, p25p));
    p50p.addEventListener('click', () => handleQuickMacroIncrement(0, 50, false, p50p));

    const resetFuelForm = () => {
      document.getElementById('fuelCalInput').value = '';
      document.getElementById('fuelProInput').value = '';
      document.getElementById('fuelNoteInput').value = '';
      document.getElementById('fuelEditIdInput').value = '';
      document.getElementById('fuelSubmitBtnText').textContent = 'Add Food Entry';
      renderAllFoodMemoryTrays();
    };

    document.getElementById('fuelResetInputBtn').addEventListener('click', resetFuelForm);

    document.getElementById('fuelEntryForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const cal = parseInt(document.getElementById('fuelCalInput').value, 10) || 0;
      const pro = parseInt(document.getElementById('fuelProInput').value, 10) || 0;
      const note = document.getElementById('fuelNoteInput').value;
      const editId = document.getElementById('fuelEditIdInput').value;
      const submitBtn = document.getElementById('fuelSubmitBtn');
      const ok = await saveFoodLog(cal, pro, note, editId, submitBtn);
      if (ok) resetFuelForm();
    });

    // 11. Tab 3: Weight & Trends Controls
    const switchUnit = async (newUnit) => {
      if (AppState.settings.unit === newUnit) return;
      AppState.settings.unit = newUnit;
      await VaultDB.putRecord('user_settings', { key: 'profile', value: AppState.settings });
      VaultDB.writeMirror(AppState);
      document.getElementById('weightEditIdInput').value = '';
      renderWeightTab(true);
      renderTodayTab();
      showToast(`Display unit set to ${newUnit}`);
    };

    document.getElementById('unitKgBtn').addEventListener('click', () => switchUnit('kg'));
    document.getElementById('unitLbsBtn').addEventListener('click', () => switchUnit('lbs'));

    document.getElementById('weightStepDownBig').addEventListener('click', () => adjustInputStepper('weightValInput', -0.5));
    document.getElementById('weightStepDownSmall').addEventListener('click', () => adjustInputStepper('weightValInput', -0.1));
    document.getElementById('weightStepUpSmall').addEventListener('click', () => adjustInputStepper('weightValInput', 0.1));
    document.getElementById('weightStepUpBig').addEventListener('click', () => adjustInputStepper('weightValInput', 0.5));

    document.getElementById('weightEntryForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const val = parseFloat(document.getElementById('weightValInput').value);
      const dateStr = document.getElementById('weightDateInput').value || getLocalDateStr();
      const note = document.getElementById('weightNoteInput').value;
      const editId = document.getElementById('weightEditIdInput').value;
      const submitBtn = document.getElementById('weightSubmitBtn');

      const ok = await saveWeightLog(val, dateStr, note, editId, submitBtn);
      if (ok) {
        document.getElementById('weightNoteInput').value = '';
        document.getElementById('weightEditIdInput').value = '';
        document.getElementById('weightSubmitBtnText').textContent = 'Save Scale Weight';
      }
    });

    document.querySelectorAll('.tf-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const days = parseInt(btn.getAttribute('data-days'), 10) || 30;
        AppState.chartTimeframeDays = days;
        document.querySelectorAll('.tf-btn').forEach((b) => b.classList.toggle('active', b === btn));
        animateWeightTrendChart();
      });
    });

    const canvas = document.getElementById('weightTrendCanvas');
    const scrubReadout = document.getElementById('chartScrubReadout');
    if (canvas && scrubReadout) {
      const handlePointerMove = (clientX) => {
        const pts = AppState.chartPointsCache;
        if (!pts || pts.length === 0) return;
        const rect = canvas.getBoundingClientRect();
        const relX = clientX - rect.left;
        let closestIdx = 0;
        let bestDist = Infinity;
        pts.forEach((pt, idx) => {
          const d = Math.abs(pt.x - relX);
          if (d < bestDist) {
            bestDist = d;
            closestIdx = idx;
          }
        });
        const chosen = pts[closestIdx];
        const unit = AppState.settings.unit;
        scrubReadout.textContent = `${formatDisplayDate(chosen.date)}: ${chosen.rawVal.toFixed(1)}${unit} (EMA ${chosen.emaVal.toFixed(1)}${unit})`;
        renderWeightTrendChart(closestIdx);
      };

      canvas.addEventListener('touchmove', (e) => {
        if (e.touches && e.touches[0]) handlePointerMove(e.touches[0].clientX);
      }, { passive: true });
      canvas.addEventListener('touchstart', (e) => {
        if (e.touches && e.touches[0]) handlePointerMove(e.touches[0].clientX);
      }, { passive: true });
      canvas.addEventListener('mousemove', (e) => handlePointerMove(e.clientX));
      canvas.addEventListener('mouseleave', () => {
        scrubReadout.textContent = 'Touch chart to inspect';
        renderWeightTrendChart(null);
      });
    }

    // 12. Tab 4: Habits Studio, Comeback Protocol & Dual-Mode Vault Controls
    const applyShieldBtn = document.getElementById('applyShieldBtn');
    applyShieldBtn.addEventListener('click', () => applyMonthlyStreakShield(applyShieldBtn));

    document.getElementById('addHabitForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameIn = document.getElementById('newHabitNameInput');
      const targetSel = document.getElementById('newHabitTargetSelect');
      const themeSel = document.getElementById('newHabitThemeSelect');
      const addBtn = document.getElementById('addHabitBtn');
      const themeKey = themeSel ? themeSel.value : 'sage';
      await addNewHabit(nameIn.value, parseInt(targetSel.value, 10) || 4, themeKey);
      if (nameIn.value.trim()) spawnParticleBurst(addBtn, '#48D69D');
      nameIn.value = '';
    });

    document.getElementById('triggerComebackBtn').addEventListener('click', () => {
      openConfirmModal(
        'Activate Comeback Protocol?',
        'Your historical weight and food logs remain untouched. Past habit streak gaps will be archived cleanly so your active consistency resets to 100% starting today ("Day 1 starts today").',
        'Start Day 1 Today',
        executeComebackProtocol
      );
    });

    // Vault Mode Switchers (Simple vs Nerdy)
    document.getElementById('vaultModeSimpleBtn').addEventListener('click', () => setVaultViewMode('simple'));
    document.getElementById('vaultModeNerdyBtn').addEventListener('click', () => setVaultViewMode('nerdy'));

    // Simple Mode 2-Button Actions
    document.getElementById('simpleSaveBackupBtn').addEventListener('click', () => exportBackupToFile());
    const fileInput = document.getElementById('restoreFileInput');
    document.getElementById('simpleRestoreBackupBtn').addEventListener('click', () => {
      AppState.restoreMode = 'merge'; // Always safe merge in Simple mode
      if (fileInput) {
        fileInput.value = '';
        fileInput.click();
      }
    });

    // Nerdy Mode Power Actions
    document.getElementById('exportVaultBtn').addEventListener('click', () => exportBackupToFile());
    document.getElementById('shareVaultNativeBtn').addEventListener('click', () => shareBackupViaNativeSheet());
    document.getElementById('copyVaultClipboardBtn').addEventListener('click', () => copyBackupToClipboard());

    const mergeBtn = document.getElementById('restoreModeMergeBtn');
    const replaceBtn = document.getElementById('restoreModeReplaceBtn');
    if (mergeBtn && replaceBtn) {
      mergeBtn.addEventListener('click', () => {
        AppState.restoreMode = 'merge';
        mergeBtn.classList.add('active');
        replaceBtn.classList.remove('active');
      });
      replaceBtn.addEventListener('click', () => {
        AppState.restoreMode = 'replace';
        replaceBtn.classList.add('active');
        mergeBtn.classList.remove('active');
      });
    }

    document.getElementById('openRestoreTriggerBtn').addEventListener('click', () => {
      if (fileInput) {
        fileInput.value = '';
        fileInput.click();
      }
    });

    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        if (file.size > MAX_BACKUP_BYTES) {
          showToast('Backup file exceeds 15MB safety limit');
          return;
        }
        const reader = new FileReader();
        reader.onload = async (ev) => {
          const text = String(ev.target.result || '');
          await restoreFromBackupJsonString(text);
        };
        reader.readAsText(file);
      });
    }

    document.getElementById('openPasteRestoreBtn').addEventListener('click', () => {
      openSettingsHandler();
      const box = document.getElementById('pasteRestoreContainer');
      if (box) {
        box.style.display = 'block';
        document.getElementById('pasteBackupTextarea').focus();
      }
    });

    document.getElementById('confirmPasteRestoreBtn').addEventListener('click', async () => {
      const raw = document.getElementById('pasteBackupTextarea').value;
      const ok = await restoreFromBackupJsonString(raw);
      if (ok) {
        document.getElementById('pasteBackupTextarea').value = '';
        closeSheet('settingsSheetBackdrop');
      }
    });

    document.getElementById('undoRestoreBtn').addEventListener('click', () => undoLastRestore());

    // 13. Settings Form Save & Demo Seed
    document.getElementById('settingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const unit = AppState.settings.unit;
      const calTarget = parseInt(document.getElementById('settingCalTarget').value, 10) || 2450;
      const proTarget = parseInt(document.getElementById('settingProTarget').value, 10) || 185;
      const goalDisp = parseFloat(document.getElementById('settingGoalWeight').value) || 80;
      const themeVal = document.getElementById('settingThemeSelect').value;

      AppState.settings = sanitizeSettingsRecord(
        Object.assign({}, AppState.settings, {
          calorieTarget: calTarget,
          proteinTarget: proTarget,
          goalWeightKg: displayToKg(goalDisp, unit),
          theme: themeVal
        })
      );

      applyTheme(AppState.settings.theme);
      await VaultDB.putRecord('user_settings', { key: 'profile', value: AppState.settings });
      VaultDB.writeMirror(AppState);
      closeSheet('settingsSheetBackdrop');
      renderAll();
      showToast('Targets & preferences saved');
    });

    document.getElementById('seedDemoDataBtn').addEventListener('click', async () => {
      const seeded = buildDefaultSeedState();
      seeded.settings.unit = AppState.settings.unit;
      seeded.settings.theme = AppState.settings.theme;
      seeded.settings.vaultViewMode = AppState.settings.vaultViewMode;
      seeded.settings.dashboardOrder = AppState.settings.dashboardOrder;
      seeded.settings.dashboardSizes = AppState.settings.dashboardSizes;
      AppState.weightLogs = seeded.weightLogs;
      AppState.foodLogs = seeded.foodLogs;
      AppState.habits = seeded.habits;
      AppState.settings = seeded.settings;
      syncPastFoodsIntoMemory();
      await persistAllState();
      closeSheet('settingsSheetBackdrop');
      renderAll();
      showToast('Loaded 24-day lifter sample history');
    });

    window.addEventListener('resize', () => {
      if (AppState.activeTab === 'weight') {
        requestAnimationFrame(() => renderWeightTrendChart());
      }
    });
    window.addEventListener('online', updateDynamicHeader);
    window.addEventListener('offline', updateDynamicHeader);
  }

  /* ------------------------------------------------------------------------
     17. SERVICE WORKER REGISTRATION (RELATIVE GITHUB PAGES SCOPING)
     ------------------------------------------------------------------------ */

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('./sw.js', { scope: './' })
        .catch(() => {});
    });
  }

  /* ------------------------------------------------------------------------
     18. BOOTSTRAP INITIALIZATION
     ------------------------------------------------------------------------ */

  async function initApp() {
    await loadInitialData();
    applyTheme(AppState.settings.theme);
    setupEventListeners();
    renderAll();
    registerServiceWorker();

    const hash = window.location.hash;
    if (hash === '#action=log-weight') {
      document.getElementById('fastLogWeightBtn').click();
    } else if (hash === '#action=log-food' || hash === '#action=log-fuel') {
      document.getElementById('fastLogFuelBtn').click();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})();