import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import type Anthropic from '@anthropic-ai/sdk';
import { CATEGORIES, CONDITIONS, type Category, type Condition } from '../domain/catalog';

export interface ImageInput {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  /** base64, không xuống dòng */
  data: string;
}

/** Kết quả AI (T5.2): chỉ những gì thấy được trên ảnh; không chắc → UNKNOWN / null. */
export interface AiResult {
  isElectronicDevice: boolean;
  isInappropriate: boolean;
  category: Category;
  brand: string | null;
  model: string | null;
  condition: Condition;
  visibleDamage: string[];
  suggestedTitle: string;
  suggestedDescription: string;
  confidence: 'low' | 'medium' | 'high';
}

export interface Analyzer {
  readonly enabled: boolean;
  analyze(images: ImageInput[]): Promise<AiResult>;
}

const TOOL_NAME = 'record_device_analysis';

const SYSTEM = `Bạn hỗ trợ người dùng ReLoop đăng bán thiết bị điện tử cũ, hỏng cho đơn vị thu mua / tái chế.
Nhiệm vụ: nhìn ảnh và ghi lại nhận xét bằng công cụ ${TOOL_NAME}. Quy tắc:
- Chỉ mô tả điều THẤY ĐƯỢC trên ảnh. Không bao giờ khẳng định máy còn chạy, bo mạch tốt hay pin còn dùng được.
- Không chắc thì để condition = "UNKNOWN", brand/model = null, confidence = "low".
- condition: WORKING chỉ khi ảnh cho thấy rõ thiết bị đang bật và hiển thị bình thường; PARTIALLY_WORKING khi đang bật nhưng có lỗi thấy được; NOT_WORKING khi hư hỏng nặng rõ ràng (vỡ nát, cháy, mất linh kiện chính); còn lại UNKNOWN.
- Ảnh không phải thiết bị điện tử → isElectronicDevice = false. Ảnh có nội dung nhạy cảm / không phù hợp → isInappropriate = true.
- suggestedTitle và suggestedDescription viết tiếng Việt, ngắn gọn, trung thực; visibleDamage là danh sách hư hỏng thấy được (tiếng Việt).`;

const TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description: 'Ghi lại kết quả phân tích ảnh thiết bị điện tử.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'isElectronicDevice',
      'isInappropriate',
      'category',
      'brand',
      'model',
      'condition',
      'visibleDamage',
      'suggestedTitle',
      'suggestedDescription',
      'confidence',
    ],
    properties: {
      isElectronicDevice: { type: 'boolean' },
      isInappropriate: { type: 'boolean' },
      category: { type: 'string', enum: [...CATEGORIES] },
      brand: { type: ['string', 'null'] },
      model: { type: ['string', 'null'] },
      condition: { type: 'string', enum: [...CONDITIONS] },
      visibleDamage: { type: 'array', items: { type: 'string' } },
      suggestedTitle: { type: 'string' },
      suggestedDescription: { type: 'string' },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    },
  },
};

/** Kiểm tra lại đầu ra ở backend (T5.2) — không tin tuyệt đối vào schema của model. */
export function validateResult(input: unknown): AiResult {
  const v = (input ?? {}) as Record<string, unknown>;
  const s = (x: unknown, max = 200) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : null);
  return {
    isElectronicDevice: v.isElectronicDevice !== false,
    isInappropriate: v.isInappropriate === true,
    category: CATEGORIES.includes(v.category as Category) ? (v.category as Category) : 'OTHER',
    brand: s(v.brand, 60),
    model: s(v.model, 80),
    condition: CONDITIONS.includes(v.condition as Condition) ? (v.condition as Condition) : 'UNKNOWN',
    visibleDamage: Array.isArray(v.visibleDamage) ? v.visibleDamage.map((d) => s(d)).filter((d): d is string => !!d).slice(0, 10) : [],
    suggestedTitle: s(v.suggestedTitle, 120) ?? '',
    suggestedDescription: s(v.suggestedDescription, 2000) ?? '',
    confidence: ['low', 'medium', 'high'].includes(v.confidence as string) ? (v.confidence as AiResult['confidence']) : 'low',
  };
}

/** Claude Haiku trên Amazon Bedrock (giaiphap E7). Credentials lấy từ IAM role của Lambda. */
export class BedrockAnalyzer implements Analyzer {
  readonly enabled = true;
  private readonly client: AnthropicBedrock;

  constructor(
    private readonly modelId: string,
    awsRegion: string,
  ) {
    this.client = new AnthropicBedrock({ awsRegion, timeout: 60_000, maxRetries: 1 });
  }

  async analyze(images: ImageInput[]): Promise<AiResult> {
    const response = await this.client.messages.create({
      model: this.modelId,
      max_tokens: 2048,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [
        {
          role: 'user',
          content: [
            ...images.map((img) => ({
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
            })),
            { type: 'text', text: 'Phân tích thiết bị trong các ảnh trên.' },
          ],
        },
      ],
    });
    if (response.stop_reason === 'refusal') throw new Error('AI từ chối phân tích ảnh');
    const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === TOOL_NAME);
    if (!toolUse) throw new Error(`AI không trả kết quả (stop_reason=${response.stop_reason})`);
    return validateResult(toolUse.input);
  }
}

/** Không cấu hình AI_MODEL_ID (dev local) → AI tắt, người dùng nhập tay (§23.1). */
export class DisabledAnalyzer implements Analyzer {
  readonly enabled = false;
  async analyze(): Promise<AiResult> {
    throw new Error('AI chưa được cấu hình');
  }
}
