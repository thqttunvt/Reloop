import { describe, expect, it } from 'vitest';
import { BedrockAnalyzer, validateResult, type Analyzer } from '../src/ai/analyzer';
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
  const app = buildApp({ ...loadConfig({ STAGE: 'local' }), dataFile: undefined }, { table, clock: new ManualClock(), images: fakeImages, analyzer });
  const ai = app.services.ai;
  const pending: string[] = [];
  ai.dispatch = async (ref) => void pending.push(ref); // worker chạy khi test gọi flush()
  const flush = async () => {
    for (const ref of pending.splice(0)) await ai.run(ref);
  };
  return { app, table, ai, calls, flush };
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
