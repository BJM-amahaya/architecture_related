# images/ 出典・ライセンス

工程0スパイク（`spike.ts`）の入力に使う**床スラブ配筋の実写真**です。

## なぜ実写真か

Step A の目的は「**AIが写真に写っていないものを書いていないか**」の検証です。
照合の基準になるのは「写真に実際に何が写っているか」という事実だけなので、
AI生成画像（鉄筋の本数・安全設備の配置が物理的にデタラメになる）は使えません。
生成画像を基準に「事実誤認なし」と判定すれば `.claude/CLAUDE.md` が禁じる
**「人工データで正常動作を偽装」**になるため、全て Wikimedia Commons の実写真を使用しています。

## 加工内容

全て共通で以下を適用（macOS 標準の `sips`）:

```
sips -Z 1568 -s format jpeg -s formatOptions <q> <入力> --out imgN.jpg
```

- 長辺 **1568px**（proposal の圧縮ルール）／アスペクト比保持
- **拡大はしていない**（元画像は全て長辺1568px以上。拡大は存在しない画質を作り出すため不可）
- ファイルサイズは proposal §5 の前提「約300KB／上振れ400KB」に収まるよう品質を調整

## 一覧

| ファイル | 写っているもの | 元ファイル | ライセンス | 作者 |
|---|---|---|---|---|
| `img1.jpg` | 床スラブの配筋メッシュ＋砕石。作業者4名。**ヘルメット未着用・サンダル履き・素手** | [Thai House Floor Slab Rebar Mesh.JPG](https://commons.wikimedia.org/wiki/File:Thai_House_Floor_Slab_Rebar_Mesh.JPG) | CC BY-SA 3.0 | Khaosaming |
| `img2.jpg` | 屋根スラブの配筋・型枠。作業員3名。**ヘルメット・高視認性ベスト・安全帯を着用** | [Installation of rebar for the roof slab of the Track A Approach Structure (27716208838).jpg](https://commons.wikimedia.org/wiki/File:Installation_of_rebar_for_the_roof_slab_of_the_Track_A_Approach_Structure._(CH061A,_4-14-2018)_(27716208838).jpg) | CC BY 2.0 | MTA Capital Construction Mega Projects |
| `img3.jpg` | エポキシ塗装（緑）鉄筋のスラブ配筋・型枠。**手すりあり**。作業員なし | [Rebar framework in preparation of pouring a concrete slab at the Metro North express level (48497323626).jpg](https://commons.wikimedia.org/wiki/File:Rebar_framework_in_preparation_of_pouring_a_concrete_slab_at_the_Metro_North_express_level._08-08-2019_(48497323626).jpg) | CC BY 2.0 | MTA Capital Construction Mega Projects |
| `img4.jpg` | 梁のあばら筋・型枠。作業員2名。**ヘルメット・高視認性ベスト着用** | [Rebar and formwork for concrete structural slabs and beams … LIRR Concourse (37101224161).jpg](https://commons.wikimedia.org/wiki/File:Rebar_and_formwork_for_concrete_structural_slabs_and_beams_at_the_planned_48th_Street_Entrance_to_the_future_LIRR_Concourse._(CM014B,_9-13-2017)_(37101224161).jpg) | CC BY 2.0 | MTA Capital Construction Mega Projects |
| `img5.jpg` | 防湿シート上の床スラブ配筋。スペーサー（コンクリート塊）あり。作業員なし | [Steel reinforcement J1b.JPG](https://commons.wikimedia.org/wiki/File:Steel_reinforcement_J1b.JPG) | CC BY-SA 3.0 | Jamain |

CC BY / CC BY-SA は**帰属表示が義務**です。このファイルを削除しないでください。
CC BY-SA 素材（img1 / img5）を改変して再配布する場合は同一ライセンスでの継承が必要です。

## この5枚が評価素材として優れている理由

安全状況が**意図せず対照的**になっており、`safety_concern.confirmed` の
ハルシネーション検出に使えます。

- `img1` … 安全対策が明確に**不十分**（ヘルメット無し・サンダル）
- `img2` `img4` … 安全対策が明確に**有り**（ヘルメット・ベスト・安全帯）
- `img3` … 手すりあり、作業員なし
- `img5` … 作業員なし

→ AI が「**全員がヘルメットを着用**」等と書けば `img1` と矛盾するため**明確な事実誤認**と判定できる。
→ 逆に「一部作業者のヘルメット未着用を確認」と書ければ、grounding が効いている証拠になる。

## 認識しておく限界

これらは**日本のマンション新築現場そのものではない**（米国の地下鉄構造物、タイの住宅など）。
一方 `spike.ts` のプロンプトは「〇〇マンション新築工事 / 2F床スラブ」と指定している。

- **工種（床スラブ配筋）は一致**しているので grounding 検証の目的は達成できる
- 建物種別の食い違いでモデルが `要確認` に倒す可能性があるが、
  それは**バグではなく望ましい挙動**。RESULTS.md に所見として記録すること

## 除外した候補

`土城中央路P01-22浮動式道床軌道鋼筋綁紮作業 2024-06-11.jpg`（Attribution / 作者不明）
… 鉄道軌道の道床配筋であり建築の床スラブと工種が異なる。
加えて画像に「2024年6月11日」のタイムスタンプが焼き込まれており、
プロンプトの日付（2026-07-06）と矛盾して検証を濁らせるため不採用。

## 旧画像

`images_irrelevant/` に退避済み（足場・基礎型枠・木造住宅内装）。
**工程4の「無関係写真」評価ケース素材**としてそのまま使えるので削除しないこと。
