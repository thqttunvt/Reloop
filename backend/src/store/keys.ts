/** Tập trung mọi khóa single-table ở một chỗ (đối chiếu giaiphap.txt E2). */
export const keys = {
  userProfile: (userId: string) => ({ pk: `USER#${userId}`, sk: 'PROFILE' }),
  wallet: (ownerId: string) => ({ pk: `WALLET#${ownerId}`, sk: 'BALANCE' }),
  walletLedgerPk: (ownerId: string) => `WALLET#${ownerId}`,
  walletLedgerLine: (ownerId: string, at: string, journalId: string) => ({
    pk: `WALLET#${ownerId}`,
    sk: `LEDGER#${at}#${journalId}`,
  }),
  journal: (journalId: string) => ({ pk: `JOURNAL#${journalId}`, sk: 'META' }),
  bankBalance: () => ({ pk: 'SYSTEM', sk: 'BANK' }),
  bankTxn: (bankTxnId: string) => ({ pk: `BANKTXN#${bankTxnId}`, sk: 'META' }),
  topUp: (userId: string, topUpId: string) => ({ pk: `USER#${userId}`, sk: `TOPUP#${topUpId}` }),
  topUpCode: (code: string) => ({ pk: `TOPUPCODE#${code}`, sk: 'META' }),
  hold: (transactionId: string) => ({ pk: `TXN#${transactionId}`, sk: 'HOLD' }),
  listingFee: (listingId: string) => ({ pk: `LISTING#${listingId}`, sk: 'FEE' }),
  listingFeeCounter: (userId: string) => ({ pk: `USER#${userId}`, sk: 'LISTINGFEE_COUNTER' }),
  bankAccount: (userId: string, accountId: string) => ({ pk: `USER#${userId}`, sk: `BANKACC#${accountId}` }),
  withdrawal: (userId: string, withdrawalId: string) => ({ pk: `USER#${userId}`, sk: `WD#${withdrawalId}` }),
  withdrawalCode: (code: string) => ({ pk: `WDCODE#${code}`, sk: 'META' }),
  reconciliation: (at: string, id: string) => ({ pk: 'RECON', sk: `${at}#${id}` }),
  idempotency: (userId: string, key: string) => ({ pk: `IDEM#${userId}`, sk: key }),
};

/** GSI1 dùng cho hàng đợi Admin: lọc theo trạng thái, sắp theo thời gian. */
export const gsi1 = {
  byStatus: (entity: string, status: string, at: string) => ({ gsi1pk: `${entity}#STATUS#${status}`, gsi1sk: at }),
  statusPk: (entity: string, status: string) => `${entity}#STATUS#${status}`,
};
