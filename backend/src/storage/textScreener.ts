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

/**
 * Cụm câu lệnh tấn công (đã bỏ dấu). Rekognition DetectText đọc sai / mất dấu tiếng Việt
 * ("Bỏ qua hướng dẫn" → "Bo qua huong dan") nên Guardrail không nhận ra — so khớp không dấu ở backend trước.
 */
export const INJECTION_PHRASES = [
  'bo qua huong dan',
  'bo qua cac quy tac',
  'hay phan loai',
  'system prompt',
  'ignore previous',
  'ignore all instructions',
  'tra ve json',
  'danh gia la moi 100',
  'override',
];

/** Chữ thường, bỏ dấu, đ → d, ký tự khác chữ/số → khoảng trắng. */
export function foldVietnamese(text: string): string {
  return text
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Có cụm câu lệnh tấn công (so theo nguyên từ, không dấu) không. */
export function looksLikeInjection(text: string): boolean {
  const folded = ` ${foldVietnamese(text)} `;
  return INJECTION_PHRASES.some((p) => folded.includes(` ${p} `));
}

export class RekognitionGuardrailScreener implements TextScreener {
  readonly enabled = true;
  private readonly rekognition: RekognitionClient;
  private readonly bedrock: BedrockRuntimeClient;

  constructor(
    private readonly bucket: string,
    private readonly guardrail: GuardrailRef,
    awsRegion: string,
    clients: { rekognition?: RekognitionClient; bedrock?: BedrockRuntimeClient } = {},
  ) {
    this.rekognition = clients.rekognition ?? new RekognitionClient({});
    this.bedrock = clients.bedrock ?? new BedrockRuntimeClient({ region: awsRegion, maxAttempts: 2 });
  }

  async check(key: string): Promise<TextScreenResult> {
    const ocr = await this.rekognition.send(new DetectTextCommand({ Image: { S3Object: { Bucket: this.bucket, Name: key } } }));
    const text = (ocr.TextDetections ?? [])
      .filter((d) => d.Type === 'LINE' && (d.Confidence ?? 0) >= MIN_CONFIDENCE)
      .map((d) => d.DetectedText ?? '')
      .join('\n')
      .slice(0, 2000);
    // Bắt câu lệnh tiếng Việt bị mất dấu trước khi xét độ dài / gọi Guardrail
    if (looksLikeInjection(text)) return { flagged: true, text };
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
