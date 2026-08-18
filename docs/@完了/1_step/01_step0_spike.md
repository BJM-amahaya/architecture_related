# 工程0 実装手順書：技術スパイク（同期／非同期の確定ゲート）

対象アプリ: 現場AI日報「GenbaLog」（`../proposal.md` §6・§9 工程0 / `../process.md` 参照）

---

## 📝 改訂履歴（先に読むところ）

| 版 | 日付 | 何が変わったか |
|---|---|---|
| v1 | 2026-07-24 | 初版。JSON 強制を **Structured Outputs（`outputConfig.textFormat`）** で行う前提 |
| **v2** | **2026-08-10** | **`outputConfig` → Tool Use 方式へ全面改訂**。Bedrock 版 Claude Haiku 4.5 が `outputConfig.textFormat` に非対応と実測で判明したため（4経路を検証）。JSON 強制の手段を **Tool Use（`toolConfig` ＋ `toolChoice`）** に切替 |
| **v3** | **2026-08-14** | **ステップ5〜7を実施し工程0を完了**。定常 P95・画像枚数別トークンを実測し、**同期継続**を確定。本手順書の実装は `genbalog-spike/` に、実測値は `genbalog-spike/RESULTS.md` にある |
| **v4** | **2026-08-16** | **唯一の残タスクだった「24時間超未使用後の再計測」を実施**（**7,852ms・再コンパイルなし**）。これで工程0の**必須項目はすべて取得完了**。残るのは任意項目（`count.ts` / `strict: true`）のみ |

**旧版の呼称との対応**：

| v1 の呼称 | v2以降の呼称 | 備考 |
|---|---|---|
| Structured Outputs / `outputConfig.textFormat` | **不採用**（Haiku 4.5 非対応） | 400 エラー `output_config.format: Extra inputs are not permitted` |
| — | **Tool Use / `toolConfig` ＋ `toolChoice`** | v2 で採用。JSON Schema で出力形状を拘束する目的は同じ |
| 成功サイン `stopReason: end_turn` | 成功サイン **`stopReason: tool_use`** | Tool Use ではモデルがツールを呼んだ状態で応答を終えるため |

> 🔗 切り替えの経緯（4経路の検証記録）→ `../../../spec/html/step0_spike_tooluse.html`
> 🔗 経路探索の詳細 → `構造化出力_次の手順（手順②）.md`
> 🔗 **実測値・判定の正本** → `genbalog-spike/RESULTS.md`

---

## ✅ 本工程は完了しました（2026-08-14）

| 項目 | 結果 |
|---|---|
| 疎通 | ✅ 成功（`stopReason: tool_use`・日報4項目取得） |
| 採用経路 | **`jp.` ＋ Converse ＋ Tool Use** |
| 定常レイテンシ（5枚・N=20） | **P50 6,535 / P95 6,691 / Max 7,779 ms**（成功20 / 失敗0） |
| 24時間超未使用後の再計測（単一値） | **7,852 ms**（2026-08-16・5枚）**再コンパイルなし** |
| usage トークン | 1枚 in 4,451 / 3枚 in 7,595 / 5枚 in 10,739（画像1枚あたり **+1,572**・線形） |
| **判定** | **同期継続 → `../03_step2_ai.md`**（P95 6,691ms ≪ 目安 25,000ms・余裕 18,309ms） |

> 🔴 **判定の留保**：この計測は「ローカルPC → Bedrock の単発呼び出し」のみで、**Lambda コールドスタート・S3 画像取得・AppSync 経路・弱回線を含みません**。工程2で **Lambda 経由の E2E 再計測**を行い判定を確定させること。

---

## 目的・前提（依存する工程）

**目的**：日報生成を **同期（AppSync custom query・実行上限30秒）** で実装できるか、**非同期（Lambda/SQS＋クライアントポーリング）** に切り替えるべきかを、**実装前に実測値で確定する**。これは手戻りの最も大きい設計分岐であり、本工程は **実装初日の最優先ゲート**（proposal §9 工程0）。

**この工程が確定させること**：
- 日本 In-Region 推論プロファイル `jp.anthropic.claude-haiku-4-5-20251001-v1:0` に対する **モデルアクセス（Marketplace 有効化）・IAM 疎通**（`bedrock:InvokeModel` が通るか）
- **Converse API + Tool Use（JSON Schema 強制）+ 画像入力（最大5枚）を1リクエストで疎通**できること
  （v1 では Structured Outputs を使う前提だったが、Haiku 4.5 非対応のため v2 で Tool Use に変更）
- **初回スキーマコンパイル込み P95** と **定常 P95** の E2E レイテンシ（ミリ秒）
- **実測 usage トークン**（入力／出力）＝ §5 コスト概算式の裏取り値

**依存関係**：
- **上流依存：なし**（Amplify 未構築でも動く。AWS SDK for JavaScript v3 のローカル Node スクリプトで完結させる）
- **下流依存：工程2（AI処理 generateReport）が本工程の判定結果を参照する**。同期／非同期のどちらで custom query を実装するかは本工程で決める。UI（工程3）着手前に確定必須。

**共通仕様（厳守）**：
- Bedrock 呼び出しID：**`jp.anthropic.claude-haiku-4-5-20251001-v1:0`（日本 In-Region 推論プロファイル）**
  - ⚠ 素のモデルID `anthropic.claude-haiku-4-5-20251001-v1:0` は **on-demand 呼び出し非対応**（`ValidationException` になる）。推論プロファイルID（先頭 `jp.`）を使うこと。`jp.` は東京・大阪内で処理する日本 In-Region 用。詳細は末尾「疎通トラブルシューティング ③」参照。
- リージョン：`ap-northeast-1`
- 画像：長辺 1,568px・最大5枚・1リクエストに同梱
- 出力：日報4項目（作業内容／進捗／安全・懸念／翌日予定、`要確認` を許容）を JSON Schema で強制

---

## ステップ

### ステップ1：Bedrock モデルアクセスの有効化（要・手動有効化）

> 🔴 **重要（実測で判明）**：このアカウントでは **初回呼び出しでは自動有効化されず**、`AccessDeniedException`（`aws-marketplace:Subscribe` 不足）になった。**Bedrock コンソールでモデルアクセスを手動で有効化する**必要がある（＝お店の「入会手続き」。棚に商品があっても、購入手続きが済むまで使えない）。

1. AWS の既定リージョンが **東京 `ap-northeast-1`** であることを確認（有効化・呼び出しはリージョン単位）。
2. AWS コンソール → **Amazon Bedrock** → 左メニュー **「Model access（モデルアクセス）」** を開く。
3. **Claude Haiku 4.5** を探し、ステータスを確認する。
   - `Access granted`（許可済み）→ 次のステップへ。
   - `Available to request` 等 → **「Enable / アクセスをリクエスト」**を押す。**Anthropic は初回に用途（ユースケース）入力を求められることがある**ので入力する。
4. ステータスが **`Access granted`** になるまで待つ（数分）。有効化直後は最大2分ほど反映待ちが出る（エラー文にも "try again after 2 minutes"）。
5. CLI で東京リージョンに当該モデルが「カタログに存在するか」を確認（※これは**存在確認のみ**で、アクセス許可の有無は判定できない点に注意）：

```bash
# 実行環境：ローカルシェル（AWS CLI v2、AWS_PROFILE で認証を渡す）
AWS_PROFILE=rag-app-admin aws bedrock list-foundation-models \
  --region ap-northeast-1 \
  --query "modelSummaries[?contains(modelId, 'claude-haiku-4-5')].modelId"
```

> ✅ **確認済（AWS公式）**：Claude Haiku 4.5 は `ap-northeast-1`（東京）で **In-Region 対応**。モデル起動日 2025-10-16／コンテキスト 200K／最大出力 64K トークン。
>
> ⚠ **注意（用語の区別）**：上記 `list-foundation-models` に出てくる＝「商品棚に並んでいる（存在する）」だけの意味。**「使う許可が下りている（Access granted）」とは別**。アクセス可否はコンソールの Model access 画面、または実際に `spike.ts` を叩いて確認する（この CLI バージョンに `get-foundation-model-availability` サブコマンドは無い）。

### ステップ2：IAM 権限（最小権限）

スパイク実行に使う IAM ユーザー／ロール（本PoCでは `rag-app-admin`）に、以下を付与する。

- **`bedrock:InvokeModel`** … 推論プロファイル `jp.` を使うため、**推論プロファイル ARN と、その裏の基盤モデル ARN（東京＋大阪の両方）の合計3つ**を Resource に指定する（推論プロファイル経由の呼び出しは、裏側の各リージョンの基盤モデルにも許可が要るため）。
- **`aws-marketplace:ViewSubscriptions` / `aws-marketplace:Subscribe`** … ステップ1のモデルアクセス有効化に必要（これが無いと `AccessDeniedException`）。

```json
// IAMポリシー（スパイク用）※Resource ARN は要・自環境で確認（下記は雛形）
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockInvokeHaiku45JpProfile",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel"],
      "Resource": [
        "arn:aws:bedrock:ap-northeast-1:<ACCOUNT_ID>:inference-profile/jp.anthropic.claude-haiku-4-5-20251001-v1:0",
        "arn:aws:bedrock:ap-northeast-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
        "arn:aws:bedrock:ap-northeast-3::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0"
      ]
    },
    {
      "Sid": "BedrockMarketplaceSubscribe",
      "Effect": "Allow",
      "Action": [
        "aws-marketplace:ViewSubscriptions",
        "aws-marketplace:Subscribe"
      ],
      "Resource": "*"
    }
  ]
}
```

> ⚠ **要確認（未検証）**：上記 ARN（アカウントID・大阪 `ap-northeast-3` の要否）は当アカウントで未検証の雛形。実環境で `AccessDeniedException` が出る場合は、エラー文が指す ARN／アクションに合わせて調整すること（存在しない値を推測で確定しない）。
>
> ⚠ **差異注記1（API と権限の対応）**：本PoC は **Converse API** を使うが、Converse / ConverseStream も内部的には `bedrock:InvokeModel`（および Stream 時 `bedrock:InvokeModelWithResponseStream`）アクションで認可される。上記 `InvokeModel` 付与で Converse 呼び出しは可能。ConverseStream を使う場合は `bedrock:InvokeModelWithResponseStream` も追加すること。CountTokens（ステップ6）を別途使う場合は `bedrock:CountTokens` を追加する。

### ステップ3：ローカル実行環境の準備

Amplify 未構築で動く形にする。作業リポジトリ（GenbaLog 本体とは別の一時ディレクトリ可）で以下を用意：

```bash
# 実行環境：ローカルシェル（Node.js 20+ 推奨）
mkdir -p genbalog-spike && cd genbalog-spike
npm init -y
# CLAUDE.md ルールに従い --ignore-scripts を付与
npm install --ignore-scripts @aws-sdk/client-bedrock-runtime
npm install --ignore-scripts -D typescript tsx @types/node
# 認証情報は AWS_PROFILE で渡す（未設定だと鍵ゼロの default を見て失敗する）
export AWS_REGION=ap-northeast-1
export AWS_PROFILE=rag-app-admin   # or 実行のたびに AWS_PROFILE=... を前置き
# ↑ プロファイルを付けない／存在しない場合 → CredentialsProviderError（末尾トラブル②）
```

> ⚠ **実行時の必須2点**：スクリプトは **`genbalog-spike/` 直下**にある。①必ず `cd genbalog-spike` してから実行、②`AWS_PROFILE=rag-app-admin` を付ける。詳細は末尾「疎通トラブルシューティング ①②」参照。

- テスト画像は **事前に長辺 1,568px・JPEG に圧縮**して `./images/` に最大5枚配置（`img1.jpg` … `img5.jpg`）。※本スパイクでは圧縮処理自体は範囲外（クライアント側実装は工程3）。長辺 1,568px は Claude が API 側で自動縮小する上限に一致させ、無駄なアップロード帯域を避けるため（proposal §6）。
- Converse の画像フォーマット enum は `png | jpeg | gif | webp`。本PoC は `jpeg` を既定とする。

### ステップ4：スパイクスクリプト（Converse + Tool Use + 画像入力）

> 🔴 **本ステップが疎通の核**。成功＝**`stopReason: tool_use`** ＋ 4項目の JSON 取得。
>
> ⚠ **v1 からの変更**：当初は `outputConfig.textFormat`（Structured Outputs）を使う設計だったが、
> **Bedrock 版 Claude Haiku 4.5 が非対応**（`jp.` / `apac.` / `global.` の全経路で 400
> `output_config.format: Extra inputs are not permitted`）と実測で判明したため、
> **Tool Use（`toolConfig` ＋ `toolChoice`）** に切り替えた。JSON Schema で出力形状を強制する目的は同じ。
> 経緯 → `../../../spec/html/step0_spike_tooluse.html`

**実装は3ファイル構成**（`genbalog-spike/` 直下。計測から再利用するため関数を分離している）：

| ファイル | 役割 |
|---|---|
| `spike-lib.ts` | 本体。`generateReport()` を `export` する |
| `spike.ts` | `generateReport()` を1回呼んで結果を表示するだけの薄い CLI |
| `measure.ts` | `generateReport()` を N 回反復して P50/P95/Max を出す（ステップ5） |

```typescript
// genbalog-spike/spike-lib.ts
// Converse API + Tool Use（JSON Schema 強制）+ 画像入力（最大5枚）を1リクエストで疎通する。
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REGION = "ap-northeast-1";
// 日本 In-Region 推論プロファイル。素のID "anthropic.claude-haiku-4-5-..." は
// on-demand 非対応で ValidationException になるため、先頭 "jp." の推論プロファイルを使う。
const MODEL_ID = "jp.anthropic.claude-haiku-4-5-20251001-v1:0";
// 回帰テストで無関係写真セット（images_irrelevant/）に切り替えられるよう環境変数で上書き可能にする。
const DEFAULT_IMAGE_DIR = process.env.IMAGE_DIR ?? "./images";
const DEFAULT_MAX_IMAGES = 5;
// 日報を返させるツール名。toolSpec と toolChoice で同じ値を使う必要がある。
const TOOL_NAME = "genba_daily_report";

const client = new BedrockRuntimeClient({ region: REGION });

// 日報4項目の JSON Schema。`要確認` を許容する設計（事実性はスキーマでは保証されない＝プロンプトで担保）。
// 注: JSON Schema Draft 2020-12 の「サブセット」のみ対応（Tool Use でも同じ制約が効く）。
//     minLength/maxLength・数値制約・recursive・additionalProperties!=false は使用不可（差異注記2参照）。
// 注: このスキーマは toolConfig の inputSchema.json に「オブジェクトのまま」渡す。
//     （outputConfig 方式と違い JSON.stringify しない）
const reportSchema = {
  type: "object",
  properties: {
    work_content: {
      type: "string",
      description:
        "作業内容。当日メモを主根拠、写真で裏付け。確認できなければ『要確認』と記載。",
    },
    progress: {
      type: "string",
      description: "進捗。数量など不明な場合は『要確認』と記載。推測で埋めない。",
    },
    safety_concern: {
      type: "object",
      // 分割の軸は「確認できた／未確認」であって「良い／悪い」ではない。
      // ここを曖昧にすると confirmed が「安全対策（良い点）」だけの欄と解釈され、
      // 画角内に写っている危険を取りこぼす（＝proposal §2「安全上の懸念の見落とし」が未解決になる）。
      description:
        "安全・懸念。分割の軸は『画像内で確認できた／画角外で未確認』であり、" +
        "『良い点／悪い点』ではない。対策も危険も、見えていれば confirmed に入れる。" +
        "『問題なし』は生成しない。",
      properties: {
        confirmed: {
          type: "string",
          description:
            "画像内で確認できた安全上の事項。" +
            "実施されている対策（できている点）と、見えている危険・懸念（できていない点）の両方を含める。" +
            "危険が写っている場合は必ず記載する。" +
            "どちらも見当たらなければ『該当なし（確認範囲内）』。",
        },
        unconfirmed: {
          type: "string",
          description:
            "画角外・不鮮明で判断できない事項のみ（例：安全帯着用状況は写真外のため要確認）。" +
            "画角内に写っている作業員や設備を『未確認』としてはならない。",
        },
      },
      required: ["confirmed", "unconfirmed"],
      additionalProperties: false,
    },
    next_day_plan: {
      type: "string",
      description: "翌日の予定。翌日予定入力を主根拠。不明なら『要確認』。",
    },
  },
  required: ["work_content", "progress", "safety_concern", "next_day_plan"],
  additionalProperties: false,
};

function loadImages(imageDir: string, maxImages: number) {
  const files = readdirSync(imageDir)
    .filter((f) => /\.(jpe?g)$/i.test(f))
    .sort()
    .slice(0, maxImages);
  // 0枚のまま先に進むと「写真なしで API を呼び、トークンだけ消費して、それらしい日報が返る」。
  // ディレクトリ名の打ち間違いに気づけないので、ここで明示的に落とす。
  if (files.length === 0) {
    throw new Error(`画像が見つかりません（imageDir: ${imageDir}）。jpg/jpeg を配置してください。`);
  }
  // Converse の画像ブロックには番号が無い。番号を添えて根拠を書かせるには、
  // 各画像の直前にラベルの text ブロックを挟んで明示的に対応付ける必要がある。
  // （これをしないと、モデルは存在しない「写真6」を引用するなど番号ごと捏造する）
  // 画像ブロック: { image: { format, source: { bytes: Uint8Array } } }
  return files.flatMap((f, i) => [
    { text: `写真${i + 1}:` },
    {
      image: {
        format: "jpeg" as const,
        source: { bytes: new Uint8Array(readFileSync(join(imageDir, f))) },
      },
    },
  ]);
}

// 計測（measure.ts）から画像枚数・画像セットを変えて呼べるようにするための引数。
// temperature / maxTokens は「同一条件で回す」のが計測の前提なので、あえて引数化しない。
export type GenerateOptions = { imageDir?: string; maxImages?: number };

export async function generateReport(options: GenerateOptions = {}) {
  const imageDir = options.imageDir ?? DEFAULT_IMAGE_DIR;
  const maxImages = options.maxImages ?? DEFAULT_MAX_IMAGES;

  const imageBlocks = loadImages(imageDir, maxImages);
  // ラベルの text ブロックが混ざるので、枚数は image ブロックだけを数える。
  const imageCount = imageBlocks.filter((b) => "image" in b).length;

  const command = new ConverseCommand({
    modelId: MODEL_ID,
    messages: [
      {
        role: "user",
        content: [
          {
            text:
              "あなたは建築現場の日報作成を補助するアシスタントです。" +
              "以下の写真と当日メモ・翌日予定から、日報4項目を日本語で作成してください。" +
              "写真から確認できない事項（工種・数量・翌日工程・口頭指示など）は推測で埋めず『要確認』としてください。" +
              "安全項目は『画像内で確認できた事項』と『画角外・未確認』を必ず分離し、『問題なし』とは書かないでください。" +
              // ここから安全項目の追加指示。良い点だけ拾って危険を落とす失敗と、
              // その反動で危険を捏造する失敗の両方を同時に抑える。
              "確認できた事項には、実施されている対策だけでなく、画角内に見えている危険も必ず含めてください。" +
              // 「推測で埋めるな」と衝突してモデルが断定を避け、危険を『不明確』とぼかす／
              // 画角内の対象を『画角外』に逃がす挙動が出たため、両者の境界を明示する。
              "写っている人物が保護具（ヘルメット・安全帯・安全靴）を着けていないと見て取れる場合、" +
              "それは推測ではなく観察事実です。ぼかさず『未着用』と書いてください。" +
              "『画角外』と書いてよいのは、その対象が写真に写っていない場合だけです。" +
              "一方、写真に写っていない危険を想像で書くことは誤りです。" +
              // proposal §3: 作業員数は写真から確定できない項目。実際に人数を数え違えたため明示的に禁止する。
              "また作業員の人数は写真から確定できないため、『3名』のように断定せず『作業員』と書いてください。" +
              "根拠となる写真の番号（例：写真1）を添え、各欄は箇条書き6項目以内で簡潔に書いてください。\n" +
              "【現場】〇〇マンション新築工事 / 【日付】2026-07-06 / 【工種】鉄筋 / " +
              "【当日メモ】2F床スラブの配筋作業を実施。 / 【翌日予定】型枠建て込み、生コン打設の段取り。",
          },
          ...imageBlocks,
        ],
      },
    ],
    // 出力上限。Tool Use ではツール引数の JSON も出力トークンを消費するため 500 では不足する。
    // 実測コスト（工程6）には usage.outputTokens の実値を使うので、上限緩和は許容。
    inferenceConfig: { maxTokens: 1500, temperature: 0 },
    // JSON Schema 強制。Bedrock の Claude Haiku 4.5 は outputConfig.textFormat
    // （Structured Outputs）に非対応のため、Tool Use で代替する。
    // toolChoice でこのツールを必ず呼ばせる＝必ずこのスキーマで返させる。
    toolConfig: {
      tools: [
        {
          toolSpec: {
            name: TOOL_NAME,
            description: "建築現場の日報4項目（作業/進捗/安全/翌日）",
            // outputConfig と違い、スキーマはオブジェクトのまま渡す（stringify しない）
            inputSchema: { json: reportSchema },
            // 注: strict: true も Structured Outputs 系の機能で、Haiku 4.5 が
            //     拒否する可能性がある。素の状態で疎通確認できてから追加すること。
          },
        },
      ],
      toolChoice: { tool: { name: TOOL_NAME } },
    },
  });

  const start = Date.now();
  const res = await client.send(command);
  const elapsedMs = Date.now() - start;

  // Tool Use の結果は content の toolUse ブロックに入る。
  // input は既にオブジェクトなので JSON.parse は不要。
  const toolUse = res.output?.message?.content?.find(
    (block) => block.toolUse?.name === TOOL_NAME,
  )?.toolUse;

  if (!toolUse?.input) {
    // 黙って undefined を返すと「動いたが中身が空」を見逃すため、明示的に落とす。
    // stopReason が max_tokens の場合はツール引数が途中で切れている。
    throw new Error(
      `ツール呼び出しの結果を取得できませんでした（stopReason: ${res.stopReason}）。` +
        `content: ${JSON.stringify(res.output?.message?.content)}`,
    );
  }

  return {
    elapsedMs,
    latencyMsFromApi: res.metrics?.latencyMs, // API 実測レイテンシ
    usage: res.usage, // { inputTokens, outputTokens, totalTokens }
    stopReason: res.stopReason,
    report: toolUse.input,
    // imageCount は実測枚数。maxImages は上限指定にすぎず、実在枚数が少なければ黙って減る。
    // 記録・集計に使うのは必ず imageCount のほう。
    imageCount,
    imageDir,
    maxImages,
  };
}
```

```typescript
// genbalog-spike/spike.ts … 薄い CLI。1回呼んで結果を出すだけ。
import { generateReport } from "./spike-lib";

generateReport()
  .then((r) => {
    console.log("=== 疎通結果 ===");
    console.log("images:", r.imageCount, "stopReason:", r.stopReason);
    console.log("elapsedMs(round-trip):", r.elapsedMs, "latencyMs(api):", r.latencyMsFromApi);
    console.log("usage:", JSON.stringify(r.usage));
    console.log("report:", JSON.stringify(r.report, null, 2));
  })
  .catch((e) => {
    console.error("=== 疎通失敗 ===");
    console.error(e?.name, e?.message);
    process.exit(1);
  });
```

実行：

```bash
# 実行環境：ローカルシェル。genbalog-spike 直下に cd し、AWS_PROFILE を付ける
cd genbalog-spike
AWS_PROFILE=rag-app-admin npx tsx spike.ts
```

成功すると `=== 疎通結果 ===` に **`stopReason: tool_use`** と日報4項目の JSON が表示される。
**Tool Use 方式では `end_turn` ではなく `tool_use` が成功のサイン**（モデルがツールを呼んだ状態で応答を終えるため）。エラーが出た場合は末尾「疎通トラブルシューティング」を参照。

> ✅ **実測（2026-08-14・5枚）**：`stopReason: tool_use` / round-trip **7,749ms** / api 6,272ms /
> usage `in 10,739 / out 563 / total 11,302`。日報4項目が正しく生成された。

#### outputConfig 方式 → Tool Use 方式（何が変わったか）

| 観点 | ✗ outputConfig 方式（不採用） | ✓ Tool Use 方式（採用） |
|---|---|---|
| 指定する欄 | `outputConfig.textFormat.structure.jsonSchema` | `toolConfig.tools[].toolSpec.inputSchema` |
| スキーマの渡し方 | `JSON.stringify(reportSchema)` の**文字列** | `{ json: reportSchema }` の**オブジェクトのまま** |
| 強制の仕組み | 出力形式そのものを JSON Schema で拘束 | `toolChoice: { tool: { name } }` で当該ツールを必ず呼ばせる |
| 成功時の `stopReason` | `end_turn` | **`tool_use`** |
| 結果の取り出し | `content[0].text` → `JSON.parse` が必要 | `content[].toolUse.input`（**parse 不要**） |
| Haiku 4.5 での可否 | ❌ 400 エラー | ✅ 成功 |

> ⚠ **差異注記2（JSON Schema サブセット制約）**：**この制約は Tool Use 方式でも同じく効く**。AWS公式では **JSON Schema Draft 2020-12 のサブセット**しか受け付けない。**`minLength`/`maxLength`・数値制約（`minimum` 等）・recursive schema・外部 `$ref`・`additionalProperties: false 以外`** は非対応で、違反時は **400 エラー**。本スキーマは全項目 `string`＋ネスト1段＋`additionalProperties: false` に収めており制約を満たす。工程2でスキーマ拡張する際もこのサブセットを厳守すること。
>
> ⚠ **差異注記3（v2 で実測により更新）**：proposal §6 は「Anthropic Messages API 経路では Structured Outputs 不可、`bedrock-runtime` の Converse / InvokeModel は可」と記載しているが、**本PoC の実測では Converse の `outputConfig.textFormat` も Claude Haiku 4.5 では使えなかった**（`jp.` / `apac.` / `global.` の全経路で 400 `output_config.format: Extra inputs are not permitted`）。**経路の問題ではなくモデル側の未対応**。したがって本PoC では **Converse ＋ Tool Use** に固定する。「利用APIを Converse に固定する」という proposal の趣旨自体は維持される。
>
> ⚠ **`maxTokens` は 500 では足りない**：proposal §5 のコスト前提は「出力トークン上限 500以下」だが、**Tool Use ではツール引数の JSON も出力トークンを消費する**ため 500 では途中で切れる（`stopReason: max_tokens`）。本手順では **1500** に緩和している。実測は 437〜563（§ステップ5）で、**5枚条件の 563 が proposal §5 の前提 500 を超えた**ため、**proposal §5 のコストモデルを工程6で更新すること**。

---

### 🔧 疎通トラブルシューティング（実際につまずいた順）

> `AWS_PROFILE=rag-app-admin npx tsx spike.ts` を実行すると、環境が整うまで **下の①→④の順にエラーが出る**（前のエラーを直すと次が出る）。各段階の「原因」と「対処」を順に潰せば疎通する。

一覧：

| # | 出るエラー（先頭） | ざっくり原因 | 対処 |
|---|---|---|---|
| ① | `ERR_MODULE_NOT_FOUND: Cannot find module '.../spike.ts'` | **実行フォルダが違う**（`spike.ts` は `genbalog-spike/` の中） | `cd genbalog-spike` してから実行 |
| ② | `CredentialsProviderError: Could not load credentials from any providers` | **AWS_PROFILE 未設定**で、鍵ゼロの `default` を見に行った | `AWS_PROFILE=rag-app-admin` を付けて実行 |
| ③ | `ValidationException: ... on-demand throughput isn't supported ... inference profile` | **素のモデルIDは on-demand 不可**。推論プロファイルIDが必要 | `MODEL_ID` を `jp.anthropic.claude-haiku-4-5-20251001-v1:0` に |
| ④ | `AccessDeniedException: ... aws-marketplace:Subscribe ...` | **モデルアクセス未登録**（Marketplace 未サブスクライブ） | Bedrock コンソールの Model access で有効化（ステップ1） |

各段階の詳細：

**① `ERR_MODULE_NOT_FOUND`（ファイルが見つからない）**
- 原因：`spike.ts` は `architecture_related/genbalog-spike/` の直下にある。1つ上の階層で実行すると「そんなファイル無い」となる。
- 対処：
  ```bash
  cd genbalog-spike        # まずこのフォルダに入る
  AWS_PROFILE=rag-app-admin npx tsx spike.ts
  ```

**② `CredentialsProviderError`（認証情報が読めない）**
- 原因：AWS の鍵は「プロファイル」から読む。`AWS_PROFILE` が設定されていないと、鍵が入っていない `default` プロファイルを見に行って「どこからも読めない」となる。
- 対処：`AWS_PROFILE=rag-app-admin` を付けて実行（`~/.aws/credentials` の `[rag-app-admin]` に静的キーがある前提）。
  ```bash
  # 確認：認証がネット接続なしで解決できるか（先頭4文字が AKIA... なら成功）
  AWS_PROFILE=rag-app-admin aws sts get-caller-identity
  ```

**③ `ValidationException`（on-demand 非対応 → 推論プロファイルを使え）**
- 原因：新しめの Claude を Bedrock で使うとき、**素のモデルID `anthropic.claude-haiku-4-5-...` を直接指定するとオンデマンド呼び出しできない**。複数リージョンに処理を振り分ける「推論プロファイルID」という別名（先頭 `jp.` など）が必要。
- 対処：`spike.ts` の `MODEL_ID` を推論プロファイルIDに変更。
  ```bash
  # 使える推論プロファイルIDを一覧（jp. = 日本 In-Region / global. = 世界振り分け）
  AWS_PROFILE=rag-app-admin aws bedrock list-inference-profiles \
    --region ap-northeast-1 \
    --query "inferenceProfileSummaries[?contains(inferenceProfileId,'haiku-4-5')].inferenceProfileId" \
    --output text
  # → jp.anthropic.claude-haiku-4-5-20251001-v1:0   global.anthropic.claude-haiku-4-5-20251001-v1:0
  ```
  → データを国内で処理する方針（proposal §6 In-Region）なので **`jp.` を選ぶ**。`global.` は海外リージョンに出る可能性があるため避ける。

**④ `AccessDeniedException`（モデルアクセス未登録）**
- 原因：Bedrock はモデルを呼ぶ前に**アカウントごとの利用登録（Marketplace サブスクライブ）**が要る。この登録が未完了、または `rag-app-admin` に Marketplace 権限が無いと拒否される。「棚に商品はあるが購入手続きが未完了」の状態。
- 対処：**ステップ1** の手順でコンソールからモデルアクセスを有効化（数分待つ）。有効化ボタンでエラーが出る場合は **ステップ2** の IAM 権限（`aws-marketplace:ViewSubscriptions` / `Subscribe`）を管理者に依頼。
- ※アクセス状態を確認する CLI（`get-foundation-model-availability`）は当環境の AWS CLI に**存在しない**ため、確認はコンソールの Model access 画面で行う。

> ✅ ①〜④をすべて解消すると **`stopReason: tool_use`** と4項目 JSON が返る（＝疎通成功）。
> ⚠ v1 では `end_turn` が成功サインと書いていたが、**Tool Use 方式では `tool_use`** が正しい。
>
> **⑤ 追加（v2 で判明）**：`ValidationException: ... output_config.format: Extra inputs are not permitted`
> → `outputConfig.textFormat`（Structured Outputs）を使っている。**Claude Haiku 4.5 は非対応**。
> Tool Use（`toolConfig` ＋ `toolChoice`）に切り替える（ステップ4）。`jp.` / `apac.` / `global.` のどれに変えても同じエラーになるため、経路変更では解決しない。

### ステップ5：レイテンシ計測（初回コンパイル実測値・定常P95・24時間後）

3種類を必ず分けて計測する（定常 P95 だけでは初回・キャッシュ失効を見落とすため）。

> ⚠ **計測定義の注意（統計の扱い）**：初回コンパイルは本質的に**1標本**（同一スキーマの「初回」は1回しか起きない）であり、**P95 は算出できない**。初回条件は「**初回実測値（＝その回の所要時間。複数スキーマで測った場合は最大値）**」として記録し、P50/P95 は**定常計測（同一スキーマ・同一入力条件の複数回測定）にのみ**適用する。なお「毎回新しいスキーマを作って初回標本を増やす」方法はスキーマ複雑度差が混入し同一条件にならないため、判定には使わない（参考値に留める）。

1. **初回コンパイル計測（単一値）**：**スキーマを一度も使っていない状態**（またはスキーマ構造を変更した直後）で1回目を実行。初回は grammar コンパイルで**最大数分**かかり得る。この値を「初回実測値」として記録（P95 ではない）。
2. **定常 P95 計測**：**同一スキーマ・同一画像枚数（最大5枚）**で連続実行し、P50/P95/Max を算出（コンパイル済みキャッシュ利用時）。下記スクリプトを使用。
3. **24時間超未使用後の再計測（単一値）**：キャッシュは**初回アクセスから24時間**で失効するため、丸1日以上あけて再度1回目を計測し、コンパイル再発の有無と所要時間を**単一値**として記録。

実装済み（`genbalog-spike/measure.ts`）。`spike-lib.ts` の `generateReport` を import して N 回反復する。

```bash
# 実行環境：ローカルシェル。genbalog-spike 直下
AWS_PROFILE=rag-app-admin npx tsx measure.ts 20      # 5枚(既定) × 20回 = 定常 P95
AWS_PROFILE=rag-app-admin npx tsx measure.ts 3 1     # 1枚 × 3回 = 枚数別トークン
AWS_PROFILE=rag-app-admin npx tsx measure.ts 3 3     # 3枚 × 3回
SLEEP_MS=3000 AWS_PROFILE=rag-app-admin npx tsx measure.ts 20   # throttle を踏む場合は間隔を広げる
```

`measure.ts` が実装している要点（設計意図込み）：

| 要素 | 内容 | なぜそうしたか |
|---|---|---|
| 分位点 | nearest-rank 法（`sorted[ceil(q*n)-1]`） | 手順書の式と一致させるため。**N が小さいと p95 が max と一致する**ことをコード内に注記 |
| 試行間隔 | 既定 `SLEEP_MS=1000` | 連続実行で `ThrottlingException` を踏むと計測が途切れるため |
| 失敗の扱い | 1回失敗しても計測を続け、**最後に件数と内容を必ず出す** | 失敗を隠すと「動いた」と誤読される |
| 全滅時 | 分位点を出さずに **throw** | 「測れた」と誤読させないため |
| 欠測トークン | 0 で埋めず「データなし」と表示 | 欠測を平均に混ぜて数字を作らないため（`.claude/CLAUDE.md`「データ偽装の禁止」） |
| 枚数の記録 | `maxImages`（上限指定）ではなく実測の `imageCount` | 実在枚数が少ないと黙って減るため |
| 判定 | **しない**（25秒との差分を表示するだけ） | 判定は人が `RESULTS.md` に記録する（ステップ7） |

> ⚠ 反復時は**同一スキーマ・同一画像枚数**で回すこと。計測中に `spike-lib.ts` のプロンプト・スキーマ・`temperature`・`maxTokens` を変更しない（「同一条件で回す」のが計測の前提）。

**実測 usage トークンの記録方法**：各レスポンスの `res.usage`（`inputTokens` / `outputTokens` / `totalTokens`）を全件ログ化し、平均・最大を残す。画像枚数（1〜5枚）ごとの入力トークンを記録すると §5 概算式の裏取りに直結する。

#### ✅ 実測結果（2026-08-14）

**レイテンシ（5枚・N=20）**

| 指標 | elapsedMs（往復） | apiMs（参考） |
|---|---|---|
| P50 | **6,535** | 6,223 |
| P95 | **6,691** | 6,339 |
| Max | **7,779** | 6,368 |

成功 **20 / 20**、失敗 **0**。目安 25,000ms に対し **余裕 18,309ms**（バジェット消費率 26.8%）。
max=7,779ms は**当日1回目**の呼び出しで、2回目以降は 6,396〜6,691ms に収束。**数分規模の grammar コンパイルは一度も観測されなかった。**

**24時間超未使用後の再計測（単一値・2026-08-16）**

| 計測条件 | elapsedMs（往復） | apiMs | stopReason | usage |
|---|---|---|---|---|
| 2026-08-14 の計測から**約2日間**未使用 → 1回実行（5枚） | **7,852** | 6,225 | `tool_use` | in 10,739 / out 563（08-14 と同値） |

→ キャッシュ失効後の初回でも **8秒未満**。**再コンパイルは発生せず**、判定条件 (a) は24時間経過後も成立する。

**usage トークン（画像枚数別）**

| 画像枚数 | inputTokens | outputTokens | totalTokens | 試行数 |
|---|---|---|---|---|
| 1枚 | **4,451** | 437 | 4,888 | N=3（全回同値） |
| 3枚 | **7,595** | 556 | 8,151 | N=3（全回同値） |
| 5枚 | **10,739** | 563 | 11,302 | N=20（全回同値） |

- 画像1枚あたりの入力トークン増分＝**1,572**（`(10,739 − 4,451) ÷ 4`）。検算 `4,451 + 1,572 × 2 = 7,595` は3枚の実測値と**完全一致**（枚数に対して線形）。
- 画像0枚相当のベース（プロンプト＋スキーマ）＝**2,879** トークン。
- `cacheReadInputTokens` は全回 **0**（プロンプトキャッシュ未使用）。

> 📄 詳細は **`genbalog-spike/RESULTS.md`**（本工程の成果物・正本）。

### ステップ6：CountTokens で入力トークンを事前確認（任意・コスト裏取り）

実際の推論を走らせずに入力トークンを見積もれる **CountTokens API**（無料・課金対象と同一カウント）で、画像枚数別の入力トークンを裏取りできる。

```typescript
// genbalog-spike/count.ts
// CountTokens: Converse 入力（messages/system）のトークン数を推論前に取得。
// 実行: npx tsx count.ts
import { BedrockRuntimeClient, CountTokensCommand } from "@aws-sdk/client-bedrock-runtime";
import { readFileSync } from "node:fs";

const client = new BedrockRuntimeClient({ region: "ap-northeast-1" });
const bytes = new Uint8Array(readFileSync("./images/img1.jpg"));

const cmd = new CountTokensCommand({
  modelId: "jp.anthropic.claude-haiku-4-5-20251001-v1:0", // 呼び出しと同じ推論プロファイルID
  // input は Union。Converse 用は `converse` フィールドに messages/system を渡す。
  input: {
    converse: {
      messages: [
        {
          role: "user",
          content: [
            { text: "この写真から日報の作業内容を要約してください。" },
            { image: { format: "jpeg", source: { bytes } } },
          ],
        },
      ],
    },
  },
});

client.send(cmd).then((r) => console.log("inputTokens:", r.inputTokens));
```

> ✅ **確認済（AWS公式）**：CountTokens は `bedrock-runtime` エンドポイントに存在。`input` は Union で、**Converse 用は `converse` フィールド**（messages/system）、**InvokeModel 用は `invokeModel` フィールド**（body 文字列）。返り値のトークン数は、同一入力を実推論した際に**課金されるカウントと一致**する。モデル固有のトークナイズのため `modelId` 指定必須。

### ステップ7：判定（同期継続 / 非同期化）

計測結果を下記基準で判定し、**判断日・判定基準・結論**を記録する（工程2が参照）。

| 判定 | 基準 | 採用方式 |
|---|---|---|
| 同期継続 | **(a) 初回コンパイルの実測最大値 < 25秒**、**または (b) ウォームアップにより初回コンパイルを利用者経路から確実に除外できる**（デプロイ後・スキーマ変更後・24時間ごとの運用が成立する）。**かつ、定常 P95 に十分な余裕**（< 25秒） | AppSync 同期 custom query（`03_step2_ai.md`） |
| 非同期化 | 上記を安定して満たせない（初回・24h後再コンパイルの超過を運用で除外できない、または定常 P95 が基準超過）。**ウォームアップ失敗時や24時間未使用後の初回利用をユーザー影響として許容できない場合も非同期に倒す** | **Lambda/SQS＋クライアントポーリング**へ切替（`03b_step2_async.md`） |

- **25秒の根拠**：AppSync 実行上限は **30秒（変更不可）**。Lambda コールドスタート・複数画像取得・弱回線のばらつきを吸収する安全マージンとして 25秒を同期継続の目安とする（proposal §9 工程0 の失敗時基準と一致）。
- 同期継続時も、**デプロイ後・スキーマ変更後にウォームアップ（同一スキーマの事前コンパイル）** を工程2で必須化する（初回コンパイル最大数分・キャッシュ24時間の制約を吸収）。
- **本工程の完了条件は「方式決定」だけでなく「採用方式の設計・手順が実装着手可能であること」**。同期なら `03_step2_ai.md`、非同期なら `03b_step2_async.md` をそのまま着手できる状態で工程1〜2へ進む（UI 工程を非同期詳細設計の不足でブロックしない）。

#### ✅ 判定結果（2026-08-14）

| 判定条件 | 実測 | 可否 |
|---|---|---|
| (a) 初回コンパイル実測最大値 < 25秒 | 3,479ms（08-07・2枚）／当日初回 7,779ms（5枚） | ✅ Yes |
| (b) ウォームアップで初回を利用者経路から除外できる | 工程2で事前呼び出しを必須化する前提（(a) を単独で満たすため本判定は (a) に依拠） | ✅ Yes |
| 定常 P95 < 25秒（十分な余裕あり） | **6,691ms**（余裕 18,309ms） | ✅ Yes |

**判定：同期継続 → `../03_step2_ai.md`**

**🔴 この判定に付く重要な留保**：本計測は「**ローカルPC → Bedrock の単発呼び出し**」のみで、
**Lambda コールドスタート・S3 からの画像取得（5枚）・AppSync 経路・弱回線**を含んでいない。
したがって 25秒バジェットとの比較は**楽観側に振れている**。18.3秒の余裕でこれらを吸収できる見込みだが、
**工程2で Lambda 経由の E2E 再計測を行い、この判定を確定させること**。E2E で P95 が 25秒に迫る場合は `03b_step2_async.md`（非同期）へ切り替える。

**⚠ 工程2 着手前に `03_step2_ai.md` を修正すること**（同手順書は工程0の実測結果を反映していない）：

1. モデルID：`anthropic.claude-haiku-4-5-20251001-v1:0`（接頭辞なし）→ **`jp.anthropic.claude-haiku-4-5-20251001-v1:0`**。接頭辞なしは `ValidationException: on-demand throughput isn't supported` で必ず失敗する。
2. 構造化出力：Structured Outputs（`outputConfig`）→ **Tool Use（`toolConfig` + `toolChoice`）**。
3. `maxTokens`：500 → **1500**（実測 outputTokens 最大 563）。

---

## 成果物の記録（作業リポジトリ側に残す）

> 本ファイルは手順書。**疎通確認記録・実測値・実測トークンは、作業リポジトリ側**（`genbalog-spike/RESULTS.md`）に残すこと。
>
> ✅ **2026-08-14 に `genbalog-spike/RESULTS.md` を作成し、下記テンプレの全項目を記入済み**（24時間後の再計測のみ未取得）。
> **実測値の正本は `RESULTS.md`** です。本手順書内の実測値は参照の便宜のために転記した要約であり、
> 食い違いがあれば `RESULTS.md` を正とします。

**記録テンプレート（このままコピーして作業リポジトリに記入）**：

```md
# 工程0 技術スパイク 実測記録

- 実施日 / 判断日: 2026-__-__
- リージョン / 呼び出しID: ap-northeast-1 / jp.anthropic.claude-haiku-4-5-20251001-v1:0（推論プロファイル）
- モデルアクセス: [ ] Bedrock コンソール Model access で Haiku 4.5 が「Access granted」＆ Converse 成功
- IAM 疎通: [ ] bedrock:InvokeModel（推論プロファイル経由）で Converse 成功

## レイテンシ（最大画像枚数=5枚で計測）
※初回・24時間後は1標本のため単一値（実測値）のみ記録する。P50/P95 は定常計測にのみ適用。

| 計測条件 | 実測値(ms) | P50(ms) | P95(ms) | Max(ms) | 備考 |
|---|---|---|---|---|---|
| 初回コンパイル（新規/変更直後・単一値） |  | — | — | — | 初回はgrammarコンパイルで最大数分 |
| 定常（キャッシュ有効・同一スキーマ・N=__回） | — |  |  |  |  |
| 24時間超未使用後の再計測（単一値） |  | — | — | — | 再コンパイル発生の有無 |

## 実測 usage トークン
| 画像枚数 | inputTokens | outputTokens | totalTokens |
|---|---|---|---|
| 1枚 |  |  |  |
| 3枚 |  |  |  |
| 5枚 |  |  |  |
| CountTokens(参考) |  | — | — |

## 判定
- (a) 初回コンパイル実測最大値 < 25秒: [ ] Yes / [ ] No
- (b) ウォームアップで初回を利用者経路から確実に除外できる: [ ] Yes / [ ] No
- 定常 P95 < 25秒（十分な余裕あり）: [ ] Yes / [ ] No
- 判定: [ ] 同期継続（(a) or (b)、かつ定常OK）→ 03_step2_ai.md / [ ] 非同期化 → 03b_step2_async.md
- 結論と根拠:
- 工程2への申し送り（採用方式の手順書で実装着手可能なことを確認済みか）:
```

---

## 完了条件チェックリスト（proposal §9 工程0 と1対1）

- [x] **疎通成功**：Converse API + **Tool Use** + 画像入力（最大5枚）を **1リクエスト**で成功（**`stopReason=tool_use`**、4項目のJSONを取得）… 2026-08-07 成功／2026-08-14 に5枚条件で再確認
- [x] **モデルアクセス・IAM 疎通の確認記録**：日本 In-Region 推論プロファイル `jp.anthropic.claude-haiku-4-5-20251001-v1:0` にアクセス成功・記録済（`RESULTS.md`）
- [x] **初回実測値／定常 P95 を取得**：初回 3,479ms（単一値）・定常 P50 6,535 / P95 6,691 / Max 7,779ms（N=20）を記録済
      **24時間後の単一値も取得済**（2026-08-16・**7,852ms**・再コンパイルなし。`RESULTS.md` §1 に記録）
- [x] **実測 usage トークンを記録**：画像枚数別 input/output トークンを記録済（1枚 4,451 / 3枚 7,595 / 5枚 10,739）
- [x] **AppSync 30秒以内の可否が数値で判定できる**：判定表に基づき **同期継続**を確定・記録済（P95 6,691ms < 25,000ms）
- [x] **採用方式の手順書で実装着手可能**：`03_step2_ai.md` を確認。**モデルID・構造化出力方式・maxTokens の3点に修正が必要**なことを申し送り済（ステップ7）

> 進捗：**6項目中6項目が達成（2026-08-16 時点で必須項目に未取得なし）**。
> 工程0のゲート（同期／非同期の確定）は**クリア済み**のため、**工程1（`../02_step1_data.md`）に着手可能**。
> 残りは**任意項目のみ**：`count.ts`（CountTokens・ステップ6）／`strict: true` の可否確認。いずれも工程1のブロッカーではない。

---

## 失敗時の代替

- **`AccessDeniedException`（`aws-marketplace:Subscribe` 不足）**：モデルアクセス未登録。**ステップ1**でコンソールから有効化＋**ステップ2**の Marketplace 権限を確認（本PoCで実際に発生。詳細は「疎通トラブルシューティング ④」）。①Anthropic の初回用途入力の未提出、②管理者の IAM/SCP 制限、③東京リージョン選択、も併せて確認。
- **`ValidationException`（on-demand 非対応）**：素のモデルID `anthropic.claude-haiku-4-5-...` を指定している。**推論プロファイルID `jp.anthropic.claude-haiku-4-5-20251001-v1:0`** に変更する（「疎通トラブルシューティング ③」）。
- **`ValidationException`（400・スキーマ拒否）**：JSON Schema サブセット違反（差異注記2）。`minLength`/`maxLength`・数値制約・`additionalProperties!=false` を除去して再試行。
- **初回コンパイルでタイムアウト／30秒超過が安定して発生**：→ **非同期（Lambda/SQS＋クライアントポーリング）を採用**（手順は `03b_step2_async.md`）。判断日・判定基準（ステップ7の (a)/(b) と定常 P95）を記録し、UI 実装（工程3）前に方式を確定する。
- **初回のみ超過するが定常は速い**：工程2でウォームアップ（デプロイ後・スキーマ変更後の事前コンパイル）を必須化した上で同期継続を検討。なお24時間後の再コンパイルでも超過するなら非同期化。
- **さらに高い可用性を優先／将来リージョン拡張**：グローバル推論プロファイル `global.anthropic.claude-haiku-4-5-20251001-v1:0` へ切替可能（世界中のリージョンに振り分け）。ただし**データが海外リージョンに出る可能性**があるため、国内処理方針（proposal §6）では非推奨。本PoC 既定は日本 In-Region 推論プロファイル `jp.`。

---

## process.md 評価ゲート（A / A+ / S）との対応

- **本工程は A評価の主要素**：`process.md` A評価「AI生成（Bedrock 呼び出し）が動く」の到達条件を、本スパイクの疎通成功（Converse 応答取得）が直接満たす。**証拠＝疎通結果ログ（CloudWatch 相当のコンソール出力）・usage トークン**。
- **A+／S への橋渡し**：本工程で確定した同期／非同期方式が工程2〜3の実装前提となり、A+評価「ログイン→写真→AI生成→確定保存→一覧の一気通貫」の技術的成立性を担保する。
- 本工程は `process.md` §3 ストレッチ目標「AppSync 30秒上限を最大写真枚数の P95 で確認（or 非同期化）」の**前倒し検証**でもある（必須ゲートではないが工程0で数値化しておく）。
