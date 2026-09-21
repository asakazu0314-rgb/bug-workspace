/**
 * BUG泡瀬店 Googleカレンダー同期スクリプト
 *
 * このアプリ（Supabase上の実施・予約記録）を、毎日自動でGoogleカレンダーの
 * 「いつものカレンダー（デフォルトカレンダー）」へ反映します。
 *
 * セットアップ手順は同じフォルダの README.md を参照してください。
 * このファイルは https://script.google.com （Google Apps Script）に
 * そのまま貼り付けて使います。
 */

var SYNC_WINDOW_PAST_DAYS = 14; // 過去何日分までさかのぼって同期するか
var SYNC_WINDOW_FUTURE_DAYS = 60; // 未来何日分まで同期するか
var EVENT_MARKER = '[BUG会員管理アプリ]'; // このスクリプトが作成したイベントの目印（説明欄に入れる）
var DEFAULT_SESSION_MINUTES = 60; // 時間未設定の予約はこの長さのイベントにする
var SYNC_HOURS = [6, 12, 15, 21, 0]; // 自動実行する時刻（24時間表記、複数指定可）

// ==== 設定の読み込み ====
// SUPABASE_URL / SUPABASE_ANON_KEY は
// 「プロジェクトの設定」→「スクリプト プロパティ」に設定してください。
function getConfig_() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('SUPABASE_URL');
  var key = props.getProperty('SUPABASE_ANON_KEY');
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY が未設定です。スクリプトのプロパティを確認してください。');
  }
  return { url: url, key: key };
}

// ==== 毎日自動実行するトリガーを作成する（最初に1回だけ実行。時刻を変えた時も再実行でOK） ====
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncCalendar') {
      ScriptApp.deleteTrigger(t);
    }
  });
  SYNC_HOURS.forEach(function (hour) {
    ScriptApp.newTrigger('syncCalendar').timeBased().everyDays(1).atHour(hour).create();
  });
  Logger.log('毎日 ' + SYNC_HOURS.join('時, ') + '時ごろに自動実行するトリガーを' + SYNC_HOURS.length + '件設定しました。');
}

// ==== 動作確認用: 今すぐ1回だけ実行する ====
function testRunNow() {
  syncCalendar();
  Logger.log('実行しました。Googleカレンダーを確認してください。');
}

// ==== アプリからのCSVアップロード時に、その場で同期するための入口 ====
// このプロジェクトを「ウェブアプリ」としてデプロイすると呼び出せるURLができます。
// アプリ側（supabase-config.js の calendarSyncUrl）からこのURLを呼ぶことで、
// 1日5回の自動実行を待たずに即座に反映されます。
function doGet(e) {
  try {
    syncCalendar();
    return ContentService.createTextOutput('OK');
  } catch (err) {
    return ContentService.createTextOutput('ERROR: ' + err.message);
  }
}

// ==== メインの同期処理 ====
function syncCalendar() {
  var calendar = CalendarApp.getDefaultCalendar();
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var start = new Date(today.getTime() - SYNC_WINDOW_PAST_DAYS * 86400000);
  var end = new Date(today.getTime() + (SYNC_WINDOW_FUTURE_DAYS + 1) * 86400000);

  var rows = supabaseGet_('session_logs', {
    select: '*,members(name)',
    session_date: ['gte.' + formatDate_(start), 'lte.' + formatDate_(end)],
    order: 'session_date.asc',
  });

  var activeEventIds = {};

  rows.forEach(function (row) {
    var member = row.members || {};
    var name = member.name || '(不明な会員)';
    var statusLabel = row.type === 'done' ? '実施済み' : '予約';
    var title = name + '（' + statusLabel + '）';
    var when = buildEventTime_(row.session_date, row.session_time);

    var event = null;
    if (row.calendar_event_id) {
      event = safeGetEventById_(calendar, row.calendar_event_id);
    }

    if (event && isAllDayEvent_(event) !== when.allDay) {
      // 終日/時間指定の切り替えが必要な場合は作り直す
      event.deleteEvent();
      event = null;
    }

    if (event) {
      // 内容が変わっていない予定にはカレンダーAPIを呼ばない（呼び出し回数を減らし、上限に達しにくくする）
      if (event.getTitle() !== title) event.setTitle(title);
      if (!when.allDay) {
        var curStart = event.getStartTime();
        var curEnd = event.getEndTime();
        if (curStart.getTime() !== when.start.getTime() || curEnd.getTime() !== when.end.getTime()) {
          event.setTime(when.start, when.end);
        }
      }
    } else {
      event = createEvent_(calendar, title, when);
      updateEventId_(row.id, event.getId());
      Utilities.sleep(200); // 新規作成が連続すると上限に達しやすいため、少し間隔をあける
    }
    activeEventIds[event.getId()] = true;
  });

  // 今回の対象から外れた（削除・状態変更された）過去の同期イベントを片付ける
  var existingEvents = calendar.getEvents(start, end);
  existingEvents.forEach(function (ev) {
    var desc = ev.getDescription() || '';
    if (desc.indexOf(EVENT_MARKER) === -1) return; // このスクリプト以外が作ったイベントには触れない
    if (!activeEventIds[ev.getId()]) {
      ev.deleteEvent();
      Utilities.sleep(200);
    }
  });

  Logger.log('同期完了: ' + rows.length + '件の記録を処理しました。');
}

function isAllDayEvent_(event) {
  try {
    return event.isAllDayEvent();
  } catch (e) {
    return false;
  }
}

function safeGetEventById_(calendar, eventId) {
  try {
    return calendar.getEventById(eventId);
  } catch (e) {
    return null;
  }
}

function buildEventTime_(dateStr, timeStr) {
  var dateParts = dateStr.split('-').map(Number);
  var y = dateParts[0], m = dateParts[1], d = dateParts[2];
  if (!timeStr) {
    return { allDay: true, date: new Date(y, m - 1, d) };
  }
  var timeParts = timeStr.split(':').map(Number);
  var start = new Date(y, m - 1, d, timeParts[0], timeParts[1] || 0);
  var end = new Date(start.getTime() + DEFAULT_SESSION_MINUTES * 60000);
  return { allDay: false, start: start, end: end };
}

function createEvent_(calendar, title, when) {
  var event;
  if (when.allDay) {
    event = calendar.createAllDayEvent(title, when.date);
  } else {
    event = calendar.createEvent(title, when.start, when.end);
  }
  event.setDescription(EVENT_MARKER);
  return event;
}

function updateEventId_(logId, eventId) {
  supabasePatch_('session_logs', { id: 'eq.' + logId }, { calendar_event_id: eventId });
}

function pad2_(n) {
  return n < 10 ? '0' + n : String(n);
}

function formatDate_(date) {
  return date.getFullYear() + '-' + pad2_(date.getMonth() + 1) + '-' + pad2_(date.getDate());
}

// ==== Supabase REST APIの薄いラッパー ====
// filters の値に配列を渡すと、同じ列名で複数条件（AND）として送る
function buildQuery_(filters) {
  var parts = [];
  Object.keys(filters).forEach(function (key) {
    var value = filters[key];
    var values = Array.isArray(value) ? value : [value];
    values.forEach(function (v) {
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(v));
    });
  });
  return parts.join('&');
}

function supabaseGet_(table, filters) {
  var cfg = getConfig_();
  var query = buildQuery_(filters);
  var url = cfg.url + '/rest/v1/' + table + (query ? '?' + query : '');
  var res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Supabaseからの取得に失敗しました（' + table + '）: ' + res.getContentText());
  }
  return JSON.parse(res.getContentText() || '[]');
}

function supabasePatch_(table, filters, row) {
  var cfg = getConfig_();
  var url = cfg.url + '/rest/v1/' + table + '?' + buildQuery_(filters);
  var res = UrlFetchApp.fetch(url, {
    method: 'patch',
    contentType: 'application/json',
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, Prefer: 'return=minimal' },
    payload: JSON.stringify(row),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Supabaseの更新に失敗しました（' + table + '）: ' + res.getContentText());
  }
}
