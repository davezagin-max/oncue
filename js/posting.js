// Reads the text out of an uploaded job-posting PDF with pdf.js, loaded from a
// CDN only when someone uploads a PDF. The file itself never leaves the browser.

const PDFJS_ROOT = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299';
// The modern build needs very recent browsers (Chrome/Edge 147+, Firefox 144+,
// Safari 26.2+); the legacy build of the same version covers Chrome 125+,
// Firefox ESR and Safari 18+. Older Safari (16.4 to 17) gets the 4.10.38 legacy build.
const MODERN = typeof Math.sumPrecise === 'function' && typeof Map.prototype.getOrInsertComputed === 'function';
const CANDIDATES = [
  { base: `${PDFJS_ROOT}/${MODERN ? 'build' : 'legacy/build'}`, assets: PDFJS_ROOT },
  { base: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build', assets: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38' },
];

let pdfjsPromise = null;

async function loadPdfjs() {
  let lastErr;
  for (const c of CANDIDATES) {
    try {
      const lib = await import(/* webpackIgnore: true */ `${c.base}/pdf.min.mjs`);
      // A cross-origin worker is fine: pdf.js wraps it in a same-origin blob: worker.
      lib.GlobalWorkerOptions.workerSrc = `${c.base}/pdf.worker.min.mjs`;
      return { lib, assets: c.assets };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = loadPdfjs();
    // Let a later upload retry if the CDN was unreachable.
    pdfjsPromise.catch(() => {
      pdfjsPromise = null;
    });
  }
  return pdfjsPromise;
}

export class PostingReadError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

export function isPdf(file) {
  return Boolean(file) && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));
}

/**
 * Returns { text, pages }: the plain text of the PDF (pages separated by blank lines).
 * Throws PostingReadError with kind 'offline' | 'password' | 'invalid' | 'empty'.
 */
export async function extractPdfText(file, { maxPages = 30 } = {}) {
  let pdfjs;
  try {
    pdfjs = await getPdfjs();
  } catch {
    throw new PostingReadError('offline', 'Could not load the PDF reader. Check your internet connection, or paste the job description instead.');
  }
  const { lib, assets } = pdfjs;

  // pdf.js takes ownership of this array, so hand it a copy and keep the File.
  const data = new Uint8Array(await file.arrayBuffer());
  const task = lib.getDocument({
    data,
    cMapUrl: `${assets}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assets}/standard_fonts/`,
    wasmUrl: `${assets}/wasm/`,
    isEvalSupported: false, // ignored by newer versions; safer on older ones
  });

  try {
    let doc;
    try {
      doc = await task.promise;
    } catch (err) {
      if (err?.name === 'PasswordException') {
        throw new PostingReadError('password', 'This PDF is password-protected. Save an unlocked copy, or paste the job description instead.');
      }
      if (err instanceof TypeError || err instanceof ReferenceError) {
        throw new PostingReadError('browser', 'This browser is too old to read PDFs here. Paste the job description instead, or update your browser.');
      }
      throw new PostingReadError('invalid', 'This file could not be opened as a PDF. Try another file, or paste the job description instead.');
    }

    const totalPages = doc.numPages;
    const parts = [];
    for (let n = 1; n <= Math.min(totalPages, maxPages); n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let pageText = '';
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue; // marked-content entries carry no text
        pageText += item.str; // pdf.js inserts the spaces itself
        if (item.hasEOL) pageText += '\n';
      }
      parts.push(pageText.replace(/[ \t]+\n/g, '\n').trim());
      page.cleanup();
    }

    const text = parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text.replace(/\s/g, '').length < 40) {
      throw new PostingReadError('empty', 'This PDF looks like a scanned image, so there is no text to read. Paste the job description instead.');
    }
    return { text, pages: totalPages };
  } finally {
    Promise.resolve()
      .then(() => task.destroy())
      .catch(() => {});
  }
}
