// BUG泡瀬店 セッション管理アプリ — LINE Messaging API Webhook 受信用 Edge Function
//
// 【重要】このファイルはコード（設計図）です。このリポジトリに置いてあるだけでは
// 動きません。Supabase CLIで実際にデプロイ（アップロード）して初めて有効になります。
// デプロイ手順はREADME、またはチャットでの説明を参照してください。
//
// このFunctionは以下だけを行います:
//   1) LINEから届いたWebhookの署名を検証する（なりすまし防止）
//   2) メッセージイベントを1件ずつ、line_users / line_messages テーブルへ保存する
//   3) 画像メッセージの場合は、LINEから画像データを取得して
//      Supabaseストレージ(meal-images バケット)に保存する
//   4) LINEへの自動返信は一切行わない（要件どおり、AI自動返信機能は実装しない）
//
// 必要な環境変数（Supabaseダッシュボード → Edge Functions → Secrets で設定）:
//   LINE_CHANNEL_SECRET       … LINE Developersコンソールで発行される値
//   LINE_CHANNEL_ACCESS_TOKEN … 同上
// 以下はSupabaseが自動的に用意してくれるため、手動設定は不要です:
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const LINE_CHANNEL_SECRET = Deno.env.get('LINE_CHANNEL_SECRET') ?? '';
const LINE_CHANNEL_ACCESS_TOKEN = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function verifySignature(rawBody: string, signatureHeader: string | null): Promise<boolean> {
  if (!signatureHeader || !LINE_CHANNEL_SECRET) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(LINE_CHANNEL_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const computed = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
  return computed === signatureHeader;
}

async function findOrCreateLineUser(lineUserId: string) {
  const { data: existing } = await supabase
    .from('line_users')
    .select('line_user_id, member_id')
    .eq('line_user_id', lineUserId)
    .maybeSingle();
  if (existing) return existing;

  const { data: created, error } = await supabase
    .from('line_users')
    .insert({ line_user_id: lineUserId })
    .select('line_user_id, member_id')
    .single();
  if (error) throw error;
  return created;
}

async function downloadAndStoreImage(messageId: string): Promise<string | null> {
  if (!LINE_CHANNEL_ACCESS_TOKEN) return null;
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) {
    console.error('LINE画像の取得に失敗しました', res.status, await res.text());
    return null;
  }
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const ext = contentType.includes('png') ? 'png' : 'jpg';
  const path = `line/${messageId}.${ext}`;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const { error } = await supabase.storage.from('meal-images').upload(path, bytes, {
    contentType,
    upsert: true,
  });
  if (error) {
    console.error('画像のアップロードに失敗しました', error);
    return null;
  }
  return path;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('OK', { status: 200 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get('x-line-signature');
  const valid = await verifySignature(rawBody, signature);
  if (!valid) {
    return new Response('invalid signature', { status: 401 });
  }

  let payload: { events?: any[] };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const events = payload.events || [];

  for (const event of events) {
    try {
      if (event.type !== 'message') continue;
      const lineUserId: string | undefined = event.source?.userId;
      if (!lineUserId) continue;

      const lineUser = await findOrCreateLineUser(lineUserId);
      const message = event.message;
      const sentAt = new Date(event.timestamp).toISOString();

      let messageType: 'text' | 'image' | null = null;
      let body: string | null = null;
      let imagePath: string | null = null;

      if (message.type === 'text') {
        messageType = 'text';
        body = message.text;
      } else if (message.type === 'image') {
        messageType = 'image';
        imagePath = await downloadAndStoreImage(message.id);
      } else {
        // スタンプ・動画・音声など、食事サポートで扱わない種類は保存しない
        continue;
      }

      await supabase.from('line_messages').insert({
        member_id: lineUser.member_id, // 未紐付けの場合は null のまま保存される
        line_user_id: lineUserId,
        sent_at: sentAt,
        sender: 'member',
        message_type: messageType,
        body,
        line_message_id: message.id,
        image_path: imagePath,
        is_confirmed: false,
      });
    } catch (err) {
      console.error('イベント処理中にエラーが発生しました', err);
      // 1件のエラーで他のイベント処理を止めない
    }
  }

  // LINEへは自動返信しない。受信確認の200のみ返す。
  return new Response('OK', { status: 200 });
});
