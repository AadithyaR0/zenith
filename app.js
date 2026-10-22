/**
 * ZENITH — MINDFUL STRENGTH & HEALTH TRACKER
 * 100% Offline-First | Zero External Dependencies | iOS Safari Optimized
 */

(function () {
  'use strict';

  /* ========================================================================
     1. DATE & FORMATTING UTILITIES
     ======================================================================== */
  const DateUtil = {
    todayISO() {
      const now = new Date();
      return this.toLocalISO(now);
    },
    yesterdayISO() {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return this.toLocalISO(d);
    },
    toLocalISO(dateObj) {
      const y = dateObj.getFullYear();
      const m = String(dateObj.getMonth() + 1).padStart(2, '0');
      const d = String(dateObj.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    },
    daysAgoISO(days) {
      const d = new Date();
      d.setDate(d.getDate() - days);
      return this.toLocalISO(d);
    },
    currentMonthKey() {
      return this.todayISO().slice(0, 7); // YYYY-MM
    },
    startOfWeekISO(dateStr) {
      const [y, m, d] = dateStr.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      const day = dt.getDay(); // 0 Sun .. 6 Sat
      const diff = dt.getDate() - day + (day === 0 ? -6 : 1); // Monday start
      dt.setDate(diff);
      return this.toLocalISO(dt);
    },
    formatShortDate(isoStr) {
      if (!isoStr) return '';
      const [y, m, d] = isoStr.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    },
    formatTime(timestamp) {
      const dt = new Date(timestamp);
      return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },
    daysBetween(isoA, isoB) {
      const a = new Date(isoA + 'T00:00:00');
      const b = new Date(isoB + 'T00:00:00');
      return Math.round((b - a) / 86400000);
    }
  };

  /* ========================================================================
     2. OFFLINE DATABASE ENGINE (IndexedDB + localStorage Fallback)
     ======================================================================== */
  const DB_NAME = 'ZenithVaultDB';
  const DB_VERSION = 1;
  const STORES = ['weight_logs', 'food_logs', 'habits', 'user_settings'];

  class ZenithStorage {
    constructor() {
      this.db = null;
      this.useFallback = false;
      this.fallbackPrefix = 'zenith_fb_';
    }

    async init() {
      // Request persistent storage from iOS WebKit
      if (navigator.storage && navigator.storage.persist) {
        try {
          await navigator.storage.persist();
        } catch (_) {
          // Ignore if unsupported
        }
      }

      if (!window.indexedDB) {
        this.useFallback = true;
        return;
      }

      return new Promise((resolve) => {
        try {
          const req = window.indexedDB.open(DB_NAME, DB_VERSION);

          req.onupgradeneeded = (e) => {
            const db = e.target.result;
            STORES.forEach((storeName) => {
              if (!db.objectStoreNames.contains(storeName)) {
                db.createObjectStore(storeName, { keyPath: 'id' });
              }
            });
          };

          req.onsuccess = (e) => {
            this.db = e.target.result;
            resolve();
          };

          req.onerror = () => {
            this.useFallback = true;
            resolve();
          };
        } catch (_) {
          this.useFallback = true;
          resolve();
        }
      });
    }

    _readFallbackStore(storeName) {
      try {
        const raw = localStorage.getItem(this.fallbackPrefix + storeName);
        return raw ? JSON.parse(raw) : [];
      } catch (_) {
        return [];
      }
    }

    _writeFallbackStore(storeName, items) {
      try {
        localStorage.setItem(this.fallbackPrefix + storeName, JSON.stringify(items));
      } catch (_) {
        // Storage quota full
      }
    }

    async getAll(storeName) {
      if (this.useFallback || !this.db) {
        return this._readFallbackStore(storeName);
      }
      return new Promise((resolve) => {
        try {
          const tx = this.db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve(this._readFallbackStore(storeName));
        } catch (_) {
          resolve(this._readFallbackStore(storeName));
        }
      });
    }

    async put(storeName, item) {
      // Always mirror to localStorage for instant synchronous resiliency
      const list = this._readFallbackStore(storeName);
      const idx = list.findIndex((x) => x.id === item.id);
      if (idx >= 0) {
        list[idx] = item;
      } else {
        list.push(item);
      }
      this._writeFallbackStore(storeName, list);

      if (this.useFallback || !this.db) {
        return item;
      }

      return new Promise((resolve) => {
        try {
          const tx = this.db.transaction(storeName, 'readwrite');
          const store = tx.objectStore(storeName);
          store.put(item);
          tx.oncomplete = () => resolve(item);
          tx.onerror = () => resolve(item);
        } catch (_) {
          resolve(item);
        }
      });
    }

    async delete(storeName, id) {
      const list = this._readFallbackStore(storeName).filter((x) => x.id !== id);
      this._writeFallbackStore(storeName, list);

      if (this.useFallback || !this.db) {
        return;
      }

      return new Promise((resolve) => {
        try {
          const tx = this.db.transaction(storeName, 'readwrite');
          tx.objectStore(storeName).delete(id);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch (_) {
          resolve();
        }
      });
    }

    async clearAndBulkPut(storeName, items) {
      this._writeFallbackStore(storeName, items);
      if (this.useFallback || !this.db) return;

      return new Promise((resolve) => {
        try {
          const tx = this.db.transaction(storeName, 'readwrite');
          const store = tx.objectStore(storeName);
          store.clear();
          items.forEach((item) => store.put(item));
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch (_) {
          resolve();
        }
      });
    }
  }

  /* ========================================================================
     3. APPLICATION STATE & DEFAULT CONFIGURATION
     ======================================================================== */
  const db = new ZenithStorage();

  const state = {
    settings: {
      id: 'profile',
      calorieTarget: 2500,
      proteinTarget: 185,
      goalWeightKg: 80.0,
      unit: 'kg', // 'kg' or 'lbs'
      theme: 'light', // 'light' or 'dark'
      lastBackupDate: null,
      comebackDate: null,
      shieldMonth: DateUtil.currentMonthKey(),
      shieldsRemaining: 2,
      shieldedDates: []
    },
    weightLogs: [], // { id, date: 'YYYY-MM-DD', weightKg: Number, note: String, timestamp: Number }
    foodLogs: [],   // { id, date: 'YYYY-MM-DD', calories: Number, protein: Number, note: String, timestamp: Number }
    habits: [],     // { id, name: String, targetPerWeek: Number, completedDates: ['YYYY-MM-DD'] }
    fuelViewDay: 'today', // 'today' or 'yesterday'
    chartTimeframeDays: 30,
    chartPointsCache: []
  };

  const DEFAULT_HABITS = [
    { id: 'hab-gym', name: 'Resistance Training', targetPerWeek: 4, completedDates: [] },
    { id: 'hab-walk', name: 'Daily Steps / Walk', targetPerWeek: 6, completedDates: [] },
    { id: 'hab-hydrate', name: 'Hydration & Electrolytes', targetPerWeek: 7, completedDates: [] },
    { id: 'hab-mobility', name: 'Mobility & Creatine', targetPerWeek: 5, completedDates: [] }
  ];

  /* ========================================================================
     4. UNIT CONVERSION & EMA TREND MATHEMATICS
     ======================================================================== */
  const KG_TO_LBS = 2.20462262;

  function toDisplayWeight(weightKg) {
    if (weightKg === null || weightKg === undefined || isNaN(weightKg)) return null;
    const val = state.settings.unit === 'lbs' ? weightKg * KG_TO_LBS : weightKg;
    return Number(val.toFixed(1));
  }

  function fromDisplayWeightToKg(inputVal) {
    const num = parseFloat(inputVal);
    if (isNaN(num)) return null;
    return state.settings.unit === 'lbs' ? num / KG_TO_LBS : num;
  }

  function unitSuffix() {
    return state.settings.unit === 'lbs' ? 'lbs' : 'kg';
  }

  /**
   * Computes sorted weight series with 7-Day Exponential Moving Average (EMA)
   * Smoothing factor alpha = 2 / (7 + 1) = 0.25
   */
  function computeWeightSeriesWithEMA() {
    const sorted = [...state.weightLogs].sort((a, b) => a.date.localeCompare(b.date));
    const alpha = 2 / (7 + 1);
    let currentEmaKg = null;

    return sorted.map((entry) => {
      if (currentEmaKg === null) {
        currentEmaKg = entry.weightKg;
      } else {
        currentEmaKg = entry.weightKg * alpha + currentEmaKg * (1 - alpha);
      }
      return {
        ...entry,
        emaKg: currentEmaKg
      };
    });
  }

  /* ========================================================================
     5. INITIALIZATION & DATA LOADING
     ======================================================================== */
  async function bootstrapApp() {
    await db.init();

    // Load settings
    const savedSettings = await db.getAll('user_settings');
    const profile = savedSettings.find((s) => s.id === 'profile');
    if (profile) {
      state.settings = { ...state.settings, ...profile };
    } else {
      // Detect system dark mode preference on first launch
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        state.settings.theme = 'dark';
      }
      await db.put('user_settings', state.settings);
    }

    // Reset monthly streak shields if entering a new calendar month
    const thisMonth = DateUtil.currentMonthKey();
    if (state.settings.shieldMonth !== thisMonth) {
      state.settings.shieldMonth = thisMonth;
      state.settings.shieldsRemaining = 2;
      await db.put('user_settings', state.settings);
    }

    // Load stores
    state.weightLogs = await db.getAll('weight_logs');
    state.foodLogs = await db.getAll('food_logs');
    state.habits = await db.getAll('habits');

    if (state.habits.length === 0) {
      for (const h of DEFAULT_HABITS) {
        const clone = { ...h, completedDates: [DateUtil.todayISO()] };
        state.habits.push(clone);
        await db.put('habits', clone);
      }
    }

    applyTheme();
    updateDynamicHeader();
    bindEventListeners();
    renderAll();
    registerServiceWorker();
  }

  /* ========================================================================
     6. DYNAMIC HEADER & THEME ENGINE
     ======================================================================== */
  function applyTheme() {
    const isDark = state.settings.theme === 'dark';
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    const metaTheme = document.getElementById('meta-theme-color');
    if (metaTheme) {
      metaTheme.setAttribute('content', isDark ? '#181715' : '#F6F3EC');
    }
  }

  function updateDynamicHeader() {
    const now = new Date();
    const hr = now.getHours();
    let greeting = 'Good evening';
    let subtitle = 'Unwind and recover well tonight.';

    if (hr >= 4 && hr < 12) {
      greeting = 'Good morning';
      subtitle = 'Own the morning. Signal over noise.';
    } else if (hr >= 12 && hr < 17) {
      greeting = 'Good afternoon';
      subtitle = 'Steady fuel, deliberate effort.';
    }

    const dateFormatted = now.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric'
    }).toUpperCase();

    document.getElementById('header-date').textContent = dateFormatted;
    document.getElementById('header-greeting').textContent = greeting;
    document.getElementById('header-subtitle').textContent = subtitle;
  }

  /* ========================================================================
     7. MASTER RENDER ORCHESTRATOR
     ======================================================================== */
  function renderAll() {
    renderBackupBanner();
    renderTodayTab();
    renderFuelTab();
    renderWeightTab();
    renderVaultTab();
  }

  function renderBackupBanner() {
    const banner = document.getElementById('backup-warning-banner');
    const badge = document.getElementById('vault-backup-badge');
    const lastDate = state.settings.lastBackupDate;

    const totalRecords = state.weightLogs.length + state.foodLogs.length;
    if (!lastDate) {
      if (totalRecords > 0) {
        banner.classList.remove('hidden');
        document.getElementById('backup-warning-text').textContent =
          'No offline backup saved yet. Tap to export to iOS Files.';
      } else {
        banner.classList.add('hidden');
      }
      badge.textContent = 'Never Backed Up';
      badge.className = 'pill-badge amber';
      return;
    }

    const daysSince = DateUtil.daysBetween(lastDate, DateUtil.todayISO());
    if (daysSince >= 30) {
      banner.classList.remove('hidden');
      document.getElementById('backup-warning-text').textContent =
        `Last vault backup was ${daysSince} days ago. Tap to back up.`;
      badge.textContent = `${daysSince}d Since Backup`;
      badge.className = 'pill-badge amber';
    } else {
      banner.classList.add('hidden');
      badge.textContent = `Backed up ${DateUtil.formatShortDate(lastDate)}`;
      badge.className = 'pill-badge sage';
    }
  }

  /* ========================================================================
     8. TAB 1: TODAY DASHBOARD RENDERING
     ======================================================================== */
  function renderTodayTab() {
    const today = DateUtil.todayISO();
    const todayMeals = state.foodLogs.filter((f) => f.date === today);

    const kcalActual = todayMeals.reduce((sum, m) => sum + (Number(m.calories) || 0), 0);
    const proActual = todayMeals.reduce((sum, m) => sum + (Number(m.protein) || 0), 0);

    const kcalTarget = state.settings.calorieTarget || 2500;
    const proTarget = state.settings.proteinTarget || 180;

    // Update SVG Rings (r = 50 -> circumference = 314.16)
    const circum = 314.16;
    const kcalPct = Math.min(1, kcalActual / kcalTarget);
    const proPct = Math.min(1, proActual / proTarget);

    document.getElementById('ring-kcal-fill').style.strokeDashoffset =
      String(circum - circum * kcalPct);
    document.getElementById('ring-protein-fill').style.strokeDashoffset =
      String(circum - circum * proPct);

    document.getElementById('today-kcal-actual').textContent = kcalActual.toLocaleString();
    document.getElementById('today-kcal-target').textContent = kcalTarget.toLocaleString();
    const kcalDiff = kcalTarget - kcalActual;
    document.getElementById('today-kcal-remaining').textContent =
      kcalDiff >= 0 ? `${kcalDiff.toLocaleString()} left` : `${Math.abs(kcalDiff).toLocaleString()} over`;

    document.getElementById('today-protein-actual').textContent = `${proActual}g`;
    document.getElementById('today-protein-target').textContent = `${proTarget}g`;
    const proDiff = proTarget - proActual;
    document.getElementById('today-protein-remaining').textContent =
      proDiff >= 0 ? `${proDiff}g left` : `+${Math.abs(proDiff)}g surplus`;

    // Status Pill
    const statusPill = document.getElementById('today-macro-status-pill');
    if (proActual >= proTarget * 0.9 && kcalActual <= kcalTarget * 1.08) {
      statusPill.textContent = 'Target Locked';
      statusPill.className = 'pill-badge sage';
    } else if (kcalActual === 0 && proActual === 0) {
      statusPill.textContent = 'Ready to Log';
      statusPill.className = 'pill-badge neutral';
    } else {
      statusPill.textContent = 'In Progress';
      statusPill.className = 'pill-badge';
    }

    // Fast-Log Weight Subtext
    const series = computeWeightSeriesWithEMA();
    const latestWeight = series.length > 0 ? series[series.length - 1] : null;
    const fastWeightSub = document.getElementById('fast-weight-sub');
    if (latestWeight) {
      fastWeightSub.textContent = `Last: ${toDisplayWeight(latestWeight.weightKg)} ${unitSuffix()}`;
    } else {
      fastWeightSub.textContent = 'Smart pre-fill';
    }

    // Habit Capsules
    const capsuleContainer = document.getElementById('today-habits-capsule-list');
    capsuleContainer.innerHTML = '';
    const weekStart = DateUtil.startOfWeekISO(today);
    let completedTodayCount = 0;

    state.habits.forEach((habit) => {
      const doneToday = habit.completedDates.includes(today);
      if (doneToday) completedTodayCount++;

      const doneThisWeek = habit.completedDates.filter((d) => d >= weekStart && d <= today).length;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `habit-capsule ${doneToday ? 'completed' : ''}`;
      btn.innerHTML = `
        <div class="habit-capsule-info">
          <span class="habit-capsule-name">${escapeHTML(habit.name)}</span>
          <span class="habit-capsule-freq">${doneThisWeek}/${habit.targetPerWeek} this week</span>
        </div>
        <div class="habit-check-circle">
          <svg class="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </div>
      `;
      btn.addEventListener('click', () => toggleHabitForToday(habit.id));
      capsuleContainer.appendChild(btn);
    });

    document.getElementById('today-habit-progress-badge').textContent =
      `${completedTodayCount}/${state.habits.length} today`;

    // End-of-Day Summary Card
    document.getElementById('eod-kcal-summary').textContent =
      `${kcalActual.toLocaleString()} / ${kcalTarget.toLocaleString()}`;
    document.getElementById('eod-protein-summary').textContent =
      `${proActual}g / ${proTarget}g`;

    if (latestWeight) {
      document.getElementById('eod-weight-summary').textContent =
        `${toDisplayWeight(latestWeight.emaKg)} ${unitSuffix()}`;
    } else {
      document.getElementById('eod-weight-summary').textContent = '--';
    }

    const narrative = document.getElementById('eod-narrative');
    if (proActual >= proTarget && completedTodayCount > 0) {
      narrative.textContent = 'Protein floor hit and daily practices logged. Recovery is earned.';
    } else if (todayMeals.length > 0 || completedTodayCount > 0) {
      narrative.textContent = `${Math.max(0, proTarget - proActual)}g protein remaining today. Keep stacking small wins.`;
    } else {
      narrative.textContent = 'Log your first meal or scale check-in to anchor the day.';
    }
  }

  /* ========================================================================
     9. TAB 2: FUEL & NUTRITION RENDERING
     ======================================================================== */
  function renderFuelTab() {
    const isToday = state.fuelViewDay === 'today';
    const targetDate = isToday ? DateUtil.todayISO() : DateUtil.yesterdayISO();

    document.getElementById('btn-fuel-day-today').classList.toggle('active', isToday);
    document.getElementById('btn-fuel-day-yesterday').classList.toggle('active', !isToday);
    document.getElementById('fuel-bank-title').textContent =
      isToday ? "Today's Macro Bank" : "Yesterday's Macro Summary";
    document.getElementById('fuel-timeline-title').textContent =
      isToday ? "Today's Chronological Log" : `Yesterday (${DateUtil.formatShortDate(targetDate)})`;

    const entries = state.foodLogs
      .filter((f) => f.date === targetDate)
      .sort((a, b) => b.timestamp - a.timestamp);

    const kcalActual = entries.reduce((s, e) => s + (Number(e.calories) || 0), 0);
    const proActual = entries.reduce((s, e) => s + (Number(e.protein) || 0), 0);
    const kcalTarget = state.settings.calorieTarget || 2500;
    const proTarget = state.settings.proteinTarget || 180;

    const kcalRem = Math.max(0, kcalTarget - kcalActual);
    const proRem = Math.max(0, proTarget - proActual);

    document.getElementById('fuel-bar-kcal-numbers').textContent =
      `${kcalActual.toLocaleString()} / ${kcalTarget.toLocaleString()} kcal (${kcalRem.toLocaleString()} left)`;
    document.getElementById('fuel-bar-protein-numbers').textContent =
      `${proActual}g / ${proTarget}g (${proRem}g left)`;

    document.getElementById('fuel-bar-kcal-fill').style.width =
      `${Math.min(100, (kcalActual / kcalTarget) * 100)}%`;
    document.getElementById('fuel-bar-protein-fill').style.width =
      `${Math.min(100, (proActual / proTarget) * 100)}%`;

    document.getElementById('fuel-entry-count').textContent =
      `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;

    const listEl = document.getElementById('fuel-timeline-list');
    listEl.innerHTML = '';

    if (entries.length === 0) {
      listEl.innerHTML = `<div class="empty-state">No nutrition entries logged for ${isToday ? 'today' : 'yesterday'}.</div>`;
      return;
    }

    entries.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'timeline-item';
      const noteText = item.note ? escapeHTML(item.note) : 'Quick Macro Entry';
      row.innerHTML = `
        <div class="timeline-main">
          <span class="timeline-primary">${item.calories} kcal &bull; ${item.protein}g protein</span>
          <span class="timeline-secondary">${DateUtil.formatTime(item.timestamp)} — ${noteText}</span>
        </div>
        <div class="timeline-actions">
          <button type="button" class="mini-act-btn" data-edit-fuel="${item.id}">Edit</button>
          <button type="button" class="mini-act-btn danger" data-del-fuel="${item.id}">Del</button>
        </div>
      `;
      listEl.appendChild(row);
    });
  }

  /* ========================================================================
     10. TAB 3: WEIGHT, 7-DAY EMA & HIGH-DPI CANVAS CHART
     ======================================================================== */
  function renderWeightTab() {
    const unit = unitSuffix();
    document.getElementById('btn-unit-toggle').textContent = unit;
    document.getElementById('label-weight-unit').textContent = `Scale Weight (${unit})`;
    document.getElementById('label-set-goal-weight').textContent = `Goal Weight (${unit})`;

    const series = computeWeightSeriesWithEMA();
    const count = series.length;
    document.getElementById('weight-history-count').textContent = `${count} logs`;

    if (count === 0) {
      document.getElementById('weight-hero-current').textContent = `-- ${unit}`;
      document.getElementById('weight-hero-delta').textContent = 'Log first check-in';
      document.getElementById('metric-current-weight').textContent = '--';
      document.getElementById('metric-ema-weight').textContent = '--';
      document.getElementById('metric-weekly-rate').textContent = '--';
      document.getElementById('metric-goal-eta').textContent = '--';
      document.getElementById('metric-goal-target').textContent =
        `Target: ${toDisplayWeight(state.settings.goalWeightKg)} ${unit}`;
      drawWeightCanvas([]);
      document.getElementById('weight-history-list').innerHTML =
        `<div class="empty-state">No scale logs yet. Tap "+ Log" above to start tracking your 7-day EMA trend.</div>`;
      return;
    }

    const latest = series[count - 1];
    const dispCurrent = toDisplayWeight(latest.weightKg);
    const dispEma = toDisplayWeight(latest.emaKg);

    document.getElementById('weight-hero-current').textContent = `${dispCurrent} ${unit}`;
    document.getElementById('metric-current-weight').textContent = `${dispCurrent} ${unit}`;
    document.getElementById('metric-current-date').textContent = DateUtil.formatShortDate(latest.date);
    document.getElementById('metric-ema-weight').textContent = `${dispEma} ${unit}`;

    // Weekly Velocity (compare latest EMA to EMA ~7 days ago)
    const sevenDaysAgoISO = DateUtil.daysAgoISO(7);
    let refEntry = series[0];
    for (let i = series.length - 1; i >= 0; i--) {
      if (series[i].date <= sevenDaysAgoISO) {
        refEntry = series[i];
        break;
      }
    }

    const daysSpan = Math.max(1, DateUtil.daysBetween(refEntry.date, latest.date));
    const emaDeltaKg = latest.emaKg - refEntry.emaKg;
    const weeklyRateKg = series.length > 1 ? (emaDeltaKg / daysSpan) * 7 : 0;
    const weeklyRateDisp = toDisplayWeight(Math.abs(weeklyRateKg)) * (weeklyRateKg < 0 ? -1 : 1);
    const formattedRate = `${weeklyRateDisp > 0 ? '+' : ''}${weeklyRateDisp.toFixed(2)} ${unit}/wk`;

    document.getElementById('metric-weekly-rate').textContent = formattedRate;
    document.getElementById('weight-hero-delta').textContent = `EMA: ${dispEma} ${unit}`;

    // Goal Trajectory Calculation
    const goalKg = state.settings.goalWeightKg || 80;
    const dispGoal = toDisplayWeight(goalKg);
    document.getElementById('metric-goal-target').textContent = `Target: ${dispGoal} ${unit}`;

    const remainingKg = goalKg - latest.emaKg;
    if (Math.abs(remainingKg) <= 0.25) {
      document.getElementById('metric-goal-eta').textContent = 'At Goal';
    } else if (
      (remainingKg < 0 && weeklyRateKg < -0.05) ||
      (remainingKg > 0 && weeklyRateKg > 0.05)
    ) {
      const weeksLeft = Math.abs(remainingKg / weeklyRateKg);
      if (weeksLeft <= 52) {
        document.getElementById('metric-goal-eta').textContent = `~${Math.ceil(weeksLeft)} wks`;
      } else {
        document.getElementById('metric-goal-eta').textContent = 'Steady pace';
      }
    } else {
      const diffDisp = toDisplayWeight(Math.abs(remainingKg));
      document.getElementById('metric-goal-eta').textContent = `${diffDisp} ${unit} to go`;
    }

    // Filter series by selected timeframe for Canvas Chart
    const cutoffISO = DateUtil.daysAgoISO(state.chartTimeframeDays);
    const filtered = series.filter((item) => item.date >= cutoffISO);
    const chartData = filtered.length > 0 ? filtered : series.slice(-Math.min(series.length, 10));
    drawWeightCanvas(chartData);

    // Render Historical List (newest first)
    const historyEl = document.getElementById('weight-history-list');
    historyEl.innerHTML = '';
    const reversed = [...series].reverse().slice(0, 45);

    reversed.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'timeline-item';
      const subNote = item.note ? ` — ${escapeHTML(item.note)}` : '';
      row.innerHTML = `
        <div class="timeline-main">
          <span class="timeline-primary">${toDisplayWeight(item.weightKg)} ${unit} <span style="font-weight:500;color:var(--accent-terracotta);font-size:0.8rem;">(EMA ${toDisplayWeight(item.emaKg)})</span></span>
          <span class="timeline-secondary">${DateUtil.formatShortDate(item.date)}${subNote}</span>
        </div>
        <div class="timeline-actions">
          <button type="button" class="mini-act-btn" data-edit-weight="${item.id}">Edit</button>
          <button type="button" class="mini-act-btn danger" data-del-weight="${item.id}">Del</button>
        </div>
      `;
      historyEl.appendChild(row);
    });
  }

  /**
   * High-DPI Retina HTML5 Canvas Renderer for Raw Scale Weight + 7-Day EMA Curve
   */
  function drawWeightCanvas(dataPoints) {
    const canvas = document.getElementById('weight-chart-canvas');
    if (!canvas) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = rect.width || 320;
    const height = rect.height || 210;

    canvas.width = width * dpr;
    canvas.height = height * dpr;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const isDark = state.settings.theme === 'dark';
    const gridColor = isDark ? 'rgba(237, 234, 228, 0.07)' : 'rgba(42, 38, 35, 0.07)';
    const textColor = isDark ? '#9E978E' : '#736D65';
    const rawColor = isDark ? 'rgba(237, 234, 228, 0.35)' : 'rgba(42, 38, 35, 0.32)';
    const emaColor = isDark ? '#D97B5E' : '#C86D51';

    if (!dataPoints || dataPoints.length === 0) {
      ctx.fillStyle = textColor;
      ctx.font = '600 13px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Log weight check-ins to visualize your 7D EMA curve', width / 2, height / 2);
      state.chartPointsCache = [];
      return;
    }

    const padLeft = 40;
    const padRight = 14;
    const padTop = 18;
    const padBottom = 26;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    const allVals = [];
    dataPoints.forEach((p) => {
      allVals.push(toDisplayWeight(p.weightKg));
      allVals.push(toDisplayWeight(p.emaKg));
    });

    let minVal = Math.min(...allVals);
    let maxVal = Math.max(...allVals);
    if (maxVal - minVal < 1.2) {
      minVal -= 0.6;
      maxVal += 0.6;
    } else {
      const margin = (maxVal - minVal) * 0.15;
      minVal -= margin;
      maxVal += margin;
    }

    // Horizontal Grid Lines & Y-Axis Labels
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.fillStyle = textColor;
    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'right';

    const steps = 3;
    for (let i = 0; i <= steps; i++) {
      const ratio = i / steps;
      const y = padTop + plotH * ratio;
      const val = (maxVal - (maxVal - minVal) * ratio).toFixed(1);

      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.stroke();

      ctx.fillText(val, padLeft - 6, y + 3);
    }

    // Map coordinates
    const coords = dataPoints.map((pt, idx) => {
      const x =
        dataPoints.length === 1
          ? padLeft + plotW / 2
          : padLeft + (idx / (dataPoints.length - 1)) * plotW;
      const rawDisp = toDisplayWeight(pt.weightKg);
      const emaDisp = toDisplayWeight(pt.emaKg);
      const yRaw = padTop + ((maxVal - rawDisp) / (maxVal - minVal)) * plotH;
      const yEma = padTop + ((maxVal - emaDisp) / (maxVal - minVal)) * plotH;
      return { x, yRaw, yEma, rawDisp, emaDisp, date: pt.date };
    });

    state.chartPointsCache = coords;

    // X-Axis Start/End Date Labels
    ctx.textAlign = 'left';
    ctx.fillText(DateUtil.formatShortDate(coords[0].date), padLeft, height - 6);
    if (coords.length > 1) {
      ctx.textAlign = 'right';
      ctx.fillText(
        DateUtil.formatShortDate(coords[coords.length - 1].date),
        width - padRight,
        height - 6
      );
    }

    // 1. Draw dashed connector for raw scale weights
    if (coords.length > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = rawColor;
      ctx.lineWidth = 1.4;
      coords.forEach((c, i) => {
        if (i === 0) ctx.moveTo(c.x, c.yRaw);
        else ctx.lineTo(c.x, c.yRaw);
      });
      ctx.stroke();
      ctx.restore();
    }

    // 2. Draw raw scale dots
    coords.forEach((c) => {
      ctx.beginPath();
      ctx.arc(c.x, c.yRaw, 3, 0, Math.PI * 2);
      ctx.fillStyle = rawColor;
      ctx.fill();
    });

    // 3. Draw smooth 7-Day EMA Curve + Subtle Gradient Area
    if (coords.length > 1) {
      const grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
      grad.addColorStop(0, isDark ? 'rgba(217, 123, 94, 0.25)' : 'rgba(200, 109, 81, 0.20)');
      grad.addColorStop(1, 'rgba(200, 109, 81, 0.0)');

      ctx.beginPath();
      ctx.moveTo(coords[0].x, coords[0].yEma);
      for (let i = 0; i < coords.length - 1; i++) {
        const xc = (coords[i].x + coords[i + 1].x) / 2;
        const yc = (coords[i].yEma + coords[i + 1].yEma) / 2;
        ctx.quadraticCurveTo(coords[i].x, coords[i].yEma, xc, yc);
      }
      const last = coords[coords.length - 1];
      ctx.lineTo(last.x, last.yEma);

      ctx.strokeStyle = emaColor;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.stroke();

      // Fill area under EMA curve
      ctx.lineTo(last.x, padTop + plotH);
      ctx.lineTo(coords[0].x, padTop + plotH);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }

    // Highlight latest EMA point
    const newest = coords[coords.length - 1];
    ctx.beginPath();
    ctx.arc(newest.x, newest.yEma, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = emaColor;
    ctx.fill();
  }

  /* ========================================================================
     11. TAB 4: HABITS, RECOVERY & VAULT RENDERING
     ======================================================================== */
  function renderVaultTab() {
    document.getElementById('shield-count-text').textContent =
      `${state.settings.shieldsRemaining}/2 Shields`;

    // Compute 30-Day and 90-Day Consistency Scores
    const score30 = computeConsistencyScore(30);
    const score90 = computeConsistencyScore(90);

    document.getElementById('habit-score-30d').textContent = `${score30}%`;
    document.getElementById('habit-score-90d').textContent = `${score90}%`;

    // Detailed Weekly Habits Stack
    const stack = document.getElementById('vault-habits-detailed-list');
    stack.innerHTML = '';
    const today = DateUtil.todayISO();
    const weekStart = DateUtil.startOfWeekISO(today);

    state.habits.forEach((h) => {
      const doneThisWeek = h.completedDates.filter((d) => d >= weekStart && d <= today).length;
      const doneToday = h.completedDates.includes(today);
      const statusText =
        doneThisWeek >= h.targetPerWeek
          ? 'Weekly target achieved'
          : `${doneThisWeek}/${h.targetPerWeek} completed this week (Rest days = recovery)`;

      const item = document.createElement('div');
      item.className = 'habit-detail-row';
      item.innerHTML = `
        <div class="habit-detail-meta">
          <span class="habit-detail-title">${escapeHTML(h.name)}</span>
          <span class="habit-detail-sub">${statusText}</span>
        </div>
        <div class="timeline-actions">
          <button type="button" class="mini-act-btn" data-toggle-habit="${h.id}">
            ${doneToday ? 'Done Today' : 'Mark Today'}
          </button>
          <button type="button" class="mini-act-btn danger" data-del-habit="${h.id}">Del</button>
        </div>
      `;
      stack.appendChild(item);
    });
  }

  /**
   * Computes rolling adherence percentage across all habits over `windowDays`,
   * respecting Comeback Protocol reset date and Streak Shields.
   */
  function computeConsistencyScore(windowDays) {
    if (state.habits.length === 0) return 100;
    const today = DateUtil.todayISO();
    let startISO = DateUtil.daysAgoISO(windowDays);

    if (state.settings.comebackDate && state.settings.comebackDate > startISO) {
      startISO = state.settings.comebackDate;
    }

    const activeDays = Math.max(1, DateUtil.daysBetween(startISO, today) + 1);
    const weeksFactor = activeDays / 7;

    let totalExpected = 0;
    let totalCompleted = 0;

    state.habits.forEach((h) => {
      const expected = Math.max(1, Math.round(h.targetPerWeek * weeksFactor));
      const actual = h.completedDates.filter((d) => d >= startISO && d <= today).length;
      const shieldBonus = (state.settings.shieldedDates || []).filter(
        (d) => d >= startISO && d <= today
      ).length;
      totalExpected += expected;
      totalCompleted += Math.min(expected, actual + shieldBonus);
    });

    if (totalExpected === 0) return 100;
    return Math.min(100, Math.round((totalCompleted / totalExpected) * 100));
  }

  /* ========================================================================
     12. ACTIONS, LOGGING & MUTATIONS
     ======================================================================== */
  async function toggleHabitForToday(habitId) {
    const today = DateUtil.todayISO();
    const habit = state.habits.find((h) => h.id === habitId);
    if (!habit) return;

    const idx = habit.completedDates.indexOf(today);
    if (idx >= 0) {
      habit.completedDates.splice(idx, 1);
      showToast(`${habit.name} unmarked`);
    } else {
      habit.completedDates.push(today);
      showToast(`${habit.name} logged`);
    }

    await db.put('habits', habit);
    renderAll();
  }

  function openSheet(sheetId) {
    document.getElementById('sheet-backdrop').classList.remove('hidden');
    requestAnimationFrame(() => {
      document.getElementById('sheet-backdrop').classList.add('visible');
      const sheet = document.getElementById(sheetId);
      if (sheet) {
        sheet.classList.add('open');
        sheet.setAttribute('aria-hidden', 'false');
      }
    });
  }

  function closeAllSheets() {
    const backdrop = document.getElementById('sheet-backdrop');
    backdrop.classList.remove('visible');
    document.querySelectorAll('.bottom-sheet.open').forEach((s) => {
      s.classList.remove('open');
      s.setAttribute('aria-hidden', 'true');
    });
    setTimeout(() => {
      backdrop.classList.add('hidden');
    }, 260);
  }

  function openFuelSheetForCreate() {
    document.getElementById('sheet-fuel-title').textContent = 'Log Fuel';
    document.getElementById('fuel-edit-id').value = '';
    document.getElementById('input-fuel-kcal').value = '';
    document.getElementById('input-fuel-protein').value = '';
    document.getElementById('input-fuel-note').value = '';
    openSheet('sheet-fuel');
  }

  function openWeightSheetForCreate() {
    document.getElementById('sheet-weight-title').textContent = 'Log Scale Weight';
    document.getElementById('weight-edit-id').value = '';
    document.getElementById('input-weight-date').value = DateUtil.todayISO();
    document.getElementById('input-weight-note').value = '';

    // Smart Pre-fill with last logged weight
    const series = computeWeightSeriesWithEMA();
    if (series.length > 0) {
      const last = series[series.length - 1];
      document.getElementById('input-weight-val').value = toDisplayWeight(last.weightKg);
    } else {
      document.getElementById('input-weight-val').value = toDisplayWeight(state.settings.goalWeightKg || 80);
    }
    openSheet('sheet-weight');
  }

  function showToast(message) {
    const toast = document.getElementById('feedback-toast');
    document.getElementById('feedback-toast-text').textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      toast.classList.remove('show');
    }, 2100);
  }

  /* ========================================================================
     13. EVENT LISTENERS & INTERACTION BINDINGS
     ======================================================================== */
  function bindEventListeners() {
    // Bottom Navigation Tabs
    document.querySelectorAll('.nav-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const targetId = tab.getAttribute('data-target');
        document.querySelectorAll('.nav-tab').forEach((t) => t.classList.remove('active'));
        document.querySelectorAll('.tab-view').forEach((v) => v.classList.remove('active'));
        tab.classList.add('active');
        const targetView = document.getElementById(targetId);
        if (targetView) targetView.classList.add('active');
        if (targetId === 'view-weight') {
          renderWeightTab();
        }
      });
    });

    // Theme Toggle
    document.getElementById('btn-theme-toggle').addEventListener('click', async () => {
      state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
      await db.put('user_settings', state.settings);
      renderWeightTab();
    });

    // Settings Sheet
    document.getElementById('btn-open-settings').addEventListener('click', () => {
      document.getElementById('input-set-kcal').value = state.settings.calorieTarget;
      document.getElementById('input-set-protein').value = state.settings.proteinTarget;
      document.getElementById('input-set-goal-weight').value = toDisplayWeight(state.settings.goalWeightKg);
      document.getElementById('select-set-unit').value = state.settings.unit;
      openSheet('sheet-settings');
    });

    // Fast Log Hero Buttons
    document.getElementById('btn-fast-fuel').addEventListener('click', openFuelSheetForCreate);
    document.getElementById('btn-fuel-add-inline').addEventListener('click', openFuelSheetForCreate);
    document.getElementById('btn-fast-weight').addEventListener('click', openWeightSheetForCreate);
    document.getElementById('btn-weight-open-sheet').addEventListener('click', openWeightSheetForCreate);

    // Close Sheets
    document.getElementById('sheet-backdrop').addEventListener('click', closeAllSheets);
    document.querySelectorAll('[data-close-sheet]').forEach((btn) => {
      btn.addEventListener('click', closeAllSheets);
    });

    // 1-Tap Macro Increment Pills
    document.querySelectorAll('[data-add-kcal]').forEach((pill) => {
      pill.addEventListener('click', () => {
        const inc = parseInt(pill.getAttribute('data-add-kcal'), 10);
        const input = document.getElementById('input-fuel-kcal');
        const curr = parseInt(input.value, 10) || 0;
        input.value = curr + inc;
      });
    });

    document.querySelectorAll('[data-add-protein]').forEach((pill) => {
      pill.addEventListener('click', () => {
        const inc = parseInt(pill.getAttribute('data-add-protein'), 10);
        const input = document.getElementById('input-fuel-protein');
        const curr = parseInt(input.value, 10) || 0;
        input.value = curr + inc;
      });
    });

    document.getElementById('btn-fuel-reset-inputs').addEventListener('click', () => {
      document.getElementById('input-fuel-kcal').value = '';
      document.getElementById('input-fuel-protein').value = '';
    });

    // Save Fuel Form
    document.getElementById('form-fuel').addEventListener('submit', async (e) => {
      e.preventDefault();
      const kcal = parseInt(document.getElementById('input-fuel-kcal').value, 10) || 0;
      const pro = parseInt(document.getElementById('input-fuel-protein').value, 10) || 0;
      const note = document.getElementById('input-fuel-note').value.trim();
      const editId = document.getElementById('fuel-edit-id').value;

      if (kcal <= 0 && pro <= 0) {
        showToast('Enter calories or protein');
        return;
      }

      if (editId) {
        const existing = state.foodLogs.find((f) => f.id === editId);
        if (existing) {
          existing.calories = kcal;
          existing.protein = pro;
          existing.note = note;
          await db.put('food_logs', existing);
        }
      } else {
        const targetDate = state.fuelViewDay === 'yesterday' ? DateUtil.yesterdayISO() : DateUtil.todayISO();
        const entry = {
          id: 'fuel-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
          date: targetDate,
          calories: kcal,
          protein: pro,
          note,
          timestamp: Date.now()
        };
        state.foodLogs.push(entry);
        await db.put('food_logs', entry);
      }

      closeAllSheets();
      renderAll();
      showToast('Fuel logged to Vault');
    });

    // Weight Fine Nudge Stepper Buttons
    document.querySelectorAll('[data-nudge-weight]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const delta = parseFloat(btn.getAttribute('data-nudge-weight'));
        const input = document.getElementById('input-weight-val');
        const curr = parseFloat(input.value) || 0;
        input.value = (curr + delta).toFixed(1);
      });
    });

    // Save Weight Form
    document.getElementById('form-weight').addEventListener('submit', async (e) => {
      e.preventDefault();
      const rawVal = document.getElementById('input-weight-val').value;
      const weightKg = fromDisplayWeightToKg(rawVal);
      const dateStr = document.getElementById('input-weight-date').value || DateUtil.todayISO();
      const note = document.getElementById('input-weight-note').value.trim();
      const editId = document.getElementById('weight-edit-id').value;

      if (!weightKg || weightKg <= 20) {
        showToast('Enter a valid scale weight');
        return;
      }

      if (editId) {
        const existing = state.weightLogs.find((w) => w.id === editId);
        if (existing) {
          existing.weightKg = weightKg;
          existing.date = dateStr;
          existing.note = note;
          await db.put('weight_logs', existing);
        }
      } else {
        // Check if an entry already exists for that date to update cleanly
        const sameDay = state.weightLogs.find((w) => w.date === dateStr);
        if (sameDay) {
          sameDay.weightKg = weightKg;
          sameDay.note = note;
          sameDay.timestamp = Date.now();
          await db.put('weight_logs', sameDay);
        } else {
          const entry = {
            id: 'wt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
            date: dateStr,
            weightKg,
            note,
            timestamp: Date.now()
          };
          state.weightLogs.push(entry);
          await db.put('weight_logs', entry);
        }
      }

      closeAllSheets();
      renderAll();
      showToast('Scale weight & EMA updated');
    });

    // Save Settings Form
    document.getElementById('form-settings').addEventListener('submit', async (e) => {
      e.preventDefault();
      const newUnit = document.getElementById('select-set-unit').value;
      const kcal = parseInt(document.getElementById('input-set-kcal').value, 10) || 2500;
      const pro = parseInt(document.getElementById('input-set-protein').value, 10) || 180;
      const goalInput = parseFloat(document.getElementById('input-set-goal-weight').value) || 80;

      state.settings.unit = newUnit;
      state.settings.calorieTarget = Math.max(800, kcal);
      state.settings.proteinTarget = Math.max(30, pro);
      state.settings.goalWeightKg = newUnit === 'lbs' ? goalInput / KG_TO_LBS : goalInput;

      await db.put('user_settings', state.settings);
      closeAllSheets();
      renderAll();
      showToast('Targets updated');
    });

    // Fuel Today vs Yesterday Segmented Toggle
    document.getElementById('btn-fuel-day-today').addEventListener('click', () => {
      state.fuelViewDay = 'today';
      renderFuelTab();
    });
    document.getElementById('btn-fuel-day-yesterday').addEventListener('click', () => {
      state.fuelViewDay = 'yesterday';
      renderFuelTab();
    });

    // Delegated Edit/Delete for Fuel Timeline
    document.getElementById('fuel-timeline-list').addEventListener('click', async (e) => {
      const editBtn = e.target.closest('[data-edit-fuel]');
      const delBtn = e.target.closest('[data-del-fuel]');

      if (editBtn) {
        const id = editBtn.getAttribute('data-edit-fuel');
        const item = state.foodLogs.find((f) => f.id === id);
        if (!item) return;
        document.getElementById('sheet-fuel-title').textContent = 'Edit Fuel Entry';
        document.getElementById('fuel-edit-id').value = item.id;
        document.getElementById('input-fuel-kcal').value = item.calories;
        document.getElementById('input-fuel-protein').value = item.protein;
        document.getElementById('input-fuel-note').value = item.note || '';
        openSheet('sheet-fuel');
      } else if (delBtn) {
        const id = delBtn.getAttribute('data-del-fuel');
        state.foodLogs = state.foodLogs.filter((f) => f.id !== id);
        await db.delete('food_logs', id);
        renderAll();
        showToast('Entry removed');
      }
    });

    // Unit Toggle Button on Weight Tab
    document.getElementById('btn-unit-toggle').addEventListener('click', async () => {
      state.settings.unit = state.settings.unit === 'kg' ? 'lbs' : 'kg';
      await db.put('user_settings', state.settings);
      renderAll();
      showToast(`Switched to ${state.settings.unit.toUpperCase()}`);
    });

    // Chart Timeframe Buttons
    document.querySelectorAll('.tf-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tf-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.chartTimeframeDays = parseInt(btn.getAttribute('data-days'), 10);
        renderWeightTab();
      });
    });

    // Interactive Touch Scrubbing on Weight Canvas
    const canvas = document.getElementById('weight-chart-canvas');
    const scrubHandler = (clientX) => {
      if (!state.chartPointsCache || state.chartPointsCache.length === 0) return;
      const rect = canvas.getBoundingClientRect();
      const relX = clientX - rect.left;
      let closest = state.chartPointsCache[0];
      let minDist = Math.abs(relX - closest.x);

      state.chartPointsCache.forEach((pt) => {
        const d = Math.abs(relX - pt.x);
        if (d < minDist) {
          minDist = d;
          closest = pt;
        }
      });

      const unit = unitSuffix();
      document.getElementById('chart-scrub-readout').textContent =
        `${DateUtil.formatShortDate(closest.date)}: Scale ${closest.rawDisp}${unit} | EMA ${closest.emaDisp}${unit}`;
    };

    canvas.addEventListener('touchmove', (e) => {
      if (e.touches && e.touches[0]) scrubHandler(e.touches[0].clientX);
    }, { passive: true });
    canvas.addEventListener('click', (e) => scrubHandler(e.clientX));

    // Delegated Edit/Delete for Weight History
    document.getElementById('weight-history-list').addEventListener('click', async (e) => {
      const editBtn = e.target.closest('[data-edit-weight]');
      const delBtn = e.target.closest('[data-del-weight]');

      if (editBtn) {
        const id = editBtn.getAttribute('data-edit-weight');
        const item = state.weightLogs.find((w) => w.id === id);
        if (!item) return;
        document.getElementById('sheet-weight-title').textContent = 'Edit Scale Check-In';
        document.getElementById('weight-edit-id').value = item.id;
        document.getElementById('input-weight-val').value = toDisplayWeight(item.weightKg);
        document.getElementById('input-weight-date').value = item.date;
        document.getElementById('input-weight-note').value = item.note || '';
        openSheet('sheet-weight');
      } else if (delBtn) {
        const id = delBtn.getAttribute('data-del-weight');
        state.weightLogs = state.weightLogs.filter((w) => w.id !== id);
        await db.delete('weight_logs', id);
        renderAll();
        showToast('Weight log removed');
      }
    });

    // Add New Habit Sheet & Submission
    document.getElementById('btn-add-habit').addEventListener('click', () => {
      document.getElementById('input-habit-name').value = '';
      document.getElementById('input-habit-target').value = '4';
      openSheet('sheet-habit');
    });

    document.getElementById('form-habit').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('input-habit-name').value.trim();
      const target = Math.min(7, Math.max(1, parseInt(document.getElementById('input-habit-target').value, 10) || 4));
      if (!name) return;

      const newHabit = {
        id: 'hab-' + Date.now(),
        name,
        targetPerWeek: target,
        completedDates: [DateUtil.todayISO()]
      };
      state.habits.push(newHabit);
      await db.put('habits', newHabit);
      closeAllSheets();
      renderAll();
      showToast('Weekly practice added');
    });

    // Delegated Actions on Vault Habits List
    document.getElementById('vault-habits-detailed-list').addEventListener('click', async (e) => {
      const toggleBtn = e.target.closest('[data-toggle-habit]');
      const delBtn = e.target.closest('[data-del-habit]');

      if (toggleBtn) {
        await toggleHabitForToday(toggleBtn.getAttribute('data-toggle-habit'));
      } else if (delBtn) {
        const id = delBtn.getAttribute('data-del-habit');
        state.habits = state.habits.filter((h) => h.id !== id);
        await db.delete('habits', id);
        renderAll();
        showToast('Practice removed');
      }
    });

    // Monthly Streak Shield Activation
    document.getElementById('btn-use-shield').addEventListener('click', async () => {
      const today = DateUtil.todayISO();
      if ((state.settings.shieldedDates || []).includes(today)) {
        showToast('Streak Shield already active for today');
        return;
      }
      if (state.settings.shieldsRemaining <= 0) {
        showToast('0 Streak Shields remaining this month');
        return;
      }
      state.settings.shieldsRemaining -= 1;
      state.settings.shieldedDates = [...(state.settings.shieldedDates || []), today];
      await db.put('user_settings', state.settings);
      renderAll();
      showToast('Streak Shield activated for today');
    });

    // Comeback Protocol (Clean Slate)
    document.getElementById('btn-comeback-protocol').addEventListener('click', async () => {
      const today = DateUtil.todayISO();
      state.settings.comebackDate = today;
      state.settings.shieldsRemaining = 2;
      await db.put('user_settings', state.settings);
      renderAll();
      document.getElementById('header-subtitle').textContent = 'Day 1 starts today. Calm momentum.';
      showToast('Day 1 starts today — Clean slate active');
    });

    // Backup Warning Banner Shortcut
    document.getElementById('backup-warning-banner').addEventListener('click', () => {
      document.querySelector('[data-target="view-vault"]').click();
    });

    // Export Full Vault Backup (.json)
    document.getElementById('btn-export-vault').addEventListener('click', async () => {
      const today = DateUtil.todayISO();
      state.settings.lastBackupDate = today;
      await db.put('user_settings', state.settings);

      const payload = {
        app: 'Zenith Mindful Health Tracker',
        version: 1,
        exportedAt: new Date().toISOString(),
        user_settings: state.settings,
        weight_logs: state.weightLogs,
        food_logs: state.foodLogs,
        habits: state.habits
      };

      const jsonStr = JSON.stringify(payload, null, 2);
      const fileName = `vault-backup-${today}.json`;
      const blob = new Blob([jsonStr], { type: 'application/json' });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1500);

      renderAll();
      showToast(`Saved ${fileName}`);
    });

    // Restore Vault Backup (.json)
    document.getElementById('input-restore-vault').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          if (!data || !Array.isArray(data.weight_logs) || !Array.isArray(data.food_logs)) {
            showToast('Invalid backup file format');
            return;
          }

          state.weightLogs = data.weight_logs;
          state.foodLogs = data.food_logs;
          state.habits = Array.isArray(data.habits) && data.habits.length ? data.habits : DEFAULT_HABITS;
          if (data.user_settings) {
            state.settings = { ...state.settings, ...data.user_settings, id: 'profile' };
          }

          await db.clearAndBulkPut('weight_logs', state.weightLogs);
          await db.clearAndBulkPut('food_logs', state.foodLogs);
          await db.clearAndBulkPut('habits', state.habits);
          await db.put('user_settings', state.settings);

          applyTheme();
          renderAll();
          showToast('Vault history restored');
        } catch (_) {
          showToast('Could not parse JSON backup');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    // Seed 60-Day Veteran Sample Dataset for Instant Testing
    document.getElementById('btn-seed-demo').addEventListener('click', async () => {
      await seedVeteranDataset();
      renderAll();
      showToast('60-day veteran dataset loaded');
    });

    // Redraw canvas on window resize
    window.addEventListener('resize', () => {
      if (document.getElementById('view-weight').classList.contains('active')) {
        renderWeightTab();
      }
    });
  }

  /* ========================================================================
     14. SAMPLE VETERAN DATASET GENERATOR (60 DAYS OF REALISTIC EMA & LOGS)
     ======================================================================== */
  async function seedVeteranDataset() {
    const sampleWeights = [];
    let baseKg = 84.2;

    for (let i = 60; i >= 0; i--) {
      const dateStr = DateUtil.daysAgoISO(i);
      // Steady cut of ~0.35kg/week with realistic daily water/glycogen noise
      baseKg -= 0.05;
      const waterNoise = Math.sin(i * 1.3) * 0.45 + (i % 5 === 0 ? 0.35 : -0.15);
      const weightKg = Number((baseKg + waterNoise).toFixed(2));
      sampleWeights.push({
        id: `demo-wt-${i}`,
        date: dateStr,
        weightKg,
        note: i % 7 === 0 ? 'Refeed day check-in' : 'Morning fasted',
        timestamp: Date.now() - i * 86400000
      });
    }

    const today = DateUtil.todayISO();
    const yesterday = DateUtil.yesterdayISO();
    const sampleFoods = [
      { id: 'demo-f1', date: today, calories: 680, protein: 55, note: 'Eggs, sourdough & whey isolate', timestamp: Date.now() - 18000000 },
      { id: 'demo-f2', date: today, calories: 820, protein: 65, note: 'Grilled chicken thigh, jasmine rice, olive oil', timestamp: Date.now() - 7200000 },
      { id: 'demo-f3', date: yesterday, calories: 750, protein: 60, note: 'Greek yogurt bowl, berries & oats', timestamp: Date.now() - 104000000 },
      { id: 'demo-f4', date: yesterday, calories: 950, protein: 72, note: 'Sirloin steak, roasted potatoes & greens', timestamp: Date.now() - 90000000 },
      { id: 'demo-f5', date: yesterday, calories: 620, protein: 50, note: 'Casein pudding & almond butter', timestamp: Date.now() - 80000000 }
    ];

    const pastDates = [];
    for (let d = 0; d < 45; d++) {
      pastDates.push(DateUtil.daysAgoISO(d));
    }

    const sampleHabits = [
      {
        id: 'hab-gym',
        name: 'Resistance Training',
        targetPerWeek: 4,
        completedDates: pastDates.filter((_, idx) => idx % 2 === 0)
      },
      {
        id: 'hab-walk',
        name: 'Daily Steps / Walk',
        targetPerWeek: 6,
        completedDates: pastDates.filter((_, idx) => idx % 7 !== 3)
      },
      {
        id: 'hab-hydrate',
        name: 'Hydration & Electrolytes',
        targetPerWeek: 7,
        completedDates: pastDates
      },
      {
        id: 'hab-mobility',
        name: 'Mobility & Creatine',
        targetPerWeek: 5,
        completedDates: pastDates.filter((_, idx) => idx % 3 !== 2)
      }
    ];

    state.weightLogs = sampleWeights;
    state.foodLogs = sampleFoods;
    state.habits = sampleHabits;
    state.settings.goalWeightKg = 79.5;

    await db.clearAndBulkPut('weight_logs', state.weightLogs);
    await db.clearAndBulkPut('food_logs', state.foodLogs);
    await db.clearAndBulkPut('habits', state.habits);
    await db.put('user_settings', state.settings);
  }

  /* ========================================================================
     15. SERVICE WORKER REGISTRATION & HELPERS
     ======================================================================== */
  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
          // Silently continue if running via file:// protocol
        });
      });
    }
  }

  function escapeHTML(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Launch Application
  document.addEventListener('DOMContentLoaded', bootstrapApp);
})();