/**
 * Datenhaltung des Terminplans.
 *
 * Grundgedanke: Der TAG ist die Einheit, nicht der einzelne Termin.
 * Ein Scan liefert immer genau einen Tagesplan. Wird derselbe Tag erneut
 * eingelesen, ersetzt der neue Plan den alten komplett (nach Rueckfrage) --
 * dadurch entfaellt jede Dedup-Heuristik, die neue Termine verschlucken kann.
 *
 * Alles liegt im localStorage des Geraets. Es gibt kein Backend und keine
 * Anmeldung; jede Patientin und jeder Patient hat den eigenen Plan im eigenen
 * Browser.
 */

const KEY = "federsee.plan.v2";
const LEGACY_KEYS = ["federsee.plan.v1", "federseePlan", "behandlungsplan"];

export const CATEGORIES = [
  { id: "bewegung", label: "Bewegung & Bad", color: "#0f7a86" },
  { id: "massage", label: "Massage & Packung", color: "#8a5a2b" },
  { id: "medizin", label: "Arzt & Diagnostik", color: "#a8323f" },
  { id: "beratung", label: "Beratung & Vortrag", color: "#4a5aa8" },
  { id: "essen", label: "Mahlzeiten", color: "#6b7a2f" },
  { id: "sonstiges", label: "Sonstiges", color: "#5a6470" },
];

const emptyState = () => ({
  version: 2,
  profile: { name: "", clinic: "" },
  days: {},
  lexicon: { title: {}, practitioner: {}, location: {} },
  settings: { reminder: 15, keepArchiveDays: 400 },
});

let state = emptyState();
const listeners = new Set();

/* ---------------------------------------------------------------- Laden */

function readRaw() {
  try {
    const current = localStorage.getItem(KEY);
    if (current) return JSON.parse(current);
    for (const key of LEGACY_KEYS) {
      const legacy = localStorage.getItem(key);
      if (legacy) return migrateLegacy(JSON.parse(legacy));
    }
  } catch (error) {
    console.warn("Gespeicherte Daten konnten nicht gelesen werden.", error);
  }
  return null;
}

/** Aeltere Staende hielten eine flache Terminliste. Diese wird zu Tagen gebuendelt. */
function migrateLegacy(data) {
  const events = Array.isArray(data) ? data : data?.events;
  if (!Array.isArray(events)) return null;
  const next = emptyState();
  for (const event of events) {
    if (!event?.date) continue;
    const day = (next.days[event.date] ||= { date: event.date, items: [], importedAt: null, source: "uebernommen" });
    day.items.push(normalizeItem(event));
  }
  Object.values(next.days).forEach(sortDay);
  return next;
}

export function load() {
  const stored = readRaw();
  state = stored ? { ...emptyState(), ...stored, lexicon: { ...emptyState().lexicon, ...(stored.lexicon || {}) } } : emptyState();
  return state;
}

/* -------------------------------------------------------------- Sichern */

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 120);
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (error) {
    console.error("Speichern fehlgeschlagen", error);
    notify({ type: "storage-error", error });
  }
}

/** Sofort schreiben -- fuer pagehide/visibilitychange, damit nichts verloren geht. */
export function flush() {
  clearTimeout(saveTimer);
  persist();
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(detail) {
  listeners.forEach((listener) => listener(state, detail));
}

export function commit(detail = {}) {
  save();
  notify(detail);
}

export const getState = () => state;

/* --------------------------------------------------------- Hilfsfunktionen */

export const todayISO = () => toISO(new Date());

export function toISO(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

export function addDays(iso, count) {
  const date = new Date(`${iso}T12:00:00`);
  date.setDate(date.getDate() + count);
  return toISO(date);
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);

export function normalizeItem(raw = {}) {
  return {
    id: raw.id || newId(),
    time: raw.time || "",
    duration: Number(raw.duration) > 0 ? Number(raw.duration) : 30,
    title: (raw.title || "").trim(),
    location: (raw.location || "").trim(),
    practitioner: (raw.practitioner || "").trim(),
    category: raw.category || "sonstiges",
    note: (raw.note || "").trim(),
    done: Boolean(raw.done),
  };
}

const sortDay = (day) => day.items.sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));

/* ------------------------------------------------------------- Tage lesen */

export function getDay(iso) {
  return state.days[iso] || null;
}

export function allDays() {
  return Object.values(state.days).sort((a, b) => a.date.localeCompare(b.date));
}

/** Die Tage ab heute -- das ist die Hauptansicht. Vergangenes bleibt im Archiv. */
export function upcomingDays(count = 5, from = todayISO()) {
  return allDays().filter((day) => day.date >= from).slice(0, count);
}

export function pastDays(before = todayISO()) {
  return allDays().filter((day) => day.date < before).reverse();
}

/** Naechster noch nicht begonnener Termin, inklusive Datum. */
export function nextAppointment(now = new Date()) {
  const today = toISO(now);
  const clock = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  for (const day of allDays()) {
    if (day.date < today) continue;
    for (const item of day.items) {
      if (item.done) continue;
      if (day.date === today && item.time && item.time < clock) continue;
      return { day, item };
    }
  }
  return null;
}

/* ------------------------------------------------------------ Tage aendern */

/**
 * Schreibt einen kompletten Tagesplan.
 * mode "replace": neuer Plan gewinnt (Standard nach erneutem Scan).
 * mode "merge":   bestehende Termine bleiben, neue kommen dazu.
 */
export function putDay(iso, items, { mode = "replace", source = "Scan" } = {}) {
  const incoming = items.map(normalizeItem).filter((item) => item.title || item.time);
  const existing = state.days[iso];

  if (mode === "merge" && existing) {
    const known = new Set(existing.items.map(fingerprint));
    const merged = [...existing.items, ...incoming.filter((item) => !known.has(fingerprint(item)))];
    state.days[iso] = { ...existing, items: merged, importedAt: Date.now(), source };
  } else {
    state.days[iso] = { date: iso, items: incoming, importedAt: Date.now(), source };
  }

  sortDay(state.days[iso]);
  learnFrom(state.days[iso].items);
  commit({ type: "day-changed", date: iso });
  return state.days[iso];
}

/**
 * Erkennungsmerkmal fuer den Ergaenzen-Modus. Verglichen wird eine bereinigte
 * Form, damit eine Verlesung ("Bewegı.ther.Sch.") nicht als eigener Termin
 * neben dem korrekt gelesenen steht.
 */
const fingerprint = (item) => `${item.time}|${item.title
  .toLocaleLowerCase("de-DE")
  .replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss")
  .replace(/[^a-z0-9]/g, "")}`;

export function removeDay(iso) {
  delete state.days[iso];
  commit({ type: "day-removed", date: iso });
}

export function upsertItem(iso, raw) {
  const day = (state.days[iso] ||= { date: iso, items: [], importedAt: Date.now(), source: "manuell" });
  const item = normalizeItem(raw);
  const index = day.items.findIndex((entry) => entry.id === item.id);
  if (index >= 0) day.items[index] = item;
  else day.items.push(item);
  sortDay(day);
  learnFrom([item]);
  commit({ type: "item-changed", date: iso, id: item.id });
  return item;
}

export function patchItem(iso, id, patch) {
  const day = state.days[iso];
  const item = day?.items.find((entry) => entry.id === id);
  if (!item) return null;
  Object.assign(item, patch);
  sortDay(day);
  commit({ type: "item-changed", date: iso, id });
  return item;
}

export function removeItem(iso, id) {
  const day = state.days[iso];
  if (!day) return;
  day.items = day.items.filter((entry) => entry.id !== id);
  if (!day.items.length) delete state.days[iso];
  commit({ type: "item-removed", date: iso, id });
}

export function setSetting(key, value) {
  state.settings[key] = value;
  commit({ type: "settings" });
}

export function setProfile(patch) {
  Object.assign(state.profile, patch);
  commit({ type: "profile" });
}

/* ---------------------------------------------------------------- Lexikon */

/**
 * Behandlungsplaene wiederholen dieselben Anwendungen, Raeume und Namen ueber
 * Wochen hinweg. Jeder bestaetigte Eintrag wird gezaehlt; der Parser korrigiert
 * damit spaeter OCR-Verlesungen ("Muler" -> "Müller").
 */
function learnFrom(items) {
  for (const item of items) {
    countTerm("title", item.title);
    countTerm("practitioner", item.practitioner);
    countTerm("location", item.location);
  }
}

/** Vergleichsform: Gross-/Kleinschreibung, Umlaute und Satzzeichen fallen weg. */
const fold = (value) => value.toLocaleLowerCase("de-DE")
  .replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss")
  .replace(/[^a-z0-9]/g, "");

/**
 * Zeichen, die in deutschen Klinikplaenen nicht vorkommen, sind ein sicheres
 * Zeichen fuer eine Verlesung ("Bewegı.ther.Sch." statt "Beweg.ther.Sch.").
 */
export const oddCharacters = (value) => (String(value).match(/[^A-Za-zÄÖÜäöüß0-9 .,:;/()+&-]/g) || []).length;

/**
 * Pro Begriff wird nur EINE Schreibweise gefuehrt. Sonst sammelt das
 * Woerterbuch Verlesungsvarianten an und normalisiert spaeter womoeglich
 * auf die falsche davon. Die sauberere Schreibweise setzt sich durch.
 */
function countTerm(field, value) {
  const term = (value || "").trim();
  if (term.length < 3) return;
  const bucket = (state.lexicon[field] ||= {});
  const key = fold(term);
  const known = Object.keys(bucket).find((entry) => fold(entry) === key);

  if (!known) { bucket[term] = 1; return; }
  if (known === term) { bucket[term] += 1; return; }

  const count = bucket[known] + 1;
  if (oddCharacters(term) < oddCharacters(known)) {
    delete bucket[known];
    bucket[term] = count;
  } else {
    bucket[known] = count;
  }
}

export const getLexicon = () => state.lexicon;

/* ------------------------------------------------------- Sichern / Umziehen */

export function exportBackup() {
  return JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2);
}

export function importBackup(json, { mode = "replace" } = {}) {
  const data = JSON.parse(json);
  if (!data || typeof data !== "object" || !data.days) throw new Error("Die Datei enthaelt keinen Terminplan.");
  if (mode === "merge") {
    for (const [iso, day] of Object.entries(data.days)) {
      if (!state.days[iso]) state.days[iso] = day;
    }
  } else {
    state = { ...emptyState(), ...data };
  }
  commit({ type: "restored" });
  return state;
}

export function clearAll() {
  state = emptyState();
  commit({ type: "cleared" });
}
