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

const IMAGE_DIR = "./images";
const MAX_IMAGES = 5;
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
      description: "安全・懸念。確認できた事項と未確認事項を分離。『問題なし』は生成しない。",
      properties: {
        confirmed: {
          type: "string",
          description: "画像内で確認できた安全上の事項。無ければ『該当なし（確認範囲内）』。",
        },
        unconfirmed: {
          type: "string",
          description: "画角外・未確認のため要確認の事項（例：安全帯着用状況は写真外のため要確認）。",
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

function loadImages() {
  const files = readdirSync(IMAGE_DIR)
    .filter((f) => /\.(jpe?g)$/i.test(f))
    .sort()
    .slice(0, MAX_IMAGES);
  // Converse の画像ブロック: { image: { format, source: { bytes: Uint8Array } } }
  return files.map((f) => ({
    image: {
      format: "jpeg" as const,
      source: { bytes: new Uint8Array(readFileSync(join(IMAGE_DIR, f))) },
    },
  }));
}

async function generateReport() {
  const imageBlocks = loadImages();

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
              "安全項目は『画像内で確認できた事項』と『画角外・未確認』を必ず分離し、『問題なし』とは書かないでください。\n" +
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
    imageCount: imageBlocks.length,
  };
}

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