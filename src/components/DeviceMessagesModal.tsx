import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  ClipboardPaste,
  Copy,
  Eye,
  FileUp,
  Link2,
  Loader2,
  MessageSquareText,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import {
  addWatchedSenderRule,
  analyzeExistingMessagesForRule,
  DeviceSmsMessage,
  flushOfflineQueuedMessagesAndScans,
  getSmsWebhookUrl,
  ingestSmsMessages,
  isMessageMatchingWatchedRules,
  loadSmsInboxSync,
  markSmsMessageRejected,
  parseImportedSmsContent,
  parseSmsLocallyHeuristic,
  processSingleMessageWithAi,
  regenerateSmsWebhookToken,
  removeWatchedSenderRule,
  saveSmsInbox,
  WatchedSenderRule,
} from '../utils/smsInboxStore';
import { formatCurrency } from '../utils/dateCycle';

type PeriodDaysOption = 7 | 30 | 90 | 0; // 0 = All

interface DeviceMessagesModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAcceptProposalToModal: (msg: DeviceSmsMessage) => void;
  onCreateManualFromMessage: (msg: DeviceSmsMessage) => void;
}

export const DeviceMessagesModal: React.FC<DeviceMessagesModalProps> = ({
  isOpen,
  onClose,
  onAcceptProposalToModal,
  onCreateManualFromMessage,
}) => {
  const { settings, showToast, showConfirm, t } = useApp();
  const isArabic = settings.language === 'ar';
  const currencySymbol = settings.currencySymbol || '£';

  const [activeTab, setActiveTab] = useState<'approved' | 'device'>('approved');
  const [periodDays, setPeriodDays] = useState<PeriodDaysOption>(30);
  const [customFromDate, setCustomFromDate] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [bundleVersion, setBundleVersion] = useState<number>(0);

  // Paste / Import & Webhook Setup Drawer
  const [showAddMessagesSheet, setShowAddMessagesSheet] = useState<boolean>(false);
  const [showWebhookSetup, setShowWebhookSetup] = useState<boolean>(false);
  const [pasteSender, setPasteSender] = useState<string>('');
  const [pasteBody, setPasteBody] = useState<string>('');
  const [newWatchInput, setNewWatchInput] = useState<string>('');
  const [copiedWebhook, setCopiedWebhook] = useState<boolean>(false);
  const [recentlyAddedRule, setRecentlyAddedRule] = useState<WatchedSenderRule | null>(null);
  const [isBatchAnalyzing, setIsBatchAnalyzing] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const refresh = () => setBundleVersion((v) => v + 1);
    window.addEventListener('sms_inbox_updated', refresh);
    return () => window.removeEventListener('sms_inbox_updated', refresh);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showAddMessagesSheet) setShowAddMessagesSheet(false);
        else if (showWebhookSetup) setShowWebhookSetup(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, showAddMessagesSheet, showWebhookSetup, onClose]);

  const bundle = useMemo(() => {
    void bundleVersion;
    return loadSmsInboxSync();
  }, [bundleVersion]);

  const webhookUrl = useMemo(() => {
    void bundleVersion;
    return getSmsWebhookUrl();
  }, [bundleVersion]);

  const filteredDeviceMessages = useMemo(() => {
    const now = Date.now();
    let minTs = 0;
    if (customFromDate) {
      const parsed = new Date(`${customFromDate}T00:00:00`).getTime();
      if (Number.isFinite(parsed)) minTs = parsed;
    } else if (periodDays > 0) {
      minTs = now - periodDays * 24 * 60 * 60 * 1000;
    }

    const q = searchQuery.trim().toLowerCase();
    return bundle.messages.filter((m) => {
      if (m.source === 'camera_queue') return false;
      if (minTs > 0 && m.receivedAt < minTs) return false;
      if (q) {
        const hay = `${m.sender} ${m.domain || ''} ${m.body}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [bundle.messages, periodDays, customFromDate, searchQuery]);

  const approvedMessages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return bundle.messages.filter((m) => {
      const isWatched =
        m.source === 'camera_queue' ||
        m.status !== 'unanalyzed' ||
        isMessageMatchingWatchedRules(m, bundle.watchedSenders);
      if (!isWatched) return false;
      if (q) {
        const hay = `${m.sender} ${m.domain || ''} ${m.body} ${m.proposal?.merchantOrTitle || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [bundle.messages, bundle.watchedSenders, searchQuery]);

  const pendingCount = useMemo(
    () =>
      bundle.messages.filter(
        (m) => m.status === 'pending_approval' || m.status === 'queued_offline'
      ).length,
    [bundle.messages]
  );

  if (!isOpen) return null;

  const handleCopyWebhook = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopiedWebhook(true);
      setTimeout(() => setCopiedWebhook(false), 1500);
    } catch {
      showToast(t('billLiveCopyFailedToast'), 'error');
    }
  };

  const handleWatchSenderOrDomain = (pattern: string, kind: 'sender' | 'domain' = 'sender') => {
    const rule = addWatchedSenderRule(pattern, kind);
    if (rule) {
      setRecentlyAddedRule(rule);
      showToast(t('smsSenderWatchedToast'), 'success');
    }
  };

  const handlePasteSubmit = async () => {
    const parsed = parseImportedSmsContent(pasteBody, pasteSender.trim() || 'SMS');
    if (parsed.length === 0) return;
    await ingestSmsMessages(
      parsed.map((p) => ({ ...p, source: 'paste' as const })),
      settings.language
    );
    setPasteBody('');
    setPasteSender('');
    setShowAddMessagesSheet(false);
    showToast(t('smsImportedSuccessToast'), 'success');
  };

  const handleImportFile = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = parseImportedSmsContent(text, 'SMS');
      if (parsed.length === 0) {
        showToast(t('smsImportEmptyToast'), 'error');
        return;
      }
      await ingestSmsMessages(
        parsed.map((p) => ({ ...p, source: 'import' as const })),
        settings.language
      );
      setShowAddMessagesSheet(false);
      setActiveTab('device');
      showToast(t('smsImportedSuccessToast'), 'success');
    } catch {
      showToast(t('smsImportEmptyToast'), 'error');
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      dir={isArabic ? 'rtl' : 'ltr'}
      className="fixed inset-0 z-[300] bg-[var(--bg-primary)] text-[var(--text-primary)] flex flex-col overflow-hidden"
    >
      {/* Top Header */}
      <header
        style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}
        className="px-4 pb-3 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)] flex items-center justify-between gap-2 shrink-0"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-[var(--accent-soft)] text-[var(--accent-primary)] flex items-center justify-center shrink-0">
            <MessageSquareText className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-extrabold truncate">{t('smsInboxTitle')}</h2>
            <p className="text-[11px] text-[var(--text-secondary)] truncate">
              {t('smsInboxSubtitle')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => {
              setShowWebhookSetup((v) => !v);
              setShowAddMessagesSheet(false);
            }}
            className={`min-h-[44px] px-3 rounded-xl border text-xs font-bold flex items-center gap-1.5 cursor-pointer active:scale-[0.97] ${
              showWebhookSetup
                ? 'bg-[var(--accent-primary)] border-[var(--accent-primary)] text-white'
                : 'bg-[var(--bg-tertiary)] border-[var(--border-subtle)] text-[var(--text-primary)]'
            }`}
          >
            <Link2 className="w-4 h-4 shrink-0" />
            <span className="hidden sm:inline">{t('smsWebhookBtn')}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setShowAddMessagesSheet((v) => !v);
              setShowWebhookSetup(false);
            }}
            className="min-h-[44px] px-3 rounded-xl bg-[var(--accent-primary)] text-white text-xs font-extrabold flex items-center gap-1.5 cursor-pointer active:scale-[0.97]"
          >
            <Plus className="w-4 h-4 shrink-0" />
            <span>{t('smsAddOrImportBtn')}</span>
          </button>

          <button
            type="button"
            onClick={onClose}
            aria-label={t('cancel')}
            className="min-w-[44px] min-h-[44px] rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--text-primary)] cursor-pointer active:scale-[0.97]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Optional Webhook Auto-Forwarding Setup Card */}
      {showWebhookSetup && (
        <div className="px-4 py-3.5 bg-[var(--bg-secondary)] border-b border-[var(--border-strong)] space-y-2.5 shrink-0">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-extrabold text-[var(--accent-primary)]">
              {t('smsWebhookCardTitle')}
            </div>
            <button
              type="button"
              onClick={async () => {
                const ok = await showConfirm({
                  title: t('smsRegenerateWebhookBtn'),
                  message: t('smsRegenerateWebhookConfirm'),
                  isDanger: true,
                });
                if (ok) {
                  regenerateSmsWebhookToken();
                  showToast(t('billLiveRegeneratedToast'), 'success');
                }
              }}
              className="text-[11px] font-bold text-[var(--text-secondary)] hover:text-[var(--status-danger)] flex items-center gap-1 cursor-pointer"
            >
              <RefreshCw className="w-3 h-3" />
              <span>{t('smsRegenerateWebhookBtn')}</span>
            </button>
          </div>
          <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
            {t('smsWebhookCardDesc')}
          </p>
          <div className="flex items-center gap-2">
            <div
              dir="ltr"
              className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[11px] font-mono truncate text-[var(--text-primary)]"
            >
              {webhookUrl}
            </div>
            <button
              type="button"
              onClick={handleCopyWebhook}
              className="min-h-[40px] px-3.5 rounded-xl bg-[var(--accent-primary)] text-white text-xs font-bold flex items-center gap-1.5 shrink-0 cursor-pointer active:scale-[0.97]"
            >
              {copiedWebhook ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              <span>{copiedWebhook ? t('billCopiedBtn') : t('billCopyLinkBtn')}</span>
            </button>
          </div>
          <div
            dir="ltr"
            className="px-3 py-2 rounded-xl bg-[var(--bg-tertiary)] text-[10px] font-mono text-[var(--text-secondary)] overflow-x-auto"
          >
            {'POST JSON: { "sender": "CIB", "body": "تم خصم 250 ج.م..." }'}
          </div>
        </div>
      )}

      {/* Optional Paste / Import Messages Drawer */}
      {showAddMessagesSheet && (
        <div className="px-4 py-3.5 bg-[var(--bg-secondary)] border-b border-[var(--border-strong)] space-y-2.5 shrink-0">
          <div className="flex items-center justify-between">
            <span className="text-xs font-extrabold text-[var(--text-primary)]">
              {t('smsPasteOrImportTitle')}
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xml,.json,.txt"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) handleImportFile(f);
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="min-h-[38px] px-3 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-xs font-bold text-[var(--accent-primary)] flex items-center gap-1.5 cursor-pointer active:scale-[0.97]"
            >
              <FileUp className="w-3.5 h-3.5" />
              <span>{t('smsImportFileBtn')}</span>
            </button>
          </div>

          <input
            type="text"
            dir="auto"
            value={pasteSender}
            onChange={(e) => setPasteSender(e.target.value)}
            placeholder={t('smsSenderPlaceholder')}
            className="w-full min-h-[44px] px-3.5 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-base text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent-primary)]"
          />
          <textarea
            rows={3}
            dir="auto"
            value={pasteBody}
            onChange={(e) => setPasteBody(e.target.value)}
            placeholder={t('smsBodyPlaceholder')}
            className="w-full p-3 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-base text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent-primary)] resize-none"
          />
          <button
            type="button"
            disabled={!pasteBody.trim()}
            onClick={handlePasteSubmit}
            className="w-full min-h-[44px] rounded-xl bg-[var(--accent-primary)] text-white text-xs font-extrabold flex items-center justify-center gap-1.5 disabled:opacity-45 cursor-pointer active:scale-[0.97]"
          >
            <ClipboardPaste className="w-4 h-4" />
            <span>{t('smsSavePastedBtn')}</span>
          </button>
        </div>
      )}

      {/* 2-Tab Segmented Control: Tab 1 (Approved) | Tab 2 (Device Messages - Last 30d / Filter) */}
      <div className="px-4 pt-3 pb-2 bg-[var(--bg-primary)] space-y-2.5 shrink-0">
        <div className="grid grid-cols-2 p-1 rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] gap-1">
          <button
            type="button"
            onClick={() => setActiveTab('approved')}
            className={`min-h-[42px] px-3 rounded-xl text-xs font-extrabold flex items-center justify-center gap-1.5 transition cursor-pointer ${
              activeTab === 'approved'
                ? 'bg-[var(--accent-primary)] text-white'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <span>{t('smsTabApproved')}</span>
            {pendingCount > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-[var(--status-warning)] text-black text-[10px] font-mono font-black">
                {pendingCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('device')}
            className={`min-h-[42px] px-3 rounded-xl text-xs font-extrabold flex items-center justify-center gap-1.5 transition cursor-pointer ${
              activeTab === 'device'
                ? 'bg-[var(--accent-primary)] text-white'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <span>{t('smsTabDeviceAll')}</span>
            <span className="text-[10px] font-mono opacity-80">({filteredDeviceMessages.length})</span>
          </button>
        </div>

        {/* Search + Period Filter Row */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="w-4 h-4 text-[var(--text-tertiary)] absolute inset-inline-start-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              dir="auto"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('smsSearchPlaceholder')}
              className="w-full min-h-[42px] ps-9 pe-8 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-base text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent-primary)]"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute inset-inline-end-2 top-1/2 -translate-y-1/2 p-1 text-[var(--text-tertiary)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {activeTab === 'device' && (
            <div className="flex items-center gap-1 overflow-x-auto">
              {([7, 30, 90, 0] as PeriodDaysOption[]).map((d) => {
                const active = !customFromDate && periodDays === d;
                const label =
                  d === 0
                    ? t('allTime')
                    : d === 7
                    ? t('smsFilter7d')
                    : d === 30
                    ? t('smsFilter30d')
                    : t('smsFilter90d');
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => {
                      setCustomFromDate('');
                      setPeriodDays(d);
                    }}
                    className={`min-h-[38px] px-2.5 rounded-xl border text-[11px] font-bold shrink-0 cursor-pointer ${
                      active
                        ? 'bg-[var(--accent-soft)] border-[var(--accent-primary)] text-[var(--accent-primary)]'
                        : 'bg-[var(--bg-secondary)] border-[var(--border-subtle)] text-[var(--text-secondary)]'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
              <input
                type="date"
                value={customFromDate}
                onChange={(e) => setCustomFromDate(e.target.value)}
                aria-label={t('customRange')}
                className="min-h-[38px] px-2.5 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-xs text-[var(--text-primary)]"
              />
            </div>
          )}
        </div>

        {/* Optional Banner After Watching a Sender: "Analyze past messages from this sender too?" */}
        {recentlyAddedRule && (
          <div className="p-3 rounded-2xl bg-[var(--accent-soft)] border border-[var(--accent-primary)] flex items-center justify-between gap-2 flex-wrap">
            <span className="text-xs font-bold text-[var(--text-primary)]">
              {t('smsAnalyzePastPrompt').replace('{sender}', recentlyAddedRule.pattern)}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={isBatchAnalyzing}
                onClick={async () => {
                  const rule = recentlyAddedRule;
                  setIsBatchAnalyzing(true);
                  await analyzeExistingMessagesForRule(
                    rule,
                    filteredDeviceMessages,
                    settings.language
                  );
                  setIsBatchAnalyzing(false);
                  setRecentlyAddedRule(null);
                  setActiveTab('approved');
                }}
                className="min-h-[36px] px-3 rounded-xl bg-[var(--accent-primary)] text-white text-xs font-extrabold flex items-center gap-1.5 cursor-pointer"
              >
                {isBatchAnalyzing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>{t('smsAnalyzePastConfirmBtn')}</span>
              </button>
              <button
                type="button"
                onClick={() => setRecentlyAddedRule(null)}
                className="min-h-[36px] px-2.5 rounded-xl bg-[var(--bg-secondary)] text-xs font-bold text-[var(--text-secondary)] cursor-pointer"
              >
                {t('laterBtn')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Main Scrollable List */}
      <div
        style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}
        className="flex-1 overflow-y-auto overscroll-contain px-4 py-2 space-y-3"
      >
        {/* Watched Senders & Domains Bar */}
        <div className="p-3 rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-[var(--text-secondary)]">
              {t('smsWatchedSendersTitle')} ({bundle.watchedSenders.length})
            </span>
            <button
              type="button"
              onClick={() => flushOfflineQueuedMessagesAndScans(settings.language, currencySymbol)}
              className="text-[11px] font-bold text-[var(--accent-primary)] flex items-center gap-1 cursor-pointer"
            >
              <RefreshCw className="w-3 h-3" />
              <span>{t('smsProcessOfflineQueueBtn')}</span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              dir="auto"
              value={newWatchInput}
              onChange={(e) => setNewWatchInput(e.target.value)}
              placeholder={t('smsAddWatchPlaceholder')}
              className="flex-1 min-h-[40px] px-3 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-base text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent-primary)]"
            />
            <button
              type="button"
              disabled={!newWatchInput.trim()}
              onClick={() => {
                const raw = newWatchInput.trim();
                const isDomain = raw.includes('.') || raw.startsWith('@');
                handleWatchSenderOrDomain(raw, isDomain ? 'domain' : 'sender');
                setNewWatchInput('');
              }}
              className="min-h-[40px] px-3.5 rounded-xl bg-[var(--accent-primary)] text-white text-xs font-extrabold disabled:opacity-45 cursor-pointer active:scale-[0.97]"
            >
              {t('billAddGuestBtn')}
            </button>
          </div>

          {bundle.watchedSenders.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {bundle.watchedSenders.map((rule) => (
                <span
                  key={rule.id}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--accent-soft)] border border-[var(--accent-primary)]/40 text-xs font-bold text-[var(--accent-primary)]"
                >
                  <span dir="auto">{rule.pattern}</span>
                  <button
                    type="button"
                    onClick={() => removeWatchedSenderRule(rule.id)}
                    aria-label={t('billDeleteBtn')}
                    className="hover:text-[var(--status-danger)] cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Messages List for Active Tab */}
        {(activeTab === 'approved' ? approvedMessages : filteredDeviceMessages).length === 0 ? (
          <div className="p-8 rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-center space-y-3">
            <MessageSquareText className="w-10 h-10 mx-auto text-[var(--text-tertiary)]" />
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              {activeTab === 'approved' ? t('smsEmptyApprovedDesc') : t('smsEmptyDeviceDesc')}
            </p>
          </div>
        ) : (
          (activeTab === 'approved' ? approvedMessages : filteredDeviceMessages).map((msg) => {
            const isWatched = isMessageMatchingWatchedRules(msg, bundle.watchedSenders);
            const p = msg.proposal;

            return (
              <div
                key={msg.id}
                style={{ contain: 'layout style' }}
                className="p-3.5 rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] space-y-2.5"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      dir="auto"
                      className="px-2.5 py-0.5 rounded-lg bg-[var(--bg-tertiary)] text-xs font-extrabold text-[var(--text-primary)] truncate max-w-[160px]"
                    >
                      {msg.sender}
                    </span>
                    {msg.domain && (
                      <span
                        dir="ltr"
                        className="text-[11px] font-mono text-[var(--text-secondary)] truncate"
                      >
                        @{msg.domain}
                      </span>
                    )}
                    <span className="text-[10px] font-mono tabular-nums text-[var(--text-tertiary)]">
                      {new Date(msg.receivedAt).toLocaleDateString(isArabic ? 'ar-EG' : 'en-US', {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                  </div>

                  {/* Status Pill */}
                  <div className="flex items-center gap-1.5">
                    {msg.status === 'queued_offline' && (
                      <span className="px-2 py-0.5 rounded-full bg-[var(--status-warning)]/15 text-[var(--status-warning)] text-[10px] font-bold flex items-center gap-1">
                        <WifiOff className="w-3 h-3" />
                        <span>{t('smsStatusQueuedOffline')}</span>
                      </span>
                    )}
                    {msg.status === 'analyzing' && (
                      <span className="px-2 py-0.5 rounded-full bg-[var(--accent-soft)] text-[var(--accent-primary)] text-[10px] font-bold flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        <span>{t('smsStatusAnalyzing')}</span>
                      </span>
                    )}
                    {msg.status === 'pending_approval' && (
                      <span className="px-2 py-0.5 rounded-full bg-[var(--accent-soft)] text-[var(--accent-primary)] text-[10px] font-bold">
                        {t('smsStatusPendingApproval')}
                      </span>
                    )}
                    {msg.status === 'accepted' && (
                      <span className="px-2 py-0.5 rounded-full bg-[var(--status-success)]/15 text-[var(--status-success)] text-[10px] font-bold flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" />
                        <span>{t('smsStatusAccepted')}</span>
                      </span>
                    )}
                    {msg.status === 'rejected' && (
                      <span className="px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] text-[10px] font-bold">
                        {t('smsStatusRejected')}
                      </span>
                    )}
                    {msg.status === 'ignored_non_financial' && (
                      <span className="px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] text-[10px] font-bold">
                        {t('smsStatusIgnoredOtp')}
                      </span>
                    )}
                  </div>
                </div>

                {/* Raw SMS Body */}
                <p
                  dir="auto"
                  className="text-xs text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap break-words"
                >
                  {msg.body}
                </p>

                {/* AI Extracted Summary Card if Available */}
                {p && p.isFinancialTransaction && (
                  <div className="p-2.5 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div
                        dir="auto"
                        className="text-xs font-extrabold text-[var(--text-primary)] truncate"
                      >
                        {p.merchantOrTitle}
                      </div>
                      {p.categoryHint && (
                        <div className="text-[10px] text-[var(--text-secondary)]">
                          {p.categoryHint}
                        </div>
                      )}
                    </div>
                    <div className="text-end shrink-0 font-mono tabular-nums">
                      <div className="text-sm font-black text-[var(--text-primary)]">
                        {formatCurrency(p.amount, currencySymbol, settings.language)}
                      </div>
                      {p.feeOrTax && p.feeOrTax > 0 ? (
                        <div className="text-[10px] text-[var(--status-warning)]">
                          +{formatCurrency(p.feeOrTax, currencySymbol, settings.language)}
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}

                {/* Action Row */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {!isWatched && msg.source !== 'camera_queue' && (
                      <button
                        type="button"
                        onClick={() => handleWatchSenderOrDomain(msg.sender, 'sender')}
                        className="min-h-[36px] px-3 rounded-xl bg-[var(--accent-soft)] text-[var(--accent-primary)] text-xs font-bold flex items-center gap-1.5 cursor-pointer active:scale-[0.97]"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>{t('smsWatchSenderBtn')}</span>
                      </button>
                    )}

                    {msg.domain &&
                      !bundle.watchedSenders.some(
                        (w) => w.pattern.toLowerCase() === msg.domain!.toLowerCase()
                      ) && (
                        <button
                          type="button"
                          onClick={() => handleWatchSenderOrDomain(msg.domain!, 'domain')}
                          className="min-h-[36px] px-3 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[var(--text-primary)] text-xs font-bold cursor-pointer active:scale-[0.97]"
                        >
                          {t('smsWatchDomainBtn')} (@{msg.domain})
                        </button>
                      )}

                    {msg.status === 'unanalyzed' && (
                      <button
                        type="button"
                        onClick={() => processSingleMessageWithAi(msg.id, settings.language)}
                        className="min-h-[36px] px-3 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[var(--text-primary)] text-xs font-bold flex items-center gap-1.5 cursor-pointer active:scale-[0.97]"
                      >
                        <Sparkles className="w-3.5 h-3.5 text-[var(--accent-primary)]" />
                        <span>{t('smsAnalyzeWithAiBtn')}</span>
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5">
                    {msg.status === 'pending_approval' ? (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            onClose();
                            onAcceptProposalToModal(msg);
                          }}
                          className="min-h-[36px] px-3.5 rounded-xl bg-[var(--status-success)] text-black text-xs font-extrabold flex items-center gap-1 cursor-pointer active:scale-[0.97]"
                        >
                          <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                          <span>{t('billApproveBtn')}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => markSmsMessageRejected(msg.id)}
                          className="min-h-[36px] px-3 rounded-xl bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--status-danger)] text-xs font-bold cursor-pointer active:scale-[0.97]"
                        >
                          {t('billRejectBtn')}
                        </button>
                      </>
                    ) : (
                      msg.status !== 'accepted' && (
                        <button
                          type="button"
                          onClick={() => {
                            // Works 100% offline using local heuristic prefill if AI hasn't analyzed yet!
                            const enriched: DeviceSmsMessage = msg.proposal
                              ? msg
                              : {
                                  ...msg,
                                  proposal: parseSmsLocallyHeuristic(msg.sender, msg.body),
                                };
                            onClose();
                            onCreateManualFromMessage(enriched);
                          }}
                          className="min-h-[36px] px-3 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-strong)] text-[var(--text-primary)] text-xs font-bold flex items-center gap-1 cursor-pointer active:scale-[0.97]"
                        >
                          <Plus className="w-3.5 h-3.5 text-[var(--accent-primary)]" />
                          <span>{t('smsCreateTxDirectlyBtn')}</span>
                        </button>
                      )
                    )}

                    <button
                      type="button"
                      onClick={() => {
                        const b = loadSmsInboxSync();
                        b.messages = b.messages.filter((x) => x.id !== msg.id);
                        saveSmsInbox(b);
                      }}
                      aria-label={t('billDeleteBtn')}
                      className="min-w-[36px] min-h-[36px] rounded-xl bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--status-danger)] flex items-center justify-center cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
