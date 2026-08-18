// 定常レイテンシ計測: spike-lib.ts の generateReport を N 回反復し P50/P95/Max を出す。
// 工程0 ステップ5（01_step0_spike.md）の「定常 P95 計測」用。
//
// 実行: AWS_PROFILE=rag-app-admin npx tsx measure.ts [N] [maxImages]
//   npx tsx measure.ts 20      … 5枚(既定)で20回 = 定常 P95 計測
//   npx tsx measure.ts 3 1     … 1枚で3回 = 画像枚数別トークンの記録用
//   SLEEP_MS=3000 npx tsx measure.ts 20  … throttle を踏む場合は間隔を広げる
//
// 注: プロンプト・スキーマ・temperature は spike-lib.ts 側で固定されている。
//     「同一条件で回す」のが計測の前提なので、計測中はあちらを変更しないこと。
import { generateReport } from "./spike-lib";

// AppSync の実行上限は30秒（変更不可）。Lambda コールドスタート・複数画像取得・弱回線の
// ばらつきを吸収する安全マージンとして 5秒みた 25秒を同期継続の目安にする（proposal §9）。
const SYNC_BUDGET_MS = 25_000;

// 連続実行で ThrottlingException を踏むと計測が途切れるため、既定で間隔を空ける。
const SLEEP_MS = Number(process.env.SLEEP_MS ?? 1000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// nearest-rank 法（手順書 L361 と同じ式）。
// 注: N が小さいと p95 は max と一致する（N=20 なら昇順19番目）。少標本での過信を避けること。
function percentile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
  };
}

const avg = (values: number[]) =>
  Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);

// 取得できなかった値は 0 で埋めずに「データなし」と出す（欠測を平均に混ぜて数字を作らない）。
const tokenLine = (label: string, values: number[]) =>
  values.length > 0
    ? `${label} avg=${avg(values)} max=${Math.max(...values)} (n=${values.length})`
    : `${label} データなし`;

async function main() {
  const n = Number(process.argv[2] ?? 20);
  // 省略時は spike-lib.ts の既定（5枚）に任せるため undefined のまま渡さない。
  const maxImages = process.argv[3] === undefined ? undefined : Number(process.argv[3]);

  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`N は1以上の整数で指定してください（受け取った値: ${process.argv[2]}）`);
  }
  if (maxImages !== undefined && (!Number.isInteger(maxImages) || maxImages < 1)) {
    throw new Error(`maxImages は1以上の整数で指定してください（受け取った値: ${process.argv[3]}）`);
  }

  const elapsedMsList: number[] = [];
  const apiMsList: number[] = [];
  const inputTokensList: number[] = [];
  const outputTokensList: number[] = [];
  const failures: string[] = [];
  // 実際に送った枚数。maxImages は上限指定にすぎないので、記録にはこちらを使う。
  let imageCount: number | undefined;

  console.log(
    `計測開始: N=${n} maxImages=${maxImages ?? "既定(5)"} 間隔=${SLEEP_MS}ms`,
  );

  for (let i = 0; i < n; i++) {
    if (i > 0) await sleep(SLEEP_MS);
    try {
      const r = await generateReport(maxImages === undefined ? {} : { maxImages });
      elapsedMsList.push(r.elapsedMs);
      if (r.latencyMsFromApi !== undefined) apiMsList.push(r.latencyMsFromApi);
      if (r.usage?.inputTokens !== undefined) inputTokensList.push(r.usage.inputTokens);
      if (r.usage?.outputTokens !== undefined) outputTokensList.push(r.usage.outputTokens);
      imageCount = r.imageCount;
      console.log(
        `#${i + 1} elapsed=${r.elapsedMs}ms api=${r.latencyMsFromApi ?? "-"}ms ` +
          `in=${r.usage?.inputTokens ?? "-"} out=${r.usage?.outputTokens ?? "-"} ` +
          `images=${r.imageCount} stop=${r.stopReason}`,
      );
    } catch (e) {
      // 1回の失敗で計測全体を落とさない。ただし失敗は隠さず件数・内容を最後に必ず出す。
      const err = e as Error;
      const line = `#${i + 1} ${err.name}: ${err.message}`;
      failures.push(line);
      console.error(`FAILED ${line}`);
    }
  }

  console.log(
    `\n=== レイテンシ (N=${n}, images=${imageCount ?? "-"}, ` +
      `成功${elapsedMsList.length} / 失敗${failures.length}) ===`,
  );

  if (elapsedMsList.length === 0) {
    // 全滅時に分位点を出すと「測れた」と誤読されるため、明示的に失敗で終わる。
    throw new Error("全ての試行が失敗しました。分位点は算出できません。");
  }

  const elapsed = stats(elapsedMsList);
  console.log(
    `elapsedMs(往復) p50=${elapsed.p50} p95=${elapsed.p95} max=${elapsed.max}`,
  );
  if (apiMsList.length > 0) {
    const api = stats(apiMsList);
    console.log(`apiMs(参考)     p50=${api.p50} p95=${api.p95} max=${api.max}`);
  }
  console.log(tokenLine("inputTokens ", inputTokensList));
  console.log(tokenLine("outputTokens", outputTokensList));
  console.log(
    `※ p95 は nearest-rank（昇順 ${Math.ceil(0.95 * elapsedMsList.length)} 番目 / ${elapsedMsList.length} 件）。` +
      `標本が少ないと max と一致する`,
  );

  if (failures.length > 0) {
    console.log(`--- 失敗した回（${failures.length}件） ---`);
    failures.forEach((f) => console.log(f));
  }

  // 判定そのものは RESULTS.md に人が記録する（01_step0_spike.md ステップ7）。ここは材料の提示のみ。
  console.log(`--- 参考: 同期継続の目安 ${SYNC_BUDGET_MS}ms（AppSync 30秒 − マージン5秒） ---`);
  console.log(
    `elapsedMs p95 = ${elapsed.p95}ms / 目安との差 = ${SYNC_BUDGET_MS - elapsed.p95}ms`,
  );
}

main().catch((e) => {
  console.error("=== 計測失敗 ===");
  console.error(e?.name, e?.message);
  process.exit(1);
});
