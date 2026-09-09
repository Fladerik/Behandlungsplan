/**
 * Aus einem OCR-Ergebnis wird ein Tagesplan.
 *
 * Der frühere Ansatz hat globale Spaltengrenzen aus gefundenen Überschriften
 * geraten. Fehlte eine Überschrift oder war sie verlesen, rutschten alle
 * Spalten -- daraus entstanden falsche Namen und leere Titel.
 *
 * Dieser Parser arbeitet zeilenweise:
 *   1. Wörter werden zu Zeilen gruppiert (das ist die stabilste OCR-Information).
 *   2. Innerhalb einer Zeile trennen die tatsächlichen Wortabstände die Zellen.
 *   3. Jede Zelle wird inhaltlich eingeordnet (Ort? Person? Anwendung?),
 *      nicht über ihre x-Position.
 *   4. Bekannte Begriffe aus früheren, bestätigten Plänen korrigieren Verlesungen.
 */

import { CATEGORIES } from "./store.js";

/* ------------------------------------------------------------- Wörterbücher */

const MONTHS = {
  januar: 1, jan: 1, februar: 2, feb: 2, "märz": 3, maerz: 3, mrz: 3, april: 4, apr: 4,
  mai: 5, juni: 6, jun: 6, juli: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10, november: 11, nov: 11, dezember: 12, dez: 12,
};

const WEEKDAYS = ["sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag"];

// Ein Ort beginnt typischerweise mit einem Ortswort ("Raum 214", "Haus 2")
// oder ist ein einzelnes zusammengesetztes Wort ("Speisesaal", "Turnhalle").
const LOCATION_START = /^(raum|zimmer|halle|bad|becken|kabine|station|geb\u00e4ude|gebaeude|haus|saal|treffpunkt|therapiezentrum|bewegungsbad|ebene|stock|etage|flur|trakt|praxis|ambulanz|turnhalle|gymnastikraum|wartebereich|empfang|foyer|liegehalle|sauna|schwimmbad|speisesaal|aufenthaltsraum|schulungsraum|sporthalle|lehrk\u00fcche)\b/i;

const LOCATION_SUFFIX = /(raum|saal|halle|zimmer|bad|becken|kabine|studio|k\u00fcche|garten|terrasse|bereich|platz)$/i;

// Zellen mit einem Behandlungsbegriff sind niemals Ortsangaben --
// sonst landet "Krankengymnastik im Bewegungsbad" in der Ortsspalte.
const TREATMENT_HINT = /(therapie|training|gymnastik|massage|packung|beratung|vortrag|schulung|gespr\u00e4ch|visite|untersuchung|drainage|anwendung|kurs|essen|walking|schwimmen|entspannung|inhalation)/i;

const ROOM_CODE = /^(?:[A-Z\u00c4\u00d6\u00dc]{1,3}[-\s]?\d{1,3}[a-z]?|\d{1,3}[a-z]?)$/;

const TITLE_PREFIX = /\b(dr|dr\.|prof|prof\.|frau|herr|hr|fr|dipl|med|univ)\b/i;

/** Anwendungen, die auf Reha-Plänen im deutschsprachigen Raum üblich sind. */
const KNOWN_TREATMENTS = [
  "Krankengymnastik", "Krankengymnastik im Bewegungsbad", "Bewegungsbad", "Wassergymnastik",
  "Aquajogging", "Medizinische Trainingstherapie", "Gerätetraining", "Ergometertraining",
  "Nordic Walking", "Terraintraining", "Wirbelsäulengymnastik", "Rückenschule",
  "Atemtherapie", "Ergotherapie", "Physiotherapie", "Manuelle Therapie", "Manuelle Lymphdrainage",
  "Klassische Massage", "Teilmassage", "Unterwasserdruckstrahlmassage", "Bindegewebsmassage",
  "Fangopackung", "Moorpackung", "Naturmoorbad", "Heißluft", "Rotlicht", "Kryotherapie",
  "Elektrotherapie", "Ultraschall", "Inhalation", "Kohlensäurebad", "Solebad", "Vierzellenbad",
  "Stangerbad", "Kneippanwendung", "Wechselbad", "Entspannungstraining", "Progressive Muskelentspannung",
  "Autogenes Training", "Yoga", "Qigong", "Tai Chi", "Rückenkurs", "Gesundheitsvortrag",
  "Ernährungsberatung", "Ernährungsvortrag", "Lehrküche", "Diätberatung", "Sozialberatung",
  "Psychologisches Einzelgespräch", "Gesprächsgruppe", "Schulung", "Visite", "Arztgespräch",
  "Aufnahmeuntersuchung", "Abschlussuntersuchung", "Blutentnahme", "Belastungs-EKG", "EKG",
  "Lungenfunktion", "Röntgen", "Ultraschalluntersuchung", "Sprechstunde",
  "Frühstück", "Mittagessen", "Abendessen", "Zwischenmahlzeit", "Anreise", "Abreise",
];

// Reihenfolge ist bedeutsam: die erste passende Regel gewinnt.
// Bewegung steht vor Massage, damit "Krankengymnastik im Bewegungsbad"
// nicht wegen des Wortteils "bad" als Anwendung einsortiert wird.
const CATEGORY_RULES = [
  { id: "essen", pattern: /(fr\u00fchst\u00fcck|fruehstueck|mittagessen|abendessen|mahlzeit|lehrk\u00fcche|kaffeetafel)/i },
  { id: "medizin", pattern: /(visite|arzt|\u00e4rztlich|aerztlich|untersuchung|\bekg\b|labor|blutentnahme|r\u00f6ntgen|sonograf|sonograph|lungenfunktion|sprechstunde|aufnahmegespr\u00e4ch|abschlussgespr\u00e4ch|befund|diagnos)/i },
  { id: "bewegung", pattern: /(gymnastik|training|sport|walking|schwimm|bewegungsbad|aquajogging|ergometer|fahrrad|terrain|wandern|yoga|qigong|tai\s?chi|physiotherapie|krankengymnastik|manuelle\s+therapie|ergotherapie|atemtherapie|r\u00fcckenschule|muskelentspannung)/i },
  { id: "massage", pattern: /(massage|packung|fango|moor|lymphdrainage|hei\u00dfluft|heissluft|rotlicht|wickel|b\u00fcrstenbad|kryo|elektrotherapie|ultraschall|stangerbad|vierzellenbad|inhalation|\bbad\b|\bb\u00e4der\b|solebad|kohlens\u00e4ure)/i },
  { id: "beratung", pattern: /(beratung|vortrag|schulung|seminar|gespr\u00e4ch|gruppe|psycholog|sozialdienst|ern\u00e4hrung|di\u00e4t|entspannung|autogenes|information|einf\u00fchrung)/i },
];

/* ----------------------------------------------------------------- Basics */

const clean = (value = "") => String(value)
  .replace(/[|¦]/g, " ")
  .replace(/[‐‑–—]/g, "-")
  .replace(/\s+/g, " ")
  .trim();

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);

export function categorize(title = "", note = "") {
  const text = `${title} ${note}`;
  const hit = CATEGORY_RULES.find((rule) => rule.pattern.test(text));
  return hit ? hit.id : "sonstiges";
}

export const categoryLabel = (id) => CATEGORIES.find((entry) => entry.id === id)?.label || "Sonstiges";

/** OCR verwechselt Ziffern regelmäßig mit Buchstaben -- hier gezielt zurückdrehen. */
export function normalizeTime(raw = "") {
  const candidate = String(raw)
    .replace(/[oO°]/g, "0").replace(/[lI|]/g, "1").replace(/[sS]/g, "5").replace(/[B]/g, "8")
    .replace(/\s+/g, "")
    .replace(/[.,;]/g, ":")
    .replace(/^(\d{1,2}):?(\d{2})(?:uhr)?$/i, "$1:$2");
  const match = candidate.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return "";
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return "";
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function parseGermanDate(text, fallbackYear = new Date().getFullYear()) {
  const source = String(text || "");
  const numeric = source.match(/\b([0-3]?\d)\s*[.\/-]\s*([01]?\d)\s*[.\/-]\s*((?:20)?\d{2})\b/);
  if (numeric) {
    const year = numeric[3].length === 2 ? Number(`20${numeric[3]}`) : Number(numeric[3]);
    return iso(year, Number(numeric[2]), Number(numeric[1]));
  }
  const written = source.toLocaleLowerCase("de-DE")
    .match(/\b([0-3]?\d)\.?\s*(januar|jan|februar|feb|märz|maerz|mrz|april|apr|mai|juni|jun|juli|jul|august|aug|september|sept|sep|oktober|okt|november|nov|dezember|dez)\.?\s*((?:20)?\d{2})?/);
  if (written) {
    const month = MONTHS[written[2]];
    const rawYear = written[3];
    const year = rawYear ? (rawYear.length === 2 ? Number(`20${rawYear}`) : Number(rawYear)) : fallbackYear;
    return iso(year, month, Number(written[1]));
  }
  const short = source.match(/\b([0-3]?\d)\s*\.\s*([01]?\d)\s*\.(?!\d)/);
  if (short) return iso(fallbackYear, Number(short[2]), Number(short[1]));
  return "";
}

function iso(year, month, day) {
  if (!year || !month || !day || month > 12 || day > 31) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function weekdayOf(isoDate) {
  return WEEKDAYS[new Date(`${isoDate}T12:00:00`).getDay()];
}

/** Prüft, ob im Text ein Wochentag steht, der zum erkannten Datum passt. */
export function dateMatchesWeekday(isoDate, text) {
  const lower = String(text).toLocaleLowerCase("de-DE");
  const named = WEEKDAYS.find((day) => lower.includes(day) || lower.includes(day.slice(0, 2) + "."));
  if (!named || !isoDate) return null;
  return named === weekdayOf(isoDate);
}

/* ------------------------------------------------- Ähnlichkeit / Lexikon */

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

const foldForCompare = (value) => value.toLocaleLowerCase("de-DE")
  .replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss")
  .replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

/**
 * Sucht den ähnlichsten bekannten Begriff. Toleranz wächst mit der Wortlänge,
 * bleibt aber eng genug, dass "Bad 2" nicht zu "Bad 3" wird.
 */
export function bestMatch(value, candidates) {
  const needle = foldForCompare(value);
  if (needle.length < 4) return null;
  const budget = needle.length <= 6 ? 1 : needle.length <= 12 ? 2 : 3;
  let best = null;
  for (const candidate of candidates) {
    const hay = foldForCompare(candidate);
    if (!hay) continue;
    if (hay === needle) return { value: candidate, distance: 0 };
    if (Math.abs(hay.length - needle.length) > budget) continue;
    const distance = levenshtein(needle, hay);
    if (distance <= budget && (!best || distance < best.distance)) best = { value: candidate, distance };
  }
  return best;
}

/**
 * Korrigiert einen erkannten Text gegen bekannte Begriffe.
 * Gibt zusätzlich zurück, ob korrigiert wurde -- die Prüfansicht markiert das.
 */
export function correct(value, field, lexicon = {}) {
  const text = clean(value);
  if (!text) return { value: "", corrected: false };
  const learned = Object.entries(lexicon[field] || {}).sort((a, b) => b[1] - a[1]).map(([term]) => term);
  const pool = field === "title" ? [...learned, ...KNOWN_TREATMENTS] : learned;
  const match = bestMatch(text, pool);
  if (match && match.distance > 0) return { value: match.value, corrected: true, from: text };
  return { value: text, corrected: false };
}

/* ------------------------------------------------------- TSV -> Textzeilen */

function tsvLines(tsv) {
  const rows = String(tsv || "").split(/\r?\n/).slice(1);
  const groups = new Map();
  for (const row of rows) {
    const cells = row.split("\t");
    if (cells.length < 12 || cells[0] !== "5") continue;
    const text = clean(cells.slice(11).join("\t"));
    const confidence = Number(cells[10]);
    if (!text || !(confidence > 20)) continue;
    const key = `${cells[1]}-${cells[2]}-${cells[3]}-${cells[4]}`;
    const word = {
      text,
      confidence,
      left: Number(cells[6]),
      top: Number(cells[7]),
      width: Number(cells[8]),
      height: Number(cells[9]),
    };
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(word);
  }
  return [...groups.values()]
    .map((words) => {
      words.sort((a, b) => a.left - b.left);
      return {
        words,
        top: Math.min(...words.map((word) => word.top)),
        bottom: Math.max(...words.map((word) => word.top + word.height)),
        left: words[0].left,
        height: Math.max(...words.map((word) => word.height)),
        text: words.map((word) => word.text).join(" "),
        confidence: Math.round(words.reduce((sum, word) => sum + word.confidence, 0) / words.length),
      };
    })
    .filter((line) => line.text)
    .sort((a, b) => a.top - b.top);
}

/**
 * Holt die führende Uhrzeit aus einer Zeile ("08:30", "09:15 - 10:00", "9.15 Uhr").
 * Bewusst wortweise statt über Spaltenpositionen: stehen Zeit- und Hausspalte
 * eng beieinander, verschmelzen sie sonst zu einer Zelle und die Zeit geht verloren.
 */
function extractTime(words) {
  const first = words[0]?.text || "";

  // Häufigster Fall bei Tabellen: die Texterkennung liefert die ganze Spanne
  // als ein Wort ("09:15-10:00"). Das zuerst prüfen.
  const span = first.split(/[-\u2013\u2014]/);
  if (span.length === 2) {
    const from = normalizeTime(span[0]);
    const to = normalizeTime(span[1]);
    if (from) return { time: from, end: to, rest: words.slice(/^uhr$/i.test(words[1]?.text || "") ? 2 : 1) };
  }

  const time = normalizeTime(first);
  if (!time) return null;
  let used = 1;
  let end = "";
  const second = words[1]?.text || "";
  if (/^[-–]$/.test(second)) {
    end = normalizeTime(words[2]?.text || "");
    if (end) used = 3;
  } else if (/^[-–]/.test(second)) {
    end = normalizeTime(second.replace(/^[-–]\s*/, ""));
    if (end) used = 2;
  }
  if (/^uhr$/i.test(words[used]?.text || "")) used += 1;
  return { time, end, rest: words.slice(used) };
}

/**
 * Zerlegt eine Zeile an den tatsächlichen Lücken zwischen den Wörtern.
 * Der Schwellwert leitet sich aus der Schrifthöhe ab und funktioniert damit
 * unabhängig von Auflösung und Zoom.
 */
function splitCells(words, height) {
  if (!words.length) return [];
  const gapLimit = Math.max(height * 0.9, 16);
  const cells = [];
  let current = [words[0]];
  for (let index = 1; index < words.length; index += 1) {
    const previous = words[index - 1];
    const word = words[index];
    const gap = word.left - (previous.left + previous.width);
    if (gap > gapLimit) {
      cells.push(current);
      current = [];
    }
    current.push(word);
  }
  cells.push(current);
  return cells
    .map((words) => ({
      text: clean(words.map((word) => word.text).join(" ")),
      left: words[0].left,
      right: words.at(-1).left + words.at(-1).width,
      confidence: Math.round(words.reduce((sum, word) => sum + word.confidence, 0) / words.length),
    }))
    .filter((cell) => cell.text);
}

/* --------------------------------------------------- Zellen einordnen */

const isHeaderLine = (text) => /^(uhrzeit|zeit|beginn|von|bis|anwendung|therapie|behandlung|heilmittel|leistung|ort|raum|haus|behandlungsstelle|therapeut|behandler|durchführung|bemerkung|hinweis)\b/i.test(text)
  || /(behandlungsplan|therapieplan|tagesplan|wochenplan)/i.test(text)
  || /^(patient|name|geb\.?|geburtsdatum|station|zimmer\s*nr|seite\s*\d)/i.test(text)
  || /^[\s\-_=.,:•]+$/.test(text);

function looksLikeLocation(text) {
  const value = text.trim();
  if (!value) return false;
  const words = value.split(/\s+/);
  if (words.length > 4) return false;
  if (ROOM_CODE.test(value)) return true;
  // Beginnt die Angabe mit einem Ortswort, ist das eindeutig -- auch bei
  // "Schulungsraum 3", das sonst am Wortteil "Schulung" hängen bliebe.
  if (LOCATION_START.test(value)) return true;
  if (TREATMENT_HINT.test(value)) return false;
  // Die Endung allein reicht nur bei sehr kurzen Angaben.
  return words.length <= 2 && LOCATION_SUFFIX.test(value);
}

/** Personennamen: "Müller", "Dr. Weber", "Schmidt, A.", "M. Bauer" -- kurz, ohne Verben. */
function looksLikePerson(text) {
  const value = text.trim();
  if (!value || value.length > 34) return false;
  if (looksLikeLocation(value)) return false;
  if (TITLE_PREFIX.test(value)) return true;
  const words = value.split(/\s+/);
  if (words.length > 3) return false;
  const capitalised = words.filter((word) => /^[A-ZÄÖÜ][a-zäöüß'-]+\.?$/.test(word) || /^[A-ZÄÖÜ]\.$/.test(word));
  if (capitalised.length !== words.length) return false;
  // Anwendungsnamen sind meist zusammengesetzt und lang; Nachnamen sind kurz.
  return words.every((word) => word.length <= 16) && !/(therapie|training|gymnastik|massage|bad|packung|beratung|vortrag|essen)/i.test(value);
}

function assignCells(cells, lexicon) {
  const rest = [...cells];
  const known = (field, value) => {
    const match = bestMatch(value, Object.keys(lexicon[field] || {}));
    return Boolean(match && match.distance <= 1);
  };

  const takeBy = (test) => {
    const index = rest.findIndex((cell) => test(cell.text));
    return index >= 0 ? rest.splice(index, 1)[0].text : "";
  };

  // Was das Lexikon sicher kennt, wird zuerst zugeordnet; danach die Textmerkmale.
  let practitioner = takeBy((text) => known("practitioner", text));

  const locations = [];
  let hit = takeBy((text) => known("location", text));
  while (hit) { locations.push(hit); hit = takeBy((text) => known("location", text)); }
  hit = takeBy(looksLikeLocation);
  while (hit) { locations.push(hit); hit = takeBy(looksLikeLocation); }

  if (!practitioner && rest.length > 1) {
    // Der Behandler steht praktisch immer in der letzten Spalte.
    const last = rest.at(-1);
    if (last && looksLikePerson(last.text)) practitioner = rest.pop().text;
  }

  const byLength = [...rest].sort((a, b) => b.text.length - a.text.length);
  const title = byLength[0]?.text || "";
  const note = rest.filter((cell) => cell.text !== title).map((cell) => cell.text).join(" \u00b7 ");
  return { title, location: locations.join(", "), practitioner, note };
}

/* --------------------------------------------------------- Hauptfunktion */

/**
 * @returns {{date: string, items: Array, warnings: Array<string>, confidence: number}}
 */
export function parsePage(tsv, fullText, { lexicon = {}, fallbackYear = new Date().getFullYear() } = {}) {
  const lines = tsvLines(tsv);
  const text = fullText || lines.map((line) => line.text).join("\n");
  const warnings = [];

  const date = parseGermanDate(text, fallbackYear);
  if (!date) warnings.push("Auf dieser Seite wurde kein Datum gefunden. Bitte oben eintragen.");
  else if (dateMatchesWeekday(date, text) === false) warnings.push("Datum und Wochentag auf dem Plan passen nicht zusammen. Bitte prüfen.");

  const items = lines.length ? fromLines(lines, lexicon, warnings) : fromPlainText(text, lexicon);
  if (!items.length) warnings.push("Es wurden keine Uhrzeiten erkannt. Termine können unten von Hand ergänzt werden.");

  const confidence = lines.length
    ? Math.round(lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length)
    : 0;

  return { date, items, warnings, confidence };
}

function fromLines(lines, lexicon, warnings) {
  // Schritt 1: Rohzeilen einsammeln und Folgezeilen anhängen.
  // Erst danach wird korrigiert -- sonst würde "Krankengymnastik im" schon
  // zu "Krankengymnastik" begradigt, bevor "Bewegungsbad" dazukommt.
  const rows = [];
  let previous = null;

  for (const line of lines) {
    if (isHeaderLine(line.text)) { previous = null; continue; }

    const stamp = extractTime(line.words);
    if (!stamp) {
      const isContinuation = previous
        && line.top - previous.bottom < previous.height * 1.4
        && line.left > previous.timeRight;
      if (isContinuation) {
        const extra = clean(line.words.map((word) => word.text).join(" "));
        if (extra && extra.length <= 60) previous.continuation.push(extra);
      }
      continue;
    }

    const cells = splitCells(stamp.rest, line.height);
    if (!cells.length) { previous = null; continue; }

    const row = {
      time: stamp.time,
      end: stamp.end,
      cells,
      continuation: [],
      confidence: Math.min(line.confidence, ...cells.map((cell) => cell.confidence)),
    };
    rows.push(row);
    previous = {
      continuation: row.continuation,
      bottom: line.bottom,
      height: line.height,
      timeRight: stamp.rest[0] ? stamp.rest[0].left - 1 : line.left,
    };
  }

  // Schritt 2: Zellen zuordnen, Folgezeile an den Titel hängen, dann korrigieren.
  return rows.map((row) => {
    const assigned = assignCells(row.cells, lexicon);
    const rawTitle = clean([assigned.title, ...row.continuation].filter(Boolean).join(" "));
    const title = correct(rawTitle, "title", lexicon);
    const practitioner = correct(assigned.practitioner, "practitioner", lexicon);
    const location = correct(assigned.location, "location", lexicon);

    if (!title.value) warnings.push(`${row.time}: Es wurde keine Anwendung erkannt.`);

    return {
      id: newId(),
      time: row.time,
      duration: row.end ? minutesBetween(row.time, row.end) : 30,
      title: title.value || "Behandlung",
      location: location.value,
      practitioner: practitioner.value,
      note: assigned.note,
      category: categorize(title.value, assigned.note),
      confidence: row.confidence,
      corrections: [title, practitioner, location]
        .filter((entry) => entry.corrected)
        .map((entry) => `${entry.from} \u2192 ${entry.value}`),
    };
  });
}

/** Rückfallebene ohne Koordinaten -- z. B. bei Text aus einer PDF-Textebene. */
function fromPlainText(text, lexicon) {
  const items = [];
  for (const raw of String(text).split(/\r?\n/)) {
    // Bewusst nur trimmen: die Mehrfach-Leerzeichen sind hier die Spaltengrenzen
    // und dürfen nicht wie sonst zu einem einzelnen Leerzeichen zusammenfallen.
    const line = raw.replace(/[|\u00a6]/g, " ").replace(/[\u2010\u2011\u2013\u2014]/g, "-").replace(/[ \t]+$/,"").trim();
    if (!line || isHeaderLine(line)) continue;
    const match = line.match(/^(\d{1,2}\s*[:.]\s*\d{2})\s*(?:[-–]\s*(\d{1,2}\s*[:.]\s*\d{2}))?\s+(.*)$/);
    if (!match) continue;
    const time = normalizeTime(match[1]);
    if (!time) continue;
    const parts = match[3].split(/\s{2,}|\t+|\s+[\u00b7|]\s+/).map(clean).filter(Boolean);
    const assigned = assignCells(parts.map((part) => ({ text: part })), lexicon);
    const title = correct(assigned.title || match[3], "title", lexicon);
    items.push({
      id: newId(),
      time,
      duration: match[2] ? Math.max(5, minutesBetween(time, normalizeTime(match[2]))) : 30,
      title: title.value || "Behandlung",
      location: assigned.location,
      practitioner: assigned.practitioner,
      note: assigned.note,
      category: categorize(title.value),
      confidence: 0,
      corrections: title.corrected ? [`${title.from} → ${title.value}`] : [],
    });
  }
  return items;
}

function minutesBetween(start, end) {
  if (!start || !end) return 30;
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  const diff = (endHour * 60 + endMinute) - (startHour * 60 + startMinute);
  return diff > 0 && diff <= 480 ? diff : 30;
}

export { KNOWN_TREATMENTS, clean };
