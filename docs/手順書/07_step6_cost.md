# 工程6 実装手順書：実測コスト更新（proposal §9 工程6）

## 目的・前提

- **目的**：GenbaLog の生成1件あたり単価・月額（標準／上振れ）を、推測値ではなく**実測トークン**で確定させ、proposal §5 のコスト試算表と概算式を最新化する。あわせてコスト監視の仕上げを行う：**AWS Budgets・S3 Lifecycle は工程1、CloudWatch Logs 保持・Lambda reserved concurrency は工程2 で初期設定済み**のため、本工程ではそれらが有効に機能しているかの確認と実測に基づく見直しを行う。
- **依存する工程**：
  - **工程2 完了（generateReport が稼働し、Bedrock 生成が実行済み）** — 本手順は「生成が動いてログに usage が記録されている」ことを前提にする。工程2 未完了なら本手順は実施できない。
  - 併せて工程2 の「ログに記録する項目」（proposal §9 末尾：request ID・report ID の非可逆識別子・モデルID・latency・**usage トークン**・結果状態・冪等/重複抑止結果）が **CloudWatch Logs に構造化ログ（JSON）で出力されている**こと。これが実測集計の一次情報になる。
  - **工程0（技術スパイク）の記録を起点にする**：工程0 で**画像枚数別の実測 usage トークン・CountTokens 値**が作業リポジトリ側の `RESULTS.md` テンプレに記録される。工程6 の実測集計はまずこの記録を参照し、運用ログ（工程2）の集計で補強・更新する。
  - モデルA/B（本書ステップ5・任意）は**工程4（品質評価）の固定評価セット**を再利用する。
- **process.md ゲートとの対応**：本工程は A→A+→S の必須ゲートではなく、**ストレッチ目標「実測コストで単価・月額を更新」**（process.md §3・§5 チェックリスト）に対応する。S 評価到達後の作り込みとして実施する。
- **モデル／リージョン（全手順共通・厳守）**：
  - Bedrock モデルID：`anthropic.claude-haiku-4-5-20251001-v1:0`
  - リージョン：`ap-northeast-1`（東京）

---

## ステップ1：実測トークンの取得

実測入力／出力トークンを得る方法は2通り。**(A) 実レスポンス usage の集計を主**とし、**(B) CountTokens を事前計測・裏取り**に使う。

### 1-1. 方法A：Converse レスポンスの `usage` を集計（推奨・主）

工程2 で Converse（または InvokeModel）を使って生成しているため、レスポンスの `usage` フィールドに実測トークンが入る。Converse レスポンスの構造は以下（AWS 公式 *Inference using Converse API* に準拠）：

```jsonc
// 参照: Bedrock Converse レスポンス（bedrock-runtime）
{
  "output": { "message": { "role": "assistant", "content": [ { "text": "..." } ] } },
  "stopReason": "end_turn",
  "usage": {
    "inputTokens": 125,     // 実測入力トークン（画像＋プロンプト＋テキスト入力の合算）
    "outputTokens": 60,     // 実測出力トークン
    "totalTokens": 185
  },
  "metrics": { "latencyMs": 1175 }
}
```

- プロンプトキャッシュ利用時は `usage.cacheReadInputTokens` / `usage.cacheWriteInputTokens` も返る（本PoCでは通常未使用）。
- **工程2 のログ設計（03_step2_ai.md ステップ3・00 §3.5）**では、この Converse レスポンスの値を**トップレベルの統一フィールド**（`modelId` / `status` / `resultStatus` / `inputTokens` / `outputTokens` / `totalTokens` / `latencyMs` / `photoCount` / `idempotent`）として、**画像・プロンプト本文を残さず**構造化ログに出力する（proposal §6・§9 末尾と整合）。下のクエリはこのフィールド名を前提とする（**工程2 の `logLine` と1対1で一致**。変更時は両方を同時に更新すること）。

**CloudWatch Logs Insights での集計クエリ例**（Lambda `generateReport` のロググループに対して実行）：

```sql
-- 実行場所: CloudWatch Logs Insights（リージョン ap-northeast-1、対象ロググループ = generateReport の Lambda）
-- 前提: 工程2 のログがトップレベル JSON で
--   { modelId, status, resultStatus, inputTokens, outputTokens, totalTokens, latencyMs, photoCount, idempotent }
--   を出力していること（03_step2_ai.md の logLine と同一フィールド名）
-- 注: status = "SUCCEEDED" は新規生成のみ。冪等ヒット（IDEMPOTENT_HIT）は Bedrock 課金が
--     発生しないため単価集計から除外される（二重課金抑止の効果測定には status = "IDEMPOTENT_HIT" を数える）
fields inputTokens, outputTokens, latencyMs
| filter status = "SUCCEEDED" and modelId = "anthropic.claude-haiku-4-5-20251001-v1:0"
| stats
    count(*)              as generations,
    avg(inputTokens)      as avg_input_tokens,
    pct(inputTokens, 95)  as p95_input_tokens,
    avg(outputTokens)     as avg_output_tokens,
    pct(outputTokens, 95) as p95_output_tokens,
    avg(latencyMs)        as avg_latency_ms,
    pct(latencyMs, 95)    as p95_latency_ms
```

- **標準ケースの代表値**＝ `avg_input_tokens` / `avg_output_tokens`、**上振れケース**＝ `p95_input_tokens` / `p95_output_tokens` を採用する（写真枚数が多いケースが上振れに相当）。
- 写真枚数別に見る場合は `| stats ... by photoCount` で分解する（`photoCount` は工程2 のログに含まれている）。
- 二重課金抑止の効果は、同じログから `filter status = "IDEMPOTENT_HIT" | stats count(*)` で冪等ヒット件数を集計して確認できる。

### 1-2. 方法B：CountTokens API での事前計測（裏取り・任意）

生成を実行する前に、同一入力を送ったときの課金トークン数を**推論を実行せずに**取得できる（Bedrock `CountTokens` API、`bedrock-runtime`）。公式ドキュメント（*CountTokens*）＋工程0 の裏取り結果より要点：

- **入力**：`modelId`（トークナイザはモデル固有）＋ `input`。`input` は **Union 型**で、Converse 用は `converse`（messages / system / toolConfig）フィールド、InvokeModel 用は `invokeModel`（リクエストボディ）フィールドに指定する（**いずれか一方**）。工程2 が Converse なら `converse` を使う。
- **返り値**：そのモデルで `InvokeModel` / `Converse` に同じ入力を送った場合と**一致する課金トークン数**。
- **料金**：**無料**（工程0 裏取りで確認済み。課金カウントと一致した値を返す）。
- **必要な IAM アクション**：`bedrock:CountTokens`。**`bedrock:InvokeModel` とは別に付与が必要**（工程2 で generateReport Lambda ロールに InvokeModel を付与済みでも、CountTokens を呼ぶ主体には CountTokens を別途追加すること）。
- 用途（公式明記）：推論前のコスト見積り、プロンプトのトークン上限最適化。

```python
# 実行場所: ローカル or Lambda（boto3, リージョン ap-northeast-1）
# 目的: 生成を実行せず、代表写真セット＋プロンプトの実測入力トークンを取得
import boto3

brt = boto3.client("bedrock-runtime", region_name="ap-northeast-1")

resp = brt.count_tokens(
    modelId="anthropic.claude-haiku-4-5-20251001-v1:0",
    input={
        "converse": {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"image": {"format": "jpeg", "source": {"bytes": image_bytes}}},  # 代表写真
                        {"text": "（工程2で使うプロンプト＋現場/日付/工種/当日メモ/翌日予定）"},
                    ],
                }
            ],
            # system や toolConfig（Structured Outputs のスキーマ）も工程2 と同一構成で渡す
        }
    },
)
print(resp["inputTokens"])  # ← 課金対象と一致する入力トークン数
```

**IAM（CountTokens を呼ぶ主体に付与）**：`bedrock:InvokeModel` とは別に `bedrock:CountTokens` が必要。

```typescript
// ファイル: amplify/backend.ts（CountTokens を Lambda から呼ぶ場合）
// 目的: generateReport ロールに CountTokens を追加（InvokeModel とは別アクション）
import { PolicyStatement } from "aws-cdk-lib/aws-iam";

backend.generateReportFunction.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["bedrock:CountTokens"],
    resources: [
      // 東京 In-Region の foundation-model ARN（proposal §6 と同一方針）
      "arn:aws:bedrock:ap-northeast-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
    ],
  }),
);
```
> ローカル計測（boto3）で呼ぶ場合は、実行する IAM ユーザー/ロールに同アクションを付与する。

---

## ステップ2：単価計算ワークシート

proposal §5 の概算式に実測値を代入して、1生成単価・月額を再計算する。

**概算式（proposal §5）**：

```text
Bedrock月額 = 日報数 × 平均生成回数 ×
  ((平均入力token / 1,000,000 × 入力単価) +
   (平均出力token / 1,000,000 × 出力単価))
```

**単価**：**実施日時点の Amazon Bedrock 料金ページ（東京リージョン・該当 service tier）**で確認した値を記録して用いる。proposal §5 は暫定値として入力 **$1** / 出力 **$5**（per 100万トークン）を記載しているが、この暫定値をそのまま採用せず、必ず料金ページで実値を確認して記入する。
> 実施時に**東京リージョンの Bedrock 料金ページ**で単価を確認し、差があれば本ワークシートに反映（後述の差異注記に記録）。確認日と参照 URL を証跡に残す。

**実測値 記入ワークシート（Markdown 表テンプレ）**：

| 項目 | 標準ケース（実測） | 上振れケース（実測） | 取得元 |
|---|---|---|---|
| 平均入力トークン / 生成 | `______` | `______`（P95） | ステップ1-1 クエリ |
| 平均出力トークン / 生成 | `______` | `______`（P95） | ステップ1-1 クエリ |
| 入力単価（$ / 100万token） | `1.0` | `1.0` | 東京料金ページで確認 |
| 出力単価（$ / 100万token） | `5.0` | `5.0` | 東京料金ページで確認 |
| **1生成 入力コスト** = 入力token/1e6×入力単価 | `$______` | `$______` | 計算 |
| **1生成 出力コスト** = 出力token/1e6×出力単価 | `$______` | `$______` | 計算 |
| **1生成単価** = 入力+出力 | `$______` | `$______` | 計算 |
| 日報数 / 月 | `100` | `300` | proposal §5 前提 |
| 平均生成回数 / 日報 | `1.1` | `2.0` | proposal §5 前提 |
| **Bedrock 月額** = 日報数×生成回数×1生成単価 | `$______` | `$______` | 計算 |

**計算チェック（proposal §5 の従来概算値：埋め込み確認用）**：標準 ≈ $0.94/月（1生成 $0.0085）、上振れ ≈ $6.9/月。実測がこの桁から大きく外れる場合は、ログの usage 集計条件（`status = "SUCCEEDED"`、モデルID フィルタ、写真枚数分布）を見直す。

**検算スニペット（任意）**：

```python
# 実行場所: ローカル（電卓代わり。実測値を代入）
def gen_unit_cost(in_tok, out_tok, in_price=1.0, out_price=5.0):
    return in_tok/1_000_000*in_price + out_tok/1_000_000*out_price

def monthly(reports, gens_per_report, unit_cost):
    return reports * gens_per_report * unit_cost

u = gen_unit_cost(in_tok=6000, out_tok=500)          # ← 実測入力/出力に置換
print("1生成単価 $", round(u, 4))
print("月額 $", round(monthly(100, 1.1, u), 2))       # 標準
```

---

## ステップ3：proposal §5 表の更新手順（更新作業自体はチーム判断）

実測が固まったら、proposal.md の以下の箇所を更新する。**どの数値をどこに反映するか**のみ示す（実際に書き換えるかはチーム判断）。

1. **proposal §5 の Bedrock 概算ブロック**（「Bedrock の概算（Claude Haiku 4.5 …）」）
   - 「画像1枚 ≈ 最大約1,600トークン」→ 実測の画像1枚あたりトークンに更新
   - 「入力 ≈ 約6,000トークン」→ 実測 `avg_input_tokens` に更新
   - 「1生成 ≈ … ＝ $0.0085/生成」→ ワークシートの**1生成単価（標準）**に更新
   - 「標準：… ≈ $0.94/月」「上振れ：… ≈ $6.9/月」→ ワークシートの**Bedrock 月額**に更新
2. **proposal §5 表A/表B の Bedrock 行と合計行**
   - **表A（通常料金：無料枠を引かない）**の Bedrock 行「標準ケース概算 約 $0.94」「上振れケース概算 約 $6.9」→ 実測値に更新
   - **表B（実支払見込み：無料枠・Expo Free plan 適用後）**の Bedrock 行も、無料枠適用後の実支払見込みに更新
   - Bedrock 行を更新したら表A・表Bの**合計行**もそれぞれ再計算
3. **更新の証跡**：更新日・採用した集計期間・件数（`generations`）・単価取得日をコミットメッセージまたは本ワークシートに残す（再現性の担保）。
4. **EAS Build（Expo）の単価確認**：expo.dev/pricing で (a) 現行 Free plan のビルド枠（月あたり本数・対象プラットフォーム）、(b) 枠超過時／on-demand のビルド単価（Android/iOS 別）を確認し、proposal §5 **表A**（通常料金：約10〜30回/月 × 単価）の「要記入」欄と**表B**（実支払見込み：Free plan 枠内なら $0）を記入・更新する。確認日と参照 URL を証跡に残す。

> 注：proposal §5 脚注は既に「実装着手後に CountTokens または実レスポンスの usage でモデル固有値を確認し、上表と概算式を更新する（§9）」と予告済み。本工程はこの予告の実行。

---

## ステップ4：コスト監視の確認・調整

低コストを「設計・運用で担保する」ためのガードレール（proposal §6「コスト監視」「保存とログの保持」と1対1）。**AWS Budgets・S3 Lifecycle は工程1（`02_step1_data.md` ステップ4-3）、CloudWatch Logs retention は工程2（`03_step2_ai.md` ステップ2 (5)）、Lambda reserved concurrency は工程2（`03_step2_ai.md` ステップ2 (6)）で初期設定済み**。本工程では「設定が有効に機能しているか」の確認と、実測に基づく調整・見直しを行う（本工程での新規設定はない）。

### 4-1. AWS Budgets（初期設定の確認と実測に基づく見直し）

工程1で月次 $10・`ACTUAL 50/80/100%`＋`FORECASTED 100%` のメール通知を設定済み（CDK `CfnBudget`。スニペットは `02_step1_data.md` ステップ4-3）。本工程では：

1. **有効性確認**：Billing and Cost Management コンソール → Budgets で `GenbaLog-monthly` が存在し、subscriber のメールアドレスが正しいことを確認。閾値到達時にメールが届いた実績（または Budgets のアラート履歴）を証拠として残す。
2. **実測に基づく見直し**：ステップ2 の実測月額（標準／上振れ）に対して予算額 $10 が適切かを判断し、乖離が大きければ予算額・閾値を更新する（`02_step1_data.md` の `CfnBudget` の `budgetLimit` を変更して再デプロイ、またはコンソールで編集）。
3. **反映遅延の注意**：Budgets の更新は1日最大3回（前回更新から8〜12時間後）。リアルタイム監視ではない。

> ⚠ 役割分担：AWS Budgets は**通知**であり、Bedrock 呼び出しを停止する機構ではない（反映も1日最大3回）。呼び出し側の上限はアプリ側のサーバー quota（Report 単位・ユーザー×日次。`03_step2_ai.md` ステップ3 (D')）と reserved concurrency（補助）が担う。Budgets 通知を受けたら quota 値・利用状況を見直す運用とする。

> ⚠ 差異注記②：proposal §6 は「AWS Budgets に Anthropic 課金を含むか確認」と記載。Cost Explorer / Budgets は **AWS アカウント上の Bedrock 利用料**を捕捉する。本PoC は Bedrock 経由（東京 In-Region 直接）で Anthropic モデルを呼ぶため課金は AWS 請求に含まれ Budgets で捕捉できる。Anthropic API を**直接**契約する構成ではない限り別課金は発生しない。実施時に請求ダッシュボードで Bedrock の課金計上を実確認すること。

### 4-2. Lambda reserved concurrency（暴走時の速度・コスト抑制）※工程2で設定済み——本工程では有効性確認と見直し

`generateReport` Lambda の予約同時実行数（`reservedConcurrentExecutions`）は、想定外の連続呼び出しによる Bedrock 二重課金・費用暴走の同時実行上限として **工程2（`03_step2_ai.md` ステップ2 (6)）で 2〜5 に設定済み**。本工程では新規設定は行わず、有効性確認と実測に基づく見直しのみを行う。

1. **設定済みの確認**：Lambda コンソール → `generateReport` 関数 → 「設定」→「同時実行数」で、予約された同時実行数が工程2で設定した値（2〜5）になっていることを確認する（未設定＝アカウント共有プールのままなら工程2の設定漏れなので差し戻す）。
2. **実測に基づく見直し**：ステップ1・2 で得た実測の同時利用状況（同時生成の件数・ピーク）に対して値が適切かを判断し、変更する場合は `03_step2_ai.md` の CDK 定数（`reservedConcurrentExecutions`）を更新して再デプロイする（本工程で直接コンソール値を書き換えると IaC と乖離するため避ける）。
3. **役割分担の明確化**：reserved concurrency は**同時実行数を絞る**だけで、時間をずらした連続生成やユーザー単位の予算超過は止められない。呼び出し回数・ユーザー単位の上限は**サーバー側 quota（Report 単位・ユーザー×日次。`03_step2_ai.md` ステップ3 (D')）が正本**として担い、reserved concurrency はその補助（同時実行の頭打ち）に位置づける。

### 4-3. S3 Lifecycle（初期設定の確認）

工程1で `media/` に 30日 expiration＋未完了 multipart abort（1日）を設定済み（CDK スニペットは `02_step1_data.md` ステップ4-3）。本工程では：

1. S3 → 対象バケット → Management → Lifecycle rules に `genbalog-photo-retention` が Enabled で存在することを確認。
2. 運用開始から30日以上経過している場合、`media/` 配下の古いオブジェクトが実際に削除されていること（削除実績）を確認し、証拠として残す。
3. 保持日数を変える場合は工程1の `addLifecycleRule` を更新して再デプロイし、proposal §5 の前提（30日）との差異を本ワークシートに記録する。

### 4-4. CloudWatch Logs 保持（初期設定の確認）

工程2で `generateReport` のロググループに retention 14日を設定済み（`03_step2_ai.md` ステップ2 (5)）。本工程では：

1. CloudWatch → Log groups → `/aws/lambda/...generate-report` の Retention が **2 weeks（または7〜14日の設定値）** になっていることを確認。`Never expire` のままなら工程2の設定漏れなので差し戻す。
2. proposal §6・§9 末尾どおり、**画像・プロンプト本文がログに出ていない**こと（usage/latency/識別子のみ）をサンプリング確認する。

---

## ステップ5（任意）：モデルA/B — Claude Haiku 4.5 vs Amazon Nova Lite

proposal §9 工程6 モデルA/B。**同一写真セット（工程4の固定評価セット）**で比較し、品質基準を満たす最安モデルを既定にする。

- **モデルA**：`anthropic.claude-haiku-4-5-20251001-v1:0`（東京 In-Region、本PoC 既定）
- **モデルB**：Amazon Nova Lite — 公式（*What is Amazon Nova?*）で **Asia Pacific (Tokyo) 対応**・**入力 Text/Image/Video 対応**・**Converse API 対応**を確認済み。低コスト・マルチモーダル。
  - モデルID：`amazon.nova-lite-v1:0`（東京で In-Region 直接呼び出しが可能か実施時に疎通確認。クロスリージョン推論プロファイル `us.amazon.nova-lite-v1:0` は米国向けで本PoC の「処理地域は東京」要件と不整合なので使わない）

**比較手順**：

1. 工程4 の評価セット（代表／不鮮明／無関係／情報不足 写真）を両モデルに**同一プロンプト・同一 Structured Outputs スキーマ**で投入。
2. 各モデルの `usage`（ステップ1）と `metrics.latencyMs` を記録。Nova Lite の単価は東京料金ページで取得し、ステップ2 のワークシートで**1件単価**を算出。
3. 下表で比較：

| 評価軸 | Claude Haiku 4.5 | Nova Lite | 測定方法 |
|---|---|---|---|
| 項目充足率（必須4項目） | `___%` | `___%` | 工程4 KPI |
| 安全指摘の質（確認/未確認分離） | `___` | `___` | 工程4 の安全項目基準 |
| 日本語品質 | `___` | `___` | 目視レビュー |
| P95 latency | `___ms` | `___ms` | ステップ1 クエリ |
| 1件単価 | `$___` | `$___` | ステップ2 ワークシート |

4. **判定**：proposal §9 工程4 の合格値（充足率≥90%、事実誤認率≤5%、要確認が推測で埋まらない）を満たすうち**最安**を既定にする。品質が基準未達なら安さに関わらず不採用。

> ⚠ 差異注記③：Nova Lite の Max Output Tokens は公式内で表記揺れあり（*What is Amazon Nova?* 一覧表は 10k、モデルカード *Nova Lite* は 5K）。本PoC は出力 `maxTokens` を 500 以下（proposal §5）に固定するため実害はないが、A/B 時は両モデルとも同一 `maxTokens` を明示指定して条件を揃えること。

---

## 完了条件チェックリスト（proposal §9 工程6 と1対1）

- [ ] 実測入力／出力トークンを取得した（方法A：CloudWatch Logs Insights で usage 集計 ／ 任意で方法B：CountTokens）
- [ ] ステップ2 ワークシートに実測値を代入し、1生成単価・Bedrock 月額（標準／上振れ）を再計算した
- [ ] proposal §5 の概算ブロック・月額表・合計の**更新箇所**を特定した（更新実施はチーム判断）。表A（通常料金）と表B（実支払見込み）を分離したまま更新する（無料枠内 $0 を表Aに混ぜない）
- [ ] EAS Build の Free plan 枠・超過単価を expo.dev/pricing で確認し、表A/表B に記入した
- [ ] **標準ケースが「実質 月額数ドル以内」に収まる**ことを実測で確認した（proposal §9 工程6 完了条件）
- [ ] AWS Budgets：工程1の初期設定（月次予算＋ACTUAL 50/80/100%・FORECASTED 100% 通知）が有効であることを確認し、実測月額に基づき予算額・閾値を見直した
- [ ] reserved concurrency（工程2で設定済み）が有効であることを確認し、実測に基づき値を見直した
- [ ] S3 Lifecycle：工程1の初期設定（`media/` 30日 expiration＋multipart abort 1日）が有効で、削除が機能していることを確認した
- [ ] CloudWatch Logs：工程2の retention 設定（7〜14日）が反映されており、画像・プロンプト本文を出力していないことを確認した
- [ ]（任意）モデルA/B：Haiku 4.5 と Nova Lite を同一評価セットで比較し、品質基準を満たす最安モデルを既定にした

## 失敗時の対処

- **usage がログに無い / 集計できない**：工程2 のログ設計（03_step2_ai.md の `logLine`）に戻り、トップレベルの `inputTokens` / `outputTokens` / `totalTokens` / `latencyMs` / `status` / `photoCount` が出力されているか確認してから再集計（ネストした `usage.*` のままだと本工程のクエリでは集計できない）。工程2 未完了なら本工程は保留。
- **実測が概算と桁違い**：集計フィルタ（`status = "SUCCEEDED"`、モデルID、写真枚数分布）を点検。画像トークンは枚数・解像度で大きく変動するため、写真圧縮（長辺1,568px／proposal §6）が効いているかを確認。
- **標準ケースが月額数ドルを超える**：写真枚数上限・`maxTokens`・平均生成回数（冪等キーで二重生成抑止）を proposal §6 のガードレール通り締める。それでも超えるならモデルA/B で Nova Lite を検討。
- **CountTokens が東京で未提供だった**：CountTokens 自体は無料・課金一致（工程0 確認済み）だが、万一 `ap-northeast-1` で未提供でも方法A（実レスポンス usage）のみで完了条件を満たせるため、方法B は省略可。
- **Budgets が Bedrock 課金を捕捉していない**：請求ダッシュボードで Bedrock の計上を確認。Anthropic 直接契約でない限り AWS 請求に含まれる（⚠ 差異注記②）。
- **Nova Lite が東京で In-Region 直接呼び出しできない**：処理地域=東京の要件を優先し、モデルB を見送る（本PoC 既定は Haiku 4.5 のまま）。

---

### ⚠ 差異注記まとめ（proposal.md は書き換えず本書に記録）

1. **CountTokens の「無料」表記**：proposal §5 脚注「CountTokens（無料）」は**工程0 の裏取りで確認済み**（無料・課金カウントと一致）。差異なし。呼び出しには `bedrock:CountTokens` IAM アクションが `bedrock:InvokeModel` とは別に必要な点に留意（本書ステップ1-2 に反映済み）。`ap-northeast-1` での API 可用性のみ実施初回に疎通確認する。
2. **Budgets と Anthropic 課金**：Bedrock 経由（東京 In-Region）なら課金は AWS 請求に計上され Budgets/Cost Explorer で捕捉可能。Anthropic 直接契約でない限り別課金なし（proposal §6 の「含むか確認」の回答）。
3. **Nova Lite の Max Output Tokens 表記揺れ**：公式内で 10k（一覧表）と 5K（モデルカード）が併存。本PoC は `maxTokens` を明示固定するため実害なし。
