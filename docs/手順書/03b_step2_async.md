# 工程2 実装手順書（非同期方式）：AI処理 `generateReport`（受付＋SQS＋worker）

対象アプリ：現場AI日報「GenbaLog」（`spec/plan7/proposal.md` §9 工程2）
評価対応：`spec/plan7/process.md` の **A評価**（AI生成が単体で動く）→ **A+評価**（一気通貫）

> **本手順書を使う条件**：工程0（`01_step0_spike.md` ステップ7）の判定が**非同期化**だった場合のみ。同期継続なら `03_step2_ai.md` を使い、本手順書は不要。
> **粒度の方針**：同期版（`03_step2_ai.md`）と同じ実装着手可能な粒度で、受付・キュー・worker・ポーリング・IAM・テストまで定義する。**検証（認可・入力・photoKeys）・冪等（lease 状態機械）・quota・ログのロジックは同期版ステップ3と同一**であり、コードは同期版から移設して再利用する（本書では差分と配置のみ示す）。

---

## 目的・前提

**目的**：AppSync 30秒上限に収まらない生成処理を、**受付（同期・軽量）＋ SQS ＋ worker（非同期・生成本体）** に分離し、クライアントはポーリングで結果を受け取る。

**依存する工程**：工程1（Data／Storage）完了。共通仕様（モデルID・リージョン・冪等キー・ログ規約）は `00_overview.md` §3 と同一（厳守）。

**全体構成と状態遷移**：

```text
[UI] --generateReport(受付query)--> [受付Lambda]
        ①認可再検証 ②入力検証 ③photoKeys検証 ④imageSetHash/inputHash算出
        ⑤lease取得(RUNNING) ⑥quota加算 ⑦SQS送信 → 即時 {jobId, status:RUNNING} を返す
[SQS 標準キュー] --(maxReceiveCount 超過)--> [DLQ]
        ↓ トリガ（batchSize:1）
[worker Lambda] ⑧lease再確認/延長(attemptId一致) ⑨Bedrock Converse ⑩結果保存(attemptId条件)
        ⑪Report へ draft*＋genStatus 永続化（入力不変の条件付き）
[UI] --ポーリング--> Report.genStatus（主）／getReportJob（補助・所有者再検証付き）

状態遷移（GenerationJobs。00 §3.4 の lease 状態機械と同一）:
  (なし) --受付--> RUNNING --worker成功--> SUCCEEDED（終端）
                   RUNNING --worker失敗--> FAILED --再受付--> RUNNING（再試行）
                   RUNNING（lease失効: worker死亡/DLQ行き）--再受付--> RUNNING（takeover・新attemptId）
```

---

## ステップ1：スキーマ変更（`amplify/data/resource.ts`）

同期版ステップ1 との差分のみ。`ReportSafety`／`ReportDraft`・認可（`allow.authenticated("identityPool")`）は同期版と同一。

```ts
// amplify/data/resource.ts（同期版からの差分）

// 受付の戻り値：生成結果ではなく「受け付けたジョブ」を返す
GenerationAccepted: a.customType({
  jobId: a.string(),      // = idempotencyKey（クライアントは意味を解釈しない不透明トークン扱い）
  status: a.string(),     // "RUNNING" | "IDEMPOTENT_HIT"（既存 SUCCEEDED を返した場合）
  result: a.ref("ReportDraft"), // IDEMPOTENT_HIT のときのみ非 null（既存結果を即返す）
}),

// ジョブ状態のポーリング（補助。主ポーリングは Report.genStatus）
GenerationJobStatus: a.customType({
  status: a.string(),     // "RUNNING" | "SUCCEEDED" | "FAILED"
  retryable: a.boolean(), // FAILED または lease 失効 RUNNING なら true
  attemptCount: a.integer(),
  result: a.ref("ReportDraft"), // SUCCEEDED のときのみ
}),

generateReport: a
  .query()
  .arguments({ reportId: a.string().required(), photoKeys: a.string().array().required() })
  .returns(a.ref("GenerationAccepted"))          // ← 同期版との差分（ReportDraft → GenerationAccepted）
  .authorization((allow) => [allow.authenticated("identityPool")])
  .handler(a.handler.function(acceptReportFunction)),

getReportJob: a
  .query()
  .arguments({ reportId: a.string().required(), jobId: a.string().required() })
  .returns(a.ref("GenerationJobStatus"))
  .authorization((allow) => [allow.authenticated("identityPool")])
  .handler(a.handler.function(getReportJobFunction)),
```

```ts
// 関数定義（受付・worker・ジョブ照会の3つ）
export const acceptReportFunction = defineFunction({
  name: "accept-report",
  entry: "./functions/accept-report/handler.ts",
  timeoutSeconds: 25, // 受付は軽量（Bedrock を呼ばない）。画像ハッシュ算出込みで余裕を持つ
  memoryMB: 1024,
  environment: { MODEL_ID, BEDROCK_REGION, PROMPT_VERSION, SCHEMA_VERSION },
});
export const generateWorkerFunction = defineFunction({
  name: "generate-worker",
  entry: "./functions/generate-worker/handler.ts",
  timeoutSeconds: 120, // AppSync 制約なし。初回コンパイル（最大数分）は許容しないためウォームアップ前提
  memoryMB: 1024,
  environment: { MODEL_ID, BEDROCK_REGION, PROMPT_VERSION, SCHEMA_VERSION },
});
export const getReportJobFunction = defineFunction({
  name: "get-report-job",
  entry: "./functions/get-report-job/handler.ts",
  timeoutSeconds: 10,
});
```

---

## ステップ2：`backend.ts` の CDK 拡張（SQS・DLQ・IAM・環境変数）

同期版ステップ2 の (1)〜(6)（Bedrock IAM／S3 read／Report テーブル／GenerationJobs／Logs retention／reserved concurrency）を**worker に対して**適用したうえで、以下を追加する。

```ts
// amplify/backend.ts（同期版からの追加分）
import { Queue } from "aws-cdk-lib/aws-sqs";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { Duration } from "aws-cdk-lib";

const workerLambda = backend.generateWorkerFunction.resources.lambda;
const acceptLambda = backend.acceptReportFunction.resources.lambda;
const jobQueryLambda = backend.getReportJobFunction.resources.lambda;

// ── DLQ：maxReceiveCount 超過メッセージの退避先（14日保持・中身はジョブIDのみで写真は含まない）──
const dlq = new Queue(backend.generateWorkerFunction.stack, "GenerationDLQ", {
  retentionPeriod: Duration.days(14),
});

// ── ジョブキュー（標準キュー）─────────────────────────────────────
//   visibilityTimeout は AWS 推奨どおり「worker の関数タイムアウトの6倍以上」にする
//   （worker 120秒 → 720秒）。可視性タイムアウト中に worker が死んだ場合、メッセージは
//   再配信され、GenerationJobs の lease（attemptId）が二重実行を防ぐ。
const jobQueue = new Queue(backend.generateWorkerFunction.stack, "GenerationQueue", {
  visibilityTimeout: Duration.seconds(720),
  deadLetterQueue: { queue: dlq, maxReceiveCount: 3 }, // 3回失敗で DLQ へ
});

// ── worker を SQS トリガに接続（1件ずつ処理・部分バッチ応答は不要）────────────
workerLambda.addEventSource(new SqsEventSource(jobQueue, { batchSize: 1 }));

// ── IAM（最小権限）──────────────────────────────────────────
// 受付：ジョブ/Reportテーブル RW・S3 read（media/* 限定）・SQS 送信のみ。Bedrock 権限は付与しない
jobTable.grantReadWriteData(acceptLambda);
reportTable.grantReadData(acceptLambda);
mediaBucket.grantRead(acceptLambda, "media/*");
jobQueue.grantSendMessages(acceptLambda);
// worker：同期版 (1)〜(3) と同じ Bedrock InvokeModel（foundation-model ARN 限定）・
//         S3 GetObject（media/*）・ジョブ/Reportテーブル RW。SQS consume は EventSource が自動付与
// getReportJob：ジョブテーブル read＋Report テーブル read（所有者再検証用）のみ
jobTable.grantReadData(jobQueryLambda);
reportTable.grantReadData(jobQueryLambda);

// 環境変数（JOB_TABLE_NAME / REPORT_TABLE_NAME / MEDIA_BUCKET_NAME を3関数へ、
// JOB_QUEUE_URL を受付へ addEnvironment。同期版 (2)(3)(4) と同様）
backend.acceptReportFunction.addEnvironment("JOB_QUEUE_URL", jobQueue.queueUrl);

// reserved concurrency：worker に小さく設定（同期版 (6) と同趣旨。キュー滞留は許容される）
```

---

## ステップ3：受付 handler（`amplify/functions/accept-report/handler.ts`）

**同期版ステップ3 の (A)(A')(B)(C)(D)(D') をそのまま移設**する（コード同一。Bedrock 呼び出し (E) 以降を行わない）。差分は末尾のみ：

```ts
// (D') quota 加算まで成功したら、SQS へジョブ投入して即返す。
// メッセージには写真バイト・入力本文を入れない（キー・ハッシュ・IDのみ）。
await sqs.send(
  new SendMessageCommand({
    QueueUrl: env.JOB_QUEUE_URL,
    MessageBody: JSON.stringify({
      idempotencyKey,
      reportId,
      attemptId,          // 受付が取得した lease の attemptId（worker が一致確認に使う）
      photoKeys: targets, // 検証済み（identityId プレフィックス確認済み）の key のみ
      callerIdentityId,   // worker 側の再検証用
      inputHash,          // Report 書き戻し時の入力不変チェックに使用
    }),
  })
);
logLine({ requestId, reportIdHash: sha8(reportId), modelId: env.MODEL_ID, status: "ACCEPTED" });
return { jobId: idempotencyKey, status: "RUNNING", result: null };
```

- 既存 `SUCCEEDED` があれば（同期版 (D) と同じ分岐で）`{ jobId, status: "IDEMPOTENT_HIT", result }` を即返し、SQS へは送らない（二重課金なし）。
- lease 有効な `RUNNING` があれば `{ jobId, status: "RUNNING", result: null }` を返す（再送しない。UI はポーリング継続）。
- `FAILED`／lease 失効 `RUNNING` は同期版と同じ条件付き更新で takeover し、新しい `attemptId` で再投入する（**FAILED が再試行不能にならない**）。
- 受付は Bedrock を呼ばないため、UI が `GENERATING` を設定した直後に受付が失敗した場合もエラーが同期で返る（UI は FAILED 表示に戻す）。

## ステップ4：worker handler（`amplify/functions/generate-worker/handler.ts`）

**同期版ステップ3 の (E)(F)(G)（deadline 付き Converse・attemptId 条件付き保存・入力不変条件付き Report 書き戻し・最小ログ）をそのまま移設**する。SQS 前処理の差分のみ：

```ts
export const handler = async (event: SQSEvent, context: Context) => {
  for (const record of event.Records) {
    const msg = JSON.parse(record.body); // { idempotencyKey, reportId, attemptId, photoKeys, callerIdentityId, inputHash }

    // ① 冪等前処理：ジョブの現在状態を確認する
    const job = (await ddb.send(new GetCommand({
      TableName: env.JOB_TABLE_NAME, Key: { idempotencyKey: msg.idempotencyKey },
    }))).Item;
    if (!job || job.status === "SUCCEEDED") continue;      // 完了済み（再配信）→ 何もしない
    if (job.attemptId !== msg.attemptId) {
      // 受付が takeover 済み（新しい attempt が存在）→ この古いメッセージは破棄
      logLine({ status: "STALE_ATTEMPT", reportIdHash: sha8(msg.reportId), modelId: env.MODEL_ID });
      continue;
    }

    // ② lease 延長（attemptId 一致条件）：worker の処理時間ぶん leaseExpiresAt を先へ延ばす。
    //    条件不一致（takeover 済み）なら破棄。SQS 再配信での二重実行はこの lease が防ぐ。
    //    以降、同期版 (E)(F)(G) を実行（deadline は context.getRemainingTimeInMillis() 基準で同じ）。
    //    S3 再取得時も photoKeys の identityId プレフィックス（msg.callerIdentityId）を再検証する。
  }
};
```

- worker が失敗（例外）した場合：同期版 (G) と同じく `FAILED`（attemptId 条件付き）＋ `Report.genStatus=FAILED` を保存してから throw する。throw により SQS が再配信し（最大 `maxReceiveCount`）、`FAILED` は受付経由でなくても worker の lease 再取得で再試行される。
- `maxReceiveCount` 超過で DLQ へ落ちた場合：ジョブは `FAILED` または lease 失効 `RUNNING` のまま残る → **UI からの再生成（受付の takeover）で回復できる**。DLQ はアラーム（CloudWatch）を任意で設定し、恒常的な失敗の検知に使う。

## ステップ5：`getReportJob` handler（所有者再検証付きポーリング補助）

**`idempotencyKey`（jobId）を知っているだけでは読めない**ようにする（推測・漏えい経由の情報取得を防ぐ）。

```ts
// amplify/functions/get-report-job/handler.ts（要点）
// ① 同期版 (A) と同一の認可再検証：identityPool の cognitoIdentityId / callerSub を取得
// ② 引数 reportId の Report を取得し、Report.owner と callerSub を突合（不一致は FORBIDDEN）
// ③ jobId（idempotencyKey）が「その reportId のジョブであること」を検証：
//    idempotencyKey は `${reportId}#...` 形式のため、reportId プレフィックス一致を必須にする
if (!msgSafeStartsWith(jobId, `${reportId}#`)) throw new Error("Forbidden");
// ④ ジョブを Get し、{ status, retryable, attemptCount, result } を返す
//    retryable = status === "FAILED" || (status === "RUNNING" && leaseExpiresAt < now)
```

- ①②③のいずれかで失敗したら `status: "FORBIDDEN"` をログに残して拒否する（工程5 TC-1 の否定テスト対象）。
- **主ポーリングは `Report.genStatus`**（`allow.owner()` で本人しか読めず、worker が draft*＋genStatus を永続化するため追加実装不要）。`getReportJob` は `retryable`／`attemptCount` の詳細が必要な場合の補助とする。

## ステップ6：UI（工程3）のポーリング規約

- 受付呼び出し：`client.queries.generateReport({ reportId, photoKeys }, { authMode: 'identityPool' })` → `{ jobId, status }`。`IDEMPOTENT_HIT` なら `result` を即表示。
- ポーリング：`Report.genStatus` を **2〜3秒間隔（指数バックオフ上限10秒）** で再取得。終了条件＝`GENERATED`（ドラフト表示）／`FAILED`（再試行表示）。**総ポーリング時間の上限（例：3分）**に達したら `getReportJob` で `retryable` を確認し、再試行ボタンを表示する。
- キャンセル：PoC ではサーバー側キャンセルを実装しない（ポーリング停止のみ）。再生成（受付の takeover）が実質のキャンセル＋再実行になる。
- ボタン無効化・回数上限（サーバー quota が正本）・状態復元（`/reports/[id]/edit` の初期取得）は同期版 UI（`04_step3_ui.md`）と共通。

---

## ステップ7：動作確認・テスト

同期版ステップ5 の確認に加えて、非同期固有の以下を確認する（工程5 のテストに接続）：

- [ ] 受付が 5秒以内程度で `{ jobId, status: "RUNNING" }` を返し、その後ポーリングで `GENERATED` になる
- [ ] **SQS 再配信の冪等性**：worker 処理中にメッセージを手動で再送（またはvisibility timeout を一時的に短縮）しても、attemptId／lease により Bedrock が二重実行されない
- [ ] **DLQ 経路**：worker を強制失敗させ `maxReceiveCount`（3回）超過で DLQ に入ること、その後 UI からの再生成で回復できること
- [ ] **`FAILED` → 再受付で再試行成功**、**lease 失効 `RUNNING` → 受付 takeover で成功**（工程5 TC-2/TC-3 拡張と同一）
- [ ] **`getReportJob` の否定テスト**：ユーザーB が A の `reportId`＋jobId で呼んで拒否される。jobId だけ知っていても reportId 不一致で拒否される（工程5 TC-1 に追加）
- [ ] メッセージ本文・DLQ に写真バイト・入力本文が含まれない（ログ規約と同趣旨）

## 完了条件チェックリスト

同期版の完了条件チェックリスト（認可・photoKeys 検証・入力検証・冪等 lease・quota・deadline・永続化・ログ・ウォームアップ）を worker／受付に読み替えてすべて満たしたうえで：

- [ ] SQS（visibility timeout ＝ worker タイムアウトの6倍以上）・DLQ（maxReceiveCount 3・14日保持）を設定した
- [ ] 受付・worker・getReportJob の IAM が最小権限（受付に Bedrock 権限なし、getReportJob は read のみ）
- [ ] `getReportJob` が Report 所有者・reportId プレフィックスを再検証する
- [ ] UI ポーリング（間隔・バックオフ・上限・終了条件・再試行）が規約どおり動く
- [ ] ステップ7 の非同期固有テストに合格した

## process.md ゲート対応

- **A評価**：worker 単体で Bedrock 呼び出しが動く（受付→SQS→worker のログで確認）。
- **A+評価**：ログイン→写真→受付→ポーリング→ドラフト表示→確定保存→一覧の一気通貫。
- **S-tech**：同期版と同じ安全ゲート（TC-1/3/4・ログ健全性・Budgets）＋最小品質スモーク。TC-4（30秒）は非同期化により「受付が30秒未満で返ること」の確認に読み替える（`06_step5_error.md` TC-4 注記）。

## 失敗時の代替

- **受付が30秒近くかかる（画像ハッシュ算出が重い）**：imageSetHash の算出を worker へ後ろ倒しし、受付の冪等キーを `reportId + photoKeys のソート済みkey列ハッシュ + inputHash + …` に変更する（キー衝突耐性は落ちるが受付は軽くなる。変更時は本書と 00 §3.4 を同時更新）。
- **SQS 再配信で二重課金が出る**：lease 延長（attemptId 条件）の実装漏れを確認。visibility timeout が worker タイムアウトの6倍以上かを確認。
- **DLQ に溜まり続ける**：worker のエラー内容（初回コンパイル超過・throttle・スキーマ400）を切り分け、ウォームアップ・reserved concurrency・スキーマサブセット制約（同期版 差異注記2）を見直す。
