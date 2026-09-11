/**
 * Aus einem OCR-Ergebnis werden Tagesplaene.
 *
 * Zwei Erkenntnisse aus echten Klinikplaenen bestimmen den Aufbau:
 *
 * 1. Eine Seite enthaelt nicht einen Tag, sondern beliebig viele. Die Tage
 *    werden durch Datumszeilen im Tabellenkoerper getrennt ("Freitag 04.
 *    September 2026"). Das Datum im Seitenkopf ist das Anreisedatum und
 *    waere fuer die Termine falsch.
 *
 * 2. Hat der Plan eine Spaltenueberschrift, ist die Spaltenposition das
 *    verlaesslichste Signal ueberhaupt. Nur wenn sie fehlt oder unplausibel
 *    ist, wird jede Zelle inhaltlich eingeordnet.
 */

import { CATEGORIES, oddCharacters } from "./store.js";

/* ------------------------------------------------------------- Woerterbuecher */

const MONTHS = {
  januar: 1, jan: 1, februar: 2, feb: 2, "märz": 3, maerz: 3, mrz: 3, april: 4, apr: 4,
  mai: 5, juni: 6, jun: 6, juli: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10, november: 11, nov: 11, dezember: 12, dez: 12,
};

const MONTH_NAMES = "januar|jan|februar|feb|märz|maerz|mrz|april|apr|mai|juni|jun|juli|jul|august|aug|september|sept|sep|oktober|okt|november|nov|dezember|dez";
const WEEKDAYS = ["sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag"];
const WEEKDAY_PATTERN = /(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonnabend|sonntag)/i;

/** Spaltenueberschriften und die Rolle, die sie bezeichnen. */
const COLUMN_ROLES = [
  { role: "time", pattern: /^(zeit|uhrzeit|beginn|von|termin)\b/i },
  { role: "location", pattern: /^(haus|geb[äa]ude|bereich|klinik|standort)\b/i },
  { role: "location", pattern: /^(behandlungsstelle|ort|raum|zimmer|stelle|wo)\b/i },
  { role: "title", pattern: /^(heilmittel|anwendung|therapie|behandlung|leistung|ma[ßs]nahme|inhalt|was)\b/i },
  { role: "practitioner", pattern: /^(behandler|therapeut|durchf[üu]hrung|wer|personal)\b/i },
];

const LOCATION_START = /^(raum|zimmer|halle|bad|becken|kabine|station|geb[äa]ude|haus|saal|treffpunkt|therapiezentrum|therapeutikum|bewegungsbad|ebene|stock|etage|og|ug|eg|flur|trakt|praxis|ambulanz|turnhalle|gymnastikraum|wartebereich|empfang|foyer|liegehalle|sauna|schwimmbad|speisesaal|aufenthaltsraum|schulungsraum|sporthalle|lehrküche|patientenzimmer|fernsehgerät|mtz|physio|kurzentrum|treff|hallenbad|wartebereich|kg-wartebereich|vortragsr|hauskapelle|service)\b/i;

const LOCATION_SUFFIX = /(raum|saal|halle|zimmer|bad|becken|kabine|studio|küche|garten|terrasse|bereich|platz|therapeutikum)$/i;

const TREATMENT_HINT = /(therapie|training|gymnastik|massage|packung|beratung|vortrag|schulung|gespräch|visite|untersuchung|drainage|anwendung|kurs|essen|frühstück|walking|schwimmen|entspannung|inhalation|mobilisieren|dehnen)/i;

const ROOM_CODE = /^(?:[A-ZÄÖÜ]{1,3}[-\s]?\d{1,3}[a-z]?|\d{1,3}[a-z]?)$/;

/**
 * Aeusserster Abstand, in dem eine Zeile ohne Uhrzeit noch zur Zeile darueber
 * gehoeren kann -- als Vielfaches der Schrifthoehe.
 *
 * Nur eine grobe Schranke, bewusst weit. Frueher sollte der Zeilenabstand
 * allein entscheiden, ob eine Zeile ein Zellumbruch oder eine eigene
 * Tabellenzeile ist. An abfotografierten Plaenen gemessen trennt er beides
 * nicht: echte Umbrueche liegen zwischen -0,14 und 0,72, eigenstaendige
 * Zeilen zwischen -0,14 und 0,69 -- die Bereiche decken sich vollstaendig.
 * Die Entscheidung faellt deshalb am Inhalt, siehe istFortsetzung().
 */
const CONTINUATION_GAP = 1.6;

/** "2.0G" und "2.O0G" sind verlesene Etagenangaben -- ein haeufiger OCR-Fehler. */
function tidyLocation(value) {
  return clean(String(value)
    .replace(/(\d)\s*\.?\s*[O0]{1,2}G\b/gi, "$1. OG")
    .replace(/(\d)\s*\.?\s*[U][G]\b/gi, "$1. UG"));
}

/**
 * Anreden und Titel vor einem Namen.
 *
 * Die Wortgrenze \b zaehlt Umlaute nicht als Buchstaben. "\bfr\b" trifft
 * deshalb mitten in "Frühstück" -- und die Mahlzeit galt als Personenname.
 * Die Grenzen sind hier darum ausgeschrieben und schliessen Umlaute ein.
 */
const TITLE_PREFIX = /(^|[^\wÄÖÜäöüß])(dr|prof|frau|herr|hr|fr|dipl|med)\.?([^\wÄÖÜäöüß]|$)/i;

/**
 * Woerter, die auf diesem Plan ausschliesslich in der Behandler-Spalte
 * stehen. Sie sind nie der Name einer Anwendung -- landen aber leicht dort,
 * wenn die Spalten auf einem gefalteten Blatt gegeneinander verrutschen.
 */
const PRACTITIONER_WORDS = [
  "Essensausgabe", "Videoschulung", "Selbständiges Üben", "Selbstständiges Üben",
];

/** Anwendungen, die auf Reha-Plaenen im deutschsprachigen Raum ueblich sind. */
const KNOWN_TREATMENTS = [
  "Krankengymnastik", "Krankengymnastik im Bewegungsbad", "Bewegungsbad", "Wassergymnastik",
  "Aquajogging", "Medizinische Trainingstherapie", "Gerätetraining", "Ergometertraining",
  "Nordic Walking", "Terraintraining", "Wirbelsäulengymnastik", "Rückenschule",
  "Atemtherapie", "Ergotherapie", "Physiotherapie", "Manuelle Therapie", "Manuelle Lymphdrainage",
  "Klassische Massage", "Teilmassage", "Unterwasserdruckstrahlmassage", "Bindegewebsmassage",
  "Fangopackung", "Fango", "Moorpackung", "Naturmoorbad", "Heißluft", "Rotlicht", "Kryotherapie",
  "Elektrotherapie", "Ultraschall", "Inhalation", "Kohlensäurebad", "Solebad", "Vierzellenbad",
  "Stangerbad", "Kneippanwendung", "Wechselbad", "Entspannungstraining", "Progressive Muskelentspannung",
  "Autogenes Training", "Yoga", "Qigong", "Tai Chi", "Rückenkurs", "Gesundheitsvortrag",
  "Ernährungsberatung", "Info Ernährung", "Lehrküche", "Diätberatung", "Sozialberatung",
  "Psychologisches Einzelgespräch", "Gesprächsgruppe", "Schulung", "Visite", "Arztgespräch",
  "Aufnahmeuntersuchung", "Abschlussuntersuchung", "Blutentnahme", "Belastungs-EKG", "EKG",
  "Lungenfunktion", "Röntgen", "Sprechstunde", "Dehnen/Mobilisieren", "Schmerzbewältigung",
  "Gelenkarthrose", "Fitness und Bewegung", "MTT Einführung", "KG einzel",
  // Schreibweisen der Federseeklinik Bad Buchau, aus echten Plänen übernommen.
  "Beweg.ther.Sch.", "Aquather. Sch.", "Mobi allg. BWB", "MTT Gruppe", "MTT Eigentraining",
  "Ergo einzel", "Helparm Üben", "Einführung Helparm", "Schlingentisch", "Nachsorgevortrag",
  "Begrüßungsvortrag", "Stressbewältigung", "Nordic Walking Info", "Info Ernährung",
  "Oase am Mittag", "Fahrgeld", "Visite", "Eigentraining Therme",
  "Beruf und Sozialrecht", "Beruf und Sozialberatung",
  // Von den Plaenen der zweiten Woche uebernommen.
  "Mobilisation", "Rückenschmerz", "ausf. Arztgespräch", "Rückenschmerzen",
  "Frühstück", "Mittagessen", "Abendessen", "Zwischenmahlzeit", "Anreise", "Abreise",
];

/**
 * Ortsangaben, die auf diesen Plaenen vorkommen.
 *
 * Die Texterkennung verliert regelmaessig Anfangsbuchstaben ("Sporthalle"
 * wird zu "orthalle", "Haus" zu "Has"). Gegen solche Verluste hilft kein
 * besseres Modell, sondern nur ein Abgleich mit dem, was auf dem Plan
 * ueberhaupt stehen kann. Das Woerterbuch lernt weiter dazu; dies ist der
 * Grundbestand, damit schon der erste Scan sitzt.
 */
const KNOWN_LOCATIONS = [
  "Therapeutikum", "Haus am Gsundbrunnen", "Haus am Park", "Kurzentrum",
  "Treff Sporthalle", "Sporthalle", "Patientenzimmer", "Hallenbad",
  "Saal Kanzach", "Saal Bad Buchau", "Speisesaal", "Hauskapelle",
  "Bewegungsbad", "EG Bewegungsbad", "EG Fango", "EG Ergotherapie",
  "EG Physio Warteber.", "EG Vortragsr. Bussen", "Wartebereich Sporth.",
  "KG-Wartebereich", "MTZ Fitnessraum", "Fernsehgerät Pr. 33",
  "Fitnessraum", "Ergotherapie", "Physiotherapie", "Fango",
  "EG Raum 14", "Therapeutikum 4. OG", "EG Vortragsr. Bussen",
  "Raum", "Haus", "Saal", "Halle", "Bad", "Kabine", "Turnhalle",
  "Schulungsraum", "Gymnastikraum", "Empfang", "Service Center",
];

// Reihenfolge ist bedeutsam: die erste passende Regel gewinnt. Geprüft wird
// nicht nur die Anwendung, sondern auch das Behandlerfeld -- dort steht bei
// diesem Plan "Videoschulung" oder "Essensausgabe" und sagt mehr über die Art
// des Termins als der Titel ("Gelenkarthrose").
const CATEGORY_RULES = [
  { id: "mahlzeit", pattern: /(frühstück|fruehstueck|mittagessen|abendessen|mahlzeit|essensausgabe|kaffeetafel|lehrküche)/i },
  { id: "info", pattern: /(vortrag|videoschulung|schulung|\binfo\b|information|beratung|seminar|gespräch(?!stherapie)|sozialdienst|ernährungsberatung|diätberatung|begrüßung)/i },
  { id: "training", pattern: /(\bmtt\b|eigentraining|trainingstherapie|gerätetraining|ergometer|nordic\s?walking|terraintraining|\btraining\b|fitness|gymnastik|sporthalle|selbständiges üben|üben\b|wandern|yoga|qigong|tai\s?chi)/i },
  { id: "therapie", pattern: /(therapie|massage|packung|fango|moor|lymphdrainage|krankengymnastik|\bkg\b|ergo\b|schlingentisch|mobi\b|beweg\.?ther|aquather|bewegungsbad|hallenbad|\bbad\b|heißluft|rotlicht|kryo|elektro|ultraschall|inhalation|visite|arzt|ärztlich|untersuchung|\bekg\b|labor|blutentnahme|röntgen|sprechstunde|dehnen|mobilisieren|atemtherapie|entspannung|autogenes|muskelentspannung|helparm)/i },
];

/* ----------------------------------------------------------------- Basics */

const clean = (value = "") => String(value)
  .replace(/[|¦]/g, " ")
  .replace(/[‐‑–—]/g, "-")
  .replace(/\s+/g, " ")
  .trim();

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);

export function categorize(title = "", note = "", practitioner = "") {
  const hit = CATEGORY_RULES.find((rule) => rule.pattern.test(`${title} ${note} ${practitioner}`));
  return hit ? hit.id : "sonstiges";
}

export const categoryLabel = (id) => CATEGORIES.find((entry) => entry.id === id)?.label || "Sonstiges";

/** OCR verwechselt Ziffern regelmaessig mit Buchstaben -- hier gezielt zurueckdrehen. */
export function normalizeTime(raw = "") {
  const candidate = String(raw)
    .replace(/[oO°]/g, "0").replace(/[lI|]/g, "1").replace(/[sS]/g, "5").replace(/B/g, "8")
    .replace(/\s+/g, "")
    .replace(/[.,;]/g, ":")
    .replace(/uhr$/i, "");
  const match = candidate.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return "";
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return "";
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

const iso = (year, month, day) =>
  (!year || !month || !day || month > 12 || day > 31) ? "" : `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

/**
 * Waehlt das Jahr, wenn der Plan keines nennt.
 *
 * Ein Aufenthalt ueber Silvester ist der Ernstfall: Wird ein Plan Ende
 * Dezember gescannt und nennt eine Zeile "Samstag 02. Januar", gehoert dieser
 * Tag ins Folgejahr. Das laufende Jahr einzusetzen legt den Termin ein Jahr
 * in die Vergangenheit -- er taucht in der Hauptansicht nie auf.
 *
 * Entschieden wird in zwei Stufen: Nennt der Text einen Wochentag, ist das
 * Jahr damit eindeutig bestimmt (derselbe Kalendertag faellt in benachbarten
 * Jahren auf verschiedene Wochentage). Sonst gewinnt das Jahr, dessen Datum
 * dem Bezugstag am naechsten liegt.
 */
function waehleJahr(tag, monat, text, bezug) {
  const bezugsTag = bezug instanceof Date ? bezug : new Date(`${bezug}T12:00:00`);
  const basis = bezugsTag.getFullYear();
  const kandidaten = [basis, basis + 1, basis - 1]
    .map((jahr) => ({ jahr, datum: new Date(jahr, monat - 1, tag, 12) }))
    .filter((eintrag) => eintrag.datum.getMonth() === monat - 1);   // 29. Februar

  if (!kandidaten.length) return basis;

  const genannt = String(text).toLocaleLowerCase("de-DE").match(WEEKDAY_PATTERN);
  if (genannt) {
    const gesucht = genannt[1] === "sonnabend" ? "samstag" : genannt[1];
    const treffer = kandidaten.filter((eintrag) => WEEKDAYS[eintrag.datum.getDay()] === gesucht);
    if (treffer.length === 1) return treffer[0].jahr;
    if (treffer.length > 1) kandidaten.length = 0, kandidaten.push(...treffer);
  }

  return kandidaten
    .sort((a, b) => Math.abs(a.datum - bezugsTag) - Math.abs(b.datum - bezugsTag))[0].jahr;
}

/**
 * @param {string} text
 * @param {string|Date|number} bezug  Bezugstag fuer Angaben ohne Jahr
 *                                    (ein Jahr als Zahl wird weiterhin angenommen)
 */
export function parseGermanDate(text, bezug = new Date()) {
  const source = String(text || "");
  const bezugsTag = typeof bezug === "number" ? new Date(bezug, 6, 1) : bezug;

  const written = source.toLocaleLowerCase("de-DE")
    .match(new RegExp(`\\b([0-3]?\\d)\\.?\\s*(${MONTH_NAMES})\\.?\\s*((?:20)?\\d{2})?`));
  if (written) {
    const tag = Number(written[1]);
    const monat = MONTHS[written[2]];
    const rohJahr = written[3];
    const jahr = rohJahr
      ? (rohJahr.length === 2 ? Number(`20${rohJahr}`) : Number(rohJahr))
      : waehleJahr(tag, monat, source, bezugsTag);
    return iso(jahr, monat, tag);
  }

  const numeric = source.match(/\b([0-3]?\d)\s*[.\/-]\s*([01]?\d)\s*[.\/-]\s*((?:20)?\d{2})\b/);
  if (numeric) {
    const jahr = numeric[3].length === 2 ? Number(`20${numeric[3]}`) : Number(numeric[3]);
    return iso(jahr, Number(numeric[2]), Number(numeric[1]));
  }

  const short = source.match(/\b([0-3]?\d)\s*\.\s*([01]?\d)\s*\.(?!\d)/);
  if (!short) return "";
  const tag = Number(short[1]);
  const monat = Number(short[2]);
  return iso(waehleJahr(tag, monat, source, bezugsTag), monat, tag);
}

export const weekdayOf = (isoDate) => WEEKDAYS[new Date(`${isoDate}T12:00:00`).getDay()];

/** Prueft, ob ein im Text genannter Wochentag zum erkannten Datum passt. */
export function dateMatchesWeekday(isoDate, text) {
  const named = String(text).toLocaleLowerCase("de-DE").match(WEEKDAY_PATTERN);
  if (!named || !isoDate) return null;
  const day = named[1] === "sonnabend" ? "samstag" : named[1];
  return day === weekdayOf(isoDate);
}

/* ------------------------------------------------- Aehnlichkeit / Lexikon */

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
 * Sucht den aehnlichsten bekannten Begriff. Die Toleranz waechst mit der
 * Wortlaenge, bleibt aber eng genug, dass aus "Raum 2" nie "Raum 5" wird.
 */
export function bestMatch(value, candidates) {
  const needle = foldForCompare(value);
  // Ab drei Zeichen, damit auch "Has" noch zu "Haus" findet -- dort aber nur
  // mit Abstand 1, sonst wuerde aus "Bad" ein "Bau".
  if (needle.length < 3) return null;
  // Zahlen unterscheiden Raeume voneinander: nur Kandidaten mit denselben Ziffern.
  const digits = needle.replace(/\D/g, "");
  const budget = needle.length <= 3 ? 1 : needle.length <= 6 ? 1 : needle.length <= 12 ? 2 : 3;
  let best = null;
  for (const candidate of candidates) {
    const hay = foldForCompare(candidate);
    if (!hay || hay.replace(/\D/g, "") !== digits) continue;
    if (hay === needle) return { value: candidate, distance: 0 };
    if (Math.abs(hay.length - needle.length) > budget) continue;
    const distance = levenshtein(needle, hay);
    if (distance <= budget && (!best || distance < best.distance)) best = { value: candidate, distance };
  }
  return best;
}

/**
 * Begradigt eine mehrteilige Angabe stueckweise.
 *
 * "Treff orthalle" findet als Ganzes keinen Treffer, wohl aber sein zweites
 * Wort. Deshalb wird zusaetzlich Wort fuer Wort geprueft -- allerdings nur
 * gegen den Grundbestand, damit nicht jedes Wort zu irgendetwas wird.
 */
function korrigiereWortweise(text, kandidaten) {
  const woerter = text.split(/\s+/);
  if (woerter.length < 2) return text;

  // Alle Einzelwoerter des Grundbestands. Ein Wort, das darin vorkommt, ist
  // richtig gelesen und wird nicht angetastet -- sonst wuerde aus dem
  // korrekten "Wartebereich" das laengere "KG-Wartebereich".
  const bekannteWoerter = new Set();
  for (const eintrag of kandidaten) {
    for (const wort of String(eintrag).split(/[\s/]+/)) {
      const gefaltet = foldForCompare(wort);
      if (gefaltet.length >= 3) bekannteWoerter.add(gefaltet);
    }
  }

  let geaendert = false;
  const neu = woerter.map((wort) => {
    // Satzzeichen am Rand gehoeren nicht zum Wort: das Komma trennt hier Haus
    // und Behandlungsstelle und muss stehen bleiben.
    const teile = wort.match(/^([^\wÄÖÜäöüß]*)(.*?)([^\wÄÖÜäöüß]*)$/);
    const [, davor, kern, danach] = teile;
    if (kern.length < 4 || /\d/.test(kern)) return wort;
    if (bekannteWoerter.has(foldForCompare(kern))) return wort;
    const treffer = bestMatch(kern, kandidaten);
    if (treffer && treffer.value !== kern && treffer.value.split(/\s+/).length === 1) {
      geaendert = true;
      return `${davor}${treffer.value}${danach}`;
    }
    return wort;
  });
  return geaendert ? neu.join(" ") : text;
}

/**
 * Woerter, die klein geschrieben fuer sich stehen duerfen. Sie sind nie der
 * Rest eines umbrochenen Wortes.
 */
const KLEINE_EIGENSTAENDIGE_WOERTER = new Set([
  "am", "im", "in", "an", "auf", "aus", "bei", "mit", "und", "zu", "zum", "zur",
  "der", "die", "das", "den", "dem", "des", "von", "vom", "fur", "uhr", "ab", "bis",
]);

/** Grundbestand, einmal aufgebaut: ganze Begriffe und ihre Einzelwoerter. */
const GRUNDBESTAND = (() => {
  const woerter = new Set();
  const begriffe = new Set();
  for (const eintrag of [...KNOWN_LOCATIONS, ...KNOWN_TREATMENTS]) {
    begriffe.add(foldForCompare(eintrag));
    for (const wort of String(eintrag).split(/[\s/]+/)) {
      const gefaltet = foldForCompare(wort);
      if (gefaltet.length >= 3) woerter.add(gefaltet);
    }
  }
  return { woerter, begriffe };
})();

/** Grundbestand samt der Begriffe, die dieses Geraet schon gelernt hat. */
function wortbestand(lexicon = {}) {
  const woerter = new Set(GRUNDBESTAND.woerter);
  const begriffe = new Set(GRUNDBESTAND.begriffe);
  for (const feld of ["title", "location", "practitioner"]) {
    for (const term of Object.keys(lexicon[feld] || {})) {
      begriffe.add(foldForCompare(term));
      for (const wort of String(term).split(/[\s/]+/)) {
        const gefaltet = foldForCompare(wort);
        if (gefaltet.length >= 3) woerter.add(gefaltet);
      }
    }
  }
  return { woerter, begriffe };
}

/**
 * Erkennt den Rest eines Wortes, das ohne Trennstrich umbrochen wurde.
 *
 * Die Spalte "Haus" ist auf diesen Plaenen schmal, und die Klinik-Software
 * bricht hart nach Zeichen um: aus "Patientenzimmer" wird "Patientenzimm" in
 * der einen und "er" in der naechsten Zeile -- ohne Bindestrich. Wuerde man
 * beides mit einem Leerzeichen verbinden, bliebe im Ort ein sinnloses "er".
 *
 * Ein wirklich neues Wort faengt in diesen Zellen praktisch immer gross an
 * ("Haus am" / "Gsundbrunnen"); ein Wortrest ist klein und kurz. Sicher ist
 * der Fall, wenn beide Teile zusammen ein bekanntes Wort ergeben.
 */
function istWortrest(vorher, bruchstueck, bekannt) {
  if (!vorher || !bruchstueck) return false;
  if (!/^[a-zäöüß]{1,6}$/.test(bruchstueck)) return false;
  if (KLEINE_EIGENSTAENDIGE_WOERTER.has(foldForCompare(bruchstueck))) return false;
  const letztes = vorher.split(/\s+/).pop();
  // Nur an einen Wortanfang anschliessen -- nicht an "33" oder "Pr.".
  if (!/[A-Za-zÄÖÜäöüß]$/.test(letztes)) return false;
  if (bekannt.woerter.has(foldForCompare(letztes + bruchstueck))) return true;
  // Sonst nur, wenn der Anfang selbst kein vollstaendiges Wort ist und der
  // Rest sehr kurz bleibt: "Ergo" / "einzel" bleiben so zwei Woerter.
  return bruchstueck.length <= 3 && !bekannt.woerter.has(foldForCompare(letztes));
}

/**
 * Woerter, nach denen eine Zelle unmoeglich zu Ende ist: "Haus am ...",
 * "Beruf und ...". Sie stehen auf diesen Plaenen nie am Zeilenende.
 */
const OFFENES_ENDE = /(?:^|\s)(?:und|oder|am|im|in|an|auf|aus|bei|mit|von|vom|zum|zur|der|die|das|den|dem|des|für|fuer|u\.|&|-|\/)$/i;

/**
 * Entscheidet, ob eine Zeile ohne Uhrzeit die Fortsetzung der Zelle darueber
 * ist oder eine eigenstaendige Tabellenzeile.
 *
 * Frueher entschied das der Zeilenabstand. An echten Fotos nachgemessen
 * taugt er dafuer nicht: "Sozialrecht" -- die Fortsetzung von "Beruf und" --
 * steht 0,72 Schrifthoehen unter seiner Zeile, waehrend die eigenstaendige
 * Zeile "MTT Eigentraining" auf denselben Plaenen bei 0,05 liegt. Ein
 * Schwellenwert kann beides nicht trennen.
 *
 * Der Inhalt kann es: Eine Zelle, die auf "am" oder "und" endet, ist
 * offensichtlich nicht zu Ende. Ein angeschnittenes Wort ("Patientenzimm")
 * ebensowenig. Steht dort dagegen ein vollstaendiger, bekannter Begriff
 * ("Abendessen"), faengt darunter etwas Neues an.
 */
function istFortsetzung(bisher, fragment, bekannt) {
  const anfang = clean(bisher);
  if (!anfang || !clean(fragment)) return false;

  // 1. Die Zelle endet auf ein Binde- oder Fuellwort.
  if (OFFENES_ENDE.test(anfang)) return true;

  // 2. Beide Teile ergeben zusammen einen bekannten Begriff. Das greift ab
  //    dem zweiten Scan auch fuer Anwendungen, die nur dieses Haus kennt.
  if (bekannt.begriffe.has(foldForCompare(`${anfang} ${fragment}`))) return true;

  // 3. Das letzte Wort der Zelle ist selbst kein bekanntes Wort -- dann ist es
  //    angeschnitten. Ziffern und Kuerzel ("2. OG", "Pr. 33") zaehlen nicht.
  const letztes = anfang.split(/\s+/).pop().replace(/[^\wÄÖÜäöüß]+$/, "");
  if (letztes.length >= 4 && !/\d/.test(letztes) && !bekannt.woerter.has(foldForCompare(letztes))) return true;

  return false;
}

/** Haengt die Zellen einer Folgezeile an -- Wortreste ohne Leerzeichen. */
function haengeFortsetzungAn(slot, teile, bekannt) {
  for (const teil of teile) {
    const letzter = slot.length ? slot[slot.length - 1] : "";
    if (istWortrest(letzter, teil, bekannt)) slot[slot.length - 1] = letzter + teil;
    else slot.push(teil);
  }
  return slot;
}

/**
 * Setzt eine angeschnittene Anrede wieder zusammen.
 *
 * Die Texterkennung verliert bei Namen regelmaessig den Anfangsbuchstaben:
 * aus "Frau M. Stubenrauch" wird "rau M. Stubenrauch", aus "Herr R. Moerschel"
 * wird "err R. Moerschel". Ein Woerterbuch hilft hier beim ersten Plan nicht,
 * denn den Nachnamen kennt es noch nicht -- die Anrede dagegen ist aus sich
 * heraus erkennbar.
 *
 * Bewusst eng gefasst: Der Rest muss wie ein Name aussehen, damit aus dem
 * Nachnamen "Rau" nicht "Frau" wird.
 */
function ergaenzeAnrede(text) {
  const treffer = text.match(/^(rau|au|err|rr)\.?\s+(.+)$/);
  if (!treffer) return text;

  const [, bruchstueck, rest] = treffer;
  // Der Rest muss mit einem Grossbuchstaben beginnen und wie ein Name
  // gebaut sein: "M. Stubenrauch", "Stubenrauch", "med. Hofer".
  if (!/^[A-ZÄÖÜ]/.test(rest) || rest.split(/\s+/).length > 3) return text;

  const anrede = ["rau", "au"].includes(bruchstueck) ? "Frau" : "Herr";
  return `${anrede} ${rest}`;
}

/** Korrigiert einen erkannten Text gegen bekannte Begriffe. */
export function correct(value, field, lexicon = {}) {
  const roh = clean(value);
  if (!roh) return { value: "", corrected: false };

  // Bei Behandlern zuerst die Anrede zusammensetzen: erst danach hat der
  // Abgleich mit dem Woerterbuch eine Chance auf einen Treffer.
  const text = field === "practitioner" ? ergaenzeAnrede(roh) : roh;
  const anredeErgaenzt = text !== roh;
  const learned = Object.entries(lexicon[field] || {}).sort((a, b) => b[1] - a[1]).map(([term]) => term);
  const grundbestand = field === "title" ? KNOWN_TREATMENTS : field === "location" ? KNOWN_LOCATIONS : [];
  // Der Grundbestand steht vorn: bei gleicher Genauigkeit gewinnt die
  // gepruefte Schreibweise, nicht die auf diesem Geraet gelernte. Gelerntes
  // setzt sich nur durch, wenn es naeher am Gelesenen liegt.
  const pool = [...grundbestand, ...learned];
  const match = bestMatch(text, pool);
  if (!match) {
    const wortweise = korrigiereWortweise(text, grundbestand);
    return wortweise === roh
      ? { value: roh, corrected: false }
      : { value: wortweise, corrected: true, from: roh };
  }
  if (match.value === roh) return { value: roh, corrected: false };
  if (match.value === text) return { value: text, corrected: anredeErgaenzt, from: roh };

  // Bei echtem Abstand gewinnt der bekannte Begriff -- das ist der Zweck des
  // Woerterbuchs. Sind beide Schreibweisen dagegen nach der Normalisierung
  // gleich ("Bewegı.ther.Sch." und "Beweg.ther.Sch."), entscheidet nicht das
  // Alter des Eintrags, sondern welche Fassung weniger Fremdzeichen enthaelt.
  const winner = match.distance > 0 || oddCharacters(match.value) <= oddCharacters(text)
    ? match.value
    : text;
  return winner === roh
    ? { value: roh, corrected: false }
    : { value: winner, corrected: true, from: roh };
}

/* ------------------------------------------------------- TSV -> Textzeilen */

/**
 * Die Texterkennung liefert Zeilenstuecke, keine Tabellenzeilen.
 *
 * Bei einer breiten Tabelle zerlegt Tesseract die Seite in Spaltenbloecke und
 * gibt der rechten Spalte eigene "Zeilen". "17:30 Therapeutikum Abendessen"
 * und "Essensausgabe" kommen dann getrennt an, obwohl sie dieselbe
 * Tabellenzeile sind. Innerhalb eines Stuecks ist die Gruppierung dagegen
 * verlaesslich -- also werden die Stuecke gebildet und anschliessend
 * zusammengefuehrt.
 */
function tsvFragments(tsv) {
  const groups = new Map();
  for (const row of String(tsv || "").split(/\r?\n/).slice(1)) {
    const cells = row.split("\t");
    if (cells.length < 12 || cells[0] !== "5") continue;
    const text = clean(cells.slice(11).join("\t"));
    const confidence = Number(cells[10]);
    // Bewusst niedrig angesetzt: Abkuerzungen mit vielen Punkten
    // ("Beweg.ther.Sch.") liest die Texterkennung mit Konfidenz um 15. Ein
    // Termin ohne Anwendung ist schlechter als einer mit unsicherer, in der
    // Pruefansicht markierter Anwendung. Reines Satzzeichen-Rauschen faellt
    // ueber die zweite Bedingung heraus.
    if (!text || confidence < 8 || !/[A-Za-zÄÖÜäöüß0-9]/.test(text)) continue;
    const key = `${cells[1]}-${cells[2]}-${cells[3]}-${cells[4]}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      text, confidence,
      left: Number(cells[6]), top: Number(cells[7]),
      width: Number(cells[8]), height: Number(cells[9]),
    });
  }
  return [...groups.values()].map((words) => {
    words.sort((a, b) => a.left - b.left);
    return makeLine(words);
  });
}

function makeLine(words) {
  const top = Math.min(...words.map((word) => word.top));
  const bottom = Math.max(...words.map((word) => word.top + word.height));
  return {
    words,
    top,
    bottom,
    left: words[0].left,
    right: words.at(-1).left + words.at(-1).width,
    height: Math.max(...words.map((word) => word.height)),
    middle: (top + bottom) / 2,
    text: words.map((word) => word.text).join(" "),
    confidence: Math.round(words.reduce((sum, word) => sum + word.confidence, 0) / words.length),
  };
}

/**
 * Schaetzt die Neigung der ganzen Seite.
 *
 * Ein abfotografiertes Blatt liegt nie exakt gerade. Statt fuer jede Zeile
 * einzeln eine Ausgleichsgerade zu bilden -- was bei kurzen Zeilen wild
 * extrapoliert -- wird die Neigung einmal fuer die Seite bestimmt: aus jedem
 * hinreichend breiten Zeilenstueck ein Wert, davon der Median. Ausreisser
 * fallen damit heraus.
 */
function pageSlope(fragments) {
  const slopes = [];
  for (const fragment of fragments) {
    if (fragment.words.length < 2) continue;
    const first = fragment.words[0];
    const last = fragment.words.at(-1);
    const dx = (last.left + last.width / 2) - (first.left + first.width / 2);
    if (dx < 200) continue;
    const dy = (last.top + last.height / 2) - (first.top + first.height / 2);
    slopes.push(dy / dx);
  }
  if (!slopes.length) return 0;
  slopes.sort((a, b) => a - b);
  const median = slopes[Math.floor(slopes.length / 2)];
  return Math.max(-MAX_SLOPE, Math.min(MAX_SLOPE, median));
}

const MAX_SLOPE = 0.12;

/**
 * Fuehrt die Zeilenstuecke zu Tabellenzeilen zusammen.
 *
 * Die Seitenneigung wird herausgerechnet, indem jedes Stueck auf eine
 * gemeinsame Grundlinie projiziert wird. Danach ist die Zuordnung ein
 * einfacher Vergleich der Hoehe -- unabhaengig davon, wie schief das Blatt
 * beim Fotografieren lag.
 */
function mergeFragments(fragments) {
  const slope = pageSlope(fragments);
  const baseline = (fragment) => fragment.middle - slope * fragment.left;

  const rows = [];
  for (const fragment of [...fragments].sort((a, b) => a.left - b.left)) {
    const level = baseline(fragment);
    let best = null;
    let bestDistance = Infinity;
    for (const row of rows) {
      // Ueberlappen sich zwei Stuecke waagerecht, stehen sie untereinander
      // und gehoeren nicht in dieselbe Tabellenzeile.
      if (fragment.left < row.right - 10) continue;
      const distance = Math.abs(row.level - level);
      const tolerance = Math.max(fragment.height, row.height) * 0.55;
      if (distance < tolerance && distance < bestDistance) {
        best = row;
        bestDistance = distance;
      }
    }
    if (best) {
      best.words.push(...fragment.words);
      best.right = Math.max(best.right, fragment.right);
      best.height = Math.max(best.height, fragment.height);
      // Die Grundlinie wird nachgefuehrt, damit eine leichte Woelbung
      // ueber die Zeilenbreite mitgenommen wird.
      best.level = (best.level + level) / 2;
    } else {
      rows.push({ ...fragment, level });
    }
  }
  return rows
    .map((row) => makeLine(row.words.sort((a, b) => a.left - b.left)))
    .sort((a, b) => a.top - b.top);
}

const tsvLines = (tsv) => mergeFragments(tsvFragments(tsv)).filter((line) => line.text);

/** Neigung der Aufnahme in Grad -- Grundlage für den Hinweis an den Nutzer. */
const tiltDegrees = (tsv) => Math.abs(Math.atan(pageSlope(tsvFragments(tsv))) * 180 / Math.PI);

/**
 * Zerlegt eine Zeile an den tatsaechlichen Luecken zwischen den Woertern.
 * Der Schwellwert leitet sich aus der Schrifthoehe ab und funktioniert damit
 * unabhaengig von Aufloesung und Zoomstufe.
 */
function splitCells(words, height) {
  if (!words.length) return [];
  const gapLimit = Math.max(height * 0.9, 16);
  const cells = [];
  let current = [words[0]];
  for (let index = 1; index < words.length; index += 1) {
    const previous = words[index - 1];
    const word = words[index];
    if (word.left - (previous.left + previous.width) > gapLimit) {
      cells.push(current);
      current = [];
    }
    current.push(word);
  }
  cells.push(current);
  return cells
    .map((group) => ({
      text: clean(group.map((word) => word.text).join(" ")),
      left: group[0].left,
      right: group.at(-1).left + group.at(-1).width,
      confidence: Math.round(group.reduce((sum, word) => sum + word.confidence, 0) / group.length),
    }))
    .filter((cell) => cell.text);
}

/* ------------------------------------------------------- Zeilen einordnen */

/** Wiederkehrender Seitenkopf, Fusszeile und Stammdaten -- nie ein Termin. */
const isChrome = (text) => /^(behandlungsplan|therapieplan|tagesplan|wochenplan|seite\s|zuletzt gedruckt|patientennummer|zimmernummer|kostenträger|anreise|abreise|patient|name|geb\.?|vielen dank|sehr geehrte)/i.test(text)
  || /^[\s\-_=.,:•]+$/.test(text);

/**
 * Erlaeuterungen zwischen den Terminen. Sie enthalten oft selbst Uhrzeiten
 * ("In der Zeit von 7 - 9 Uhr") und wuerden sonst Termine erfinden.
 */
function isNoteLine(text) {
  const value = text.trim();
  if (/^(bitte|wir bitten|hinweis|achtung|öffnungszeiten|nach dem erhalt|wasserspuren|sprechzeiten|den internen|die auszahlung|die "oase|die oase|therapeutikum oder|an der kasse|pfandquittung|zimmer ein|raum geöffnet|gewährleistet|nordic walking findet|alle sind herzlich|es findet|dienstags von|12 uhr|16:00 uhr|und davon|diesen terminen|rechter schalter)/i.test(value)) return true;
  // Ein ganzer Satz ist keine Tabellenzeile: viele Woerter, Satzzeichen am
  // Ende und eine Anrede oder ein Verb darin.
  const words = value.split(/\s+/);
  return words.length >= 8 && /[.!?]$/.test(value) && /\b(sie|ihr|ihre|ihres|wir|ist|sind|wird|werden|erfolgt|findet|können|bitte)\b/i.test(value);
}

/**
 * Ganze Saetze sind nie der Name einer Anwendung.
 *
 * Auf dem Foto rutscht ein Hinweistext ("... im Saal Kanzach ein. In der Zeit
 * von 7 - 9 Uhr ...") gelegentlich in die Titelspalte, und der Termin hiess
 * dann "Kanzach ein. In d". Geprueft wird nur bei Titeln, die ohnehin keiner
 * bekannten Anwendung entsprechen -- "Mobi allg. BWB" und "Aquather. Sch."
 * bleiben dadurch unberuehrt.
 */
function istProsa(text) {
  const wert = clean(text);
  if (!wert) return false;
  if (wert.split(/\s+/).length > 5) return true;
  // Punkt, Leerzeichen, Grossbuchstabe -- ein Satzende. Die Abkuerzungen
  // dieses Plans schreiben ihre Punkte ohne Leerzeichen dahinter.
  return /[.!?]\s+[A-ZÄÖÜ]/.test(wert);
}

const isColumnHeading = (text) => COLUMN_ROLES.some((entry) => entry.pattern.test(text.trim()));

/** "Donnerstag 03. September 2026" -- eine Zeile, die nur einen Tag benennt. */
function dayHeadingDate(line, bezugstag) {
  const text = clean(line.text);
  if (!WEEKDAY_PATTERN.test(text)) return "";
  if (/\d{1,2}\s*[:.]\s*\d{2}/.test(text)) return "";   // enthaelt eine Uhrzeit -> Hinweis
  if (text.length > 46) return "";
  const date = parseGermanDate(text, bezugstag);
  if (!date) return "";
  return dateMatchesWeekday(date, text) === false ? "" : date;
}

/* --------------------------------------------- Spalten aus der Ueberschrift */

/**
 * Sucht die Spaltenueberschrift und leitet daraus die Spaltenanker ab.
 * Ist eine vorhanden, ist die Position das verlaesslichste Signal, das ein
 * Plan hergibt -- die Klinik druckt jeden Tag dieselbe Tabelle.
 */
function findColumns(lines) {
  for (const line of lines) {
    const cells = splitCells(line.words, line.height);
    if (cells.length < 3) continue;
    const roles = cells.map((cell) => COLUMN_ROLES.find((entry) => entry.pattern.test(cell.text))?.role || null);
    const named = roles.filter(Boolean).length;
    // Mindestens drei erkannte Ueberschriften, und die Zeitspalte muss dabei sein.
    if (named < 3 || named < cells.length - 1 || roles[0] !== "time") continue;
    return {
      top: line.bottom,
      anchors: cells.map((cell, index) => ({ role: roles[index], left: cell.left, right: cell.right })),
    };
  }
  return null;
}

/**
 * Ordnet eine Zelle der Spalte zu, deren Bereich ihre linke Kante trifft,
 * und liefert deren Index. Der Index zaehlt, nicht nur die Rolle: "Haus" und
 * "Behandlungsstelle" sind beide Ortsangaben, aber getrennte Spalten -- eine
 * Fortsetzungszeile muss in genau ihre eigene zurueckfinden.
 */
function columnIndexAt(anchors, cell) {
  let chosen = 0;
  for (let index = 0; index < anchors.length; index += 1) {
    // Toleranz nach links, weil Zellinhalte etwas vor der Ueberschrift beginnen.
    if (cell.left >= anchors[index].left - 24) chosen = index;
  }
  return chosen;
}

/** Fuegt die Spalten-Slots zu den Feldern eines Termins zusammen. */
function slotsToFields(slots, anchors) {
  const pick = (role) => anchors
    .map((anchor, index) => (anchor.role === role ? clean((slots[index] || []).join(" ")) : ""))
    .filter(Boolean);
  return {
    title: pick("title").join(" "),
    location: pick("location").join(", "),
    practitioner: pick("practitioner").join(" "),
    note: pick(null).join(" · "),
    byColumn: true,
  };
}

function assignByColumns(cells, anchors) {
  const slots = [];
  // Ein ganzer Satz in einer Zelle ist ein Hinweistext, der in die
  // Terminzeile hineingerutscht ist -- nicht der Name einer Anwendung.
  for (const cell of cells.filter((cell) => !isNoteLine(cell.text))) {
    const index = columnIndexAt(anchors, cell);
    (slots[index] ||= []).push(cell.text);
  }
  return { slots, ...slotsToFields(slots, anchors) };
}

/* ------------------------------------------- Zellen inhaltlich einordnen */

function looksLikeLocation(text) {
  const value = text.trim();
  if (!value) return false;
  const words = value.split(/\s+/);
  if (words.length > 4) return false;
  if (ROOM_CODE.test(value)) return true;
  if (LOCATION_START.test(value)) return true;
  if (TREATMENT_HINT.test(value)) return false;
  return words.length <= 2 && LOCATION_SUFFIX.test(value);
}

/** Personennamen: "Müller", "Dr. Weber", "Frau M. Stubenrauch". */
function looksLikePerson(text) {
  const value = text.trim();
  if (!value || value.length > 34 || looksLikeLocation(value)) return false;
  if (TITLE_PREFIX.test(value)) return true;
  const words = value.split(/\s+/);
  if (words.length > 3) return false;
  const capitalised = words.filter((word) => /^[A-ZÄÖÜ][a-zäöüß'-]+\.?$/.test(word) || /^[A-ZÄÖÜ]\.$/.test(word));
  return capitalised.length === words.length
    && words.every((word) => word.length <= 16)
    && !TREATMENT_HINT.test(value);
}

/** Rueckfallebene ohne Spaltenueberschrift: jede Zelle wird inhaltlich eingeordnet. */
function assignByContent(cells, lexicon) {
  const rest = [...cells];
  const known = (field, value) => {
    const match = bestMatch(value, Object.keys(lexicon[field] || {}));
    return Boolean(match && match.distance <= 1);
  };
  const takeBy = (test) => {
    const index = rest.findIndex((cell) => test(cell.text));
    return index >= 0 ? rest.splice(index, 1)[0].text : "";
  };

  let practitioner = takeBy((text) => known("practitioner", text));

  const locations = [];
  for (const test of [(text) => known("location", text), (text) => looksLikeLocation(text)]) {
    let hit = takeBy(test);
    while (hit) { locations.push(hit); hit = takeBy(test); }
  }

  if (!practitioner && rest.length > 1 && looksLikePerson(rest.at(-1).text)) practitioner = rest.pop().text;

  const title = [...rest].sort((a, b) => b.text.length - a.text.length)[0]?.text || "";
  const note = rest.filter((cell) => cell.text !== title).map((cell) => cell.text).join(" · ");
  return { title, location: locations.join(", "), practitioner, note, byColumn: false };
}

/* ------------------------------------------------------- Zeit aus der Zeile */

function extractTime(words) {
  const first = words[0]?.text || "";

  // Haeufigster Fall bei Tabellen: die Texterkennung liefert die ganze Spanne
  // als ein Wort ("09:15-10:00").
  const span = first.split(/[-–—]/);
  if (span.length === 2) {
    const from = normalizeTime(span[0]);
    if (from) return { time: from, end: normalizeTime(span[1]), rest: words.slice(1) };
  }

  const time = normalizeTime(first);
  if (!time) return null;
  let used = 1;
  let end = "";
  const second = words[1]?.text || "";
  if (/^[-–—]$/.test(second)) {
    end = normalizeTime(words[2]?.text || "");
    if (end) used = 3;
  } else if (/^[-–—]/.test(second)) {
    end = normalizeTime(second.replace(/^[-–—]\s*/, ""));
    if (end) used = 2;
  }
  if (/^uhr$/i.test(words[used]?.text || "")) used += 1;
  return { time, end, rest: words.slice(used) };
}

function minutesBetween(start, end) {
  if (!start || !end) return 30;
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  const diff = (endHour * 60 + endMinute) - (startHour * 60 + startMinute);
  return diff > 0 && diff <= 480 ? diff : 30;
}

/* --------------------------------------------------------- Hauptfunktion */

/**
 * @returns {{days: Array<{date: string, items: Array}>, warnings: string[], confidence: number, skipped: number}}
 */
export function parsePage(tsv, fullText, { lexicon = {}, bezugstag = new Date() } = {}) {
  const lines = tsvLines(tsv);
  const warnings = [];

  if (!lines.length) {
    const items = fromPlainText(fullText || "", lexicon);
    const textLines = String(fullText || "").split(/\r?\n/).map((text) => ({ text }));
    const date = headerDate(textLines, fullText, bezugstag);
    return { days: items.length ? [{ date, items }] : [], warnings, confidence: 0, skipped: 0 };
  }

  // Ab etwa vier Grad Neigung rutschen die Spalten gegeneinander und die
  // Zuordnung wird unzuverlässig. Darauf wird hingewiesen, statt still
  // falsche Termine zu speichern.
  const tilt = tiltDegrees(tsv);
  if (tilt > 4) {
    warnings.push(`Das Foto ist um etwa ${Math.round(tilt)} Grad geneigt – dabei können Spalten vertauscht werden. Prüfen Sie die Zeilen unten, oder fotografieren Sie den Plan flach liegend noch einmal; die neue Aufnahme ersetzt diesen Tag.`);
  }

  const columns = findColumns(lines);
  const sections = splitIntoDays(lines, bezugstag);

  if (!sections.length) {
    // Kein Tagesabschnitt im Tabellenkoerper: die ganze Seite gilt als ein Tag,
    // dessen Datum aus dem Seitenkopf stammt. Gewarnt wird nur, wenn auch dort
    // keines steht -- nicht schon, weil die Datumszeile fehlt.
    const date = headerDate(lines, fullText, bezugstag);
    if (!date) {
      warnings.push("Für diesen Plan wurde kein Tagesdatum gefunden – auf der Seite steht nur ein Anreise- oder Druckdatum. Bitte das Datum oben selbst eintragen.");
    }
    else if (dateMatchesWeekday(date, fullText || "") === false) {
      warnings.push("Datum und Wochentag auf dem Plan passen nicht zusammen. Bitte prüfen.");
    }
    sections.push({ date, lines });
  }

  let skipped = 0;
  const days = [];
  for (const section of sections) {
    const result = fromLines(section.lines, columns, lexicon);
    skipped += result.skipped;
    if (result.items.length) days.push({ date: section.date, items: result.items });
  }

  if (!days.length) warnings.push("Es wurden keine Uhrzeiten erkannt. Termine können unten von Hand ergänzt werden.");
  for (const day of days) {
    // Ein Plan läuft chronologisch. Springt die Reihenfolge, hat die
    // Zeilenzuordnung gelitten -- ein verlässliches Warnsignal.
    const times = day.items.map((item) => item.time);
    if (times.some((time, index) => index > 0 && time < times[index - 1])) {
      warnings.push("Die Uhrzeiten stehen nicht in der richtigen Reihenfolge – ein Zeichen, dass die Aufnahme schief war. Bitte diesen Tag sorgfältig prüfen oder das Blatt flach liegend noch einmal fotografieren.");
    }
  }
  for (const day of days) {
    if (!day.date) warnings.push(`${day.items.length} Termine ohne erkanntes Datum – bitte das Datum eintragen.`);
  }

  return {
    days,
    warnings,
    confidence: Math.round(lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length),
    skipped,
  };
}

/** Woerter, neben denen ein Datum nie der Tag der Termine ist. */
const FREMDES_DATUM = /(anreise|abreise|zuletzt gedruckt|gedruckt am|geburt|aufnahme|entlassung|ausstellung|stand vom)/i;

/**
 * Datum aus dem Seitenkopf -- die letzte Wahl.
 *
 * Auf Klinikplaenen stehen dort Anreise, Abreise und Druckzeitpunkt, aber
 * nicht der Tag der Termine. Frueher wurde dafuer die rohe Textausgabe
 * zeilenweise gefiltert; bei einem schiefen Foto trennt die Texterkennung
 * "Anreise:" und das Datum jedoch in verschiedene Zeilen, der Filter lief
 * ins Leere und das Anreisedatum landete auf allen Terminen.
 *
 * Jetzt gilt: Steht im Kopfbereich ueberhaupt eines dieser Woerter, ist jedes
 * Datum dort verdaechtig -- dann wird lieber keines geraten. Ein leeres
 * Datumsfeld faellt in der Pruefung auf, ein falsches nicht.
 */
function headerDate(lines, fullText, bezugstag) {
  // Auf den zusammengefuehrten Zeilen arbeiten: die kennen die raeumliche
  // Nachbarschaft und halten "Anreise: 02.09.2026" zusammen.
  // Steht auf der Seite ueberhaupt ein Anreise-, Abreise- oder Druckdatum?
  const stoerend = lines.some((line) => FREMDES_DATUM.test(line.text));

  const kandidaten = [];
  for (const line of lines) {
    const text = clean(line.text);
    if (FREMDES_DATUM.test(text)) continue;
    const datum = parseGermanDate(text, bezugstag);
    if (datum) kandidaten.push({ datum, mitWochentag: WEEKDAY_PATTERN.test(text) });
  }

  // Auf einem Foto reisst die Texterkennung "Anreise:" und "02.09.2026"
  // regelmaessig in getrennte Zeilen -- das Datum steht dann scheinbar
  // unverdaechtig da und landete bisher auf allen Terminen des Blattes.
  //
  // Ein Tagesdatum traegt auf diesen Plaenen immer seinen Wochentag
  // ("Donnerstag 17. September 2026"); ein Anreisedatum nie. Sobald also ein
  // fremdes Datum auf der Seite steht, zaehlt nur noch ein Datum mit
  // Wochentag. Lieber kein Datum als das falsche: ein leeres Feld faellt in
  // der Pruefung auf, ein falsches nicht.
  const brauchbar = stoerend ? kandidaten.filter((eintrag) => eintrag.mitWochentag) : kandidaten;
  if (brauchbar.length) return brauchbar[0].datum;

  if (stoerend) return "";
  return parseGermanDate(fullText || "", bezugstag) || "";
}

/** Zerlegt die Seite an den Datumszeilen in Tagesabschnitte. */
function splitIntoDays(lines, bezugstag) {
  const sections = [];
  let current = null;
  for (const line of lines) {
    const date = dayHeadingDate(line, bezugstag);
    if (date) {
      current = { date, lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return sections;
}

/**
 * Holt die Anwendung aus einem Ortsfeld heraus, in dem beides zusammenklebt.
 *
 * Klebt auf dem Foto die Spalte "Behandlungsstelle" zu dicht an "Heilmittel",
 * trennt die Texterkennung beide nicht -- dann steht im Ort
 * "Wartebereich Sporth. Nordic Walking Info" und der Titel bleibt leer.
 * Ein Abstandsmass hilft dagegen nicht zuverlaessig; am Foto gemessen
 * schwanken die Spaltenabstaende zu stark. Das Woerterbuch hilft: der hintere
 * Teil ist eine bekannte Anwendung, der vordere bleibt der Ort.
 *
 * Greift bewusst nur, wenn sonst gar kein Titel zustande kaeme. Wo die
 * Spalten sauber erkannt wurden, aendert sich dadurch nichts.
 */
/**
 * Sucht die Anwendung im gesamten Text einer Terminzeile.
 *
 * Die Spaltenerkennung schliesst aus Pixelabstaenden. Auf einem gefalteten,
 * schraeg fotografierten Blatt traegt das nicht: ein Knick wirft einen
 * Schatten, die Zeile verrutscht, und Heilmittel landet im Ortsfeld oder
 * umgekehrt.
 *
 * Die Begriffe auf diesem Plan stammen dagegen aus einer festen, kurzen
 * Liste. Deshalb wird die Zeile zusaetzlich Wort fuer Wort danach abgesucht:
 * jede zusammenhaengende Wortfolge wird mit den bekannten Anwendungen
 * verglichen, die genaueste gewinnt. Das braucht keine Koordinaten und
 * uebersteht auch einen verlesenen Buchstaben.
 *
 * @returns {{title: string, vorher: string, nachher: string}|null}
 */
function findeAnwendungImText(text, lexicon) {
  const woerter = clean(text).split(/\s+/).filter(Boolean);
  if (!woerter.length) return null;
  const anwendungen = [...Object.keys(lexicon.title || {}), ...KNOWN_TREATMENTS];

  let beste = null;
  // Anwendungen dieses Plans sind hoechstens vier Woerter lang
  // ("Krankengymnastik im Bewegungsbad", "Beruf und Sozialrecht").
  for (let von = 0; von < woerter.length; von += 1) {
    for (let laenge = Math.min(4, woerter.length - von); laenge >= 1; laenge -= 1) {
      const stueck = woerter.slice(von, von + laenge).join(" ");
      const treffer = bestMatch(stueck, anwendungen);
      if (!treffer) continue;
      // Genauigkeit zaehlt zuerst, danach der laengere Begriff: aus
      // "Nordic Walking Info" soll nicht nur "Walking" werden.
      if (!beste || treffer.distance < beste.distance
        || (treffer.distance === beste.distance && laenge > beste.laenge)) {
        beste = { distance: treffer.distance, laenge, von, titel: treffer.value };
      }
    }
  }
  if (!beste) return null;

  return {
    title: beste.titel,
    vorher: clean(woerter.slice(0, beste.von).join(" ")).replace(/[,;:]+$/, ""),
    nachher: clean(woerter.slice(beste.von + beste.laenge).join(" ")).replace(/^[,;:]+/, ""),
  };
}

function holeAnwendungAusOrt(ort, lexicon) {
  const woerter = clean(ort).split(/\s+/);
  if (woerter.length < 2) return null;
  const anwendungen = [...Object.keys(lexicon.title || {}), ...KNOWN_TREATMENTS];

  // Steht dort in Wahrheit nur eine Anwendung, ist nichts abzutrennen.
  if (bestMatch(woerter.join(" "), anwendungen)) return null;

  let beste = null;
  for (let schnitt = 1; schnitt < woerter.length; schnitt += 1) {
    const hinten = woerter.slice(schnitt).join(" ");
    const treffer = bestMatch(hinten, anwendungen);
    if (!treffer) continue;
    // Bei gleicher Genauigkeit gewinnt der laengere Begriff: aus
    // "Nordic Walking Info" soll nicht nur "Info" werden.
    const laenge = woerter.length - schnitt;
    if (!beste || treffer.distance < beste.distance
      || (treffer.distance === beste.distance && laenge > beste.laenge)) {
      beste = { distance: treffer.distance, laenge, schnitt, titel: treffer.value };
    }
  }
  if (!beste) return null;

  const vorne = clean(woerter.slice(0, beste.schnitt).join(" ")).replace(/[,;:]+$/, "");
  if (!vorne) return null;
  return { title: beste.titel, location: vorne };
}

function fromLines(lines, columns, lexicon) {
  // Schritt 1: Rohzeilen sammeln und Folgezeilen anhaengen. Erst danach wird
  // korrigiert -- sonst wuerde "Krankengymnastik im" schon begradigt, bevor
  // "Bewegungsbad" dazukommt.
  const rows = [];
  let previous = null;
  let skipped = 0;
  const bekannt = wortbestand(lexicon);

  for (const line of lines) {
    const text = clean(line.text);
    if (isChrome(text) || isNoteLine(text) || (columns && line.top < columns.top - 4)) { previous = null; continue; }
    if (isColumnHeading(text) && !extractTime(line.words)) { previous = null; continue; }

    const stamp = extractTime(line.words);

    if (!stamp) {
      // Zeile ohne Uhrzeit: entweder der Umbruch einer Tabellenzelle oder eine
      // eigenstaendige Zeile ohne Zeitangabe. Welches von beidem, entscheidet
      // der Inhalt der Zelle darueber -- Spalte fuer Spalte.
      const cells = splitCells(line.words, line.height);
      if (!cells.length) continue;
      // "MTT Eigentraining" steht als eigene Tabellenzeile ohne Uhrzeit und
      // darf nicht an den Termin darueber angehaengt werden. Ein bekannter,
      // fuer sich stehender Begriff ist nie die Fortsetzung eines anderen.
      const own = clean(line.words.map((word) => word.text).join(" "));
      const standsAlone = Boolean(bestMatch(own, [...KNOWN_TREATMENTS, ...Object.keys(lexicon.title || {})]));
      const inReichweite = previous && line.top - previous.bottom < previous.height * CONTINUATION_GAP;

      let angehaengt = 0;
      if (inReichweite && !standsAlone) {
        for (const cell of cells) {
          const index = columns ? columnIndexAt(columns.anchors, cell) : "title";
          if (columns && columns.anchors[index].role === "time") continue;
          const slot = (previous.row.slots[index] ||= []);
          if (!istFortsetzung(slot.join(" "), cell.text, bekannt)) continue;
          haengeFortsetzungAn(slot, [cell.text], bekannt);
          angehaengt += 1;
        }
      }

      if (angehaengt) {
        // Eine Zelle kann ueber drei Zeilen laufen: der naechste Umbruch misst
        // seinen Abstand ab hier, nicht ab der Zeile mit der Uhrzeit.
        previous.bottom = line.bottom;
        previous.height = line.height;
      } else {
        skipped += 1;
        previous = null;
      }
      continue;
    }

    const cells = splitCells(stamp.rest, line.height);
    if (!cells.length) { previous = null; continue; }

    // Die Spalten-Slots entstehen sofort: die naechste Zeile muss wissen, was
    // in ihrer Spalte bereits steht, um ueber eine Fortsetzung zu entscheiden.
    const slots = columns ? assignByColumns(cells, columns.anchors).slots : { title: [] };
    const row = { time: stamp.time, end: stamp.end, cells, slots, confidence: Math.min(line.confidence, ...cells.map((cell) => cell.confidence)) };
    rows.push(row);
    previous = { row, bottom: line.bottom, height: line.height };
  }

  // Schritt 2: Zellen zuordnen, Fortsetzungen anhaengen, dann korrigieren.
  const items = rows.map((row) => {
    let assigned;
    if (columns) {
      // Die Fortsetzungen stehen schon in ihren Slots -- hier werden die
      // Spalten nur noch zu Feldern zusammengesetzt.
      assigned = slotsToFields(row.slots, columns.anchors);
    } else {
      assigned = assignByContent(row.cells, lexicon);
      const extra = row.slots.title;
      if (extra.length) assigned.title = clean(haengeFortsetzungAn([assigned.title], extra, bekannt).join(" "));
    }

    // Zuerst pruefen, ob der zugeordnete Titel ueberhaupt eine bekannte
    // Anwendung ist. Sitzt die Spaltenzuordnung, ist er es -- dann bleibt
    // alles, wie es ist. Sitzt sie nicht, entscheidet das Woerterbuch.
    // Die Zeile so festhalten, wie sie zugeordnet wurde. Jede Reparatur
    // sucht darin -- wer vorher etwas loescht, sucht hinterher vergeblich.
    const rohZeile = [assigned.location, assigned.title, assigned.practitioner]
      .map((wert) => clean(wert)).filter(Boolean).join(" ");

    const anwendungen = [...Object.keys(lexicon.title || {}), ...KNOWN_TREATMENTS];
    const istAnwendung = (wert) => Boolean(clean(wert) && bestMatch(wert, anwendungen));

    // Ein Hinweistext in der Titelspalte wird verworfen, bevor gesucht wird --
    // sonst bliebe er als Terminname stehen.
    if (clean(assigned.title) && !istAnwendung(assigned.title) && istProsa(assigned.title)) {
      assigned.title = "";
    }

    // Eine Anrede oder ein reines Behandler-Wort im Titel heisst: die Spalten
    // sind verrutscht. Bewusst eng geprueft -- "Helparm Üben" und "Info
    // Ernährung" sehen wie zwei Namen aus und sind doch Anwendungen.
    const titelIstBehandler = clean(assigned.title)
      && !istAnwendung(assigned.title)
      && (TITLE_PREFIX.test(assigned.title) || Boolean(bestMatch(assigned.title, PRACTITIONER_WORDS)));

    if (titelIstBehandler) {
      if (!clean(assigned.practitioner)) assigned.practitioner = assigned.title;
      assigned.title = "";
    }

    if (!istAnwendung(assigned.title)) {
      // Haeufigster Fall: die Anwendung klebt hinten am Ortsfeld.
      if (!clean(assigned.title) && assigned.location) {
        const gerettet = holeAnwendungAusOrt(assigned.location, lexicon);
        if (gerettet) {
          assigned.title = gerettet.title;
          assigned.location = gerettet.location;
        }
      }
      // Sonst die ganze Zeile durchsuchen, so wie sie urspruenglich dastand.
      if (!istAnwendung(assigned.title)) {
        const gefunden = findeAnwendungImText(rohZeile, lexicon);
        if (gefunden) {
          assigned.title = gefunden.title;
          if (gefunden.vorher && !istAnwendung(assigned.location)) assigned.location = gefunden.vorher;
          if (gefunden.nachher && !clean(assigned.practitioner)) assigned.practitioner = gefunden.nachher;
        }
      }
    }

    const title = correct(assigned.title, "title", lexicon);
    const practitioner = correct(assigned.practitioner, "practitioner", lexicon);
    const location = correct(tidyLocation(assigned.location), "location", lexicon);

    return {
      id: newId(),
      time: row.time,
      duration: row.end ? minutesBetween(row.time, row.end) : 30,
      title: title.value || "Behandlung",
      location: location.value,
      practitioner: practitioner.value,
      note: assigned.note,
      category: categorize(title.value, assigned.note, practitioner.value),
      confidence: row.confidence,
      corrections: [title, practitioner, location]
        .filter((entry) => entry.corrected)
        .map((entry) => `${entry.from} → ${entry.value}`),
    };
  });

  return { items, skipped };
}

/** Rueckfallebene ohne Koordinaten -- etwa fuer Text aus einer PDF-Textebene. */
function fromPlainText(text, lexicon) {
  const items = [];
  for (const raw of String(text).split(/\r?\n/)) {
    // Bewusst nur trimmen: die Mehrfach-Leerzeichen sind hier die Spaltengrenzen.
    const line = raw.replace(/[|¦]/g, " ").replace(/[‐‑–—]/g, "-").trim();
    if (!line || isChrome(line) || isNoteLine(line)) continue;
    const match = line.match(/^(\d{1,2}\s*[:.]\s*\d{2})\s*(?:-\s*(\d{1,2}\s*[:.]\s*\d{2}))?\s+(.*)$/);
    if (!match) continue;
    const time = normalizeTime(match[1]);
    if (!time) continue;
    const parts = match[3].split(/\s{2,}|\t+|\s+[·|]\s+/).map(clean).filter(Boolean);
    const assigned = assignByContent(parts.map((part) => ({ text: part })), lexicon);
    const title = correct(assigned.title || clean(match[3]), "title", lexicon);
    items.push({
      id: newId(),
      time,
      duration: match[2] ? minutesBetween(time, normalizeTime(match[2])) : 30,
      title: title.value,
      location: assigned.location,
      practitioner: assigned.practitioner,
      note: assigned.note,
      category: categorize(title.value, assigned.note, assigned.practitioner),
      confidence: 0,
      corrections: title.corrected ? [`${title.from} → ${title.value}`] : [],
    });
  }
  return items;
}

export { KNOWN_TREATMENTS, clean, holeAnwendungAusOrt, findeAnwendungImText };
