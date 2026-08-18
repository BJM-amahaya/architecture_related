# 工程3 実装手順書：UI 統合（GenbaLog / React Native (Expo)）

> 対象: `proposal.md` §9「工程3：UI 統合」 / 評価ゲート: `process.md`（v2） **A+**（一気通貫デモ）〜 **S-tech**（EAS 内部配布 or 通しデモ）
> 前工程手順書: `02_step1_data.md`（Data/Storage）, `03_step2_ai.md`（generateReport。非同期採用時は `03b_step2_async.md`）
> フロント技術は **React Native (Expo)** に統一（2026-07-10 チーム決定。proposal §4 決定記録）。

---

## 0. 目的・前提

**目的**: 「撮って書き足すだけで日報が仕上がる」体験を、ログイン → 日報作成（日付=当日既定・現場確定）→ 撮影＋最小テキスト入力 → AI生成 → 確認・微修正 → 確定保存 → 一覧 → PDF出力 の一気通貫 UI として実装する（proposal §3 の3ステップを画面に落とす）。

**依存する工程（完了していること）**:
- **工程1（`Site`/`Report`/`Photo` の Data / `media/{entity_id}/*` の Storage）が完了**。`amplify_outputs.json` が生成済みで、Cognito ログイン・S3 アップロードが sandbox で動く。
- **工程2（custom query `generateReport`）が完了**。同期方式（`03_step2_ai.md`）を前提に記述する（非同期採用時は §2-3 の代替と `03b_step2_async.md` ステップ6 を参照）。

**共通仕様（本 PoC 全体で厳守）**:
- Bedrock モデルID: `anthropic.claude-haiku-4-5-20251001-v1:0` / リージョン: `ap-northeast-1`（UI からは直接呼ばず、`generateReport` 経由）
- データモデル: `Site` / `Report` / `Photo`、S3 パス: `media/{entity_id}/*`（`entity_id` = Cognito **identity id**）、冪等キー: `reportId + imageSetHash + inputHash + promptVersion + modelId + schemaVersion`（`00_overview.md` §3.4）
- フロント: **Expo（Expo Router）+ `@aws-amplify/ui-react-native`（Authenticator）**。撮影/選択は expo-image-picker（必要に応じ expo-camera）、圧縮は expo-image-manipulator（長辺1,568px）、PDF は **expo-print によるクライアント側生成**（Lambda PDF なし。proposal §9 工程3）。配布は Expo Go / EAS 開発ビルド（ストア申請なし）。

**設計原則（このファイルで最重要の2点）**:
1. **`reportId` は URL（ルートパラメータ）に永続化する**。Report 作成後は必ず `/reports/[id]/edit` へ遷移し、**アプリ再起動・画面再読み込み後も Report 本体・写真・入力値・ドラフト・生成状態をサーバーから再取得して完全復元**する。React state だけに状態を持たない（工程5 TC-6）。
2. **作成順と必須項目の整合**：`Report.reportDate` は必須（工程1）。UI は**日付＝当日を既定値**にし、**現場（Site）と日付を確定して `Report.create` に成功してから写真 UI を有効化**する。「写真を先に撮ったら必須項目エラーで Report 作成に失敗する」経路を作らない。

---

## 1. フロント基盤セットアップ

### ステップ 1-1. プロジェクト作成と依存パッケージ

> ⚠ グローバル規約: `npm install` は `--ignore-scripts` を付ける。新規パッケージ追加は事前確認。`npx` 実行（`create-expo-app` 等）も事前確認の対象。

```bash
# Expo プロジェクト作成（Expo Router テンプレート）
npx create-expo-app@latest genbalog --template default   # app/ ディレクトリ（Expo Router）構成
cd genbalog

# Amplify（Gen2 クライアント + RN 用 UI）と RN 前提ライブラリ
npm install --ignore-scripts aws-amplify @aws-amplify/ui-react-native \
  @aws-amplify/react-native react-native-safe-area-context @react-native-community/netinfo \
  @react-native-async-storage/async-storage react-native-get-random-values react-native-url-polyfill

# Expo モジュール（撮影・圧縮・PDF・共有）は expo install で SDK 互換版を入れる
npx expo install expo-image-picker expo-image-manipulator expo-print expo-sharing
```

- `@aws-amplify/react-native` と polyfill 群（AsyncStorage / netinfo / get-random-values / url-polyfill）は **Amplify v6 を React Native で使うための公式必須依存**。
- `expo-camera` はファインダー UI を自作したい場合のみ追加（本手順の主線は expo-image-picker の `launchCameraAsync` でネイティブカメラを起動する構成。権限ダイアログも同 API が管理する）。

### ステップ 1-2. Amplify 設定（アプリ起動時に一度だけ）

```tsx
// app/_layout.tsx（Expo Router のルートレイアウト）
import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';
import { Amplify } from 'aws-amplify';
import { Authenticator } from '@aws-amplify/ui-react-native';
import { Stack } from 'expo-router';
import outputs from '../amplify_outputs.json';

Amplify.configure(outputs); // モジュール読み込み時に一度だけ（他の Amplify API より先）

export default function RootLayout() {
  return (
    // email/password ログイン（工程1の defineAuth 設定に一致）
    <Authenticator.Provider>
      <Authenticator>
        <Stack screenOptions={{ headerTitle: 'GenbaLog' }} />
      </Authenticator>
    </Authenticator.Provider>
  );
}
```

> ⚠ 注意: `Amplify.configure` 前に他の Amplify API を使うと `NoCredentials`／未設定エラーになる。必ずルートレイアウトの先頭（モジュールスコープ）で呼ぶ。

### ステップ 1-3. 画面構成（Expo Router）

```
app/
  _layout.tsx              … 認証＋Amplify設定（§1-2）
  index.tsx                … 一覧（ホーム）
  reports/
    new.tsx                … 日報作成の入口（現場＋日付を確定 → Report.create → edit へ replace）
    [id]/
      edit.tsx             … 日報編集（撮影→入力→生成→確認→確定。リロード復元の本体）
src/lib/
  amplifyClient.ts         … generateClient を1箇所で生成
  compressImage.ts         … 画像圧縮（長辺1,568px / expo-image-manipulator）
  printReport.ts           … PDF出力（expo-print）
```

---

## 2. 画面フロー実装

### ステップ 2-0. Data クライアント（共通）

```ts
// src/lib/amplifyClient.ts
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '@/amplify/data/resource'; // 工程1で定義した Schema 型

export const client = generateClient<Schema>();
```

### ステップ 2-1. 画像圧縮（長辺1,568px / expo-image-manipulator）

proposal §6 のとおり、**Claude が API 側で自動縮小する上限（長辺1,568px）にクライアントで合わせて**アップロード帯域とトークンの無駄を削る。

```ts
// src/lib/compressImage.ts
import * as ImageManipulator from 'expo-image-manipulator';

const MAX_EDGE = 1568;

// picker の asset（uri / width / height）を受け取り、長辺 1,568px・JPEG に圧縮した uri を返す
export async function compressImage(asset: {
  uri: string; width: number; height: number;
}): Promise<{ uri: string }> {
  const longEdge = Math.max(asset.width, asset.height);
  const actions =
    longEdge <= MAX_EDGE
      ? [] // 既に小さければリサイズしない（再エンコードのみ）
      : [
          asset.width >= asset.height
            ? { resize: { width: MAX_EDGE } }   // 横長: 幅を上限に（縦横比は維持される）
            : { resize: { height: MAX_EDGE } }, // 縦長: 高さを上限に
        ];
  const result = await ImageManipulator.manipulateAsync(asset.uri, actions, {
    compress: 0.8,
    format: ImageManipulator.SaveFormat.JPEG, // 出力 MIME は JPEG に固定（サーバー側検証と一致）
  });
  return { uri: result.uri };
}
```

### ステップ 2-2. 日報作成の入口：現場＋日付（当日既定）→ `Report.create` → 編集画面へ

**写真より先に Report を確定させる**（設計原則2）。日付は当日を既定値にするため、通常のユーザー操作は「現場を選ぶ（または新規入力）→ 作成」だけで済み、「撮って書き足すだけ」の体験を損なわない。

```tsx
// app/reports/new.tsx
import { useEffect, useState } from 'react';
import { View, Text, TextInput, Button, Alert } from 'react-native';
import { Picker } from '@react-native-picker/picker'; // 追加時は事前確認のうえ npx expo install
import { router } from 'expo-router';
import { client } from '@/src/lib/amplifyClient';

const today = () => new Date().toISOString().slice(0, 10); // 日付の既定値＝当日

export default function NewReportScreen() {
  const [sites, setSites] = useState<{ id: string; name: string }[]>([]);
  const [siteId, setSiteId] = useState('');
  const [newSiteName, setNewSiteName] = useState('');
  const [reportDate, setReportDate] = useState(today()); // ★ 既定値＝当日（必須項目を空にしない）
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    client.models.Site.list().then(({ data }) => setSites((data ?? []) as any));
  }, []);

  async function resolveSiteId(): Promise<string> {
    if (siteId) return siteId;
    if (!newSiteName.trim()) throw new Error('現場を選択または入力してください');
    const { data, errors } = await client.models.Site.create({ name: newSiteName.trim() });
    if (errors || !data) throw new Error('現場（Site）の作成に失敗しました');
    return data.id;
  }

  // 現場＋日付を確定してから Report を作成し、編集画面（/reports/[id]/edit）へ replace。
  // 以降の全状態は reportId（URL パラメータ）起点でサーバーから復元できる（設計原則1）。
  async function handleCreate() {
    setCreating(true);
    try {
      if (!reportDate) throw new Error('日付を入力してください'); // required（工程1）
      const resolvedSiteId = await resolveSiteId();
      const { data, errors } = await client.models.Report.create({
        siteId: resolvedSiteId,
        reportDate,
        genStatus: 'DRAFT',
      });
      if (errors || !data) throw new Error('Report の作成に失敗しました');
      router.replace(`/reports/${data.id}/edit`); // ★ push でなく replace（戻るで二重作成しない）
    } catch (e: any) {
      Alert.alert('作成できません', e?.message ?? 'エラーが発生しました');
    } finally {
      setCreating(false);
    }
  }

  return (
    <View>
      <Text>現場</Text>
      <Picker selectedValue={siteId} onValueChange={setSiteId}>
        <Picker.Item label="（現場を選択 / 新規は下に入力）" value="" />
        {sites.map((s) => <Picker.Item key={s.id} label={s.name} value={s.id} />)}
      </Picker>
      {!siteId && (
        <TextInput value={newSiteName} onChangeText={setNewSiteName} placeholder="新しい現場名" />
      )}
      <Text>日付（既定: 当日）</Text>
      <TextInput value={reportDate} onChangeText={setReportDate} placeholder="YYYY-MM-DD" />
      <Button title="日報を作成して撮影へ" onPress={handleCreate} disabled={creating} />
    </View>
  );
}
```

> ⚠ 差異注記（作成順の整合）: 旧版は「最初の写真選択時に Report を作成」しており、日付が空のままだと必須 `reportDate` の検証で `Report.create` が失敗し得た。本版は **日付＝当日既定＋現場確定 → Report.create → 写真UI有効化** の順序に固定し、この経路を排除した（`02_step1_data.md` のスキーマ注記と対応）。加えて工程2 handler も日付・文字数をサーバー検証する（UI だけに依存しない）。

### ステップ 2-3. 日報編集画面：復元 → 撮影/圧縮/アップロード → 入力 → 生成 → 確認 → 確定

編集画面が本手順書の中心。**初期表示で必ずサーバーから全状態を復元**する。

```tsx
// app/reports/[id]/edit.tsx（骨子。生成・確定の詳細は §2-4/§2-5）
import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Button, Image, Alert } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { uploadData, getUrl } from 'aws-amplify/storage';
import { client } from '@/src/lib/amplifyClient';
import { compressImage } from '@/src/lib/compressImage';

const MAX_PHOTOS = 3;       // 写真枚数上限（コスト/連打対策）
const MAX_REGENERATE = 3;   // 表示用の目安。★上限の正本はサーバー側 quota（工程2 (D')）

type GenStatus = 'DRAFT' | 'GENERATING' | 'GENERATED' | 'CONFIRMED' | 'FAILED';

export default function EditReportScreen() {
  const { id: reportId } = useLocalSearchParams<{ id: string }>(); // ★ URL から復元（React state に依存しない）

  const [loaded, setLoaded] = useState(false);
  const [reportDate, setReportDate] = useState('');
  const [workType, setWorkType] = useState('');
  const [memo, setMemo] = useState('');
  const [nextPlanInput, setNextPlanInput] = useState('');
  const [photoKeys, setPhotoKeys] = useState<string[]>([]);
  const [photoUrls, setPhotoUrls] = useState<string[]>([]); // サムネイル表示用（getUrl で解決）
  const [genStatus, setGenStatus] = useState<GenStatus>('DRAFT');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [genUpdatedAt, setGenUpdatedAt] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // ── 状態復元（初期表示・アプリ再起動・切断復帰。工程5 TC-6 の本体）───────────
  //   Report 本体（入力値・photoKeys・draft*・genStatus・updatedAt）をサーバーから読み直し、
  //   写真は S3 の getUrl でサムネイルを再解決する。GENERATING の扱いは §2-4 参照。
  const restore = useCallback(async () => {
    if (!reportId) return;
    const { data } = await client.models.Report.get({ id: reportId });
    if (!data) { Alert.alert('日報が見つかりません'); return; }
    setReportDate(data.reportDate ?? '');
    setWorkType(data.workType ?? '');
    setMemo(data.memo ?? '');
    setNextPlanInput(data.nextPlanInput ?? '');
    const keys = (data.photoKeys ?? []).filter((k): k is string => !!k);
    setPhotoKeys(keys);
    const urls = await Promise.all(
      keys.map(async (k) => (await getUrl({ path: k })).url.toString())
    );
    setPhotoUrls(urls);
    setGenStatus((data.genStatus as GenStatus) ?? 'DRAFT');
    setGenUpdatedAt(data.updatedAt ?? null);
    if (data.genStatus === 'GENERATED' || data.genStatus === 'CONFIRMED') {
      setDraft({
        work: data.draftWork ?? '',
        progress: data.draftProgress ?? '',
        safety: { confirmed: data.draftSafetyConfirmed ?? '', unconfirmed: data.draftSafetyUnconfirmed ?? '' },
        tomorrow: data.draftTomorrow ?? '',
        status: 'needs_review', // 復元時は要確認扱いで表示（人の確認を促す）
        idempotent: false,
      });
    }
    setLoaded(true);
  }, [reportId]);

  useEffect(() => { restore(); }, [restore]);

  // ── 撮影/選択 → 圧縮 → アップロード → Photo.create → Report.photoKeys 更新 ─────
  async function handlePickPhoto(fromCamera: boolean) {
    if (photoKeys.length >= MAX_PHOTOS) { Alert.alert(`写真は最大 ${MAX_PHOTOS} 枚までです`); return; }
    const perm = fromCamera
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('権限が必要です', '設定アプリからカメラ/写真へのアクセスを許可してください'); return; }

    const picked = fromCamera
      ? await ImagePicker.launchCameraAsync({ quality: 1 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    if (picked.canceled || !picked.assets?.[0]) return;

    setUploading(true);
    try {
      const { uri } = await compressImage(picked.assets[0]); // 長辺1,568px / JPEG
      const blob = await (await fetch(uri)).blob();          // RN では fetch(uri).blob() でバイト化

      // entity_id(=identityId) 配下へアップロード。ファイル名は衝突回避のため連番
      const index = photoKeys.length;
      const result = await uploadData({
        path: ({ identityId }) => `media/${identityId}/${reportId}/${index}.jpg`,
        data: blob,
        options: { contentType: 'image/jpeg' },
      }).result;

      // Photo レコード（S3 key を記録）
      await client.models.Photo.create({ reportId: reportId!, s3Key: result.path });

      // ★ 必須: Report.photoKeys へ S3 key 配列を保存（表示・整合性チェック用）。
      //   未保存だと工程2の整合性チェックで生成が拒否される。認可の正本は
      //   工程2の identityId プレフィックス検証であり、photoKeys ではない（proposal §6）。
      const nextKeys = [...photoKeys, result.path];
      const { errors } = await client.models.Report.update({ id: reportId!, photoKeys: nextKeys });
      if (errors) throw new Error('写真キーの保存に失敗しました');

      setPhotoKeys(nextKeys);
      setPhotoUrls((prev) => [...prev, (URL as any).createObjectURL?.(blob) ?? uri]); // 表示はローカル uri で足りる
    } catch (e) {
      console.error(e);
      Alert.alert('アップロードに失敗しました', '電波状況を確認して再試行してください。');
    } finally {
      setUploading(false);
    }
  }

  if (!loaded) return <Text>読み込み中…</Text>;

  return (
    <View>
      <Text>日報編集（{reportDate}）</Text>

      {/* 撮影/選択（Report 作成済みのため常に有効。上限のみ制御） */}
      <Button title="カメラで撮影" onPress={() => handlePickPhoto(true)}
        disabled={uploading || photoKeys.length >= MAX_PHOTOS} />
      <Button title="写真から選択" onPress={() => handlePickPhoto(false)}
        disabled={uploading || photoKeys.length >= MAX_PHOTOS} />
      <Text>アップロード済み: {photoKeys.length} / {MAX_PHOTOS}</Text>
      <View style={{ flexDirection: 'row' }}>
        {photoUrls.map((u, i) => <Image key={i} source={{ uri: u }} style={{ width: 80, height: 80 }} />)}
      </View>

      {/* 最小テキスト入力（現場・日付は作成時に確定済み。日付はここでも変更可） */}
      <TextInput value={reportDate} onChangeText={setReportDate} placeholder="日付 YYYY-MM-DD" />
      <TextInput value={workType} onChangeText={setWorkType} placeholder="工種" />
      <TextInput value={memo} onChangeText={setMemo} placeholder="当日メモ" multiline />
      <TextInput value={nextPlanInput} onChangeText={setNextPlanInput} placeholder="翌日予定" multiline />

      {/* 生成〜確認・確定（§2-4 / §2-5） */}
      <GenerateSection
        reportId={reportId!}
        photoKeys={photoKeys}
        input={{ reportDate, workType, memo, nextPlanInput }}
        genStatus={genStatus} setGenStatus={setGenStatus}
        draft={draft} setDraft={setDraft}
        genUpdatedAt={genUpdatedAt}
        onRestore={restore}
      />
    </View>
  );
}
```

### ステップ 2-4. AI生成：`generateReport` 呼び出し（ボタン無効化・サーバー quota・GENERATING の扱い）

- custom query は **`client.queries.generateReport({ reportId, photoKeys }, { authMode: 'identityPool' })`** で呼ぶ。**`authMode: 'identityPool'` は必須**——工程2は identityPool（IAM）認可で、handler が `cognitoIdentityId` により S3 key のプレフィックス検証（IDOR 対策の正本）を行うため。
- **生成前に入力を `Report.update`** で保存（`reportDate / workType / memo / nextPlanInput` と `genStatus: 'GENERATING'`）してから呼ぶ（handler は Report から入力を読む）。
- **回数上限の正本はサーバー側 quota（工程2 (D')）**。クライアントの `count` はリロード・別端末でリセットされるため**費用ガードレールにしない**。UI は quota 超過エラー（`Generation quota exceeded`）を受けたら「本日の生成上限に達しました」を表示する。
- **冪等キーに `inputHash` が含まれる**ため、写真が同じでもメモ・翌日予定を変更して再生成すれば**新しいドラフト**が返る（旧結果のキャッシュは返らない。工程5 TC-8）。同一入力の再生成のみ `idempotent: true`（再課金なし）になる。
- **`genStatus` の責任分担（工程2確定）**：UI は `DRAFT`／`GENERATING`／`CONFIRMED`、handler は `GENERATED`／`FAILED`＋ドラフト本文を Report へ永続化する。
- **`GENERATING` の復元時の扱い**：初期表示で `GENERATING` だった場合、(a) `updatedAt` が新しい（例: 90秒以内）なら実行中とみなし **3秒間隔のポーリング**（`restore` の再実行）で完了を待つ、(b) `updatedAt` が古い（lease 失効相当）なら「前回の生成が中断された可能性」として**再試行ボタン**を表示する。再試行は冪等キー＋lease takeover（工程2 (D)）により二重課金しない。

```tsx
// app/reports/[id]/edit.tsx 内 GenerateSection（骨子）
export interface Draft {
  work: string;
  progress: string;
  safety: { confirmed: string; unconfirmed: string };
  tomorrow: string;
  status: 'ok' | 'needs_review' | 'unknown';
  idempotent: boolean;
}

const STALE_GENERATING_MS = 90_000; // lease（60秒）＋余裕。これより古い GENERATING は中断扱い

function GenerateSection({ reportId, photoKeys, input, genStatus, setGenStatus, draft, setDraft, genUpdatedAt, onRestore }: Props) {
  // GENERATING を復元した場合のポーリング（3秒間隔・updatedAt が新しい間のみ）
  useEffect(() => {
    if (genStatus !== 'GENERATING') return;
    const fresh = genUpdatedAt && Date.now() - Date.parse(genUpdatedAt) < STALE_GENERATING_MS;
    if (!fresh) return; // 古い GENERATING はポーリングせず再試行ボタンに委ねる
    const timer = setInterval(onRestore, 3000);
    return () => clearInterval(timer);
  }, [genStatus, genUpdatedAt, onRestore]);

  const staleGenerating =
    genStatus === 'GENERATING' &&
    (!genUpdatedAt || Date.now() - Date.parse(genUpdatedAt) >= STALE_GENERATING_MS);
  const disabled =
    (genStatus === 'GENERATING' && !staleGenerating) || photoKeys.length === 0;

  async function handleGenerate() {
    setGenStatus('GENERATING'); // ボタン無効化・処理中表示
    try {
      // 1) 入力を Report へ保存＋GENERATING（UI の責任範囲）
      const { errors: updErrors } = await client.models.Report.update({
        id: reportId, ...input, genStatus: 'GENERATING',
      });
      if (updErrors) throw new Error('入力の保存に失敗しました');

      // 2) custom query（identityPool 認可・引数は工程2確定）
      const { data, errors } = await client.queries.generateReport(
        { reportId, photoKeys },
        { authMode: 'identityPool' },
      );
      if (errors || !data) {
        const msg = errors?.[0]?.message ?? '';
        if (msg.includes('quota')) throw new Error('QUOTA'); // サーバー quota 超過（正本）
        if (msg.includes('in progress')) throw new Error('IN_PROGRESS');
        throw new Error('生成に失敗しました');
      }

      // 3) 表示（Report への永続化は handler 実施済み。UI は genStatus を書き戻さない）
      const d = data as unknown as Draft;
      setDraft({ ...d, safety: { confirmed: d.safety?.confirmed ?? '', unconfirmed: d.safety?.unconfirmed ?? '' } });
      setGenStatus('GENERATED'); // ローカル表示のみ
    } catch (err: any) {
      if (err?.message === 'QUOTA') {
        Alert.alert('生成上限', '生成回数の上限に達しました（サーバー側で制限しています）。');
      } else if (err?.message === 'IN_PROGRESS') {
        // 先行実行中：ポーリングに切り替える（restore が拾う）
      } else {
        setGenStatus('FAILED'); // ローカル表示。Report 側は handler が FAILED を保存する
      }
    }
  }

  return (
    <View>
      <Button title={genStatus === 'GENERATING' && !staleGenerating ? 'AIが生成中…' : 'AIで日報生成'}
        onPress={handleGenerate} disabled={disabled} />
      {genStatus === 'GENERATING' && !staleGenerating && (
        <Text>写真とメモを解析しています（最大30秒）… 自動で結果を確認します</Text>
      )}
      {staleGenerating && (
        <Text>前回の生成が中断された可能性があります。再度「AIで日報生成」を押してください（二重課金されません）。</Text>
      )}
      {genStatus === 'FAILED' && <Text>生成に失敗しました。再試行してください（サーバー側で再試行可能な状態に戻っています）。</Text>}
      {draft?.idempotent && <Text>同一入力のため、前回の生成結果を表示しています（再課金なし）。</Text>}
      {draft?.status === 'needs_review' && <Text>要確認項目があります。内容を確認してください。</Text>}
      {draft && <ConfirmEditor reportId={reportId} draft={draft} onDraftChange={setDraft} />}
    </View>
  );
}
```

> ✅ 工程2の確定定義に一致: 引数 `{ reportId, photoKeys }`＋`authMode: 'identityPool'`、戻り値 `ReportDraft { work, progress, safety:{confirmed,unconfirmed}, tomorrow, status, idempotent }`（`03_step2_ai.md`）。`photoKeys` は渡すが認可の正本ではない（identityId プレフィックス検証）。`imageSetHash`/`inputHash` は Lambda 算出。
>
> ⚠ 非同期方式が採用された場合（`03b_step2_async.md`）: `generateReport` は `{ jobId, status }` を返す受付になる。UI は受付後に **`Report.genStatus` を 2〜3秒間隔（バックオフ上限10秒・総上限3分）でポーリング**し、`GENERATED`/`FAILED` で終了する。本節の `restore` ポーリングがそのまま実体になり、ボタン無効化・quota・状態復元は共通（`03b_step2_async.md` ステップ6）。

### ステップ 2-5. 確認・微修正 → 確定保存（Report 更新）

- AI 出力は**ドラフト**（proposal §3）。監督が確認・微修正し、確定で `genStatus: 'CONFIRMED'` に更新する（UI の責任範囲）。
- 安全項目は「問題なし」を生成させない設計（工程2）。**確認できた事項（`safety.confirmed`）と画角外・未確認（`safety.unconfirmed`）を分けて表示・編集**する。

```tsx
// ConfirmEditor（骨子）
function ConfirmEditor({ reportId, draft, onDraftChange }: {
  reportId: string; draft: Draft; onDraftChange: (d: Draft) => void;
}) {
  async function handleConfirm() {
    const { errors } = await client.models.Report.update({
      id: reportId,
      draftWork: draft.work,
      draftProgress: draft.progress,
      draftSafetyConfirmed: draft.safety.confirmed,
      draftSafetyUnconfirmed: draft.safety.unconfirmed,
      draftTomorrow: draft.tomorrow,
      genStatus: 'CONFIRMED',
    });
    if (errors) { Alert.alert('保存に失敗しました'); return; }
    router.replace('/'); // 一覧へ
  }
  return (
    <View>
      <Text>作業内容</Text>
      <TextInput multiline value={draft.work} onChangeText={(t) => onDraftChange({ ...draft, work: t })} />
      <Text>進捗</Text>
      <TextInput multiline value={draft.progress} onChangeText={(t) => onDraftChange({ ...draft, progress: t })} />
      <Text>安全（確認できた事項）</Text>
      <TextInput multiline value={draft.safety.confirmed}
        onChangeText={(t) => onDraftChange({ ...draft, safety: { ...draft.safety, confirmed: t } })} />
      <Text>安全（画角外・未確認）</Text>
      <TextInput multiline value={draft.safety.unconfirmed}
        onChangeText={(t) => onDraftChange({ ...draft, safety: { ...draft.safety, unconfirmed: t } })} />
      <Text>翌日の予定</Text>
      <TextInput multiline value={draft.tomorrow} onChangeText={(t) => onDraftChange({ ...draft, tomorrow: t })} />
      <Button title="確定保存" onPress={handleConfirm} />
    </View>
  );
}
```

### ステップ 2-6. 一覧画面

```tsx
// app/index.tsx
import { useCallback, useState } from 'react';
import { View, Text, Button, FlatList } from 'react-native';
import { Link, useFocusEffect, router } from 'expo-router';
import { client } from '@/src/lib/amplifyClient';
import { printReport } from '@/src/lib/printReport';

export default function ListScreen() {
  const [reports, setReports] = useState<any[]>([]);

  useFocusEffect(useCallback(() => {
    // owner 認可により本人の Report のみ返る。現場名はリレーション経由で1回取得
    client.models.Report.list({
      selectionSet: ['id', 'reportDate', 'workType', 'genStatus', 'site.name'],
    }).then(({ data }) => setReports(data ?? []));
  }, []));

  return (
    <View>
      <Button title="＋ 新規作成" onPress={() => router.push('/reports/new')} />
      <FlatList
        data={reports}
        keyExtractor={(r) => r.id}
        renderItem={({ item: r }) => (
          <View>
            <Link href={`/reports/${r.id}/edit`}>
              <Text>{r.reportDate} / {r.site?.name} / {r.workType}（{r.genStatus}）</Text>
            </Link>
            <Button title="PDF" onPress={() => printReport(r.id)} />
          </View>
        )}
      />
    </View>
  );
}
```

### ステップ 2-7. PDF 出力（expo-print / クライアント側生成）

**Lambda での PDF 生成はしない**（proposal §9 工程3）。`expo-print` の `printToFileAsync` で HTML から PDF を生成し、`expo-sharing` で共有（保存/AirDrop/メール等）する。

```ts
// src/lib/printReport.ts
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { client } from '@/src/lib/amplifyClient';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export async function printReport(reportId: string): Promise<void> {
  const { data: r } = await client.models.Report.get(
    { id: reportId },
    { selectionSet: ['id', 'reportDate', 'workType', 'site.name',
      'draftWork', 'draftProgress', 'draftSafetyConfirmed', 'draftSafetyUnconfirmed', 'draftTomorrow'] },
  );
  if (!r) return;
  const html = `
    <html><body style="font-family: sans-serif; font-size: 11pt; padding: 12mm;">
      <h1>作業日報</h1>
      <p>現場: ${esc(r.site?.name)} ／ 日付: ${esc(r.reportDate)} ／ 工種: ${esc(r.workType)}</p>
      <h2>作業内容</h2><p>${esc(r.draftWork)}</p>
      <h2>進捗</h2><p>${esc(r.draftProgress)}</p>
      <h2>安全・懸念</h2>
      <h3>確認できた事項</h3><p>${esc(r.draftSafetyConfirmed)}</p>
      <h3>画角外・未確認</h3><p>${esc(r.draftSafetyUnconfirmed)}</p>
      <h2>翌日の予定</h2><p>${esc(r.draftTomorrow)}</p>
    </body></html>`;
  const { uri } = await Print.printToFileAsync({ html }); // PDF ファイル生成（クライアント側）
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' });
  }
}
```

---

## 3. 動作確認（A+評価の証拠取得）

`process.md` **A+** の到達条件（ログイン → 写真アップロード → AI生成 → 確定保存 → 一覧表示 の一気通貫）を、以下の順で sandbox＋実機（Expo Go / 開発ビルド）で確認する。

### ステップ 3-1. sandbox 起動と開発サーバー

```bash
npx ampx sandbox        # 別ターミナルで常駐（amplify_outputs.json を生成/更新）
npx expo start          # Metro 起動。実機の Expo Go / 開発ビルドで読み込む
```

### ステップ 3-2. 一気通貫の手順（画面録画しながら実施）

1. **ログイン**: Authenticator でメール/パスワードのサインアップ→ログイン。
2. **日報作成**: 「＋新規作成」→ 現場を選択（日付は当日が既定）→「日報を作成して撮影へ」→ 編集画面へ遷移（URL に reportId）。
3. **撮影**: 「カメラで撮影」→ 権限許可 → 撮影 → 圧縮・アップロード完了（枚数表示が増える）。
4. **入力**: 工種/当日メモ/翌日予定を入力。
5. **生成**: 「AIで日報生成」押下 → ボタン無効化＆生成中表示 → 4項目のドラフトが表示される。
6. **復元確認（TC-6 の先行確認）**: **アプリを完全終了（タスクキル）→ 再起動 → 一覧から同じ日報を開く** → 写真・入力・ドラフト・状態が復元されること。
7. **確認・微修正 → 確定**: テキストを微修正し「確定保存」。
8. **一覧**: 確定した日報が本人の一覧に出る。
9. **PDF**: 「PDF」→ expo-print で PDF 生成 → 共有シートで保存できる。

### ステップ 3-3. 証拠（チームレビュー提出物）

- **画面録画**（1〜9の通し動画）。`process.md` A+ の「通しデモ動画」。
- **CloudWatch ログ**: `generateReport` の Lambda ロググループで、当該生成の **request ID / report ID の非可逆識別子 / モデルID(`anthropic.claude-haiku-4-5-20251001-v1:0`) / latency / usage トークン / 結果状態** を確認（proposal §9「ログに記録する項目」）。画像・プロンプト本文がログに出ていないことも併せて確認。

---

## 4.（S-tech評価向け）EAS Build 内部配布と通しデモ

`process.md`（v2） **S-tech** の共有手段は「**EAS Build 内部配布（開発ビルド）での他メンバー実機確認**」または「**チーム前通しデモ成功**」。

1. **EAS 設定**: `npm install --ignore-scripts -g eas-cli`（または `npx eas-cli`。実行前確認）→ `eas login` → `eas build:configure`（`eas.json` 生成）。
2. **内部配布ビルド**: `eas build --profile development --platform android`（iOS は Apple Developer 資格が必要なため、PoC では Android 内部配布＋iOS は Expo Go 実演の組み合わせでもよい）。ビルド完了後に発行される**配布リンク（install URL）**を他メンバーへ共有し、実機にインストールしてもらう。
3. **確認**: 別アカウントでサインアップ→本人分の日報のみ見えること（`allow.owner()`）を確認。
4. **安全ゲート（S-tech 必須・process.md §2 v2）**: 写真枚数上限（`MAX_PHOTOS`）・生成ボタン連打防止（無効化）・**サーバー側 quota** に加え、**工程5 の TC-1（IDOR 否定テスト）・TC-3（冪等抑止）・TC-4（AppSync timeout 健全性）の合格、ログ本文非出力の確認、AWS Budgets 設定（工程1）、最小品質スモーク（工程4 §0）**が必須条件。判定記録（工程5 TC-7 テンプレ）とスクリーンショットを証拠として揃える。

> ⚠ 注意: EAS Build のビルド回数はコスト要因（proposal §5 表A/表B。Free plan の枠と超過料金は expo.dev/pricing で確認）。配布リンクの共有範囲はチーム内に限定する。ストア申請は行わない（proposal §5）。

---

## 5. 完了条件チェックリスト（proposal §9 工程3 と1対1）

| # | proposal §9 工程3 の内容 | 本手順書の対応 | 完了確認 |
|---|---|---|---|
| A | 撮影＋最小テキスト入力 | §2-3（expo-image-picker＋5項目。日付は当日既定・現場確定後に撮影） | ☐ 撮影/選択・入力ができる |
| B | 生成（ボタン無効化・処理中/再試行表示・サーバー quota 超過表示） | §2-4 | ☐ 無効化・処理中/エラー/quota 表示が動く |
| C | **編集 URL への reportId 永続化と完全復元** | §2-2（replace 遷移）＋§2-3（`restore`） | ☐ アプリ完全再起動後に写真・入力・ドラフト・状態が復元される |
| D | 確認・微修正 → 確定 | §2-5（`Report.update` → `genStatus: 'CONFIRMED'`） | ☐ 微修正して確定保存できる |
| E | 一覧表示 | §2-6（`Report.list`、owner 認可） | ☐ 本人の日報が一覧に出る |
| F | PDF出力（クライアント側 / Lambda PDF なし） | §2-7（expo-print + expo-sharing） | ☐ PDF が生成・共有できる |

**process.md ゲート対応**:
- **A+**: §3-2 の一気通貫 ＋ §3-3 の画面録画・CloudWatch ログ（Bedrock 応答確認）。
- **S-tech**: §4 の EAS 内部配布 or 通しデモ ＋ 安全ゲート（TC-1/3/4・ログ本文非出力・Budgets・最小品質スモーク。process.md §2 v2）。

---

## 6. 失敗時の代替

| 症状 | 原因の候補 | 代替・対処 |
|---|---|---|
| `NoCredentials`／未設定エラー | `Amplify.configure` が API 呼び出し後 | §1-2 のとおりルートレイアウトのモジュールスコープで configure |
| カメラ/写真が開かない | 権限拒否 | `requestCameraPermissionsAsync` の結果を確認し、拒否時は設定アプリへの導線を表示（§2-3） |
| アップロードが 403 | `media/{entity_id}/*` に `allow.entity('identity')` 未設定、パスが identityId 配下でない | 工程1の Storage 定義を確認し、`path: ({ identityId }) => ...` に修正 |
| 生成が 30 秒でタイムアウト | AppSync 30 秒上限（proposal §6）／初回スキーマコンパイル | 工程2のウォームアップを実施。恒常的に超えるなら**非同期方式**（`03b_step2_async.md`）へ切替 |
| 生成が認可エラーで失敗する | `authMode: 'identityPool'` 未指定、未ログイン | §2-4 のとおり `{ authMode: 'identityPool' }` で呼ぶ（工程2は identityPool(IAM) 認可） |
| 生成が全拒否される | `Report.photoKeys` 未保存／他ユーザー・別パスの key 混入（プレフィックス検証で拒否） | §2-3 のとおりアップロード確定時に `Report.photoKeys` を保存。key が本人の `media/{identityId}/` 配下か確認 |
| 生成しても入力が反映されない | 生成前に入力を Report へ未保存（handler は Report から読む） | §2-4 のとおり `generateReport` 前に `Report.update` で入力を保存 |
| メモを変えたのに前と同じドラフトが返る | 冪等キーに `inputHash` が入っていない旧実装 | 工程2が `03_step2_ai.md`（inputHash 込み冪等キー）どおりか確認（工程5 TC-8） |
| 「生成上限」と表示される | サーバー側 quota（Report 単位/ユーザー×日次）到達 | 仕様どおり（費用ガードレールの正本）。上限値の見直しは工程2 の定数で行う |
| 二重生成・二重課金 | 連打・再送 | ボタン無効化＋冪等キー（lease 状態機械）で抑止。戻り値 `idempotent` で既存結果表示 |
| アプリ再起動後に状態が消える | 編集画面以外に state を持っている／`restore` 未実装 | §2-2 の replace 遷移と §2-3 の `restore`（Report・photoKeys・draft*・genStatus の再取得）を確認（工程5 TC-6） |
| `GENERATING` のまま動かない | 送信失敗や中断で handler 未到達 | §2-4 の stale 判定（`updatedAt` が古い）で再試行ボタンを表示。再試行は lease takeover で安全（工程2 (D)） |
| PDF が生成できない | expo-print 未インストール／共有不可端末 | `npx expo install expo-print expo-sharing` を確認。共有不可なら `Print.printAsync` で印刷ダイアログに切替 |

---

## 7. 他工程への依存・申し送り

- **工程1（依存・確定済み）**: Storage は `media/{entity_id}/*` ＋ `allow.entity('identity')`。`Report` の確定フィールド（`02_step1_data.md`）— 入力系 `reportDate（必須・UI は当日既定）/ workType / memo / nextPlanInput`、写真 key リスト `photoKeys: string[]`（**UI がアップロード確定時に保存。表示・整合性チェック用で認可の正本ではない**）、ドラフト保存先 `draftWork / draftProgress / draftSafetyConfirmed / draftSafetyUnconfirmed / draftTomorrow`（**生成成功時は handler が保存**）、状態 `genStatus`（enum: `DRAFT/GENERATING/GENERATED/CONFIRMED/FAILED`。**UI が DRAFT/GENERATING/CONFIRMED、handler が GENERATED/FAILED を更新**）、`owner`（field-level authorization で再割当禁止）。冪等制御・quota は工程2の専用 DynamoDB テーブル（`Report` には持たない）。現場（Site）はリレーション `Report.siteId` ＋ `site: belongsTo("Site")` で保持し、一覧・PDF は `report.site?.name` で表示する。
- **工程2（確定済み・一致済み）**: `generateReport` は **identityPool（IAM）認可**（UI は `authMode: 'identityPool'`）、引数 `{ reportId, photoKeys }`、戻り値 `ReportDraft { work, progress, safety:{confirmed,unconfirmed}, tomorrow, status, idempotent }`。冪等キーは `inputHash` 込み（テキスト変更で新規生成）。**再生成上限はサーバー側 quota が正本**（UI 表示は補助）。**成功/失敗時は handler が Report へ draft*＋genStatus を永続化**し、UI は編集画面の `restore` で状態復元する。非同期採用時は `Report.genStatus` ポーリングへ（§2-4 注記・`03b_step2_async.md` ステップ6）。
- **工程4（品質評価）へ**: 本 UI の「確認・微修正」画面（AI 生成の `ReportDraft` と確定後 `draft*` フィールドの差分）が修正文字率の測定点。安全は `safety.confirmed`/`safety.unconfirmed` の2軸で評価可能。必要なら AI 生成原文（微修正前）を別フィールドで保持することを工程1と調整。
- **工程5（異常系）へ**: TC-6 は「生成要求送信前／生成実行中／生成完了直後／確定前」の4時点で**アプリ完全終了→再起動**して復元を検証する（§2-3 `restore` が対象）。TC-8（入力変更→新規生成）は §2-4 の冪等キー挙動が対象。
