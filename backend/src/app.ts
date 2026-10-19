import { BedrockAnalyzer, DisabledAnalyzer, type Analyzer } from './ai/analyzer';
import { CognitoAuthProvider, LocalAuthProvider, type AuthProvider } from './auth/auth';
import { apiRoutes, type Services } from './http/routes';
import { ChatService } from './modules/chat/chatService';
import { AiService } from './modules/ai/aiService';
import { TimerSweeper } from './modules/jobs/timers';
import { LocationService } from './modules/locations/locationService';
import { ReportService } from './modules/reports/reportService';
import { ListingService } from './modules/listings/listingService';
import { NotificationService } from './modules/notifications/notificationService';
import { ReputationService } from './modules/reputation/reputationService';
import { TransactionService } from './modules/transactions/transactionService';
import { PartnerService } from './modules/partners/partnerService';
import { createApiHandler } from './http/router';
import { UserService } from './modules/users/userService';
import { Ledger } from './modules/wallet/ledger';
import { DEFAULT_FEES, type FeePolicy } from './modules/wallet/walletConfig';
import { WalletService } from './modules/wallet/walletService';
import { systemClock, type Clock } from './shared/clock';
import { DynamoTable } from './store/dynamoTable';
import { DisabledImageStore, S3ImageStore, type ImageStore } from './storage/imageStore';
import { DisabledModerator, RekognitionModerator, type ImageModerator } from './storage/moderator';
import { MemoryTable } from './store/memoryTable';
import type { Table } from './store/table';

export interface AppConfig {
  stage: 'local' | 'aws';
  authMode: 'local' | 'cognito';
  fees: FeePolicy;
  /** Bảng DynamoDB khi STAGE=aws. */
  tableName?: string;
  /** Bucket ảnh thiết bị. Không có → tắt upload ảnh (dev local không có AWS). */
  imageBucket?: string;
  /** Model Bedrock cho AI phân tích ảnh (mặc định Amazon Nova Pro). Không có → tắt AI, người dùng nhập tay. */
  aiModelId?: string;
  /** Bedrock Guardrail áp cho mỗi lần gọi AI (không bắt buộc). */
  aiGuardrail?: { id: string; version: string };
  awsRegion: string;
  /** Chỉ dùng với MemoryTable khi dev local. */
  dataFile?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const stage = env.STAGE === 'aws' ? 'aws' : 'local';
  const authMode = env.AUTH_MODE === 'cognito' ? 'cognito' : 'local';
  if (stage === 'aws' && authMode !== 'cognito') throw new Error('STAGE=aws bắt buộc AUTH_MODE=cognito');
  if (stage === 'aws' && !env.TABLE_NAME) throw new Error('STAGE=aws bắt buộc TABLE_NAME');
  return {
    stage,
    authMode,
    fees: DEFAULT_FEES,
    tableName: env.TABLE_NAME,
    imageBucket: env.IMAGE_BUCKET || undefined,
    aiModelId: env.AI_MODEL_ID || undefined,
    aiGuardrail: env.AI_GUARDRAIL_ID ? { id: env.AI_GUARDRAIL_ID, version: env.AI_GUARDRAIL_VERSION || 'DRAFT' } : undefined,
    awsRegion: env.AWS_REGION ?? 'ap-southeast-1',
    dataFile: env.DATA_FILE ?? '.data/db.json',
  };
}

/** Lắp các adapter theo môi trường. Test truyền overrides (bảng trong bộ nhớ, đồng hồ giả). */
export function buildApp(
  config: AppConfig,
  overrides: { table?: Table; clock?: Clock; images?: ImageStore; analyzer?: Analyzer; moderator?: ImageModerator } = {},
) {
  const clock = overrides.clock ?? systemClock;
  const table =
    overrides.table ??
    (config.stage === 'aws' ? new DynamoTable(config.tableName ?? '') : new MemoryTable(config.dataFile));
  const auth: AuthProvider = config.authMode === 'cognito' ? new CognitoAuthProvider() : new LocalAuthProvider();
  const images = overrides.images ?? (config.imageBucket ? new S3ImageStore(config.imageBucket) : new DisabledImageStore());
  const moderator = overrides.moderator ?? (config.imageBucket ? new RekognitionModerator(config.imageBucket) : new DisabledModerator());

  const users = new UserService(table, clock);
  const wallet = new WalletService(table, clock, new Ledger(table, clock), config.fees);
  const notifications = new NotificationService(table, clock);
  const partners = new PartnerService(table, clock, users, notifications);
  const listings = new ListingService(table, clock, users, partners, images, notifications);
  const transactions = new TransactionService(table, clock, users, partners, listings, notifications, images);
  const reputation = new ReputationService(table, clock);
  const analyzer = overrides.analyzer ?? (config.aiModelId ? new BedrockAnalyzer(config.aiModelId, config.awsRegion, config.aiGuardrail) : new DisabledAnalyzer());
  const ai = new AiService(table, clock, analyzer, images);
  const locations = new LocationService(table, clock);
  const reports = new ReportService(table, clock, listings, notifications);
  const chat = new ChatService(table, clock, listings, partners, users, notifications);
  const services: Services = { users, wallet, partners, listings, images, moderator, notifications, transactions, reputation, ai, locations, reports, chat };
  const sweeper = new TimerSweeper(table, clock, {
    LISTING_EXPIRE: (t) => listings.expireIfDue(t.targetId),
    TX_REMIND: (t) => transactions.remindIfWaiting(t.targetId),
    TX_AUTO_COMPLETE: async (t) => void (await transactions.autoComplete(t.targetId)),
  });

  const routes = apiRoutes(services);
  return { handler: createApiHandler({ routes, auth, table, clock }), services, table, sweeper };
}
