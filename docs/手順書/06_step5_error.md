# 工程5：異常系テスト（受入条件）実行手順書

現場AI日報「GenbaLog」PoC / proposal.md §9 工程5 の実行手順書。

---

## 目的・前提

**目的：** proposal.md §9 工程5 の異常系テストを実施し、**いずれのケースでも「情報漏えい・二重課金・不整合」が発生しない**ことを、ログ・DB・課金の証拠で証明する。

**依存する工程（前提）：**

- **工程1（認可付き Data／Storage）完了**：`Site` / `Report` / `Photo` が `allow.owner()` で分離、S3 が `media/{entity_id}/*` で本人分離、Block Public Access 有効。
- **工程2（AI処理 generateReport）完了**：custom query `generateReport` が動作し、所有者・S3 key 再検証（IDOR 対策）、冪等キー（`reportId + imageSetHash + inputHash + promptVersion + modelId + schemaVersion`）、Structured Outputs、ウォームアップが実装済み。
- **工程3（UI 統合）完了**：生成中ボタン無効化・処理中／再試行状態表示が実装済み（テストケース 2・6 の UI 確認に必要）。
- （工程0 で同期／非同期方式が確定済みであること。本手順書は proposal §9 工程5 に従い**同期 custom query 方式**を主対象に記述する。非同期方式を採用した場合は、テストケース 2・4 の「クライアント挙動」をポーリング状態遷移に読み替える。）

**共通の技術前提（proposal 準拠・厳守）：**

- Bedrock モデルID：`anthropic.claude-haiku-4-5-20251001-v1:0`
- リージョン：`ap-northeast-1`（東京 In-Region 直接呼び出し）
- データモデル：`Site` / `Report` / `Photo`（`allow.owner()`）
- S3 パス：`media/{entity_id}/*`
- 冪等キー：`reportId + imageSetHash + inputHash + promptVersion + modelId + schemaVersion`
- ログ記録項目（proposal §9 末尾）：request ID・report ID の非可逆識別子・モデルID・latency・usage トークン・結果状態・冪等/重複抑止結果。**画像・プロンプト本文は残さない。**

**テスト環境の準備（全ケース共通）：**

1. 各自の `npx ampx sandbox` を起動し、工程1〜3 をデプロイ済みにする。
2. Cognito に**テストユーザー2名**を作成する（以下 **ユーザーA** / **ユーザーB**）。
3. ユーザーA でログインし、`Site` 1件・`Report` 1件を作成、写真1枚をアップロードして S3 key と `reportId` を控える。
4. CloudWatch Logs（generateReport Lambda のロググループ）、DynamoDB コンソール（`Report` テーブル）、Bedrock の usage 確認手段（CloudWatch メトリクス `AWS/Bedrock` の `Invocations` / `InputTokenCount` / `OutputTokenCount`、または generateReport ログに記録した usage トークン）を開いておく。

---

## テストケース

各ケースに「手順・期待結果・確認方法（ログ/DB/課金）」を付す。

### TC-1. 認可違反（否定テスト：IDOR）

proposal §6「認可の再検証（IDOR 対策）」／§9 工程5「他ユーザーIDの `reportId`／S3 key を指定した否定テストが拒否される」に対応。

**手順：**

1. ユーザーA で前記「準備」の `Report`（`reportId_A`）と S3 key（`media/{identityA}/xxx.jpg`）を用意する。
2. **ユーザーB でログイン**し、B のセッションから `generateReport` を呼ぶ（`authMode: 'identityPool'`）。引数に **A の `reportId_A`** を指定する。
3. 続けて、B のセッションから **A の S3 key**（`media/{identityA}/xxx.jpg`）を引数に指定して `generateReport` を呼ぶ（key を直接渡す経路がある場合）。
4. Data／Storage レイヤの owner 分離も直接検証する：B のセッションで A の `Report` を GraphQL `get`／`list` し、B のセッションで A の S3 オブジェクトを `getUrl`／`download` する。
5. **【中核シナリオ：allowlist 迂回】B が自分の `Report` を作成し、その `photoKeys` に A の S3 key（`media/{identityA}/xxx.jpg`）を保存**したうえで、`generateReport({ reportId: <B自身のreportId>, photoKeys: ["media/{identityA}/xxx.jpg"] })` を呼ぶ。Report の owner 検証は通る（B 自身の Report のため）が、**S3 key の identityId プレフィックス検証**（工程2 ステップ3-B：`media/{Bの identityId}/` 配下のみ許可）で拒否されることを検証する。クライアント更新可能な `Report.photoKeys` を認可の正本にしていないことの証明。
6. **【owner 再割当】** B が自分の `Report`／`Site`／`Photo` レコードの `owner` フィールドを別ユーザー（A の sub）へ `update` しようとする。また B のセッションから A のレコードの `owner` 書き換えも試みる。工程1 の field-level authorization（owner は update 不可）で拒否されることを検証する。

**期待結果：**

- 手順2・3：`generateReport` が**認可拒否で失敗**（Lambda 内の所有者再検証で弾かれ、Bedrock を呼ばない）。クライアントには GraphQL の `errors` にエラーが返る。**A のデータ内容は一切返らない。**
- 手順4：Data の `get`／`list` は A のレコードを**返さない**（owner 不一致で 0 件／null）。Storage の A オブジェクト取得は**拒否**される。
- 手順5：`generateReport` が**プレフィックス検証で拒否**（ログに `status: "FORBIDDEN"`）。Bedrock を呼ばず、A の写真バイトを一切読まない（S3 GetObject も発生しない）。
- 手順6：`owner` の update が**認可エラーで拒否**され、レコードの owner が変わらない。

**確認方法：**

- **ログ**：generateReport ログに `status: "FORBIDDEN"`（所有者不一致・プレフィックス違反）が記録され、**Bedrock InvokeModel の呼び出しログが無い**こと（=課金発生なし）。画像・プロンプト本文が出ていないことも確認。
- **DB**：`Report` テーブルに B による A レコードの更新が発生していないこと。手順6 の後で各レコードの `owner` が元のままであること。
- **課金**：`AWS/Bedrock` の `Invocations` が本テストで増えないこと（二重課金・不正課金なし）。

---

### TC-2. Bedrock throttle / timeout

proposal §6「Bedrock リージョン／IAM」「コスト制御」／§9 工程5「Bedrock throttle/timeout」に対応。

**Bedrock 側の例外（裏取り済み・下記「裏取りメモ」参照）：**

- `ThrottlingException`：リクエストがサービス全体の制限を超過。**「後で、または別リージョンで再送」**。SDK 上は再試行可能（retryable）系。
- `ModelTimeoutException`：処理時間がモデルのタイムアウト長を超過（「The request took too long to process」）。

**発生させ方（いずれか）：**

- **(a) 実発生（throttle）**：短時間に generateReport を連続呼び出しし、アカウントの Bedrock リクエスト／トークンクォータを一時的に超過させて `ThrottlingException` を誘発する。Lambda の reserved concurrency を小さくしておくと再現しやすい。
- **(b) 擬似（推奨・確実）**：handler に**テスト専用フラグ／モック**を用意し、Bedrock 呼び出し箇所で `ThrottlingException`／`ModelTimeoutException` を強制スロー（環境変数やテスト用入力で切替）。本番経路に残さないこと。

**手順：**

1. (a) または (b) で throttle / timeout を発生させ、generateReport を1回呼ぶ。
2. UI 上で生成ボタンを押し、失敗後の表示を確認する。
3. 失敗（`FAILED`）を確認した後、UI から**再試行**する。
4. reserved concurrency（工程2で小さく設定済み）を一時的に 1 にし、並行呼び出しでスロットリング（Rate Exceeded）を発生させ、**UI の表示挙動**（エラー表示→再試行可能）を確認する。

**期待結果：**

- Lambda は例外を捕捉し、**冪等キーの生成状態を「未完了／失敗（再試行可能）」として記録**（成功として確定保存しない）。
- UI に**「処理中→失敗、再試行可能」状態**が表示され、`Report` は確定（成功）状態にならない。
- `ModelTimeoutException` の場合も部分的な確定保存が行われない。
- **`FAILED` になったジョブは条件付き更新でロックを再取得でき、再試行が成功する**（`attemptCount` が増える。FAILED が恒久的な再試行不能にならない）。
- スロットリング時も UI が再試行可能状態を表示し、状態不整合にならない。

**確認方法：**

- **ログ**：結果状態に `ThrottlingException`／`ModelTimeoutException` 相当が記録され、latency・request ID が残ること。
- **DB**：`Report` が成功確定になっていない（生成状態フィールドが失敗／再試行可）こと。GenerationJobs の該当キーが FAILED→（再試行後）RUNNING→SUCCEEDED と遷移し、attemptId が更新・attemptCount が加算されていること。
- **課金**：throttle 時は Bedrock の**課金対象 Invocation が成立しない**（拒否）ことを `AWS/Bedrock` メトリクスで確認。

---

### TC-3. Lambda 再実行・重複クリック（冪等抑止）

proposal §6「冪等キー（`reportId + imageSetHash + inputHash + promptVersion + modelId + schemaVersion`）で Bedrock を二重実行しない」／§9 工程5「Lambda 再実行」「重複クリック（冪等抑止）」に対応。

**重要な前提（裏取り済み）：** AppSync からの Lambda 呼び出しは**同期呼び出し**であり、**Lambda はエラー時に自動再試行しない**（同期呼び出しでは呼び出し側が再試行責任を負う）。したがって二重実行の主因は**クライアントの重複クリック／クライアント（SDK）側の再送**である。冪等キーはこれを吸収する。

**手順：**

1. UI で同一 `Report`・同一写真に対して「AIで日報生成」を**連打**する（生成中ボタン無効化が効くことも併せて確認）。
2. 無効化をすり抜ける経路（例：ネットワーク再送、二重タブ）を想定し、**同一の冪等キー**で generateReport を2回以上呼ぶ。
3. **lease 失効 RUNNING の takeover**: handler をテスト用に Bedrock 呼び出し前で強制終了（またはモックで例外前にプロセス kill 相当）させ、GenerationJobs が `RUNNING` のまま `leaseExpiresAt` を過ぎるのを待つ（lease は60秒）。その後 UI から再生成する。

**期待結果：**

- 2回目以降は冪等キー一致により**Bedrock を再実行せず**、初回結果（または「処理中」状態）を返す。
- `Report` レコードが**重複作成されない**。
- lease 失効後の再生成は条件付き更新で **takeover** され（新しい attemptId）、成功する。lease 有効中の再送は IN_PROGRESS として拒否され二重実行されない。古い実行が後から完走しても attemptId 不一致（STALE_ATTEMPT）で新しい状態を上書きしない。

**確認方法：**

- **ログ**：CloudWatch に**冪等抑止（重複検知）の記録**が残り、2回目以降で InvokeModel が走っていないこと。IN_PROGRESS（lease 有効中）/ STALE_ATTEMPT（takeover 後の旧実行）が正しく出ること。
- **DB**：`Report` が1件のまま（重複なし）。生成状態が一貫していること。
- **課金**：`AWS/Bedrock` `Invocations` が**1回分しか増えない**（二重課金なし）。

---

### TC-4. AppSync 30秒タイムアウト

proposal §6「AppSync 30秒上限（最重要の技術リスク）」／§9 工程5「AppSync timeout」に対応。

**前提（裏取り済み）：** AppSync は GraphQL クエリ実行を**最大30秒**に制限（変更不可）。超過時、クライアント（Amplify Data クライアント）は**成功データを受け取らず、`errors` 配列にエラーが返る**（例外/エラーとして扱われる）。

**手順：**

1. 30秒超過を誘発する：最大写真枚数＋初回スキーマコンパイル（proposal §6：新規 JSON Schema の初回コンパイルは最大数分）を意図的に踏む、または handler にテスト用の遅延を仕込む。
2. UI から generateReport を呼び、30秒経過時のクライアント挙動を観察する。

**期待結果：**

- クライアントは 30秒でタイムアウトエラー（`errors` にエラー）を受け取る。
- 一方で **Lambda / Bedrock はバックグラウンドで走り切る可能性がある**ため、**状態不整合を作らない**こと：冪等キー＋生成状態で管理し、後続の再試行が**同一結果に収束**（二重確定・二重課金しない）。
- UI は「処理中／再試行可能」を表示し、ユーザーが再試行しても TC-3 の冪等抑止が効く。

**確認方法：**

- **ログ**：AppSync 側の 30秒到達と、Lambda 側の継続実行・最終結果状態を突き合わせ、確定保存が1回で収束していること。
- **DB**：タイムアウト後に `Report` が重複確定・中途半端な部分確定になっていないこと。
- **課金**：バックグラウンド完走した場合でも、再試行を含めて Bedrock Invocation が**入力1件につき1回に収束**していること。

> ⚠ 差異注記：proposal §6・§9 は「AppSync 30秒」を単一のタイムアウトとして扱うが、実装上は **(1) AppSync 30秒**・**(2) Lambda 関数タイムアウト**・**(3) Bedrock `ModelTimeoutException`** の3種が別々に存在する。整合のため **Lambda 関数タイムアウトは AppSync の30秒未満に設定**し、3種のいずれで失敗しても TC-4 の「状態不整合なし・二重課金なし」を満たすこと。Lambda 関数タイムアウト（ハードタイムアウト）到達時は実行環境がリセットされ catch による FAILED 保存は保証されないため、handler は `context.getRemainingTimeInMillis()` ベースの deadline（AbortSignal＋後処理バッファ）で Bedrock を自前で打ち切る（03_step2_ai.md ステップ3 (E)）。deadline 前に catch できず落ちた場合も lease 失効で回復する（TC-3 拡張で検証）。非同期方式採用時は TC-4 を『受付が30秒未満で返ること』の確認に読み替える（03b_step2_async.md）。

---

### TC-5. S3 アップロード失敗・同一写真の再送

proposal §6「必須環境（通信）」「アップロードは MIME type・サイズ・枚数をサーバー側でも検証」／§9 工程5「S3 アップロード失敗」「同一写真の再送」に対応。

**手順：**

1. 写真アップロードを**途中で失敗**させる（アップロード中に機内モードへ切替、またはアプリを強制終了 → 未完了 multipart upload を発生させる）。
2. 同じ写真を**再送**（リトライ）する。
3. 続けて generateReport を実行する。

**期待結果：**

- 途中失敗した写真は S3 に完全オブジェクトとして残らない（未完了 multipart は Lifecycle abort 対象、proposal §6）。
- 再送しても `Photo`／`Report` の**レコードが二重作成されない**（同一写真＝同一 `imageSetHash` で冪等キーが一致）。
- サーバー側検証（MIME／サイズ／枚数）が効き、不正・過大アップロードは拒否される。

**確認方法：**

- **ログ**：再送時に冪等抑止（同一 `imageSetHash`）が記録されること。
- **DB**：`Photo`／`Report` が重複していないこと。
- **課金**：同一写真の再送で Bedrock 生成が二重に走らない（`Invocations` が増えすぎない）こと。

---

### TC-6. 低速回線・途中切断・再読み込み

proposal §6「必須環境（通信）」「弱回線での 30秒超過」／§9 工程5「低速回線・途中切断・再読み込み」に対応。

**手順（React Native アプリでのネットワーク制限・アプリ再起動）：**

1. 低速回線を再現する：**機内モード切替**、または **OS のネットワーク制限**（iOS: 設定→開発者→Network Link Conditioner ／ Android: エミュレータのネットワーク速度設定）で低速プロファイルにする。
2. 写真アップロード＋generateReport を実行し、応答が遅い状態を作る。
3. **次の4時点それぞれでアプリを完全終了（タスクキル）→ 再起動 → 一覧から同じ日報（/reports/[id]/edit）を開いて復元を検証する**：(1) 生成要求送信前（写真・入力のみ）、(2) 生成実行中（GENERATING）、(3) 生成完了直後（GENERATED・確定前）、(4) 確定前の微修正中。
4. 生成中に**回線を一時 Offline** にして途中切断を発生させ、その後 Online に戻す。

**期待結果：**

- 生成中はボタンが無効化され、二重送信が起きない（proposal §6）。
- アプリ再起動／再開後、UI が**現在の生成状態（処理中／完了／再試行可能）を正しく復元**し、勝手に二重生成・二重確定しない。復元の仕組み：UI は編集画面の URL（reportId）起点に Report・photoKeys（S3 getUrl でサムネイル復元）・入力値・draft*・genStatus をサーバーから完全復元する（04_step3_ui.md §2-3 の restore）。**生成成功時に handler が `Report` へ `draft*` 5項目＋`genStatus: 'GENERATED'`（失敗時 `FAILED`）を永続化**している（工程2 ステップ3）。切断中に Lambda が完走したケースでも、復帰後にドラフトが復元表示される。(2) の GENERATING は updatedAt が新しければポーリング、古ければ（lease 失効相当）再試行ボタンを表示する。
- 途中切断→復帰でも冪等キーにより**同一結果に収束**する。

**確認方法：**

- **ログ**：切断・アプリ再起動をまたいでも InvokeModel が入力1件につき1回に収束すること。
- **DB**：`Report` が重複・中途半端な確定になっていないこと。**生成成功後の `Report` に `draft*` と `genStatus=GENERATED` が保存されている**こと（アプリ再起動前に確認しておき、再起動後の UI 表示と一致することを見る）。
- **UI**：上記4時点それぞれでアプリ再起動後に復元が正しいこと。(1) は写真・入力のみ復元、(3)（`GENERATED`）ならドラフトが復元表示、(2)（`GENERATING`）なら updatedAt が新しければ処理中＋再取得、古ければ再試行表示、(4) は微修正中の入力が復元されること。`FAILED` なら再試行表示になること。
- **課金**：`AWS/Bedrock` `Invocations` が増えすぎないこと。

---

### TC-8. 入力変更後の再生成（古いドラフトを返さない）

proposal §3（テキスト入力が一次情報）・§6 冪等キーの `inputHash` に対応。

**手順：**

1. 写真をアップロードし生成 → SUCCEEDED を確認する。
2. **写真はそのまま**、当日メモ（または翌日予定）だけを変更して保存し、再生成する。
3. 変更後のドラフトが返ることを確認する。
4. 参考：入力を元に戻して再生成すると、元の冪等キーにヒットし `idempotent: true` で旧結果が返ることも確認する。

**期待結果：**

- 手順2の再生成は `inputHash` が変わるため**新規生成**され（`idempotent: false`・Bedrock Invocation が1回増える）、**変更前の古いドラフトを返さない**。生成結果は変更後のメモ・翌日予定を反映している。

**確認方法：**

- **ログ**：新しい idempotencyKey で SUCCEEDED が記録されること。
- **DB**：GenerationJobs に別キーのレコードが増えること。
- **課金**：意図した1回分のみ `Invocations` が増加すること。

> 注：これは誤った日報を確定させないデータ完全性のテストであり、単なるキャッシュ効率の問題ではない。

---

### TC-7. 判定記録テンプレート

各テストケースの合否と証拠を1行ずつ記録する。証拠はログ/DB/課金のスクリーンショットまたはロググループ URL・request ID を貼付する。

| # | テストケース | 合否 (Pass/Fail) | 情報漏えい無 | 二重課金無 | 不整合無 | 証拠（ログ/DB/課金） | 備考 |
|---|---|---|---|---|---|---|---|
| TC-1 | 認可違反（IDOR 否定テスト） | | ☐ | ☐ | ☐ | | |
| TC-2 | Bedrock throttle / timeout | | ☐ | ☐ | ☐ | | 実発生/擬似の別を記載 |
| TC-3 | Lambda 再実行・重複クリック | | ☐ | ☐ | ☐ | | 冪等抑止ログの request ID |
| TC-4 | AppSync 30秒タイムアウト | | ☐ | ☐ | ☐ | | 3種タイムアウトの別を記載 |
| TC-5 | S3 失敗・同一写真再送 | | ☐ | ☐ | ☐ | | imageSetHash 一致の証拠 |
| TC-6 | 低速回線・切断・再読み込み | | ☐ | ☐ | ☐ | | ネットワーク制限設定値・4時点復元 |
| TC-8 | 入力変更後の再生成（新規生成・旧結果なし） | | ☐ | ☐ | ☐ | | inputHash 差分の証拠 |

---

## 完了条件チェックリスト（proposal §9 工程5 と1対1）

proposal §9 工程5 の完了条件は「**いずれも情報漏えい・二重課金・不整合が発生しない**」。全 TC を横断して以下を満たすこと：

- [ ] **情報漏えいなし**：TC-1 で、他ユーザー（B）から A の `reportId`／S3 key／`Report`／S3 オブジェクトに一切アクセスできない。**B 自身の Report の `photoKeys` に A の key を保存する allowlist 迂回、および owner 再割当も拒否される**（Data の owner 分離＋owner field-level authorization・Storage の `media/{entity_id}/*` 分離・generateReport の所有者再検証＋identityId プレフィックス検証が拒否する）。
- [ ] **二重課金なし**：TC-3・TC-4・TC-5・TC-6 で、同一入力（冪等キー `reportId + imageSetHash + inputHash + promptVersion + modelId + schemaVersion`）に対し Bedrock InvokeModel が**1回に収束**し、`AWS/Bedrock` `Invocations` が重複増加しない。TC-8 では入力変更で意図した新規生成1回のみが課金される（旧結果を返さず、かつ重複課金もしない）。TC-1・TC-2（拒否/throttle）では課金対象呼び出しが成立しない。
- [ ] **不整合なし**：TC-2・TC-4・TC-6 で、失敗・タイムアウト・切断が発生しても `Report` が二重確定・部分確定にならず、生成状態が一貫し、再試行が同一結果に収束する。TC-5 で `Photo`／`Report` が重複しない。FAILED→再試行成功・lease takeover が機能し、恒久的な再試行不能状態が存在しない。
- [ ] **ログ健全性**：全 TC で画像・プロンプト本文が通常ログに出ておらず、記録項目は proposal §9 末尾の許可項目（request ID・非可逆 report ID・モデルID・latency・usage・結果状態・冪等/重複抑止結果）のみ。

---

## process.md ゲートとの対応

- **S-tech の必須条件（process.md §2 v2）**：本手順書のうち以下は **S-tech に必須**である。人に触ってもらう共有状態で、写真漏えい・二重課金・状態不整合が起き得る構成を許容しないため。
  - **TC-1（IDOR 否定テスト）**：手順2〜6 全経路（他人の reportId／S3 key、**B所有 Report＋Aの key（allowlist 迂回）**、owner 再割当）が拒否されること
  - **TC-3（重複クリック／冪等抑止・lease takeover）**：同一入力で Bedrock 呼び出しが1回に収束すること
  - **TC-4（AppSync 30秒タイムアウト）**：タイムアウト発生時も状態不整合・二重課金にならないこと（または非同期化の判断・切替が済んでいること）
  - **ログ健全性**：全ケースで画像・プロンプト本文がログに出ていないこと
  - 判定記録は TC-7 テンプレに残し、S-tech の証拠として提出する（process.md §2 v2）。
- **ストレッチ扱い（S-tech 必須ではない）**：**TC-2（throttle/timeout の擬似・実発生の網羅）・TC-5（S3 失敗・再送）・TC-6（低速回線・切断・再読み込み）・TC-8（入力変更後の再生成）の網羅的合格**、および AppSync 30秒の P95 網羅計測（初回コンパイル・24時間キャッシュ失効込み）は、process.md §3 ストレッチ目標に位置づけられる。S-tech 達成後の作り込みとして実施する。

---

## 失敗時の対処

- **TC-1 で A のデータが返る／拒否されない**：generateReport 内の所有者再検証（`cognitoIdentityAuthProvider` からの sub 抽出と `Report.owner` 突合）と **S3 key の identityId プレフィックス検証**（`media/{呼び出し元identityId}/` 配下のみ許可。工程2 ステップ3-B）を見直す。クライアント入力の `reportId`／key／**クライアント更新可能な `Report.photoKeys`** をそのまま信用しない。Lambda の S3 権限が `media/*` の `GetObject` に限定されているか、Data の `allow.owner()`＋owner の field-level authorization（再割当禁止）・Storage の `media/{entity_id}/*` 規則、モデルへの `allow.authenticated()`／API key／公開バケットを使っていないことを確認（proposal §4・§6）。
- **TC-2 で確定保存されてしまう／再試行不可**：例外捕捉と生成状態管理を修正し、失敗時は成功確定しない。UI の再試行可能状態表示を実装。FAILED からの再取得条件（`attribute_not_exists` OR `status=FAILED` OR lease失効）と attemptId 条件付き更新（03_step2_ai.md ステップ3 (D)）を確認する。ConditionalCheckFailedException を一律 IN_PROGRESS 扱いにしていないか確認する。
- **TC-3・TC-4・TC-5・TC-6 で二重実行・二重確定**：冪等キー（`reportId + imageSetHash + inputHash + promptVersion + modelId + schemaVersion`）の生成・保存・判定ロジックを見直す。生成状態を DynamoDB に保存し、同一キーの再呼び出しで Bedrock を再実行しないこと（proposal §6）。
- **TC-4 で 30秒安定超過**：proposal §9 工程0 の判定基準（初回コンパイルの実測最大値 < 25秒、またはウォームアップで初回を利用者経路から確実に除外。かつ定常 P95 に余裕。`01_step0_spike.md` ステップ7）に照らし、ウォームアップ（初回スキーマ事前コンパイル）を追加、なお超えるなら**非同期（`03b_step2_async.md`）へ切替**。切替後は本手順書 TC-2・TC-4 のクライアント挙動をポーリング状態遷移に読み替えて再テスト。
- **TC-6 で状態復元されない**：(1) 工程2 handler の Report 永続化（成功時 `draft*`＋`genStatus=GENERATED`、失敗時 `FAILED`。03_step2_ai.md ステップ3）と、(2) 工程3 UI の復元ロジック（初期表示時に Report・photoKeys・入力値・draft*・genStatus をサーバーから完全復元する restore。04_step3_ui.md §2-3）の両方が実装されているか確認する。

---

## 裏取りメモ（AWS 公式ドキュメント確認事項）

本手順書に記載した AWS 挙動は以下で確認済み（推測で仕様を書かない方針）：

- **Bedrock `ThrottlingException`**（bedrock-runtime）：「Your request was throttled because of service-wide limitations. Resubmit your request later or in a different region.」／InvokeModel は `ThrottlingException`・`ModelTimeoutException`・`ServiceQuotaExceededException`・`ServiceUnavailableException` 等を返す（AWS SDK 公式リファレンス）。
- **Bedrock `ModelTimeoutException`**：「The request took too long to process. Processing time exceeded the model timeout length.」（Bedrock Runtime API リファレンス）。
- **Lambda 再試行挙動**：「Understanding retry behavior in Lambda」／「Synchronous invocations: the caller receives the timeout error and is responsible for retrying」。**同期呼び出しで Lambda は自動再試行しない**（自動2回再試行は非同期呼び出しのみ）。AppSync→Lambda は同期呼び出し。
- **AppSync 30秒制限**：「AWS AppSync limits GraphQL query execution to a maximum of 30 seconds.」（AWS 公式ブログ）。超過時、Amplify Data クライアントは成功データを受け取らず `errors`（例外/`APIException`）として扱う（Amplify Gen2 データアクセス公式）。
