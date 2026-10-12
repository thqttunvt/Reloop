import { CognitoAuthProvider, LocalAuthProvider, type AuthProvider } from './auth/auth';
import { FakeBankProvider, type BankProvider } from './bank/bankProvider';
import { apiRoutes, devRoutes, type Services } from './http/routes';
import { createApiHandler } from './http/router';
import { UserService } from './modules/users/userService';
import { Ledger } from './modules/wallet/ledger';
import { PayoutService } from './modules/wallet/payoutService';
import {
  DEFAULT_FEES,
  DEFAULT_LIMITS,
  type BankAccountInfo,
  type FeePolicy,
  type WalletLimits,
} from './modules/wallet/walletConfig';
import { WalletService } from './modules/wallet/walletService';
import { systemClock, type Clock } from './shared/clock';
import { MemoryTable } from './store/memoryTable';
import type { Table } from './store/table';

export interface AppConfig {
  stage: 'local' | 'aws';
  authMode: 'local' | 'cognito';
  receivingAccount: BankAccountInfo;
  webhookSecret: string;
  limits: WalletLimits;
  fees: FeePolicy;
  /** Chỉ dùng với MemoryTable khi dev local. */
  dataFile?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const stage = env.STAGE === 'aws' ? 'aws' : 'local';
  const authMode = env.AUTH_MODE === 'cognito' ? 'cognito' : 'local';
  if (stage === 'aws' && authMode !== 'cognito') throw new Error('STAGE=aws bắt buộc AUTH_MODE=cognito');
  const webhookSecret = env.BANK_WEBHOOK_SECRET ?? '';
  if (stage === 'aws' && webhookSecret.length < 16) throw new Error('BANK_WEBHOOK_SECRET quá ngắn');
  return {
    stage,
    authMode,
    receivingAccount: {
      bankBin: env.BANK_BIN ?? '970422',
      accountNo: env.BANK_ACCOUNT_NO ?? '0000000000',
      accountName: env.BANK_ACCOUNT_NAME ?? 'RELOOP DEMO',
    },
    webhookSecret: webhookSecret || 'dev-secret',
    limits: DEFAULT_LIMITS,
    fees: DEFAULT_FEES,
    dataFile: env.DATA_FILE ?? '.data/db.json',
  };
}

/** Lắp các adapter theo môi trường. Test truyền overrides (bảng trong bộ nhớ, đồng hồ giả). */
export function buildApp(config: AppConfig, overrides: { table?: Table; clock?: Clock; bankProvider?: BankProvider } = {}) {
  const clock = overrides.clock ?? systemClock;
  // TODO(tuần 5–6): DynamoTable cho STAGE=aws (cùng interface Table).
  const table = overrides.table ?? new MemoryTable(config.stage === 'local' ? config.dataFile : undefined);
  const auth: AuthProvider = config.authMode === 'cognito' ? new CognitoAuthProvider() : new LocalAuthProvider();
  const bankProvider = overrides.bankProvider ?? new FakeBankProvider(config.webhookSecret);

  const users = new UserService(table, clock);
  const ledger = new Ledger(table, clock);
  const wallet = new WalletService(table, clock, ledger, users, config.receivingAccount, config.limits, config.fees);
  const payouts = new PayoutService(table, clock, ledger, users, config.limits);
  const services: Services = { users, wallet, payouts, bankProvider };

  const routes = [...apiRoutes(services), ...(config.stage === 'local' ? devRoutes(services, config.webhookSecret) : [])];
  return { handler: createApiHandler({ routes, auth, table, clock }), services, table };
}
