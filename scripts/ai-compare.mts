// So sánh AI phân tích ảnh trên ảnh thật: Bedrock Nova Pro (prompt mới) ↔ Gemini (nếu có key).
// Dùng (từ thư mục gốc repo):
//   aws login --profile reloop
//   AWS_PROFILE=reloop GEMINI_API_KEY=... npx -w backend tsx ../scripts/ai-compare.mts anh1.jpg [anh2.jpg ...]
// Không có GEMINI_API_KEY → chỉ chạy Nova Pro. Ảnh chỉ đọc từ máy, không upload S3.
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { BedrockAnalyzer, DEFAULT_GEMINI_MODEL, GeminiAnalyzer, type Analyzer, type ImageInput } from '../backend/src/ai/analyzer';

const files = process.argv.slice(2);
if (files.length === 0) throw new Error('Truyền đường dẫn ảnh (tối đa 3)');
const TYPES: Record<string, ImageInput['mediaType']> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const images: ImageInput[] = files.slice(0, 3).map((f) => ({
  mediaType: TYPES[extname(f).toLowerCase()] ?? 'image/jpeg',
  data: readFileSync(resolve(f)).toString('base64'),
}));

const analyzers: Analyzer[] = [new BedrockAnalyzer(process.env.AI_MODEL_ID ?? 'apac.amazon.nova-pro-v1:0', process.env.AWS_REGION ?? 'ap-southeast-1')];
if (process.env.GEMINI_API_KEY) analyzers.push(new GeminiAnalyzer(process.env.GEMINI_API_KEY, process.env.GEMINI_MODEL_ID ?? DEFAULT_GEMINI_MODEL));

for (const a of analyzers) {
  const started = Date.now();
  try {
    const r = await a.analyze(images);
    console.log(`\n=== ${a.modelId} (${Date.now() - started} ms)`);
    console.log(JSON.stringify(r, null, 2));
  } catch (err) {
    console.log(`\n=== ${a.modelId} LỖI: ${err instanceof Error ? err.message : String(err)}`);
  }
}
