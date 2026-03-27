import { Schedule } from "./config.js";
import { log } from "./utils.js";
import { ScheduleResult } from "./notify.js";

const API_BASE = "https://www.street-academy.com/api/v1";
const PER_PAGE = 500;

interface StoacaEvent {
  class_id: number;
  start_at: string; // ISO8601: "2026-04-01T10:00:00+09:00"
}

/**
 * 指定講師の全イベントをストアカAPIから取得する
 */
async function fetchTeacherEvents(teacherId: string): Promise<StoacaEvent[]> {
  const allEvents: StoacaEvent[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const url = `${API_BASE}/events?page=${page}&per=${PER_PAGE}&teacher=${teacherId}`;
    const response = await fetch(url);

    if (!response.ok) {
      log(`講師ID ${teacherId} のイベント取得失敗: ${response.status}`);
      break;
    }

    const json = await response.json();
    const events: StoacaEvent[] = json.events || [];
    allEvents.push(...events);
    hasMore = events.length === PER_PAGE;
    page++;
  }

  return allEvents;
}

/**
 * スケジュールからISO8601のstart_atを生成する
 */
function toStartAt(schedule: Schedule): string {
  const startTime = schedule.time.split("~")[0]; // HH:mm
  return `${schedule.date}T${startTime}:00+09:00`;
}

/**
 * 重複チェック: 既存日程と一致するスケジュールを除外する
 * @returns 重複除外後のスケジュールと、スキップ分のresults
 */
export async function filterDuplicates(
  schedules: Schedule[],
): Promise<{ filtered: Schedule[]; skippedResults: ScheduleResult[] }> {
  // teacherIdごとにスケジュールをグループ化
  const byTeacher = new Map<string, Schedule[]>();
  const noTeacherId: Schedule[] = [];

  for (const s of schedules) {
    if (s.teacherId) {
      const list = byTeacher.get(s.teacherId) || [];
      list.push(s);
      byTeacher.set(s.teacherId, list);
    } else {
      noTeacherId.push(s);
    }
  }

  const filtered: Schedule[] = [...noTeacherId];
  const skippedResults: ScheduleResult[] = [];

  if (noTeacherId.length > 0) {
    log(`teacherIdなし: ${noTeacherId.length}件 → 重複チェックをスキップ`);
  }

  for (const [teacherId, teacherSchedules] of byTeacher) {
    log(`講師ID ${teacherId} の既存日程を取得中...`);
    const existingEvents = await fetchTeacherEvents(teacherId);

    // classIdとstart_atの組み合わせでSetを作成
    const existingKeys = new Set(
      existingEvents.map((ev) => `${ev.class_id}|${ev.start_at}`),
    );
    log(`  既存日程: ${existingEvents.length}件`);

    for (const s of teacherSchedules) {
      const key = `${s.classId}|${toStartAt(s)}`;
      if (existingKeys.has(key)) {
        log(`  重複スキップ: ${s.courseName} ${s.date} ${s.time}`);
        skippedResults.push({
          id: s.id,
          status: "done",
          error: "重複のためスキップ",
        });
      } else {
        filtered.push(s);
        // 今回の申請内での重複も防ぐ
        existingKeys.add(key);
      }
    }
  }

  log(`重複チェック結果: ${schedules.length}件中 ${skippedResults.length}件スキップ → ${filtered.length}件登録対象`);

  return { filtered, skippedResults };
}
