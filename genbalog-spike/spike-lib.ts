import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REGION = "ap-northeast-1";
// 東京 In-Region の推論プロファイル。prefix 無しの素の modelId は
// 「on-demand throughput isn't supported」で弾かれるため必須。
const MODEL_ID = "jp.anthropic.claude-haiku-4-5-20251001-v1:0";

// 既定は ./images（配筋写真）。回帰テストで無関係写真セットに切り替えるため環境変数で上書き可能。
//   例: IMAGE_DIR=./images_irrelevant AWS_PROFILE=... npx tsx spike.ts
// 呼び出し側（measure.ts など）から引数で上書きする場合はそちらが優先。
const DEFAULT_IMAGE_DIR = process.env.IMAGE_DIR ?? "./images";
const DEFAULT_MAX_IMAGES = 5;
// 日報を返させるツール名。toolSpec と toolChoice で同じ値を使う必要がある。
const TOOL_NAME = "genba_daily_report";

const client = new BedrockRuntimeClient({ region: REGION });

// 日報4項目の JSON Schema。`要確認` を許容する設計（事実性はスキーマでは保証されない＝プロンプトで担保）。
// 注: JSON Schema Draft 2020-12 の「サブセット」のみ対応。
//     minLength/maxLength・数値制約・recursive は使用不可（差異注記2参照）。
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
  // （存在しないディレクトリは readdirSync が ENOENT で落ちるため、ここは「あるが空」を守る）
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
export type GenerateOptions = {
  imageDir?: string;
  maxImages?: number;
};

// 引数なしでも呼べる（既定値＝従来の定数）。spike.ts は無変更で動く。
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
    // 出力上限。ツール引数の JSON も出力トークンを消費するため 500 では不足する。
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

  const parsed = toolUse.input;
  return {
    elapsedMs,
    latencyMsFromApi: res.metrics?.latencyMs, // API 実測レイテンシ
    usage: res.usage, // { inputTokens, outputTokens, totalTokens }
    stopReason: res.stopReason,
    report: parsed,
    // imageCount は実測枚数。maxImages は上限指定にすぎず、実在枚数が少なければ黙って減る。
    // 記録・集計に使うのは必ず imageCount のほう。
    imageCount,
    imageDir,
    maxImages,
  };
}