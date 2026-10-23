import { DetectModerationLabelsCommand, RekognitionClient } from '@aws-sdk/client-rekognition';

export interface ModerationResult {
  allowed: boolean;
  /** Nghi ngờ (nhãn nặng 50–70%) → cho dùng ảnh nhưng tin phải chờ Admin duyệt tay (QĐ-43). */
  review?: boolean;
  /** Nhãn vi phạm Rekognition tìm thấy (để log / báo lỗi) */
  labels: { name: string; confidence: number }[];
}

/** Kiểm duyệt ảnh nhạy cảm (giaiphap E5, mục mở rộng M6). */
export interface ImageModerator {
  readonly enabled: boolean;
  check(key: string): Promise<ModerationResult>;
}

/**
 * Nhóm nhãn bị chặn — gồm tên ở cả bộ nhãn cũ và mới của Rekognition.
 * Không chặn "Swimwear or Underwear" / "Alcohol" / "Gambling": không liên quan tới ảnh thiết bị
 * và dễ bắt nhầm (vd thùng máy có hình quảng cáo).
 */
const BLOCKED = new Set([
  'Explicit',
  'Explicit Nudity',
  'Non-Explicit Nudity of Intimate parts and Kissing',
  'Suggestive',
  'Violence',
  'Graphic Violence',
  'Graphic Violence Or Gore',
  'Visually Disturbing',
  'Hate Symbols',
  'Rude Gestures',
  'Drugs & Tobacco',
  'Drugs',
]);

/** Nhãn nặng: dưới ngưỡng chặn nhưng ≥ REVIEW_CONFIDENCE thì đưa Admin duyệt tay (QĐ-43). */
const HEAVY = new Set([
  'Explicit',
  'Explicit Nudity',
  'Violence',
  'Graphic Violence',
  'Graphic Violence Or Gore',
  'Hate Symbols',
  'Drugs & Tobacco',
  'Drugs',
]);

/** Ngưỡng tin cậy để chặn. Thấp hơn → bắt nhầm nhiều; cao hơn → lọt nhiều. */
export const REJECT_CONFIDENCE = 70;
/** Vùng nghi ngờ [REVIEW_CONFIDENCE, REJECT_CONFIDENCE) cho nhãn nặng → chờ Admin duyệt. Chỉnh theo metric ImagesSensitiveSuspected. */
export const REVIEW_CONFIDENCE = 50;

/** Phân loại nhãn Rekognition: chặn / nghi ngờ chờ duyệt / cho qua. */
export function classifyModeration(raw: { name: string; parent?: string; confidence: number }[]): ModerationResult {
  const hits = raw.filter((l) => BLOCKED.has(l.name) || BLOCKED.has(l.parent ?? ''));
  const label = (l: { name: string; confidence: number }) => ({ name: l.name, confidence: Math.round(l.confidence) });
  const rejected = hits.filter((l) => l.confidence >= REJECT_CONFIDENCE);
  if (rejected.length) return { allowed: false, labels: rejected.map(label) };
  const suspected = hits.filter((l) => (HEAVY.has(l.name) || HEAVY.has(l.parent ?? '')) && l.confidence >= REVIEW_CONFIDENCE);
  return { allowed: true, review: suspected.length > 0, labels: suspected.map(label) };
}

export class RekognitionModerator implements ImageModerator {
  readonly enabled = true;
  private readonly client = new RekognitionClient({});

  constructor(private readonly bucket: string) {}

  async check(key: string): Promise<ModerationResult> {
    const res = await this.client.send(
      new DetectModerationLabelsCommand({ Image: { S3Object: { Bucket: this.bucket, Name: key } }, MinConfidence: REVIEW_CONFIDENCE }),
    );
    return classifyModeration((res.ModerationLabels ?? []).map((l) => ({ name: l.Name ?? '', parent: l.ParentName, confidence: l.Confidence ?? 0 })));
  }
}

/** Không có S3 (dev local) → không kiểm duyệt được, cho qua. */
export class DisabledModerator implements ImageModerator {
  readonly enabled = false;
  async check(): Promise<ModerationResult> {
    return { allowed: true, labels: [] };
  }
}
