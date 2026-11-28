import { onValue, ref, remove } from 'firebase/database';
import { TransactionType } from '../types';
import { getItemFromIndexedDB, saveItemToIndexedDB } from './indexedDB';
import { ensureFirebaseAuth, firebaseConfig, rtdb } from './firebase';
import {
  allocateNextTemporaryCode,
  analyzeItemPhotoWithAi,
  callGeminiJsonPrompt,
  findLocalProductByVisualOrName,
  loadProductCatalogSync,
  persistCatalogProductDecision,
  removeOfflineCameraScan,
} from './cameraCatalog';

export type SmsMessageStatus =
  | 'unanalyzed'
  | 'queued_offline'
  | 'analyzing'
  | 'pending_approval'
  | 'accepted'
  | 'rejected'
  | 'ignored_non_financial';

export interface ParsedSmsTransactionProposal {
  isFinancialTransaction: boolean;
  ignoreReason?: 'otp' | 'promo' | 'informational';
  type: TransactionType;
  amount: number;
  feeOrTax?: number;
  currency?: string;
  merchantOrTitle: string;
  categoryHint?: string;
  accountHint?: string; // e.g. CIB, BM, InstaPay, card last 4 digits
  toAccountHint?: string;
}

export interface DeviceSmsMessage {
  id: string;
  sender: string;
  domain?: string;
  body: string;
  receivedAt: number;
  source: 'webhook' | 'share' | 'paste' | 'import' | 'camera_queue';
  status: SmsMessageStatus;
  proposal?: ParsedSmsTransactionProposal;
  linkedTransactionId?: string;
  thumbnailDataUrl?: string;
  productMeta?: {
    catalogId: string;
    code: string;
    isTemporaryCode: boolean;
    name: string;
    savedPrice?: number;
    serverPrice?: number;
    aiVerifiedPrintedPrice?: boolean;
    visualHash?: string;
  };
}

export interface WatchedSenderRule {
  id: string;
  pattern: string; // Sender name or domain (e.g. "CIB", "InstaPay", "BM", "@nbe.com.eg")
  kind: 'sender' | 'domain';
  createdAt: number;
}

export interface SmsInboxStorageBundle {
  inboxToken: string;
  watchedSenders: WatchedSenderRule[];
  messages: DeviceSmsMessage[];
}

const LOCAL_SMS_KEY = 'mm_sms_inbox_v1';
const IDB_SMS_KEY = 'sms_inbox_v1';

let memorySmsBundle: SmsInboxStorageBundle | null = null;
let idbSmsHydrated = false;

function generateSecretToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return (
    Math.random().toString(16).slice(2).padEnd(16, 'a').slice(0, 16) +
    Date.now().toString(16).padStart(16, '0').slice(0, 16)
  );
}

export function extractDomainFromSenderOrBody(sender: string, body: string): string | undefined {
  const emailMatch = String(sender || '').match(/@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (emailMatch) return emailMatch[1].toLowerCase();
  const urlMatch = String(body || '').match(/https?:\/\/(?:www\.)?([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
  if (urlMatch) return urlMatch[1].toLowerCase();
  return undefined;
}

export function loadSmsInboxSync(): SmsInboxStorageBundle {
  if (memorySmsBundle) return memorySmsBundle;
  try {
    const raw = localStorage.getItem(LOCAL_SMS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        memorySmsBundle = {
          inboxToken:
            typeof parsed.inboxToken === 'string' && parsed.inboxToken.length >= 24
              ? parsed.inboxToken
              : generateSecretToken(),
          watchedSenders: Array.isArray(parsed.watchedSenders) ? parsed.watchedSenders : [],
          messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        };
        return memorySmsBundle;
      }
    }
  } catch {}
  memorySmsBundle = {
    inboxToken: generateSecretToken(),
    watchedSenders: [],
    messages: [],
  };
  saveSmsInbox(memorySmsBundle);
  return memorySmsBundle;
}

export function saveSmsInbox(bundle: SmsInboxStorageBundle): void {
  memorySmsBundle = bundle;
  try {
    localStorage.setItem(LOCAL_SMS_KEY, JSON.stringify(bundle));
  } catch {}
  saveItemToIndexedDB(IDB_SMS_KEY, bundle).catch(() => {});
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('sms_inbox_updated'));
  }
}

export async function hydrateSmsInboxFromIndexedDB(): Promise<SmsInboxStorageBundle> {
  const local = loadSmsInboxSync();
  if (idbSmsHydrated) return local;
  idbSmsHydrated = true;
  try {
    const idb = await getItemFromIndexedDB<SmsInboxStorageBundle>(IDB_SMS_KEY);
    if (idb && Array.isArray(idb.messages)) {
      const byId = new Map<string, DeviceSmsMessage>();
      for (const m of idb.messages) byId.set(m.id, m);
      for (const m of local.messages) byId.set(m.id, m);
      const mergedMessages = Array.from(byId.values()).sort((a, b) => b.receivedAt - a.receivedAt);
      const watchedMap = new Map<string, WatchedSenderRule>();
      for (const w of idb.watchedSenders || []) watchedMap.set(w.pattern.toLowerCase(), w);
      for (const w of local.watchedSenders || []) watchedMap.set(w.pattern.toLowerCase(), w);
      const merged: SmsInboxStorageBundle = {
        inboxToken: local.inboxToken || idb.inboxToken || generateSecretToken(),
        watchedSenders: Array.from(watchedMap.values()),
        messages: mergedMessages,
      };
      memorySmsBundle = merged;
      return merged;
    }
  } catch {}
  return local;
}

export function getSmsWebhookUrl(): string {
  const bundle = loadSmsInboxSync();
  const base = firebaseConfig.databaseURL.replace(/\/+$/, '');
  return `${base}/sms_inbox/${bundle.inboxToken}.json`;
}

export function regenerateSmsWebhookToken(): string {
  const bundle = loadSmsInboxSync();
  bundle.inboxToken = generateSecretToken();
  saveSmsInbox(bundle);
  return getSmsWebhookUrl();
}

export function isMessageMatchingWatchedRules(
  msg: Pick<DeviceSmsMessage, 'sender' | 'domain' | 'body'>,
  rules: WatchedSenderRule[]
): boolean {
  if (!rules || rules.length === 0) return false;
  const senderNorm = String(msg.sender || '').toLowerCase().trim();
  const domainNorm = String(msg.domain || '').toLowerCase().trim();
  for (const r of rules) {
    const pat = r.pattern.toLowerCase().trim().replace(/^@/, '');
    if (!pat) continue;
    if (r.kind === 'domain') {
      if (domainNorm && (domainNorm === pat || domainNorm.endsWith(`.${pat}`))) return true;
      if (senderNorm.includes(pat) || String(msg.body || '').toLowerCase().includes(pat)) return true;
    } else {
      if (senderNorm === pat || senderNorm.includes(pat)) return true;
    }
  }
  return false;
}

/**
 * Fast deterministic OTP & promo pre-filter + offline regex parser for Egyptian & international bank/wallet SMS.
 */
export function parseSmsLocallyHeuristic(
  sender: string,
  body: string
): ParsedSmsTransactionProposal {
  const text = String(body || '').trim();
  const lower = text.toLowerCase();

  // Detect pure OTP / verification code messages
  const hasOtpKeyword =
    /\b(otp|verification code|security code|passcode|pin code|one[- ]time password)\b/i.test(text) ||
    /(كود التحقق|رمز التحقق|الرقم السري المتغير|كلمة السر المتغيرة|رمز التفعيل)/.test(text);
  const hasTxVerb =
    /\b(debited|credited|purchase|paid|payment|transferred|received|withdrawn|withdrawal|deposit|deposited|instapay)\b/i.test(text) ||
    /(تم خصم|خصم مبلغ|شراء بمبلغ|تم تحويل|تم إيداع|تم استلام|سحب نقدي|إنستاباي|انستاباي|فودافون كاش|تحويل لحظي)/.test(text);

  if (hasOtpKeyword && !hasTxVerb) {
    return {
      isFinancialTransaction: false,
      ignoreReason: 'otp',
      type: 'expense',
      amount: 0,
      merchantOrTitle: sender || 'OTP',
    };
  }

  // Detect pure promotional / marketing messages without transaction amounts
  const isPromo =
    (/\b(offer|discount up to|cashback up to|unsubscribe|installment offer|apply now)\b/i.test(lower) ||
      /(عرض خاص|خصومات تصل|قسط الآن|لإلغاء الاشتراك|تطبق الشروط والأحكام)/.test(text)) &&
    !hasTxVerb;
  if (isPromo) {
    return {
      isFinancialTransaction: false,
      ignoreReason: 'promo',
      type: 'expense',
      amount: 0,
      merchantOrTitle: sender || 'Promo',
    };
  }

  // Normalize Arabic-Indic digits
  const normalizedDigits = text.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

  // Extract amount near currency markers (EGP, LE, ج.م, جنيه, USD, SAR, AED, EUR) or fallback to primary decimal number
  const currMatch =
    normalizedDigits.match(
      /(?:EGP|LE|L\.E\.?|USD|SAR|AED|EUR|ج\.م|جنيه|جم)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i
    ) ||
    normalizedDigits.match(
      /([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:EGP|LE|L\.E\.?|USD|SAR|AED|EUR|ج\.م|جنيه|جم)/i
    ) ||
    normalizedDigits.match(/(?:مبلغ|بمبلغ|بقيمة|amount(?:\s+of)?)\s*:?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);

  const amount = currMatch ? Number(currMatch[1].replace(/,/g, '')) : 0;

  // Extract fee if mentioned
  const feeMatch = normalizedDigits.match(
    /(?:fee|fees|commission|رسوم|عمولة)\s*:?\s*(?:EGP|LE|ج\.م)?\s*([0-9]+(?:\.[0-9]{1,2})?)/i
  );
  const feeOrTax = feeMatch ? Number(feeMatch[1]) : undefined;

  let type: TransactionType = 'expense';
  if (
    /\b(credited|received|deposit|deposited|refund|salary)\b/i.test(lower) ||
    /(تم إيداع|تم استلام|وارد|إضافة مبلغ|مرتب|راتب|استرداد)/.test(text)
  ) {
    type = 'income';
  } else if (
    /\b(transfer between|internal transfer)\b/i.test(lower) ||
    /(تحويل بين حساباتك)/.test(text)
  ) {
    type = 'transfer';
  }

  // Merchant extraction ("at <MERCHANT> on", "لدى <MERCHANT>", "من <MERCHANT>")
  const merchMatch =
    normalizedDigits.match(/\b(?:at|to|from)\s+([A-Za-z0-9 &._-]{2,35}?)(?:\s+on\b|\s+for\b|\.|$)/i) ||
    text.match(/(?:لدى|لـ|من)\s+([^\n.,،]{2,35})/);
  const merchantOrTitle = (merchMatch?.[1] || sender || 'رسالة بنكية').trim();

  return {
    isFinancialTransaction: amount > 0 && hasTxVerb,
    ignoreReason: amount <= 0 ? 'informational' : undefined,
    type,
    amount: Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : 0,
    feeOrTax: feeOrTax && Number.isFinite(feeOrTax) && feeOrTax > 0 ? feeOrTax : undefined,
    merchantOrTitle,
    accountHint: sender || undefined,
  };
}

export async function analyzeSmsWithAi(
  msg: Pick<DeviceSmsMessage, 'sender' | 'body'>,
  language: 'ar' | 'en'
): Promise<ParsedSmsTransactionProposal> {
  // Fast deterministic pre-skip for obvious pure OTPs so we save AI latency and never surface OTPs
  const heuristic = parseSmsLocallyHeuristic(msg.sender, msg.body);
  if (heuristic.ignoreReason === 'otp') {
    return heuristic;
  }

  const prompt = `Analyze this bank, wallet (InstaPay, Vodafone Cash, Fawry), card, or service SMS/notification message.
Sender: "${msg.sender}"
Message: """${msg.body}"""

Rules:
1. If this message is an OTP / verification code, promotional ad, marketing offer, balance-inquiry-only, or password alert (NOT an actual money deduction, income, deposit, payment, or transfer), set "isFinancialTransaction": false and set "ignoreReason": "otp" | "promo" | "informational".
2. If it IS a real financial transaction:
   - "type": "expense" (purchase, withdrawal, outgoing payment/InstaPay sent, bill paid), "income" (deposit, salary, incoming transfer/InstaPay received, refund), or "transfer" (explicit transfer between user's own accounts).
   - "amount": principal numeric amount.
   - "feeOrTax": optional transfer fee / bank commission if explicitly stated (else 0).
   - "merchantOrTitle": concise clean ${language === 'ar' ? 'Arabic/brand' : 'English'} description (e.g., merchant name, recipient, or bill name).
   - "categoryHint": best matching category ("Food & Dining", "Shopping", "Transportation", "Bills & Utilities", "Salary", "Health & Medical", "Entertainment", "Bank Fees / Transfer Commissions").
   - "accountHint": sender bank/wallet or card last-4 digits if mentioned.
Return ONLY valid JSON:
{
  "isFinancialTransaction": true,
  "ignoreReason": null,
  "type": "expense",
  "amount": 350.00,
  "feeOrTax": 0,
  "merchantOrTitle": "Carrefour",
  "categoryHint": "Shopping",
  "accountHint": "CIB"
}`;

  const raw = await callGeminiJsonPrompt(prompt);
  const amt = Number(String(raw?.amount ?? 0).replace(/[^0-9.]/g, ''));
  const fee = Number(String(raw?.feeOrTax ?? 0).replace(/[^0-9.]/g, ''));
  const isFin = Boolean(raw?.isFinancialTransaction) && Number.isFinite(amt) && amt > 0;
  return {
    isFinancialTransaction: isFin,
    ignoreReason: !isFin
      ? raw?.ignoreReason === 'otp' || raw?.ignoreReason === 'promo'
        ? raw.ignoreReason
        : 'informational'
      : undefined,
    type: raw?.type === 'income' || raw?.type === 'transfer' ? raw.type : 'expense',
    amount: Number.isFinite(amt) && amt > 0 ? Math.round(amt * 100) / 100 : 0,
    feeOrTax: Number.isFinite(fee) && fee > 0 ? Math.round(fee * 100) / 100 : undefined,
    merchantOrTitle: String(raw?.merchantOrTitle || msg.sender || 'معاملة من رسالة').trim(),
    categoryHint: typeof raw?.categoryHint === 'string' ? raw.categoryHint.trim() : undefined,
    accountHint: typeof raw?.accountHint === 'string' ? raw.accountHint.trim() : msg.sender,
  };
}

export async function ingestSmsMessages(
  incoming: Array<{
    id?: string;
    sender: string;
    body: string;
    receivedAt?: number;
    source: DeviceSmsMessage['source'];
  }>,
  language: 'ar' | 'en' = 'ar'
): Promise<DeviceSmsMessage[]> {
  const bundle = loadSmsInboxSync();
  const existingSignatures = new Set(
    bundle.messages.map(
      (m) => `${m.sender.trim().toLowerCase()}|${m.body.trim()}|${Math.floor(m.receivedAt / 60000)}`
    )
  );

  const newlyAdded: DeviceSmsMessage[] = [];
  for (const raw of incoming) {
    const body = String(raw.body || '').trim();
    if (!body) continue;
    const sender = String(raw.sender || 'Unknown').trim() || 'Unknown';
    const receivedAt =
      typeof raw.receivedAt === 'number' && Number.isFinite(raw.receivedAt) && raw.receivedAt > 0
        ? raw.receivedAt
        : Date.now();
    const sig = `${sender.toLowerCase()}|${body}|${Math.floor(receivedAt / 60000)}`;
    if (existingSignatures.has(sig)) continue;
    existingSignatures.add(sig);

    const domain = extractDomainFromSenderOrBody(sender, body);
    const isWatched = isMessageMatchingWatchedRules({ sender, domain, body }, bundle.watchedSenders);
    const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine;

    const msg: DeviceSmsMessage = {
      id: raw.id || `sms_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      sender,
      domain,
      body,
      receivedAt,
      source: raw.source,
      status: isWatched ? (isOnline ? 'analyzing' : 'queued_offline') : 'unanalyzed',
    };
    newlyAdded.push(msg);
  }

  if (newlyAdded.length === 0) return [];

  bundle.messages = [...newlyAdded, ...bundle.messages]
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, 500);
  saveSmsInbox(bundle);

  // Run AI analysis asynchronously for watched messages when online
  const toAnalyze = newlyAdded.filter((m) => m.status === 'analyzing');
  for (const m of toAnalyze) {
    await processSingleMessageWithAi(m.id, language);
  }

  return newlyAdded;
}

export async function processSingleMessageWithAi(
  msgId: string,
  language: 'ar' | 'en' = 'ar'
): Promise<DeviceSmsMessage | null> {
  const bundle = loadSmsInboxSync();
  const idx = bundle.messages.findIndex((m) => m.id === msgId);
  if (idx === -1) return null;

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    bundle.messages[idx] = { ...bundle.messages[idx], status: 'queued_offline' };
    saveSmsInbox(bundle);
    return bundle.messages[idx];
  }

  bundle.messages[idx] = { ...bundle.messages[idx], status: 'analyzing' };
  saveSmsInbox(bundle);

  try {
    const proposal = await analyzeSmsWithAi(bundle.messages[idx], language);
    const latest = loadSmsInboxSync();
    const latestIdx = latest.messages.findIndex((m) => m.id === msgId);
    if (latestIdx === -1) return null;
    latest.messages[latestIdx] = {
      ...latest.messages[latestIdx],
      proposal,
      status: proposal.isFinancialTransaction ? 'pending_approval' : 'ignored_non_financial',
    };
    saveSmsInbox(latest);
    return latest.messages[latestIdx];
  } catch {
    // Offline / transient network failure -> keep queued_offline until internet returns (or user logs manually!)
    const latest = loadSmsInboxSync();
    const latestIdx = latest.messages.findIndex((m) => m.id === msgId);
    if (latestIdx === -1) return null;
    latest.messages[latestIdx] = {
      ...latest.messages[latestIdx],
      status: 'queued_offline',
    };
    saveSmsInbox(latest);
    return latest.messages[latestIdx];
  }
}

export async function flushOfflineQueuedMessagesAndScans(
  language: 'ar' | 'en' = 'ar',
  currencySymbol: string = '£'
): Promise<void> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  const bundle = loadSmsInboxSync();
  const queued = bundle.messages.filter((m) => m.status === 'queued_offline' && m.source !== 'camera_queue');
  for (const q of queued) {
    await processSingleMessageWithAi(q.id, language);
  }

  // Also process any offline-queued camera scans and inject them as pending proposals in the top floating strip!
  const catBundle = loadProductCatalogSync();
  const camQueued = [...(catBundle.offlineQueue || [])];
  for (const scan of camQueued) {
    if (!scan.imageBase64) {
      removeOfflineCameraScan(scan.id);
      continue;
    }
    try {
      const aiRes = await analyzeItemPhotoWithAi({
        base64: scan.imageBase64,
        mimeType: scan.mimeType || 'image/jpeg',
        knownBarcode: scan.detectedCode,
        language,
        currencySymbol,
      });
      const existingVisual = findLocalProductByVisualOrName(scan.visualHash, aiRes.name);
      const effectiveCode =
        aiRes.detectedCode ||
        scan.detectedCode ||
        existingVisual?.code ||
        allocateNextTemporaryCode();
      const isTemp = effectiveCode.startsWith('TMP-');
      const savedEntry = await persistCatalogProductDecision({
        code: effectiveCode,
        isTemporaryCode: isTemp,
        name: aiRes.name,
        price: aiRes.estimatedPrice || existingVisual?.localPrice || 0,
        categoryHint: aiRes.categoryHint,
        visualHash: scan.visualHash,
        thumbnailDataUrl: scan.thumbnailDataUrl,
        updateSavedPrice: !existingVisual || existingVisual.localPrice <= 0,
        aiVerifiedPrintedPrice: aiRes.printedPriceVisible,
      });
      removeOfflineCameraScan(scan.id);

      const finalPrice =
        existingVisual && existingVisual.localPrice > 0
          ? existingVisual.localPrice
          : aiRes.estimatedPrice;

      injectPendingProposalCard({
        id: `cam_prop_${scan.id}`,
        sender: language === 'ar' ? 'مسح الكاميرا' : 'Camera Scan',
        body: `${aiRes.name} (${effectiveCode})`,
        receivedAt: scan.createdAt,
        source: 'camera_queue',
        status: 'pending_approval',
        thumbnailDataUrl: scan.thumbnailDataUrl,
        proposal: {
          isFinancialTransaction: true,
          type: aiRes.transactionType,
          amount: finalPrice > 0 ? finalPrice : 0,
          merchantOrTitle: aiRes.name,
          categoryHint: aiRes.categoryHint,
        },
        productMeta: {
          catalogId: savedEntry.id,
          code: savedEntry.code,
          isTemporaryCode: savedEntry.isTemporaryCode,
          name: savedEntry.name,
          savedPrice: existingVisual?.localPrice,
          serverPrice: savedEntry.serverPrice,
          aiVerifiedPrintedPrice: aiRes.printedPriceVisible,
          visualHash: scan.visualHash,
        },
      });
    } catch {
      // Keep in queue for next online retry
    }
  }
}

export function addWatchedSenderRule(
  pattern: string,
  kind: 'sender' | 'domain' = 'sender'
): WatchedSenderRule | null {
  const clean = String(pattern || '').trim();
  if (!clean) return null;
  const bundle = loadSmsInboxSync();
  const exists = bundle.watchedSenders.find(
    (w) => w.pattern.toLowerCase() === clean.toLowerCase()
  );
  if (exists) return exists;
  const rule: WatchedSenderRule = {
    id: `watch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pattern: clean,
    kind,
    createdAt: Date.now(),
  };
  bundle.watchedSenders = [rule, ...bundle.watchedSenders];
  saveSmsInbox(bundle);
  return rule;
}

export function removeWatchedSenderRule(ruleId: string): void {
  const bundle = loadSmsInboxSync();
  bundle.watchedSenders = bundle.watchedSenders.filter((r) => r.id !== ruleId);
  saveSmsInbox(bundle);
}

export async function analyzeExistingMessagesForRule(
  rule: WatchedSenderRule,
  messagesInScope: DeviceSmsMessage[],
  language: 'ar' | 'en' = 'ar'
): Promise<number> {
  const targets = messagesInScope.filter(
    (m) =>
      m.status === 'unanalyzed' &&
      isMessageMatchingWatchedRules(m, [rule])
  );
  if (targets.length === 0) return 0;

  const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine;
  const bundle = loadSmsInboxSync();
  const targetIds = new Set(targets.map((t) => t.id));
  bundle.messages = bundle.messages.map((m) =>
    targetIds.has(m.id) ? { ...m, status: isOnline ? 'analyzing' : 'queued_offline' } : m
  );
  saveSmsInbox(bundle);

  if (isOnline) {
    for (const t of targets) {
      await processSingleMessageWithAi(t.id, language);
    }
  }
  return targets.length;
}

export function markSmsMessageAccepted(msgId: string, linkedTransactionId: string): void {
  const bundle = loadSmsInboxSync();
  bundle.messages = bundle.messages.map((m) =>
    m.id === msgId
      ? { ...m, status: 'accepted', linkedTransactionId }
      : m
  );
  saveSmsInbox(bundle);
}

export function markSmsMessageRejected(msgId: string): void {
  const bundle = loadSmsInboxSync();
  bundle.messages = bundle.messages.map((m) =>
    m.id === msgId ? { ...m, status: 'rejected' } : m
  );
  saveSmsInbox(bundle);
}

export function injectPendingProposalCard(card: DeviceSmsMessage): void {
  const bundle = loadSmsInboxSync();
  bundle.messages = [card, ...bundle.messages.filter((m) => m.id !== card.id)].slice(0, 500);
  saveSmsInbox(bundle);
}

/**
 * Parses Android "SMS Backup & Restore" XML, JSON arrays, or multi-block pasted SMS text.
 */
export function parseImportedSmsContent(
  rawText: string,
  defaultSender = 'SMS'
): Array<{ sender: string; body: string; receivedAt: number }> {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return [];

  // 1. XML format (<sms address="CIB" body="..." date="1732000000000" />)
  if (trimmed.startsWith('<') && /<sms\b/i.test(trimmed)) {
    const out: Array<{ sender: string; body: string; receivedAt: number }> = [];
    const tagRegex = /<sms\b([^>]*)\/?>/gi;
    let m: RegExpExecArray | null;
    while ((m = tagRegex.exec(trimmed)) !== null) {
      const attrs = m[1];
      const addr = attrs.match(/\baddress="([^"]*)"/i)?.[1] || defaultSender;
      const body = (attrs.match(/\bbody="([^"]*)"/i)?.[1] || '')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&#10;/g, '\n');
      const dateMs = Number(attrs.match(/\bdate="(\d+)"/i)?.[1] || Date.now());
      if (body.trim()) {
        out.push({ sender: addr.trim() || defaultSender, body: body.trim(), receivedAt: dateMs });
      }
    }
    if (out.length > 0) return out;
  }

  // 2. JSON array or single JSON object
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const out: Array<{ sender: string; body: string; receivedAt: number }> = [];
      for (const item of arr) {
        if (!item) continue;
        const body = String(item.body || item.message || item.text || '').trim();
        if (!body) continue;
        const sender = String(item.sender || item.from || item.address || defaultSender).trim();
        const ts = Number(item.receivedAt || item.timestamp || item.date || Date.now());
        out.push({ sender, body, receivedAt: Number.isFinite(ts) && ts > 0 ? ts : Date.now() });
      }
      if (out.length > 0) return out;
    } catch {}
  }

  // 3. Plain text: split by blank lines if multiple messages pasted, or treat as single message
  const blocks = trimmed
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter(Boolean);

  return blocks.map((block, idx) => {
    // Support optional "Sender: Body" prefix on first line
    const prefixMatch = block.match(/^([A-Za-z0-9@._-]{2,25})\s*:\s*([\s\S]+)$/);
    if (prefixMatch && !/^https?$/i.test(prefixMatch[1])) {
      return {
        sender: prefixMatch[1].trim(),
        body: prefixMatch[2].trim(),
        receivedAt: Date.now() - idx * 1000,
      };
    }
    return {
      sender: defaultSender.trim() || 'SMS',
      body: block,
      receivedAt: Date.now() - idx * 1000,
    };
  });
}

/**
 * Attaches a real-time WebSocket listener to `/sms_inbox/{inboxToken}` so any SMS forwarded
 * via iOS Shortcuts or Android SMS Forwarder arrives instantaneously and drains cleanly.
 */
export function subscribeToSmsWebhookDropbox(language: 'ar' | 'en' = 'ar'): () => void {
  let activeUnsub: (() => void) | null = null;
  let cancelled = false;

  const start = async () => {
    try {
      await ensureFirebaseAuth();
      if (cancelled) return;
      const bundle = loadSmsInboxSync();
      if (!bundle.inboxToken || bundle.inboxToken.length < 24) return;
      const dropboxRef = ref(rtdb, `sms_inbox/${bundle.inboxToken}`);
      activeUnsub = onValue(
        dropboxRef,
        async (snap) => {
          if (!snap.exists()) return;
          const val = snap.val();
          if (!val || typeof val !== 'object') return;
          const entries = Object.entries(val) as Array<[string, any]>;
          const batch: Array<{
            id: string;
            sender: string;
            body: string;
            receivedAt: number;
            source: 'webhook';
          }> = [];
          const keysToDrain: string[] = [];

          for (const [key, item] of entries) {
            if (!item || typeof item !== 'object') continue;
            const body = String(item.body || item.message || item.text || '').trim();
            if (!body) {
              keysToDrain.push(key);
              continue;
            }
            const sender = String(item.sender || item.from || item.address || 'SMS').trim();
            const rawTs = Number(item.receivedAt || item.timestamp || item.date || Date.now());
            const receivedAt =
              Number.isFinite(rawTs) && rawTs > 0
                ? rawTs < 1e11
                  ? rawTs * 1000
                  : rawTs
                : Date.now();
            batch.push({
              id: `wh_${key}`,
              sender,
              body,
              receivedAt,
              source: 'webhook',
            });
            keysToDrain.push(key);
          }

          if (batch.length > 0) {
            await ingestSmsMessages(batch, language);
          }
          for (const k of keysToDrain) {
            remove(ref(rtdb, `sms_inbox/${bundle.inboxToken}/${k}`)).catch(() => {});
          }
        },
        () => {}
      );
    } catch {}
  };

  start();

  return () => {
    cancelled = true;
    if (activeUnsub) activeUnsub();
  };
}
