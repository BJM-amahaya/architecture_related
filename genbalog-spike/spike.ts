import { generateReport } from'./spike-lib';

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