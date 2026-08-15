(() => {
  'use strict';

  const LOCAL_SETTINGS_KEY = 'bug_session_goal_app_v1';
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

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  // ---------- local settings (店舗全体の月間/週間目標のみ。会員データはSupabaseへ) ----------
  function defaultLocalSettings() {
    return { monthlyGoalByMonth: {}, weeklyGoalByWeek: {} };
  }

  function loadLocalSettings() {
    try {
      const raw = localStorage.getItem(LOCAL_SETTINGS_KEY);
      if (!raw) return defaultLocalSettings();
      const parsed = JSON.parse(raw);
      return {
        monthlyGoalByMonth: parsed.monthlyGoalByMonth || {},
        weeklyGoalByWeek: parsed.weeklyGoalByWeek || {},
      };
    } catch (e) {
      console.error('設定の読み込みに失敗しました', e);
      return defaultLocalSettings();
    }
  }

  function saveLocalSettings() {
    localStorage.setItem(LOCAL_SETTINGS_KEY, JSON.stringify(state.settings));
  }

  // ---------- state ----------
  const state = {
    settings: loadLocalSettings(),
    data: { members: [], log: [] },
    viewMonthKey: todayMonthKey(),
    busy: false,
  };

  // ---------- Supabase client ----------
  let supabase = null;

  function supabaseConfigured() {
    const cfg = window.SUPABASE_CONFIG;
    return !!(cfg && cfg.url && cfg.anonKey && !cfg.url.includes('YOUR_SUPABASE') && !cfg.anonKey.includes('YOUR_SUPABASE'));
  }

  function initSupabaseClient() {
    const cfg = window.SUPABASE_CONFIG;
    supabase = window.supabase.createClient(cfg.url, cfg.anonKey);
  }

  // ---------- row <-> app model mapping ----------
  function memberFromRow(row) {
    return {
      id: row.id,
      name: row.name,
      weeklyFreq: row.weekly_sessions || 0,
      monthlyGoal: row.monthly_target || 0,
      remainingContract: row.remaining_contract || 0,
      memo: row.memo || '',
    };
  }

  function memberToRow(m) {
    return {
      name: m.name,
      weekly_sessions: m.weeklyFreq,
      monthly_target: m.monthlyGoal,
      remaining_contract: m.remainingContract,
      memo: m.memo,
    };
  }

  function logFromRow(row) {
    return { id: row.id, memberId: row.member_id, date: row.session_date, type: row.type };
  }

  const FIELD_LABELS = {
    name: '会員名',
    weekly_sessions: '週の目標頻度',
    monthly_target: '月の目標セッション数',
    remaining_contract: '契約残りセッション数',
    memo: 'メモ',
  };

  // 送信した内容とSupabaseが実際に保存した内容を突き合わせ、ズレがあれば警告する
  // （スキーマキャッシュが古いままだと、エラーにならずに一部の列だけ既定値で
  //   保存されてしまうことがあるため、その状態を画面上で見逃さないようにする）
  function warnIfMismatch(sentRow, savedRow) {
    const mismatched = Object.keys(sentRow).filter((key) => sentRow[key] !== savedRow[key]);
    if (mismatched.length === 0) return;
    const labels = mismatched.map((k) => FIELD_LABELS[k] || k).join('、');
    showErrorBanner(
      `保存はできましたが、一部の項目（${labels}）がSupabaseに反映されていない可能性があります。Supabaseダッシュボードの「Project Settings → Data API」→「Reload schema cache」を実行してから、もう一度保存し直してください。`
    );
  }

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
    const keys = Object.keys(state.settings.monthlyGoalByMonth).sort();
    return resolveGoal(state.settings.monthlyGoalByMonth, monthKey, keys, DEFAULT_MONTHLY_GOAL);
  }

  function weeklyGoalFor(weekKey) {
    const keys = Object.keys(state.settings.weeklyGoalByWeek).sort();
    return resolveGoal(state.settings.weeklyGoalByWeek, weekKey, keys, DEFAULT_WEEKLY_GOAL);
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

  // ---------- Supabase data access ----------
  async function fetchAll() {
    const [membersRes, logsRes] = await Promise.all([
      supabase.from('members').select('*').order('created_at', { ascending: true }),
      supabase.from('session_logs').select('*'),
    ]);
    if (membersRes.error) throw membersRes.error;
    if (logsRes.error) throw logsRes.error;
    state.data.members = membersRes.data.map(memberFromRow);
    state.data.log = logsRes.data.map(logFromRow);
  }

  // 今月分の実施・予約件数を members.completed_sessions / booked_sessions に反映する
  // （画面はログから直接集計するため必須ではないが、Supabase側のテーブルを直接見たときも
  //   常に「今月の値」が表示されるようにするための同期処理）
  async function syncMemberCounts(memberId) {
    const monthKey = todayMonthKey();
    const done = doneInMonth(memberId, monthKey);
    const booked = bookedInMonth(memberId, monthKey);
    const { error } = await supabase
      .from('members')
      .update({ completed_sessions: done, booked_sessions: booked })
      .eq('id', memberId);
    if (error) throw error;
  }

  async function reconcileAllMemberCounts() {
    const monthKey = todayMonthKey();
    for (const m of state.data.members) {
      const done = doneInMonth(m.id, monthKey);
      const booked = bookedInMonth(m.id, monthKey);
      await supabase.from('members').update({ completed_sessions: done, booked_sessions: booked }).eq('id', m.id);
    }
  }

  async function createMember(payload) {
    const rowToSend = memberToRow(payload);
    const { data, error } = await supabase.from('members').insert(rowToSend).select().single();
    if (error) throw error;
    if (!data) throw new Error('会員の保存確認に失敗しました（Supabaseからの応答が空でした）');
    state.data.members.push(memberFromRow(data));
    warnIfMismatch(rowToSend, data);
  }

  async function updateMemberRow(id, payload) {
    const rowToSend = memberToRow(payload);
    const { data, error } = await supabase.from('members').update(rowToSend).eq('id', id).select().single();
    if (error) throw error;
    if (!data) throw new Error('会員情報の更新確認に失敗しました（Supabaseからの応答が空でした）');
    const m = state.data.members.find((x) => x.id === id);
    Object.assign(m, memberFromRow(data));
    warnIfMismatch(rowToSend, data);
  }

  async function deleteMemberRow(id) {
    const { error } = await supabase.from('members').delete().eq('id', id);
    if (error) throw error;
    state.data.members = state.data.members.filter((m) => m.id !== id);
    state.data.log = state.data.log.filter((e) => e.memberId !== id);
  }

  async function insertLog(memberId, date, type) {
    const { data, error } = await supabase
      .from('session_logs')
      .insert({ member_id: memberId, session_date: date, type })
      .select()
      .single();
    if (error) throw error;
    state.data.log.push(logFromRow(data));
    await syncMemberCounts(memberId);
  }

  async function deleteLogRow(logId, memberId) {
    const { error } = await supabase.from('session_logs').delete().eq('id', logId);
    if (error) throw error;
    state.data.log = state.data.log.filter((e) => e.id !== logId);
    await syncMemberCounts(memberId);
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

  // ---------- busy guard & error banner ----------
  async function withBusyGuard(fn) {
    if (state.busy) return;
    state.busy = true;
    try {
      await fn();
    } catch (err) {
      console.error(err);
      showErrorBanner('通信に失敗しました。ネットワーク接続を確認してもう一度お試しください。（' + (err.message || err) + '）');
    } finally {
      state.busy = false;
    }
  }

  function showErrorBanner(message) {
    $('#error-message').textContent = message;
    $('#error-banner').classList.remove('hidden');
  }

  function hideErrorBanner() {
    $('#error-banner').classList.add('hidden');
  }

  // ---------- actions ----------
  async function addDoneToday(memberId) {
    await insertLog(memberId, todayISO(), 'done');
    render();
  }

  async function removeLastDone(memberId) {
    const candidates = state.data.log
      .filter((e) => e.memberId === memberId && e.type === 'done')
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (candidates.length === 0) return;
    const last = candidates[candidates.length - 1];
    await deleteLogRow(last.id, memberId);
    render();
  }

  async function removeNextBooking(memberId) {
    const today = todayISO();
    const candidates = state.data.log
      .filter((e) => e.memberId === memberId && e.type === 'booked' && e.date >= today)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (candidates.length === 0) return;
    await deleteLogRow(candidates[0].id, memberId);
    render();
  }

  async function addBooking(memberId, dateStr) {
    await insertLog(memberId, dateStr, 'booked');
    render();
  }

  async function deleteMember(memberId) {
    await deleteMemberRow(memberId);
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
      state.settings.monthlyGoalByMonth[state.viewMonthKey] = v;
      saveLocalSettings();
      render();
    });

    $('#week-goal-input').addEventListener('change', (e) => {
      const v = Math.max(0, parseInt(e.target.value, 10) || 0);
      const range = currentWeekRange();
      state.settings.weeklyGoalByWeek[range.key] = v;
      saveLocalSettings();
      render();
    });

    $('#members-list').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const { action } = btn.dataset;
      const id = Number(btn.dataset.id);
      const member = state.data.members.find((m) => m.id === id);
      if (!member) return;
      if (action === 'done-plus') withBusyGuard(() => addDoneToday(id));
      else if (action === 'done-minus') withBusyGuard(() => removeLastDone(id));
      else if (action === 'booked-plus') openBookingForm(id);
      else if (action === 'booked-minus') withBusyGuard(() => removeNextBooking(id));
      else if (action === 'edit-member') openMemberForm(member);
      else if (action === 'delete-member') {
        openConfirm(`「${member.name}」を削除します。よろしいですか？（Supabase上の記録もすべて削除されます）`, () =>
          withBusyGuard(() => deleteMember(id))
        );
      }
    });

    $('#add-member-btn').addEventListener('click', () => openMemberForm(null));
    $('#member-cancel-btn').addEventListener('click', () => closeModal('#member-modal'));

    $('#member-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const idRaw = $('#member-id').value;
      const id = idRaw ? Number(idRaw) : null;
      const payload = {
        name: $('#member-name').value.trim() || '名称未設定',
        weeklyFreq: Math.max(0, parseInt($('#member-weekly-freq').value, 10) || 0),
        monthlyGoal: Math.max(0, parseInt($('#member-monthly-goal').value, 10) || 0),
        remainingContract: Math.max(0, parseInt($('#member-remaining-contract').value, 10) || 0),
        memo: $('#member-memo').value.trim(),
      };
      withBusyGuard(async () => {
        if (id) {
          await updateMemberRow(id, payload);
        } else {
          await createMember(payload);
        }
        closeModal('#member-modal');
        render();
      });
    });

    $('#booking-cancel-btn').addEventListener('click', () => closeModal('#booking-modal'));
    $('#booking-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const memberId = Number($('#booking-member-id').value);
      const date = $('#booking-date').value;
      if (!date) {
        closeModal('#booking-modal');
        return;
      }
      withBusyGuard(async () => {
        await addBooking(memberId, date);
        closeModal('#booking-modal');
      });
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

    $('#error-close-btn').addEventListener('click', hideErrorBanner);
    $('#error-retry-btn').addEventListener('click', () => {
      hideErrorBanner();
      init();
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
          const members = Array.isArray(parsed.members) ? parsed.members : [];
          openConfirm(
            `バックアップファイル内の会員 ${members.length} 名を、新しい会員として追加します（上書きではありません）。よろしいですか？`,
            () =>
              withBusyGuard(async () => {
                for (const m of members) {
                  await createMember({
                    name: m.name,
                    weeklyFreq: m.weeklyFreq || 0,
                    monthlyGoal: m.monthlyGoal || 0,
                    remainingContract: m.remainingContract || 0,
                    memo: m.memo || '',
                  });
                }
                render();
              })
          );
        } catch (err) {
          alert('ファイルの読み込みに失敗しました。正しいバックアップファイルを選択してください。');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    $('#reset-btn').addEventListener('click', () => {
      openConfirm(
        '全会員のデータをSupabaseから完全に削除します。この操作は他の端末にも影響し、元に戻せません。本当によろしいですか？',
        () =>
          withBusyGuard(async () => {
            for (const m of [...state.data.members]) {
              await deleteMemberRow(m.id);
            }
            render();
          })
      );
    });
  }

  // ---------- init ----------
  function showLoading(show) {
    $('#loading-overlay').classList.toggle('hidden', !show);
  }

  async function init() {
    hideErrorBanner();

    if (!window.supabase || !window.supabase.createClient) {
      showErrorBanner('Supabaseライブラリの読み込みに失敗しました。インターネット接続を確認してページを再読み込みしてください。');
      return;
    }

    if (!supabaseConfigured()) {
      $('#setup-banner').classList.remove('hidden');
      showLoading(false);
      return;
    }
    $('#setup-banner').classList.add('hidden');

    showLoading(true);
    try {
      if (!supabase) initSupabaseClient();
      await fetchAll();
      render();
      showLoading(false);
      // 月が変わったタイミングなどで会員テーブルの表示用カウントを最新化する（裏側で実行）
      reconcileAllMemberCounts()
        .then(render)
        .catch((err) => console.error('カウントの再集計に失敗しました', err));
    } catch (err) {
      console.error(err);
      showLoading(false);
      showErrorBanner('Supabaseへの接続に失敗しました。URLとキーが正しいかご確認ください。（' + (err.message || err) + '）');
    }
  }

  wireEvents();
  init();
})();
