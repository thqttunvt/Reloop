import type { AiResult, Analyzer } from '../../ai/analyzer';
import { log } from '../../http/log';
import type { Clock } from '../../shared/clock';
import { AppError, conflict, notFound } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { assertOwnImageKeys, type ImageStore } from '../../storage/imageStore';
import { keys } from '../../store/keys';
import { withOptimisticRetry } from '../../store/retry';
import { ConditionFailedError, putVersioned, type Item, type Table } from '../../store/table';

/** Giới hạn gọi AI (T5.3): 20 lần / user / ngày; tối đa 3 ảnh / lần (giaiphap A1). */
export const AI_DAILY_LIMIT = 20;
export const AI_MAX_IMAGES = 3;

export interface Analysis extends Item {
  analysisId: string;
  userId: string;
  imageKeys: string[];
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  result?: AiResult;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

/** Cách chạy worker: AWS → Lambda tự gọi chính nó dạng async; local/test → chạy ngay sau khi trả response. */
export type Dispatch = (analysisId: string) => Promise<void>;

/** AI phân tích ảnh chạy nền (QĐ-13, giaiphap A1): tạo job → 202 → frontend polling. */
export class AiService {
  dispatch: Dispatch = async (id) => {
    setTimeout(() => void this.run(id), 0);
  };

  constructor(
    private readonly table: Table,
    private readonly clock: Clock,
    private readonly analyzer: Analyzer,
    private readonly images: ImageStore,
  ) {}

  get enabled() {
    return this.analyzer.enabled && this.images.enabled;
  }

  async create(userId: string, rawKeys: unknown): Promise<Analysis> {
    if (!this.enabled) throw new AppError(503, 'AI_DISABLED', 'AI chưa bật ở môi trường này — hãy nhập thông tin thủ công');
    const imageKeys = assertOwnImageKeys(userId, rawKeys).slice(0, AI_MAX_IMAGES);
    if (imageKeys.length === 0) throw new AppError(400, 'IMAGES_REQUIRED', 'Cần ít nhất 1 ảnh');
    await this.images.assertModerated(imageKeys);
    await this.consumeQuota(userId);

    const now = this.clock.now().toISOString();
    const analysisId = newId();
    const analysis: Analysis = { ...keys.aiAnalysis(userId, analysisId), analysisId, userId, imageKeys, status: 'PENDING', createdAt: now };
    await this.table.transact([putVersioned(analysis, 0)]);
    await this.dispatch(`${userId}/${analysisId}`);
    return { ...analysis, version: 1 };
  }

  async get(userId: string, analysisId: string) {
    const k = keys.aiAnalysis(userId, analysisId);
    const a = await this.table.get<Analysis>(k.pk, k.sk);
    if (!a) throw notFound('lượt phân tích');
    return a;
  }

  /** Worker. Idempotent: chỉ xử lý khi còn PENDING. */
  async run(ref: string): Promise<void> {
    const [userId, analysisId] = ref.split('/') as [string, string];
    const k = keys.aiAnalysis(userId, analysisId);
    const a = await this.table.get<Analysis>(k.pk, k.sk);
    if (!a || a.status !== 'PENDING') return;
    let next: Analysis;
    try {
      const imgs = await Promise.all(a.imageKeys.map((key) => this.images.read(key)));
      const result = await this.analyzer.analyze(imgs);
      next = { ...a, status: 'COMPLETED', result, completedAt: this.clock.now().toISOString() };
    } catch (err) {
      log('error', 'ai_analysis_failed', { analysisId, error: err instanceof Error ? err.message : String(err) });
      next = { ...a, status: 'FAILED', error: 'Không phân tích được ảnh — hãy nhập thông tin thủ công', completedAt: this.clock.now().toISOString() };
    }
    try {
      await this.table.transact([putVersioned(next, a.version ?? 1)]);
    } catch (err) {
      if (!(err instanceof ConditionFailedError)) throw err; // lượt chạy trùng đã ghi trước
    }
  }

  private consumeQuota(userId: string) {
    const day = this.clock.now().toISOString().slice(0, 10);
    const k = keys.aiQuota(userId, day);
    return withOptimisticRetry(async () => {
      const q = await this.table.get<Item & { count: number }>(k.pk, k.sk);
      const count = q?.count ?? 0;
      if (count >= AI_DAILY_LIMIT) throw conflict('AI_DAILY_LIMIT', `Mỗi ngày tối đa ${AI_DAILY_LIMIT} lượt phân tích AI`);
      await this.table.transact([putVersioned({ ...k, count: count + 1, ttl: Math.floor(this.clock.now().getTime() / 1000) + 2 * 86400 }, q?.version ?? 0)]);
    });
  }
}
