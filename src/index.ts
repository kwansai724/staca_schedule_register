import { loadConfig } from "./config.js";
import { login } from "./auth.js";
import { registerSchedules } from "./register.js";
import { notifyResults } from "./notify.js";
import { filterDuplicates } from "./dedup.js";
import { log, safeScreenshot } from "./utils.js";

async function main(): Promise<void> {
  log("ストアカ日程登録を開始します");

  // 1. 設定読み込み
  const config = loadConfig();
  const { schedules, webhook_url } = config.payload;

  if (schedules.length === 0) {
    log("登録対象のスケジュールがありません。終了します。");
    return;
  }

  log(`登録対象: ${schedules.length}件`);

  // 2. 重複チェック（ストアカAPI）
  const { filtered, skippedResults } = await filterDuplicates(schedules);

  if (filtered.length === 0) {
    log("すべて重複のため登録対象がありません");
    await notifyResults(webhook_url, skippedResults);
    return;
  }

  // 3. ブラウザ起動・セッション検証
  const { browser, page } = await login(config.headless);

  try {
    // 4. 日程登録実行
    const results = await registerSchedules(page, filtered);

    // 5. GAS webhookに結果送信（重複スキップ分も含める）
    await notifyResults(webhook_url, [...skippedResults, ...results]);

    log("すべての処理が完了しました");
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log(`致命的エラー: ${errMsg}`);
    await safeScreenshot(page, "fatal-error");

    // エラー時も結果を通知（重複スキップ分 + 残りは全件エラー）
    const errorResults = filtered.map((s) => ({
      id: s.id,
      status: "error" as const,
      error: errMsg,
    }));
    await notifyResults(webhook_url, [...skippedResults, ...errorResults]);

    throw error;
  } finally {
    await browser.close();
    log("ブラウザを閉じました");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
