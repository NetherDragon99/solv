import React, { useMemo } from 'react';
import { ArrowDown, ArrowLeftRight, ArrowUp, Check, Sparkles, X } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { DeviceSmsMessage, markSmsMessageRejected } from '../utils/smsInboxStore';
import { formatCurrency } from '../utils/dateCycle';

interface FloatingPendingTransactionsBarProps {
  pendingItems: DeviceSmsMessage[];
  onAcceptItem: (msg: DeviceSmsMessage) => void;
  onOpenInbox: () => void;
}

export const FloatingPendingTransactionsBar: React.FC<FloatingPendingTransactionsBarProps> = ({
  pendingItems,
  onAcceptItem,
  onOpenInbox,
}) => {
  const { settings, t } = useApp();
  const isArabic = settings.language === 'ar';
  const currencySymbol = settings.currencySymbol || '£';

  const visibleItems = useMemo(
    () => pendingItems.filter((m) => m.status === 'pending_approval' && m.proposal?.isFinancialTransaction),
    [pendingItems]
  );

  if (visibleItems.length === 0) return null;

  return (
    <div
      dir={isArabic ? 'rtl' : 'ltr'}
      style={{ top: 'max(64px, calc(env(safe-area-inset-top) + 56px))' }}
      className="fixed inset-x-0 z-[100] pointer-events-none px-3 sm:px-5"
    >
      <div className="max-w-3xl mx-auto pointer-events-auto rounded-2xl bg-[var(--bg-secondary)]/92 backdrop-blur-md border border-[var(--border-strong)] shadow-2xl p-2.5 space-y-2">
        {/* Compact Header Strip */}
        <div className="flex items-center justify-between px-1.5">
          <button
            type="button"
            onClick={onOpenInbox}
            className="flex items-center gap-1.5 text-xs font-extrabold text-[var(--accent-primary)] cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5 shrink-0" />
            <span>
              {t('smsFloatingPendingTitle')} ({visibleItems.length})
            </span>
          </button>
          <span className="text-[10px] text-[var(--text-secondary)]">
            {t('smsFloatingSwipeHint')}
          </span>
        </div>

        {/* Horizontal Snap-Scrollable Cards Row */}
        <div className="flex items-stretch gap-2.5 overflow-x-auto snap-x snap-mandatory pb-0.5 overscroll-contain">
          {visibleItems.map((msg) => {
            const p = msg.proposal!;
            const isIncome = p.type === 'income';
            const isTransfer = p.type === 'transfer';

            return (
              <div
                key={msg.id}
                style={{ contain: 'layout style' }}
                className="snap-start shrink-0 w-[285px] sm:w-[320px] rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] p-2.5 flex flex-col justify-between gap-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {msg.thumbnailDataUrl ? (
                      <img
                        src={msg.thumbnailDataUrl}
                        alt=""
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display = 'none';
                        }}
                        className="w-9 h-9 rounded-lg object-cover shrink-0 border border-[var(--border-subtle)]"
                      />
                    ) : (
                      <div
                        className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                          isIncome
                            ? 'bg-[var(--status-success)]/15 text-[var(--status-success)]'
                            : isTransfer
                            ? 'bg-[var(--accent-soft)] text-[var(--accent-primary)]'
                            : 'bg-[var(--status-danger)]/15 text-[var(--status-danger)]'
                        }`}
                      >
                        {isIncome ? (
                          <ArrowDown className="w-4 h-4" />
                        ) : isTransfer ? (
                          <ArrowLeftRight className="w-4 h-4" />
                        ) : (
                          <ArrowUp className="w-4 h-4" />
                        )}
                      </div>
                    )}

                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span
                          dir="auto"
                          className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-[var(--bg-secondary)] text-[var(--text-secondary)] truncate max-w-[110px]"
                        >
                          {msg.sender}
                        </span>
                      </div>
                      <div
                        dir="auto"
                        className="text-xs font-extrabold text-[var(--text-primary)] truncate mt-0.5"
                      >
                        {p.merchantOrTitle}
                      </div>
                    </div>
                  </div>

                  <div className="text-end shrink-0">
                    <div
                      className={`text-sm font-mono font-black tabular-nums ${
                        isIncome
                          ? 'text-[var(--status-success)]'
                          : isTransfer
                          ? 'text-[var(--accent-primary)]'
                          : 'text-[var(--status-danger)]'
                      }`}
                    >
                      {isIncome ? '+' : isTransfer ? '' : '-'}
                      {formatCurrency(p.amount, currencySymbol, settings.language)}
                    </div>
                    {p.feeOrTax && p.feeOrTax > 0 ? (
                      <div className="text-[10px] font-mono tabular-nums text-[var(--status-warning)]">
                        +{formatCurrency(p.feeOrTax, currencySymbol, settings.language)}
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-0.5">
                  <button
                    type="button"
                    onClick={() => onAcceptItem(msg)}
                    className="flex-1 min-h-[38px] px-3 rounded-xl bg-[var(--status-success)] text-black text-xs font-extrabold flex items-center justify-center gap-1 cursor-pointer active:scale-[0.97]"
                  >
                    <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                    <span>{t('billApproveBtn')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => markSmsMessageRejected(msg.id)}
                    className="min-h-[38px] px-3 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--status-danger)] text-xs font-bold flex items-center justify-center gap-1 cursor-pointer active:scale-[0.97]"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>{t('billRejectBtn')}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
