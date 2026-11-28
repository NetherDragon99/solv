import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  HelpCircle,
  Image as ImageIcon,
  Loader2,
  QrCode,
  RefreshCw,
  ScanLine,
  Sparkles,
  WifiOff,
  X,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { PendingTxPrefillDraft } from '../types';
import {
  allocateNextTemporaryCode,
  analyzeItemPhotoWithAi,
  enqueueOfflineCameraScan,
  findLocalProductByCode,
  findLocalProductByVisualOrName,
  hydrateProductCatalogFromIndexedDB,
  lookupProductFromServerAndGlobal,
  persistCatalogProductDecision,
  processCapturedCanvasOrFile,
  upgradeTemporaryCodeToRealCode,
} from '../utils/cameraCatalog';

interface DetectedCodeBox {
  rawValue: string;
  format: string;
  box?: { x: number; y: number; width: number; height: number }; // Normalized 0..1 relative to video element
}

interface CameraTransactionScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenPrefilledTransaction: (draft: PendingTxPrefillDraft) => void;
}

export const CameraTransactionScannerModal: React.FC<CameraTransactionScannerModalProps> = ({
  isOpen,
  onClose,
  onOpenPrefilledTransaction,
}) => {
  const { settings, categories, showToast, t } = useApp();
  const isArabic = settings.language === 'ar';
  const currencySymbol = settings.currencySymbol || '£';

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const rafTimerRef = useRef<number | null>(null);
  const detectorRef = useRef<any>(null);

  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState<boolean>(false);
  const [detectedCode, setDetectedCode] = useState<DetectedCodeBox | null>(null);
  const [manualCodeInput, setManualCodeInput] = useState<string>('');
  const [showManualCodeBox, setShowManualCodeBox] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [processingLabel, setProcessingLabel] = useState<string>('');
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [offlineCapturePendingChoice, setOfflineCapturePendingChoice] = useState<{
    mode: 'photo' | 'barcode';
    detectedCode?: string;
    base64: string;
    mimeType: string;
    thumbnailDataUrl: string;
    visualHash: string;
  } | null>(null);

  const matchCategoryId = useCallback(
    (hint?: string, existingCatId?: string): string | undefined => {
      if (existingCatId && categories.some((c) => c.id === existingCatId)) {
        return existingCatId;
      }
      if (!hint) return undefined;
      const h = hint.toLowerCase();
      const expCats = categories.filter((c) => c.type === 'expense');
      const direct = expCats.find(
        (c) =>
          c.name.toLowerCase().includes(h) ||
          h.includes(c.name.toLowerCase()) ||
          (h.includes('food') && (c.name.toLowerCase().includes('food') || c.name.includes('طعام') || c.name.includes('أكل') || c.name.includes('مطاعم'))) ||
          (h.includes('transport') && (c.name.toLowerCase().includes('transport') || c.name.includes('مواصلات') || c.name.includes('نقل'))) ||
          (h.includes('shop') && (c.name.toLowerCase().includes('shop') || c.name.includes('تسوق') || c.name.includes('مشتريات'))) ||
          (h.includes('bill') && (c.name.toLowerCase().includes('bill') || c.name.includes('فواتير'))) ||
          (h.includes('health') && (c.name.toLowerCase().includes('health') || c.name.includes('صحة') || c.name.includes('علاج')))
      );
      return direct?.id;
    },
    [categories]
  );

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    hydrateProductCatalogFromIndexedDB().catch(() => {});
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showGuide) setShowGuide(false);
        else if (offlineCapturePendingChoice) setOfflineCapturePendingChoice(null);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, showGuide, offlineCapturePendingChoice, onClose]);

  const stopCamera = useCallback(() => {
    if (rafTimerRef.current) {
      window.clearTimeout(rafTimerRef.current);
      rafTimerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      stopCamera();
      setDetectedCode(null);
      setOfflineCapturePendingChoice(null);
      setIsProcessing(false);
      return;
    }

    let cancelled = false;
    setCameraError(null);

    // Initialize native BarcodeDetector when available in browser/WebView
    if (typeof window !== 'undefined' && 'BarcodeDetector' in window && !detectorRef.current) {
      try {
        const BD = (window as any).BarcodeDetector;
        detectorRef.current = new BD({
          formats: [
            'qr_code',
            'ean_13',
            'ean_8',
            'upc_a',
            'upc_e',
            'code_128',
            'code_39',
            'itf',
            'codabar',
            'data_matrix',
            'pdf417',
          ],
        });
      } catch {
        try {
          const BD = (window as any).BarcodeDetector;
          detectorRef.current = new BD();
        } catch {}
      }
    }

    const startStream = async () => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setCameraError(t('camErrUnsupported'));
        return;
      }
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: facingMode },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        if (cancelled) {
          media.getTracks().forEach((tr) => tr.stop());
          return;
        }
        streamRef.current = media;
        if (videoRef.current) {
          videoRef.current.srcObject = media;
          await videoRef.current.play().catch(() => {});
        }

        // Start throttled live barcode/QR scan loop (~5 scans/sec)
        const scanTick = async () => {
          if (cancelled || !isOpen) return;
          const vid = videoRef.current;
          if (vid && detectorRef.current && vid.readyState >= 2 && vid.videoWidth > 0) {
            try {
              const results = await detectorRef.current.detect(vid);
              if (Array.isArray(results) && results.length > 0) {
                const top = results[0];
                const raw = String(top?.rawValue || '').trim();
                if (raw) {
                  const bb = top.boundingBox;
                  const vw = vid.videoWidth || 1;
                  const vh = vid.videoHeight || 1;
                  setDetectedCode({
                    rawValue: raw,
                    format: String(top.format || 'code'),
                    box: bb
                      ? {
                          x: Math.max(0, Math.min(0.92, bb.x / vw)),
                          y: Math.max(0, Math.min(0.92, bb.y / vh)),
                          width: Math.max(0.08, Math.min(1, bb.width / vw)),
                          height: Math.max(0.08, Math.min(1, bb.height / vh)),
                        }
                      : undefined,
                  });
                }
              }
            } catch {}
          }
          rafTimerRef.current = window.setTimeout(scanTick, 220);
        };
        scanTick();
      } catch {
        if (!cancelled) {
          setCameraError(t('camErrPermission'));
        }
      }
    };

    startStream();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [isOpen, facingMode, stopCamera, t]);

  // Handler 1: User taps "Use Code" for a detected Barcode / QR (or manual code)
  const handleUseDetectedCode = async (rawCodeToUse: string) => {
    const cleanCode = String(rawCodeToUse || '').trim();
    if (!cleanCode || isProcessing) return;

    setIsProcessing(true);
    setProcessingLabel(t('camCheckingCodeMsg'));

    try {
      // 1. Check permanent local storage first (works 100% offline!)
      const localHit = findLocalProductByCode(cleanCode);

      // 2. If online, check server for updates or global lookup
      let resolvedEntry = localHit;
      if (isOnline) {
        const serverHit = await lookupProductFromServerAndGlobal(cleanCode);
        if (serverHit) {
          resolvedEntry = serverHit;
        }
      }

      if (resolvedEntry && resolvedEntry.name) {
        const effectiveSavedPrice =
          resolvedEntry.localPrice > 0
            ? resolvedEntry.localPrice
            : resolvedEntry.serverPrice && resolvedEntry.serverPrice > 0
            ? resolvedEntry.serverPrice
            : 0;

        stopCamera();
        onClose();
        onOpenPrefilledTransaction({
          source: 'camera',
          type: 'expense',
          amount: effectiveSavedPrice > 0 ? effectiveSavedPrice : undefined,
          description: resolvedEntry.name,
          categoryId: matchCategoryId(resolvedEntry.categoryHint, resolvedEntry.categoryId),
          categoryHint: resolvedEntry.categoryHint,
          productItem: {
            catalogId: resolvedEntry.id,
            code: resolvedEntry.code,
            isTemporaryCode: resolvedEntry.isTemporaryCode,
            name: resolvedEntry.name,
            savedPrice: effectiveSavedPrice > 0 ? effectiveSavedPrice : undefined,
            serverPrice: resolvedEntry.serverPrice,
            visualHash: resolvedEntry.visualHash,
            thumbnailDataUrl: resolvedEntry.thumbnailDataUrl,
            isNewItem: false,
          },
        });
        return;
      }

      // 3. Brand-new unknown barcode/QR! Grab live camera frame if available
      let captured: {
        base64: string;
        mimeType: string;
        thumbnailDataUrl: string;
        visualHash: string;
      } | null = null;
      if (videoRef.current && videoRef.current.videoWidth > 0) {
        captured = await processCapturedCanvasOrFile(videoRef.current);
      }

      if (!isOnline) {
        if (captured) {
          setOfflineCapturePendingChoice({
            mode: 'barcode',
            detectedCode: cleanCode,
            ...captured,
          });
          setIsProcessing(false);
          return;
        }
        // Offline without video frame: open TransactionModal directly with code attached
        stopCamera();
        onClose();
        onOpenPrefilledTransaction({
          source: 'camera',
          type: 'expense',
          description: '',
          productItem: {
            catalogId: `prod_${Date.now()}`,
            code: cleanCode,
            isTemporaryCode: false,
            name: cleanCode,
            isNewItem: true,
          },
        });
        return;
      }

      // Online unknown barcode/QR -> analyze live frame + code with AI!
      if (captured) {
        setProcessingLabel(t('camAnalyzingAiMsg'));
        const aiRes = await analyzeItemPhotoWithAi({
          base64: captured.base64,
          mimeType: captured.mimeType,
          knownBarcode: cleanCode,
          language: settings.language,
          currencySymbol,
        });

        // Upgrade any matching temporary code (TMP-*) with this real barcode!
        const tempCandidate = findLocalProductByVisualOrName(captured.visualHash, aiRes.name);
        if (tempCandidate && tempCandidate.isTemporaryCode) {
          await upgradeTemporaryCodeToRealCode(tempCandidate.code, cleanCode, {
            name: aiRes.name,
            categoryHint: aiRes.categoryHint,
            localPrice: aiRes.estimatedPrice || tempCandidate.localPrice,
            visualHash: captured.visualHash,
            thumbnailDataUrl: captured.thumbnailDataUrl,
          });
        }

        const saved = await persistCatalogProductDecision({
          code: cleanCode,
          isTemporaryCode: false,
          name: aiRes.name,
          price: aiRes.estimatedPrice || 0,
          categoryHint: aiRes.categoryHint,
          visualHash: captured.visualHash,
          thumbnailDataUrl: captured.thumbnailDataUrl,
          updateSavedPrice: true,
          aiVerifiedPrintedPrice: aiRes.printedPriceVisible,
        });

        stopCamera();
        onClose();
        onOpenPrefilledTransaction({
          source: 'camera',
          type: aiRes.transactionType,
          amount: aiRes.estimatedPrice > 0 ? aiRes.estimatedPrice : undefined,
          description: aiRes.name,
          categoryId: matchCategoryId(aiRes.categoryHint),
          categoryHint: aiRes.categoryHint,
          productItem: {
            catalogId: saved.id,
            code: cleanCode,
            isTemporaryCode: false,
            name: aiRes.name,
            savedPrice: tempCandidate?.localPrice || undefined,
            serverPrice: saved.serverPrice,
            aiSuggestedPrice: aiRes.estimatedPrice,
            aiVerifiedPrintedPrice: aiRes.printedPriceVisible,
            visualHash: captured.visualHash,
            thumbnailDataUrl: captured.thumbnailDataUrl,
            isNewItem: !tempCandidate,
          },
        });
        return;
      }

      // Fallback when no camera frame (e.g. typed code manually)
      stopCamera();
      onClose();
      onOpenPrefilledTransaction({
        source: 'camera',
        type: 'expense',
        description: cleanCode,
        productItem: {
          catalogId: `prod_${Date.now()}`,
          code: cleanCode,
          isTemporaryCode: false,
          name: cleanCode,
          isNewItem: true,
        },
      });
    } catch {
      showToast(t('camScanFailedToast'), 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  // Handler 2: User captures a real photo (Product / Ticket / Device / Anything) or picks from gallery
  const handleCapturePhotoSource = async (source: HTMLVideoElement | File) => {
    if (isProcessing) return;
    setIsProcessing(true);
    setProcessingLabel(t('camAnalyzingAiMsg'));

    try {
      const processed = await processCapturedCanvasOrFile(source);

      // Also check if BarcodeDetector spots a barcode inside an uploaded/captured image
      let embeddedBarcode: string | undefined = detectedCode?.rawValue;
      if (!embeddedBarcode && detectorRef.current && source instanceof File) {
        try {
          const bmp = await createImageBitmap(source);
          const codes = await detectorRef.current.detect(bmp);
          if (Array.isArray(codes) && codes[0]?.rawValue) {
            embeddedBarcode = String(codes[0].rawValue).trim();
          }
        } catch {}
      }

      // Fast local visual match check (works even offline if photographed before!)
      const visualHit = findLocalProductByVisualOrName(processed.visualHash);
      if (!isOnline) {
        if (visualHit) {
          stopCamera();
          onClose();
          onOpenPrefilledTransaction({
            source: 'camera',
            type: 'expense',
            amount: visualHit.localPrice > 0 ? visualHit.localPrice : undefined,
            description: visualHit.name,
            categoryId: matchCategoryId(visualHit.categoryHint, visualHit.categoryId),
            productItem: {
              catalogId: visualHit.id,
              code: visualHit.code,
              isTemporaryCode: visualHit.isTemporaryCode,
              name: visualHit.name,
              savedPrice: visualHit.localPrice > 0 ? visualHit.localPrice : undefined,
              serverPrice: visualHit.serverPrice,
              visualHash: visualHit.visualHash,
              thumbnailDataUrl: visualHit.thumbnailDataUrl,
              isNewItem: false,
            },
          });
          return;
        }
        // Offline & unseen photo -> give user explicit choice: Queue until online OR Enter manually now!
        setOfflineCapturePendingChoice({
          mode: 'photo',
          detectedCode: embeddedBarcode,
          ...processed,
        });
        setIsProcessing(false);
        return;
      }

      // Online: Analyze photo with Gemini AI
      const aiRes = await analyzeItemPhotoWithAi({
        base64: processed.base64,
        mimeType: processed.mimeType,
        knownBarcode: embeddedBarcode,
        language: settings.language,
        currencySymbol,
      });

      const existingMatch =
        (aiRes.detectedCode ? findLocalProductByCode(aiRes.detectedCode) : null) ||
        findLocalProductByVisualOrName(processed.visualHash, aiRes.name);

      let finalCode =
        aiRes.detectedCode ||
        embeddedBarcode ||
        existingMatch?.code ||
        allocateNextTemporaryCode();
      let isTemp = finalCode.startsWith('TMP-');

      // If AI spotted a real barcode on an item that previously had a TMP-* code, upgrade it!
      if (!isTemp && existingMatch && existingMatch.isTemporaryCode && existingMatch.code !== finalCode) {
        await upgradeTemporaryCodeToRealCode(existingMatch.code, finalCode, {
          name: aiRes.name,
          categoryHint: aiRes.categoryHint,
          localPrice: existingMatch.localPrice || aiRes.estimatedPrice,
          visualHash: processed.visualHash,
          thumbnailDataUrl: processed.thumbnailDataUrl,
        });
      }

      const prevSavedPrice =
        existingMatch && existingMatch.localPrice > 0
          ? existingMatch.localPrice
          : existingMatch?.serverPrice && existingMatch.serverPrice > 0
          ? existingMatch.serverPrice
          : undefined;

      const saved = await persistCatalogProductDecision({
        code: finalCode,
        isTemporaryCode: isTemp,
        name: aiRes.name,
        price: prevSavedPrice ?? aiRes.estimatedPrice ?? 0,
        categoryHint: aiRes.categoryHint,
        visualHash: processed.visualHash,
        thumbnailDataUrl: processed.thumbnailDataUrl,
        updateSavedPrice: !prevSavedPrice,
        aiVerifiedPrintedPrice: aiRes.printedPriceVisible,
      });

      const prefillAmount =
        aiRes.printedPriceVisible && aiRes.estimatedPrice > 0
          ? aiRes.estimatedPrice
          : prevSavedPrice ?? (aiRes.estimatedPrice > 0 ? aiRes.estimatedPrice : undefined);

      stopCamera();
      onClose();
      onOpenPrefilledTransaction({
        source: 'camera',
        type: aiRes.transactionType,
        amount: prefillAmount,
        description: aiRes.name,
        categoryId: matchCategoryId(aiRes.categoryHint, existingMatch?.categoryId),
        categoryHint: aiRes.categoryHint,
        productItem: {
          catalogId: saved.id,
          code: saved.code,
          isTemporaryCode: saved.isTemporaryCode,
          name: aiRes.name,
          savedPrice: prevSavedPrice,
          serverPrice: saved.serverPrice,
          aiSuggestedPrice: aiRes.estimatedPrice,
          aiVerifiedPrintedPrice: aiRes.printedPriceVisible,
          visualHash: processed.visualHash,
          thumbnailDataUrl: processed.thumbnailDataUrl,
          isNewItem: !existingMatch,
        },
      });
    } catch {
      showToast(t('camScanFailedToast'), 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      dir={isArabic ? 'rtl' : 'ltr'}
      className="fixed inset-0 z-[300] bg-[var(--bg-primary)] text-[var(--text-primary)] flex flex-col overflow-hidden"
    >
      {/* Top Camera Header */}
      <header
        style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}
        className="px-4 pb-3 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)] flex items-center justify-between gap-2 z-20 shrink-0"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-[var(--accent-soft)] text-[var(--accent-primary)] flex items-center justify-center shrink-0">
            <ScanLine className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm sm:text-base font-extrabold truncate">
              {t('camModalTitle')}
            </h2>
            <p className="text-[11px] text-[var(--text-secondary)] truncate">
              {isOnline ? t('camSubtitleOnline') : t('camSubtitleOffline')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setShowGuide((v) => !v)}
            aria-label={t('camHowItWorksBtn')}
            className={`min-h-[44px] px-3 rounded-xl border text-xs font-bold flex items-center gap-1.5 transition cursor-pointer active:scale-[0.97] ${
              showGuide
                ? 'bg-[var(--accent-primary)] border-[var(--accent-primary)] text-[var(--text-on-accent)]'
                : 'bg-[var(--bg-tertiary)] border-[var(--border-subtle)] text-[var(--text-primary)]'
            }`}
          >
            <HelpCircle className="w-4 h-4 shrink-0" />
            <span>{t('camHowItWorksBtn')}</span>
          </button>

          <button
            type="button"
            onClick={() => setFacingMode((m) => (m === 'environment' ? 'user' : 'environment'))}
            aria-label={t('camFlipBtn')}
            className="min-w-[44px] min-h-[44px] rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--text-primary)] cursor-pointer active:scale-[0.97]"
          >
            <RefreshCw className="w-4 h-4" />
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

      {/* Collapsible Built-in Feature Explanation Panel inside Camera */}
      {showGuide && (
        <div className="px-4 py-3.5 bg-[var(--bg-secondary)] border-b border-[var(--border-strong)] space-y-2 text-xs leading-relaxed z-20 shrink-0">
          <div className="font-extrabold text-[var(--accent-primary)] flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 shrink-0" />
            <span>{t('camGuideTitle')}</span>
          </div>
          <ul className="space-y-1.5 text-[var(--text-secondary)] list-disc ps-4">
            <li>{t('camGuidePointPhoto')}</li>
            <li>{t('camGuidePointCode')}</li>
            <li>{t('camGuidePointPrice')}</li>
            <li>{t('camGuidePointOffline')}</li>
          </ul>
        </div>
      )}

      {/* Main Live Camera Viewfinder */}
      <div className="relative flex-1 min-h-0 bg-black flex items-center justify-center overflow-hidden">
        {cameraError ? (
          <div className="max-w-sm mx-4 p-5 rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-center space-y-3">
            <Camera className="w-10 h-10 mx-auto text-[var(--status-warning)]" />
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{cameraError}</p>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full min-h-[44px] px-4 rounded-xl bg-[var(--accent-primary)] text-white text-xs font-bold flex items-center justify-center gap-2 cursor-pointer active:scale-[0.97]"
            >
              <ImageIcon className="w-4 h-4" />
              <span>{t('camPickGalleryBtn')}</span>
            </button>
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="w-full h-full object-cover"
            />

            {/* Framing Guide Reticle */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
              <div className="w-64 h-64 sm:w-72 sm:h-72 rounded-3xl border-2 border-white/35 relative">
                <span className="absolute -top-0.5 -start-0.5 w-6 h-6 border-t-4 border-s-4 border-[var(--accent-primary)] rounded-ss-2xl" />
                <span className="absolute -top-0.5 -end-0.5 w-6 h-6 border-t-4 border-e-4 border-[var(--accent-primary)] rounded-se-2xl" />
                <span className="absolute -bottom-0.5 -start-0.5 w-6 h-6 border-b-4 border-s-4 border-[var(--accent-primary)] rounded-es-2xl" />
                <span className="absolute -bottom-0.5 -end-0.5 w-6 h-6 border-b-4 border-e-4 border-[var(--accent-primary)] rounded-ee-2xl" />
              </div>
            </div>

            {/* Live Highlight Marker on Detected QR / Barcode */}
            {detectedCode?.box && (
              <div
                style={{
                  transform: `translate3d(0, 0, 0)`,
                  insetInlineStart: `${detectedCode.box.x * 100}%`,
                  top: `${detectedCode.box.y * 100}%`,
                  width: `${detectedCode.box.width * 100}%`,
                  height: `${detectedCode.box.height * 100}%`,
                }}
                className="pointer-events-none absolute border-2 border-[var(--status-success)] bg-[var(--status-success)]/15 rounded-xl flex items-start justify-start p-1"
              >
                <span className="px-1.5 py-0.5 rounded-md bg-[var(--status-success)] text-black text-[10px] font-mono font-extrabold truncate max-w-full">
                  {detectedCode.rawValue}
                </span>
              </div>
            )}

            {/* Offline Status Pill inside Camera */}
            {!isOnline && (
              <div className="absolute top-3 inset-x-4 flex justify-center pointer-events-none">
                <div className="px-3 py-1.5 rounded-full bg-[var(--bg-secondary)] border border-[var(--status-warning)] text-[var(--status-warning)] text-[11px] font-bold flex items-center gap-1.5 shadow-lg">
                  <WifiOff className="w-3.5 h-3.5 shrink-0" />
                  <span>{t('camOfflineBadge')}</span>
                </div>
              </div>
            )}

            {/* Floating "Use Code" Action Card when Barcode or QR is Spotted */}
            {detectedCode && !isProcessing && (
              <div className="absolute bottom-4 inset-x-4 flex justify-center z-10">
                <div className="w-full max-w-md p-3 rounded-2xl bg-[var(--bg-secondary)] border-2 border-[var(--status-success)] shadow-2xl flex items-center justify-between gap-2.5">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-10 h-10 rounded-xl bg-[var(--accent-soft)] text-[var(--status-success)] flex items-center justify-center shrink-0">
                      <QrCode className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-[11px] font-bold text-[var(--status-success)]">
                        {t('camCodeDetectedLabel')}
                      </div>
                      <div dir="ltr" className="text-xs font-mono font-bold text-[var(--text-primary)] truncate">
                        {detectedCode.rawValue}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleUseDetectedCode(detectedCode.rawValue)}
                      className="min-h-[44px] px-3.5 rounded-xl bg-[var(--status-success)] text-black text-xs font-extrabold cursor-pointer active:scale-[0.97]"
                    >
                      {t('camUseCodeBtn')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDetectedCode(null)}
                      aria-label={t('cancel')}
                      className="min-w-[38px] min-h-[44px] rounded-xl bg-[var(--bg-tertiary)] text-[var(--text-secondary)] flex items-center justify-center cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Processing Overlay */}
            {isProcessing && (
              <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-3 p-6 text-center z-20">
                <Loader2 className="w-10 h-10 text-[var(--accent-primary)] animate-spin" />
                <div className="text-sm font-bold text-white">{processingLabel}</div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Manual Code Entry Bar (Optional fallback for browsers without BarcodeDetector or damaged print) */}
      {showManualCodeBox && (
        <div className="px-4 py-2.5 bg-[var(--bg-secondary)] border-t border-[var(--border-subtle)] flex items-center gap-2 shrink-0">
          <input
            type="text"
            dir="ltr"
            value={manualCodeInput}
            onChange={(e) => setManualCodeInput(e.target.value)}
            placeholder={t('camManualCodePlaceholder')}
            className="flex-1 min-h-[44px] px-3.5 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-base text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent-primary)]"
          />
          <button
            type="button"
            disabled={!manualCodeInput.trim() || isProcessing}
            onClick={() => handleUseDetectedCode(manualCodeInput.trim())}
            className="min-h-[44px] px-4 rounded-xl bg-[var(--accent-primary)] text-white text-xs font-extrabold disabled:opacity-45 cursor-pointer active:scale-[0.97]"
          >
            {t('camUseCodeBtn')}
          </button>
        </div>
      )}

      {/* Bottom Camera Shutter & Controls Bar */}
      <div
        style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}
        className="px-5 pt-3 bg-[var(--bg-secondary)] border-t border-[var(--border-subtle)] flex items-center justify-between gap-4 shrink-0 z-20"
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) handleCapturePhotoSource(f);
          }}
        />

        {/* Gallery Picker */}
        <button
          type="button"
          disabled={isProcessing}
          onClick={() => fileInputRef.current?.click()}
          className="min-w-[52px] min-h-[48px] px-3 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex flex-col items-center justify-center gap-0.5 text-[var(--text-primary)] text-[10px] font-bold cursor-pointer active:scale-[0.97] disabled:opacity-45"
        >
          <ImageIcon className="w-5 h-5" />
          <span>{t('camGalleryShort')}</span>
        </button>

        {/* Primary Photo Capture Shutter Button */}
        <button
          type="button"
          disabled={isProcessing || Boolean(cameraError)}
          onClick={() => {
            if (videoRef.current && videoRef.current.videoWidth > 0) {
              handleCapturePhotoSource(videoRef.current);
            }
          }}
          aria-label={t('camCapturePhotoBtn')}
          className="w-18 h-18 min-w-[68px] min-h-[68px] rounded-full p-1.5 border-4 border-[var(--accent-primary)] bg-[var(--bg-primary)] flex items-center justify-center cursor-pointer active:scale-[0.95] disabled:opacity-45 transition-transform"
        >
          <span className="w-full h-full rounded-full bg-[var(--accent-primary)] flex items-center justify-center text-white">
            <Camera className="w-7 h-7" />
          </span>
        </button>

        {/* Toggle Manual Barcode / QR Input */}
        <button
          type="button"
          disabled={isProcessing}
          onClick={() => setShowManualCodeBox((v) => !v)}
          className={`min-w-[52px] min-h-[48px] px-3 rounded-2xl border flex flex-col items-center justify-center gap-0.5 text-[10px] font-bold cursor-pointer active:scale-[0.97] disabled:opacity-45 ${
            showManualCodeBox
              ? 'bg-[var(--accent-soft)] border-[var(--accent-primary)] text-[var(--accent-primary)]'
              : 'bg-[var(--bg-tertiary)] border-[var(--border-subtle)] text-[var(--text-primary)]'
          }`}
        >
          <QrCode className="w-5 h-5" />
          <span>{t('camTypeCodeShort')}</span>
        </button>
      </div>

      {/* Offline Capture Choice Sheet: Queue for Online AI vs Enter Manually Right Now */}
      {offlineCapturePendingChoice && (
        <div
          className="fixed inset-0 z-[320] bg-black/75 flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setOfflineCapturePendingChoice(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full sm:max-w-md rounded-t-[22px] sm:rounded-[22px] bg-[var(--bg-secondary)] border border-[var(--border-strong)] p-5 space-y-4 shadow-2xl"
            style={{ paddingBottom: 'max(20px, env(safe-area-inset-bottom))' }}
          >
            <div className="flex items-center gap-3">
              <img
                src={offlineCapturePendingChoice.thumbnailDataUrl}
                alt=""
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                }}
                className="w-14 h-14 rounded-2xl object-cover border border-[var(--border-subtle)] shrink-0"
              />
              <div className="min-w-0">
                <h3 className="text-sm font-extrabold text-[var(--text-primary)]">
                  {t('camOfflineChoiceTitle')}
                </h3>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5 leading-relaxed">
                  {t('camOfflineChoiceDesc')}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <button
                type="button"
                onClick={() => {
                  enqueueOfflineCameraScan({
                    mode: offlineCapturePendingChoice.mode,
                    detectedCode: offlineCapturePendingChoice.detectedCode,
                    imageBase64: offlineCapturePendingChoice.base64,
                    mimeType: offlineCapturePendingChoice.mimeType,
                    thumbnailDataUrl: offlineCapturePendingChoice.thumbnailDataUrl,
                    visualHash: offlineCapturePendingChoice.visualHash,
                  });
                  setOfflineCapturePendingChoice(null);
                  stopCamera();
                  onClose();
                  showToast(t('camQueuedOfflineToast'), 'info');
                }}
                className="w-full min-h-[46px] px-4 rounded-xl bg-[var(--accent-primary)] text-white text-xs font-extrabold cursor-pointer active:scale-[0.97]"
              >
                {t('camQueueUntilOnlineBtn')}
              </button>

              <button
                type="button"
                onClick={() => {
                  const code =
                    offlineCapturePendingChoice.detectedCode || allocateNextTemporaryCode();
                  const isTemp = code.startsWith('TMP-');
                  const thumb = offlineCapturePendingChoice.thumbnailDataUrl;
                  const vHash = offlineCapturePendingChoice.visualHash;
                  setOfflineCapturePendingChoice(null);
                  stopCamera();
                  onClose();
                  onOpenPrefilledTransaction({
                    source: 'camera',
                    type: 'expense',
                    description: '',
                    productItem: {
                      catalogId: `prod_${Date.now()}`,
                      code,
                      isTemporaryCode: isTemp,
                      name: '',
                      visualHash: vHash,
                      thumbnailDataUrl: thumb,
                      isNewItem: true,
                    },
                  });
                }}
                className="w-full min-h-[46px] px-4 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[var(--text-primary)] text-xs font-bold cursor-pointer active:scale-[0.97]"
              >
                {t('camEnterManuallyNowBtn')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
