/**
 * Bilder und PDF-Dateien in Text mit Positionsangaben umwandeln.
 *
 * Alles läuft im Browser des Geräts: Tesseract für Fotos und Scans,
 * pdf.js für PDF-Dateien. Es verlässt keine Datei das Gerät.
 */

import { entzerre } from "./deskew.js";

const TESS_OPTIONS = {
  workerPath: "./vendor/worker.min.js",
  corePath: "./vendor/",
  langPath: "./tessdata/",
};

let workerPromise = null;

/**
 * Prueft, ob die Texterkennung ueberhaupt geladen wurde.
 *
 * Fehlt der Ordner "vendor" auf dem Server -- der haeufigste Fehler beim
 * Hochladen -- schlaegt das Skript im Seitenkopf still fehl und der Aufruf
 * endet mit "Tesseract is not defined". Diese Meldung hilft niemandem,
 * deshalb wird hier geprueft und im Klartext gesagt, was fehlt.
 */
async function ensureLibraries() {
  if (typeof Tesseract !== "undefined") return;

  const fehlend = [];
  for (const datei of ["./vendor/tesseract.min.js", "./vendor/worker.min.js", "./tessdata/deu.traineddata.gz"]) {
    try {
      const antwort = await fetch(datei, { method: "HEAD" });
      if (!antwort.ok) fehlend.push(`${datei} (Fehler ${antwort.status})`);
    } catch {
      fehlend.push(`${datei} (nicht erreichbar)`);
    }
  }

  const fehler = new Error(fehlend.length
    ? `Nicht gefunden: ${fehlend.join(", ")}.`
    : "Die Dateien sind vorhanden, die Texterkennung ließ sich trotzdem nicht starten.");
  fehler.missing = fehlend;
  throw fehler;
}

async function getWorker(onProgress) {
  await ensureLibraries();
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
function enhance(source, width, height, bereitsSkaliert = false) {
  const target = bereitsSkaliert ? width : Math.min(2600, Math.max(1600, width));
  const scale = target / width;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, canvas.width, canvas.height);

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = pixels.data;
  const histogramm = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    const grau = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
    data[i] = data[i + 1] = data[i + 2] = grau;
    histogramm[grau] += 1;
  }
  if (!gleicheLichtAus(data, canvas.width, canvas.height)) {
    spreizeKontrast(data, canvas.width * canvas.height, histogramm);
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}

/**
 * Kontrast ueber das ganze Bild spreizen (2 %/98 %).
 *
 * Der bisherige Weg, jetzt nur noch Rueckfallebene: Er taugt fuer gleichmaessig
 * belichtete Vorlagen -- eine PDF-Seite, ein Scan -- und fuer alles, was gar
 * nicht nach Papier aussieht. Bei ungleichem Licht richtet er nichts aus,
 * weil er mit einem einzigen Massstab fuer die ganze Seite rechnet.
 */
function spreizeKontrast(data, gesamt, histogramm) {
  let unten = 0;
  let oben = 255;
  let gezaehlt = 0;
  for (let wert = 0; wert < 256; wert += 1) { gezaehlt += histogramm[wert]; if (gezaehlt > gesamt * 0.02) { unten = wert; break; } }
  gezaehlt = 0;
  for (let wert = 255; wert >= 0; wert -= 1) { gezaehlt += histogramm[wert]; if (gezaehlt > gesamt * 0.02) { oben = wert; break; } }
  const spanne = Math.max(24, oben - unten);
  for (let i = 0; i < data.length; i += 4) {
    const gestreckt = Math.min(255, Math.max(0, ((data[i] - unten) / spanne) * 255));
    data[i] = data[i + 1] = data[i + 2] = gestreckt;
  }
}

/**
 * Schatten ausgleichen -- der groesste Hebel bei gefalteten Blaettern.
 *
 * Ein gefalteter Zettel wirft entlang der Bruchkante ein Schattenband. Darin
 * ist die Schrift nicht unscharf, sondern nur dunkler: das Papier hat dort
 * vielleicht den Grauwert 120 statt 250, die Schrift 60 statt 20. Der
 * Abstand zwischen beidem schrumpft, und die Texterkennung liest die Zeile
 * gar nicht mehr oder nur als Umriss -- ganze Terminzeilen fielen so aus.
 *
 * Eine Kontrastspreizung ueber das ganze Bild hilft dagegen nicht. Sie
 * rechnet mit EINEM Hell- und EINEM Dunkelwert fuer die gesamte Seite; das
 * helle Papier neben der Falte haelt den Hellwert oben, und im Schatten
 * bleibt alles, wie es war. Gebraucht wird ein Massstab, der sich von Ort
 * zu Ort mitbewegt.
 *
 * Genau das geschieht hier: Fuer jeden Bildpunkt wird der oertliche
 * Papierton geschaetzt und der Punkt daran gemessen. Wo das Papier dunkel
 * ist, wird kraeftiger aufgehellt als daneben. Die Schaetzung laeuft auf
 * einem auf ein Achtel verkleinerten Bild -- ein Schattenverlauf ist
 * grobkoernig, und die Rechnung kostet so nur ein Sechzigstel; der volle
 * Weg braeuchte fuer ein Integralbild ueber sieben Millionen Punkte
 * dreissig Megabyte allein an Zwischenspeicher.
 */
function gleicheLichtAus(data, breite, hoehe) {
  const TEILER = 8;
  const kb = Math.max(1, Math.ceil(breite / TEILER));
  const kh = Math.max(1, Math.ceil(hoehe / TEILER));

  const summe = new Float64Array(kb * kh);
  const anzahl = new Uint32Array(kb * kh);
  for (let y = 0; y < hoehe; y += 1) {
    const zeile = (y / TEILER) | 0;
    for (let x = 0; x < breite; x += 1) {
      const k = zeile * kb + ((x / TEILER) | 0);
      summe[k] += data[(y * breite + x) * 4];
      anzahl[k] += 1;
    }
  }
  const klein = new Float64Array(kb * kh);
  for (let k = 0; k < klein.length; k += 1) klein[k] = anzahl[k] ? summe[k] / anzahl[k] : 255;

  // Integralbild ueber das verkleinerte Bild: damit kostet jeder Mittelwert
  // vier Zugriffe, unabhaengig von der Fenstergroesse.
  const ib = kb + 1;
  const integral = new Float64Array(ib * (kh + 1));
  for (let y = 0; y < kh; y += 1) {
    let zeilensumme = 0;
    for (let x = 0; x < kb; x += 1) {
      zeilensumme += klein[y * kb + x];
      integral[(y + 1) * ib + (x + 1)] = integral[y * ib + (x + 1)] + zeilensumme;
    }
  }

  // Das Fenster muss deutlich groesser sein als ein Buchstabe, sonst wird
  // der Text selbst zum Massstab und loescht sich weg. Ein Sechstel der
  // Blattbreite liegt weit darueber und bleibt zugleich klein genug, um
  // dem Schattenverlauf einer Falte zu folgen.
  const radius = Math.max(3, Math.round(kb / 6));
  const grund = new Float64Array(kb * kh);
  for (let y = 0; y < kh; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(kh, y + radius + 1);
    for (let x = 0; x < kb; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(kb, x + radius + 1);
      const flaeche = (y1 - y0) * (x1 - x0);
      const wert = integral[y1 * ib + x1] - integral[y0 * ib + x1] - integral[y1 * ib + x0] + integral[y0 * ib + x0];
      grund[y * kb + x] = wert / flaeche;
    }
  }

  // Sieht die Vorlage ueberhaupt nach Papier aus? Das Verfahren setzt voraus,
  // dass der oertliche Grundton das Blatt ist. Bei einer durchweg dunklen
  // Vorlage -- heller Text auf schwarzem Grund, ein missratenes Foto -- trifft
  // das nicht zu; dann wuerde alles zu Weiss und nichts bliebe lesbar.
  const sortiert = Float64Array.from(grund).sort();
  const mitte = sortiert[(sortiert.length / 2) | 0];
  if (mitte < 80) return false;

  // Der oertliche Mittelwert liegt unter dem Papierton, weil Schrift
  // darinsteckt. Ohne Ausgleich bliebe das Papier grau; 1,06 hebt es zurueck
  // auf Weiss, ohne duenne Buchstaben mitzureissen.
  const ZIEL = 255 / 1.06;
  // Deckel auf die Verstaerkung: In einem tiefen Schatten liegt oft nur noch
  // Koernung. Ohne Deckel wird sie zu scheinbaren Buchstaben aufgeblasen, und
  // die Texterkennung haengt "A595" an einen Behandlernamen. Der Faktor drei
  // holt ein Schattenband zurueck und erfindet nichts.
  const MAX_VERSTAERKUNG = 3;
  for (let y = 0; y < hoehe; y += 1) {
    const zeile = ((y / TEILER) | 0) * kb;
    for (let x = 0; x < breite; x += 1) {
      const i = (y * breite + x) * 4;
      const bezug = Math.max(40, grund[zeile + ((x / TEILER) | 0)]);
      const wert = data[i] * Math.min(MAX_VERSTAERKUNG, ZIEL / bezug);
      data[i] = data[i + 1] = data[i + 2] = wert > 255 ? 255 : wert < 0 ? 0 : wert;
    }
  }
  return true;
}

function alsBild(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
    image.src = url;
  });
}

/**
 * Bild aus einer Datei holen.
 *
 * Zwei Wege, weil ein Weg allein nicht reicht: Der uebliche ueber ein
 * Bild-Element scheitert auf manchen Geraeten an HEIC, dem Standardformat der
 * iPhone-Kamera. createImageBitmap kommt in einigen dieser Faelle weiter.
 * Klappt beides nicht, sagt die Meldung, woran es liegt und was hilft --
 * "konnte nicht gelesen werden" allein laesst den Nutzer ratlos zurueck.
 */
async function loadImage(file) {
  try {
    return await alsBild(file);
  } catch {
    // Weiter zum zweiten Weg.
  }
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // Auch das hat nicht geholfen.
    }
  }
  const heic = /\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type || "");
  throw new Error(heic
    ? `„${file.name}" liegt im iPhone-Format HEIC vor, das dieses Gerät nicht öffnen kann. Abhilfe: das Bild in der Fotos-App über „Teilen → Bild sichern" als JPEG ablegen, oder unter Einstellungen → Kamera → Formate auf „Maximale Kompatibilität" umstellen.`
    : `„${file.name}" konnte nicht als Bild geöffnet werden. Bitte ein JPEG oder PNG wählen.`);
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

/**
 * Oeffnet ein PDF und liefert je Seite eine Aufgabe -- ohne sie schon zu
 * zeichnen. Das Zeichnen passiert erst unmittelbar vor der Erkennung, damit
 * nie mehr als eine Seite gleichzeitig im Speicher liegt.
 */
async function pdfTasks(file) {
  const pdfjs = await getPdfjs();
  const buffer = await file.arrayBuffer();
  const document_ = await pdfjs.getDocument({ data: buffer }).promise;
  const tasks = [];
  for (let number = 1; number <= document_.numPages; number += 1) {
    tasks.push({
      name: `${file.name} · Seite ${number}`,
      async load() {
        const page = await document_.getPage(number);

        // Enthaelt das PDF bereits eine Textebene, ist sie jeder OCR ueberlegen.
        const textContent = await page.getTextContent();
        const embedded = textContent.items.map((item) => item.str).join(" ").trim();
        if (embedded.length > 60) return { kind: "text", text: layoutText(textContent) };

        const viewport = page.getViewport({ scale: 2.2 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        // PDF-Seiten sind bereits rechtwinklig; eine Entzerrung waere hier
        // nur ein zusaetzlicher Abtastschritt und wuerde Schaerfe kosten.
        const enhanced = enhance(canvas, canvas.width, canvas.height);
        release(canvas);
        return { kind: "canvas", canvas: enhanced };
      },
    });
  }
  return tasks;
}

/** Gibt den Speicher eines Canvas sofort frei, statt auf den Sammler zu warten. */
function release(canvas) {
  canvas.width = 0;
  canvas.height = 0;
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
  const report = (label, ratio) => onProgress?.({ label, ratio: Math.min(1, Math.max(0, ratio)) });

  // Schritt 1: Aufgabenliste bilden, ohne Bilder zu erzeugen. Ein Handyfoto
  // belegt aufbereitet gut 35 MB; sechs Seiten auf einmal im Speicher zu
  // halten laesst die App auf dem Telefon abbrechen.
  const tasks = [];
  for (const file of files) {
    if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
      report(`PDF wird geöffnet: ${file.name}`, 0.02);
      tasks.push(...await pdfTasks(file));
    } else {
      tasks.push({
        name: file.name,
        async load(onSchritt) {
          const image = await loadImage(file);
          // Zuerst das Blatt geradeziehen: eine schiefe Aufnahme laesst die
          // Tabellenspalten gegeneinander verrutschen, und daran scheitert
          // jede weitere Auswertung.
          // Ein Bild-Element meldet seine Groesse als naturalWidth, ein
          // ImageBitmap -- der zweite Weg in loadImage -- nur als width.
          // Wer das verwechselt, rechnet mit undefined weiter und bekommt
          // spaeter "Value is not of type 'long'" aus getImageData.
          const breiteRoh = image.naturalWidth || image.width;
          const hoeheRoh = image.naturalHeight || image.height;
          if (!Number.isFinite(breiteRoh) || !Number.isFinite(hoeheRoh) || breiteRoh < 1 || hoeheRoh < 1) {
            throw new Error(`Die Groesse von „${file.name}" liess sich nicht bestimmen. Bitte ein JPEG oder PNG waehlen.`);
          }
          const gerade = await entzerre(image, breiteRoh, hoeheRoh, undefined, onSchritt);
          const quelle = gerade.canvas || image;
          const breite = gerade.canvas ? gerade.canvas.width : breiteRoh;
          const hoehe = gerade.canvas ? gerade.canvas.height : hoeheRoh;
          // Ein entzerrtes Bild hat bereits die richtige Groesse; enhance
          // wuerde es sonst ein zweites Mal abtasten.
          const fertig = enhance(quelle, breite, hoehe, gerade.entzerrt);
          if (gerade.canvas) release(gerade.canvas);
          return { kind: "canvas", canvas: fertig, entzerrt: gerade.entzerrt };
        },
      });
    }
  }

  // Schritt 2: jede Seite einzeln aufbereiten, lesen und wieder freigeben.
  const result = [];
  let worker = null;
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    const base = index / tasks.length;
    const share = 1 / tasks.length;

    report(`Seite ${index + 1} von ${tasks.length} wird aufbereitet …`, base + share * 0.15);
    const page = await task.load((anteil) =>
      report(`Seite ${index + 1} von ${tasks.length} wird geradegezogen … ${Math.round(anteil * 100)} %`,
        base + share * (0.05 + 0.15 * anteil)));
    if (page.entzerrt) report(`Seite ${index + 1}: Blatt erkannt und geradegezogen.`, base + share * 0.25);

    if (page.kind === "text") {
      result.push({ text: page.text, tsv: "", name: task.name });
      report(`Seite ${index + 1} von ${tasks.length} gelesen.`, base + share);
      continue;
    }

    worker ||= await getWorker();
    report(`Seite ${index + 1} von ${tasks.length} wird gelesen …`, base + share * 0.35);
    try {
      const { data } = await worker.recognize(page.canvas, {}, { text: true, tsv: true });
      result.push({ text: data.text || "", tsv: data.tsv || "", name: task.name, entzerrt: Boolean(page.entzerrt) });
    } finally {
      release(page.canvas);
    }
    report(`Seite ${index + 1} von ${tasks.length} gelesen.`, base + share);
  }

  report("Fertig gelesen.", 1);
  return result;
}
