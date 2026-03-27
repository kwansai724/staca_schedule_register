import { Page } from "playwright";
import { Schedule } from "./config.js";
import { log, humanDelay, safeScreenshot } from "./utils.js";
import { ScheduleResult } from "./notify.js";

const BASE_URL = "https://www.street-academy.com";
const MAX_SCHEDULES_PER_BATCH = 30;
const MAX_403_RETRIES = 3;

/**
 * 日付文字列をパースする（ISO8601のUTCタイムゾーンずれに対応）
 * "2026-03-30" → そのまま / "2026-03-29T15:00:00.000Z" → JST変換で2026-03-30
 */
function parseDate(raw: string): { y: number; m: number; d: number } {
  const str = String(raw);
  if (str.includes("T")) {
    const dt = new Date(str);
    // JSTに変換
    const jst = new Date(dt.getTime() + 9 * 60 * 60 * 1000);
    return { y: jst.getUTCFullYear(), m: jst.getUTCMonth() + 1, d: jst.getUTCDate() };
  }
  const [y, m, d] = str.split("-").map(Number);
  return { y, m, d };
}

interface GroupKey {
  classId: string;
  capacity: number;
  price: number;
  deadline: string;
  emergencyContact: string;
}

interface ScheduleGroup {
  key: GroupKey;
  schedules: Schedule[];
}

/**
 * スケジュールをグループ化する（講座ID + 定員 + 受講料 + 締切 + 連絡先）
 */
export function groupSchedules(schedules: Schedule[]): ScheduleGroup[] {
  const groups = new Map<string, ScheduleGroup>();

  for (const s of schedules) {
    const keyStr = `${s.classId}|${s.capacity}|${s.price}|${s.deadline}|${s.emergencyContact}`;
    if (!groups.has(keyStr)) {
      groups.set(keyStr, {
        key: {
          classId: s.classId,
          capacity: s.capacity,
          price: s.price,
          deadline: s.deadline,
          emergencyContact: s.emergencyContact,
        },
        schedules: [],
      });
    }
    groups.get(keyStr)!.schedules.push(s);
  }

  return Array.from(groups.values());
}

/**
 * 403 Forbiddenの検知とリトライ
 */
async function handle403(page: Page): Promise<boolean> {
  for (let retry = 0; retry < MAX_403_RETRIES; retry++) {
    const content = await page.content();
    if (!content.includes("403 Forbidden")) {
      return true;
    }
    log(`403 Forbidden 検知。2分間待機してリトライします... (${retry + 1}/${MAX_403_RETRIES})`);
    await new Promise((resolve) => setTimeout(resolve, 120000));
    await page.reload();
  }
  log("403 Forbidden が解消しませんでした。");
  return false;
}

/**
 * 締め切り日時を設定する
 */
async function setDeadline(page: Page, deadline: string): Promise<void> {
  if (deadline.includes("日前")) {
    const value = deadline.replace("日前", "").trim();
    await page.locator("#session_detail_multi_form_select_deadline_type_0").check();
    await page.locator("#session_detail_multi_form_deadline_days_ago").fill(value);
    log(`締め切りを ${value} 日前に設定`);
  } else if (deadline.includes("時間前")) {
    const value = deadline.replace("時間前", "").trim();
    await page.locator("#session_detail_multi_form_select_deadline_type_1").check();
    await page.locator("#session_detail_multi_form_deadline_hours_ago").fill(value);
    log(`締め切りを ${value} 時間前に設定`);
  } else if (deadline.includes("分前")) {
    const value = deadline.replace("分前", "").trim();
    await page.locator("#session_detail_multi_form_select_deadline_type_2").check();
    await page.locator("#session_detail_multi_form_deadline_minutes_ago").fill(value);
    log(`締め切りを ${value} 分前に設定`);
  } else {
    log(`警告: 解析できない締め切りフォーマット: ${deadline}`);
  }
}

/**
 * 1グループ（同一講座ID・同一条件）の日程を登録する
 * 30件ごとにチャンク分割して処理
 */
async function registerGroup(
  page: Page,
  group: ScheduleGroup
): Promise<ScheduleResult[]> {
  const results: ScheduleResult[] = [];
  const { key, schedules } = group;

  // 30件ごとにチャンク分割
  const chunks: Schedule[][] = [];
  for (let i = 0; i < schedules.length; i += MAX_SCHEDULES_PER_BATCH) {
    chunks.push(schedules.slice(i, i + MAX_SCHEDULES_PER_BATCH));
  }

  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    const chunk = chunks[chunkIdx];
    log(`--- バッチ ${chunkIdx + 1}/${chunks.length}: ${chunk.length}件 ---`);

    try {
      const url = `${BASE_URL}/session_details/new_multi_session?classdetailid=${key.classId}`;
      await page.goto(url);
      await humanDelay(2000, 3000);

      // 403チェック
      if (!(await handle403(page))) {
        for (const s of chunk) {
          results.push({ id: s.id, status: "error", error: "403 Forbidden" });
        }
        continue;
      }

      // 「日程を複製する」ボタンが表示されるまで待機
      await page.getByRole("button", { name: "日程を複製する" }).waitFor({ timeout: 30000 });

      // 講座名チェック
      try {
        const titleEl = page.locator('p:has-text("『")');
        await titleEl.waitFor({ timeout: 10000 });
        const pageTitle = (await titleEl.innerText()).replace(/『|』/g, "").trim();
        const expectedName = chunk[0].courseName;

        if (expectedName !== pageTitle) {
          log(`[警告] 講座名不一致 - 入力: "${expectedName}" / ページ: "${pageTitle}" → スキップ`);
          for (const s of chunk) {
            results.push({ id: s.id, status: "error", error: `講座名不一致: ${pageTitle}` });
          }
          continue;
        }
        log("講座名の一致を確認");
      } catch {
        log("[警告] 講座名の確認に失敗 → スキップ");
        for (const s of chunk) {
          results.push({ id: s.id, status: "error", error: "講座名確認失敗" });
        }
        continue;
      }

      // オンライン選択
      const onlineRadio = page.locator("#session_detail_multi_form_is_online_true");
      if (await onlineRadio.isVisible()) {
        log("「オンライン」を選択");
        await onlineRadio.check();
      }

      // 定員・受講料・緊急連絡先
      await page.locator("#session_detail_multi_form_session_capacity").fill(String(key.capacity));
      await page.locator("#session_detail_multi_form_cost").fill(String(key.price));
      await page.locator("#session_detail_multi_form_emergency_contact").fill(key.emergencyContact);
      const ec = key.emergencyContact;
      const maskedContact = ec.slice(0, -4).replace(/\d/g, "*") + ec.slice(-4);
      log(`定員=${key.capacity}, 受講料=${key.price}円, 連絡先=${maskedContact}`);

      // 締め切り日時
      await setDeadline(page, key.deadline);

      // 各日程をフォームに入力
      for (let i = 0; i < chunk.length; i++) {
        const s = chunk[i];
        const [startTime, endTime] = s.time.split("~");
        const { y, m, d } = parseDate(s.date);
        const [startHour, startMin] = startTime.split(":").map(Number);
        const [endHour, endMin] = endTime.split(":").map(Number);

        let block;
        if (i === 0) {
          block = page.locator("div[data-repeater-item]").first();
        } else {
          await page.getByRole("button", { name: "日程を複製する" }).click();
          await humanDelay(500, 1000);
          block = page.locator("div[data-repeater-item]").last();
          await block.waitFor();
        }

        await block.locator('select[name*="[session_startdate_year]"]').selectOption(String(y));
        await humanDelay(500, 1000);
        await block.locator('select[name*="[session_startdate_month]"]').selectOption(String(m));
        // 月変更後、日の選択肢が動的に再生成されるのを待つ
        const daySelect = block.locator('select[name*="[session_startdate_day]"]');
        await daySelect.locator(`option[value="${d}"]`).waitFor({ timeout: 10000 });
        await daySelect.selectOption(String(d));
        await humanDelay(100, 300);
        await block.locator("select.js_start_time_hour").selectOption(String(startHour));
        await humanDelay(100, 300);
        await block.locator("select.js_start_time_minute").selectOption(String(startMin));
        await humanDelay(100, 300);
        await block.locator("select.js_end_time_hour").selectOption(String(endHour));
        await humanDelay(100, 300);
        await block.locator("select.js_end_time_minute").selectOption(String(endMin));

        log(`  日程 ${i + 1}: ${s.date} ${startTime}~${endTime}`);
      }

      // プレビュー → 確定
      await humanDelay(2000, 3000);
      await page.getByRole("button", { name: "プレビュー画面で確認" }).click();

      const confirmButton = page.getByRole("button", { name: "確定" });
      await confirmButton.waitFor({ timeout: 15000 });
      await humanDelay(2000, 3000);
      await confirmButton.click({ timeout: 60000 });

      // 完了ページ確認
      log("完了ページへの遷移を待機...");
      const successLink = page.getByRole("link", { name: "集客する" })
        .or(page.getByRole("link", { name: "日程追加" }));
      await successLink.first().waitFor({ timeout: 60000 });

      log(`バッチ ${chunkIdx + 1} 完了`);

      // 成功を記録
      for (const s of chunk) {
        results.push({ id: s.id, status: "done" });
      }

      await humanDelay(3000, 4000);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log(`バッチ ${chunkIdx + 1} エラー: ${errMsg}`);
      await safeScreenshot(page, `error-group-${key.classId}-batch-${chunkIdx}`);

      for (const s of chunk) {
        // 既にresultsに含まれている場合はスキップ
        if (!results.find((r) => r.id === s.id)) {
          results.push({ id: s.id, status: "error", error: errMsg });
        }
      }
    }
  }

  return results;
}

/**
 * 全スケジュールを登録する（メインエントリーポイント）
 */
export async function registerSchedules(
  page: Page,
  schedules: Schedule[]
): Promise<ScheduleResult[]> {
  const groups = groupSchedules(schedules);
  log(`処理対象: ${schedules.length}件（${groups.length}グループ）`);

  const allResults: ScheduleResult[] = [];

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    log(`\n=== グループ ${i + 1}/${groups.length}: 講座ID=${group.key.classId}, ${group.schedules.length}件 ===`);

    const results = await registerGroup(page, group);
    allResults.push(...results);
  }

  const doneCount = allResults.filter((r) => r.status === "done").length;
  const errorCount = allResults.filter((r) => r.status === "error").length;
  log(`\n全処理完了: ${doneCount}件成功 / ${errorCount}件エラー`);

  return allResults;
}
