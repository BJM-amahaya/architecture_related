# 00 全体概要・共通規約（GenbaLog 実装手順書）

現場AI日報「GenbaLog」PoC の実装手順書シリーズの入口。まず本ファイルを読み、環境・共通規約・ゲート対応を把握してから各工程ファイルに進む。

- 上位資料：`spec/plan7/proposal.md`（提案書。本手順書の「§N」はこの§を指す）、`spec/plan7/process.md`（A→A+→S 評価ゲートの正本。**v2**：S は S-tech／S-accept に分離）
- 技術構成：Amplify Gen2 + CDK + Amazon Bedrock（Claude Haiku 4.5 / 東京 In-Region 直接）+ **React Native (Expo)**（2026-07-10 チーム決定。proposal §4 決定記録）

---

## 目的・前提（依存する工程）

- **目的**：以降の全工程ファイルが従う「環境前提・共通規約・アーキテクチャ・ゲート対応・コスト前提」を一元化する。
- **前提**：本ファイルに依存工程はない（シリーズの起点）。各工程ファイルは本ファイルの共通規約を前提とする。
- **最優先ゲート**：**工程0（技術スパイク）が実装初日の最優先ゲート**。同期／非同期方式の確定前に UI 実装へ進まない（§9）。

---

## 1. 手順書全体の構成と読み進め方

以下9ファイルを**番号順に読む**。ただし着手は工程0を最優先し、その判定結果で工程2以降の実装方式が変わる。

| 順 | ファイル | 対応工程（§9） | 概要 |
|---|---|---|---|
| 0 | `00_overview.md`（本ファイル） | 全体 | 環境前提・共通規約・アーキ・ゲート対応・コスト前提 |
| 1 | `01_step0_spike.md` | 工程0（最優先ゲート） | Bedrock 疎通・Structured Outputs・画像入力・初回コンパイル実測＋定常 P95 計測。**同期/非同期を確定** |
| 2 | `02_step1_data.md` | 工程1 | `defineAuth`/`defineData`/`defineStorage`。`allow.owner()`・S3 本人分離・Block Public Access |
| 3 | `03_step2_ai.md` | 工程2（同期方式） | custom query `generateReport`・IDOR 再検証・冪等キー（lease 状態機械）・quota・Structured Outputs・ウォームアップ |
| 3b | `03b_step2_async.md` | 工程2（非同期方式） | 工程0で非同期判定となった場合の完全手順（受付＋SQS＋worker＋ポーリング） |
| 4 | `04_step3_ui.md` | 工程3 | 撮影＋最小テキスト入力 → 生成 → 確認・微修正 → 確定 → 一覧・PDF（Expo / expo-print） |
| 5 | `05_step4_quality.md` | 工程4 | S-tech 前の最小品質スモーク＋固定評価セットで充足率・事実誤認率・要確認率・修正文字率・時間短縮率を測定 |
| 6 | `06_step5_error.md` | 工程5 | 認可違反否定テスト・throttle/timeout・再試行回復（FAILED/lease）・重複クリック・入力変更再生成・弱回線の異常系 |
| 7 | `07_step6_cost.md` | 工程6 | 実測 usage トークンで §5 概算式・月額表を更新。任意でモデルA/B |

**読み進め方の原則**：
1. 本ファイル（00）で環境・規約を整える。
2. `01_step0_spike.md` を実施し、**「初回コンパイルの実測最大値 < 25秒、またはウォームアップで初回を利用者経路から確実に除外できること（かつ定常 P95 に十分な余裕）」なら同期継続、満たせなければ非同期化**を確定（§9 工程0）。非同期化の場合は `03b_step2_async.md` を工程2の手順書とする。
3. 確定した方式を前提に工程1→2→3 を実装（A→A+）。
4. 工程4（最小スモーク＋KPI）・5・6 と EAS 内部配布／通しデモで品質・安全・コストを固め、S-tech → S-accept 評価へ。

---

## 2. 前提環境

> 🔰 **このセクションのゴール（初学者向け）**
> §2 が終わると、次の3つが手元の Mac で揃った状態になります。ここが工程0以降のスタートラインです。
> 1. `node -v` でバージョンが表示される（開発ツールが入った）
> 2. `aws sts get-caller-identity` で自分のアカウント情報が返る（AWS 認証が通った）
> 3. 東京リージョンで Claude Haiku 4.5 を**実際に呼べる**（初回呼び出しで自動有効化。事前の有効化操作は不要）
>
> 以下は **Mac（macOS）** 前提です。コマンドは上から順にターミナルへ貼り付けて実行し、各手順の「**✅ こう表示されればOK**」を確認しながら進めてください。

### 2.1 開発ツールを入れる（Mac）

必要なツールと最低バージョン（AWS 公式 Amplify Gen2 の前提要件）：

| 項目 | 要件 | 確認コマンド |
|---|---|---|
| Node.js | **v18.16.0 以降**（LTS の 20 以降を推奨） | `node -v` |
| npm | **v6.14.4 以降** | `npm -v` |
| git | **v2.14.1 以降** | `git --version` |

#### 手順①：ターミナルを開く
`⌘（command）＋ space` で Spotlight を開き、`ターミナル`（Terminal）と入力して Enter。黒い or 白い文字入力画面が出ればOK。以降のコマンドはここに貼り付けます。

#### 手順②：Homebrew（Mac 用のソフト管理ツール）を入れる
まず入っているか確認します。

```bash
# 実行環境：ローカルシェル（Mac のターミナル）
brew -v
```

> ✅ こう表示されればOK：`Homebrew 4.x.x` のようにバージョンが出る（＝すでに入っている。手順③へ）。
> ❌ `command not found: brew` と出たら未導入。下記の**公式1行コマンド**で入れます。

```bash
# 実行環境：ローカルシェル（Mac のターミナル）／Homebrew 公式インストールコマンド
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

> ⚠ 導入前の注意：これは Mac に新しいツールを入れる操作です。実行すると管理者パスワードを求められる場合があります。**内容を理解した上で**実行してください（不安な場合はチームに確認）。インストール後、画面末尾に出る「Next steps」の `PATH` 追記コマンドがあれば、その指示にも従ってください。

#### 手順③：Node.js を入れる
Homebrew で入れます（最新の Node.js が入り、要件の v18.16 以上を満たします）。

```bash
# 実行環境：ローカルシェル（Mac のターミナル）
brew install node
node -v
npm -v
```

> ✅ こう表示されればOK：`node -v` が **`v20.x.x` 以上**（例：`v24.14.0`）、`npm -v` が数字（例：`11.9.0`）を返す。数字の頭が **18.16 以上**なら合格です。

> ⚠ 補足（バージョンを切り替えたい人向け）：複数の Node バージョンを使い分けたい場合は `nvm`（`brew install nvm`）を使い、`nvm install 20` → `nvm use 20` で 20 LTS に固定できます。導入後は brew が画面に出す `~/.zshrc` への追記指示に従ってください。**必須ではありません**（`brew install node` だけで OK）。

#### 手順④：git を確認する
Mac には最初から git が入っていることが多いです。

```bash
# 実行環境：ローカルシェル（Mac のターミナル）
git --version
```

> ✅ こう表示されればOK：`git version 2.x.x`（例：`git version 2.50.1`）が出る。もし「開発者ツールを入れますか」というポップアップが出たら、指示に従って Xcode Command Line Tools を入れれば git も入ります。

#### Amplify で使うコマンド（この時点では覚えるだけでOK）
- バックエンド作成：`npm create amplify@latest`（工程1で実行）
- 個人サンドボックス起動：`npx ampx sandbox`（Gen2 CLI は `ampx`。旧 `amplify` CLI ではない）
- チーム各自が独立した sandbox で A→A+ を取る運用（§process.md-4）。

> ⚠ 差異注記（Node バージョン）：公式 Amplify Gen2「Set up AI」ページの最小要件は **Node.js v18.16.0 以降**。ただし関連ツール（例：AWS Blocks）は Node.js 22 以降を要求するため、将来の拡張を見据えるなら **Node 20 LTS 以降**で統一するのが無難。proposal.md には Node バージョンの明記がないため差異ではなく補足として記載。

### 2.2 AWS アカウントと認証（aws configure）

Amplify や Bedrock を動かすには、ターミナルから AWS を操作する「鍵」を設定します。

#### 手順①：AWS CLI（AWS 操作ツール）を入れる
Mac 公式の pkg で入れるのが確実です（AWS 公式手順）。

```bash
# 実行環境：ローカルシェル（Mac のターミナル）／AWS 公式インストーラ
curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "AWSCLIV2.pkg"
sudo installer -pkg ./AWSCLIV2.pkg -target /
aws --version
```

> ✅ こう表示されればOK：`aws-cli/2.x.x Python/3.x.x Darwin/xx.x.x` のように `aws-cli/2`（バージョン2系）が出る。
> ※ `sudo` で Mac のログインパスワードを聞かれます（画面には表示されませんがそのまま入力→Enter）。ブラウザで `https://awscli.amazonaws.com/AWSCLIV2.pkg` を開いてダブルクリック導入でも可。

#### 手順②：アクセスキーを用意する
AWS コンソールにログイン → **IAM** → 対象ユーザー → **セキュリティ認証情報** タブ → 「**アクセスキーを作成**」で、`アクセスキー ID` と `シークレットアクセスキー` を控えます。

> ⚠ **セキュリティ注意（重要）**：シークレットアクセスキーは**パスワードと同じ**です。**Git にコミットしない・チャットに貼らない・他人に渡さない**。より安全な方法として、会社で **IAM Identity Center（SSO）** が用意されている場合は、アクセスキーの代わりに `aws configure sso` を使ってください（キーを PC に残さずに済みます）。どちらを使うかはチームの方針に合わせます。

#### 手順③：`aws configure` で鍵とリージョンを設定する

```bash
# 実行環境：ローカルシェル（Mac のターミナル）
aws configure
```

対話式に4つ聞かれます。次のように入力します（**リージョンは東京 `ap-northeast-1` を必ず指定**）。

```text
AWS Access Key ID [None]:     ← 手順②のアクセスキー ID を貼り付け
AWS Secret Access Key [None]: ← 手順②のシークレットキーを貼り付け（画面には出ません）
Default region name [None]:   ap-northeast-1
Default output format [None]: json
```

#### 手順④：設定できたか確認する

```bash
# 実行環境：ローカルシェル（Mac のターミナル）
aws configure get region
aws sts get-caller-identity
```

> ✅ こう表示されればOK：
> - `aws configure get region` が **`ap-northeast-1`** を返す。
> - `aws sts get-caller-identity` が `UserId` / `Account`（12桁の数字）/ `Arn` を含む JSON を返す（＝認証成功）。
> ❌ `Unable to locate credentials` や `InvalidClientTokenId` が出たら、鍵の貼り間違い。もう一度 `aws configure` をやり直します。

- Amplify sandbox・Bedrock 呼び出しは、この認証情報で実行されます。
- なぜ東京固定か → 本 PoC はリージョンを東京にそろえる方針だからです（次の §2.4 が理由）。

### 2.3 Bedrock モデルアクセス（自動有効化・確認方法）

> 🔰 **仕様が変わりました（重要）**
> 以前は Bedrock コンソールの「**Model access**（モデルアクセス）」ページで、モデルを1つずつ手動で有効化する必要がありました。
> **このページは廃止**され、いまはサーバーレス基盤モデル（Claude など）を**初めて呼び出した瞬間に、そのリージョンで自動的に有効化**されます。
> つまり「使う前にボタンを押して有効化する」作業は**もう不要**です。

- **有効化はリージョン単位**（東京で自動有効化されても、他リージョンには波及しない）。本 PoC は**東京 `ap-northeast-1` に固定**なので、呼び出しも東京で行います（§2.2 で既定リージョンを東京にしてあること）。
- **事前の有効化操作は不要**。工程0（`01_step0_spike.md`）で実際に Bedrock を呼び出せば、その時に有効化されます。
- **Anthropic（Claude）は初回利用時のみ、用途（ユースケース）の入力を求められることがあります**。求められたら画面の指示に従って入力してください。それを提出するまでは呼び出しがブロックされます。

確認は「**実際に呼べるか**」で行います。まず CLI で東京に当該モデルが見えるか一次チェックします。

```bash
# 実行環境：ローカルシェル（Mac のターミナル）／東京にモデルが見えるか確認
aws bedrock list-foundation-models \
  --region ap-northeast-1 \
  --query "modelSummaries[?contains(modelId, 'claude-haiku-4-5')].modelId"
```

> ✅ こう表示されればOK：`"anthropic.claude-haiku-4-5-20251001-v1:0"` を含むリストが返る（＝東京でモデルが見えている）。**最終確認は工程0（`01_step0_spike.md`）の疎通テストで Converse／InvokeModel が成功すること**。ここが緑バッジの代わりの合格判定です。
> ⚠ 呼び出しで `AccessDeniedException` が出る場合：①初回の用途入力が未提出、②**会社の管理者が IAM ポリシー／SCP でモデルを制限**している、③リージョン取り違え、のいずれか。ページ末尾「失敗時の代替」も参照。

### 2.4 リージョン・モデル（本 PoC 固定値）
以下は**この PoC で必ずこの値を使う**という固定値です（勝手に変えない）。

- リージョン：**`ap-northeast-1`（東京）**。処理地域も東京。→ 遅延を抑え、データの処理場所を東京にそろえるため。
- 呼び出し方式：**東京 In-Region 直接呼び出し**。
- モデルID：**`anthropic.claude-haiku-4-5-20251001-v1:0`**（この表記以外を使わない）。

> 裏取り（AWS 公式 Claude Haiku 4.5 モデルカード）：`ap-northeast-1`（東京）は **In-Region ✅ / Geo ✅ / Global ✅** に対応。基盤モデルID は `anthropic.claude-haiku-4-5-20251001-v1:0`。`bedrock-runtime` エンドポイントで **Converse / Invoke / Messages** と**画像入力**をサポート。国内高可用性を後日優先する場合の日本 Geo 推論プロファイルは `jp.anthropic.claude-haiku-4-5-20251001-v1:0`（§6 の切替オプション）。**大阪（ap-northeast-3）は In-Region 非対応（Geo は対応）** のため、In-Region 直接は東京固定とする。

> 🔰 **§2 の自己チェック（3点そろえば§2完了）**
> - [ ] `node -v` でバージョンが表示される（`npm -v` / `git --version` も出る）
> - [ ] `aws sts get-caller-identity` が自分のアカウント情報（JSON）を返す
> - [ ] 東京リージョンで Claude Haiku 4.5 を**実際に呼び出して成功**（工程0の疎通テスト。初回自動有効化）

---

## 3. 共通規約（全工程が従う）

> 🔰 **このセクションのゴール（初学者向け）**
> §3 は「全工程が必ず守る共通ルール集」です。ここで決めた**モデル・ファイルの置き場所・データ名・二重生成の防ぎ方・ログの書き方**を全工程で使い回します。**細部は各工程で読み返せばOK**。まずは「こういうルールがある」という地図として眺めてください。以下の各節は「何のためのルールか」を 🔰 で先に一言添えています。

以降のすべての手順書は次を厳守する。

### 3.1 Bedrock
> 🔰 この節は「**AI（Claude）をどう呼ぶか**」の固定ルール。モデル・地域・呼び出し方式・権限を全工程でそろえる。
- モデルID：`anthropic.claude-haiku-4-5-20251001-v1:0`
- リージョン：`ap-northeast-1`（東京 In-Region 直接呼び出し）
- API：**Converse または InvokeModel に固定**（Structured Outputs〔＝AI の返答を決まった JSON の形に強制する機能〕を使うため。Anthropic Messages 互換経路では Structured Outputs 不可 ※proposal §6・§7 の前提。工程0で実挙動を確認）
- IAM〔＝AWS の権限設定〕：当該 foundation-model ARN への `bedrock:InvokeModel` を付与（クロスリージョン推論プロファイル ARN 許可は In-Region 構成では不要）

### 3.2 Amplify Gen2 パス規約（新規/編集ファイルの固定位置）
> 🔰 この節は「**どのファイルをどこに置くか**」の地図。全員が同じ場所に書けば、レビューも引き継ぎも迷わない。
```text
amplify/auth/resource.ts                       # defineAuth（Cognito・メールログイン）
amplify/data/resource.ts                       # defineData（Site/Report/Photo・allow.owner()・custom query）
amplify/storage/resource.ts                    # defineStorage（media/{entity_id}/*）
amplify/functions/generate-report/resource.ts  # defineFunction（generateReport）
amplify/functions/generate-report/handler.ts   # Lambda 実装（Bedrock 呼び出し・IDOR 再検証）
amplify/backend.ts                             # backend 統合・CDK で IAM 付与（bedrock:InvokeModel / S3 read）
```

### 3.3 データモデル・ストレージ・認可
> 🔰 この節は「**誰が自分のデータだけを触れるようにするか**」のルール。基本は「作った本人だけが読み書きできる」。
- モデル：**`Site`（現場）/ `Report`（日報）/ `Photo`（写真）**、いずれも **`allow.owner()`**〔＝作成者本人だけが CRUD〔作成・読取・更新・削除〕できる設定〕。
- S3〔＝写真の保管庫〕パス：**`media/{entity_id}/*`**（entity = Cognito identity で本人分離＝人ごとにフォルダを分ける）。**Block Public Access 有効化**〔＝外部への公開を全面ブロック〕。
- guest/public アクセス・API key 認可は**使わない**。モデルへの `allow.authenticated()`〔＝ログイン済みなら誰でも可〕も**使わない**（§4。工程2 の custom query `generateReport` のみ `allow.authenticated("identityPool")`＝IAM 認可〔＝AWS の権限で本人確認する方式〕を使う）。

### 3.4 冪等キー・生成制御・認可検証
> 🔰 この節は「**二重生成・なりすまし・使いすぎを防ぐ安全装置**」。連打や再送で AI を無駄に2回呼ばない／他人の写真を読ませない／回数を制限する、を仕組みで担保する。
- 冪等キー〔＝同じ入力なら1回だけ実行する“合言葉”〕：**`reportId + imageSetHash + inputHash + promptVersion + modelId + schemaVersion`**（同一入力の再試行・二重送信で Bedrock を二重実行しない）。
  - `imageSetHash`：Lambda が実際に read した S3 key＋画像バイトから順序安定で算出（クライアント値を信用しない）。
  - `inputHash`：Lambda が Report から読んだ `reportDate/workType/memo/nextPlanInput` を**順序固定・Unicode 正規化（NFC〔＝見た目が同じ文字の内部表現をそろえる処理〕）**してハッシュ化。**写真が同じでもテキスト入力を変更すれば新規生成**され、古いドラフトを返さない（proposal §3 の「テキスト入力が一次情報」との整合）。
- 生成状態は **lease 付き状態機械**〔＝「作業中ロック」に期限（lease）を付け、状態を `RUNNING`／`FAILED` などで管理する仕組み。期限切れなら別プロセスが引き取れる〕として DynamoDB（GenerationJobs）に保存する：`leaseExpiresAt`／`attemptId`／`attemptCount` を持ち、`FAILED` と lease 期限切れ `RUNNING` は条件付き更新で再取得（即時再試行）できる。完了・失敗の更新は `attemptId` 一致を条件にする。**TTL は履歴削除専用**とし、ロック期限判定に使わない。
- Lambda は**ハードタイムアウトの `catch` に依存しない**：`context.getRemainingTimeInMillis()` に基づく deadline（AbortSignal）で Bedrock 呼び出しを打ち切り、失敗保存の後処理バッファを確保する（工程2）。
- 写真は枚数上限（例：3枚、上振れ 5枚）、クライアント側で**長辺 1,568px に圧縮**、出力は `maxTokens` で上限。生成中はボタン無効化。**再生成回数上限はサーバー側 quota〔＝1日あたりの回数上限〕（Report 単位・ユーザー×日次、条件付き更新で強制。冪等ヒットは加算しない）が正本**で、クライアントの回数表示は UX 補助。
- アップロードは MIME type・サイズ・枚数を、生成入力は日付・文字数上限を**サーバー側でも検証**。
- **写真アクセス認可の正本は「S3 key が `media/{呼び出し元identityId}/` 配下」のサーバー側プレフィックス検証**（工程2、identityPool 認可で `cognitoIdentityId` を取得）。クライアントが更新できる `Report.photoKeys` は表示・整合性チェック用であり、**認可の正本にしない**。
- `genStatus` の更新責任：**UI が `DRAFT`／`GENERATING`／`CONFIRMED`、handler が生成完了・失敗時に `GENERATED`／`FAILED`＋ドラフト本文を Report へ永続化**（リロード・切断後の状態復元のため）。

### 3.5 ログ規約（証拠・再現性／§9 末）
> 🔰 この節は「**ログに何を書き、何を書かないか**」のルール。写真やプロンプト本文などの中身は残さず、追跡に必要な数値・IDだけを残す（プライバシーと後の集計の両立）。
- **画像・プロンプト本文は残さない**。記録するのは request ID・report ID の非可逆識別子・モデルID・latency・usage トークン・結果状態・冪等/重複抑止結果。
- 構造化ログ（JSON）のフィールド名は**トップレベルで統一**し、工程2（出力）と工程6（Logs Insights 集計）で同一にする：`requestId / reportIdHash / modelId / status（SUCCEEDED|FAILED|IDEMPOTENT_HIT|IN_PROGRESS|FORBIDDEN|QUOTA_EXCEEDED|STALE_ATTEMPT|INPUT_CHANGED）/ resultStatus（ok|needs_review|unknown）/ errorName / inputTokens / outputTokens / totalTokens / latencyMs / photoCount / idempotent`。
- CloudWatch Logs 保持は 7〜14日に固定（§6。**設定は工程2の完了条件**）。

> 🔰 **§3 の自己チェック（言葉で説明できればOK）**
> - [ ] AI は「東京・Claude Haiku 4.5・Converse/InvokeModel」で呼ぶ、と言える（§3.1）
> - [ ] データは3種（Site/Report/Photo）で、**本人だけ**が触れる（`allow.owner()`）と言える（§3.3）
> - [ ] 冪等キーが「同じ入力なら AI を1回だけ呼ぶ合言葉」だと説明できる（§3.4）
> - [ ] ログに**写真・プロンプト本文を書かない**理由が言える（§3.5）

---

## 4. アーキテクチャ概要（proposal §4 要約）

> 🔰 **図の読み方（初学者向け）**
> 上から下へ**データの流れ**です。①スマホアプリ → ②Amplify のバックエンド（認証 Cognito・データ AppSync/DynamoDB・写真 S3・処理 Lambda）→ ③AI（Bedrock の Claude）。日報生成の入口は `generateReport` という Lambda で、ここで**「本人か」「他人の写真を読もうとしていないか」「二重生成でないか」を必ずチェック**してから AI を呼びます。細部の用語は §3 のグロス参照。

```text
[スマホ（React Native アプリ / Expo）]
        │  Amplify Libraries（aws-amplify / @aws-amplify/ui-react-native）
        ▼
┌──────────────────────────────────────────────┐
│  Amplify Gen2 Backend（TypeScript 一元管理）    │
│                                                │
│  Cognito ── 認証（メールログイン / defineAuth）  │
│  AppSync(GraphQL) ── DynamoDB（Site/Report）    │
│        │  allow.owner()（本人のみ CRUD）         │
│  S3 ── 現場写真（media/{entity_id}/* / 本人分離）│
│        │  Block Public Access 有効             │
│  Lambda ── generateReport（custom query,        │
│        │      identityPool(IAM) 認可）           │
│        │  ① 所有者(sub)再検証                    │
│        │  ② S3 key の identityId プレフィックス   │
│        │     検証（IDOR 対策の正本）              │
│        │  ③ 冪等キーで二重実行防止               │
│        │  CDK: bedrock:InvokeModel               │
│        │       + S3 read（media/* 限定）         │
│        ▼                                        │
│  Amazon Bedrock                                │
│  Claude Haiku 4.5 / 東京 In-Region 直接          │
│  anthropic.claude-haiku-4-5-20251001-v1:0      │
│  Converse/InvokeModel + 画像入力 + Structured   │
│  Outputs（JSON Schema で日報4項目を強制）        │
└──────────────────────────────────────────────┘
```

| レイヤ | サービス | Gen2 定義 |
|---|---|---|
| フロント | React Native (Expo) + Amplify UI for React Native | — / EAS Build（開発・配布ビルド） |
| 認証 | Cognito | `defineAuth` |
| データ | AppSync + DynamoDB（`allow.owner()`） | `defineData` |
| ストレージ | S3（`media/{entity_id}/*`） | `defineStorage` |
| AI処理 | Lambda → Bedrock | `defineFunction` + custom query |
| 権限付与 | IAM（Bedrock invoke / S3 read） | `backend.ts`（CDK `addToRolePolicy`） |

> ℹ 図中の **IDOR** は「他人のデータを ID 差し替えで覗く攻撃」のこと。②の S3 key プレフィックス検証がその対策の正本です（§5・§6 でも同義で使用）。

**主要技術リスク（工程0で判定）**：AppSync のリクエスト実行上限 **30秒（変更不可）** の中に「複数画像取得＋Lambda コールドスタート〔＝初回起動の遅れ〕＋Bedrock 推論＋初回スキーマコンパイル」を収められるか。収まらなければ非同期（Lambda/SQS＋ポーリング）へ切替（§6・§9）。

---

## 5. ゲート対応表（process.md × 工程）

> 🔰 **このセクションのゴール（初学者向け）**
> ゲート＝「ここまで出来たら合格」の**関門**です。難しい方へ4段階：
> **A**（部品が1つ動く）→ **A+**（ログインから確定保存まで一気通貫）→ **S-tech**（他メンバーに共有でき、安全チェックも通る）→ **S-accept**（品質 KPI まで満たし提案として受け入れられる）。
> 大事なのは**合否を主観でなく「証拠」（スクショ／ログ／デモ動画）で判定**すること。下の表は「各ゲートに何が必要で、どの工程で作るか」の対応表です。

process.md（**v2** / 2026-07-11 改定）の A→A+→S-tech→S-accept ゲートと、本手順書の工程の対応。**証拠（スクショ／ログ／デモ）で判定**する（主観判定しない）。

| ゲート | 到達条件（process.md §2/§5） | 到達に必要な工程 | 証拠 |
|---|---|---|---|
| **A**（土台が動く） | いずれか1つ：sandbox デプロイ成功（CFn 成功）／ログイン／写真アップロード（S3保存）／AI生成（Bedrock 呼出）のどれか1つが動く | **工程1 の一部**（`ampx sandbox` 成功 or 部品1つ）。工程0の疎通ログでも AI生成の1つに該当し得る | 動作画面のスクショ or CloudWatch ログ |
| **A+**（一気通貫） | ログイン→写真アップロード→AI生成→確定保存→一覧表示 が手元(sandbox/開発ビルド)で一気通貫 | **工程1〜3 の一気通貫**（前提として工程0で方式確定） | 通しデモ動画＋Bedrock 応答の CloudWatch ログ |
| **S-tech**（技術共有可） | 共有手段いずれか1つ：**EAS Build 内部配布（開発ビルド）での他メンバー実機確認／チーム前通しデモ成功**。**かつ安全ゲート全て**：TC-1（IDOR 否定テスト。B所有 Report＋Aの key 含む）／TC-3（冪等抑止）／TC-4（AppSync 30秒で不整合なし or 非同期化判断済み）／ログ本文非出力確認／AWS Budgets 設定済み。**かつ最小品質スモーク**（無関係・不鮮明写真とテキスト欠落入力で捏造しない、安全項目で「問題なし」を生成しない） | **A+ ＋ EAS 内部配布 or 通しデモ ＋ 安全ゲート ＋ スモーク**（工程5 の TC-1/3/4・ログ健全性＋工程1 の Budgets＋工程4 §0） | 配布リンク or デモ記録 ＋ TC-1/3/4 の判定記録（TC-7 テンプレ）・ログ確認・Budgets スクショ・スモーク記録 |
| **S-accept**（提案受入可） | S-tech ＋ 工程4 フル KPI 合格（充足率≥90%・事実誤認率≤5%・要確認が推測で埋まらない） | **S-tech ＋ 工程4 全件評価** | KPI 集計表・合否判定表 |

- **工程6（実測コスト更新）・工程5 の TC-2/5/6/8 網羅合格は S-tech の必須条件ではない**（process.md §3 ストレッチ目標）。ただし **工程5 の TC-1／TC-3／TC-4 とログ健全性確認、AWS Budgets（工程1で初期設定）、工程4 §0 の最小品質スモークは S-tech 必須**（process.md §2 v2）。
- **工程4のフル KPI 測定は S-accept の条件**であり、S-tech（技術共有）だけならスモークで足りる。「共有できる」と「提案価値を受入できる」を混同しない。
- S-tech の「最低限の安全策」＝枚数上限・連打防止に加え、「他ユーザーの写真を読めない」「二重生成されない」「ログに写真・プロンプト本文が出ない」まで（process.md §2）。
- 目安：**A ≒ 工程1 の一部（or 工程0 の疎通）／A+ ≒ 工程1〜3 一気通貫／S-tech ≒ EAS 内部配布 or 通しデモ＋安全ゲート＋スモーク／S-accept ≒ S-tech＋工程4 KPI**。

> 🔰 **§5 の自己チェック（言葉で説明できればOK）**
> - [ ] A → A+ → S-tech → S-accept の順で難しくなる、と言える
> - [ ] 合否は**証拠（スクショ・ログ・デモ）**で決める、と言える
> - [ ] 「共有できる（S-tech）」と「提案として受け入れられる（S-accept）」は別、と説明できる

---

## 6. コスト前提の要約（proposal §5 / §6）

> 🔰 **このセクションのゴール（初学者向け）**
> 「このアプリを月いくらで動かせるか」の**ざっくり見積もり**と、**お金が膨らまないための歯止め（ガードレール）**の一覧です。要点は2つ：①標準的な使い方なら**月数ドル規模**、②ただし写真の保持期間・ログ保持・予算監視などの**設定を入れて初めてこの見積もりが成立**する。数値は実施時に料金ページ／実測で更新します（工程6）。

**通常料金ベース（無料枠を引かない）月額試算**（正本は proposal §5 の**表A（通常料金）／表B（実支払見込み）**。実測更新は `07_step6_cost.md`）：

| ケース | 合計（通常料金・表A） | 主因 |
|---|---|---|
| 標準（5人・日報100件/月・写真3枚） | **約 $1.0〜1.2 ＋ EAS Build 従量分 / 月** | Bedrock 約$0.94 |
| 上振れ（10人・日報300件/月・写真5枚） | **約 $7.5〜8 ＋ EAS Build 従量分 / 月** | Bedrock 約$6.9 |

- EAS Build の通常料金（on-demand 単価）と Free plan の枠・超過時料金は、実施時に expo.dev/pricing で確認して proposal §5 表A/表Bへ記入する（工程6）。
- 実支払見込み（表B）：適用可能な無料枠・Expo Free plan・新 Free Tier クレジットで表Aより縮小し、標準ケースは**実質 月額数ドル以内**の見込み。単価・無料枠はリージョン/時期で変動するため運用前に料金ページで確認（proposal §5）。
- Bedrock 単価前提：Claude Haiku 4.5 = 入力 $1 / 出力 $5（per 100万トークン）。入力は画像で変動 → 工程6 で **CountTokens（無料）／実 usage** により実測更新。
- ⚠ 上記試算の前提（写真30日保持・Logs 7〜14日・予算監視）は **S3 Lifecycle（工程1）／Logs retention（工程2）／AWS Budgets（工程1）を適用して初めて成立**する。適用前は保持が無期限となり試算前提を満たさない（proposal §5 注記）。

**主要ガードレール一覧（proposal §6・詳細は各工程ファイル）**：

| ガードレール | 要点 | 主担当工程 |
|---|---|---|
| AppSync 30秒上限 | 最大写真枚数で P95〔＝遅い方から5%を除いた実用上の最大時間〕計測、超過なら非同期化 | 工程0・工程2 |
| Structured Outputs 初回コンパイル | 初回最大数分・キャッシュ24h → デプロイ/スキーマ変更後にウォームアップ | 工程0・工程2 |
| 写真・生成制御 | 枚数上限・1,568px 圧縮・`maxTokens`・冪等キー（`inputHash` 込み・lease 状態機械）・**サーバー側 quota**・サーバー側検証 | 工程2・工程3 |
| 認可再検証（IDOR） | `generateReport`（identityPool 認可）内で所有者 sub 再検証＋S3 key の `media/{identityId}/` プレフィックス検証（正本）。`Report.photoKeys` は認可の正本にしない | 工程2・工程5 |
| 保存/ログ保持 | S3 Lifecycle（例30日）〔＝一定日数で自動削除する設定〕＋未完了 multipart abort〔＝中断した分割アップロードのゴミ掃除〕＝**工程1で設定**、Logs 7〜14日＝**工程2で設定**、本文非記録 | 工程1・工程2 |
| Bedrock リージョン/IAM | 東京 In-Region、foundation-model ARN に `bedrock:InvokeModel` | 工程0・工程2 |
| Free Tier 注意 | 2025-07-15 以降作成アカウントはクレジット方式。無料枠を恒常前提にしない | 工程6 |
| コスト監視 | AWS Budgets〔＝予算超過を通知する仕組み〕月次予算＋複数閾値通知＝**工程1で初期設定・工程6で実測見直し**（Budgets は通知であり停止機構ではない。停止側はアプリ quota が担う）、Lambda reserved concurrency〔＝同時実行数の上限予約〕小＝**工程2で初期設定・工程6で見直し** | 工程1・工程2・工程6 |

> 🔰 **§6 の自己チェック（言葉で説明できればOK）**
> - [ ] 標準的な使い方なら**月数ドル規模**、と言える
> - [ ] この見積もりは**保持期間・ログ保持・予算監視の設定を入れて初めて成立**する、と言える
> - [ ] Budgets は「通知」であって「自動停止」ではない（止めるのはアプリ側の quota）、と説明できる

---

## 完了条件チェックリスト（本ファイル＝環境・規約の整備）

- [ ] Node.js（v18.16.0 以降、推奨 20 LTS+）／npm（v6.14.4+）／git（v2.14.1+）を確認
- [ ] AWS CLI／認証を設定し、既定リージョンを `ap-northeast-1` に設定
- [ ] 東京リージョンで **Claude Haiku 4.5 を実際に呼び出して成功**（初回自動有効化。工程0の疎通で確認）
- [ ] `npm create amplify@latest` / `npx ampx sandbox` が実行できる状態
- [ ] 共通規約（モデルID・パス規約・データモデル名・冪等キー・ログ規約）をチームで合意
- [ ] ゲート対応表（§5）とコスト前提（§6）をチームで共有
- [ ] **次に `01_step0_spike.md`（工程0＝最優先ゲート）へ進むことを確認**

## 失敗時の代替

- **初回呼び出しで `AccessDeniedException` 等が出て使えない**：①初回の**用途（ユースケース）入力**が未提出でないか、②**管理者が IAM ポリシー／SCP** で当該モデルを制限していないか、③リージョンが東京 `ap-northeast-1` かを確認。東京で未提供の状況が判明した場合は proposal §6 の**日本 Geo 推論プロファイル**（`jp.anthropic.claude-haiku-4-5-20251001-v1:0`／推論プロファイル＋東京・大阪の foundation-model ARN 許可）への切替を検討（工程0で判定）。
- **Node/CLI の相性問題**：Node を LTS（20 系）に統一し `ampx` を再インストール。`amplify`（Gen1 CLI）と混同しない。
- **リージョン取り違え**：CLI 既定・Bedrock コンソール・IAM ARN のすべてが `ap-northeast-1` を指しているか再点検。

## process.md ゲート対応

- 本ファイルは環境・規約の整備であり単独ではゲート非該当。ここで整えた前提の上で、**工程0の疎通 or 工程1 の部品1つで A 評価**、**工程1〜3 一気通貫で A+**、**EAS 内部配布／通しデモ＋安全ゲート＋最小品質スモークで S-tech**、**さらに工程4 KPI 合格で S-accept** に到達する（§5 対応表・process.md v2）。
