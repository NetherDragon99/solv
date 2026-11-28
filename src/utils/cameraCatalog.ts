import { get, ref, set } from 'firebase/database';
import { getItemFromIndexedDB, saveItemToIndexedDB } from './indexedDB';
import { auth, ensureFirebaseAuth, rtdb } from './firebase';
import { extractJsonFromModelText } from './billSplitOcr';

export interface ProductPriceVote {
  price: number;
  count: number;
  lastRequestedAt: number;
}

export interface CatalogProductEntry {
  id: string;
  code: string; // Real barcode / QR string or sequential TMP-XXXXXX
  isTemporaryCode: boolean;
  name: string;
  brand?: string;
  itemKind?: 'product' | 'ticket' | 'device' | 'bill' | 'other';
  categoryHint?: string;
  categoryId?: string;
  /** User's effective local price (updated immediately when user picks "Update Data") */
  localPrice: number;
  /** Latest globally verified / 3-vote consensus server price */
  serverPrice?: number;
  currency?: string;
  visualHash?: string; // 16-hex 64-bit dHash for fast repeat photo recognition
  thumbnailDataUrl?: string; // Tiny compressed ~96x96 JPEG data URL
  usageCount: number;
  createdAt: number;
  updatedAt: number;
  pendingServerSync?: boolean;
  replacedTempCodes?: string[];
}

export interface OfflinePendingCameraScan {
  id: string;
  createdAt: number;
  mode: 'photo' | 'barcode';
  detectedCode?: string;
  imageBase64?: string;
  mimeType?: string;
  thumbnailDataUrl?: string;
  visualHash?: string;
  status: 'queued_offline' | 'processing' | 'failed';
}

export interface ProductCatalogBundle {
  itemsByCode: Record<string, CatalogProductEntry>;
  tempRedirects: Record<string, string>; // TMP-XXXXXX -> realCode
  nextTempSeq: number;
  offlineQueue: OfflinePendingCameraScan[];
}

const LOCAL_CATALOG_KEY = 'mm_product_catalog_v1';
const IDB_CATALOG_KEY = 'product_catalog_v1';

const DEFAULT_SCAN_MODELS = [
  'gemini-3-flash-preview',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
  'gemini-flash-latest',
];

let memoryBundle: ProductCatalogBundle | null = null;
let idbHydrated = false;

function emptyBundle(): ProductCatalogBundle {
  return {
    itemsByCode: {},
    tempRedirects: {},
    nextTempSeq: 1,
    offlineQueue: [],
  };
}

export function sanitizeCatalogKey(rawCode: string): string {
  return String(rawCode || '')
    .trim()
    .replace(/[.#$/[\]\s]+/g, '_')
    .slice(0, 120);
}

function normalizeNameForMatch(name: string): string {
  return String(name || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function loadProductCatalogSync(): ProductCatalogBundle {
  if (memoryBundle) return memoryBundle;
  try {
    const raw = localStorage.getItem(LOCAL_CATALOG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        memoryBundle = {
          itemsByCode: parsed.itemsByCode || {},
          tempRedirects: parsed.tempRedirects || {},
          nextTempSeq: typeof parsed.nextTempSeq === 'number' && parsed.nextTempSeq >= 1 ? parsed.nextTempSeq : 1,
          offlineQueue: Array.isArray(parsed.offlineQueue) ? parsed.offlineQueue : [],
        };
        return memoryBundle;
      }
    }
  } catch {}
  memoryBundle = emptyBundle();
  return memoryBundle;
}

export function saveProductCatalog(bundle: ProductCatalogBundle): void {
  memoryBundle = bundle;
  try {
    localStorage.setItem(LOCAL_CATALOG_KEY, JSON.stringify(bundle));
  } catch {
    // If localStorage quota is tight, strip thumbnails in localStorage while keeping full bundle in IndexedDB
    try {
      const slimItems: Record<string, CatalogProductEntry> = {};
      for (const [k, v] of Object.entries(bundle.itemsByCode)) {
        slimItems[k] = { ...v, thumbnailDataUrl: undefined };
      }
      localStorage.setItem(
        LOCAL_CATALOG_KEY,
        JSON.stringify({
          ...bundle,
          itemsByCode: slimItems,
          offlineQueue: bundle.offlineQueue.map((q) => ({ ...q, imageBase64: undefined })),
        })
      );
    } catch {}
  }
  saveItemToIndexedDB(IDB_CATALOG_KEY, bundle).catch(() => {});
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('product_catalog_updated'));
  }
}

export async function hydrateProductCatalogFromIndexedDB(): Promise<ProductCatalogBundle> {
  const local = loadProductCatalogSync();
  if (idbHydrated) return local;
  idbHydrated = true;
  try {
    const idb = await getItemFromIndexedDB<ProductCatalogBundle>(IDB_CATALOG_KEY);
    if (idb && idb.itemsByCode) {
      const mergedItems: Record<string, CatalogProductEntry> = { ...idb.itemsByCode };
      for (const [k, v] of Object.entries(local.itemsByCode)) {
        const prev = mergedItems[k];
        if (!prev || (v.updatedAt || 0) >= (prev.updatedAt || 0)) {
          mergedItems[k] = {
            ...prev,
            ...v,
            thumbnailDataUrl: v.thumbnailDataUrl || prev?.thumbnailDataUrl,
          };
        }
      }
      const merged: ProductCatalogBundle = {
        itemsByCode: mergedItems,
        tempRedirects: { ...(idb.tempRedirects || {}), ...(local.tempRedirects || {}) },
        nextTempSeq: Math.max(idb.nextTempSeq || 1, local.nextTempSeq || 1),
        offlineQueue:
          (idb.offlineQueue?.length || 0) >= (local.offlineQueue?.length || 0)
            ? idb.offlineQueue || []
            : local.offlineQueue || [],
      };
      memoryBundle = merged;
      return merged;
    }
  } catch {}
  return local;
}

export function allocateNextTemporaryCode(): string {
  const bundle = loadProductCatalogSync();
  let seq = bundle.nextTempSeq || 1;
  let candidate = `TMP-${String(seq).padStart(6, '0')}`;
  while (bundle.itemsByCode[candidate] || bundle.tempRedirects[candidate]) {
    seq += 1;
    candidate = `TMP-${String(seq).padStart(6, '0')}`;
  }
  bundle.nextTempSeq = seq + 1;
  saveProductCatalog(bundle);
  return candidate;
}

/**
 * Computes a 64-bit difference perceptual hash (16 hex chars) + tiny 96x96 thumbnail
 * and a 1280px compressed image for AI recognition.
 */
export async function processCapturedCanvasOrFile(
  source: HTMLCanvasElement | HTMLVideoElement | File
): Promise<{
  base64: string;
  mimeType: string;
  thumbnailDataUrl: string;
  visualHash: string;
}> {
  let drawSource: CanvasImageSource;
  let srcW = 640;
  let srcH = 480;

  if (typeof File !== 'undefined' && source instanceof File) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(new Error('Failed to read image'));
      r.readAsDataURL(source);
    });
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('Invalid image'));
      im.src = dataUrl;
    });
    drawSource = img;
    srcW = img.naturalWidth || img.width || 640;
    srcH = img.naturalHeight || img.height || 480;
  } else if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    drawSource = source;
    srcW = source.videoWidth || 640;
    srcH = source.videoHeight || 480;
  } else {
    const c = source as HTMLCanvasElement;
    drawSource = c;
    srcW = c.width || 640;
    srcH = c.height || 480;
  }

  // 1. Main AI image (max 1280px)
  const maxDim = 1280;
  let w = srcW;
  let h = srcH;
  if (w > maxDim || h > maxDim) {
    if (w >= h) {
      h = Math.round((h * maxDim) / w);
      w = maxDim;
    } else {
      w = Math.round((w * maxDim) / h);
      h = maxDim;
    }
  }
  const mainCanvas = document.createElement('canvas');
  mainCanvas.width = Math.max(1, w);
  mainCanvas.height = Math.max(1, h);
  const mCtx = mainCanvas.getContext('2d');
  mCtx?.drawImage(drawSource, 0, 0, mainCanvas.width, mainCanvas.height);
  const fullDataUrl = mainCanvas.toDataURL('image/jpeg', 0.82);
  const base64 = fullDataUrl.split(',')[1] || '';

  // 2. Tiny 96x96 thumbnail (center-cropped square)
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = 96;
  thumbCanvas.height = 96;
  const tCtx = thumbCanvas.getContext('2d');
  const minSide = Math.min(srcW, srcH);
  const sx = Math.max(0, Math.floor((srcW - minSide) / 2));
  const sy = Math.max(0, Math.floor((srcH - minSide) / 2));
  tCtx?.drawImage(drawSource, sx, sy, minSide, minSide, 0, 0, 96, 96);
  const thumbnailDataUrl = thumbCanvas.toDataURL('image/jpeg', 0.65);

  // 3. 9x8 grayscale dHash -> 64 bits -> 16 hex chars
  const hashCanvas = document.createElement('canvas');
  hashCanvas.width = 9;
  hashCanvas.height = 8;
  const hCtx = hashCanvas.getContext('2d');
  let visualHash = '';
  if (hCtx) {
    hCtx.drawImage(drawSource, sx, sy, minSide, minSide, 0, 0, 9, 8);
    const pixels = hCtx.getImageData(0, 0, 9, 8).data;
    let bits = '';
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const i1 = (row * 9 + col) * 4;
        const i2 = (row * 9 + col + 1) * 4;
        const lum1 = pixels[i1] * 0.299 + pixels[i1 + 1] * 0.587 + pixels[i1 + 2] * 0.114;
        const lum2 = pixels[i2] * 0.299 + pixels[i2 + 1] * 0.587 + pixels[i2 + 2] * 0.114;
        bits += lum1 < lum2 ? '1' : '0';
      }
    }
    for (let i = 0; i < 64; i += 4) {
      visualHash += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
  }

  return {
    base64,
    mimeType: 'image/jpeg',
    thumbnailDataUrl,
    visualHash,
  };
}

export function computeVisualHashDistance(h1?: string, h2?: string): number {
  if (!h1 || !h2 || h1.length !== 16 || h2.length !== 16) return 64;
  let dist = 0;
  for (let i = 0; i < 16; i++) {
    let xor = (parseInt(h1[i], 16) ^ parseInt(h2[i], 16)) & 0xf;
    while (xor > 0) {
      dist += xor & 1;
      xor >>= 1;
    }
  }
  return dist;
}

export function findLocalProductByCode(rawCode: string): CatalogProductEntry | null {
  const bundle = loadProductCatalogSync();
  const clean = String(rawCode || '').trim();
  if (!clean) return null;
  const redirected = bundle.tempRedirects[clean] || clean;
  return bundle.itemsByCode[redirected] || bundle.itemsByCode[clean] || null;
}

export function findLocalProductByVisualOrName(
  visualHash?: string,
  candidateName?: string
): CatalogProductEntry | null {
  const bundle = loadProductCatalogSync();
  const entries = Object.values(bundle.itemsByCode);
  if (entries.length === 0) return null;

  if (candidateName) {
    const norm = normalizeNameForMatch(candidateName);
    if (norm.length >= 3) {
      const exact = entries.find((e) => normalizeNameForMatch(e.name) === norm);
      if (exact) return exact;
    }
  }

  if (visualHash && visualHash.length === 16) {
    let best: CatalogProductEntry | null = null;
    let bestDist = 7; // Strict <= 6 Hamming threshold out of 64 bits
    for (const entry of entries) {
      const d = computeVisualHashDistance(visualHash, entry.visualHash);
      if (d < bestDist) {
        bestDist = d;
        best = entry;
      }
    }
    if (best) return best;
  }

  return null;
}

/**
 * Replaces a temporary code (`TMP-XXXXXX`) with a real barcode/QR globally & locally.
 */
export async function upgradeTemporaryCodeToRealCode(
  tempCode: string,
  realCode: string,
  overrides?: Partial<CatalogProductEntry>
): Promise<CatalogProductEntry | null> {
  const cleanTemp = String(tempCode || '').trim();
  const cleanReal = String(realCode || '').trim();
  if (!cleanTemp || !cleanReal || cleanTemp === cleanReal) return null;

  const bundle = loadProductCatalogSync();
  const oldEntry = bundle.itemsByCode[cleanTemp];
  const existingReal = bundle.itemsByCode[cleanReal];
  const now = Date.now();

  const merged: CatalogProductEntry = {
    id: existingReal?.id || oldEntry?.id || `prod_${now}`,
    code: cleanReal,
    isTemporaryCode: false,
    name: overrides?.name || existingReal?.name || oldEntry?.name || cleanReal,
    brand: overrides?.brand || existingReal?.brand || oldEntry?.brand,
    itemKind: overrides?.itemKind || existingReal?.itemKind || oldEntry?.itemKind || 'product',
    categoryHint: overrides?.categoryHint || existingReal?.categoryHint || oldEntry?.categoryHint,
    categoryId: overrides?.categoryId || existingReal?.categoryId || oldEntry?.categoryId,
    localPrice:
      overrides?.localPrice ?? existingReal?.localPrice ?? oldEntry?.localPrice ?? 0,
    serverPrice:
      overrides?.serverPrice ?? existingReal?.serverPrice ?? oldEntry?.serverPrice,
    visualHash: overrides?.visualHash || existingReal?.visualHash || oldEntry?.visualHash,
    thumbnailDataUrl:
      overrides?.thumbnailDataUrl || existingReal?.thumbnailDataUrl || oldEntry?.thumbnailDataUrl,
    usageCount: (existingReal?.usageCount || 0) + (oldEntry?.usageCount || 0) + 1,
    createdAt: existingReal?.createdAt || oldEntry?.createdAt || now,
    updatedAt: now,
    replacedTempCodes: Array.from(
      new Set([...(existingReal?.replacedTempCodes || []), ...(oldEntry?.replacedTempCodes || []), cleanTemp])
    ),
  };

  delete bundle.itemsByCode[cleanTemp];
  bundle.itemsByCode[cleanReal] = merged;
  bundle.tempRedirects[cleanTemp] = cleanReal;
  saveProductCatalog(bundle);

  // Sync redirect & upgraded entry to Firebase RTDB when online
  if (typeof navigator === 'undefined' || navigator.onLine) {
    try {
      await ensureFirebaseAuth();
      const realKey = sanitizeCatalogKey(cleanReal);
      const tempKey = sanitizeCatalogKey(cleanTemp);
      await Promise.all([
        set(ref(rtdb, `temp_code_redirects/${tempKey}`), cleanReal),
        set(ref(rtdb, `product_catalog/${realKey}`), {
          code: merged.code,
          isTemporaryCode: false,
          name: merged.name,
          brand: merged.brand || null,
          itemKind: merged.itemKind || 'product',
          categoryHint: merged.categoryHint || null,
          price: merged.serverPrice ?? merged.localPrice,
          visualHash: merged.visualHash || null,
          thumbnailDataUrl: merged.thumbnailDataUrl || null,
          replacedTempCodes: merged.replacedTempCodes || [cleanTemp],
          updatedAt: now,
        }),
        set(ref(rtdb, `product_catalog/${tempKey}`), null),
      ]);
    } catch {}
  }

  return merged;
}

/**
 * Fetches latest product entry from Firebase RTDB (following temp_code_redirects if upgraded!)
 * and falls back to OpenFoodFacts for global retail EAN/UPC barcodes.
 */
export async function lookupProductFromServerAndGlobal(
  rawCode: string
): Promise<CatalogProductEntry | null> {
  const clean = String(rawCode || '').trim();
  if (!clean) return null;
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return findLocalProductByCode(clean);
  }

  const localExisting = findLocalProductByCode(clean);

  try {
    await ensureFirebaseAuth();
    let effectiveCode = clean;
    const tempKey = sanitizeCatalogKey(clean);
    if (clean.startsWith('TMP-')) {
      const redirSnap = await get(ref(rtdb, `temp_code_redirects/${tempKey}`));
      if (redirSnap.exists() && typeof redirSnap.val() === 'string') {
        effectiveCode = redirSnap.val();
      }
    }

    const codeKey = sanitizeCatalogKey(effectiveCode);
    const snap = await get(ref(rtdb, `product_catalog/${codeKey}`));
    if (snap.exists() && snap.val()) {
      const sv = snap.val();
      const serverPrice = typeof sv.price === 'number' && sv.price > 0 ? sv.price : undefined;
      const now = Date.now();
      const bundle = loadProductCatalogSync();
      if (effectiveCode !== clean) {
        bundle.tempRedirects[clean] = effectiveCode;
        delete bundle.itemsByCode[clean];
      }
      const prev = bundle.itemsByCode[effectiveCode] || localExisting;
      const merged: CatalogProductEntry = {
        id: prev?.id || `prod_${now}`,
        code: effectiveCode,
        isTemporaryCode: Boolean(sv.isTemporaryCode),
        name: sv.name || prev?.name || effectiveCode,
        brand: sv.brand || prev?.brand,
        itemKind: sv.itemKind || prev?.itemKind || 'product',
        categoryHint: sv.categoryHint || prev?.categoryHint,
        categoryId: prev?.categoryId,
        localPrice: prev?.localPrice && prev.localPrice > 0 ? prev.localPrice : serverPrice || 0,
        serverPrice: serverPrice ?? prev?.serverPrice,
        visualHash: sv.visualHash || prev?.visualHash,
        thumbnailDataUrl: sv.thumbnailDataUrl || prev?.thumbnailDataUrl,
        usageCount: (prev?.usageCount || 0) + 1,
        createdAt: prev?.createdAt || now,
        updatedAt: Math.max(sv.updatedAt || 0, prev?.updatedAt || 0, now),
      };
      bundle.itemsByCode[effectiveCode] = merged;
      saveProductCatalog(bundle);
      return merged;
    }
  } catch {}

  // Global barcode lookup via OpenFoodFacts for numeric 8-14 digit EAN/UPC codes
  if (/^\d{8,14}$/.test(clean)) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(
        `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(clean)}.json?fields=product_name,product_name_ar,brands,categories`,
        { signal: controller.signal }
      );
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        const p = data?.product;
        const foundName = String(p?.product_name_ar || p?.product_name || '').trim();
        if (foundName) {
          const brand = String(p?.brands || '').split(',')[0]?.trim();
          const fullName = brand && !foundName.toLowerCase().includes(brand.toLowerCase())
            ? `${foundName} (${brand})`
            : foundName;
          const now = Date.now();
          // Check if we had a temporary code with the same product name so we auto-upgrade it!
          const tempMatch = findLocalProductByVisualOrName(undefined, fullName);
          if (tempMatch && tempMatch.isTemporaryCode) {
            const upgraded = await upgradeTemporaryCodeToRealCode(tempMatch.code, clean, {
              name: fullName,
              brand: brand || undefined,
              categoryHint: 'Food & Dining',
            });
            if (upgraded) return upgraded;
          }

          const entry: CatalogProductEntry = {
            id: `prod_${now}`,
            code: clean,
            isTemporaryCode: false,
            name: fullName,
            brand: brand || undefined,
            itemKind: 'product',
            categoryHint: 'Food & Dining',
            localPrice: localExisting?.localPrice || 0,
            serverPrice: localExisting?.serverPrice,
            usageCount: 1,
            createdAt: now,
            updatedAt: now,
          };
          const bundle = loadProductCatalogSync();
          bundle.itemsByCode[clean] = entry;
          saveProductCatalog(bundle);
          return entry;
        }
      }
    } catch {}
  }

  return localExisting;
}

/**
 * Saves or updates a product locally AND submits to Firebase RTDB.
 * Price consensus rule:
 * - Updates user's local permanent storage immediately when `updateSavedPrice` is true.
 * - On the server: updates global `price` immediately if `isFirstCreation` OR `aiVerifiedPrintedPrice` is true;
 *   otherwise increments `priceRequests[priceKey]` and promotes to global `price` once `count >= 3`
 *   (counting repeated confirmations even from the same user across separate transactions!).
 */
export async function persistCatalogProductDecision(params: {
  code: string;
  isTemporaryCode: boolean;
  name: string;
  price: number;
  categoryId?: string;
  categoryHint?: string;
  visualHash?: string;
  thumbnailDataUrl?: string;
  updateSavedPrice: boolean;
  aiVerifiedPrintedPrice?: boolean;
}): Promise<CatalogProductEntry> {
  const bundle = loadProductCatalogSync();
  const cleanCode = String(params.code || '').trim() || allocateNextTemporaryCode();
  const now = Date.now();

  // If this is a real barcode/QR, check if an existing TMP-* item has the same name or visual hash to upgrade it!
  if (!params.isTemporaryCode && !cleanCode.startsWith('TMP-')) {
    const tempCandidate = findLocalProductByVisualOrName(params.visualHash, params.name);
    if (tempCandidate && tempCandidate.isTemporaryCode && tempCandidate.code !== cleanCode) {
      const upgraded = await upgradeTemporaryCodeToRealCode(tempCandidate.code, cleanCode, {
        name: params.name,
        categoryId: params.categoryId,
        categoryHint: params.categoryHint,
        localPrice: params.updateSavedPrice ? params.price : tempCandidate.localPrice || params.price,
        visualHash: params.visualHash || tempCandidate.visualHash,
        thumbnailDataUrl: params.thumbnailDataUrl || tempCandidate.thumbnailDataUrl,
      });
      if (upgraded) return upgraded;
    }
  }

  const existing = bundle.itemsByCode[cleanCode];
  const nextLocalPrice =
    params.updateSavedPrice || !existing || existing.localPrice <= 0
      ? params.price
      : existing.localPrice;

  const entry: CatalogProductEntry = {
    id: existing?.id || `prod_${now}`,
    code: cleanCode,
    isTemporaryCode: params.isTemporaryCode,
    name: params.name.trim() || existing?.name || cleanCode,
    brand: existing?.brand,
    itemKind: existing?.itemKind || 'product',
    categoryId: params.categoryId || existing?.categoryId,
    categoryHint: params.categoryHint || existing?.categoryHint,
    localPrice: Math.round(nextLocalPrice * 100) / 100,
    serverPrice: existing?.serverPrice,
    visualHash: params.visualHash || existing?.visualHash,
    thumbnailDataUrl: params.thumbnailDataUrl || existing?.thumbnailDataUrl,
    usageCount: (existing?.usageCount || 0) + 1,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    pendingServerSync: typeof navigator !== 'undefined' && !navigator.onLine,
  };

  bundle.itemsByCode[cleanCode] = entry;
  saveProductCatalog(bundle);

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return entry;
  }

  if (params.updateSavedPrice || !existing) {
    try {
      await ensureFirebaseAuth();
      const codeKey = sanitizeCatalogKey(cleanCode);
      const nodeRef = ref(rtdb, `product_catalog/${codeKey}`);
      const snap = await get(nodeRef);
      const sv = snap.exists() ? snap.val() : null;
      const roundedPrice = Math.round(params.price * 100) / 100;
      const priceKey = `p_${Math.round(roundedPrice * 100)}`;

      // Also check server-side if a TMP-* item matches by visualHash/name when saving a real code
      if (!sv && roundedPrice > 0) {
        await set(nodeRef, {
          code: cleanCode,
          isTemporaryCode: params.isTemporaryCode,
          name: entry.name,
          categoryHint: entry.categoryHint || null,
          price: roundedPrice,
          visualHash: entry.visualHash || null,
          thumbnailDataUrl: entry.thumbnailDataUrl || null,
          priceRequests: {
            [priceKey]: { price: roundedPrice, count: 1, lastRequestedAt: now },
          },
          updatedAt: now,
        });
        entry.serverPrice = roundedPrice;
        entry.pendingServerSync = false;
        bundle.itemsByCode[cleanCode] = entry;
        saveProductCatalog(bundle);
      } else if (sv && roundedPrice > 0) {
        const existingServerPrice = typeof sv.price === 'number' ? sv.price : 0;
        const priceRequests: Record<string, ProductPriceVote> = { ...(sv.priceRequests || {}) };
        const prevVote = priceRequests[priceKey] || { price: roundedPrice, count: 0, lastRequestedAt: 0 };
        const nextCount = (prevVote.count || 0) + 1;
        priceRequests[priceKey] = {
          price: roundedPrice,
          count: nextCount,
          lastRequestedAt: now,
        };

        // Promote server price immediately if AI verified printed price, no prior server price, or >= 3 matching requests!
        const shouldPromoteGlobalPrice =
          existingServerPrice <= 0 ||
          Math.abs(existingServerPrice - roundedPrice) < 0.01 ||
          Boolean(params.aiVerifiedPrintedPrice) ||
          nextCount >= 3;

        const nextServerPrice = shouldPromoteGlobalPrice ? roundedPrice : existingServerPrice;
        await set(nodeRef, {
          ...sv,
          code: cleanCode,
          isTemporaryCode: params.isTemporaryCode,
          name: entry.name || sv.name,
          categoryHint: entry.categoryHint || sv.categoryHint || null,
          visualHash: entry.visualHash || sv.visualHash || null,
          thumbnailDataUrl: entry.thumbnailDataUrl || sv.thumbnailDataUrl || null,
          price: nextServerPrice,
          priceRequests: shouldPromoteGlobalPrice
            ? { [priceKey]: { price: roundedPrice, count: nextCount, lastRequestedAt: now } }
            : priceRequests,
          updatedAt: now,
        });

        entry.serverPrice = nextServerPrice;
        entry.pendingServerSync = false;
        bundle.itemsByCode[cleanCode] = entry;
        saveProductCatalog(bundle);
      }
    } catch {}
  }

  return entry;
}

async function fetchGeminiKeyInMemory(): Promise<{ apiKey?: string; model?: string }> {
  try {
    if (typeof auth.authStateReady === 'function') {
      await auth.authStateReady();
    }
    await ensureFirebaseAuth();
    const snap = await get(ref(rtdb, 'app_config'));
    if (snap.exists() && snap.val()) {
      const val = snap.val();
      const apiKey =
        (typeof val?.gemini?.apiKey === 'string' && val.gemini.apiKey.trim()) ||
        (typeof val?.gemini_api_key === 'string' && val.gemini_api_key.trim()) ||
        undefined;
      const model =
        (typeof val?.ocr_model === 'string' && val.ocr_model.trim()) ||
        (typeof val?.gemini?.ocrModel === 'string' && val.gemini.ocrModel.trim()) ||
        undefined;
      return { apiKey, model };
    }
  } catch {}
  return {};
}

export async function callGeminiJsonPrompt(
  prompt: string,
  imageBase64?: string,
  mimeType: string = 'image/jpeg'
): Promise<any> {
  const cfg = await fetchGeminiKeyInMemory();
  const envKey = ((import.meta as any).env?.VITE_GEMINI_API_KEY as string | undefined)?.trim();
  const apiKey = cfg.apiKey || envKey;
  if (!apiKey) {
    throw new Error('AI key unavailable');
  }

  const models = Array.from(
    new Set([cfg.model, ...DEFAULT_SCAN_MODELS].filter(Boolean) as string[])
  );

  let lastErr: any = null;
  for (const modelName of models) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 16000);
    try {
      const parts: any[] = [{ text: prompt }];
      if (imageBase64) {
        parts.push({ inlineData: { mimeType, data: imageBase64 } });
      }
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: {
              temperature: 0.1,
              responseMimeType: 'application/json',
            },
          }),
          signal: controller.signal,
        }
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      const rawText = (data?.candidates?.[0]?.content?.parts || [])
        .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
        .join('')
        .trim();
      if (!rawText) throw new Error('Empty response');
      return extractJsonFromModelText(rawText);
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('AI request failed');
}

export interface AiRecognizedObjectResult {
  name: string;
  brand?: string;
  itemKind: 'product' | 'ticket' | 'device' | 'bill' | 'other';
  estimatedPrice: number;
  printedPriceVisible: boolean;
  categoryHint: string;
  detectedCode?: string;
  transactionType: 'expense' | 'income';
}

export async function analyzeItemPhotoWithAi(params: {
  base64: string;
  mimeType: string;
  knownBarcode?: string;
  language: 'ar' | 'en';
  currencySymbol: string;
}): Promise<AiRecognizedObjectResult> {
  const prompt = `You are a universal smart item, ticket, receipt tag, and device recognizer for a personal finance app (default currency: ${params.currencySymbol}, Egypt/Global market).
Identify ANYTHING shown in this photo — whether it is a grocery/supermarket product, beverage, snack, bus/metro/train/cinema ticket, electronic device, gadget, medicine, clothing tag, or bill.
${params.knownBarcode ? `A barcode/QR code "${params.knownBarcode}" was also scanned on this item.` : ''}
Language for "name": ${params.language === 'ar' ? 'Clear natural Arabic (keep well-known brand names clear, e.g. "تذكرة أتوبيس نقل عام" or "جهينة حليب كامل الدسم 1 لتر")' : 'Clear concise English'}.
Rules:
1. If a price or fare is printed/written anywhere on the item, ticket, or shelf tag, extract that EXACT number in "estimatedPrice" and set "printedPriceVisible": true.
2. Otherwise, provide a realistic typical market price in Egypt/local currency in "estimatedPrice" (or 0 if completely impossible to estimate) and set "printedPriceVisible": false.
3. If a visible barcode number or QR code text is legible in the photo, return it in "detectedCode".
4. Choose "categoryHint" from: "Food & Dining", "Transportation", "Shopping", "Bills & Utilities", "Health & Medical", "Entertainment", "Education", "Electronics".
Return ONLY valid JSON:
{
  "name": "Item or ticket name",
  "brand": "Optional brand",
  "itemKind": "product" | "ticket" | "device" | "bill" | "other",
  "estimatedPrice": 25,
  "printedPriceVisible": true,
  "categoryHint": "Transportation",
  "detectedCode": "",
  "transactionType": "expense"
}`;

  const raw = await callGeminiJsonPrompt(prompt, params.base64, params.mimeType);
  const priceNum = Number(String(raw?.estimatedPrice ?? 0).replace(/[^0-9.]/g, ''));
  return {
    name: String(raw?.name || (params.language === 'ar' ? 'عنصر ممسوح بالكاميرا' : 'Scanned Item')).trim(),
    brand: typeof raw?.brand === 'string' && raw.brand.trim() ? raw.brand.trim() : undefined,
    itemKind:
      raw?.itemKind === 'ticket' ||
      raw?.itemKind === 'device' ||
      raw?.itemKind === 'bill' ||
      raw?.itemKind === 'other'
        ? raw.itemKind
        : 'product',
    estimatedPrice: Number.isFinite(priceNum) && priceNum >= 0 ? Math.round(priceNum * 100) / 100 : 0,
    printedPriceVisible: Boolean(raw?.printedPriceVisible),
    categoryHint: String(raw?.categoryHint || 'Shopping').trim(),
    detectedCode:
      params.knownBarcode ||
      (typeof raw?.detectedCode === 'string' && raw.detectedCode.trim() ? raw.detectedCode.trim() : undefined),
    transactionType: raw?.transactionType === 'income' ? 'income' : 'expense',
  };
}

export function enqueueOfflineCameraScan(scan: Omit<OfflinePendingCameraScan, 'id' | 'createdAt' | 'status'>): OfflinePendingCameraScan {
  const bundle = loadProductCatalogSync();
  const item: OfflinePendingCameraScan = {
    ...scan,
    id: `camq_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    createdAt: Date.now(),
    status: 'queued_offline',
  };
  bundle.offlineQueue = [item, ...bundle.offlineQueue].slice(0, 30);
  saveProductCatalog(bundle);
  return item;
}

export function removeOfflineCameraScan(scanId: string): void {
  const bundle = loadProductCatalogSync();
  bundle.offlineQueue = bundle.offlineQueue.filter((q) => q.id !== scanId);
  saveProductCatalog(bundle);
}
