/**
 * Blatterkennung und perspektivische Entzerrung.
 *
 * Ein Handyfoto zeigt das Blatt fast nie rechtwinklig: es liegt schief, wölbt
 * sich, wird aus der Hand aufgenommen. Fuer die Texterkennung ist das der
 * grosse Stoerfaktor -- die Spalten einer Tabelle rutschen gegeneinander, und
 * die Behandlerspalte landet in der Zeile darunter.
 *
 * Hier wird das Blatt im Bild gesucht und auf ein Rechteck zurueckgerechnet.
 * Findet sich keine plausible Blattkontur, bleibt das Bild unveraendert --
 * ein falsch entzerrtes Bild waere schlechter als ein schiefes.
 */

/** Groesse, auf die zur Analyse verkleinert wird. Mehr bringt nichts. */
const ANALYSE_BREITE = 640;

/**
 * Breite des entzerrten Bildes. Die Texterkennung arbeitet in dieser
 * Groessenordnung am besten; direkt darauf zu entzerren spart gegenueber
 * "erst entzerren, dann verkleinern" einen Abtastschritt, viel Rechenzeit
 * und ein Vielfaches an Speicher.
 */
const ZIEL_BREITE = 2600;

/**
 * Ab welcher Verzerrung ueberhaupt entzerrt wird.
 *
 * Die Umrechnung tastet das Bild neu ab und kostet dabei etwas Schaerfe --
 * bei einer leicht schiefen Aufnahme schadet sie mehr, als sie nuetzt, weil
 * die Zeilenzusammenfuehrung solche Faelle ohnehin auffaengt. Der Wert wurde
 * an Testaufnahmen bestimmt und unten in der Datei belegt.
 */
const KIPPUNG_SCHWELLE = 0.12;

/* ------------------------------------------------------------ Blatt finden */

/** Schwellwert nach Otsu: trennt helles Papier vom dunkleren Hintergrund. */
function otsu(histogramm, gesamt) {
  let summe = 0;
  for (let i = 0; i < 256; i += 1) summe += i * histogramm[i];

  let summeHintergrund = 0;
  let anzahlHintergrund = 0;
  let bestesMass = -1;
  let schwelle = 128;

  for (let i = 0; i < 256; i += 1) {
    anzahlHintergrund += histogramm[i];
    if (!anzahlHintergrund) continue;
    const anzahlVordergrund = gesamt - anzahlHintergrund;
    if (!anzahlVordergrund) break;

    summeHintergrund += i * histogramm[i];
    const mittelHintergrund = summeHintergrund / anzahlHintergrund;
    const mittelVordergrund = (summe - summeHintergrund) / anzahlVordergrund;
    const mass = anzahlHintergrund * anzahlVordergrund * (mittelHintergrund - mittelVordergrund) ** 2;
    if (mass > bestesMass) {
      bestesMass = mass;
      schwelle = i;
    }
  }
  return schwelle;
}

/**
 * Sucht die groesste zusammenhaengende helle Flaeche -- das Blatt.
 * Iterativer Flutfuellalgorithmus, damit tiefe Rekursion nicht den
 * Aufrufstapel sprengt.
 */
function groessteFlaeche(hell, breite, hoehe) {
  const besucht = new Uint8Array(breite * hoehe);
  const stapel = new Int32Array(breite * hoehe);
  let beste = null;

  for (let start = 0; start < hell.length; start += 1) {
    if (!hell[start] || besucht[start]) continue;

    let oben = 0;
    stapel[oben++] = start;
    besucht[start] = 1;
    const flaeche = [];

    while (oben > 0) {
      const index = stapel[--oben];
      flaeche.push(index);
      const x = index % breite;
      const y = (index / breite) | 0;

      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= breite || ny >= hoehe) continue;
        const nachbar = ny * breite + nx;
        if (hell[nachbar] && !besucht[nachbar]) {
          besucht[nachbar] = 1;
          stapel[oben++] = nachbar;
        }
      }
    }

    if (!beste || flaeche.length > beste.length) beste = flaeche;
  }
  return beste;
}

/**
 * Die vier Ecken eines Vierecks aus einer Punktmenge.
 * Die Extrema von x+y und x-y treffen die Ecken eines gekippten Rechtecks
 * zuverlaessig und kommen ohne echte Konturverfolgung aus.
 */
function eckenAus(flaeche, breite) {
  let obenLinks = null;
  let obenRechts = null;
  let untenRechts = null;
  let untenLinks = null;
  let minSumme = Infinity;
  let maxSumme = -Infinity;
  let minDiff = Infinity;
  let maxDiff = -Infinity;

  for (const index of flaeche) {
    const x = index % breite;
    const y = (index / breite) | 0;
    const summe = x + y;
    const diff = x - y;
    if (summe < minSumme) { minSumme = summe; obenLinks = [x, y]; }
    if (summe > maxSumme) { maxSumme = summe; untenRechts = [x, y]; }
    if (diff > maxDiff) { maxDiff = diff; obenRechts = [x, y]; }
    if (diff < minDiff) { minDiff = diff; untenLinks = [x, y]; }
  }
  return [obenLinks, obenRechts, untenRechts, untenLinks];
}

const abstand = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Flaeche eines Vierecks nach der Trapezformel. */
function vierecksFlaeche(ecken) {
  let summe = 0;
  for (let i = 0; i < 4; i += 1) {
    const [x1, y1] = ecken[i];
    const [x2, y2] = ecken[(i + 1) % 4];
    summe += x1 * y2 - x2 * y1;
  }
  return Math.abs(summe) / 2;
}

/**
 * Prueft, ob die gefundenen Ecken wirklich ein Blatt beschreiben.
 * Im Zweifel wird nicht entzerrt.
 */
function istPlausibel(ecken, breite, hoehe) {
  if (ecken.some((ecke) => !ecke)) return false;

  // Das Blatt muss einen erheblichen Teil des Bildes ausmachen.
  const anteil = vierecksFlaeche(ecken) / (breite * hoehe);
  if (anteil < 0.25 || anteil > 0.995) return false;

  // Keine zwei Ecken duerfen zusammenfallen.
  const kanten = [
    abstand(ecken[0], ecken[1]), abstand(ecken[1], ecken[2]),
    abstand(ecken[2], ecken[3]), abstand(ecken[3], ecken[0]),
  ];
  if (kanten.some((laenge) => laenge < Math.min(breite, hoehe) * 0.2)) return false;

  // Gegenueberliegende Kanten aehnlich lang -- sonst ist es kein Blatt,
  // sondern etwa ein Lichtfleck.
  if (Math.max(kanten[0], kanten[2]) / Math.min(kanten[0], kanten[2]) > 1.8) return false;
  if (Math.max(kanten[1], kanten[3]) / Math.min(kanten[1], kanten[3]) > 1.8) return false;

  return true;
}

/* -------------------------------------------------------- Homographie */

/** Loest ein lineares Gleichungssystem mit Gauss-Elimination. */
function loese(matrix, vektor) {
  const n = vektor.length;
  const a = matrix.map((zeile, i) => [...zeile, vektor[i]]);

  for (let spalte = 0; spalte < n; spalte += 1) {
    let pivot = spalte;
    for (let zeile = spalte + 1; zeile < n; zeile += 1) {
      if (Math.abs(a[zeile][spalte]) > Math.abs(a[pivot][spalte])) pivot = zeile;
    }
    if (Math.abs(a[pivot][spalte]) < 1e-10) return null;
    [a[spalte], a[pivot]] = [a[pivot], a[spalte]];

    for (let zeile = 0; zeile < n; zeile += 1) {
      if (zeile === spalte) continue;
      const faktor = a[zeile][spalte] / a[spalte][spalte];
      for (let k = spalte; k <= n; k += 1) a[zeile][k] -= faktor * a[spalte][k];
    }
  }
  return a.map((zeile, i) => zeile[n] / zeile[i]);
}

/**
 * Homographie, die die vier Zielecken auf die vier Quellecken abbildet.
 * Gerechnet wird rueckwaerts: fuer jeden Zielpunkt wird der Quellpunkt
 * gesucht, aus dem seine Farbe stammt.
 */
function homographie(ziel, quelle) {
  const matrix = [];
  const vektor = [];
  for (let i = 0; i < 4; i += 1) {
    const [u, v] = ziel[i];
    const [x, y] = quelle[i];
    matrix.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    vektor.push(x);
    matrix.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    vektor.push(y);
  }
  return loese(matrix, vektor);
}

/* ------------------------------------------------------------ Hauptweg */

/**
 * Entzerrt ein Bild, wenn darin ein Blatt erkennbar ist.
 *
 * @param {HTMLImageElement|HTMLCanvasElement} quelle
 * @param {number} breite
 * @param {number} hoehe
 * @returns {{canvas: HTMLCanvasElement, entzerrt: boolean}}
 */
export function entzerre(quelle, breite, hoehe, zielBreiteMax = ZIEL_BREITE) {
  const skalierung = ANALYSE_BREITE / breite;
  const kleinBreite = Math.max(1, Math.round(breite * skalierung));
  const kleinHoehe = Math.max(1, Math.round(hoehe * skalierung));

  const klein = document.createElement("canvas");
  klein.width = kleinBreite;
  klein.height = kleinHoehe;
  const kleinCtx = klein.getContext("2d", { willReadFrequently: true });
  kleinCtx.drawImage(quelle, 0, 0, kleinBreite, kleinHoehe);

  const daten = kleinCtx.getImageData(0, 0, kleinBreite, kleinHoehe).data;
  const grau = new Uint8Array(kleinBreite * kleinHoehe);
  const histogramm = new Uint32Array(256);
  for (let i = 0, p = 0; i < daten.length; i += 4, p += 1) {
    const wert = (0.299 * daten[i] + 0.587 * daten[i + 1] + 0.114 * daten[i + 2]) | 0;
    grau[p] = wert;
    histogramm[wert] += 1;
  }

  const schwelle = otsu(histogramm, grau.length);
  const hell = new Uint8Array(grau.length);
  for (let i = 0; i < grau.length; i += 1) hell[i] = grau[i] > schwelle ? 1 : 0;

  const flaeche = groessteFlaeche(hell, kleinBreite, kleinHoehe);
  klein.width = 0;
  klein.height = 0;

  if (!flaeche || flaeche.length < grau.length * 0.2) return { canvas: null, entzerrt: false };

  const eckenKlein = eckenAus(flaeche, kleinBreite);
  if (!istPlausibel(eckenKlein, kleinBreite, kleinHoehe)) return { canvas: null, entzerrt: false };

  // Ecken auf die Originalaufloesung zurueckrechnen.
  const ecken = eckenKlein.map(([x, y]) => [x / skalierung, y / skalierung]);

  // Zielgroesse aus den mittleren Kantenlaengen -- so bleibt das
  // Seitenverhaeltnis des Blattes erhalten. Nach oben begrenzt, damit aus
  // einem sehr grossen Foto kein riesiges Zwischenbild entsteht.
  const rohBreite = (abstand(ecken[0], ecken[1]) + abstand(ecken[3], ecken[2])) / 2;
  const rohHoehe = (abstand(ecken[0], ecken[3]) + abstand(ecken[1], ecken[2])) / 2;
  const faktor = Math.min(1, zielBreiteMax / rohBreite);
  const zielBreite = Math.round(rohBreite * faktor);
  const zielHoehe = Math.round(rohHoehe * faktor);
  if (zielBreite < 200 || zielHoehe < 200) return { canvas: null, entzerrt: false };

  const h = homographie(
    [[0, 0], [zielBreite, 0], [zielBreite, zielHoehe], [0, zielHoehe]],
    ecken,
  );
  if (!h) return { canvas: null, entzerrt: false };

  // War die Verzerrung minimal, lohnt das Umrechnen nicht -- jede
  // Neuabtastung kostet ein wenig Schaerfe.
  const kippung = Math.max(
    Math.abs(ecken[0][1] - ecken[1][1]) / zielBreite,
    Math.abs(ecken[3][1] - ecken[2][1]) / zielBreite,
    Math.abs(ecken[0][0] - ecken[3][0]) / zielHoehe,
    Math.abs(ecken[1][0] - ecken[2][0]) / zielHoehe,
  );
  if (kippung < KIPPUNG_SCHWELLE) return { canvas: null, entzerrt: false, kippung };

  return { canvas: zeichneEntzerrt(quelle, breite, hoehe, h, zielBreite, zielHoehe), entzerrt: true, kippung };
}

/**
 * Wendet die Homographie an, mit bilinearer Abtastung.
 *
 * Die Quelle wird dafuer zuerst auf eine handliche Groesse gebracht. Ein
 * Foto mit 45 Megapixeln als Canvas zu halten kostet ueber 180 MB allein
 * fuer die Bilddaten -- und nochmal so viel fuer die Kopie, die zum Lesen
 * noetig ist. Fuer ein Ziel von 2600 Pixeln Breite genuegt gut das
 * Anderthalbfache an Quellaufloesung.
 */
/**
 * Groesste Flaeche, die ein Canvas haben darf -- in Bildpunkten.
 *
 * Safari auf iPhone und iPad begrenzt die Flaeche eines Canvas hart auf rund
 * 16,7 Megapixel. Wird die Grenze ueberschritten, kommt keine Fehlermeldung:
 * getImageData liefert ein leeres Bild zurueck, und die Texterkennung findet
 * auf einer weissen Flaeche nichts. Auf einem Rechner faellt das nie auf,
 * dort gibt es diese Grenze nicht.
 *
 * Der Wert liegt bewusst deutlich darunter, denn neben der Quelle liegt
 * gleichzeitig das entzerrte Zielbild im Speicher, und beide werden als
 * Bilddaten kopiert -- vier Byte je Bildpunkt.
 */
const MAX_QUELL_FLAECHE = 12e6;

function zeichneEntzerrt(quelle, breite, hoehe, h, zielBreite, zielHoehe) {
  // Grosszuegig gewaehlt: Jede Verkleinerung vor der Transformation kostet
  // Schaerfe, die die spaetere Abtastung nicht zurueckholt. Erst bei sehr
  // grossen Aufnahmen wird ueberhaupt verkleinert -- ein uebliches
  // Handyfoto mit 12 Megapixeln bleibt unangetastet.
  const maxQuelle = Math.max(4500, zielBreite * 2);
  // Neben der Breite begrenzt auch die Flaeche. Ein iPhone liefert je nach
  // Modell 24 oder 48 Megapixel; ohne diese Schranke entstuende ein Canvas,
  // das Safari nicht mehr zeichnet.
  const schrumpf = Math.min(
    1,
    maxQuelle / breite,
    Math.sqrt(MAX_QUELL_FLAECHE / (breite * hoehe)),
  );
  const quellBreite = Math.max(1, Math.round(breite * schrumpf));
  const quellHoehe = Math.max(1, Math.round(hoehe * schrumpf));

  const quellCanvas = document.createElement("canvas");
  quellCanvas.width = quellBreite;
  quellCanvas.height = quellHoehe;
  const quellCtx = quellCanvas.getContext("2d", { willReadFrequently: true });
  quellCtx.imageSmoothingQuality = "high";
  quellCtx.drawImage(quelle, 0, 0, quellBreite, quellHoehe);
  const quellDaten = quellCtx.getImageData(0, 0, quellBreite, quellHoehe).data;

  const ziel = document.createElement("canvas");
  ziel.width = zielBreite;
  ziel.height = zielHoehe;
  const zielCtx = ziel.getContext("2d", { willReadFrequently: true });
  const zielBild = zielCtx.createImageData(zielBreite, zielHoehe);
  const zielDaten = zielBild.data;

  const [a, b, c, d, e, f, g, i] = h;
  for (let v = 0; v < zielHoehe; v += 1) {
    for (let u = 0; u < zielBreite; u += 1) {
      const nenner = g * u + i * v + 1;
      // Die Homographie liefert Koordinaten im Originalbild; sie werden auf
      // die verkleinerte Quelle umgerechnet.
      const x = ((a * u + b * v + c) / nenner) * schrumpf;
      const y = ((d * u + e * v + f) / nenner) * schrumpf;
      const ziffer = (v * zielBreite + u) * 4;

      if (x < 0 || y < 0 || x >= quellBreite - 1 || y >= quellHoehe - 1) {
        zielDaten[ziffer] = zielDaten[ziffer + 1] = zielDaten[ziffer + 2] = 255;
        zielDaten[ziffer + 3] = 255;
        continue;
      }

      const x0 = x | 0;
      const y0 = y | 0;
      const fx = x - x0;
      const fy = y - y0;
      const p00 = (y0 * quellBreite + x0) * 4;
      const p10 = p00 + 4;
      const p01 = p00 + quellBreite * 4;
      const p11 = p01 + 4;

      for (let kanal = 0; kanal < 3; kanal += 1) {
        const oben = quellDaten[p00 + kanal] * (1 - fx) + quellDaten[p10 + kanal] * fx;
        const unten = quellDaten[p01 + kanal] * (1 - fx) + quellDaten[p11 + kanal] * fx;
        zielDaten[ziffer + kanal] = oben * (1 - fy) + unten * fy;
      }
      zielDaten[ziffer + 3] = 255;
    }
  }

  zielCtx.putImageData(zielBild, 0, 0);
  quellCanvas.width = 0;
  quellCanvas.height = 0;
  return ziel;
}
