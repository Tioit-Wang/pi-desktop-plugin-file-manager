// The viewer component reads globalThis.pdfjsLib during module evaluation.
// Evaluate the matching compatibility API first, including in the IIFE build.
import "pdfjs-dist/legacy/build/pdf.mjs";
import { AnnotationEditorType, AnnotationMode, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { EventBus, PDFLinkService, PDFViewer, RenderingStates, ScrollMode, SpreadMode } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import type { T } from "../i18n";
import { createPdfFitWidths, type PdfSpread } from "./pdfFit";

export type { PdfSpread } from "./pdfFit";
export const MIN_PDF_ZOOM = 0.1;
export const MAX_PDF_ZOOM = 4;
export const clampPdfZoom = (zoom: number) => Math.min(MAX_PDF_ZOOM, Math.max(MIN_PDF_ZOOM, zoom));

type Callbacks = {
  t: () => T;
  ready: () => void;
  page: (page: number) => void;
  scale: (scale: number) => void;
  rendering: (busy: boolean) => void;
  failed: () => void;
};

/** A document-scoped PDFViewer, with no scripting, editing or remote l10n. */
export function createDocumentViewer(container: HTMLDivElement, host: HTMLDivElement, pdf: PDFDocumentProxy, callbacks: Callbacks) {
  const lifetime = new AbortController();
  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus, ignoreDestinationZoom: true });
  linkService.externalLinkEnabled = false;
  let destroyed = false;
  const fitWidths = createPdfFitWidths();
  let fit = true;
  let spread: PdfSpread = "single";
  let resizeFrame = 0;

  // PDF.js types this as its concrete L10n class, but only calls these methods
  // in the read-only viewer. Page labels and all controls use the plugin's T.
  const l10n = {
    getLanguage: () => document.documentElement.lang || "en",
    getDirection: () => "ltr",
    get: async () => "",
    translate: async () => {},
    translateOnce: async () => {},
    destroy: async () => {},
    pause: () => {},
    resume: () => {},
  } as unknown as NonNullable<ConstructorParameters<typeof PDFViewer>[0]["l10n"]>;
  const options: ConstructorParameters<typeof PDFViewer>[0] & { abortSignal: AbortSignal } = {
    container, viewer: host, eventBus, linkService, l10n,
    abortSignal: lifetime.signal,
    annotationMode: AnnotationMode.DISABLE,
    annotationEditorMode: AnnotationEditorType.DISABLE,
    enableAutoLinking: false,
    enableSelectionRendering: false,
    removePageBorders: true,
    maxCanvasPixels: 16 * 1024 * 1024,
    maxCanvasDim: 8192,
    enableDetailCanvas: false,
  };
  const viewer = new PDFViewer(options);
  linkService.setViewer(viewer);
  linkService.setDocument(pdf);

  const labelPages = () => {
    for (let index = 0; index < viewer.pagesCount; index += 1) {
      viewer.getPageView(index).div.setAttribute("aria-label", callbacks.t()("pageOf", { page: index + 1, count: pdf.numPages }));
    }
  };
  const rememberPage = (number: number, page: PDFPageProxy | null | undefined) => {
    if (!page) return false;
    const before = fitWidths.width(spread);
    fitWidths.add(number, page.getViewport({ scale: 96 / 72 }).width);
    return fitWidths.width(spread) > before;
  };
  const refreshWidth = () => {
    if (destroyed || !fit || !viewer.pagesCount || container.clientWidth <= 0) return;
    const naturalWidth = fitWidths.width(spread);
    if (!naturalWidth) return;
    // Fit the widest known row in this layout. A lone cover/final page keeps
    // the same scale as paired rows; pagechanging must never alter global zoom.
    const columns = spread === "single" ? 0 : spread === "cover" && pdf.numPages <= 2 ? 1 : Math.min(2, pdf.numPages);
    const available = container.clientWidth - 32 - columns * 10;
    const scale = Math.min(MAX_PDF_ZOOM, Math.max(0.01, available / naturalWidth));
    if (Math.abs(scale - viewer.currentScale) < 1e-8) return;
    viewer.update(); // Synchronize the saved location before preserving it.
    viewer.currentScaleValue = String(scale);
  };
  const resize = () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      if (destroyed) return;
      refreshWidth();
      viewer.update();
    });
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  eventBus.on("pagesinit", () => {
    if (destroyed) return;
    viewer.scrollMode = ScrollMode.VERTICAL;
    labelPages();
    rememberPage(1, viewer.getPageView(0).pdfPage);
    refreshWidth();
    callbacks.ready();
  }, { signal: lifetime.signal });
  eventBus.on("pagesloaded", () => {
    if (destroyed) return;
    let changed = false;
    // PDF.js can resolve pagesPromise before every proxy exists in lazy mode.
    // Use only pages it already initialized; do not fetch the entire document.
    for (let index = 0; index < viewer.pagesCount; index += 1) {
      changed = rememberPage(index + 1, viewer.getPageView(index).pdfPage) || changed;
    }
    if (changed) resize();
  }, { signal: lifetime.signal });
  eventBus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => {
    if (destroyed) return;
    callbacks.page(pageNumber);
    callbacks.rendering(viewer.getPageView(pageNumber - 1)?.renderingState !== RenderingStates.FINISHED);
  }, { signal: lifetime.signal });
  eventBus.on("scalechanging", ({ scale }: { scale: number }) => {
    if (!destroyed) callbacks.scale(scale);
  }, { signal: lifetime.signal });
  eventBus.on("pagerender", ({ pageNumber }: { pageNumber: number }) => {
    if (destroyed) return;
    if (rememberPage(pageNumber, viewer.getPageView(pageNumber - 1)?.pdfPage)) resize();
    if (pageNumber === viewer.currentPageNumber) callbacks.rendering(true);
  }, { signal: lifetime.signal });
  eventBus.on("pagerendered", ({ pageNumber, error }: { pageNumber: number; error?: unknown }) => {
    if (destroyed) return;
    if (error) callbacks.failed();
    else if (pageNumber === viewer.currentPageNumber) callbacks.rendering(false);
  }, { signal: lifetime.signal });
  viewer.setDocument(pdf);
  void viewer.pagesPromise?.catch(() => { if (!destroyed) callbacks.failed(); });

  return {
    viewer,
    labelPages,
    thumbnailRendered(pageNumber: number, pdfPage: PDFPageProxy) {
      if (destroyed) return;
      if (rememberPage(pageNumber, pdfPage)) resize();
      eventBus.dispatch("thumbnailrendered", { source: viewer, pageNumber, pdfPage });
    },
    goToPage(number: number) { if (!destroyed) viewer.currentPageNumber = Math.max(1, Math.min(pdf.numPages, number)); },
    async goToDestination(destination: string | unknown[]) {
      if (!destroyed) await linkService.goToDestination(destination);
    },
    setSpread(mode: PdfSpread) {
      if (destroyed) return;
      spread = mode;
      viewer.update();
      viewer.spreadMode = mode === "double" ? SpreadMode.ODD : mode === "cover" ? SpreadMode.EVEN : SpreadMode.NONE;
      resize();
    },
    setZoom(value: number | null) {
      if (destroyed) return;
      fit = value === null;
      // A navigation can move the scroll position before PDF.js's next frame
      // updates its saved location. Synchronize it before preserving it on zoom.
      viewer.update();
      if (fit) refreshWidth();
      else viewer.currentScaleValue = String(clampPdfZoom(value!));
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      const pages = Array.from({ length: viewer.pagesCount }, (_, index) => viewer.getPageView(index));
      // setDocument(null) cancels rendering and removes the document listeners.
      viewer.setDocument(null);
      for (const page of pages) page.destroy();
      linkService.setDocument(null);
      lifetime.abort(); // disconnects PDF.js's own ResizeObserver and scroll listener
      host.replaceChildren();
    },
  };
}

export type DocumentViewer = ReturnType<typeof createDocumentViewer>;
