(() => {
  'use strict';

  const STORAGE_KEY = 'bug_session_goal_app_v1';
  const DEFAULT_MONTHLY_GOAL = 120;
  const DEFAULT_WEEKLY_GOAL = 28;

  // ---------- date helpers ----------
  const pad2 = (n) => String(n).padStart(2, '0');

  function isoDate(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function parseISO(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function todayISO() {
    return isoDate(new Date());
  }

  function monthKeyOf(dateStr) {
    return dateStr.slice(0, 7);
  }

  function todayMonthKey() {
    return monthKeyOf(todayISO());
  }

  function monthLabel(monthKey) {
    const [y, m] = monthKey.split('-').map(Number);
    return `${y}年${m}月`;
  }

  function addMonths(monthKey, delta) {
    const [y, m] = monthKey.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  }

  function daysInMonth(monthKey) {
    const [y, m] = monthKey.split('-').map(Number);
    return new Date(y, m, 0).getDate();
  }

  function remainingDaysInMonth(monthKey) {
    if (monthKey !== todayMonthKey()) return 0;
    const total = daysInMonth(monthKey);
    const today = new Date().getDate();
    return total - today + 1;
  }

  function addDays(d, n) {
    const nd = new Date(d);
    nd.setDate(nd.getDate() + n);
    return nd;
  }

  function getWeekStart(d) {
    const day = d.getDay(); // 0=Sun..6=Sat
    const diff = day === 0 ? -6 : 1 - day;
    const ws = addDays(d, diff);
    ws.setHours(0, 0, 0, 0);
    return ws;
  }

  function currentWeekRange() {
    const ws = getWeekStart(new Date());
    const we = addDays(ws, 6);
    return { start: isoDate(ws), end: isoDate(we), key: isoDate(ws) };
  }

  function weekLabel(range) {
    const s = parseISO(range.start);
    const e = parseISO(range.end);
    const wd = ['日', '月', '火', '水', '木', '金', '土'];
    return `${s.getMonth() + 1}/${s.getDate()}(${wd[s.getDay()]})〜${e.getMonth() + 1}/${e.getDate()}(${wd[e.getDay()]})`;
  }

  function inRange(dateStr, startStr, endStr) {
    return dateStr >= startStr && dateStr <= endStr;
  }

  function genId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  // ---------- storage ----------
  function defaultData() {
    return {
      members: [],
      monthlyGoalByMonth: {},
      weeklyGoalByWeek: {},
      log: [],
    };
  }

  function loadData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultData();
      const parsed = JSON.parse(raw);
      return Object.assign(defaultData(), parsed);
    } catch (e) {
      console.error('データの読み込みに失敗しました', e);
      return defaultData();
    }
  }

  function saveData() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
  }

  // ---------- state ----------
  const state = {
    data: loadData(),
    viewMonthKey: todayMonthKey(),
  };

  // ---------- goal resolution (carry forward from most recent prior entry) ----------
  function resolveGoal(map, key, sortedKeysAsc, fallback) {
    if (map[key] !== undefined) return map[key];
    let best = null;
    for (const k of sortedKeysAsc) {
      if (k < key) best = k;
    }
    return best !== null ? map[best] : fallback;
  }

  function monthlyGoalFor(monthKey) {
    const keys = Object.keys(state.data.monthlyGoalByMonth).sort();
    return resolveGoal(state.data.monthlyGoalByMonth, monthKey, keys, DEFAULT_MONTHLY_GOAL);
  }

  function weeklyGoalFor(weekKey) {
    const keys = Object.keys(state.data.weeklyGoalByWeek).sort();
    return resolveGoal(state.data.weeklyGoalByWeek, weekKey, keys, DEFAULT_WEEKLY_GOAL);
  }

  // ---------- aggregation ----------
  function logCount(memberId, type, predicate) {
    return state.data.log.filter(
      (e) => (memberId == null || e.memberId === memberId) && e.type === type && predicate(e.date)
    ).length;
  }

  function doneInMonth(memberId, monthKey) {
    return logCount(memberId, 'done', (d) => monthKeyOf(d) === monthKey);
  }

  function bookedInMonth(memberId, monthKey) {
    return logCount(memberId, 'booked', (d) => monthKeyOf(d) === monthKey);
  }

  function doneInRange(memberId, start, end) {
    return logCount(memberId, 'done', (d) => inRange(d, start, end));
  }

  function bookedInRange(memberId, start, end) {
    return logCount(memberId, 'booked', (d) => inRange(d, start, end));
  }

  function nextSessionDate(memberId) {
    const today = todayISO();
    const dates = state.data.log
      .filter((e) => e.memberId === memberId && e.type === 'booked' && e.date >= today)
      .map((e) => e.date)
      .sort();
    return dates.length ? dates[0] : null;
  }

  // ---------- rendering ----------
  const $ = (sel) => document.querySelector(sel);

  function render() {
    renderMonthNav();
    renderMonthlySummary();
    renderWeeklySummary();
    renderMembers();
  }

  function renderMonthNav() {
    $('#month-nav-label').textContent = monthLabel(state.viewMonthKey);
    $('#month-nav-next').disabled = state.viewMonthKey >= todayMonthKey();
  }

  function renderMonthlySummary() {
    const monthKey = state.viewMonthKey;
    const goal = monthlyGoalFor(monthKey);
    const done = doneInMonth(null, monthKey);
    const booked = bookedInMonth(null, monthKey);
    const landing = done + booked;
    const remaining = Math.max(goal - done, 0);
    const rate = goal > 0 ? Math.min(Math.round((done / goal) * 100), 999) : 0;
    const remainDays = remainingDaysInMonth(monthKey);
    const perDay = remainDays > 0 ? (remaining / remainDays).toFixed(1) : '-';
    const isCurrent = monthKey === todayMonthKey();
    const gap = landing - goal;

    $('#stat-goal').textContent = goal;
    $('#stat-done').textContent = done;
    $('#stat-booked').textContent = booked;
    $('#stat-landing').textContent = landing;
    $('#stat-remaining').textContent = remaining;
    $('#stat-rate').textContent = `${rate}%`;
    $('#progress-bar-fill').style.width = `${Math.min(rate, 100)}%`;

    $('#detail-remain-days').textContent = isCurrent ? `${remainDays}日` : '-';
    $('#detail-per-day').textContent = isCurrent ? perDay : '-';

    const forecastEl = $('#detail-forecast');
    if (!isCurrent) {
      forecastEl.textContent = '-';
      forecastEl.className = 'forecast';
    } else if (gap >= 0) {
      forecastEl.textContent = `✅ 目標達成見込み（+${gap}）`;
      forecastEl.className = 'forecast ok';
    } else {
      forecastEl.textContent = `⚠️ 不足見込み（${gap}）`;
      forecastEl.className = 'forecast warn';
    }

    $('#monthly-goal-input').value = goal;
  }

  function renderWeeklySummary() {
    const section = $('#weekly-summary');
    if (state.viewMonthKey !== todayMonthKey()) {
      section.classList.add('hidden');
      return;
    }
    section.classList.remove('hidden');
    const range = currentWeekRange();
    const goal = weeklyGoalFor(range.key);
    const done = doneInRange(null, range.start, range.end);
    const booked = bookedInRange(null, range.start, range.end);
    const remaining = Math.max(goal - done, 0);

    $('#week-range-label').textContent = weekLabel(range);
    $('#week-goal-input').value = goal;
    $('#week-stat-done').textContent = done;
    $('#week-stat-booked').textContent = booked;
    $('#week-stat-remaining').textContent = remaining;
  }

  function memberCardHtml(m) {
    const monthKey = state.viewMonthKey;
    const isCurrent = monthKey === todayMonthKey();
    const done = doneInMonth(m.id, monthKey);
    const booked = bookedInMonth(m.id, monthKey);
    const remaining = Math.max(m.monthlyGoal - done, 0);
    const next = nextSessionDate(m.id);

    return `
    <div class="member-card" data-id="${m.id}">
      <div class="member-card-head">
        <div class="member-name">${escapeHtml(m.name)}</div>
        <div class="member-badge">週${m.weeklyFreq}</div>
      </div>
      <div class="member-stats">
        <div class="mstat"><span class="mstat-label">月目標</span><span class="mstat-value">${m.monthlyGoal}</span></div>
        <div class="mstat"><span class="mstat-label">実施</span><span class="mstat-value">${done}</span></div>
        <div class="mstat"><span class="mstat-label">予約</span><span class="mstat-value">${booked}</span></div>
        <div class="mstat"><span class="mstat-label">残り目標</span><span class="mstat-value ${remaining === 0 ? 'good' : ''}">${remaining}</span></div>
      </div>
      <div class="member-meta">
        <div>次回セッション: ${next ? escapeHtml(next) : '未定'}</div>
        <div>契約残り: ${m.remainingContract} 回</div>
        ${m.memo ? `<div class="member-memo">メモ: ${escapeHtml(m.memo)}</div>` : ''}
      </div>
      ${
        isCurrent
          ? `
      <div class="member-actions">
        <div class="counter-group">
          <span class="counter-label">実施</span>
          <button class="btn-round" data-action="done-minus" data-id="${m.id}">−1</button>
          <button class="btn-round primary" data-action="done-plus" data-id="${m.id}">＋1</button>
        </div>
        <div class="counter-group">
          <span class="counter-label">予約</span>
          <button class="btn-round" data-action="booked-minus" data-id="${m.id}">−1</button>
          <button class="btn-round wide" data-action="booked-plus" data-id="${m.id}">＋予約</button>
        </div>
      </div>`
          : ''
      }
      <div class="member-footer">
        <button class="btn-link" data-action="edit-member" data-id="${m.id}">編集</button>
        <button class="btn-link danger" data-action="delete-member" data-id="${m.id}">削除</button>
      </div>
    </div>`;
  }

  function renderMembers() {
    const list = $('#members-list');
    if (state.data.members.length === 0) {
      list.innerHTML = `<p class="empty-msg">まだ会員が登録されていません。「＋ 会員を追加」から登録してください。</p>`;
      return;
    }
    list.innerHTML = state.data.members.map(memberCardHtml).join('');
  }

  // ---------- actions ----------
  function addDoneToday(memberId) {
    state.data.log.push({ id: genId(), memberId, date: todayISO(), type: 'done' });
    saveData();
    render();
  }

  function removeLastDone(memberId) {
    const idx = [...state.data.log]
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.memberId === memberId && e.type === 'done')
      .map(({ i }) => i)
      .pop();
    if (idx === undefined) return;
    state.data.log.splice(idx, 1);
    saveData();
    render();
  }

  function removeNextBooking(memberId) {
    const today = todayISO();
    const candidates = state.data.log
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.memberId === memberId && e.type === 'booked' && e.date >= today)
      .sort((a, b) => (a.e.date < b.e.date ? -1 : 1));
    if (candidates.length === 0) return;
    state.data.log.splice(candidates[0].i, 1);
    saveData();
    render();
  }

  function addBooking(memberId, dateStr) {
    state.data.log.push({ id: genId(), memberId, date: dateStr, type: 'booked' });
    saveData();
    render();
  }

  function deleteMember(memberId) {
    state.data.members = state.data.members.filter((m) => m.id !== memberId);
    state.data.log = state.data.log.filter((e) => e.memberId !== memberId);
    saveData();
    render();
  }

  // ---------- modals ----------
  function openModal(id) {
    $(id).classList.remove('hidden');
  }
  function closeModal(id) {
    $(id).classList.add('hidden');
  }

  function openMemberForm(member) {
    const form = $('#member-form');
    form.reset();
    $('#member-form-title').textContent = member ? '会員を編集' : '会員を追加';
    $('#member-id').value = member ? member.id : '';
    $('#member-name').value = member ? member.name : '';
    $('#member-weekly-freq').value = member ? member.weeklyFreq : 2;
    $('#member-monthly-goal').value = member ? member.monthlyGoal : 8;
    $('#member-remaining-contract').value = member ? member.remainingContract : 0;
    $('#member-memo').value = member ? member.memo : '';
    openModal('#member-modal');
  }

  function openBookingForm(memberId) {
    $('#booking-member-id').value = memberId;
    $('#booking-date').value = todayISO();
    $('#booking-date').min = todayISO();
    openModal('#booking-modal');
  }

  let confirmCallback = null;
  function openConfirm(message, cb) {
    $('#confirm-message').textContent = message;
    confirmCallback = cb;
    openModal('#confirm-modal');
  }

  // ---------- event wiring ----------
  function wireEvents() {
    $('#month-nav-prev').addEventListener('click', () => {
      state.viewMonthKey = addMonths(state.viewMonthKey, -1);
      render();
    });
    $('#month-nav-next').addEventListener('click', () => {
      if (state.viewMonthKey < todayMonthKey()) {
        state.viewMonthKey = addMonths(state.viewMonthKey, 1);
        render();
      }
    });

    $('#monthly-goal-input').addEventListener('change', (e) => {
      const v = Math.max(0, parseInt(e.target.value, 10) || 0);
      state.data.monthlyGoalByMonth[state.viewMonthKey] = v;
      saveData();
      render();
    });

    $('#week-goal-input').addEventListener('change', (e) => {
      const v = Math.max(0, parseInt(e.target.value, 10) || 0);
      const range = currentWeekRange();
      state.data.weeklyGoalByWeek[range.key] = v;
      saveData();
      render();
    });

    $('#members-list').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const { action, id } = btn.dataset;
      const member = state.data.members.find((m) => m.id === id);
      if (!member) return;
      if (action === 'done-plus') addDoneToday(id);
      else if (action === 'done-minus') removeLastDone(id);
      else if (action === 'booked-plus') openBookingForm(id);
      else if (action === 'booked-minus') removeNextBooking(id);
      else if (action === 'edit-member') openMemberForm(member);
      else if (action === 'delete-member') {
        openConfirm(`「${member.name}」を削除します。よろしいですか？（記録もすべて削除されます）`, () =>
          deleteMember(id)
        );
      }
    });

    $('#add-member-btn').addEventListener('click', () => openMemberForm(null));
    $('#member-cancel-btn').addEventListener('click', () => closeModal('#member-modal'));

    $('#member-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const id = $('#member-id').value;
      const payload = {
        name: $('#member-name').value.trim() || '名称未設定',
        weeklyFreq: Math.max(0, parseInt($('#member-weekly-freq').value, 10) || 0),
        monthlyGoal: Math.max(0, parseInt($('#member-monthly-goal').value, 10) || 0),
        remainingContract: Math.max(0, parseInt($('#member-remaining-contract').value, 10) || 0),
        memo: $('#member-memo').value.trim(),
      };
      if (id) {
        const m = state.data.members.find((x) => x.id === id);
        Object.assign(m, payload);
      } else {
        state.data.members.push({ id: genId(), ...payload });
      }
      saveData();
      closeModal('#member-modal');
      render();
    });

    $('#booking-cancel-btn').addEventListener('click', () => closeModal('#booking-modal'));
    $('#booking-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const memberId = $('#booking-member-id').value;
      const date = $('#booking-date').value;
      if (date) addBooking(memberId, date);
      closeModal('#booking-modal');
    });

    $('#confirm-cancel-btn').addEventListener('click', () => {
      confirmCallback = null;
      closeModal('#confirm-modal');
    });
    $('#confirm-ok-btn').addEventListener('click', () => {
      if (confirmCallback) confirmCallback();
      confirmCallback = null;
      closeModal('#confirm-modal');
    });

    $('#export-btn').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bug-session-data-${todayISO()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });

    $('#import-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result);
          openConfirm('現在のデータを、読み込んだファイルの内容で上書きします。よろしいですか？', () => {
            state.data = Object.assign(defaultData(), parsed);
            saveData();
            render();
          });
        } catch (err) {
          alert('ファイルの読み込みに失敗しました。正しいバックアップファイルを選択してください。');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    $('#reset-btn').addEventListener('click', () => {
      openConfirm('すべてのデータを削除して初期状態に戻します。この操作は取り消せません。よろしいですか？', () => {
        state.data = defaultData();
        saveData();
        render();
      });
    });
  }

  wireEvents();
  render();
})();
