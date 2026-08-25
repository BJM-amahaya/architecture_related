// genbalog/amplify/data/resource.ts（★ Todo テンプレを全面置き換え）
import { type ClientSchema, a, defineData } from '@aws-amplify/backend';

const schema = a.schema({
  // ── 現場マスタ ─────────────────────────────
  Site: a
    .model({
      name: a.string().required(),      // 現場名
      address: a.string(),              // 所在地（任意）
      reports: a.hasMany('Report', 'siteId'),
      // ★ owner を明示定義し update を許可しないことで「owner 再割当」を禁止する。
      //   Amplify の owner 認可は既定では既存レコードの owner を別ユーザーへ再割当できるため、
      //   field-level authorization で塞ぐ。
      owner: a
        .string()
        .authorization((allow) => [allow.owner().to(['read', 'delete'])]),
    })
    .authorization((allow) => [allow.owner()]),

  // ── 日報 ───────────────────────────────────
  Report: a
    .model({
      // 関連
      siteId: a.id(),
      site: a.belongsTo('Site', 'siteId'),

      // 入力項目（proposal §3：現場・日付・工種・当日メモ・翌日予定）
      // ⚠ reportDate は required のため Report.create 時点で値が必要。
      //   UI（02）は「日付＝当日を既定値」＋「Site 確定 → Report.create → 写真UI有効化」の
      //   順序とし、写真先行で create が失敗する経路を作らない。
      reportDate: a.date().required(),  // 日付（UI は当日を既定値に設定）
      workType: a.string(),             // 工種
      memo: a.string(),                 // 当日メモ（作業実績の一次情報）
      nextPlanInput: a.string(),        // 翌日予定（入力・生成の主根拠）

      // 生成ドラフト保存先。確定保存は 02/03 の UI から update する。
      // 安全は工程4 の機械集計のため「確認できた事項」と「画角外・未確認」を2フィールドに分離
      draftWork: a.string(),              // 作業内容
      draftProgress: a.string(),          // 進捗
      draftSafetyConfirmed: a.string(),   // 安全・懸念（画像内で確認できた事項）
      draftSafetyUnconfirmed: a.string(), // 安全・懸念（画角外・未確認）
      draftTomorrow: a.string(),          // 翌日の予定

      // 生成状態：UI（工程3）が DRAFT / GENERATING / CONFIRMED を、
      // handler（工程2）が GENERATED / FAILED を更新する（0-9）
      genStatus: a.enum([
        'DRAFT',       // 未生成（入力のみ）
        'GENERATING',  // 生成中（ボタン無効化）
        'GENERATED',   // 生成完了・未確定（handler が設定）
        'CONFIRMED',   // 確定保存済み
        'FAILED',      // 生成失敗（handler が設定）
      ]),

      // 写真 S3 key のリスト。02 のアップロード確定時に保存する。
      // ⚠ 表示・整合性チェック用であり、認可の正本ではない。
      photoKeys: a.string().array(),

      // 冪等制御（reportId + imageSetHash + inputHash + promptVersion + modelId + schemaVersion）は
      // Report には持たせず、工程2 が CDK で作る専用 DynamoDB テーブルで管理する。

      photos: a.hasMany('Photo', 'reportId'),

      // owner 再割当禁止（Site と同じ field-level authorization）
      owner: a
        .string()
        .authorization((allow) => [allow.owner().to(['read', 'delete'])]),
    })
    .authorization((allow) => [allow.owner()]),

  // ── 写真（S3 オブジェクトのメタデータ） ──────
  Photo: a
    .model({
      reportId: a.id(),
      report: a.belongsTo('Report', 'reportId'),
      s3Key: a.string().required(),  // media/{entity_id}/... の S3 キー
      imageHash: a.string(),         // 参考メタデータ（冪等キーの正は工程2 が実バイトから算出）
      contentType: a.string(),       // MIME（工程2 のサーバ側検証にも使用）
      sizeBytes: a.integer(),        // サイズ（枚数・サイズ制御用）

      // owner 再割当禁止（Site / Report と同じ）
      owner: a
        .string()
        .authorization((allow) => [allow.owner().to(['read', 'delete'])]),
    })
    .authorization((allow) => [allow.owner()]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    // 全リクエストを Cognito ユーザートークンで署名（API key は使わない）
    defaultAuthorizationMode: 'userPool',
  },
});