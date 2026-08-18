# GenbaLog — プロジェクト概要

> このファイルは Claude Code 向けの「プロジェクトの前提知識・地図」です。
> 振る舞いルール（作法）は `.claude/CLAUDE.md`、Codex 用ルールは `AGENTS.md` にあります。

## これは何か
建築現場向けAI日報アプリ「GenbaLog」のPoC（デモアプリ）。
現場で撮った写真＋最小テキスト入力（現場/日付/工種/当日メモ/翌日予定）を
Amazon Bedrock（Claude）が解析し、日報ドラフトを自動生成する。
**要件の正は `docs/proposal.md`**（本ファイルは要約＋地図のみ）。

## 技術スタック
- フロント: React Native (Expo) ※Web(Next.js)は不採用（proposal §4 決定記録）
- バックエンド: AWS Amplify Gen2 (Cognito / AppSync+DynamoDB / S3 / Lambda)
- AI: Amazon Bedrock / Claude Haiku 4.5 / 日本 In-Region 推論プロファイル
      **`jp.anthropic.claude-haiku-4-5-20251001-v1:0`**
      ⚠ 接頭辞なしの素のID `anthropic.claude-haiku-4-5-...` は **on-demand 非対応**で
      `ValidationException: on-demand throughput isn't supported` になる（工程0で実測）

## ディレクトリ地図
- `docs/proposal.md` ……… 提案書（要件の正・最重要）
- `docs/手順書/` …………… 実装手順（工程0〜6）※同名の `.md` と `.html` は対。**更新時は両方**
    - `0_step/00_overview.md` … 全体像・環境準備
    - `1_step/01_step0_spike.md` … 技術スパイク（✅完了）
    - `1_step/構造化出力_次の手順（手順②）.md` … Tool Use 採用に至る経路探索の記録
    - `02_step1_data.md` … 認可付き Data/Storage ← **次はここ**
    - `03_step2_ai.md` / `03b_step2_async.md` … AI処理（同期/非同期）→ **同期を採用**
    - `04_step3_ui.md` … UI統合
    - `05_step4_quality.md` … 品質評価
    - `06_step5_error.md` … 異常系テスト
    - `07_step6_cost.md` … 実測コスト更新
- `genbalog-spike/` ……… 工程0のスパイク実装（**別 git リポジトリ**）
    - `spike-lib.ts` … 本体（`generateReport()` を export）
    - `spike.ts` … 疎通1回の薄いCLI ／ `measure.ts` … N回反復して P50/P95/Max
    - **`RESULTS.md`** … 工程0の実測値・判定の**正本**
    - `images/` … 配筋の実写真5枚（出典は `CREDITS.md`。CC BY/BY-SA のため削除禁止）
    - `images_irrelevant/` … 工程4の「無関係写真」評価ケース素材
- `spec/` ……………………… 仕様・Codexレビュー結果の保存先
    - `html/step0_spike_tooluse.html` … outputConfig → Tool Use 切替の検証記録
    - （レビュー結果は `spec/codexレビュー/YYYYMMDD/` 配下に保存。現在は空）

## 重要な設計判断（触る前に知っておくこと）
- 認可は `allow.owner()`（本人のみ）。guest/public/API key は使わない
- AppSync 30秒上限が最重要リスク → **工程0で「同期」に決定済み（2026-08-14）**
  実測 P95 **6,691ms**（5枚・N=20）で目安25秒に対し余裕18.3秒 → 工程2は `03_step2_ai.md`
  🔴 ただしこの計測は Lambda/S3/AppSync/弱回線を**含まない**。工程2で E2E 再計測が必要
- 冪等キー: `reportId + imageSetHash + inputHash + promptVersion + modelId + schemaVersion`
- 写真は長辺1568pxに圧縮、出力は `maxTokens` で上限
- **JSON強制は Tool Use（`toolConfig` + `toolChoice`）を使う**
  ⚠ Bedrock版 Claude Haiku 4.5 は `outputConfig.textFormat`（Structured Outputs）**非対応**
  （`jp.`/`apac.`/`global.` 全経路で 400 `output_config.format: Extra inputs are not permitted`）
  成功サインは `end_turn` ではなく **`stopReason: tool_use`**。結果は `content[].toolUse.input`（parse不要）
- `maxTokens` は **1500**。Tool Use はツール引数のJSONも出力トークンを消費するため 500 では切れる
  （実測 outputTokens: 1枚437 / 3枚556 / 5枚563）
- 実測トークン: 入力は画像1枚あたり **+1,572**（線形）、ベース2,879 → 5枚で 10,739

## 工程の進捗（2026-08-14 現在）
- 工程0（技術スパイク）… ✅ **完了**（実測値の正本 = `genbalog-spike/RESULTS.md`）
  - 2026-08-16 に 24時間超未使用後の再計測を実施（**7,852ms・再コンパイルなし**）→ **必須項目の残なし**
  - 残は任意項目のみ: `count.ts`（CountTokens）／`strict: true` の可否確認
- 工程1〜6 … ⬜ 未着手。**次は `docs/手順書/02_step1_data.md`（工程1）**
- ⚠ `03_step2_ai.md` は工程0の実測を未反映。着手前に modelId / Tool Use / maxTokens の3点を要修正

## 用語集
- Report = 日報 / Site = 現場 / Photo = 写真（S3）
- `generateReport` … 日報生成の custom query（Lambda → Bedrock）

## 重要コマンド

すべて **`genbalog-spike/` 直下**で実行し、**`AWS_PROFILE=rag-app-admin` を前置き**する
（cd 忘れ → `ERR_MODULE_NOT_FOUND`／プロファイル忘れ → `CredentialsProviderError`）。

```bash
cd genbalog-spike
npx tsc --noEmit                                  # 型チェック
AWS_PROFILE=rag-app-admin npx tsx spike.ts        # 疎通1回（初回/24h後の単一値取得）
AWS_PROFILE=rag-app-admin npx tsx measure.ts 20   # 定常 P50/P95/Max（5枚 × 20回）
AWS_PROFILE=rag-app-admin npx tsx measure.ts 3 1  # 1枚のトークン（枚数別）
AWS_PROFILE=rag-app-admin npx tsx measure.ts 3 3  # 3枚のトークン
SLEEP_MS=3000 AWS_PROFILE=rag-app-admin npx tsx measure.ts 20   # throttle時は間隔を広げる
IMAGE_DIR=./images_irrelevant AWS_PROFILE=rag-app-admin npx tsx spike.ts  # 無関係写真での回帰（工程4用）
```

⚠ 計測中は `spike-lib.ts` のプロンプト・スキーマ・`temperature`・`maxTokens` を変更しないこと
（「同一条件で回す」のが計測の前提）。

**未導入**（工程1着手時に追記）：`npx ampx sandbox` … 個人サンドボックスへデプロイ
（現時点で `amplify/` ディレクトリと Expo アプリは未作成。存在するのは `genbalog-spike/` のみ）