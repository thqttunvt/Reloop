import { describe, expect, it } from 'vitest';
import { moderateUpload, type ImageStore } from '../src/storage/imageStore';
import type { ImageModerator } from '../src/storage/moderator';

function fakes(allowed: boolean) {
  const calls: string[] = [];
  const images: ImageStore = {
    enabled: true,
    createUpload: async () => ({ key: 'k', url: 'u', fields: {}, expiresInSeconds: 1 }),
    viewUrl: async () => '',
    markAttached: async () => undefined,
    markModerated: async (k) => void calls.push(`moderated:${k}`),
    assertModerated: async () => undefined,
    remove: async (k) => void calls.push(`removed:${k}`),
    read: async () => ({ mediaType: 'image/jpeg', data: '' }),
  };
  const moderator: ImageModerator = {
    enabled: true,
    check: async () => (allowed ? { allowed: true, labels: [] } : { allowed: false, labels: [{ name: 'Explicit Nudity', confidence: 98 }] }),
  };
  return { images, moderator, calls };
}

describe('Kiểm duyệt ảnh (Rekognition, M6)', () => {
  it('ảnh sạch → gắn tag đã kiểm duyệt', async () => {
    const { images, moderator, calls } = fakes(true);
    const res = await moderateUpload(images, moderator, 'u1', 'listings/u1/a.jpg', () => undefined);
    expect(res).toEqual({ key: 'listings/u1/a.jpg', allowed: true });
    expect(calls).toEqual(['moderated:listings/u1/a.jpg']);
  });

  it('ảnh nhạy cảm → xóa ngay, trả 422 IMAGE_REJECTED, ghi nhận vi phạm', async () => {
    const { images, moderator, calls } = fakes(false);
    const rejected: string[] = [];
    await expect(moderateUpload(images, moderator, 'u1', 'listings/u1/b.jpg', (k) => rejected.push(k))).rejects.toMatchObject({
      status: 422,
      code: 'IMAGE_REJECTED',
      details: { labels: ['Explicit Nudity'] },
    });
    expect(calls).toEqual(['removed:listings/u1/b.jpg']);
    expect(rejected).toEqual(['listings/u1/b.jpg']);
  });

  it('không kiểm duyệt / xóa được ảnh của người khác', async () => {
    const { images, moderator, calls } = fakes(false);
    await expect(moderateUpload(images, moderator, 'u1', 'listings/u2/b.jpg', () => undefined)).rejects.toMatchObject({ code: 'INVALID_IMAGE_KEYS' });
    expect(calls).toEqual([]);
  });
});
