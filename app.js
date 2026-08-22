(() => {
  'use strict';

  const LOCAL_SETTINGS_KEY = 'bug_session_goal_app_v1';
  const DEFAULT_MONTHLY_GOAL = 120;
  const DEFAULT_WEEKLY_GOAL = 28;
  const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];
  const COURSE_LABELS = { 8: '8回コース', 24: '24回コース', 48: '48回コース' };
  const STATUS_LABELS = { achieved: '達成', ontrack: '順調', short: '不足' };

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
    return `${s.getMonth() + 1}/${s.getDate()}(${WEEKDAYS_JA[s.getDay()]})〜${e.getMonth() + 1}/${e.getDate()}(${WEEKDAYS_JA[e.getDay()]})`;
  }

  function inRange(dateStr, startStr, endStr) {
    return dateStr >= startStr && dateStr <= endStr;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  function courseLabel(course) {
    return course ? COURSE_LABELS[course] || `${course}回コース` : '未設定';
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
    calendarMonth: {}, // memberId -> 'YYYY-MM'（会員詳細のミニカレンダーは月全体のナビゲーションと独立）
    activeView: 'dashboard', // 'dashboard' | 'members' | 'calendar'
    dashboardSearch: '',
    membersFilter: { query: '', course: 'all', status: 'all', sort: 'name' },
    detailMemberId: null,
    busy: false,
  };

  function getCalendarMonthKey(memberId) {
    if (!state.calendarMonth[memberId]) state.calendarMonth[memberId] = todayMonthKey();
    return state.calendarMonth[memberId];
  }

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
      course: row.course_sessions || null,
      weeklyFreq: row.weekly_sessions || 0,
      monthlyGoal: row.monthly_target || 0,
      remainingContract: row.remaining_contract || 0,
      memo: row.memo || '',
    };
  }

  function memberToRow(m) {
    return {
      name: m.name,
      course_sessions: m.course || null,
      weekly_sessions: m.weeklyFreq,
      monthly_target: m.monthlyGoal,
      remaining_contract: m.remainingContract,
      memo: m.memo,
    };
  }

  function logFromRow(row) {
    return { id: row.id, memberId: row.member_id, date: row.session_date, type: row.type, time: row.session_time || null };
  }

  const FIELD_LABELS = {
    name: '会員名',
    course_sessions: 'コース',
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

  // 今月の実施/予約/残り必要数/達成率/ステータス（達成・順調・不足）をまとめて算出する
  function memberMonthStats(member, monthKey) {
    const done = doneInMonth(member.id, monthKey);
    const booked = bookedInMonth(member.id, monthKey);
    const target = member.monthlyGoal || 0;
    const remaining = Math.max(target - done - booked, 0);
    const rate = target > 0 ? Math.min(100, Math.round((done / target) * 100)) : 0;
    let status;
    if (target <= 0 || done >= target) status = 'achieved';
    else if (done + booked >= target) status = 'ontrack';
    else status = 'short';
    return { done, booked, target, remaining, rate, status };
  }

  // 直近の未来の予約（日付＋時間）を1件返す
  function nextBookingEntry(memberId) {
    const today = todayISO();
    const entries = state.data.log
      .filter((e) => e.memberId === memberId && e.type === 'booked' && e.date >= today)
      .sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        const ta = a.time || '99:99';
        const tb = b.time || '99:99';
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      });
    return entries[0] || null;
  }

  function formatNextSession(memberId) {
    const e = nextBookingEntry(memberId);
    if (!e) return null;
    const d = parseISO(e.date);
    const dateLabel = `${d.getMonth() + 1}/${d.getDate()}`;
    return e.time ? `${dateLabel} ${e.time.slice(0, 5)}` : dateLabel;
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

  // 予約日を過ぎた「予約」を自動的に「実施」へ変更する
  // （無断キャンセル等で実際には来なかった場合は、会員詳細の「実施－」で取り消してください）
  async function autoCompletePastBookings() {
    const today = todayISO();
    const overdue = state.data.log.filter((e) => e.type === 'booked' && e.date < today);
    if (overdue.length === 0) return;
    const affectedMemberIds = new Set();
    for (const entry of overdue) {
      const { error } = await supabase.from('session_logs').update({ type: 'done' }).eq('id', entry.id);
      if (error) throw error;
      entry.type = 'done';
      affectedMemberIds.add(entry.memberId);
    }
    for (const memberId of affectedMemberIds) {
      await syncMemberCounts(memberId);
    }
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

  async function insertLog(memberId, date, type, time) {
    const { data, error } = await supabase
      .from('session_logs')
      .insert({ member_id: memberId, session_date: date, type, session_time: time || null })
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
    renderDashboardSearch();
    renderMembersView();
    renderCalendarOverview();
    renderNoBookingView();
    renderApproachView();
    renderTodayView();
    if (state.detailMemberId != null && !$('#member-detail-modal').classList.contains('hidden')) {
      renderMemberDetail();
    }
    if (memberDayContext && !$('#member-day-modal').classList.contains('hidden')) {
      renderMemberDayModal();
    }
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

  // ---------- ダッシュボード会員検索 ----------
  function renderDashboardSearch() {
    const q = state.dashboardSearch.trim();
    const resultsEl = $('#dashboard-search-results');
    if (!q) {
      resultsEl.innerHTML = '';
      resultsEl.classList.add('hidden');
      return;
    }
    resultsEl.classList.remove('hidden');
    const monthKey = state.viewMonthKey;
    const matches = state.data.members.filter((m) => m.name.toLowerCase().includes(q.toLowerCase()));
    if (matches.length === 0) {
      resultsEl.innerHTML = `<p class="cal-overview-empty">「${escapeHtml(q)}」に一致する会員が見つかりません</p>`;
      return;
    }
    resultsEl.innerHTML = matches
      .map((m) => {
        const stats = memberMonthStats(m, monthKey);
        const next = formatNextSession(m.id);
        return `
        <button type="button" class="search-result-row" data-action="open-detail" data-id="${m.id}">
          <div class="search-result-name">${escapeHtml(m.name)}</div>
          <div class="search-result-line">${courseLabel(m.course)}｜残り${m.remainingContract}回</div>
          <div class="search-result-line">次回 ${next ? escapeHtml(next) : '未定'}</div>
          <div class="search-result-line">今月 ${stats.done}実施 / ${stats.booked}予約 / ${stats.target}目標</div>
        </button>`;
      })
      .join('');
  }

  // ---------- 全会員の月間カレンダー ----------
  function renderCalendarOverview() {
    const monthKey = state.viewMonthKey;
    $('#cal-overview-month-label').textContent = ` ${monthLabel(monthKey)}`;

    const totalDays = daysInMonth(monthKey);
    const [y, mo] = monthKey.split('-').map(Number);
    const startWeekday = new Date(y, mo - 1, 1).getDay();
    const today = todayISO();

    const byDate = {};
    state.data.log.forEach((e) => {
      if (monthKeyOf(e.date) !== monthKey) return;
      if (!byDate[e.date]) byDate[e.date] = { done: 0, booked: 0 };
      byDate[e.date][e.type]++;
    });

    const todayEntry = byDate[today];
    $('#today-count-badge').textContent = todayEntry ? todayEntry.done + todayEntry.booked : 0;

    const cells = [];
    for (let i = 0; i < startWeekday; i++) cells.push('<div class="ocal-cell empty"></div>');
    for (let day = 1; day <= totalDays; day++) {
      const dateStr = `${monthKey}-${pad2(day)}`;
      const entry = byDate[dateStr];
      const doneCount = entry ? entry.done : 0;
      const bookedCount = entry ? entry.booked : 0;
      const total = doneCount + bookedCount;
      const isToday = dateStr === today;
      if (total === 0) {
        cells.push(`<div class="ocal-cell${isToday ? ' is-today' : ''}"><span class="ocal-day">${day}</span></div>`);
      } else {
        cells.push(`
          <button type="button" class="ocal-cell has-data${isToday ? ' is-today' : ''}" data-date="${dateStr}">
            <span class="ocal-day">${day}</span>
            <span class="ocal-dots">
              ${bookedCount ? '<span class="ocal-dot ocal-dot-booked"></span>' : ''}
              ${doneCount ? '<span class="ocal-dot ocal-dot-done"></span>' : ''}
            </span>
            ${total >= 2 ? `<span class="ocal-count">${total}件</span>` : ''}
          </button>`);
      }
    }
    $('#overview-calendar-grid').innerHTML = cells.join('');

    // 今週誰が来るか
    const range = currentWeekRange();
    const weekEntries = state.data.log
      .filter((e) => inRange(e.date, range.start, range.end))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const weekListEl = $('#this-week-list');
    if (weekEntries.length === 0) {
      weekListEl.innerHTML = `<p class="cal-overview-empty">今週の予定はありません</p>`;
    } else {
      weekListEl.innerHTML = weekEntries
        .map((e) => {
          const member = state.data.members.find((mm) => mm.id === e.memberId);
          const d = parseISO(e.date);
          const label = `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS_JA[d.getDay()]})`;
          const statusClass = e.type === 'done' ? 'is-done' : 'is-booked';
          const statusLabel = e.type === 'done' ? '実施済み' : '予約';
          return `<div class="week-list-row ${statusClass}"><span class="week-list-date">${label}</span><span class="week-list-name">${escapeHtml(member ? member.name : '(削除済み)')}</span><span class="week-list-status">${statusLabel}</span></div>`;
        })
        .join('');
    }

    // 会員別 今月の回数
    const tallyRows = state.data.members
      .map((mm) => ({ name: mm.name, done: doneInMonth(mm.id, monthKey), booked: bookedInMonth(mm.id, monthKey) }))
      .filter((r) => r.done + r.booked > 0)
      .sort((a, b) => b.done + b.booked - (a.done + a.booked));
    const tallyEl = $('#member-tally-list');
    if (tallyRows.length === 0) {
      tallyEl.innerHTML = `<p class="cal-overview-empty">今月の記録はまだありません</p>`;
    } else {
      tallyEl.innerHTML = tallyRows
        .map(
          (r) =>
            `<div class="tally-row"><span class="tally-name">${escapeHtml(r.name)}</span><span class="tally-count">実施${r.done}・予約${r.booked}</span></div>`
        )
        .join('');
    }
  }

  function openDayDetail(dateStr) {
    const d = parseISO(dateStr);
    $('#day-detail-title').textContent = `${d.getMonth() + 1}月${d.getDate()}日(${WEEKDAYS_JA[d.getDay()]})`;

    const entries = state.data.log
      .filter((e) => e.date === dateStr)
      .map((e) => ({ ...e, member: state.data.members.find((mm) => mm.id === e.memberId) }))
      .sort((a, b) => {
        const ta = a.time || '99:99';
        const tb = b.time || '99:99';
        if (ta !== tb) return ta < tb ? -1 : 1;
        return (a.member ? a.member.name : '').localeCompare(b.member ? b.member.name : '');
      });

    $('#day-detail-list').innerHTML =
      entries
        .map((e) => {
          const statusClass = e.type === 'done' ? 'is-done' : 'is-booked';
          const statusLabel = e.type === 'done' ? '実施済み' : '予約';
          const timeLabel = e.time ? e.time.slice(0, 5) : '時間未定';
          const nameHtml = e.member
            ? `<button type="button" class="day-detail-name" data-action="open-detail" data-id="${e.member.id}">${escapeHtml(e.member.name)}</button>`
            : `<span class="day-detail-name">(削除済み)</span>`;
          return `
        <div class="day-detail-row ${statusClass}">
          <span class="day-detail-time">${timeLabel}</span>
          ${nameHtml}
          <span class="day-detail-badge">${statusLabel}</span>
        </div>`;
        })
        .join('') || `<p class="cal-overview-empty">この日の予定はありません</p>`;

    openModal('#day-detail-modal');
  }

  // 会員ごとのミニカレンダー（実施済み＝✓、予約あり＝●）
  function calendarHtml(member) {
    const monthKey = getCalendarMonthKey(member.id);
    const [y, mo] = monthKey.split('-').map(Number);
    const totalDays = daysInMonth(monthKey);
    const startWeekday = new Date(y, mo - 1, 1).getDay();
    const today = todayISO();

    const statusByDate = {};
    state.data.log.forEach((e) => {
      if (e.memberId !== member.id || monthKeyOf(e.date) !== monthKey) return;
      if (e.type === 'done') statusByDate[e.date] = 'done';
      else if (e.type === 'booked' && statusByDate[e.date] !== 'done') statusByDate[e.date] = 'booked';
    });
    const doneCount = Object.values(statusByDate).filter((s) => s === 'done').length;
    const bookedCount = Object.values(statusByDate).filter((s) => s === 'booked').length;

    const cells = [];
    for (let i = 0; i < startWeekday; i++) cells.push('<div class="cal-cell empty"></div>');
    for (let day = 1; day <= totalDays; day++) {
      const dateStr = `${monthKey}-${pad2(day)}`;
      const status = statusByDate[dateStr];
      const mark =
        status === 'done'
          ? '<span class="cal-mark cal-done">✓</span>'
          : status === 'booked'
          ? '<span class="cal-mark cal-booked">●</span>'
          : '';
      cells.push(
        `<button type="button" class="cal-cell${dateStr === today ? ' is-today' : ''}" data-action="cal-day" data-date="${dateStr}" data-id="${member.id}"><span class="cal-day">${day}</span>${mark}</button>`
      );
    }

    return `
      <h4>簡易カレンダー</h4>
      <div class="mini-calendar">
        <div class="cal-head">
          <button type="button" class="cal-nav" data-action="cal-prev" data-id="${member.id}" aria-label="前の月">‹</button>
          <span class="cal-label">${monthLabel(monthKey)}</span>
          <button type="button" class="cal-nav" data-action="cal-next" data-id="${member.id}" aria-label="次の月">›</button>
        </div>
        <div class="cal-grid cal-weekdays">${WEEKDAYS_JA.map((w) => `<div class="cal-wd">${w}</div>`).join('')}</div>
        <div class="cal-grid">${cells.join('')}</div>
        <div class="cal-summary">実施 ${doneCount}・予約 ${bookedCount}</div>
      </div>`;
  }

  // ---------- 会員一覧（検索・絞り込み・並び替え） ----------
  function filterMembers(members, filter, monthKey) {
    const q = filter.query.trim().toLowerCase();
    return members.filter((m) => {
      if (q && !m.name.toLowerCase().includes(q)) return false;
      if (filter.course !== 'all') {
        if (filter.course === 'none') {
          if (m.course) return false;
        } else if (String(m.course) !== filter.course) {
          return false;
        }
      }
      if (filter.status !== 'all') {
        if (memberMonthStats(m, monthKey).status !== filter.status) return false;
      }
      return true;
    });
  }

  function sortMembers(members, sortKey, monthKey) {
    const arr = [...members];
    if (sortKey === 'next') {
      arr.sort((a, b) => {
        const na = nextBookingEntry(a.id);
        const nb = nextBookingEntry(b.id);
        const ka = na ? na.date + (na.time || '') : '9999-99-99';
        const kb = nb ? nb.date + (nb.time || '') : '9999-99-99';
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
    } else if (sortKey === 'contract') {
      arr.sort((a, b) => a.remainingContract - b.remainingContract);
    } else if (sortKey === 'shortage') {
      arr.sort((a, b) => memberMonthStats(b, monthKey).remaining - memberMonthStats(a, monthKey).remaining);
    } else {
      arr.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    }
    return arr;
  }

  function memberCompactCardHtml(m, monthKey) {
    const stats = memberMonthStats(m, monthKey);
    const next = formatNextSession(m.id);
    return `
    <button type="button" class="mcard" data-action="open-detail" data-id="${m.id}">
      <div class="mcard-head">
        <div class="mcard-name">${escapeHtml(m.name)}</div>
        <span class="mcard-status status-${stats.status}">${STATUS_LABELS[stats.status]}</span>
      </div>
      <div class="mcard-course">${courseLabel(m.course)}</div>
      <div class="mcard-sub">契約残り：${m.remainingContract}回 ・ 週${m.weeklyFreq}回</div>
      <div class="mcard-month">
        <div class="mcard-month-title">今月</div>
        <div class="mcard-month-grid">
          <div class="mcard-month-item"><span>目標</span><strong>${stats.target}回</strong></div>
          <div class="mcard-month-item"><span>実施</span><strong>${stats.done}回</strong></div>
          <div class="mcard-month-item"><span>予約</span><strong>${stats.booked}回</strong></div>
          <div class="mcard-month-item"><span>残り</span><strong>${stats.remaining}回</strong></div>
        </div>
      </div>
      <div class="mcard-rate">達成率 <strong>${stats.rate}%</strong></div>
      <div class="mcard-next">次回：${next ? escapeHtml(next) : '未定'}</div>
    </button>`;
  }

  function renderMembersView() {
    const monthKey = state.viewMonthKey;
    const listEl = $('#members-view-list');
    if (state.data.members.length === 0) {
      listEl.innerHTML = `<p class="empty-msg">まだ会員が登録されていません。「＋ 会員を追加」から登録してください。</p>`;
      return;
    }
    const filtered = filterMembers(state.data.members, state.membersFilter, monthKey);
    const sorted = sortMembers(filtered, state.membersFilter.sort, monthKey);
    if (sorted.length === 0) {
      listEl.innerHTML = `<p class="empty-msg">条件に一致する会員が見つかりません。</p>`;
      return;
    }
    listEl.innerHTML = sorted.map((m) => memberCompactCardHtml(m, monthKey)).join('');
  }

  // ---------- 予約なしの会員 ----------
  function renderNoBookingView() {
    const listEl = $('#no-booking-list');
    const badgeEl = $('#no-booking-count-badge');
    if (!listEl) return;
    const monthKey = state.viewMonthKey;
    const noBooking = state.data.members
      .filter((m) => !nextBookingEntry(m.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    if (badgeEl) badgeEl.textContent = state.data.members.length ? `（${noBooking.length}名）` : '';
    if (state.data.members.length === 0) {
      listEl.innerHTML = `<p class="empty-msg">まだ会員が登録されていません。</p>`;
      return;
    }
    if (noBooking.length === 0) {
      listEl.innerHTML = `<p class="empty-msg">全員に次回予約が入っています。</p>`;
      return;
    }
    listEl.innerHTML = noBooking.map((m) => memberCompactCardHtml(m, monthKey)).join('');
  }

  // ---------- 予約アプローチ（各週の実施済み状況が週目標に届いていない会員） ----------
  // 今月に入ってから今週までの、月〜日曜の週区切りを生成する
  function monthWeekRanges(monthKey) {
    const [y, m] = monthKey.split('-').map(Number);
    const firstOfMonth = new Date(y, m - 1, 1);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weeks = [];
    let ws = getWeekStart(firstOfMonth);
    while (ws <= today) {
      weeks.push({ start: isoDate(ws), end: isoDate(addDays(ws, 6)), key: isoDate(ws) });
      ws = addDays(ws, 7);
    }
    return weeks;
  }

  function approachWeekBlockHtml(range) {
    const rows = state.data.members
      .filter((m) => (m.weeklyFreq || 0) > 0)
      .map((m) => ({ member: m, done: doneInRange(m.id, range.start, range.end), target: m.weeklyFreq }))
      .filter((r) => r.done < r.target)
      .sort((a, b) => (b.target - b.done) - (a.target - a.done) || a.member.name.localeCompare(b.member.name, 'ja'));

    if (rows.length === 0) return { html: '', memberIds: [] };

    const rowsHtml = rows
      .map(
        (r) => `
      <div class="day-detail-row">
        <button type="button" class="day-detail-name" data-action="open-detail" data-id="${r.member.id}">${escapeHtml(r.member.name)}</button>
        <span class="day-detail-badge">実施 ${r.done}/${r.target}回</span>
        <span class="approach-shortfall-badge">不足${r.target - r.done}回</span>
      </div>`
      )
      .join('');

    return {
      html: `
        <section class="approach-week-block">
          <h3 class="approach-week-title">${weekLabel(range)}</h3>
          <div class="day-detail-list">${rowsHtml}</div>
        </section>`,
      memberIds: rows.map((r) => r.member.id),
    };
  }

  function renderApproachView() {
    const containerEl = $('#approach-list');
    const badgeEl = $('#approach-count-badge');
    if (!containerEl) return;

    if (state.data.members.length === 0) {
      if (badgeEl) badgeEl.textContent = '';
      containerEl.innerHTML = `<p class="empty-msg">まだ会員が登録されていません。</p>`;
      return;
    }

    const weeks = monthWeekRanges(todayMonthKey()).reverse(); // 今週を先頭に表示
    const shortMemberIds = new Set();
    const blocks = weeks
      .map((range) => approachWeekBlockHtml(range))
      .filter((block) => {
        block.memberIds.forEach((id) => shortMemberIds.add(id));
        return block.html !== '';
      })
      .map((block) => block.html);

    if (badgeEl) badgeEl.textContent = shortMemberIds.size ? `（${shortMemberIds.size}名）` : '';
    containerEl.innerHTML = blocks.length
      ? blocks.join('')
      : `<p class="empty-msg">今月に入ってからの各週で、週目標を下回っている会員はいません。</p>`;
  }

  // ---------- 今日の予定 ----------
  function renderTodayView() {
    const listEl = $('#today-schedule-list');
    const labelEl = $('#today-view-date-label');
    if (!listEl) return;
    const today = todayISO();
    const d = parseISO(today);
    if (labelEl) labelEl.textContent = ` ${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS_JA[d.getDay()]})`;

    const entries = state.data.log
      .filter((e) => e.date === today)
      .map((e) => ({ ...e, member: state.data.members.find((mm) => mm.id === e.memberId) }))
      .sort((a, b) => {
        const ta = a.time || '99:99';
        const tb = b.time || '99:99';
        if (ta !== tb) return ta < tb ? -1 : 1;
        return (a.member ? a.member.name : '').localeCompare(b.member ? b.member.name : '');
      });

    if (entries.length === 0) {
      listEl.innerHTML = `<p class="cal-overview-empty">今日の予定はありません</p>`;
      return;
    }

    listEl.innerHTML = entries
      .map((e) => {
        const statusClass = e.type === 'done' ? 'is-done' : 'is-booked';
        const statusLabel = e.type === 'done' ? '実施済み' : '予約';
        const timeLabel = e.time ? e.time.slice(0, 5) : '時間未定';
        const nameHtml = e.member
          ? `<button type="button" class="day-detail-name" data-action="open-detail" data-id="${e.member.id}">${escapeHtml(e.member.name)}</button>`
          : `<span class="day-detail-name">(削除済み)</span>`;
        const toggleHtml =
          e.type === 'booked'
            ? `<button type="button" class="day-detail-complete-btn" data-action="set-log-type" data-log-id="${e.id}" data-member-id="${e.memberId}" data-type="done">実施</button>`
            : `<button type="button" class="day-detail-revert-btn" data-action="set-log-type" data-log-id="${e.id}" data-member-id="${e.memberId}" data-type="booked">予約に戻す</button>`;
        return `
        <div class="day-detail-row ${statusClass}">
          <span class="day-detail-time">${timeLabel}</span>
          ${nameHtml}
          <span class="day-detail-badge">${statusLabel}</span>
          ${toggleHtml}
        </div>`;
      })
      .join('');
  }

  // 予約⇔実施済みの状態を切り替える（今日の予定タブから使用）
  async function setLogType(logId, memberId, type) {
    const { error } = await supabase.from('session_logs').update({ type }).eq('id', logId);
    if (error) throw error;
    const entry = state.data.log.find((e) => e.id === logId);
    if (entry) entry.type = type;
    await syncMemberCounts(memberId);
    render();
  }

  // ---------- 会員詳細モーダル ----------
  function openMemberDetail(memberId) {
    const m = state.data.members.find((x) => x.id === memberId);
    if (!m) return;
    state.detailMemberId = memberId;
    renderMemberDetail();
    openModal('#member-detail-modal');
  }

  function renderMemberDetail() {
    const m = state.data.members.find((x) => x.id === state.detailMemberId);
    if (!m) {
      closeModal('#member-detail-modal');
      return;
    }
    const monthKey = state.viewMonthKey;
    const stats = memberMonthStats(m, monthKey);
    const nextEntry = nextBookingEntry(m.id);

    $('#detail-name').textContent = m.name;
    const statusEl = $('#detail-status');
    statusEl.textContent = STATUS_LABELS[stats.status];
    statusEl.className = `mcard-status status-${stats.status}`;

    $('#detail-course').textContent = courseLabel(m.course);
    $('#detail-contract').textContent = `${m.remainingContract}回`;
    $('#detail-weekly-freq').textContent = `週${m.weeklyFreq}回`;
    $('#detail-monthly-goal').textContent = `${m.monthlyGoal}回`;
    $('#detail-memo').textContent = m.memo || 'メモはありません';

    $('#detail-done').textContent = stats.done;
    $('#detail-booked').textContent = stats.booked;
    $('#detail-remaining').textContent = stats.remaining;
    $('#detail-rate').textContent = `${stats.rate}%`;

    if (nextEntry) {
      const d = parseISO(nextEntry.date);
      $('#detail-next-date').textContent = `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS_JA[d.getDay()]})`;
      $('#detail-next-time').textContent = nextEntry.time ? nextEntry.time.slice(0, 5) : '時間未定';
    } else {
      $('#detail-next-date').textContent = '未定';
      $('#detail-next-time').textContent = '-';
    }

    const today = todayISO();
    const future = state.data.log
      .filter((e) => e.memberId === m.id && e.type === 'booked' && e.date >= today)
      .sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        const ta = a.time || '99:99';
        const tb = b.time || '99:99';
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      });
    $('#detail-booking-list').innerHTML = future.length
      ? future
          .map((e) => {
            const d = parseISO(e.date);
            const label = `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS_JA[d.getDay()]})`;
            const timeLabel = e.time ? e.time.slice(0, 5) : '時間未定';
            return `<div class="booking-row is-future"><span class="booking-date">${label}</span><span class="booking-time">${timeLabel}</span></div>`;
          })
          .join('')
      : `<p class="booking-empty">今後の予約はありません</p>`;

    $('#detail-calendar').innerHTML = calendarHtml(m);

    $('#detail-done-plus').dataset.id = m.id;
    $('#detail-done-minus').dataset.id = m.id;
    $('#detail-done-past-btn').dataset.id = m.id;
    $('#detail-booking-plus').dataset.id = m.id;
    $('#detail-booking-minus').dataset.id = m.id;
    $('#detail-edit-btn').dataset.id = m.id;
    $('#detail-delete-btn').dataset.id = m.id;
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

  async function addDoneOnDate(memberId, dateStr) {
    await insertLog(memberId, dateStr, 'done');
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

  async function addBooking(memberId, dateStr, timeStr) {
    await insertLog(memberId, dateStr, 'booked', timeStr);
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
    $('#member-course').value = member && member.course ? String(member.course) : '';
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
    $('#booking-time').value = '';
    openModal('#booking-modal');
  }

  function openDoneForm(memberId) {
    $('#done-member-id').value = memberId;
    $('#done-date').value = todayISO();
    $('#done-date').max = todayISO();
    openModal('#done-modal');
  }

  // ---------- 会員カレンダーの日付タップ: その日の実施・予約を追加/削除 ----------
  let memberDayContext = null;

  function openMemberDayModal(memberId, dateStr) {
    memberDayContext = { memberId, dateStr };
    renderMemberDayModal();
    openModal('#member-day-modal');
  }

  function renderMemberDayModal() {
    if (!memberDayContext) return;
    const { memberId, dateStr } = memberDayContext;
    const member = state.data.members.find((m) => m.id === memberId);
    if (!member) {
      memberDayContext = null;
      closeModal('#member-day-modal');
      return;
    }
    const d = parseISO(dateStr);
    const today = todayISO();
    $('#member-day-title').textContent = `${member.name}｜${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS_JA[d.getDay()]})`;

    const entries = state.data.log
      .filter((e) => e.memberId === memberId && e.date === dateStr)
      .sort((a, b) => {
        const ta = a.time || '99:99';
        const tb = b.time || '99:99';
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      });

    $('#member-day-entries-list').innerHTML = entries.length
      ? entries
          .map((e) => {
            const statusClass = e.type === 'done' ? 'is-done' : 'is-booked';
            const statusLabel = e.type === 'done' ? '実施済み' : '予約';
            const timeLabel = e.time ? e.time.slice(0, 5) : '時間未定';
            return `
          <div class="day-detail-row ${statusClass}">
            <span class="day-detail-time">${timeLabel}</span>
            <span class="day-detail-badge">${statusLabel}</span>
            <button type="button" class="day-detail-delete-btn" data-action="delete-day-entry" data-log-id="${e.id}" aria-label="削除">✕</button>
          </div>`;
          })
          .join('')
      : `<p class="cal-overview-empty">この日の記録はまだありません</p>`;

    $('#member-day-add-done-btn').classList.toggle('hidden', dateStr > today);
    $('#member-day-booking-row').classList.toggle('hidden', dateStr < today);
    $('#member-day-booking-time').value = '';
  }

  let confirmCallback = null;
  function openConfirm(message, cb) {
    $('#confirm-message').textContent = message;
    confirmCallback = cb;
    openModal('#confirm-modal');
  }

  // ---------- タブ切り替え ----------
  function switchView(view) {
    state.activeView = view;
    document.querySelectorAll('.app-view').forEach((el) => {
      el.classList.toggle('hidden', el.id !== `view-${view}`);
    });
    document.querySelectorAll('.app-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });
  }

  // ---------- event wiring ----------
  function wireEvents() {
    document.querySelectorAll('.app-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

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

    // ダッシュボード検索
    $('#dashboard-search-input').addEventListener('input', (e) => {
      state.dashboardSearch = e.target.value;
      renderDashboardSearch();
    });

    // 会員一覧: 検索・絞り込み・並び替え
    $('#members-search-input').addEventListener('input', (e) => {
      state.membersFilter.query = e.target.value;
      renderMembersView();
    });
    $('#members-filter-course').addEventListener('change', (e) => {
      state.membersFilter.course = e.target.value;
      renderMembersView();
    });
    $('#members-filter-status').addEventListener('change', (e) => {
      state.membersFilter.status = e.target.value;
      renderMembersView();
    });
    $('#members-sort').addEventListener('change', (e) => {
      state.membersFilter.sort = e.target.value;
      renderMembersView();
    });

    // 全会員カレンダー: 日付タップで詳細モーダル
    $('#overview-calendar-grid').addEventListener('click', (e) => {
      const cell = e.target.closest('.ocal-cell[data-date]');
      if (!cell) return;
      openDayDetail(cell.dataset.date);
    });
    $('#day-detail-close-btn').addEventListener('click', () => closeModal('#day-detail-modal'));

    // 今日の予定: 予約⇔実施済みの切り替えボタン
    $('#today-schedule-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="set-log-type"]');
      if (!btn) return;
      const logId = Number(btn.dataset.logId);
      const memberId = Number(btn.dataset.memberId);
      const type = btn.dataset.type;
      withBusyGuard(() => setLogType(logId, memberId, type));
    });

    // 会員カード・検索結果・日別詳細の会員名 → 会員詳細モーダルを開く（共通の委譲ハンドラ）
    document.body.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="open-detail"]');
      if (!btn) return;
      closeModal('#day-detail-modal');
      openMemberDetail(Number(btn.dataset.id));
    });

    // 会員詳細モーダル内のミニカレンダー月送り
    $('#detail-calendar').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const id = Number(btn.dataset.id);
      if (btn.dataset.action === 'cal-prev') {
        state.calendarMonth[id] = addMonths(getCalendarMonthKey(id), -1);
        renderMemberDetail();
      } else if (btn.dataset.action === 'cal-next') {
        state.calendarMonth[id] = addMonths(getCalendarMonthKey(id), 1);
        renderMemberDetail();
      } else if (btn.dataset.action === 'cal-day') {
        openMemberDayModal(id, btn.dataset.date);
      }
    });

    // 会員カレンダーの日付タップ用モーダル
    $('#member-day-add-done-btn').addEventListener('click', () => {
      if (!memberDayContext) return;
      withBusyGuard(() => addDoneOnDate(memberDayContext.memberId, memberDayContext.dateStr));
    });
    $('#member-day-add-booking-btn').addEventListener('click', () => {
      if (!memberDayContext) return;
      const time = $('#member-day-booking-time').value || null;
      withBusyGuard(() => addBooking(memberDayContext.memberId, memberDayContext.dateStr, time));
    });
    $('#member-day-entries-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="delete-day-entry"]');
      if (!btn || !memberDayContext) return;
      const logId = Number(btn.dataset.logId);
      withBusyGuard(async () => {
        await deleteLogRow(logId, memberDayContext.memberId);
        render();
      });
    });
    $('#member-day-close-btn').addEventListener('click', () => closeModal('#member-day-modal'));

    // 会員詳細モーダルの操作ボタン
    $('#detail-done-plus').addEventListener('click', () => {
      const id = Number($('#detail-done-plus').dataset.id);
      withBusyGuard(() => addDoneToday(id));
    });
    $('#detail-done-minus').addEventListener('click', () => {
      const id = Number($('#detail-done-minus').dataset.id);
      withBusyGuard(() => removeLastDone(id));
    });
    $('#detail-done-past-btn').addEventListener('click', () => {
      const id = Number($('#detail-done-past-btn').dataset.id);
      openDoneForm(id);
    });
    $('#detail-booking-plus').addEventListener('click', () => {
      const id = Number($('#detail-booking-plus').dataset.id);
      openBookingForm(id);
    });
    $('#detail-booking-minus').addEventListener('click', () => {
      const id = Number($('#detail-booking-minus').dataset.id);
      withBusyGuard(() => removeNextBooking(id));
    });
    $('#detail-edit-btn').addEventListener('click', () => {
      const id = Number($('#detail-edit-btn').dataset.id);
      const member = state.data.members.find((m) => m.id === id);
      if (member) openMemberForm(member);
    });
    $('#detail-delete-btn').addEventListener('click', () => {
      const id = Number($('#detail-delete-btn').dataset.id);
      const member = state.data.members.find((m) => m.id === id);
      if (!member) return;
      openConfirm(`「${member.name}」を削除します。よろしいですか？（Supabase上の記録もすべて削除されます）`, () =>
        withBusyGuard(async () => {
          await deleteMember(id);
          closeModal('#member-detail-modal');
        })
      );
    });
    $('#member-detail-close-btn').addEventListener('click', () => closeModal('#member-detail-modal'));

    $('#add-member-btn').addEventListener('click', () => openMemberForm(null));
    $('#member-cancel-btn').addEventListener('click', () => closeModal('#member-modal'));

    $('#member-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const idRaw = $('#member-id').value;
      const id = idRaw ? Number(idRaw) : null;
      const courseRaw = $('#member-course').value;
      const payload = {
        name: $('#member-name').value.trim() || '名称未設定',
        course: courseRaw ? Number(courseRaw) : null,
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
      const time = $('#booking-time').value || null;
      if (!date) {
        closeModal('#booking-modal');
        return;
      }
      withBusyGuard(async () => {
        await addBooking(memberId, date, time);
        closeModal('#booking-modal');
      });
    });

    $('#done-cancel-btn').addEventListener('click', () => closeModal('#done-modal'));
    $('#done-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const memberId = Number($('#done-member-id').value);
      const date = $('#done-date').value;
      if (!date) {
        closeModal('#done-modal');
        return;
      }
      if (date > todayISO()) {
        alert('未来の日付は選べません。今日までの日付を指定してください。');
        return;
      }
      withBusyGuard(async () => {
        await addDoneOnDate(memberId, date);
        closeModal('#done-modal');
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
                    course: m.course || null,
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
      await autoCompletePastBookings();
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
