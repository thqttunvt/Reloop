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
  hold: (transactionId: string) => ({ pk: `TXN#${transactionId}`, sk: 'HOLD' }),
  listingFee: (listingId: string) => ({ pk: `LISTING#${listingId}`, sk: 'FEE' }),
  listingFeeCounter: (userId: string) => ({ pk: `USER#${userId}`, sk: 'LISTINGFEE_COUNTER' }),
  idempotency: (userId: string, key: string) => ({ pk: `IDEM#${userId}`, sk: key }),

  // Đối tác (partnerId = userId của người đăng ký)
  partner: (partnerId: string) => ({ pk: `PARTNER#${partnerId}`, sk: 'PROFILE' }),
  partnerPk: (partnerId: string) => `PARTNER#${partnerId}`,
  branch: (partnerId: string, branchId: string) => ({ pk: `PARTNER#${partnerId}`, sk: `BRANCH#${branchId}` }),
  rule: (partnerId: string, ruleId: string) => ({ pk: `PARTNER#${partnerId}`, sk: `RULE#${ruleId}` }),
  /** Hộp "tin phù hợp" của Partner (Matching Requests), mới nhất trước. */
  partnerRequest: (partnerId: string, at: string, listingId: string, branchId: string) => ({
    pk: `PARTNER#${partnerId}`,
    sk: `REQ#${at}#${listingId}#${branchId}`,
  }),

  // Tin đăng
  listing: (listingId: string) => ({ pk: `LISTING#${listingId}`, sk: 'META' }),
  listingPk: (listingId: string) => `LISTING#${listingId}`,
  /** Bảng tin chung: con trỏ tới tin, chia "ngăn" theo tháng tạo tin, mới nhất trước. */
  feedItem: (month: string, at: string, listingId: string) => ({ pk: `FEED#${month}`, sk: `${at}#${listingId}` }),
  feedPk: (month: string) => `FEED#${month}`,
  match: (listingId: string, branchId: string) => ({ pk: `LISTING#${listingId}`, sk: `MATCH#${branchId}` }),
  quote: (listingId: string, quoteId: string) => ({ pk: `LISTING#${listingId}`, sk: `QUOTE#${quoteId}` }),

  // Giao dịch
  transaction: (transactionId: string) => ({ pk: `TX#${transactionId}`, sk: 'META' }),
  transactionPk: (transactionId: string) => `TX#${transactionId}`,
  transactionEvent: (transactionId: string, at: string, seq: number) => ({
    pk: `TX#${transactionId}`,
    sk: `EVENT#${at}#${String(seq).padStart(3, '0')}`,
  }),
  /** Danh sách giao dịch của một người tham gia (Owner hoặc Partner), mới nhất trước. */
  userTransaction: (userId: string, at: string, transactionId: string) => ({ pk: `USER#${userId}`, sk: `TX#${at}#${transactionId}` }),
  review: (transactionId: string, by: string) => ({ pk: `TX#${transactionId}`, sk: `REVIEW#${by}` }),
  /** Đánh giá nhận được — để tính uy tín (T12.3). */
  receivedReview: (userId: string, at: string, transactionId: string) => ({ pk: `USER#${userId}`, sk: `RATING#${at}#${transactionId}` }),

  savedLocation: (userId: string, locationId: string) => ({ pk: `USER#${userId}`, sk: `LOC#${locationId}` }),
  report: (reportId: string) => ({ pk: `REPORT#${reportId}`, sk: 'META' }),

  // Chat người bán ↔ đơn vị thu mua theo từng tin
  conversation: (conversationId: string) => ({ pk: `CONV#${conversationId}`, sk: 'META' }),
  conversationPk: (conversationId: string) => `CONV#${conversationId}`,
  /** seq = version của cuộc trò chuyện lúc gửi → thứ tự đúng kể cả khi 2 tin cùng mili giây. */
  chatMessage: (conversationId: string, at: string, seq: number, id: string) => ({
    pk: `CONV#${conversationId}`,
    sk: `MSG#${at}#${String(seq).padStart(8, '0')}#${id}`,
  }),
  userConversation: (userId: string, conversationId: string) => ({ pk: `USER#${userId}`, sk: `CONV#${conversationId}` }),

  // Hẹn giờ việc nền (Epic 10)
  timer: (bucket: string, kind: string, id: string) => ({ pk: `TIMER#${bucket}`, sk: `${kind}#${id}` }),
  timerPk: (bucket: string) => `TIMER#${bucket}`,

  // AI phân tích ảnh
  aiAnalysis: (userId: string, analysisId: string) => ({ pk: `USER#${userId}`, sk: `AI#${analysisId}` }),
  aiQuota: (userId: string, day: string) => ({ pk: `USER#${userId}`, sk: `AIQUOTA#${day}` }),

  // Thông báo
  notification: (userId: string, at: string, id: string) => ({ pk: `USER#${userId}`, sk: `NOTIF#${at}#${id}` }),
  notificationPk: (userId: string) => `USER#${userId}`,
  userPk: (userId: string) => `USER#${userId}`,
};

/** GSI1 dùng cho hàng đợi Admin: lọc theo trạng thái, sắp theo thời gian. */
export const gsi1 = {
  byStatus: (entity: string, status: string, at: string) => ({ gsi1pk: `${entity}#STATUS#${status}`, gsi1sk: at }),
  statusPk: (entity: string, status: string) => `${entity}#STATUS#${status}`,
  /** Tìm chi nhánh theo ô geohash (TL-01). */
  geo: (geohash: string, partnerId: string, branchId: string) => ({ gsi1pk: `GEO4#${geohash}`, gsi1sk: `BRANCH#${partnerId}#${branchId}` }),
  geoPk: (geohash: string) => `GEO4#${geohash}`,
  /** Tin đăng của một Owner, mới nhất trước. */
  ownerListing: (ownerId: string, at: string) => ({ gsi1pk: `OWNER#${ownerId}`, gsi1sk: `LISTING#${at}` }),
  ownerListingPk: (ownerId: string) => `OWNER#${ownerId}`,
};
