import { DetectModerationLabelsCommand, RekognitionClient } from '@aws-sdk/client-rekognition';

export interface ModerationResult {
  allowed: boolean;
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

/** Ngưỡng tin cậy để chặn. Thấp hơn → bắt nhầm nhiều; cao hơn → lọt nhiều. */
const MIN_CONFIDENCE = 70;

export class RekognitionModerator implements ImageModerator {
  readonly enabled = true;
  private readonly client = new RekognitionClient({});

  constructor(private readonly bucket: string) {}

  async check(key: string): Promise<ModerationResult> {
    const res = await this.client.send(
      new DetectModerationLabelsCommand({ Image: { S3Object: { Bucket: this.bucket, Name: key } }, MinConfidence: MIN_CONFIDENCE }),
    );
    const labels = (res.ModerationLabels ?? [])
      .filter((l) => BLOCKED.has(l.Name ?? '') || BLOCKED.has(l.ParentName ?? ''))
      .map((l) => ({ name: l.Name ?? '', confidence: Math.round(l.Confidence ?? 0) }));
    return { allowed: labels.length === 0, labels };
  }
}

/** Không có S3 (dev local) → không kiểm duyệt được, cho qua. */
export class DisabledModerator implements ImageModerator {
  readonly enabled = false;
  async check(): Promise<ModerationResult> {
    return { allowed: true, labels: [] };
  }
}
