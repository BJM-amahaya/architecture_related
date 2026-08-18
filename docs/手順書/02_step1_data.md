# 工程1 実装手順書：認可付き Data／Storage

現場AI日報「GenbaLog」PoC / Amplify Gen2

> 対応工程: `proposal.md` §9「工程1：認可付き Data／Storage」
> 対応ゲート: `process.md` **A評価**（sandbox デプロイ成功 or ログイン／写真アップロードのいずれかが動く）

---

## 目的・前提（依存する工程）

**目的**：`Site`／`Report`／`Photo` の3モデルを **`allow.owner()`（本人のみ）** で定義し、写真は S3 の `media/{entity_id}/*` で本人分離する。`npx ampx sandbox` でバックエンドをデプロイし、「Cognito ログイン → 現場登録 → 写真アップロード（S3 保存）」までを動作確認する。

**依存関係**：
- **前工程（工程0：技術スパイク）** は Bedrock 疎通・同期/非同期の方式判定であり、**本工程（データ／ストレージ基盤）とは独立**して並行着手できる。工程1は AI 処理（工程2）の**前提基盤**となる。
- 本工程では **AI 処理（`generateReport`）は実装しない**（工程2 の担当）。ただしデータモデルには工程2/工程3 が使う「生成ドラフト・生成状態・写真 key リスト（`photoKeys`。**表示・整合性チェック用で認可の正本ではない**）」の**格納フィールドだけ**を先に用意する（冪等制御用テーブルは工程2 が CDK で別途作成）。

**共通仕様（厳守）**：
- Bedrock モデルID：`jp.anthropic.claude-haiku-4-5-20251001-v1:0`（日本 In-Region 推論プロファイル）／リージョン：`ap-northeast-1`（工程2で使用）
  - ⚠ 接頭辞なしの素のID `anthropic.claude-haiku-4-5-20251001-v1:0` は **on-demand 非対応**で `ValidationException: on-demand throughput isn't supported` になる（工程0で実測。正本は `genbalog-spike/RESULTS.md`）
- データモデル：`Site`／`Report`／`Photo`（全て `allow.owner()`）
- S3 パス：`media/{entity_id}/*`、冪等キー：`reportId + imageSetHash + inputHash + promptVersion + modelId + schemaVersion`（定義の正本は `00_overview.md` §3.4。実装は工程2）
- **guest/public アクセス・API key 認可は使わない。モデルへの `allow.authenticated()` も使わない**（全ログインユーザー許可となり得るため owner に限定。工程2 の custom query `generateReport` のみ `allow.authenticated("identityPool")` を使う）

---

## ステップ1：Amplify Gen2 プロジェクト作成

### 1-1. 前提ツール
- Node.js 18 以上、npm
- AWS アカウントと認証情報（`aws configure` 済み、または SSO プロファイル）
- **デフォルトリージョンを東京に設定**しておく（`~/.aws/config` の `region = ap-northeast-1`）。`ampx sandbox` はプロファイルのリージョンにデプロイするため。

### 1-2. スキャフォールド作成

```bash
# ターミナル（プロジェクトを置きたい親ディレクトリで実行）
npm create amplify@latest
# → プロジェクト名などを対話で入力。amplify/ ディレクトリ一式が生成される
```

生成される既定構成（Amplify Gen2 のパス規約）：

```text
amplify/
├── auth/resource.ts        # defineAuth（本手順ステップ2）
├── data/resource.ts        # defineData（本手順ステップ3）
├── backend.ts              # defineBackend（各リソースを束ねる）
└── package.json など
# storage/resource.ts は既定では未生成。ステップ4で新規作成する
```

> ⚠ 差異注記①：`npm create amplify@latest` の既定スキャフォールドには **`amplify/storage/resource.ts` は含まれない**（`auth` と `data` のみ）。工程1では storage を**新規に追加**する（ステップ4）。proposal §4 の表は storage を前提としているが、ファイルは手動追加が必要。

### 1-3. 依存パッケージ

`npm create amplify@latest` が依存を導入する。追加で `npm install` する場合は全社ルールに従い `--ignore-scripts` を付ける：

```bash
npm install --ignore-scripts
```

---

## ステップ2：`defineAuth`（メールログイン）

```typescript
// amplify/auth/resource.ts
import { defineAuth } from "@aws-amplify/backend";

/**
 * メールアドレス＋パスワードでのログインを設定。
 * 外部プロバイダ・電話番号ログインは PoC では使わない。
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
});
```

- `loginWith.email: true` により、Cognito User Pool と Identity Pool が生成される。
- Identity Pool の identity id が、Storage の `{entity_id}`（ステップ4）と Data の `owner`（ステップ3）の identity 単位に対応する。

---

## ステップ3：`defineData`（`Site`／`Report`／`Photo`）

**全モデルに `allow.owner()` を付与**し、`defaultAuthorizationMode` を `userPool`（Cognito ユーザートークン署名）にする。フィールドは proposal §3 の入力項目・生成ドラフト（安全は確認/未確認の2フィールドに分離）・生成状態・写真 key リスト（表示・整合性チェック用）を含める。

```typescript
// amplify/data/resource.ts
import { type ClientSchema, a, defineData } from "@aws-amplify/backend";

const schema = a.schema({
  // ── 現場マスタ ─────────────────────────────
  Site: a
    .model({
      name: a.string().required(),      // 現場名
      address: a.string(),              // 所在地（任意）
      reports: a.hasMany("Report", "siteId"),
      // owner を明示定義し、update を許可しないことで「owner 再割当」を禁止する
      //（Amplify 公式: owner 認可の既定では既存レコードの owner を別ユーザーへ
      //  再割当できるため、field-level authorization で塞ぐ）
      owner: a
        .string()
        .authorization((allow) => [allow.owner().to(["read", "delete"])]),
    })
    .authorization((allow) => [allow.owner()]),

  // ── 日報 ───────────────────────────────────
  Report: a
    .model({
      // 関連
      siteId: a.id(),
      site: a.belongsTo("Site", "siteId"),

      // 入力項目（proposal §3：現場・日付・工種・当日メモ・翌日予定）
      // ⚠ reportDate は required のため、Report.create 時点で値が必要。
      //   UI（工程3）は「日付＝当日を既定値」＋「Site 確定 → Report.create → 写真UI有効化」の
      //   順序とし、写真先行で create が失敗する経路を作らない（作成順と必須項目の整合）。
      //   さらに handler（工程2）でも日付の形式・許容範囲、memo/nextPlanInput の長さ上限を
      //   サーバー側で検証する（UI だけに依存しない）。
      reportDate: a.date().required(),  // 日付（UI は当日を既定値に設定）
      workType: a.string(),             // 工種
      memo: a.string(),                 // 当日メモ（作業実績の一次情報）
      nextPlanInput: a.string(),        // 翌日予定（入力・生成の主根拠）

      // 生成ドラフト保存先。確定保存は工程3のUIから update する
      // （proposal §3：作業内容/進捗/安全・懸念/翌日の予定。安全は工程4の
      //   機械集計のため「確認できた事項」と「画角外・未確認」を2フィールドに分離）
      draftWork: a.string(),             // 作業内容
      draftProgress: a.string(),         // 進捗
      draftSafetyConfirmed: a.string(),  // 安全・懸念（画像内で確認できた事項）
      draftSafetyUnconfirmed: a.string(),// 安全・懸念（画角外・未確認）
      draftTomorrow: a.string(),         // 翌日の予定

      // 生成状態：UI（工程3）が DRAFT / GENERATING / CONFIRMED を、
      // handler（工程2）が生成完了・失敗時に GENERATED / FAILED を更新する
      //（成功ドラフトと終端状態を handler が永続化し、リロード後の状態復元を可能にする）
      genStatus: a.enum([
        "DRAFT",       // 未生成（入力のみ）
        "GENERATING",  // 生成中（ボタン無効化）
        "GENERATED",   // 生成完了・未確定（handler が設定）
        "CONFIRMED",   // 確定保存済み
        "FAILED",      // 生成失敗（handler が設定）
      ]),

      // 写真 S3 key のリスト。工程3のアップロード確定時に保存する。
      // ⚠ 表示・整合性チェック用であり、認可の正本ではない（owner が更新できる
      //   フィールドのため信頼境界に置かない）。写真アクセス認可の正本は、工程2の
      //   generateReport が行う「S3 key の media/{呼び出し元identityId}/ プレフィックス検証」。
      photoKeys: a.string().array(),

      // 冪等制御（reportId + imageSetHash + inputHash + promptVersion + modelId + schemaVersion）は
      // Report には持たせず、工程2が CDK で作る専用 DynamoDB テーブル（lease 付き状態機械）で管理する。

      photos: a.hasMany("Photo", "reportId"),

      // owner 再割当禁止（Site と同じ field-level authorization）
      owner: a
        .string()
        .authorization((allow) => [allow.owner().to(["read", "delete"])]),
    })
    .authorization((allow) => [allow.owner()]),

  // ── 写真（S3 オブジェクトのメタデータ） ──────
  Photo: a
    .model({
      reportId: a.id(),
      report: a.belongsTo("Report", "reportId"),
      s3Key: a.string().required(),  // media/{entity_id}/... の S3 キー
      imageHash: a.string(),         // 参考メタデータ（任意）。冪等キーの正は工程2の Lambda が実バイトから算出する imageSetHash
      contentType: a.string(),       // MIME（サーバ側検証にも使用：工程2）
      sizeBytes: a.integer(),        // サイズ（枚数・サイズ制御用）

      // owner 再割当禁止（Site / Report と同じ field-level authorization）
      owner: a
        .string()
        .authorization((allow) => [allow.owner().to(["read", "delete"])]),
    })
    .authorization((allow) => [allow.owner()]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    // 全リクエストを Cognito ユーザートークンで署名（API key は使わない）
    defaultAuthorizationMode: "userPool",
  },
});
```

**設計ノート**：
- `allow.owner()` は各レコードに `owner` フィールド（作成者の identity claim）を自動付与し、**作成者本人のみ** create/read/update/delete 可能にする。
- **owner の再割当禁止**：Amplify 公式ドキュメントのとおり、owner 認可の既定では**既存レコードの owner を別ユーザーへ再割当できる**。本スキーマは owner フィールドを明示し `allow.owner().to(["read", "delete"])`（update を含めない）の field-level authorization で再割当を禁止する。工程2 の Lambda はこの不変性を前提に `Report.owner` を認可判定に使う。再割当が実際に拒否されることは工程5 TC-1 の否定テストで検証する（sandbox デプロイ時に実挙動も確認）。
- `defaultAuthorizationMode: "userPool"` により API key モードを無効化。`allow.publicApiKey()` / `allow.guest()` / モデルへの `allow.authenticated()` は**使用しない**（工程2 の custom query のみ identityPool 認可を使う）。
- S3 実体は Storage（ステップ4）が持ち、`Photo` は**メタデータ**（S3 キー・ハッシュ等）を保持する。`Photo.s3Key`／`Report.photoKeys` はクライアントが書けるため**認可の正本にしない**。工程2 の `generateReport` は「呼び出し元の `cognitoIdentityId` と S3 key のプレフィックス一致」＋「`Report.owner` の sub 照合」で IDOR を防止する。

> ⚠ 差異注記②：冪等キーは proposal §6 で「`reportId + imageSetHash + inputHash + promptVersion + modelId + schemaVersion`」と定義（`inputHash` はテキスト入力のサーバー側正規化ハッシュ。写真同一でもメモ・翌日予定を変更すれば新規生成される）。`reportId` は `Report` の `id`（自動採番）に相当する。冪等制御用のキーは `Report` モデルには保持せず、**工程2 が CDK で作る専用 DynamoDB テーブル `GenerationJobs`**（合成キー＋`leaseExpiresAt`/`attemptId`/`attemptCount` を持つ lease 付き状態機械）で管理する。合成・二重実行防止・再試行回復ロジックは工程2 で実装する。

---

## ステップ4：`defineStorage`（`media/{entity_id}/*` 本人のみ）

`amplify/storage/resource.ts` を**新規作成**する。

```typescript
// amplify/storage/resource.ts
import { defineStorage } from "@aws-amplify/backend";

/**
 * 現場写真ストレージ。
 * media/{entity_id}/* を、そのユーザー本人（identity）だけが read/write/delete できる。
 * {entity_id} は予約トークンで、アップロード時にユーザーの identity id に置換される。
 */
export const storage = defineStorage({
  name: "genbalogMedia",
  access: (allow) => ({
    "media/{entity_id}/*": [
      allow.entity("identity").to(["read", "write", "delete"]),
    ],
  }),
});
```

- `allow.entity('identity')`：identity id が一致する本人のみ許可。identity 単位でパスを分離するため、他ユーザーの `media/<別id>/*` にはアクセスできない。
- `to(['read','write','delete'])`：本人に読み書き削除を許可。guest/public エントリは**書かない**。

### 4-1. `backend.ts` へ登録

```typescript
// amplify/backend.ts
import { defineBackend } from "@aws-amplify/backend";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { storage } from "./storage/resource";

export const backend = defineBackend({
  auth,
  data,
  storage,
});
```

### 4-2. Block Public Access の確認方法

Amplify Gen2 の `defineStorage` が生成する S3 バケットは、**既定でパブリックアクセスをブロック**する（バケットポリシーによる公開はせず、Cognito/IAM 経由のみ許可）。デプロイ後に念のため確認する：

```bash
# デプロイ後、バケット名は amplify_outputs.json の storage.bucket_name で確認
aws s3api get-public-access-block \
  --bucket <生成された bucket 名> \
  --region ap-northeast-1
# 期待値：BlockPublicAcls / IgnorePublicAcls / BlockPublicPolicy / RestrictPublicBuckets が全て true
```

- S3 コンソール → 対象バケット →「アクセス許可」タブ →「ブロックパブリックアクセス」が全項目オンであることでも確認可（**A評価の証拠スクリーンショット**に使える）。

> ⚠ 差異注記③：`defineStorage` の既定パブリックアクセスブロックは Amplify のマネージド挙動。`get-public-access-block` の出力（全 true）を証拠として保存し、明示確認すること。

### 4-3. 初期コストガードレール（S3 Lifecycle・AWS Budgets）

proposal §5 のコスト試算は「写真30日保持・予算監視あり」が前提。**適用前は写真が無期限保持・予算通知なしとなり試算前提を満たさない**ため、sandbox 初回デプロイの時点（＝本工程）で設定する。工程6 では実測に基づき予算額・閾値を見直す。

```typescript
// amplify/backend.ts（4-1 の defineBackend の後に追記）
import { Duration } from "aws-cdk-lib";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";

// ── (1) S3 Lifecycle：写真30日expiration + 未完了 multipart abort（1日）──
//   proposal §6「S3 写真は Lifecycle で短期 expiration（例：30日）」に対応
const mediaBucket = backend.storage.resources.bucket;
mediaBucket.addLifecycleRule({
  id: "genbalog-photo-retention",
  enabled: true,
  prefix: "media/",                                      // 写真の格納パス（proposal §4）
  expiration: Duration.days(30),                         // 30日で自動削除
  abortIncompleteMultipartUploadAfter: Duration.days(1), // 未完了アップロードを1日でabort
});

// ── (2) AWS Budgets：月次$10予算 + ACTUAL 50/80/100% + FORECASTED 100% メール通知 ──
//   proposal §6「コスト監視」。反映は1日最大3回でリアルタイムではない点に注意
const costStack = backend.createStack("cost-guardrails");
const NOTIFY_EMAIL = "team@example.com"; // ← チームのメールに置換

new CfnBudget(costStack, "GenbaLogMonthlyBudget", {
  budget: {
    budgetName: "GenbaLog-monthly",
    budgetType: "COST",
    timeUnit: "MONTHLY",
    budgetLimit: { amount: 10, unit: "USD" },
  },
  notificationsWithSubscribers: [
    { type: "ACTUAL", th: 50 },
    { type: "ACTUAL", th: 80 },
    { type: "ACTUAL", th: 100 },
    { type: "FORECASTED", th: 100 },
  ].map((t) => ({
    notification: {
      notificationType: t.type,
      comparisonOperator: "GREATER_THAN",
      threshold: t.th,
      thresholdType: "PERCENTAGE",
    },
    subscribers: [{ subscriptionType: "EMAIL", address: NOTIFY_EMAIL }],
  })),
});
```

- コンソールで設定する場合：S3 → 対象バケット → Management → Lifecycle rules（prefix `media/`・30日 expiration・multipart abort 1日）／Billing → Budgets → Create budget（Monthly / $10 / 閾値 50・80・100%＋Forecasted 100%）。
- CloudWatch **Logs retention（7〜14日）は `generateReport` Lambda のロググループに対する設定のため工程2で行う**（`03_step2_ai.md` ステップ2）。
- 設定確認（Lifecycle が付いたこと・Budgets が作られたこと）のスクリーンショットを S評価の証拠として保存する（process.md §2「AWS Budgets 設定済み」）。

---

## ステップ5：`npx ampx sandbox` デプロイと動作確認

### 5-1. sandbox 起動（東京リージョン）

```bash
# プロファイルの region が ap-northeast-1 ならそのまま
npx ampx sandbox

# 明示的に東京へデプロイする場合（環境変数で指定）
AWS_REGION=ap-northeast-1 npx ampx sandbox
```

- `ampx sandbox` は AWS プロファイルのリージョンにデプロイする。CLI 専用のリージョンフラグは無く、**`AWS_REGION` 環境変数**で上書きする（AWS 公式 CLI commands ドキュメント準拠）。
- 起動するとファイル監視のホットスワップ状態になり、`amplify_outputs.json` が生成される。

### 5-2. CloudFormation デプロイ成功の確認

- ターミナルに各リソース（auth/data/storage）のデプロイ完了が表示され、`amplify_outputs.json` が更新されれば成功。
- コンソール確認：CloudFormation → sandbox のスタック（`amplify-<app>-<user>-sandbox-...`）が **CREATE_COMPLETE / UPDATE_COMPLETE**。

```bash
# CLI でスタック状態を確認する例
aws cloudformation describe-stacks \
  --region ap-northeast-1 \
  --query "Stacks[?contains(StackName, 'sandbox')].[StackName,StackStatus]" \
  --output table
```

**→ この時点で `process.md` A評価の到達条件「sandbox デプロイ成功（CloudFormation 成功）」を満たす。**

### 5-3. ログイン → 現場登録 → 写真アップロードの動作確認

最小の確認フロー（フロント統合は工程3 だが、A評価はどれか1つが動けば良い）。Amplify クライアント（`aws-amplify`）を使った確認スニペット例：

```typescript
// 確認用（例：一時的な Node スクリプト / Expo アプリ内のデバッグ画面。フロント統合は工程3）
// amplify_outputs.json を読み込んで Amplify.configure 済みであること
import { generateClient } from "aws-amplify/data";
import { uploadData } from "aws-amplify/storage";
import { getCurrentUser } from "aws-amplify/auth";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>();

// (1) Cognito ログイン後、本人確認
const user = await getCurrentUser();
console.log("[GenbaLog] signed in:", user.userId);

// (2) 現場登録（Site 作成）
const { data: site } = await client.models.Site.create({
  name: "デモ現場A",
  address: "東京都〇〇",
});
console.log("[GenbaLog] site:", site?.id);

// (3) 写真アップロード（media/{entity_id}/ 配下へ）
//     path のコールバックで {entity_id} を identityId に解決させる
const file = /* File オブジェクト */ null as unknown as File;
const result = await uploadData({
  path: ({ identityId }) => `media/${identityId}/${file.name}`,
  data: file,
  options: { contentType: file.type },
}).result;
console.log("[GenbaLog] uploaded key:", result.path);
```

- ログイン UI は Amplify UI の `Authenticator` を使うと最短（メール＋パスワード）。
- アップロード後、S3 保存を確認：

```bash
# 対象 identity 配下にオブジェクトがあるか
aws s3 ls "s3://<bucket 名>/media/" --recursive --region ap-northeast-1
```

- 他ユーザーの identity パスへアクセスできないこと（否定確認）は工程5 の異常系で本格検証するが、本工程でも別 identity パス指定が拒否されることを軽く確認しておくとよい。

---

## ステップ6：証拠の取り方（process.md A評価用）

`process.md` の A評価は「動作画面のスクリーンショット **または** CloudWatch ログ」を証拠とする。以下を取得・保存する：

1. **CloudFormation 成功のスクリーンショット**：sandbox スタックが `*_COMPLETE`。
2. **S3 バケットの Block Public Access がオンのスクリーンショット**（ステップ4-2）。
3. **ログイン成功画面**（Authenticator 認証後の画面）。
4. **現場登録の結果**：DynamoDB コンソールで `Site` テーブルに本人 `owner` 付きレコードが1件、または上記スニペットの `console.log` 出力。
5. **写真アップロードの S3 保存確認**：`aws s3 ls` の出力、または S3 コンソールで `media/<identityId>/` にオブジェクト表示。
6. **CloudWatch ログ**（任意）：AppSync のリクエストログ等。
   - ⚠ proposal §9 の「ログに記録する項目」に従い、**画像・プロンプト本文は残さない**方針は工程2 のログ設計で適用する。工程1では S3/DynamoDB の保存確認が主証拠。

---

## 完了条件チェックリスト（proposal §9 工程1 と1対1）

- [ ] `Site`／`Report`／`Photo` を **`allow.owner()`** で定義（guest/public・API key・モデルへの `allow.authenticated()` 不使用）
- [ ] **owner フィールドを明示定義し、field-level authorization（`to(["read","delete"])`）で owner 再割当を禁止**
- [ ] S3 を **`media/{entity_id}/*`** で本人分離（`allow.entity('identity').to(['read','write','delete'])`）
- [ ] **Block Public Access 有効**を `get-public-access-block`（全 true）で確認
- [ ] **S3 Lifecycle（`media/` 30日 expiration＋multipart abort 1日）を設定**（ステップ4-3）
- [ ] **AWS Budgets（月次予算＋ACTUAL 50/80/100%・FORECASTED 100% 通知）を設定**（ステップ4-3。S評価の必須条件）
- [ ] **`npx ampx sandbox` デプロイ成功（CloudFormation 成功）**
- [ ] **Cognito ログイン** が動く
- [ ] **現場登録**（`Site` レコード作成）ができる
- [ ] **写真アップロード（S3 保存確認）** ができる

## process.md ゲート対応（A評価に直結）

| process.md A評価 到達条件 | 本手順の該当ステップ | 証拠 |
|---|---|---|
| sandbox デプロイ成功（CloudFormation 成功） | ステップ5-2 | CFn スタック `*_COMPLETE` のスクショ |
| ログインが動く | ステップ5-3 (1) | ログイン成功画面 |
| 写真アップロード（S3保存）が動く | ステップ5-3 (3) | `aws s3 ls` 出力 / S3 コンソール |

> 上記のうち **いずれか1つ**でも証拠が揃えば A評価の到達条件を満たす（`process.md` §2）。本手順は複数を同時に満たす構成。

---

## 失敗時の代替（proposal §9 工程1「失敗時」準拠）

- **認可が意図通り効かない／デプロイエラー**：認可規則を **owner 明示**（`allow.owner()`）に修正し再デプロイ。`allow.authenticated()` や `allow.publicApiKey()` が混入していないか `data/resource.ts` を確認。`defaultAuthorizationMode: "userPool"` を再確認。
- **CloudFormation ロールバック**：sandbox のエラーログでリソース名を特定。命名衝突・IAM 不足が多い。`npx ampx sandbox delete` で作り直して再デプロイ。
- **写真アップロードが 403**：`media/{entity_id}/*` のパスとアップロード時 `path` の `identityId` 解決が一致しているか、ログイン済み（identity 発行済み）かを確認。
- **リージョンずれ**：`amplify_outputs.json` の `aws_region` が `ap-northeast-1` か確認。異なる場合は `AWS_REGION=ap-northeast-1 npx ampx sandbox` で再実行。

---

## 他工程への引き継ぎ事項

- 工程2（`generateReport`）は **identityPool（IAM）認可**で実装し、**IDOR 検証の正本は「呼び出し元 `cognitoIdentityId` と S3 key の `media/{identityId}/` プレフィックス一致」**とする。本工程の `Report.owner`（再割当禁止済み）は sub 照合に、`Report.photoKeys` は整合性チェック（多層防御）に使う。生成ドラフト（`draftWork`／`draftProgress`／`draftSafetyConfirmed`／`draftSafetyUnconfirmed`／`draftTomorrow`）は**成功時に handler が Report へ永続化**する。冪等制御は工程2 が CDK で作る専用 DynamoDB テーブル（`reportId + imageSetHash + inputHash + promptVersion + modelId + schemaVersion` をキーとする lease 付き状態機械）で管理する（Report には持たせない）。**生成入力（`reportDate` の形式・許容範囲、`memo`/`nextPlanInput` の長さ上限）は handler でもサーバー検証**する（UI 検証だけに依存しない）。
- `genStatus` の更新責任：**工程3（UI）が `DRAFT`／`GENERATING`／`CONFIRMED`、工程2（handler）が `GENERATED`／`FAILED`** を更新する。リロード・切断後は UI が `Report.genStatus`＋ドラフトを読み直して状態復元する（工程3・工程5 TC-6）。
- S3 Lifecycle・AWS Budgets は本工程で設定済み（ステップ4-3）。**CloudWatch Logs retention（7〜14日）は工程2**で `generateReport` のロググループに設定する。工程6 は実測に基づく見直し・有効性確認を行う。
- Bedrock（モデルID `jp.anthropic.claude-haiku-4-5-20251001-v1:0` / `ap-northeast-1`）の IAM 付与は工程2 の `backend.ts` CDK エスケープハッチで実施（本工程では行わない）。**推論プロファイルのため、IAM 許可は推論プロファイル ARN ＋ 東京・大阪の foundation-model ARN の両方が必要**（工程0の知見）。
