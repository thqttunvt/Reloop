import { describe, expect, it } from 'vitest';
import { validateResult, type Analyzer } from '../src/ai/analyzer';
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
    analyze: async (imgs) => {
      calls.push(imgs.length);
      return analyze(imgs);
    },
  };
  const app = buildApp({ ...loadConfig({ STAGE: 'local' }), dataFile: undefined }, { table: new MemoryTable(), clock: new ManualClock(), images: fakeImages, analyzer });
  const ai = app.services.ai;
  const pending: string[] = [];
  ai.dispatch = async (ref) => void pending.push(ref); // worker chạy khi test gọi flush()
  const flush = async () => {
    for (const ref of pending.splice(0)) await ai.run(ref);
  };
  return { ai, calls, flush };
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
