export interface Schedule {
  id: string;
  teacherName: string;
  courseName: string;
  classId: string;
  teacherId?: string;  // 講師ID（重複チェック用）
  date: string;       // yyyy-MM-dd
  time: string;        // HH:mm~HH:mm
  capacity: number;
  price: number;
  deadline: string;    // "1日前", "12時間前", "30分前"
  emergencyContact: string;
}

export interface ClientPayload {
  schedules: Schedule[];
  webhook_url: string;
}

export interface Config {
  payload: ClientPayload;
  headless: boolean;
}

export function loadConfig(): Config {
  const payloadStr = process.env.PAYLOAD;

  if (!payloadStr) {
    throw new Error("PAYLOAD 環境変数が設定されていません");
  }

  let payload: ClientPayload;
  try {
    payload = JSON.parse(payloadStr);
  } catch {
    throw new Error("PAYLOAD のJSON解析に失敗しました");
  }

  if (!payload.schedules || !Array.isArray(payload.schedules)) {
    throw new Error("payload.schedules が配列ではありません");
  }

  return {
    payload,
    headless: process.env.HEADLESS !== "false",
  };
}
