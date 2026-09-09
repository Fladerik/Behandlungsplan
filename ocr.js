/**
 * Bilder und PDF-Dateien in Text mit Positionsangaben umwandeln.
 *
 * Alles läuft im Browser des Geräts: Tesseract für Fotos und Scans,
 * pdf.js für PDF-Dateien. Es verlässt keine Datei das Gerät.
 */

const TESS_OPTIONS = {
  workerPath: "./vendor/worker.min.js",
  corePath: "./vendor/",
  langPath: "./tessdata/",
};

let workerPromise = null;

async function getWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker("deu", Tesseract.OEM.LSTM_ONLY, {
      ...TESS_OPTIONS,
      logger(message) {
        if (message.status === "recognizing text") onProgress?.(message.progress || 0);
      },
    }).then(async (worker) => {
      await worker.setParameters({
        preserve_interword_spaces: "1",
        tessedit_pageseg_mode: Tesseract.PSM.AUTO,
        // Der Plan enthält keine exotischen Zeichen; das reduziert Verlesungen.
        tessedit_char_blacklist: "©®™{}~^`",
      });
      return worker;
    });
  }
  return workerPromise;
}

export async function releaseWorker() {
  if (!workerPromise) return;
  const worker = await workerPromise;
  workerPromise = null;
  await worker.terminate().catch(() => {});
}

/* ------------------------------------------------------- Bildaufbereitung */

/**
 * Handyfotos sind selten ideal. Hochskalieren auf eine für Tesseract gute
 * Größe, Graustufen und eine sanfte Kontrastspreizung bringen den größten
 * Gewinn -- härteres Schwellwertverfahren frisst dünne Buchstaben weg.
 */
function enhance(source, width, height) {
  const target = Math.min(2600, Math.max(1600, width));
  const scale = target / width;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, canvas.width, canvas.height);

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = pixels.data;
  const histogram = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    const gray = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
    data[i] = data[i + 1] = data[i + 2] = gray;
    histogram[gray] += 1;
  }
  // Kontrast an den tatsächlichen Grauwerten des Blattes ausrichten (2 %/98 %).
  const total = canvas.width * canvas.height;
  let low = 0;
  let high = 255;
  let seen = 0;
  for (let value = 0; value < 256; value += 1) { seen += histogram[value]; if (seen > total * 0.02) { low = value; break; } }
  seen = 0;
  for (let value = 255; value >= 0; value -= 1) { seen += histogram[value]; if (seen > total * 0.02) { high = value; break; } }
  const span = Math.max(24, high - low);
  for (let i = 0; i < data.length; i += 4) {
    const stretched = Math.min(255, Math.max(0, ((data[i] - low) / span) * 255));
    data[i] = data[i + 1] = data[i + 2] = stretched;
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Das Bild konnte nicht gelesen werden.")); };
    image.src = url;
  });
}

/* ----------------------------------------------------------------- PDF */

let pdfjsPromise = null;
async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("./vendor/pdf.mjs").then((module) => {
      module.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.mjs";
      return module;
    });
  }
  return pdfjsPromise;
}

async function pdfPages(file, onPage) {
  const pdfjs = await getPdfjs();
  const buffer = await file.arrayBuffer();
  const document_ = await pdfjs.getDocument({ data: buffer }).promise;
  const pages = [];
  for (let number = 1; number <= document_.numPages; number += 1) {
    onPage?.(number, document_.numPages);
    const page = await document_.getPage(number);

    // Enthält das PDF bereits eine Textebene, ist sie jeder OCR überlegen.
    const textContent = await page.getTextContent();
    const embedded = textContent.items.map((item) => item.str).join(" ").trim();
    if (embedded.length > 60) {
      pages.push({ kind: "text", text: layoutText(textContent), tsv: "" });
      continue;
    }

    const viewport = page.getViewport({ scale: 2.2 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    pages.push({ kind: "canvas", canvas: enhance(canvas, canvas.width, canvas.height) });
  }
  return pages;
}

/** Baut aus den PDF-Textelementen zeilenweisen Text mit erhaltenen Spaltenabständen. */
function layoutText(textContent) {
  const rows = new Map();
  for (const item of textContent.items) {
    if (!item.str.trim()) continue;
    const y = Math.round(item.transform[5]);
    const key = [...rows.keys()].find((value) => Math.abs(value - y) <= 3) ?? y;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push({ x: item.transform[4], text: item.str });
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, items]) => items.sort((a, b) => a.x - b.x).map((entry) => entry.text).join("   ").replace(/\s{4,}/g, "   "))
    .join("\n");
}

/* ------------------------------------------------------------ Hauptweg */

/**
 * @param {File[]} files
 * @param {(info: {label: string, ratio: number}) => void} onProgress
 * @returns {Promise<Array<{text: string, tsv: string, name: string}>>}
 */
export async function readFiles(files, onProgress) {
  const result = [];
  const report = (label, ratio) => onProgress?.({ label, ratio: Math.min(1, Math.max(0, ratio)) });

  // Zuerst alle Seiten aufbereiten, damit die Fortschrittsanzeige stimmt.
  const pages = [];
  for (const file of files) {
    if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
      report(`PDF wird geöffnet: ${file.name}`, 0.02);
      const parts = await pdfPages(file, (number, total) => report(`Seite ${number} von ${total} wird aufbereitet …`, 0.05));
      parts.forEach((part, index) => pages.push({ ...part, name: `${file.name} · Seite ${index + 1}` }));
    } else {
      report(`Bild wird aufbereitet: ${file.name}`, 0.05);
      const image = await loadImage(file);
      pages.push({ kind: "canvas", canvas: enhance(image, image.naturalWidth, image.naturalHeight), name: file.name });
    }
  }

  const needOcr = pages.filter((page) => page.kind === "canvas");
  let done = 0;
  const worker = needOcr.length ? await getWorker() : null;

  for (const page of pages) {
    if (page.kind === "text") {
      result.push({ text: page.text, tsv: "", name: page.name });
      continue;
    }
    const share = 1 / needOcr.length;
    report(`Seite wird gelesen … (${done + 1} von ${needOcr.length})`, 0.1 + done * share * 0.9);
    const { data } = await worker.recognize(page.canvas, {}, { text: true, tsv: true });
    result.push({ text: data.text || "", tsv: data.tsv || "", name: page.name });
    done += 1;
    report(`Seite gelesen (${done} von ${needOcr.length})`, 0.1 + done * share * 0.9);
  }

  report("Fertig gelesen.", 1);
  return result;
}
