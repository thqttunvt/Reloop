import { ApplyGuardrailCommand, BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { DetectTextCommand, RekognitionClient } from '@aws-sdk/client-rekognition';
import type { GuardrailRef } from '../ai/analyzer';

export interface TextScreenResult {
  /** true = chữ trong ảnh giống câu lệnh tấn công / nội dung không phù hợp → tin cần Admin duyệt */
  flagged: boolean;
  /** Chữ đọc được (để Admin xem khi duyệt) */
  text: string;
}

/**
 * Kiểm tra CHỮ nằm trong ảnh (QĐ-36) — chống prompt injection qua hình ảnh:
 * Rekognition chỉ lọc hình nhạy cảm, Guardrail PROMPT_ATTACK chỉ xét chữ → đọc chữ ra trước (OCR) rồi mới đưa qua Guardrail.
 * Kết quả chỉ để GẮN CỜ (tin chờ Admin duyệt), không chặn upload.
 */
export interface TextScreener {
  readonly enabled: boolean;
  check(key: string): Promise<TextScreenResult>;
}

/** Ít chữ hơn ngưỡng này (vd "DELL", "220V") thì không đủ để là câu lệnh — bỏ qua, đỡ gọi Guardrail. */
const MIN_TEXT_LENGTH = 12;
const MIN_CONFIDENCE = 80;

export class RekognitionGuardrailScreener implements TextScreener {
  readonly enabled = true;
  private readonly rekognition = new RekognitionClient({});
  private readonly bedrock: BedrockRuntimeClient;

  constructor(
    private readonly bucket: string,
    private readonly guardrail: GuardrailRef,
    awsRegion: string,
  ) {
    this.bedrock = new BedrockRuntimeClient({ region: awsRegion, maxAttempts: 2 });
  }

  async check(key: string): Promise<TextScreenResult> {
    const ocr = await this.rekognition.send(new DetectTextCommand({ Image: { S3Object: { Bucket: this.bucket, Name: key } } }));
    const text = (ocr.TextDetections ?? [])
      .filter((d) => d.Type === 'LINE' && (d.Confidence ?? 0) >= MIN_CONFIDENCE)
      .map((d) => d.DetectedText ?? '')
      .join('\n')
      .slice(0, 2000);
    if (text.replace(/\s+/g, '').length < MIN_TEXT_LENGTH) return { flagged: false, text };
    const verdict = await this.bedrock.send(
      new ApplyGuardrailCommand({
        guardrailIdentifier: this.guardrail.id,
        guardrailVersion: this.guardrail.version,
        source: 'INPUT',
        content: [{ text: { text } }],
      }),
    );
    return { flagged: verdict.action === 'GUARDRAIL_INTERVENED', text };
  }
}

/** Không có S3 / Guardrail (dev local) → không kiểm tra, không gắn cờ. */
export class DisabledTextScreener implements TextScreener {
  readonly enabled = false;
  async check(): Promise<TextScreenResult> {
    return { flagged: false, text: '' };
  }
}
