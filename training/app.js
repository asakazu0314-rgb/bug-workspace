(() => {
  'use strict';

  let sb = null; // Supabaseクライアント（training-config.js の設定が正しい場合のみ生成される）

  // ---------- helpers ----------
  const $ = (sel) => document.querySelector(sel);

  const pad2 = (n) => String(n).padStart(2, '0');
  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  function numOrNull(v) {
    return v === '' || v === null || v === undefined ? null : Number(v);
  }

  function valOrDash(v) {
    return v === null || v === undefined ? '-' : v;
  }

  // ---------- state ----------
  const state = {
    members: [],
    exercises: [],
    lastRecordDateByMember: {},
    memberSearch: '',
    memberSort: 'name', // 'name' | 'recent'
    currentMemberId: null,
    detailTab: 'body',
    bodyMetric: 'weight',
    bodyRecords: [],
    sessions: [],
    pairSessionDates: {}, // date -> [memberId,...]（ペア相手の同日セッション）
    pendingExerciseBlocks: {}, // sessionId -> [{exerciseId, exerciseName}]（まだ記録0件の種目ブロック）
    activeSession: null, // { memberIds, sessionIdByMember, date }（ペア同時記録中のセッション）
    sessionExerciseModalSessionId: null,
    bodyChart: null,
    exerciseChart: null,
    selectedExerciseIdForChart: null,
  };

  // ---------- data fetch ----------
  async function fetchMembers() {
    const { data, error } = await sb.from('members').select('*').order('name');
    if (error) { console.error(error); return; }
    state.members = data || [];
  }

  async function fetchExercises() {
    const { data, error } = await sb.from('exercises').select('*').order('name');
    if (error) { console.error(error); return; }
    state.exercises = data || [];
  }

  async function fetchLastRecordDates() {
    const map = {};
    const { data: br } = await sb.from('body_records').select('member_id,date');
    (br || []).forEach((r) => { if (!map[r.member_id] || r.date > map[r.member_id]) map[r.member_id] = r.date; });
    const { data: ts } = await sb.from('training_sessions').select('member_id,date');
    (ts || []).forEach((r) => { if (!map[r.member_id] || r.date > map[r.member_id]) map[r.member_id] = r.date; });
    state.lastRecordDateByMember = map;
  }

  async function fetchBodyRecords(memberId) {
    const { data, error } = await sb.from('body_records').select('*').eq('member_id', memberId).order('date', { ascending: true });
    if (error) { console.error(error); return; }
    state.bodyRecords = data || [];
  }

  async function fetchSessions(memberId) {
    const { data, error } = await sb
      .from('training_sessions')
      .select('*, training_records(*, exercises(id,name))')
      .eq('member_id', memberId)
      .order('date', { ascending: false });
    if (error) { console.error(error); return; }
    state.sessions = (data || []).sort((a, b) => b.date.localeCompare(a.date) || b.session_no - a.session_no);
  }

  async function fetchPairSessionDatesFor(member) {
    const pairs = pairMembersOf(member);
    if (pairs.length === 0) return {};
    const ids = pairs.map((p) => p.id);
    const { data } = await sb.from('training_sessions').select('member_id,date').in('member_id', ids);
    const map = {};
    (data || []).forEach((r) => { (map[r.date] = map[r.date] || []).push(r.member_id); });
    return map;
  }

  async function refreshPairSessionDates() {
    const m = state.members.find((x) => x.id === state.currentMemberId);
    state.pairSessionDates = m ? await fetchPairSessionDatesFor(m) : {};
  }

  // ---------- derived data ----------
  function pairMembersOf(member) {
    if (!member || !member.pair_group_id) return [];
    return state.members.filter((m) => m.pair_group_id === member.pair_group_id && m.id !== member.id);
  }

  function visibleMembers() {
    const q = state.memberSearch.trim().toLowerCase();
    let list = state.members.filter((m) => m.name.toLowerCase().includes(q));
    if (state.memberSort === 'name') {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    } else {
      list = [...list].sort((a, b) => {
        const da = state.lastRecordDateByMember[a.id] || '';
        const db = state.lastRecordDateByMember[b.id] || '';
        return db.localeCompare(da);
      });
    }
    return list;
  }

  function groupRecordsByExercise(records) {
    const byExercise = {};
    (records || []).forEach((r) => {
      const key = r.exercise_id;
      if (!byExercise[key]) {
        byExercise[key] = { exerciseId: key, exerciseName: r.exercises ? r.exercises.name : '(削除された種目)', sets: [] };
      }
      byExercise[key].sets.push(r);
    });
    Object.values(byExercise).forEach((b) => b.sets.sort((a, c) => a.set_no - c.set_no));
    return Object.values(byExercise);
  }

  function blocksForSession(s) {
    const real = groupRecordsByExercise(s.training_records);
    const implementedIds = new Set(real.map((b) => b.exerciseId));
    const pending = (state.pendingExerciseBlocks[s.id] || []).filter((p) => !implementedIds.has(p.exerciseId));
    return [...real, ...pending.map((p) => ({ exerciseId: p.exerciseId, exerciseName: p.exerciseName, sets: [] }))];
  }

  function sessionOtherMembersLabel(s) {
    const ids = (state.pairSessionDates && state.pairSessionDates[s.date]) || [];
    if (ids.length === 0) return '';
    const names = ids.map((id) => { const m = state.members.find((x) => x.id === id); return m ? m.name : null; }).filter(Boolean);
    return names.join('、');
  }

  function mirrorTargetsFor(sessionId) {
    if (state.activeSession && Object.values(state.activeSession.sessionIdByMember).includes(sessionId)) {
      return Object.values(state.activeSession.sessionIdByMember);
    }
    return [sessionId];
  }

  // ---------- screen / modal control ----------
  function showScreen(sel) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(sel).classList.add('active');
  }
  function openModal(sel) { $(sel).classList.remove('hidden'); }
  function closeModal(sel) { $(sel).classList.add('hidden'); }

  let confirmCallback = null;
  function openConfirm(message, cb) {
    $('#confirm-message').textContent = message;
    confirmCallback = cb;
    openModal('#confirm-modal');
  }

  function setActiveTab(tab) {
    state.detailTab = tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    $(`#tab-${tab}`).classList.add('active');
  }

  // ---------- rendering: members ----------
  function memberCardHtml(m) {
    const pairs = pairMembersOf(m);
    const last = state.lastRecordDateByMember[m.id];
    return `
    <div class="member-card" data-id="${m.id}">
      <div class="member-card-head">
        <div class="member-name">${escapeHtml(m.name)}</div>
      </div>
      <div class="member-meta">
        ${m.height ? `<div>身長: ${escapeHtml(String(m.height))}cm</div>` : ''}
        ${m.goal ? `<div>目標: ${escapeHtml(m.goal)}</div>` : ''}
        <div>直近の記録: ${last ? escapeHtml(last) : 'なし'}</div>
      </div>
      ${pairs.length ? `<div class="pair-badge">ペア: ${escapeHtml(pairs.map((p) => p.name).join('、'))}</div>` : ''}
    </div>`;
  }

  function renderMembers() {
    const list = visibleMembers();
    const el = $('#members-list');
    if (list.length === 0) {
      el.innerHTML = `<p class="empty-msg">会員が登録されていません。「＋ 会員を追加」から登録してください。</p>`;
      return;
    }
    el.innerHTML = list.map(memberCardHtml).join('');
  }

  // ---------- rendering: member detail ----------
  function renderMemberDetail() {
    const m = state.members.find((x) => x.id === state.currentMemberId);
    if (!m) return;
    $('#detail-member-name').textContent = m.name;
    const metaParts = [];
    if (m.height) metaParts.push(`身長 ${m.height}cm`);
    if (m.goal) metaParts.push(`目標: ${m.goal}`);
    $('#detail-member-meta').textContent = metaParts.join(' ・ ');
    const pairs = pairMembersOf(m);
    $('#detail-member-pair').textContent = pairs.length ? `ペア会員: ${pairs.map((p) => p.name).join('、')}` : '';
    renderBodyTab();
    renderTrainingTab();
  }

  function metricLabel(metric) {
    return { weight: '体重(kg)', body_fat: '体脂肪(%)', body_age: '体内年齢', muscle_mass: '筋肉量(kg)' }[metric];
  }

  function renderBodyTab() {
    if (!$('#body-date').value) $('#body-date').value = todayISO();
    renderBodyChart();
    renderBodyRecordsList();
  }

  function renderBodyChart() {
    const ctx = $('#body-chart');
    const metric = state.bodyMetric;
    const points = state.bodyRecords.filter((r) => r[metric] !== null && r[metric] !== undefined);
    if (state.bodyChart) { state.bodyChart.destroy(); state.bodyChart = null; }
    state.bodyChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: points.map((r) => r.date),
        datasets: [{
          label: metricLabel(metric),
          data: points.map((r) => r[metric]),
          borderColor: '#1f6feb',
          backgroundColor: 'rgba(31,111,235,0.15)',
          tension: 0.25,
          fill: true,
        }],
      },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: false } } },
    });
  }

  function renderBodyRecordsList() {
    const el = $('#body-records-list');
    if (state.bodyRecords.length === 0) {
      el.innerHTML = `<p class="empty-msg">記録がまだありません。</p>`;
      return;
    }
    const rows = [...state.bodyRecords].sort((a, b) => b.date.localeCompare(a.date));
    el.innerHTML = rows.map((r) => `
      <div class="record-row" data-id="${r.id}">
        <div class="record-main">
          <div class="record-date">${escapeHtml(r.date)}</div>
          <div>体重:${valOrDash(r.weight)} / 体脂肪:${valOrDash(r.body_fat)} / 体内年齢:${valOrDash(r.body_age)} / 筋肉量:${valOrDash(r.muscle_mass)}</div>
          ${r.note ? `<div class="record-note">${escapeHtml(r.note)}</div>` : ''}
        </div>
        <button class="btn-link danger" data-action="delete-body-record" data-id="${r.id}">削除</button>
      </div>`).join('');
  }

  function renderTrainingTab() {
    renderExerciseChartSelect();
    renderExerciseChart();
    renderSessionsList();
  }

  function renderExerciseChartSelect() {
    const sel = $('#exercise-chart-select');
    const usedIds = new Set();
    state.sessions.forEach((s) => (s.training_records || []).forEach((r) => usedIds.add(r.exercise_id)));
    const options = state.exercises.filter((ex) => usedIds.has(ex.id));
    const current = state.selectedExerciseIdForChart;
    sel.innerHTML = `<option value="">種目を選択</option>` + options.map((ex) => `<option value="${ex.id}">${escapeHtml(ex.name)}</option>`).join('');
    if (current && options.some((o) => o.id === current)) sel.value = current;
    else state.selectedExerciseIdForChart = null;
  }

  function renderExerciseChart() {
    const ctx = $('#exercise-chart');
    if (state.exerciseChart) { state.exerciseChart.destroy(); state.exerciseChart = null; }
    const exId = state.selectedExerciseIdForChart;
    if (!exId) return;
    const sorted = [...state.sessions].sort((a, b) => a.date.localeCompare(b.date) || a.session_no - b.session_no);
    const points = [];
    sorted.forEach((s) => {
      const recs = (s.training_records || []).filter((r) => r.exercise_id === exId);
      if (recs.length === 0) return;
      const top = recs.reduce((a, b) => ((b.weight || 0) > (a.weight || 0) ? b : a));
      points.push({ date: s.date, weight: top.weight, reps: top.reps });
    });
    state.exerciseChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: points.map((p) => p.date),
        datasets: [
          { label: '最大重量(kg)', data: points.map((p) => p.weight), borderColor: '#1f6feb', backgroundColor: 'rgba(31,111,235,0.15)', yAxisID: 'y', tension: 0.25 },
          { label: '回数', data: points.map((p) => p.reps), borderColor: '#1a8a4a', backgroundColor: 'rgba(26,138,74,0.15)', yAxisID: 'y1', tension: 0.25 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { type: 'linear', position: 'left', title: { display: true, text: '重量(kg)' } },
          y1: { type: 'linear', position: 'right', title: { display: true, text: '回数' }, grid: { drawOnChartArea: false } },
        },
      },
    });
  }

  function exerciseBlockHtml(sessionId, block) {
    return `
    <div class="session-exercise-block" data-exercise-id="${block.exerciseId}">
      <h5>${escapeHtml(block.exerciseName)}</h5>
      ${block.sets.map((set) => `
        <div class="set-row" data-record-id="${set.id}">
          <span class="set-no">${set.set_no}セット目</span>
          <span class="set-val">${valOrDash(set.weight)}kg × ${valOrDash(set.reps)}回</span>
          <button class="btn-link danger" data-action="delete-set" data-id="${set.id}">削除</button>
        </div>`).join('')}
      <div class="set-add-row">
        <input type="number" step="0.5" inputmode="decimal" placeholder="重量kg" class="set-weight-input">
        <input type="number" step="1" inputmode="numeric" placeholder="回数" class="set-reps-input">
        <button class="btn-secondary small" data-action="add-set" data-session-id="${sessionId}" data-exercise-id="${block.exerciseId}">セット追加</button>
      </div>
    </div>`;
  }

  function sessionCardHtml(s) {
    const blocks = blocksForSession(s);
    const others = sessionOtherMembersLabel(s);
    return `
    <div class="session-card" data-session-id="${s.id}">
      <div class="session-card-head">
        <h4>${escapeHtml(s.date)}（${s.session_no}回目）</h4>
        <button class="btn-link danger" data-action="delete-session" data-id="${s.id}">セッション削除</button>
      </div>
      ${others ? `<div class="session-members">同時記録: ${escapeHtml(others)}</div>` : ''}
      ${blocks.map((b) => exerciseBlockHtml(s.id, b)).join('')}
      <button class="btn-secondary small session-add-exercise-btn" data-action="add-exercise" data-session-id="${s.id}">＋ 種目を追加</button>
    </div>`;
  }

  function renderSessionsList() {
    const el = $('#sessions-list');
    if (state.sessions.length === 0) {
      el.innerHTML = `<p class="empty-msg">セッション記録がまだありません。</p>`;
      return;
    }
    el.innerHTML = state.sessions.map(sessionCardHtml).join('');
  }

  // ---------- rendering: exercises master ----------
  function renderExercisesList() {
    const el = $('#exercises-list');
    if (state.exercises.length === 0) {
      el.innerHTML = `<p class="empty-msg">種目が登録されていません。</p>`;
      return;
    }
    el.innerHTML = [...state.exercises].sort((a, b) => a.name.localeCompare(b.name, 'ja')).map((ex) => `
      <div class="exercise-row" data-id="${ex.id}">
        <span class="exercise-name-text">${escapeHtml(ex.name)}</span>
        <div>
          <button class="btn-link" data-action="rename-exercise" data-id="${ex.id}">名前変更</button>
          <button class="btn-link danger" data-action="delete-exercise" data-id="${ex.id}">削除</button>
        </div>
      </div>`).join('');
  }

  // ---------- actions: member detail navigation ----------
  async function openMemberDetail(id) {
    state.currentMemberId = id;
    state.pendingExerciseBlocks = {};
    state.activeSession = null;
    state.selectedExerciseIdForChart = null;
    $('#body-date').value = '';
    showScreen('#screen-member-detail');
    setActiveTab('body');
    const m = state.members.find((x) => x.id === id);
    await Promise.all([fetchBodyRecords(id), fetchSessions(id)]);
    state.pairSessionDates = await fetchPairSessionDatesFor(m);
    renderMemberDetail();
  }

  // ---------- actions: member CRUD ----------
  function openMemberForm(member) {
    const form = $('#member-form');
    form.reset();
    $('#member-form-title').textContent = member ? '会員を編集' : '会員を追加';
    $('#member-id').value = member ? member.id : '';
    $('#member-name').value = member ? member.name : '';
    $('#member-height').value = member && member.height != null ? member.height : '';
    $('#member-goal').value = member ? member.goal || '' : '';
    const box = $('#member-pair-checkboxes');
    const others = state.members.filter((m) => !member || m.id !== member.id);
    const currentPairIds = member ? pairMembersOf(member).map((p) => p.id) : [];
    if (others.length === 0) {
      box.innerHTML = `<p class="empty-msg" style="padding:4px 0;">他に会員がいません</p>`;
    } else {
      box.innerHTML = others.map((o) => `<label><input type="checkbox" value="${o.id}" ${currentPairIds.includes(o.id) ? 'checked' : ''}> ${escapeHtml(o.name)}</label>`).join('');
    }
    openModal('#member-modal');
  }

  async function updateMemberPairs(memberId, checkedIds) {
    const groupIds = new Set([memberId, ...checkedIds]);
    const self = state.members.find((m) => m.id === memberId);
    const oldGroupId = self ? self.pair_group_id : null;
    let groupId = null;
    for (const id of groupIds) {
      const m = state.members.find((x) => x.id === id);
      if (m && m.pair_group_id) { groupId = m.pair_group_id; break; }
    }
    if (groupIds.size <= 1) groupId = null;
    else if (!groupId) groupId = crypto.randomUUID();

    if (oldGroupId) {
      const leftBehind = state.members.filter((m) => m.pair_group_id === oldGroupId && !groupIds.has(m.id));
      for (const m of leftBehind) {
        await sb.from('members').update({ pair_group_id: null }).eq('id', m.id);
      }
    }
    for (const id of groupIds) {
      await sb.from('members').update({ pair_group_id: groupId }).eq('id', id);
    }
  }

  // ---------- actions: training session / records ----------
  function openSessionExerciseModal(sessionId) {
    state.sessionExerciseModalSessionId = sessionId;
    const sel = $('#session-exercise-select');
    sel.innerHTML = `<option value="">選択してください</option>` + [...state.exercises].sort((a, b) => a.name.localeCompare(b.name, 'ja')).map((ex) => `<option value="${ex.id}">${escapeHtml(ex.name)}</option>`).join('');
    $('#session-exercise-new-name').value = '';
    openModal('#session-exercise-modal');
  }

  async function addSetToSession(sessionId, exerciseId, weight, reps) {
    const targets = mirrorTargetsFor(sessionId);
    for (const sid of targets) {
      const { count } = await sb.from('training_records').select('id', { count: 'exact', head: true }).eq('session_id', sid).eq('exercise_id', exerciseId);
      const nextSetNo = (count || 0) + 1;
      const { error } = await sb.from('training_records').insert({ session_id: sid, exercise_id: exerciseId, set_no: nextSetNo, weight, reps });
      if (error) alert('保存に失敗しました: ' + error.message);
    }
    await fetchSessions(state.currentMemberId);
    renderTrainingTab();
  }

  // ---------- realtime sync ----------
  let refreshTimer = null;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      await fetchMembers();
      await fetchExercises();
      await fetchLastRecordDates();
      if ($('#screen-members').classList.contains('active')) renderMembers();
      if ($('#screen-exercises').classList.contains('active')) renderExercisesList();
      if ($('#screen-member-detail').classList.contains('active') && state.currentMemberId) {
        await fetchBodyRecords(state.currentMemberId);
        await fetchSessions(state.currentMemberId);
        await refreshPairSessionDates();
        renderMemberDetail();
      }
    }, 400);
  }

  function updateConnStatus(status) {
    const el = $('#conn-status');
    if (status === 'SUBSCRIBED') {
      el.textContent = '● 端末間リアルタイム同期 有効';
      el.className = 'conn-status ok';
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      el.textContent = '● 同期エラー（通信環境を確認してください）';
      el.className = 'conn-status error';
    }
  }

  function setupRealtime() {
    const channel = sb.channel('bug-training-sync');
    ['members', 'body_records', 'exercises', 'training_sessions', 'training_records'].forEach((table) => {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, scheduleRefresh);
    });
    channel.subscribe(updateConnStatus);
  }

  // ---------- event wiring ----------
  function wireEvents() {
    $('#member-search').addEventListener('input', (e) => { state.memberSearch = e.target.value; renderMembers(); });
    $('#sort-name-btn').addEventListener('click', () => { state.memberSort = 'name'; renderMembers(); });
    $('#sort-recent-btn').addEventListener('click', () => { state.memberSort = 'recent'; renderMembers(); });

    $('#members-list').addEventListener('click', (e) => {
      const card = e.target.closest('.member-card');
      if (!card) return;
      openMemberDetail(card.dataset.id);
    });

    $('#add-member-btn').addEventListener('click', () => openMemberForm(null));
    $('#member-cancel-btn').addEventListener('click', () => closeModal('#member-modal'));

    $('#member-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = $('#member-id').value;
      const payload = {
        name: $('#member-name').value.trim() || '名称未設定',
        height: numOrNull($('#member-height').value),
        goal: $('#member-goal').value.trim() || null,
      };
      const checkedIds = [...document.querySelectorAll('#member-pair-checkboxes input:checked')].map((i) => i.value);
      let memberId = id;
      if (id) {
        const { error } = await sb.from('members').update(payload).eq('id', id);
        if (error) { alert('保存に失敗しました: ' + error.message); return; }
      } else {
        const { data, error } = await sb.from('members').insert(payload).select().single();
        if (error) { alert('保存に失敗しました: ' + error.message); return; }
        memberId = data.id;
        state.members.push(data);
      }
      await updateMemberPairs(memberId, checkedIds);
      closeModal('#member-modal');
      await fetchMembers();
      await fetchLastRecordDates();
      renderMembers();
      if (state.currentMemberId === memberId) renderMemberDetail();
    });

    $('#back-to-members-btn').addEventListener('click', () => { showScreen('#screen-members'); renderMembers(); });

    $('#edit-member-btn').addEventListener('click', () => {
      const m = state.members.find((x) => x.id === state.currentMemberId);
      if (m) openMemberForm(m);
    });

    $('#delete-member-btn').addEventListener('click', () => {
      const m = state.members.find((x) => x.id === state.currentMemberId);
      if (!m) return;
      openConfirm(`「${m.name}」を削除します。身体データ・トレーニング記録もすべて削除されます。よろしいですか？`, async () => {
        const { error } = await sb.from('members').delete().eq('id', m.id);
        if (error) { alert('削除に失敗しました: ' + error.message); return; }
        await fetchMembers();
        await fetchLastRecordDates();
        showScreen('#screen-members');
        renderMembers();
      });
    });

    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
    });

    // 身体データ
    $('#body-metric-selector').addEventListener('click', (e) => {
      const btn = e.target.closest('.metric-btn');
      if (!btn) return;
      state.bodyMetric = btn.dataset.metric;
      document.querySelectorAll('#body-metric-selector .metric-btn').forEach((b) => b.classList.toggle('active', b === btn));
      renderBodyChart();
    });

    $('#body-record-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        member_id: state.currentMemberId,
        date: $('#body-date').value,
        weight: numOrNull($('#body-weight').value),
        body_fat: numOrNull($('#body-fat').value),
        body_age: numOrNull($('#body-age').value),
        muscle_mass: numOrNull($('#body-muscle').value),
        note: $('#body-note').value.trim() || null,
      };
      const { error } = await sb.from('body_records').insert(payload);
      if (error) { alert('保存に失敗しました: ' + error.message); return; }
      e.target.reset();
      $('#body-date').value = todayISO();
      await fetchBodyRecords(state.currentMemberId);
      await fetchLastRecordDates();
      renderBodyTab();
    });

    $('#body-records-list').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action="delete-body-record"]');
      if (!btn) return;
      openConfirm('この身体データを削除します。よろしいですか？', async () => {
        await sb.from('body_records').delete().eq('id', btn.dataset.id);
        await fetchBodyRecords(state.currentMemberId);
        await fetchLastRecordDates();
        renderBodyTab();
      });
    });

    // トレーニング
    $('#new-session-btn').addEventListener('click', () => {
      const m = state.members.find((x) => x.id === state.currentMemberId);
      $('#session-date').value = todayISO();
      const pairs = pairMembersOf(m);
      const field = $('#session-pair-field');
      const box = $('#session-pair-checkboxes');
      if (pairs.length) {
        field.classList.remove('hidden');
        box.innerHTML = pairs.map((p) => `<label><input type="checkbox" value="${p.id}"> ${escapeHtml(p.name)}</label>`).join('');
      } else {
        field.classList.add('hidden');
        box.innerHTML = '';
      }
      openModal('#session-modal');
    });

    $('#session-cancel-btn').addEventListener('click', () => closeModal('#session-modal'));

    $('#session-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const date = $('#session-date').value;
      const checkedIds = [...document.querySelectorAll('#session-pair-checkboxes input:checked')].map((i) => i.value);
      const memberIds = [state.currentMemberId, ...checkedIds];
      const sessionIdByMember = {};
      for (const mid of memberIds) {
        const { count } = await sb.from('training_sessions').select('id', { count: 'exact', head: true }).eq('member_id', mid);
        const sessionNo = (count || 0) + 1;
        const { data, error } = await sb.from('training_sessions').insert({ member_id: mid, date, session_no: sessionNo }).select().single();
        if (error) { alert('セッション作成に失敗しました: ' + error.message); return; }
        sessionIdByMember[mid] = data.id;
      }
      state.activeSession = { memberIds, sessionIdByMember, date };
      state.pendingExerciseBlocks = {};
      closeModal('#session-modal');
      await fetchSessions(state.currentMemberId);
      await fetchLastRecordDates();
      await refreshPairSessionDates();
      renderTrainingTab();
    });

    $('#sessions-list').addEventListener('click', async (e) => {
      const delSessionBtn = e.target.closest('button[data-action="delete-session"]');
      if (delSessionBtn) {
        openConfirm('このセッションを削除します。よろしいですか？', async () => {
          await sb.from('training_sessions').delete().eq('id', delSessionBtn.dataset.id);
          await fetchSessions(state.currentMemberId);
          await fetchLastRecordDates();
          renderTrainingTab();
        });
        return;
      }
      const addExBtn = e.target.closest('button[data-action="add-exercise"]');
      if (addExBtn) { openSessionExerciseModal(addExBtn.dataset.sessionId); return; }

      const addSetBtn = e.target.closest('button[data-action="add-set"]');
      if (addSetBtn) {
        const block = addSetBtn.closest('.session-exercise-block');
        const weight = numOrNull(block.querySelector('.set-weight-input').value);
        const reps = numOrNull(block.querySelector('.set-reps-input').value);
        if (weight === null && reps === null) return;
        await addSetToSession(addSetBtn.dataset.sessionId, addSetBtn.dataset.exerciseId, weight, reps);
        return;
      }

      const delSetBtn = e.target.closest('button[data-action="delete-set"]');
      if (delSetBtn) {
        await sb.from('training_records').delete().eq('id', delSetBtn.dataset.id);
        await fetchSessions(state.currentMemberId);
        renderTrainingTab();
      }
    });

    $('#exercise-chart-select').addEventListener('change', (e) => {
      state.selectedExerciseIdForChart = e.target.value || null;
      renderExerciseChart();
    });

    $('#session-exercise-cancel-btn').addEventListener('click', () => closeModal('#session-exercise-modal'));

    $('#session-exercise-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const sessionId = state.sessionExerciseModalSessionId;
      let exerciseId = $('#session-exercise-select').value;
      const newName = $('#session-exercise-new-name').value.trim();
      if (newName) {
        const existing = state.exercises.find((ex) => ex.name === newName);
        if (existing) {
          exerciseId = existing.id;
        } else {
          const { data, error } = await sb.from('exercises').insert({ name: newName }).select().single();
          if (error) { alert('種目の追加に失敗しました: ' + error.message); return; }
          state.exercises.push(data);
          exerciseId = data.id;
        }
      }
      if (!exerciseId) { alert('種目を選択するか、新しい種目名を入力してください。'); return; }
      const exercise = state.exercises.find((ex) => ex.id === exerciseId);
      const targets = mirrorTargetsFor(sessionId);
      targets.forEach((sid) => {
        if (!state.pendingExerciseBlocks[sid]) state.pendingExerciseBlocks[sid] = [];
        if (!state.pendingExerciseBlocks[sid].some((b) => b.exerciseId === exerciseId)) {
          state.pendingExerciseBlocks[sid].push({ exerciseId, exerciseName: exercise.name });
        }
      });
      closeModal('#session-exercise-modal');
      renderTrainingTab();
    });

    // 種目マスタ
    $('#open-exercises-btn').addEventListener('click', () => { showScreen('#screen-exercises'); renderExercisesList(); });
    $('#back-from-exercises-btn').addEventListener('click', () => { showScreen('#screen-members'); renderMembers(); });

    $('#exercise-add-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#new-exercise-name').value.trim();
      if (!name) return;
      const { data, error } = await sb.from('exercises').insert({ name }).select().single();
      if (error) {
        alert('追加に失敗しました: ' + (error.message.includes('duplicate') ? 'すでに同じ名前の種目があります' : error.message));
        return;
      }
      state.exercises.push(data);
      $('#new-exercise-name').value = '';
      renderExercisesList();
    });

    $('#exercises-list').addEventListener('click', async (e) => {
      const renameBtn = e.target.closest('button[data-action="rename-exercise"]');
      if (renameBtn) {
        const ex = state.exercises.find((x) => x.id === renameBtn.dataset.id);
        const newName = prompt('新しい種目名を入力してください', ex.name);
        if (!newName || !newName.trim() || newName.trim() === ex.name) return;
        const { error } = await sb.from('exercises').update({ name: newName.trim() }).eq('id', ex.id);
        if (error) { alert('変更に失敗しました: ' + error.message); return; }
        await fetchExercises();
        renderExercisesList();
        return;
      }
      const delBtn = e.target.closest('button[data-action="delete-exercise"]');
      if (delBtn) {
        const ex = state.exercises.find((x) => x.id === delBtn.dataset.id);
        openConfirm(`種目「${ex.name}」を削除します。この種目のトレーニング記録もすべて削除されます。よろしいですか？`, async () => {
          await sb.from('exercises').delete().eq('id', ex.id);
          await fetchExercises();
          renderExercisesList();
        });
      }
    });

    // 確認モーダル
    $('#confirm-cancel-btn').addEventListener('click', () => { confirmCallback = null; closeModal('#confirm-modal'); });
    $('#confirm-ok-btn').addEventListener('click', async () => {
      const cb = confirmCallback;
      confirmCallback = null;
      closeModal('#confirm-modal');
      if (cb) await cb();
    });
  }

  // ---------- boot ----------
  async function boot() {
    const cfg = window.BUG_TRAINING_CONFIG;
    const configured = cfg && cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes('YOUR-PROJECT')
      && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.includes('YOUR-ANON');
    if (!configured) {
      $('#setup-banner').classList.remove('hidden');
      $('#conn-status').textContent = '未設定';
      return;
    }
    if (!window.supabase || !window.supabase.createClient) {
      $('#conn-status').textContent = 'ライブラリの読み込みに失敗しました。通信環境を確認してください。';
      $('#conn-status').className = 'conn-status error';
      return;
    }
    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    $('#main-area').classList.remove('hidden');
    await fetchMembers();
    await fetchExercises();
    await fetchLastRecordDates();
    renderMembers();
    setupRealtime();
  }

  wireEvents();
  boot();
})();
