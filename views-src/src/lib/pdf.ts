import { getDocument, PDFWorker, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import { workerSource } from "virtual:pdf-assets";

const RESOURCE_ROOT = "https://pi-file-manager.invalid/pdfjs/";

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** One document owns one real worker; disposal is safe to call more than once. */
export function createPdfSession(src: string, onFailure?: () => void) {
  const prefix = "data:application/pdf;base64,";
  if (!src.startsWith(prefix)) throw new Error("Invalid PDF data URI");
  const data = decodeBase64(src.slice(prefix.length));
  const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  let port: Worker;
  try {
    port = new Worker(url, { name: "file-manager-pdf" });
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  let worker: PDFWorker | undefined;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    port.onerror = null;
    worker?.destroy();
    port.terminate();
    URL.revokeObjectURL(url);
  };
  let signalFailure!: () => void;
  const failed = new Promise<void>((resolve) => { signalFailure = resolve; });
  const workerFailure = new Promise<never>((_resolve, reject) => {
    port.onerror = (event) => {
      event.preventDefault();
      // A dead worker cannot acknowledge PDF.js's asynchronous destroy request.
      release();
      signalFailure();
      reject(new Error(event.message || "PDF worker failed"));
      onFailure?.();
    };
  });
  try {
    worker = PDFWorker.create({ port, verbosity: VerbosityLevel.ERRORS });
    const task = getDocument({
      data,
      worker,
      cMapUrl: `${RESOURCE_ROOT}cmaps/`,
      standardFontDataUrl: `${RESOURCE_ROOT}standard_fonts/`,
      wasmUrl: `${RESOURCE_ROOT}wasm/`,
      iccUrl: `${RESOURCE_ROOT}iccs/`,
      cMapPacked: true,
      // The bundled worker redirects resource fetches to embedded data URLs.
      // Worker fetching also enables PDF.js's synchronous ICC conversion.
      useWorkerFetch: true,
      useSystemFonts: false,
      canvasMaxAreaInBytes: 64 * 1024 * 1024,
      verbosity: VerbosityLevel.ERRORS,
    });
    let disposal: Promise<void> | undefined;
    return {
      promise: Promise.race([task.promise, workerFailure]),
      destroy(): Promise<void> {
        return (disposal ??= Promise.race([task.destroy().catch(() => {}), failed]).finally(release));
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
