/**
 * BUG泡瀬店 Gyms連携スクリプト
 *
 * Gyms（system@gyms.jp）から届く「予約が入りました」「予約がキャンセルされました」
 * 「予約変更されました」メールを読み取り、このアプリのSupabaseへ自動で反映します。
 *
 * セットアップ手順は同じフォルダの README.md を参照してください。
 * このファイルは https://script.google.com （Google Apps Script）に
 * そのまま貼り付けて使います。
 */

var GYMS_SENDER = 'system@gyms.jp';
var PROCESSED_LABEL_NAME = 'Gyms同期済み';

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

// ==== 5分ごとの自動実行トリガーを作成する（最初に1回だけ実行） ====
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkGymsEmails') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('checkGymsEmails').timeBased().everyMinutes(5).create();
  Logger.log('5分ごとの自動実行トリガーを設定しました。');
}

// ==== 動作確認用: 今すぐ1回だけ実行する ====
function testRunNow() {
  checkGymsEmails();
  Logger.log('実行しました。この下のログと、アプリの「Gyms確認」タブを確認してください。');
}

// ==== メインの処理（トリガーから呼び出される） ====
function checkGymsEmails() {
  var label = getOrCreateLabel_(PROCESSED_LABEL_NAME);
  var threads = GmailApp.search('from:(' + GYMS_SENDER + ') -label:' + PROCESSED_LABEL_NAME, 0, 30);

  threads.forEach(function (thread) {
    var messages = thread.getMessages();
    var allProcessed = true;

    messages.forEach(function (message) {
      if (message.getFrom().indexOf(GYMS_SENDER) === -1) return;
      try {
        var handled = processMessage_(message);
        if (!handled) allProcessed = false;
      } catch (err) {
        Logger.log('メール処理でエラーが発生しました: ' + err);
        allProcessed = false;
      }
    });

    if (allProcessed) {
      thread.addLabel(label);
    }
  });
}

function processMessage_(message) {
  var messageId = message.getId();
  if (isAlreadyProcessed_(messageId)) return true;

  var text = message.getSubject() + '\n' + message.getPlainBody();
  var parsed = parseGymsEmail_(text);

  if (!parsed.relevant) {
    // 予約の追加・キャンセル・変更に関係しないGymsメールはそのままスキップ
    markProcessed_(messageId);
    return true;
  }

  if (parsed.parseFailed) {
    recordUnmatched_(parsed, 'parse_failed');
    markProcessed_(messageId);
    return true;
  }

  applyGymsEvent_(parsed);
  markProcessed_(messageId);
  return true;
}

// ==== メール本文の解析 ====
function parseGymsEmail_(text) {
  var eventType = null;
  if (text.indexOf('予約が入りました') !== -1) eventType = 'booking';
  else if (text.indexOf('予約がキャンセルされました') !== -1) eventType = 'cancel';
  else if (text.indexOf('予約変更されました') !== -1) eventType = 'change';
  if (!eventType) return { relevant: false };

  var subject = text.split('\n')[0];
  var customerId = matchFirst_(text, /顧客ID[：:]\s*(\S+)/);
  var customerNameRaw = matchFirst_(text, /顧客名[：:]\s*(.+)/);
  var customerName = normalizeCustomerName_(customerNameRaw);
  var startTime = matchDateTime_(text, /開始時間[：:]\s*(\d{4})年(\d{2})月(\d{2})日\s*(\d{2}):(\d{2})/);

  if (!customerName || !startTime) {
    return {
      relevant: true,
      parseFailed: true,
      eventType: eventType,
      subject: subject,
      customerName: customerName || '(不明)',
      customerId: customerId,
      date: null,
      time: null,
      oldDate: null,
      oldTime: null,
    };
  }

  var result = {
    relevant: true,
    parseFailed: false,
    eventType: eventType,
    subject: subject,
    customerId: customerId,
    customerName: customerName,
    date: startTime.date,
    time: startTime.time,
    oldDate: null,
    oldTime: null,
  };

  if (eventType === 'change') {
    var oldTime = matchDateTime_(text, /様の予約が\s*(\d{4})年(\d{2})月(\d{2})日\s*(\d{2}):(\d{2})から/);
    if (oldTime) {
      result.oldDate = oldTime.date;
      result.oldTime = oldTime.time;
    }
  }

  return result;
}

function matchFirst_(text, regex) {
  var m = text.match(regex);
  return m ? m[1].trim() : null;
}

function matchDateTime_(text, regex) {
  var m = text.match(regex);
  if (!m) return null;
  return { date: m[1] + '-' + m[2] + '-' + m[3], time: m[4] + ':' + m[5] + ':00' };
}

// 「様」「さま」などの敬称を末尾から取り除く
function normalizeCustomerName_(name) {
  if (!name) return '';
  return name.replace(/(さま|様)\s*$/, '').trim();
}

// 会員名の比較用（全角・半角スペースの違いを吸収する）
function normalizeForMatch_(name) {
  return (name || '').replace(/[\s　]/g, '');
}

// ==== Supabaseへの反映 ====
function applyGymsEvent_(parsed) {
  var member = findMember_(parsed);

  if (!member) {
    recordUnmatched_(parsed, 'no_matching_member');
    return;
  }

  // 顧客IDをまだ紐付けていなければ記録しておく（次回以降、名前が変わっても確実に照合できるようにする）
  if (parsed.customerId && member.gyms_customer_id !== parsed.customerId) {
    updateMemberGymsId_(member.id, parsed.customerId);
  }

  if (parsed.eventType === 'booking') {
    insertBooking_(member.id, parsed.date, parsed.time);
  } else if (parsed.eventType === 'cancel') {
    var removed = deleteBooking_(member.id, parsed.date, parsed.time);
    if (!removed) recordUnmatched_(parsed, 'booking_not_found');
  } else if (parsed.eventType === 'change') {
    var removedOld = parsed.oldDate ? deleteBooking_(member.id, parsed.oldDate, parsed.oldTime) : true;
    insertBooking_(member.id, parsed.date, parsed.time);
    if (!removedOld) recordUnmatched_(parsed, 'booking_not_found');
  }
}

function findMember_(parsed) {
  if (parsed.customerId) {
    var byId = supabaseGet_('members', { gyms_customer_id: 'eq.' + parsed.customerId });
    if (byId.length > 0) return byId[0];
  }
  var all = supabaseGet_('members', {});
  var target = normalizeForMatch_(parsed.customerName);
  for (var i = 0; i < all.length; i++) {
    if (normalizeForMatch_(all[i].name) === target) return all[i];
  }
  return null;
}

function updateMemberGymsId_(memberId, gymsCustomerId) {
  supabasePatch_('members', { id: 'eq.' + memberId }, { gyms_customer_id: gymsCustomerId });
}

function insertBooking_(memberId, date, time) {
  supabasePost_('session_logs', {
    member_id: memberId,
    session_date: date,
    type: 'booked',
    session_time: time,
  });
}

// 該当する予約(booked)を1件削除する。見つからなければ false を返す。
function deleteBooking_(memberId, date, time) {
  var existing = supabaseGet_('session_logs', {
    member_id: 'eq.' + memberId,
    session_date: 'eq.' + date,
    session_time: 'eq.' + time,
    type: 'eq.booked',
  });
  if (existing.length === 0) return false;
  supabaseDelete_('session_logs', { id: 'eq.' + existing[0].id });
  return true;
}

function recordUnmatched_(parsed, reason) {
  supabasePost_('gyms_unmatched_events', {
    event_type: parsed.eventType,
    reason: reason,
    customer_name: parsed.customerName,
    gyms_customer_id: parsed.customerId,
    scheduled_date: parsed.date,
    scheduled_time: parsed.time,
    old_scheduled_date: parsed.oldDate,
    old_scheduled_time: parsed.oldTime,
    raw_subject: parsed.subject,
  });
}

// ==== 処理済みメールの記録（同じメールの二重反映を防ぐ） ====
function isAlreadyProcessed_(messageId) {
  var rows = supabaseGet_('gyms_processed_messages', { gmail_message_id: 'eq.' + messageId });
  return rows.length > 0;
}

function markProcessed_(messageId) {
  supabasePost_('gyms_processed_messages', { gmail_message_id: messageId });
}

// ==== Gmailラベルの取得/作成 ====
function getOrCreateLabel_(name) {
  var label = GmailApp.getUserLabelByName(name);
  if (!label) label = GmailApp.createLabel(name);
  return label;
}

// ==== Supabase REST APIの薄いラッパー ====
function buildQuery_(filters) {
  return Object.keys(filters)
    .map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(filters[k]);
    })
    .join('&');
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

function supabasePost_(table, row) {
  var cfg = getConfig_();
  var res = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + table, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, Prefer: 'return=minimal' },
    payload: JSON.stringify(row),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Supabaseへの保存に失敗しました（' + table + '）: ' + res.getContentText());
  }
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

function supabaseDelete_(table, filters) {
  var cfg = getConfig_();
  var url = cfg.url + '/rest/v1/' + table + '?' + buildQuery_(filters);
  var res = UrlFetchApp.fetch(url, {
    method: 'delete',
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, Prefer: 'return=minimal' },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Supabaseの削除に失敗しました（' + table + '）: ' + res.getContentText());
  }
}
