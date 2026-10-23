import { describe, expect, it } from 'vitest';
import {
  BedrockAnalyzer,
  DisabledAnalyzer,
  FallbackAnalyzer,
  GeminiAnalyzer,
  sanitizeVietnamese,
  validateResult,
  type AiResult,
  type Analyzer,
} from '../src/ai/analyzer';
import { analyzerFor } from '../src/app';
import { TERMS_VERSION } from '../src/modules/users/userService';
import { keys } from '../src/store/keys';
import { listingBody } from './fixtures';
import { buildApp, loadConfig } from '../src/app';
import { ManualClock } from '../src/shared/clock';
import type { ImageStore } from '../src/storage/imageStore';
import { MemoryTable } from '../src/store/memoryTable';

const fakeImages: ImageStore = {
  enabled: true,
  createUpload: async () => ({ key: 'k', url: 'u', fields: {}, expiresInSeconds: 1 }),
  viewUrl: async (k) => `https://img/${k}`,
  markAttached: async () => undefined,
  markModerated: async () => undefined,
  assertModerated: async () => undefined,
  remove: async () => undefined,
  read: async () => ({ mediaType: 'image/jpeg', data: 'AAAA' }),
};

function setup(analyze: Analyzer['analyze']) {
  const calls: number[] = [];
  const analyzer: Analyzer = {
    enabled: true,
    modelId: 'apac.amazon.nova-pro-v1:0',
    analyze: async (imgs) => {
      calls.push(imgs.length);
      return analyze(imgs);
    },
  };
  const table = new MemoryTable();
  const clock = new ManualClock();
  const app = buildApp({ ...loadConfig({ STAGE: 'local' }), dataFile: undefined }, { table, clock, images: fakeImages, analyzer });
  const ai = app.services.ai;
  const pending: string[] = [];
  ai.dispatch = async (ref) => void pending.push(ref); // worker chạy khi test gọi flush()
  const flush = async () => {
    for (const ref of pending.splice(0)) await ai.run(ref);
  };
  return { app, table, ai, calls, flush, clock };
}

const KEYS = (u: string, n = 1) => Array.from({ length: n }, (_, i) => `listings/${u}/img${i}.jpg`);

describe('AI phân tích ảnh chạy nền (Epic 5)', () => {
  it('tạo job PENDING → worker → COMPLETED; tối đa 3 ảnh / lần', async () => {
    const { ai, calls, flush } = setup(async () =>
      validateResult({ category: 'LAPTOP', brand: 'Dell', model: null, condition: 'NOT_WORKING', visibleDamage: ['Vỡ màn hình'], suggestedTitle: 'Laptop Dell vỡ màn hình', suggestedDescription: '…', confidence: 'medium', isElectronicDevice: true, isInappropriate: false }),
    );
    const job = await ai.create('u1', KEYS('u1', 5));
    expect(job.status).toBe('PENDING');
    await flush();
    const done = await ai.get('u1', job.analysisId);
    expect(done.status).toBe('COMPLETED');
    expect(done.result).toMatchObject({ category: 'LAPTOP', brand: 'Dell', condition: 'NOT_WORKING' });
    expect(calls).toEqual([3]);
    await ai.run(`u1/${job.analysisId}`); // chạy trùng không gọi AI lần 2
    expect(calls).toEqual([3]);
  });

  it('AI lỗi → FAILED, người dùng nhập tay (§23.1)', async () => {
    const { ai, flush } = setup(async () => {
      throw new Error('throttled');
    });
    const job = await ai.create('u1', KEYS('u1'));
    await flush();
    expect((await ai.get('u1', job.analysisId)).status).toBe('FAILED');
  });

  it('không dùng ảnh của người khác; giới hạn 20 lượt / ngày', async () => {
    const { ai } = setup(async () => validateResult({}));
    await expect(ai.create('u1', KEYS('u2'))).rejects.toMatchObject({ code: 'INVALID_IMAGE_KEYS' });
    for (let i = 0; i < 20; i++) await ai.create('u1', KEYS('u1'));
    await expect(ai.create('u1', KEYS('u1'))).rejects.toMatchObject({ code: 'AI_DAILY_LIMIT' });
  });

  it('lượt AI reset lúc 0h giờ Việt Nam, không phải 7h sáng (mục 12 danhgia)', async () => {
    const { ai, clock } = setup(async () => validateResult({}));
    for (let i = 0; i < 20; i++) await ai.create('u1', KEYS('u1')); // 07:00 giờ VN ngày 01/01
    clock.advance(16 * 3_600_000 + 59 * 60_000); // 23:59 giờ VN cùng ngày → vẫn hết lượt
    await expect(ai.create('u1', KEYS('u1'))).rejects.toMatchObject({ code: 'AI_DAILY_LIMIT' });
    clock.advance(2 * 60_000); // 00:01 giờ VN ngày 02/01 (vẫn là 01/01 theo UTC) → có lượt mới
    await expect(ai.create('u1', KEYS('u1'))).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('validateResult: giá trị lạ → UNKNOWN / OTHER, không tin tuyệt đối đầu ra của model (T5.2)', () => {
    expect(validateResult({ category: 'SPACESHIP', condition: 'GREAT', brand: '  ', confidence: 'sure' })).toMatchObject({
      category: 'OTHER',
      condition: 'UNKNOWN',
      brand: null,
      confidence: 'low',
      isElectronicDevice: true,
    });
  });
});

describe('Amazon Nova Pro qua Bedrock Converse', () => {
  const img = { mediaType: 'image/png' as const, data: Buffer.from('png-bytes').toString('base64') };

  it('ép trả JSON bằng toolChoice, chỉ gửi ảnh + chỉ dẫn cố định; Guardrail khi có cấu hình', async () => {
    const plain = new BedrockAnalyzer('apac.amazon.nova-pro-v1:0', 'ap-southeast-1').buildRequest([img]);
    expect(plain.modelId).toBe('apac.amazon.nova-pro-v1:0');
    expect(plain.toolConfig?.toolChoice).toEqual({ tool: { name: 'record_device_analysis' } });
    const content = plain.messages![0]!.content!;
    expect(content[0]).toMatchObject({ image: { format: 'png' } });
    expect(Buffer.from((content[0] as { image: { source: { bytes: Uint8Array } } }).image.source.bytes).toString()).toBe('png-bytes');
    expect(content[1]).toEqual({ text: 'Phân tích thiết bị trong các ảnh trên.' });
    expect(plain.guardrailConfig).toBeUndefined();

    const guarded = new BedrockAnalyzer('m', 'ap-southeast-1', { id: 'gr-1', version: '1' }).buildRequest([img]);
    expect(guarded.guardrailConfig).toEqual({ guardrailIdentifier: 'gr-1', guardrailVersion: '1' });
  });

  it('đọc kết quả từ toolUse; Guardrail chặn → lỗi (người dùng nhập tay)', async () => {
    const reply = (output: unknown) => ({ send: async () => output }) as never;
    const ok = new BedrockAnalyzer('m', 'r', undefined, reply({
      stopReason: 'tool_use',
      output: { message: { content: [{ toolUse: { name: 'record_device_analysis', input: { category: 'LAPTOP', condition: 'NOT_WORKING', brand: 'Dell' } } }] } },
    }));
    expect(await ok.analyze([img])).toMatchObject({ category: 'LAPTOP', condition: 'NOT_WORKING', brand: 'Dell' });
    const blocked = new BedrockAnalyzer('m', 'r', { id: 'g', version: '1' }, reply({ stopReason: 'guardrail_intervened', output: { message: { content: [] } } }));
    await expect(blocked.analyze([img])).rejects.toThrow('Guardrail');
  });
});

describe('Chất lượng tiếng Việt + schema suy luận (Nova Pro sai chính tả khi chạy thật)', () => {
  it('sửa lỗi đã gặp, giữ chữ hoa đầu, xóa cụm vô nghĩa thay vì bịa màu / tình trạng', () => {
    expect(sanitizeVietnamese('Chuốt không dây Logitech')).toBe('Chuột không dây Logitech');
    expect(sanitizeVietnamese('Chuốt không dây Logitech màu máu, dùng lịnh.')).toBe('Chuột không dây Logitech.');
    expect(sanitizeVietnamese('Bổ tâng Arduino với các mới nỗi')).toBe('Bo mạch Arduino với các mối nối');
    expect(sanitizeVietnamese('Bổ tàng Arduino với các mới nỗi, bao gồm các dây dân và linh kiện.')).toBe(
      'Bo mạch Arduino với các mối nối, bao gồm các dây dẫn và linh kiện.',
    );
    // Chỉ sửa nguyên từ: "chuốtx" không phải lỗi đã biết; chữ đúng giữ nguyên
    expect(sanitizeVietnamese('chuốtx  Bo mạch vi điều khiển   ESP32')).toBe('chuốtx Bo mạch vi điều khiển ESP32');
  });

  it('validateResult áp sanitizer cho tiêu đề + mô tả, bỏ trường suy luận khỏi AiResult', () => {
    const r = validateResult({
      observedTextAndLabels: 'Logitech M650 L',
      identifiedComponents: ['chuột'],
      category: 'OTHER',
      brand: 'Logitech',
      model: 'M650 L',
      suggestedTitle: 'Chuốt không dây Logitech',
      suggestedDescription: 'Chuốt không dây Logitech màu máu, dùng lịnh.',
    });
    expect(r).toMatchObject({ suggestedTitle: 'Chuột không dây Logitech', suggestedDescription: 'Chuột không dây Logitech.', model: 'M650 L' });
    expect(r).not.toHaveProperty('observedTextAndLabels');
    expect(r).not.toHaveProperty('identifiedComponents');
  });

  it('schema Bedrock: observedTextAndLabels + identifiedComponents đứng đầu, bắt buộc; prompt có bảng từ vựng', () => {
    const req = new BedrockAnalyzer('m', 'ap-southeast-1').buildRequest([]);
    const schema = req.toolConfig!.tools![0]!.toolSpec!.inputSchema!.json as { properties: object; required: string[] };
    expect(Object.keys(schema.properties).slice(0, 2)).toEqual(['observedTextAndLabels', 'identifiedComponents']);
    expect(schema.required).toEqual(expect.arrayContaining(['observedTextAndLabels', 'identifiedComponents']));
    const system = req.system![0]!.text!;
    expect(system).toContain('Chuột không dây');
    expect(system).toContain('Mạch thử nghiệm (Breadboard)');
    expect(system).toContain('"Arduino"');
  });
});

describe('Gemini (Google AI Studio) + dự phòng Bedrock', () => {
  const img = { mediaType: 'image/jpeg' as const, data: 'AAAA' };
  const answer = { category: 'OTHER', brand: 'Logitech', model: 'M650 L', condition: 'UNKNOWN', suggestedTitle: 'Chuốt không dây Logitech M650 L', confidence: 'high' };
  const geminiReply = (status: number, body: unknown) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    };
    return { calls, fetchFn };
  };

  it('gửi ảnh inline + responseSchema JSON; key ở header, không ở URL; kết quả qua validateResult', async () => {
    const { calls, fetchFn } = geminiReply(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] });
    const r = await new GeminiAnalyzer('secret-key', 'gemini-2.5-flash', fetchFn).analyze([img]);
    expect(r).toMatchObject({ brand: 'Logitech', model: 'M650 L', suggestedTitle: 'Chuột không dây Logitech M650 L' });
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(calls[0]!.url).not.toContain('secret-key');
    expect((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret-key');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } });
    expect(body.generationConfig).toMatchObject({ temperature: 0, responseMimeType: 'application/json' });
    expect(body.generationConfig.responseSchema.propertyOrdering.slice(0, 2)).toEqual(['observedTextAndLabels', 'identifiedComponents']);
  });

  const nova = (): Analyzer & { calls: number } => {
    const a = {
      enabled: true,
      modelId: 'apac.amazon.nova-pro-v1:0',
      calls: 0,
      analyze: async (): Promise<AiResult> => {
        a.calls++;
        return validateResult({ category: 'OTHER', suggestedTitle: 'Từ Nova' });
      },
    };
    return a;
  };

  it('Gemini 429 (hết hạn mức) hoặc lỗi → dùng Bedrock; modelId ghi đúng model đã trả kết quả', async () => {
    const limited = new FallbackAnalyzer(new GeminiAnalyzer('k', 'gemini-2.5-flash', geminiReply(429, { error: { code: 429 } }).fetchFn), nova());
    expect(await limited.analyze([img])).toMatchObject({ suggestedTitle: 'Từ Nova' });
    expect(limited.modelId).toBe('apac.amazon.nova-pro-v1:0');

    const crashed = new FallbackAnalyzer(
      new GeminiAnalyzer('k', 'gemini-2.5-flash', async () => {
        throw new Error('network down');
      }),
      nova(),
    );
    expect(await crashed.analyze([img])).toMatchObject({ suggestedTitle: 'Từ Nova' });

    const empty = new FallbackAnalyzer(new GeminiAnalyzer('k', 'gemini-2.5-flash', geminiReply(200, { candidates: [{ finishReason: 'SAFETY' }] }).fetchFn), nova());
    expect(await empty.analyze([img])).toMatchObject({ suggestedTitle: 'Từ Nova' });
  });

  it('Gemini thành công → không gọi Bedrock', async () => {
    const backup = nova();
    const ok = new FallbackAnalyzer(
      new GeminiAnalyzer('k', 'gemini-2.5-flash', geminiReply(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }).fetchFn),
      backup,
    );
    expect(await ok.analyze([img])).toMatchObject({ brand: 'Logitech' });
    expect(ok.modelId).toBe('gemini-2.5-flash');
    expect(backup.calls).toBe(0);
  });

  it('analyzerFor: có cả 2 → Fallback; 1 cái → dùng cái đó; không có → tắt', () => {
    const base = loadConfig({ STAGE: 'local' });
    expect(analyzerFor({ ...base, geminiApiKey: 'k', aiModelId: 'nova' })).toBeInstanceOf(FallbackAnalyzer);
    expect(analyzerFor({ ...base, geminiApiKey: 'k' })).toBeInstanceOf(GeminiAnalyzer);
    expect(analyzerFor({ ...base, aiModelId: 'nova' })).toBeInstanceOf(BedrockAnalyzer);
    expect(analyzerFor(base)).toBeInstanceOf(DisabledAnalyzer);
    expect(loadConfig({ STAGE: 'local', GEMINI_API_KEY: 'k' })).toMatchObject({ geminiApiKey: 'k', geminiModelId: 'gemini-2.5-flash' });
  });
});

describe('Bộ dữ liệu nhãn: AI gợi ý ↔ người đăng chốt', () => {
  it('đăng tin kèm lượt AI → lưu nhãn + các trường người dùng đã sửa; id lạ bị bỏ qua', async () => {
    const { app, table, ai, flush } = setup(async () =>
      validateResult({ category: 'LAPTOP', brand: 'Dell', model: null, condition: 'UNKNOWN', confidence: 'medium' }),
    );
    const u = { userId: 'seller', groups: [] };
    await app.services.users.acceptTerms(u, TERMS_VERSION);
    await app.services.partners.apply(u, { tier: 'INDIVIDUAL', businessType: 'PERSONAL', businessName: 'Người bán', licenseNo: '001099012345', contactEmail: 's@mail.vn' });
    await app.services.partners.review('admin1', 'seller', true);
    const job = await ai.create('seller', KEYS('seller'));
    await flush();

    const listing = await app.services.listings.create(u, listingBody({ imageKeys: KEYS('seller'), brand: 'dell', model: 'Latitude 5490', aiAnalysisId: job.analysisId }));
    const [label] = await table.query<any>(keys.aiLabelPk(listing.createdAt.slice(0, 7)));
    expect(label).toMatchObject({
      listingId: listing.listingId,
      modelId: 'apac.amazon.nova-pro-v1:0',
      imageKeys: KEYS('seller'),
      ai: { category: 'LAPTOP', brand: 'Dell', model: null, condition: 'UNKNOWN' },
      final: { category: 'LAPTOP', brand: 'dell', model: 'Latitude 5490', condition: 'NOT_WORKING' },
      changed: ['model', 'condition'], // "dell" = "Dell" không tính là sửa
    });

    await app.services.listings.create(u, listingBody({ imageKeys: KEYS('seller'), aiAnalysisId: 'khong-hop-le' }));
    expect(await table.query(keys.aiLabelPk(listing.createdAt.slice(0, 7)))).toHaveLength(1);
  });
});
