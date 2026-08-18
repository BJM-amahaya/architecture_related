# 工程2 実装手順書：AI処理 `generateReport`

対象アプリ：現場AI日報「GenbaLog」（`spec/plan7/proposal.md` §9 工程2）
評価対応：`process.md` の **A評価**（AI生成が単体で動く）→ **A+評価**（一気通貫）

---

## 目的・前提

**目的**：現場写真＋最小テキスト入力を Amazon Bedrock（Claude Haiku 4.5）に渡し、日報4項目（作業／進捗／安全／翌日）の**構造化ドラフト**を返す custom query `generateReport` を実装する。

**依存する工程**：
- **工程0（技術スパイク）の同期／非同期判定結果**：本手順書は**同期方式（custom query 直呼び）を主線**とする。工程0の判定基準は **「初回コンパイルの実測最大値 < 25秒、またはウォームアップで初回を利用者経路から確実に除外できること（かつ定常 P95 に十分な余裕）→ 同期継続、満たせなければ非同期化」**（`01_step0_spike.md` ステップ7）。非同期化の場合は本手順書ではなく **`03b_step2_async.md`** に従う（末尾 §6）。
- **工程1（認可付き Data／Storage のデプロイ）**：`Site`/`Report`/`Photo`（`allow.owner()`）と S3 `media/{entity_id}/*`、Block Public Access が有効化済みであること。本手順は工程1の `amplify/data/resource.ts`・`amplify/storage/resource.ts`・`amplify/backend.ts` に**追記**する形で進める。

**共通仕様（厳守）**：
- Bedrock モデルID：`anthropic.claude-haiku-4-5-20251001-v1:0`
- リージョン：`ap-northeast-1`（東京 In-Region 直接呼び出し。クロスリージョン推論プロファイルは使わない）
- 使用 API：**Bedrock Converse API**（`@aws-sdk/client-bedrock-runtime` の `ConverseCommand`）。Structured Outputs は Converse / InvokeModel でのみ利用可（Anthropic Messages 互換経路では不可）。本手順は Converse に固定する。
- `maxTokens`：500

**インターフェース確定（この手順書の定義が正）**：
> `generateReport` の引数・戻り値名は**本手順書の定義を最終仕様（正）**とする。工程3（UI, `04_step3_ui.md`）・工程4（品質評価）はこの定義に合わせること。UI 側の想定（引数 `reportId` ＋ `photoKeys`、戻り値 `work`/`progress`/`safety`/`tomorrow`）と一致済み。安全項目は工程4の集計都合により `safety.confirmed`／`safety.unconfirmed` の**ネスト構造**で確定する（後述）。

---

## ステップ1：`defineFunction` と custom query `generateReport` の定義

### 1-1. 関数定義とスキーマ追加（`amplify/data/resource.ts`）

工程1の `Site`/`Report`/`Photo` 定義に、以下の `generateReportFunction` と custom query `generateReport` を**追記**する。

```ts
// amplify/data/resource.ts
import {
  type ClientSchema,
  a,
  defineData,
  defineFunction,
} from "@aws-amplify/backend";

// ── Bedrock / プロンプト定数（backend.ts からも import する）─────────────
export const MODEL_ID = "anthropic.claude-haiku-4-5-20251001-v1:0";
export const BEDROCK_REGION = "ap-northeast-1";
// プロンプトを変更したら必ずインクリメントする（冪等キーの一部・ステップ4のウォームアップ対象）
export const PROMPT_VERSION = "v1";
// JSON Schema（REPORT_JSON_SCHEMA）の構造を変更したら必ずインクリメントする（冪等キーの一部。
// スキーマ変更＝別コンパイル・別出力形式のため、旧結果を再利用しない）
export const SCHEMA_VERSION = "v1";

// ── generateReport 関数 ─────────────────────────────────────────────
export const generateReportFunction = defineFunction({
  name: "generate-report",
  entry: "./functions/generate-report/handler.ts", // 実体は amplify/functions/generate-report/handler.ts
  timeoutSeconds: 29, // AppSync 30秒上限より短いハードタイムアウト（最後の砦）。
  // ⚠ ハードタイムアウト到達時は実行環境がリセットされ、JavaScript の catch による
  //   FAILED 保存は「保証されない」。そのため handler はハードタイムアウトに頼らず、
  //   context.getRemainingTimeInMillis() ベースの deadline（AbortSignal）＋後処理バッファで
  //   Bedrock 呼び出しを自前で打ち切る（ステップ3 (E)）。それでも異常終了した場合は
  //   GenerationJobs の lease 失効（ステップ3 (D)）により後続の再試行で回復する。
  memoryMB: 1024, // proposal §5 の前提（約10〜20秒 × 1024MB）
  environment: {
    MODEL_ID,
    BEDROCK_REGION,
    PROMPT_VERSION,
    SCHEMA_VERSION,
    // MEDIA_BUCKET_NAME / JOB_TABLE_NAME / REPORT_TABLE_NAME は backend.ts で addEnvironment する（循環参照回避）
  },
});

const schema = a.schema({
  // ── 工程1で定義済み（再掲・抜粋。フィールドの正本は 02_step1_data.md）──────
  Site: a
    .model({
      name: a.string().required(),
      reports: a.hasMany("Report", "siteId"),
    })
    .authorization((allow) => [allow.owner()]),

  Report: a
    .model({
      siteId: a.id(),
      site: a.belongsTo("Site", "siteId"),
      reportDate: a.date(),
      workType: a.string(),
      memo: a.string(), // 当日メモ（作業内容の主根拠）
      nextPlanInput: a.string(), // 翌日予定入力（翌日予定の主根拠）
      // 写真キーのリスト（工程3のアップロード時に保存）。表示・整合性チェック用で
      // 認可の正本ではない（正本は handler の identityId プレフィックス検証・ステップ3-B）。
      photoKeys: a.string().array(),
      // 生成ドラフト保存先。生成成功時に handler が保存し、確定保存は工程3のUIから update する
      draftWork: a.string(),
      draftProgress: a.string(),
      draftSafetyConfirmed: a.string(),
      draftSafetyUnconfirmed: a.string(),
      draftTomorrow: a.string(),
      // 生成状態。UI(工程3) が DRAFT/GENERATING/CONFIRMED を、handler が生成完了・失敗時に
      // GENERATED/FAILED を更新する（リロード後の状態復元のため。冪等制御は専用テーブル）。
      genStatus: a.enum(["DRAFT", "GENERATING", "GENERATED", "CONFIRMED", "FAILED"]),
      photos: a.hasMany("Photo", "reportId"),
      // owner 再割当禁止の field-level authorization（正本は 02_step1_data.md）
      owner: a
        .string()
        .authorization((allow) => [allow.owner().to(["read", "delete"])]),
    })
    .authorization((allow) => [allow.owner()]),

  Photo: a
    .model({
      reportId: a.id(),
      report: a.belongsTo("Report", "reportId"),
      s3Key: a.string().required(), // media/{entity_id}/... （Amplify Storage が採番）
      contentType: a.string(),
      sizeBytes: a.integer(),
    })
    .authorization((allow) => [allow.owner()]),

  // ── 工程2で追加する戻り値の型 ───────────────────────────────
  // 安全項目は confirmed / unconfirmed を構造分離（工程4が事実誤認率を機械集計しやすくするため）
  ReportSafety: a.customType({
    confirmed: a.string(), // 画像内で確認できた事項
    unconfirmed: a.string(), // 画角外・未確認（「問題なし」は入れない）
  }),
  ReportDraft: a.customType({
    work: a.string(), // 作業内容
    progress: a.string(), // 進捗
    safety: a.ref("ReportSafety"), // 安全（confirmed/unconfirmed のネスト）
    tomorrow: a.string(), // 翌日予定
    status: a.string(), // "ok" | "needs_review" | "unknown"（要確認/不明の全体フラグ）
    idempotent: a.boolean(), // 冪等抑止で既存結果を返した場合 true
  }),

  // ── custom query 本体 ─────────────────────────────────────
  generateReport: a
    .query()
    // 引数：reportId ＋ photoKeys（S3 key 配列）。工程3(UI)の呼び出しに整合。
    // imageSetHash / inputHash はクライアントから受け取らず Lambda 側で算出する（改ざん防止）。
    // photoKeys は「そのまま信用せず」handler が identityId プレフィックスで検証する（IDOR対策・ステップ3-B）。
    .arguments({
      reportId: a.string().required(),
      photoKeys: a.string().array().required(),
    })
    .returns(a.ref("ReportDraft"))
    // ⚠ 認可注記：custom query には allow.owner() を付けられない（owner フィールドが無いため）。
    //   ここでは identityPool（IAM）認可を使う。理由：
    //   - S3 の本人分離は media/{entity_id}/*（entity_id = Identity Pool の identityId）だが、
    //     userPool 認可の event.identity には identityId が入らず sub しか取れない。
    //   - identityPool（IAM）認可なら event.identity（AppSyncIdentityIAM）に
    //     cognitoIdentityId が入り、Lambda が「渡された key が呼び出し元本人の
    //     media/{identityId}/ 配下か」をサーバー側で検証できる（IDOR 対策の正本）。
    //   - Report 所有者の sub は cognitoIdentityAuthProvider（"...:CognitoSignIn:<sub>"）から抽出する。
    //   クライアントは authMode: 'identityPool' で呼び出す（工程3参照）。
    //   認証済みユーザー（identity pool の authenticated role）のみ許可し、guest は不許可。
    .authorization((allow) => [allow.authenticated("identityPool")])
    .handler(a.handler.function(generateReportFunction)),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    // 工程1どおり userPool を既定にする（モデルの allow.owner() が有効になる）。
    // generateReport は operation 単位で identityPool(IAM) 認可を指定しており、
    // クライアントは authMode: 'identityPool' で呼び分ける（工程3）
    defaultAuthorizationMode: "userPool",
  },
});
```

> **⚠ 差異注記（proposal §4「custom query」と Amplify 公式サンプルの差異）**：AWS 公式「Connect to Amazon Bedrock」サンプルは `allow.publicApiKey()`＋Anthropic Messages 形式の `InvokeModel` を使う。本PoC は (1) 認可を `allow.authenticated("identityPool")`（IAM。Lambda が `cognitoIdentityId` を取得して S3 key のプレフィックス検証を行うため）に、(2) API を Structured Outputs 対応の **Converse** に変更している。これは proposal §4（guest/public・API key を使わない）と §6（IDOR 対策・Structured Outputs は Converse/InvokeModel 限定）に従った意図的な差異。custom query での `allow.authenticated('identityPool')` の受理と IAM identity の内容（`cognitoIdentityId`／`cognitoIdentityAuthProvider`）は、**工程0または本工程のデプロイ時に実挙動を確認**すること（AppSync resolver context reference で仕様確認済み）。

---

## ステップ2：`backend.ts` の CDK 拡張（IAM／S3 read／冪等テーブル／環境変数）

工程1の `backend.ts` に、Bedrock 権限・S3 read・冪等制御用 DynamoDB テーブルを**追記**する。

```ts
// amplify/backend.ts
import { defineBackend } from "@aws-amplify/backend";
import { auth } from "./auth/resource";
import {
  data,
  MODEL_ID,
  BEDROCK_REGION,
  generateReportFunction,
} from "./data/resource";
import { storage } from "./storage/resource";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import {
  AttributeType,
  BillingMode,
  Table,
  TableEncryption,
} from "aws-cdk-lib/aws-dynamodb";
import { RemovalPolicy } from "aws-cdk-lib";

export const backend = defineBackend({
  auth,
  data,
  storage,
  generateReportFunction,
});

const lambda = backend.generateReportFunction.resources.lambda;

// ── (1) Bedrock InvokeModel（東京 In-Region の foundation-model ARN に限定）───
//   ⚠ 認可アクション対応表（工程0裏取り）：
//     - Converse            → bedrock:InvokeModel                       ← 本手順はこれのみ
//     - ConverseStream      → bedrock:InvokeModelWithResponseStream     （ストリーミング採用時に追加）
//     - CountTokens         → bedrock:CountTokens                        （工程6の実測時に追加）
//   ARN はリージョン固定（ap-northeast-1）。クロスリージョン推論プロファイルは付与しない。
lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["bedrock:InvokeModel"],
    resources: [
      `arn:aws:bedrock:${BEDROCK_REGION}::foundation-model/${MODEL_ID}`,
    ],
  })
);

// ── (2) 対象 S3 バケットの read 付与（media/* に限定）─────────────────
//   バケット全体 read は付与しない。GetObject を media/* に限定し、さらに handler が
//   「key が呼び出し元 identityId の media/{identityId}/ 配下か」を検証する（多層防御）。
const mediaBucket = backend.storage.resources.bucket;
lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["s3:GetObject"],
    resources: [`${mediaBucket.bucketArn}/media/*`],
  })
);
backend.generateReportFunction.addEnvironment(
  "MEDIA_BUCKET_NAME",
  mediaBucket.bucketName
);

// ── (3) Report テーブルの read/write を付与＋テーブル名注入 ──────────────
//   read：handler が Report.owner / Report.photoKeys を突合するため（IDOR 検証）。
//   write：生成成功時に draft*＋genStatus=GENERATED（失敗時 FAILED）を永続化するため
//         （リロード・切断後の状態復元。工程5 TC-6）。
const reportTable = backend.data.resources.tables["Report"];
reportTable.grantReadWriteData(lambda);
backend.generateReportFunction.addEnvironment(
  "REPORT_TABLE_NAME",
  reportTable.tableName
);

// ── (4) 冪等制御・quota テーブル（lease 付き状態機械）─────────────────────
//   冪等キー：reportId + imageSetHash + inputHash + promptVersion + modelId + schemaVersion
//   アイテム属性（ジョブ）：status（RUNNING|SUCCEEDED|FAILED）/ leaseExpiresAt（epoch秒）/
//     attemptId（実行ごとの UUID）/ attemptCount / inputHash / result / ttl
//   quota アイテム（同一テーブルに同居）：pk = "QUOTA#REPORT#<reportId>" / "QUOTA#USER#<sub>#<YYYY-MM-DD>"、
//     generationCount を条件付きで加算（ステップ3 (D')）
//   ⚠ TTL は「履歴の掃除」専用（例：7日）。TTL の削除は期限後も数日遅延し得る非同期削除であり、
//     ロックの有効期限・即時回復の判定には一切使わない。回復判定は leaseExpiresAt で行う。
const jobTable = new Table(backend.generateReportFunction.stack, "GenerationJobs", {
  partitionKey: { name: "idempotencyKey", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  encryption: TableEncryption.AWS_MANAGED,
  timeToLiveAttribute: "ttl", // 履歴削除専用（ロック期限判定には使わない）
  removalPolicy: RemovalPolicy.DESTROY, // PoC なので破棄可
});
jobTable.grantReadWriteData(lambda);
backend.generateReportFunction.addEnvironment("JOB_TABLE_NAME", jobTable.tableName);

// ── (5) CloudWatch Logs retention（14日）────────────────────────────
//   proposal §6「Logs 保持は7〜14日に固定」。無期限保持による課金増とログ漏えい面積を抑える。
//   コスト試算（proposal §5）の前提であり、本工程の完了条件に含める。
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs"; // ファイル先頭の import にまとめる
new LogGroup(backend.generateReportFunction.stack, "GenerateReportLogGroup", {
  logGroupName: `/aws/lambda/${lambda.functionName}`,
  retention: RetentionDays.TWO_WEEKS,
  removalPolicy: RemovalPolicy.DESTROY, // PoC なので破棄可
});

// ── (6) reserved concurrency（初期コストガードレール・本工程で設定）──────────
//   proposal §6「コスト監視」。全体上限の補助（同時実行数を絞るだけで、時間をずらした連続生成や
//   ユーザー単位の予算超過は止められない。主ガードレールはステップ3 (D') のサーバー側 quota）。
//   スロットリング発生時（Rate Exceeded）の UI 挙動は工程5 TC-2 で確認する。工程6 で実測見直し。
import { CfnFunction } from "aws-cdk-lib/aws-lambda"; // ファイル先頭の import にまとめる
(lambda.node.defaultChild as CfnFunction).reservedConcurrentExecutions = 5; // デモ規模なら 2〜5
```

> **補足（IDOR 多層防御の構成）**：S3 read は `media/*` に限定し、認可の正本は handler の「呼び出し元 `cognitoIdentityId` と key のプレフィックス一致」検証（ステップ3-B）。クライアントが更新できる `Report.photoKeys` は整合性チェックにのみ使い、**信頼境界に置かない**。他人の key を自分の Report の `photoKeys` に保存しても、プレフィックス検証で拒否される（工程5 TC-1 で否定テスト）。
>
> **補足（Logs retention）**：Lambda が自動作成するロググループと命名衝突する場合は、先に sandbox を一度デプロイしてから既存ロググループの retention をコンソール／CLI（`aws logs put-retention-policy --retention-in-days 14`）で設定する方式でもよい。いずれの方式でも「7〜14日に固定されていること」を確認して証拠を残す。

---

## ステップ3：`handler.ts`（本体）

`amplify/functions/generate-report/handler.ts` を新規作成する。**認可再検証・入力サーバー検証・lease 付き冪等制御・サーバー側 quota・deadline 付き Converse 呼び出し・生成結果の Report 永続化（入力不変の条件付き）・最小ログ**を実装する。

処理の流れ：**(A) 認可再検証 → (A') 入力サーバー検証 → (B) photoKeys 検証 → (C) 画像取得＋`imageSetHash`／`inputHash` 算出 → (D) lease 取得（冪等制御） → (D') quota 加算 → (E) deadline 付き Bedrock 呼び出し → (F) 結果保存（attemptId 条件付き）＋Report 書き戻し（入力不変の条件付き） → (G) 最小ログ**。

```ts
// amplify/functions/generate-report/handler.ts
import type { Schema } from "../../data/resource";
import { env } from "$amplify/env/generate-report"; // 生成される型付き環境変数
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash, randomUUID } from "node:crypto";

// ── クライアント（コールドスタート短縮のためモジュールスコープで初期化）──────
const bedrock = new BedrockRuntimeClient({ region: env.BEDROCK_REGION });
const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// ── 入力検証・制御の定数 ───────────────────────────────────────
const MAX_IMAGES = 3; // 主線は3枚
const HARD_MAX_IMAGES = 5; // 上限5枚（超過は 400 相当で拒否）
const MAX_BYTES_PER_IMAGE = 5 * 1024 * 1024; // 1枚 5MB 上限
const ALLOWED_MIME: Record<string, "jpeg" | "png" | "webp" | "gif"> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MAX_TEXT_LEN = 2000; // memo / nextPlanInput / workType の文字数上限（サーバー側検証）
const LEASE_SECONDS = 60; // 生成ロックの lease。Lambda ハードタイムアウト（29秒）＋余裕で設定
const POSTPROCESS_BUFFER_MS = 5000; // Bedrock 打ち切り後、失敗保存・ログ出力に確保する後処理バッファ
const MAX_GENERATIONS_PER_REPORT = 3; // Report 単位の再生成上限（サーバー側 quota の正本）
const MAX_GENERATIONS_PER_USER_PER_DAY = 30; // ユーザー×日次の上限（費用ガードレール）

// ── 日報4項目の JSON Schema（Converse Structured Outputs 用）──────────────
//   ⚠ 制約（工程0裏取り／JSON Schema Draft 2020-12 の「サブセット」のみ対応）：
//     - additionalProperties は全オブジェクトで false 必須（違反時 400）
//     - minLength / maxLength・数値制約（minimum等）・recursive・外部 $ref は非対応
//     - required は全プロパティを列挙
//   → 全項目 string ＋ safety のみネスト1段。「要確認」「不明」「空文字」を値として許容し、
//     「問題なし」はプロンプトで禁止する（スキーマでは表現しない）。
const REPORT_JSON_SCHEMA = {
  type: "object",
  properties: {
    work: { type: "string", description: "作業内容。当日メモを主根拠に。不明なら空文字。" },
    progress: {
      type: "string",
      description: "進捗。数量など写真・入力から確認できない場合は『要確認』。",
    },
    safety: {
      type: "object",
      properties: {
        confirmed: {
          type: "string",
          description: "画像内で確認できた安全事項のみ。無ければ空文字。",
        },
        unconfirmed: {
          type: "string",
          description: "画角外・未確認の安全事項。『問題なし』は書かない。",
        },
      },
      required: ["confirmed", "unconfirmed"],
      additionalProperties: false,
    },
    tomorrow: { type: "string", description: "翌日予定。翌日予定入力を主根拠に。" },
    status: {
      type: "string",
      enum: ["ok", "needs_review", "unknown"],
      description: "要確認/不明が含まれる場合は needs_review、情報不足なら unknown。",
    },
  },
  required: ["work", "progress", "safety", "tomorrow", "status"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = [
  "あなたは建築現場の日報作成を補助するアシスタントです。",
  "写真とテキスト入力から確認できない事項（工種・数量・作業員数・翌日工程・口頭指示など）は推測で埋めないこと。",
  "確認できない項目は『要確認』『不明』または空文字を返すこと。",
  "安全項目は『画像内で確認できた事項(safety.confirmed)』と『画角外・未確認(safety.unconfirmed)』を必ず分離すること。",
  "安全について『問題なし』『異常なし』等の断定は絶対に生成しないこと（最終判断は有資格者が行う）。",
  "出力は指定された JSON スキーマに厳密に従うこと。",
].join("\n");

type Handler = Schema["generateReport"]["functionHandler"];

// context（第2引数）から残り実行時間を取得して deadline を作る（(E) 参照）
export const handler: Handler = async (event, context) => {
  const started = Date.now();
  const requestId = event.request?.headers?.["x-amzn-requestid"] ?? "n/a";
  const { reportId, photoKeys } = event.arguments;

  // ── (A) 認可再検証（IDOR対策）─────────────────────────────
  //   identityPool(IAM) 認可のため event.identity は AppSyncIdentityIAM 形式
  //   （cognitoIdentityId / cognitoIdentityAuthType / cognitoIdentityAuthProvider）。
  const identity = event.identity as
    | {
        cognitoIdentityId?: string;
        cognitoIdentityAuthType?: string;
        cognitoIdentityAuthProvider?: string;
      }
    | undefined;
  const callerIdentityId = identity?.cognitoIdentityId;
  if (!callerIdentityId || identity?.cognitoIdentityAuthType !== "authenticated") {
    throw new Error("Unauthorized: no caller identity");
  }
  // User Pool の sub は cognitoIdentityAuthProvider（"...:CognitoSignIn:<sub>"）から抽出する
  const signInMatch = /:CognitoSignIn:([^,]+)/.exec(
    identity?.cognitoIdentityAuthProvider ?? ""
  );
  const callerSub = signInMatch?.[1];
  if (!callerSub) throw new Error("Unauthorized: no caller sub");

  // owner 検証のため Report を直接取得（テーブル名は backend.ts で注入）。
  const r = await ddb.send(
    new GetCommand({ TableName: env.REPORT_TABLE_NAME, Key: { id: reportId } })
  );
  const report = r.Item;
  if (!report) throw new Error("Not found");
  // owner フィールドは "<sub>::<username>" もしくは "<sub>" 形式。sub 先頭一致で突合する。
  //（owner は 02 の field-level authorization で再割当禁止済み。保存形式は工程5で否定テスト）
  const reportOwnerSub = String(report.owner ?? "").split("::")[0];
  if (reportOwnerSub !== callerSub) {
    // 他人の reportId を指定した否定テストはここで拒否（proposal §9 工程5 TC-1）
    logLine({ requestId, reportIdHash: sha8(reportId), modelId: env.MODEL_ID, status: "FORBIDDEN" });
    throw new Error("Forbidden");
  }

  // ── (A') 生成入力のサーバー側検証（UI 検証に依存しない）──────────────
  //   reportDate は必須（02 のスキーマ）だが、空文字・不正形式・非常識な日付の混入を
  //   ここでも拒否する。memo / nextPlanInput / workType は長さ上限を強制する。
  const reportDate = String(report.reportDate ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate) || Number.isNaN(Date.parse(reportDate))) {
    throw new Error("Invalid input: reportDate is required (YYYY-MM-DD)");
  }
  for (const [name, v] of [
    ["workType", report.workType],
    ["memo", report.memo],
    ["nextPlanInput", report.nextPlanInput],
  ] as const) {
    if (v != null && String(v).length > MAX_TEXT_LEN) {
      throw new Error(`Invalid input: ${name} exceeds ${MAX_TEXT_LEN} chars`);
    }
  }

  // ── (B) photoKeys の検証（クライアント指定 key を信用しない）──────────
  //   認可の正本：全 key が呼び出し元本人の media/{callerIdentityId}/ 配下であること。
  //   Report.photoKeys はクライアントが更新できるため認可の正本にせず、
  //   整合性チェック（多層防御）として照合する。
  //   → 他人の写真キー（B所有 Report に A の key を保存したケース含む）や
  //     任意パスを差し込む IDOR / パストラバーサルをここで拒否。
  const ownPrefix = `media/${callerIdentityId}/`;
  const requested = (photoKeys ?? []).filter(
    (k): k is string => typeof k === "string"
  );
  if (requested.some((k) => !k.startsWith(ownPrefix))) {
    // 本人の identity 配下でない key が混ざっている → 全体を拒否（工程5 TC-1）
    logLine({ requestId, reportIdHash: sha8(reportId), modelId: env.MODEL_ID, status: "FORBIDDEN" });
    throw new Error("Forbidden: photo key outside caller's media path");
  }
  const allowlist = new Set<string>(
    (report.photoKeys ?? []).filter((k: string) => typeof k === "string")
  );
  const validKeys = requested.filter((k) => allowlist.has(k)); // 整合性チェック
  if (validKeys.length === 0) throw new Error("No valid photo key");
  if (validKeys.length > HARD_MAX_IMAGES) throw new Error("Too many images");
  const targets = validKeys.slice(0, MAX_IMAGES); // 主線は最大3枚を Bedrock に渡す

  // ── (C) 画像取得＋入力検証（MIME/サイズ/枚数）＋ imageSetHash / inputHash 算出 ──
  //   imageSetHash はクライアントからは受け取らず、実際に read したバイトから Lambda が算出する。
  const images: { format: "jpeg" | "png" | "webp" | "gif"; bytes: Uint8Array }[] =
    [];
  const hash = createHash("sha256");
  for (const key of targets) {
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: env.MEDIA_BUCKET_NAME, Key: key })
    );
    const contentType = obj.ContentType ?? "";
    const format = ALLOWED_MIME[contentType];
    if (!format) throw new Error(`Unsupported MIME: ${contentType}`);
    const bytes = await obj.Body!.transformToByteArray();
    if (bytes.byteLength > MAX_BYTES_PER_IMAGE) throw new Error("Image too large");
    images.push({ format, bytes });
    hash.update(key); // キーも含めてハッシュ（同一集合・同一順序で安定）
    hash.update(bytes);
  }
  const imageSetHash = hash.digest("hex");

  //   inputHash：日報の一次情報であるテキスト入力のハッシュ。Report から読んだ値を
  //   「順序固定・Unicode 正規化（NFC）・区切り文字固定」で連結して算出する（クライアント値を信用しない）。
  //   これが冪等キーに入ることで、写真が同じでも memo / nextPlanInput 等を変更すれば
  //   必ず新規生成になり、変更前の古いドラフトを返さない（データ完全性の要件。工程5 TC-8）。
  const inputHash = hashInputs(report);

  // ── (D) 冪等制御：lease 付き状態機械 ─────────────────────────────
  //   冪等キー = reportId + imageSetHash + inputHash + promptVersion + modelId + schemaVersion。
  //   ⚠ promptVersion / schemaVersion / modelId がキーに含まれるため、これらを変更すると
  //     同一 reportId・同一写真・同一入力でも「必ず新規生成」される（前版の結果を再利用しない）。
  //   ⚠ inputHash が含まれるため、写真同一でもテキスト入力を変えれば新規生成される（TC-8）。
  //   ⚠ AppSync→Lambda は同期呼び出しのため Lambda の自動再試行は無い。二重実行の主因は
  //     クライアントの重複クリック / SDK 再送であり、この冪等キーで吸収する（proposal §6・工程5）。
  //
  //   状態機械（回復可能性が要件。工程5 TC-2/3 の「FAILED→再試行成功」「stale RUNNING→takeover」）：
  //     - SUCCEEDED           → 既存結果を返す（終端。再実行しない）
  //     - FAILED              → 条件付き更新でロック再取得し、再試行できる
  //     - RUNNING（lease 有効）→ 先行実行中。IN_PROGRESS を返す
  //     - RUNNING（lease 失効）→ ハードタイムアウト等で死んだ実行。条件付き更新で takeover する
  //   TTL はロック期限判定に使わない（削除は非同期で数日遅延し得るため。履歴掃除専用）。
  const idempotencyKey = [
    reportId, imageSetHash, inputHash, env.PROMPT_VERSION, env.MODEL_ID, env.SCHEMA_VERSION,
  ].join("#");
  const nowSec = Math.floor(started / 1000);

  const existing = await ddb.send(
    new GetCommand({ TableName: env.JOB_TABLE_NAME, Key: { idempotencyKey } })
  );
  if (existing.Item?.status === "SUCCEEDED" && existing.Item.result) {
    // 同一入力の再試行・二重送信 → Bedrock を再実行せず既存結果を返す（二重課金防止）。
    // Report にも復元書き込みし、前回の書き込みが失敗していても状態が揃うようにする。
    await saveDraftToReport(reportId, existing.Item.result, report);
    logLine({
      requestId,
      reportIdHash: sha8(reportId),
      modelId: env.MODEL_ID,
      status: "IDEMPOTENT_HIT",
      latencyMs: Date.now() - started,
      photoCount: targets.length,
      idempotent: true,
    });
    return { ...existing.Item.result, idempotent: true };
  }

  // lease 取得：新規 / FAILED / lease 失効 RUNNING のいずれかなら1回の条件付き Update で獲得する。
  // attemptId は実行ごとの UUID。完了・失敗の書き込みは attemptId 一致を条件にするため、
  // takeover 後に旧実行がゾンビ復活しても新しい実行の結果を上書きできない。
  const attemptId = randomUUID();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: env.JOB_TABLE_NAME,
        Key: { idempotencyKey },
        UpdateExpression:
          "SET #s = :running, attemptId = :aid, leaseExpiresAt = :lease, " +
          "attemptCount = if_not_exists(attemptCount, :zero) + :one, " +
          "inputHash = :ih, #t = :ttl",
        ConditionExpression:
          "attribute_not_exists(idempotencyKey) OR #s = :failed OR (#s = :running AND leaseExpiresAt < :now)",
        ExpressionAttributeNames: { "#s": "status", "#t": "ttl" },
        ExpressionAttributeValues: {
          ":running": "RUNNING",
          ":failed": "FAILED",
          ":aid": attemptId,
          ":lease": nowSec + LEASE_SECONDS,
          ":now": nowSec,
          ":zero": 0,
          ":one": 1,
          ":ih": inputHash,
          ":ttl": nowSec + 7 * 24 * 3600, // 履歴掃除専用
        },
      })
    );
  } catch (e: any) {
    if (e?.name === "ConditionalCheckFailedException") {
      // 一律 IN_PROGRESS にしない：再 Get で既存アイテムの状態を判別する
      //（ReturnValuesOnConditionCheckFailure: "ALL_OLD" で例外から旧アイテムを読む方式でも可）。
      const cur = (
        await ddb.send(
          new GetCommand({ TableName: env.JOB_TABLE_NAME, Key: { idempotencyKey } })
        )
      ).Item;
      if (cur?.status === "SUCCEEDED" && cur.result) {
        // 並行実行の勝者が完了済み → その結果を返す（二重課金なし）
        await saveDraftToReport(reportId, cur.result, report);
        logLine({ requestId, reportIdHash: sha8(reportId), modelId: env.MODEL_ID, status: "IDEMPOTENT_HIT", idempotent: true });
        return { ...cur.result, idempotent: true };
      }
      // lease 有効な RUNNING（先行実行中。初回コンパイル中の再試行を含む）
      logLine({ requestId, reportIdHash: sha8(reportId), modelId: env.MODEL_ID, status: "IN_PROGRESS" });
      throw new Error("Generation in progress, retry later");
    }
    throw e;
  }

  // ── (D') サーバー側 quota（費用ガードレールの正本。クライアント count は UX 補助）────
  //   新規 Bedrock 呼び出しだけを原子的に加算する（冪等ヒットは上で return 済みのため数えない）。
  //   Report 単位＋ユーザー×日次の両方を条件付き更新で強制する。quota アイテムはジョブと
  //   同じテーブルに pk 規約（QUOTA#...）で同居させる。
  try {
    const day = new Date(started).toISOString().slice(0, 10);
    await incrementQuota(`QUOTA#REPORT#${reportId}`, MAX_GENERATIONS_PER_REPORT, nowSec);
    await incrementQuota(`QUOTA#USER#${callerSub}#${day}`, MAX_GENERATIONS_PER_USER_PER_DAY, nowSec);
  } catch (e: any) {
    if (e?.name === "ConditionalCheckFailedException") {
      // 上限超過：獲得済みロックを FAILED に戻して終了（lease 待ちを発生させない）
      await markJobFailed(idempotencyKey, attemptId, "QUOTA_EXCEEDED");
      logLine({ requestId, reportIdHash: sha8(reportId), modelId: env.MODEL_ID, status: "QUOTA_EXCEEDED" });
      throw new Error("Generation quota exceeded");
    }
    throw e;
  }

  // ── (E) deadline 付き Bedrock Converse 呼び出し（画像＋テキスト＋Structured Outputs）──
  //   ⚠ Lambda のハードタイムアウト（timeoutSeconds: 29）に達すると実行環境がリセットされ、
  //     下の catch による FAILED 保存は保証されない。そこでハードタイムアウトに頼らず、
  //     「残り実行時間 − 後処理バッファ」を deadline として AbortSignal で Bedrock を自前で
  //     打ち切る。打ち切り後は catch が確実に動き、FAILED 保存・Report 更新・ログ出力を行える。
  //     バッファ値（POSTPROCESS_BUFFER_MS）は「失敗保存2回＋ログ」の実測値に余裕を載せて調整する。
  //     それでもプロセス異常で catch が動かなかった場合は、(D) の lease 失効が回復手段になる。
  const remainingMs = context.getRemainingTimeInMillis();
  const bedrockTimeoutMs = Math.max(1000, remainingMs - POSTPROCESS_BUFFER_MS);
  const abortSignal = AbortSignal.timeout(bedrockTimeoutMs);

  const userText =
    `日付: ${report.reportDate ?? ""} / 工種: ${report.workType ?? ""}\n` +
    `当日メモ: ${report.memo ?? ""}\n翌日予定: ${report.nextPlanInput ?? ""}\n` +
    `上記と添付写真から日報4項目を作成してください。`;

  const content = [
    ...images.map((img) => ({
      image: { format: img.format, source: { bytes: img.bytes } },
    })),
    { text: userText },
  ];

  try {
    const res = await bedrock.send(
      new ConverseCommand({
        modelId: env.MODEL_ID,
        system: [{ text: SYSTEM_PROMPT }],
        messages: [{ role: "user", content }],
        inferenceConfig: { maxTokens: 500, temperature: 0.2 },
        // Structured Outputs（JSON Schema 出力強制）。
        // ⚠ 指定方法（工程0裏取り）：outputConfig.textFormat（type: json_schema）、
        //    structure.jsonSchema.schema には JSON Schema を「文字列化」して渡す。
        outputConfig: {
          textFormat: {
            type: "json_schema",
            structure: {
              jsonSchema: {
                name: "genba_daily_report",
                description: "建築現場の日報4項目",
                schema: JSON.stringify(REPORT_JSON_SCHEMA),
              },
            },
          },
        },
      }),
      // deadline（(E) 冒頭）：超過時は AbortError として下の catch に落ち、
      // 後処理バッファ内で FAILED 保存・ログ出力を確実に完了させる
      { abortSignal }
    );

    const raw = res.output?.message?.content?.[0]?.text ?? "{}";
    const parsed = JSON.parse(raw);
    const result = {
      work: parsed.work ?? "",
      progress: parsed.progress ?? "",
      safety: {
        confirmed: parsed.safety?.confirmed ?? "",
        unconfirmed: parsed.safety?.unconfirmed ?? "",
      },
      tomorrow: parsed.tomorrow ?? "",
      status: parsed.status ?? "needs_review",
    };

    // ── (F) 結果保存：attemptId 一致を条件に SUCCEEDED を書く ──────────────
    //   lease takeover 後に旧実行（ゾンビ）が遅れて完走しても、attemptId 不一致で
    //   新しい実行の状態を上書きできない（ConditionalCheckFailed は「敗者」なので握りつぶす）。
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: env.JOB_TABLE_NAME,
          Key: { idempotencyKey },
          UpdateExpression: "SET #s = :s, #r = :r",
          ConditionExpression: "attemptId = :aid",
          ExpressionAttributeNames: { "#s": "status", "#r": "result" },
          ExpressionAttributeValues: { ":s": "SUCCEEDED", ":r": result, ":aid": attemptId },
        })
      );
    } catch (e: any) {
      if (e?.name === "ConditionalCheckFailedException") {
        // 別 attempt に takeover 済み。この実行の結果は破棄する（Report にも書かない）
        logLine({ requestId, reportIdHash: sha8(reportId), modelId: env.MODEL_ID, status: "STALE_ATTEMPT" });
        const stale = new Error("Superseded by a newer attempt, retry later");
        stale.name = "StaleAttemptError"; // 外側 catch で Report を FAILED にしないための目印
        throw stale;
      }
      throw e;
    }

    //   生成結果を Report へ永続化（draft* ＋ genStatus=GENERATED）。
    //   AppSync 30秒タイムアウトや回線切断中に Lambda が完走したケースでも、
    //   UI が Report を読み直すだけで状態復元できる（工程3・工程5 TC-6）。
    //   ⚠ 書き戻しは「生成に使った入力が Report 上で変更されていないこと」を条件付き更新で
    //     確認する（saveDraftToReport 内）。生成中にユーザーが memo 等を変更していた場合は
    //     書き戻さない（古い入力によるドラフトで新しい入力を上書きしないため。結果は
    //     GenerationJobs に残り、変更後入力での再生成は新しい冪等キーで実行される）。
    await saveDraftToReport(reportId, result, report);

    // ── (G) 最小ログ（画像・プロンプト本文は出さない。proposal §9「ログに記録する項目」）──
    //   フィールドはトップレベルで統一（工程6 の Logs Insights 集計と同一名。00 §3.5）
    logLine({
      requestId,
      reportIdHash: sha8(reportId), // report ID の非可逆識別子
      modelId: env.MODEL_ID,
      status: "SUCCEEDED",
      resultStatus: result.status, // "ok" | "needs_review" | "unknown"
      inputTokens: res.usage?.inputTokens,
      outputTokens: res.usage?.outputTokens,
      totalTokens: res.usage?.totalTokens,
      latencyMs: Date.now() - started,
      photoCount: targets.length,
      idempotent: false,
    });

    return { ...result, idempotent: false };
  } catch (err: any) {
    // 失敗は FAILED として記録（FAILED は (D) の条件で再取得できるため、即時再試行が可能）。
    // deadline 打ち切り（AbortError）・初回コンパイル超過・ModelTimeoutException もここに落ちる。
    // attemptId 一致を条件にするため、takeover 済みの新実行の状態を旧実行が壊すことはない。
    await markJobFailed(idempotencyKey, attemptId, err?.name ?? "Error");
    // Report 側にも失敗を永続化（リロード後に UI が FAILED＝再試行可能を復元できる）。
    // ただし takeover された旧実行（StaleAttemptError）は、新実行の状態を汚さないため書かない。
    if (err?.name !== "StaleAttemptError") {
      await ddb.send(
        new UpdateCommand({
          TableName: env.REPORT_TABLE_NAME,
          Key: { id: reportId },
          UpdateExpression: "SET genStatus = :g, updatedAt = :u",
          ExpressionAttributeValues: {
            ":g": "FAILED",
            ":u": new Date().toISOString(),
          },
        })
      );
    }
    logLine({
      requestId,
      reportIdHash: sha8(reportId),
      modelId: env.MODEL_ID,
      status: "FAILED",
      errorName: err?.name ?? "Error",
      latencyMs: Date.now() - started,
    });
    throw err;
  }
};

// ── ヘルパ ────────────────────────────────────────────────
function sha8(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}
function logLine(o: Record<string, unknown>): void {
  // 画像・プロンプト本文・生の入力テキストは絶対に含めない。
  // フィールド名はトップレベルで統一：requestId / reportIdHash / modelId /
  // status(SUCCEEDED|FAILED|IDEMPOTENT_HIT|IN_PROGRESS|FORBIDDEN|QUOTA_EXCEEDED|
  //        STALE_ATTEMPT|INPUT_CHANGED) / resultStatus /
  // errorName / inputTokens / outputTokens / totalTokens / latencyMs / photoCount / idempotent
  console.log(JSON.stringify(o));
}

// 生成入力（テキスト）の正規化ハッシュ。順序固定・NFC 正規化・区切り固定で安定させる。
// Report から読んだ値のみ使用（クライアントから直接受け取らない）。
function hashInputs(report: Record<string, any>): string {
  const norm = (v: unknown) => String(v ?? "").normalize("NFC");
  return createHash("sha256")
    .update(
      [norm(report.reportDate), norm(report.workType), norm(report.memo), norm(report.nextPlanInput)].join(
        " " // 値の連結境界が曖昧にならない区切り文字
      )
    )
    .digest("hex");
}

// サーバー側 quota：pk 単位で generationCount を条件付き加算（上限到達で ConditionalCheckFailed）。
// 新規 Bedrock 呼び出しのみ加算する（冪等ヒットは呼び出し元で return 済み）。
async function incrementQuota(pk: string, max: number, nowSec: number): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: env.JOB_TABLE_NAME,
      Key: { idempotencyKey: pk }, // quota アイテムはジョブと同一テーブルに pk 規約で同居
      UpdateExpression:
        "SET generationCount = if_not_exists(generationCount, :zero) + :one, #t = :ttl",
      ConditionExpression: "attribute_not_exists(generationCount) OR generationCount < :max",
      ExpressionAttributeNames: { "#t": "ttl" },
      ExpressionAttributeValues: {
        ":zero": 0,
        ":one": 1,
        ":max": max,
        ":ttl": nowSec + 30 * 24 * 3600, // 履歴掃除専用
      },
    })
  );
}

// ジョブを FAILED にする（attemptId 一致が条件。takeover 済みなら no-op）。
async function markJobFailed(idempotencyKey: string, attemptId: string, errorName: string): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: env.JOB_TABLE_NAME,
        Key: { idempotencyKey },
        UpdateExpression: "SET #s = :s, errorName = :e",
        ConditionExpression: "attemptId = :aid",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": "FAILED", ":e": errorName, ":aid": attemptId },
      })
    );
  } catch (e: any) {
    if (e?.name !== "ConditionalCheckFailedException") throw e; // takeover 済みは無視
  }
}

// 生成結果（ドラフト4項目＋状態）を Report へ永続化する。
// AppSync 経由でなく DynamoDB 直接更新のため、AppSync が自動管理する updatedAt も手動で更新する。
// ⚠ 「生成に使った入力（snapshot）が Report 上で変更されていないこと」を条件にする。
//   生成中にユーザーが memo 等を変更していた場合は書き戻さず（INPUT_CHANGED）、
//   変更後入力での再生成（新しい inputHash＝新しい冪等キー）に委ねる。
async function saveDraftToReport(
  reportId: string,
  r: {
    work: string;
    progress: string;
    safety: { confirmed: string; unconfirmed: string };
    tomorrow: string;
  },
  snapshot: Record<string, any> // handler 冒頭で Get した Report（生成入力のスナップショット）
): Promise<void> {
  // 入力4項目それぞれについて「読み取り時と同値（未設定なら未設定のまま）」を条件式にする
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const conds: string[] = [];
  for (const f of ["reportDate", "workType", "memo", "nextPlanInput"] as const) {
    names[`#${f}`] = f;
    const v = snapshot[f];
    if (v == null) {
      conds.push(`attribute_not_exists(#${f})`);
    } else {
      values[`:${f}`] = v;
      conds.push(`#${f} = :${f}`);
    }
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: env.REPORT_TABLE_NAME,
        Key: { id: reportId },
        UpdateExpression:
          "SET draftWork = :w, draftProgress = :p, draftSafetyConfirmed = :sc, " +
          "draftSafetyUnconfirmed = :su, draftTomorrow = :t, genStatus = :g, updatedAt = :u",
        ConditionExpression: conds.join(" AND "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: {
          ...values,
          ":w": r.work,
          ":p": r.progress,
          ":sc": r.safety.confirmed,
          ":su": r.safety.unconfirmed,
          ":t": r.tomorrow,
          ":g": "GENERATED",
          ":u": new Date().toISOString(),
        },
      })
    );
  } catch (e: any) {
    if (e?.name === "ConditionalCheckFailedException") {
      // 生成中に入力が変更された → 古い入力によるドラフトで上書きしない
      logLine({ reportIdHash: sha8(reportId), modelId: env.MODEL_ID, status: "INPUT_CHANGED" });
      return;
    }
    throw e;
  }
}
```

> **実装メモ（Report の read/write）**：owner／`photoKeys` の突合と生成結果の永続化のため、Lambda は Report テーブルを直接読み書きする。`backend.ts` の (3) で `REPORT_TABLE_NAME` 注入＋`grantReadWriteData` 済み。`report.site`（belongsTo）は `GetCommand` では解決されないため、現場名を出力に含めたい場合は Report に `siteName: a.string()` を非正規化保存する（PoC では省略可）。DynamoDB 直接更新は AppSync の自動 `updatedAt` 管理を通らないため、`saveDraftToReport` で `updatedAt` を手動更新している。
>
> **`Report.photoKeys` の扱い**：工程3のアップロード確定時に、その Report に紐づく S3 key 配列を `Report.photoKeys` に保存しておくこと（表示・整合性チェック用。**認可の正本ではない**——正本は (B) の identityId プレフィックス検証）。未保存だと整合性チェックで `No valid photo key` になり生成が拒否される。

---

## ステップ4：ウォームアップ手順（初回コンパイル対策）※工程4も参照

Structured Outputs は**新規スキーマの初回コンパイルに最大数分**、キャッシュは**初回アクセスから24時間**（proposal §6・工程0裏取りと一致）。**デプロイ後・スキーマ（`REPORT_JSON_SCHEMA`／`SCHEMA_VERSION`）変更後・`PROMPT_VERSION` 変更後・24時間超の未使用後**に、**同一スキーマで事前コンパイル呼び出し**を行う。

> **工程4（品質評価）への申し送り**：固定評価セットで計測する前には必ず本ウォームアップを実行すること。未実行だと初回コンパイル分（最大数分）がレイテンシに混入し、P95 や事実誤認率の測定条件がぶれる。スキーマ／`PROMPT_VERSION` を変更した評価では毎回再実行が必須。

スキーマのコンパイルキャッシュはアカウント単位・スキーマ単位。**同一スキーマJSONで Converse を1回叩けばアカウント全体でキャッシュが温まる**ため、画像なしのテキスト最小呼び出しで足りる。

```ts
// scripts/warmup.mjs  （デプロイ後 / スキーマ変更後 / PROMPT_VERSION 変更後 / 24h 経過後に実行）
// 実行: node scripts/warmup.mjs
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

// handler.ts の REPORT_JSON_SCHEMA と完全一致させること（1文字でも違うと別スキーマ扱い）
const REPORT_JSON_SCHEMA = {
  /* handler.ts からコピー。必ず同一にする（safety のネストを含む） */
};

const client = new BedrockRuntimeClient({ region: "ap-northeast-1" });

const t0 = Date.now();
const res = await client.send(
  new ConverseCommand({
    modelId: "anthropic.claude-haiku-4-5-20251001-v1:0",
    messages: [{ role: "user", content: [{ text: "warmup" }] }],
    inferenceConfig: { maxTokens: 500 },
    outputConfig: {
      textFormat: {
        type: "json_schema",
        structure: {
          jsonSchema: {
            name: "genba_daily_report",
            description: "建築現場の日報4項目",
            schema: JSON.stringify(REPORT_JSON_SCHEMA),
          },
        },
      },
    },
  })
);
console.log("warmup latencyMs =", Date.now() - t0, "usage =", res.usage);
```

**運用手順**：
1. `npx ampx sandbox`（または pipeline デプロイ）完了後、上記 `warmup.mjs` を1回実行。
2. 初回は数分かかり得るので、**タイムアウトせず完了するまで待つ**（初回はレイテンシ計測対象外）。
3. `PROMPT_VERSION` かスキーマを変更したデプロイでは必ず再実行する。
4. 定常運用では **24時間ごと**にウォームアップを流すと、実ユーザー呼び出しが常にキャッシュヒットになる。

---

## ステップ5：動作確認（A → A+）

1. **単体（A評価）**：sandbox デプロイ後、フロントの `client.queries.generateReport({ reportId, photoKeys }, { authMode: 'identityPool' })`（または AppSync コンソール）を叩く。→ Bedrock がドラフト4項目を返すことを確認。呼び出しは `generateClient<Schema>()` の `client.queries.generateReport(...)`、戻り値は `{ data, errors }`（工程3と整合）。**identityPool 認可が受理され、handler で `cognitoIdentityId` が取得できること**（差異注記参照）もここで確認する。
2. **一気通貫（A+評価）**：ログイン → 写真アップロード（工程1、`Report.photoKeys` 保存）→「AIで日報生成」→ ドラフト返却 → 確認・微修正 →「確定保存」（`Report` を update）→ 一覧表示。
3. **DynamoDB レコード確認**：
   - `Report` テーブルに**生成直後の時点で** `draftWork`/`draftProgress`/`draftSafetyConfirmed`/`draftSafetyUnconfirmed`/`draftTomorrow` と `genStatus=GENERATED` が保存されている（handler が永続化。確定時に UI が `CONFIRMED` へ更新）。
   - **生成成功後にアプリを再起動（画面を再読み込み）**しても、`Report` を読み直すだけでドラフトと生成状態が復元できる（工程5 TC-6 の前提）。
   - `GenerationJobs` テーブルに `idempotencyKey`・`status=SUCCEEDED`・`attemptId`・`leaseExpiresAt`・`inputHash` を持つレコードがある。
   - 同じ Report・同じ写真・**同じ入力**で再度「生成」→ `GenerationJobs` が増えず、レスポンスの `idempotent: true` を確認（二重課金防止）。
   - **写真は同じまま `memo`／`nextPlanInput` を変更して再生成 → `inputHash` が変わり新規生成される**（旧ドラフトを返さない。工程5 TC-8）。
   - **失敗（`FAILED`）後に再度「生成」→ 条件付き更新でロックを再取得し、再試行が成功する**（`attemptCount` が増える。工程5 TC-2）。
   - `PROMPT_VERSION`／`SCHEMA_VERSION` を上げて再生成 → `idempotencyKey` が変わり**新規 SUCCEEDED レコードが作られる**（前版を再利用しない）ことを確認。
   - `QUOTA#REPORT#<reportId>` の `generationCount` が新規生成のみ加算され、冪等ヒットでは増えないことを確認。上限（`MAX_GENERATIONS_PER_REPORT`）到達で `QUOTA_EXCEEDED` エラーになることを確認。
4. **CloudWatch ログの確認ポイント**（`/aws/lambda/...generate-report`）：
   - トップレベルの `status`（SUCCEEDED/IDEMPOTENT_HIT/IN_PROGRESS/FAILED/FORBIDDEN/QUOTA_EXCEEDED/STALE_ATTEMPT/INPUT_CHANGED）、`resultStatus`、`latencyMs`、`inputTokens`/`outputTokens`/`totalTokens`、`photoCount`、`idempotent` が出ている（工程6 の Logs Insights 集計と同一フィールド名。00 §3.5）。
   - **画像・プロンプト本文・生入力テキストが出ていない**こと（proposal §6・§9 と整合）。
   - `inputTokens` は proposal §5 の概算式・月額表更新（工程6）の実測値として控える。

---

## ステップ6：非同期切替（工程0で同期継続の基準を満たさなかった場合のみ）

工程0の判定が「同期継続の基準（`01_step0_spike.md` ステップ7）を満たさない」場合、本手順書ではなく **`03b_step2_async.md`（非同期方式の完全手順）** に従って工程2を実装する。

`03b_step2_async.md` は、受付 Lambda（検証＋lease 取得＋SQS 送信）／SQS（visibility timeout・maxReceiveCount・DLQ）／worker Lambda（Bedrock 呼び出し・attemptId 条件付き更新）／`getReportJob`（所有者再検証付きポーリング）／状態遷移・キャンセル・IAM 最小権限・テストまで、本手順書（同期版）と同じ粒度で定義済みである。本手順書のステップ3の検証・冪等・quota・ログのロジックは worker へそのまま移設して再利用する。

> 切替判断日・判定基準は工程0で確定済みであること（proposal §9 工程0 の失敗時対応）。同期で安定するならこの節は不要。

---

## 完了条件チェックリスト（proposal §9 工程2 と1対1）

- [ ] 工程0で確定した方式（同期＝本手順書／非同期＝`03b_step2_async.md`）で custom query `generateReport` を実装した
- [ ] **認可（identityPool）**：`allow.authenticated("identityPool")` で定義し、handler が `cognitoIdentityId`／`cognitoIdentityAuthProvider` を取得できることを確認した
- [ ] **所有者再検証（IDOR対策）**：`cognitoIdentityAuthProvider` から抽出した呼び出し元 `sub` と `Report.owner` を突合し、不一致を拒否（工程5の否定テストが通る）
- [ ] **photoKeys 検証（IDOR対策の正本）**：全 key が `media/{呼び出し元identityId}/` 配下であることを検証し、配下でない key の混入は全体拒否。`Report.photoKeys` との照合は整合性チェック（多層防御）に限定
- [ ] **S3 read の限定**：Lambda の S3 権限は `media/*` への `s3:GetObject` に限定（バケット全体 read を付与しない）
- [ ] **入力サーバー検証**：`reportDate` の形式・`memo`/`nextPlanInput`/`workType` の長さ上限を handler で検証（UI 検証に依存しない）
- [ ] **生成結果の永続化**：成功時に handler が `Report` へ draft* 5項目＋`genStatus=GENERATED` を保存（失敗時 FAILED、冪等ヒット時も復元書き込み）。**書き戻しは入力不変（読取時スナップショットとの一致）を条件付き更新で確認**。リロード後に Report から状態復元できる
- [ ] **CloudWatch Logs retention**：`generateReport` のロググループを 7〜14日に固定（ステップ2 (5)）
- [ ] **冪等キー（lease 付き状態機械）**：`reportId + imageSetHash + inputHash + promptVersion + modelId + schemaVersion` で生成状態を DynamoDB に保存、同一キー再実行は既存結果を返す（Bedrock 二重実行なし）。`imageSetHash`/`inputHash` は Lambda 側で算出。`promptVersion`/`schemaVersion`/`modelId` 変更時、および**テキスト入力変更時は必ず新規生成**
- [ ] **再試行回復**：`FAILED` と lease 期限切れ `RUNNING` を条件付き更新で再取得できる（`leaseExpiresAt`/`attemptId`/`attemptCount`）。完了・失敗更新は `attemptId` 一致条件。`ConditionalCheckFailedException` は再 Get で状態判別（一律 IN_PROGRESS にしない）。TTL はロック期限判定に使わない
- [ ] **deadline 制御**：`context.getRemainingTimeInMillis()` − 後処理バッファを AbortSignal で Bedrock に適用し、ハードタイムアウトの catch に依存しない
- [ ] **サーバー側 quota**：Report 単位・ユーザー×日次の生成上限を条件付き更新で強制。冪等ヒットは加算しない。reserved concurrency（補助）を設定（ステップ2 (6)）
- [ ] **Structured Outputs**：Converse API の JSON Schema 出力強制で日報4項目を取得（`要確認`/`不明`/空欄許容、安全は `safety.confirmed`/`safety.unconfirmed` 分離、「問題なし」を生成しない）、`maxTokens` 500
- [ ] **ウォームアップ**：デプロイ後・スキーマ／`PROMPT_VERSION` 変更後の事前コンパイル手順を用意（工程4も参照）
- [ ] 「AIで日報生成」→ ドラフト返却 → 確定保存 → DynamoDB レコード作成を確認
- [ ] ログは §末の記録項目のみを**トップレベルの統一フィールド名**（requestId／reportIdHash／modelId／status／resultStatus／errorName／inputTokens／outputTokens／totalTokens／latencyMs／photoCount／idempotent）で出力。画像・プロンプト本文は出さない

## process.md ゲート対応

- **A評価**：`generateReport` 単体で Bedrock 呼び出しが動く（CloudWatch ログで応答＋usage を確認）→ ステップ5-1・5-4。
- **A+評価**：ログイン→写真アップ→AI生成→確定保存→一覧 の一気通貫（通しデモ動画＋Bedrock 応答の CloudWatch ログ）→ ステップ5-2。
- **S評価（必須）**：本手順の IDOR 検証（identityId プレフィックス）・冪等キー・ログ本文非出力は、process.md §2 改定後の **S評価必須の安全ゲート**（工程5 TC-1／TC-3／TC-4・ログ健全性）を支える実装。S 前に完了していること。

## 失敗時の代替

- **初回コンパイルで AppSync 30秒超過**：まずステップ4ウォームアップを追加。なお超えるなら `03b_step2_async.md` の非同期方式へ切替。
- **Converse で 400（スキーマ非対応機能）**：`REPORT_JSON_SCHEMA` から `minLength`/`maxLength`/数値制約/`additionalProperties:true`/recursive を除去（Draft 2020-12 サブセットに限定。safety のネストも `additionalProperties:false`）。スキーマ構造を変えたら `SCHEMA_VERSION` を上げる。
- **Bedrock throttle/timeout（ModelTimeoutException・deadline の AbortError 含む）**：`GenerationJobs` は `FAILED` になり、条件付き更新で即時再取得できる。UI から再試行（冪等キーで二重課金なし）。失敗ハンドリングはハードタイムアウト（29秒）ではなく handler 内 deadline（残り時間 − 後処理バッファ）で完了させる。deadline 前に catch できず実行環境が落ちた場合も、lease 失効（`leaseExpiresAt` 経過）後の再試行で takeover できる。
- **`event.identity` が取れない／`cognitoIdentityId` が無い**：custom query の認可が `allow.authenticated("identityPool")` になっているか、フロントが `authMode: 'identityPool'` で呼んでいるか（userPool トークンのままだと IAM identity にならない）、ログイン済みで Identity Pool の authenticated ロールが発行されているかを確認。

---

### ⚠ 差異注記まとめ（proposal と AWS 公式ドキュメントの差異）

1. **認可**：公式 Bedrock サンプルは `allow.publicApiKey()`。本PoC は proposal §4 に従い認証必須とし、さらに **`allow.authenticated("identityPool")`（IAM）** を採用した。custom query には `allow.owner()` を付与できないため所有者判定は handler 内で行い、identityPool 認可により handler が `cognitoIdentityId` を取得して S3 key のプレフィックス検証（IDOR 対策の正本）を可能にした（proposal §6 の再検証方針と一致、矛盾なし）。**custom query での `allow.authenticated('identityPool')` の受理・IAM identity の内容は工程0または本工程デプロイ時に実挙動確認**すること。
2. **API**：公式サンプルは Anthropic Messages 形式の `InvokeModel`。本PoC は Structured Outputs のため **Converse API**（`outputConfig.textFormat.type: "json_schema"`、`schema` は**文字列化**して渡す）に変更（proposal §6・§7、工程0裏取りと一致）。
3. **S3 read の使い方**：Converse は `image.source.s3Location` で S3 を直接参照できるが、それだとクライアント指定 key の検証を Bedrock 側に委ねてしまう。本PoC は **Lambda が GetObject でバイト取得 → `image.source.bytes` で渡す**方式にし、IDOR 検証をサーバー側に固定した。加えて Lambda の S3 権限は `media/*` の `s3:GetObject` に限定した（proposal §6 と一致）。
4. **Cognito identity の粒度**：S3 パス `media/{entity_id}/*` の `entity_id` は Cognito **Identity Pool** の identityId。userPool 認可の `event.identity.sub`（User Pool の sub）とは一致しないため、本手順は **identityPool（IAM）認可に切り替えて `cognitoIdentityId` を直接取得**し、「key が呼び出し元の `media/{identityId}/` 配下か」を認可の正本として検証する。User Pool の sub は `cognitoIdentityAuthProvider`（`...:CognitoSignIn:<sub>`）から抽出して `Report.owner` と突合する（proposal §4/§6 の意図を実装で担保）。
5. **引数 `photoKeys` の扱い（工程3との整合）**：UI からは `photoKeys` を受け取るが、そのまま信用しない。認可は identityId プレフィックス検証で行い、クライアントが更新できる `Report.photoKeys` との照合は整合性チェック（多層防御）に留める（**allowlist を認可の正本にしない**——B所有 Report に A の key を保存する IDOR を防ぐため）。`imageSetHash`／`inputHash` はクライアントから受け取らず Lambda が実バイト・Report 読取値から算出する。これによりインターフェースの利便性と IDOR/改ざん耐性を両立した。
