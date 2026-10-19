import { DeleteObjectCommand, GetObjectCommand, GetObjectTaggingCommand, PutObjectTaggingCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppError, badRequest } from '../shared/errors';
import { log } from '../http/log';
import { newId } from '../shared/ids';
import type { TextScreener } from './textScreener';

/**
 * Vòng đời ảnh (QĐ-27) do S3 Lifecycle xử lý theo tag "state":
 *  - pending  : vừa upload, chưa gắn vào tin → xóa sau 1 ngày (ảnh rác)
 *  - attached : đã gắn vào tin / đề nghị giảm giá → xóa sau 120 ngày (≈ 90 ngày sau khi tin kết thúc)
 * Rule nằm ở infra/storage.tf.
 * Tag "moderation=passed": ảnh đã qua kiểm duyệt Rekognition — bắt buộc trước khi dùng ảnh.
 */
const tagging = (state: 'pending' | 'attached') => `<Tagging><TagSet><Tag><Key>state</Key><Value>${state}</Value></Tag></TagSet></Tagging>`;

/** Giới hạn ảnh (giaiphap E6): JPEG/PNG/WebP, ≤ 5 MB/ảnh, 1–6 ảnh/tin. */
export const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_LISTING = 6;

export interface UploadTicket {
  key: string;
  /** Trình duyệt POST multipart tới url, gửi kèm toàn bộ fields rồi tới field "file". */
  url: string;
  fields: Record<string, string>;
  expiresInSeconds: number;
}

/** Cổng lưu ảnh. Nghiệp vụ chỉ biết key; URL xem ảnh là link tạm thời. */
export interface ImageStore {
  readonly enabled: boolean;
  createUpload(userId: string, contentType: unknown): Promise<UploadTicket>;
  viewUrl(key: string): Promise<string>;
  /** Đánh dấu ảnh đã được dùng → không bị xóa như ảnh rác. */
  markAttached(keys: string[]): Promise<void>;
  /** Ảnh vừa qua kiểm duyệt (vẫn là ảnh rác cho tới khi được gắn vào tin). */
  markModerated(key: string): Promise<void>;
  /** Ném 400 IMAGE_NOT_MODERATED nếu có ảnh chưa qua kiểm duyệt. */
  assertModerated(keys: string[]): Promise<void>;
  remove(key: string): Promise<void>;
  /** Đọc ảnh (base64) để gửi cho AI — Bedrock không nhận ảnh qua URL. */
  read(key: string): Promise<{ mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; data: string }>;
}

/** Key ảnh của user luôn nằm dưới listings/<userId>/ — backend chỉ nhận key đúng prefix của người gửi. */
export const userImagePrefix = (userId: string) => `listings/${userId}/`;

export const assertOwnImageKeys = (userId: string, value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGES_PER_LISTING) {
    throw badRequest('INVALID_IMAGE_KEYS', `Tối đa ${MAX_IMAGES_PER_LISTING} ảnh`);
  }
  const prefix = userImagePrefix(userId);
  const keys = value.map((k) => {
    if (typeof k !== 'string' || !k.startsWith(prefix) || !/^[a-zA-Z0-9/._-]+$/.test(k)) {
      throw badRequest('INVALID_IMAGE_KEYS', 'Ảnh không hợp lệ');
    }
    return k;
  });
  return [...new Set(keys)];
};

export class S3ImageStore implements ImageStore {
  readonly enabled = true;
  private readonly s3 = new S3Client({});

  constructor(private readonly bucket: string) {}

  async createUpload(userId: string, contentType: unknown): Promise<UploadTicket> {
    const ext = typeof contentType === 'string' ? IMAGE_TYPES[contentType] : undefined;
    if (!ext) throw badRequest('INVALID_CONTENT_TYPE', 'Chỉ nhận ảnh JPEG, PNG hoặc WebP');
    const key = `${userImagePrefix(userId)}${newId()}.${ext}`;
    const expiresInSeconds = 300;
    const { url, fields } = await createPresignedPost(this.s3, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [
        ['content-length-range', 1, MAX_IMAGE_BYTES],
        ['eq', '$Content-Type', contentType as string],
        ['eq', '$tagging', tagging('pending')],
      ],
      Fields: { 'Content-Type': contentType as string, tagging: tagging('pending') },
      Expires: expiresInSeconds,
    });
    return { key, url, fields, expiresInSeconds };
  }

  viewUrl(key: string): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: 3600 });
  }

  private setTags(Key: string, state: 'pending' | 'attached') {
    return this.s3.send(
      new PutObjectTaggingCommand({
        Bucket: this.bucket,
        Key,
        Tagging: { TagSet: [{ Key: 'state', Value: state }, { Key: 'moderation', Value: 'passed' }] },
      }),
    );
  }

  async markAttached(keys: string[]): Promise<void> {
    await Promise.all(keys.map((k) => this.setTags(k, 'attached')));
  }

  async markModerated(key: string): Promise<void> {
    await this.setTags(key, 'pending');
  }

  async assertModerated(keys: string[]): Promise<void> {
    const results = await Promise.all(
      keys.map(async (Key) => {
        try {
          const res = await this.s3.send(new GetObjectTaggingCommand({ Bucket: this.bucket, Key }));
          return res.TagSet?.some((t) => t.Key === 'moderation' && t.Value === 'passed') ?? false;
        } catch {
          return false; // ảnh không tồn tại (đã bị xóa / hết hạn)
        }
      }),
    );
    if (results.includes(false)) throw badRequest('IMAGE_NOT_MODERATED', 'Có ảnh chưa qua kiểm duyệt hoặc đã bị xóa — hãy tải lại ảnh');
  }

  async remove(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async read(key: string) {
    const obj = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await obj.Body!.transformToByteArray();
    const ext = key.split('.').pop();
    const mediaType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return { mediaType: mediaType as 'image/jpeg' | 'image/png' | 'image/webp', data: Buffer.from(bytes).toString('base64') };
  }
}

/** Không cấu hình IMAGE_BUCKET (dev local không có AWS) → tắt upload ảnh, tin đăng vẫn tạo được. */
export class DisabledImageStore implements ImageStore {
  readonly enabled = false;
  async createUpload(): Promise<UploadTicket> {
    throw new AppError(503, 'IMAGES_DISABLED', 'Upload ảnh chưa được cấu hình ở môi trường này');
  }
  async viewUrl(): Promise<string> {
    return '';
  }
  async markAttached(): Promise<void> {}
  async markModerated(): Promise<void> {}
  async assertModerated(): Promise<void> {}
  async remove(): Promise<void> {}
  async read(): Promise<never> {
    throw new AppError(503, 'IMAGES_DISABLED', 'Upload ảnh chưa được cấu hình ở môi trường này');
  }
}

/**
 * Kiểm duyệt ảnh ngay sau khi trình duyệt upload xong:
 *  1. Rekognition: hình nhạy cảm → xóa ảnh, trả 422.
 *  2. (QĐ-36) Chữ trong ảnh giống câu lệnh tấn công → GẮN CỜ, không chặn: tin dùng ảnh này phải chờ Admin duyệt.
 */
export async function moderateUpload(
  images: ImageStore,
  moderator: import('./moderator').ImageModerator,
  userId: string,
  rawKey: unknown,
  onRejected: (key: string, labels: { name: string; confidence: number }[]) => void,
  textCheck?: { screener: TextScreener; onFlagged: (key: string, text: string) => Promise<void> },
) {
  const [key] = assertOwnImageKeys(userId, [rawKey]);
  if (!key) throw badRequest('INVALID_IMAGE_KEYS', 'Ảnh không hợp lệ');
  if (!images.enabled) return { key, allowed: true, flagged: false };
  const result = await moderator.check(key);
  if (!result.allowed) {
    await images.remove(key);
    onRejected(key, result.labels);
    throw new AppError(422, 'IMAGE_REJECTED', 'Ảnh bị từ chối vì có nội dung không phù hợp. Vui lòng chỉ đăng ảnh thiết bị.', {
      labels: result.labels.map((l) => l.name),
    });
  }
  await images.markModerated(key);

  let flagged = false;
  if (textCheck?.screener.enabled) {
    try {
      const screen = await textCheck.screener.check(key);
      flagged = screen.flagged;
      if (flagged) await textCheck.onFlagged(key, screen.text);
    } catch (err) {
      // Lỗi OCR / Guardrail không được chặn người dùng upload ảnh
      log('error', 'image_text_check_failed', { key, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { key, allowed: true, flagged };
}
