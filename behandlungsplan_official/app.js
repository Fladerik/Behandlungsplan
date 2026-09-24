/**
 * Terminplan -- Oberfläche.
 *
 * Ablauf: Plan scannen -> prüfen -> speichern. Gespeichert wird ausschließlich
 * lokal; beim Schließen der Seite geht nichts verloren, beim erneuten Öffnen
 * ist alles wieder da.
 */

import { ANWENDUNG, FASSUNG } from "./konfiguration.js";
import * as store from "./store.js";
import { CATEGORIES } from "./store.js";
import { parsePage, categorize, categoryLabel } from "./parser.js";
import { readFiles, releaseWorker } from "./ocr.js";
import { makeICS, download, speichern } from "./ics.js";

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

const VISIBLE_DAYS = 5;

const ui = {
  selectedDay: "alle",
  category: "alle",
  search: "",
  calendarMonth: null,
  review: null,
  reviewWarnings: [],
};

const categoryColor = (id) => CATEGORIES.find((entry) => entry.id === id)?.color || "#5a6470";

/** Wortlaut an einer Stelle -- er erscheint beim ersten Start und im Menü. */
const PRIVACY_TEXT = `<strong>Ihre Daten bleiben auf diesem Gerät.</strong> Behandlungspläne und
  Termine werden direkt in Ihrem Browser verarbeitet und lokal auf diesem Gerät gespeichert.
  Es erfolgt keine automatische Übertragung an die Website oder an Dritte.<br><br>
  <strong>Wichtig:</strong> Wenn Sie Browserdaten, Websitedaten oder Cookies für diese Webseite
  löschen, können die lokal gespeicherten Termine entfernt werden. Sichern Sie Ihre Daten bei
  Bedarf vorher oder exportieren Sie sie in Ihren Kalender.`;

/* ------------------------------------------------------------ Formatierung */

const fmtDay = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "2-digit", month: "long" });
const fmtShortDow = new Intl.DateTimeFormat("de-DE", { weekday: "short" });
const fmtMonth = new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric" });

const dateOf = (iso) => new Date(`${iso}T12:00:00`);

function relativeDay(iso) {
  const today = store.todayISO();
  if (iso === today) return "Heute";
  if (iso === store.addDays(today, 1)) return "Morgen";
  if (iso === store.addDays(today, -1)) return "Gestern";
  return "";
}

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

const nowClock = () => {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
};

function endOf(time, duration) {
  if (!time) return "";
  const [hours, minutes] = time.split(":").map(Number);
  const total = hours * 60 + minutes + Number(duration || 30);
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function toast(message, ms = 3200) {
  const element = $("#toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.hidden = true; }, ms);
}

/* -------------------------------------------------------------- Rendering */

/**
 * Begrüßung nach Tageszeit. Ohne hinterlegten Namen bleibt der Titel stehen --
 * ein "Guten Morgen," ohne Anrede wirkt unfertig.
 */
function renderGreeting() {
  const name = store.getState().profile.name;
  const element = $("#greeting");
  if (!name) {
    element.textContent = ANWENDUNG.name;
    return;
  }
  // Grenzen wie vorgegeben, in Minuten gerechnet: bis 11:00 einschließlich
  // „Guten Morgen“, ab 11:01 bis 18:00 „Hallo“, danach „Guten Abend“.
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const gruss = minutes <= 11 * 60 ? "Guten Morgen" : minutes <= 18 * 60 ? "Hallo" : "Guten Abend";
  element.textContent = `${gruss}, ${name}`;
}

function render() {
  renderGreeting();
  renderNextUp();
  renderDayStrip();
  renderFilter();
  renderPlan();
}

function renderNextUp() {
  const container = $("#next-up");
  const next = store.nextAppointment();
  if (!next) {
    container.innerHTML = `<div class="next-card is-empty">Zurzeit steht kein weiterer Termin an.</div>`;
    return;
  }

  const { day, item, laeuft } = next;
  const heute = day.date === store.todayISO();
  const wann = heute ? "Heute" : fmtDay.format(dateOf(day.date));
  const meta = [item.location, item.practitioner].filter(Boolean)
    .map((wert) => `<span>${escapeHTML(wert)}</span>`).join("");

  container.innerHTML = `
    <div class="next-card ${laeuft ? "is-now" : ""}">
      <p class="eyebrow">
        ${laeuft ? "Läuft gerade" : "Nächster Termin"} · ${escapeHTML(wann)}
        <span class="rest">${escapeHTML(restText(day, item, laeuft))}</span>
      </p>
      <div class="clock">${escapeHTML(item.time || "--:--")}<small>bis ${escapeHTML(endOf(item.time, item.duration))}</small></div>
      <div class="body">
        <p class="title">${escapeHTML(item.title || "Ohne Bezeichnung")}</p>
        ${meta ? `<p class="meta">${meta}</p>` : ""}
      </div>
    </div>`;
}

/** "in 25 Min.", "noch 20 Min.", "morgen" -- was für den Patienten zählt. */
function restText(day, item, laeuft) {
  const jetzt = new Date();
  if (day.date !== store.todayISO()) {
    const tage = Math.round((dateOf(day.date) - dateOf(store.todayISO())) / 86400000);
    return tage === 1 ? "morgen" : `in ${tage} Tagen`;
  }
  const [stunde, minute] = (item.time || "00:00").split(":").map(Number);
  const beginn = stunde * 60 + minute;
  const minutenJetzt = jetzt.getHours() * 60 + jetzt.getMinutes();

  if (laeuft) {
    const rest = beginn + (Number(item.duration) || 30) - minutenJetzt;
    return rest <= 1 ? "endet gleich" : `noch ${rest} Min.`;
  }
  const bis = beginn - minutenJetzt;
  if (bis <= 0) return "jetzt";
  if (bis < 60) return `in ${bis} Min.`;
  const stunden = Math.floor(bis / 60);
  const restMinuten = bis % 60;
  return restMinuten ? `in ${stunden} Std. ${restMinuten} Min.` : `in ${stunden} Std.`;
}

/** Die Tagesleiste zeigt heute und die folgenden Tage -- Vergangenes nur im Kalender. */
function renderDayStrip() {
  const strip = $("#day-strip");
  const today = store.todayISO();
  const withPlan = store.upcomingDays(VISIBLE_DAYS);
  // Immer heute anzeigen, auch wenn für heute nichts eingetragen ist.
  const dates = [...new Set([today, ...withPlan.map((day) => day.date)])].sort().slice(0, VISIBLE_DAYS);

  const tabs = [`<button class="day-tab" data-day="alle" aria-pressed="${ui.selectedDay === "alle"}">
      <span class="dow">Alle</span><span class="num">${dates.length}</span><span class="count">Tage</span>
    </button>`];

  for (const iso of dates) {
    const day = store.getDay(iso);
    const count = day?.items.length || 0;
    tabs.push(`<button class="day-tab ${iso === today ? "is-today" : ""}" data-day="${iso}" aria-pressed="${ui.selectedDay === iso}">
      <span class="dow">${escapeHTML(fmtShortDow.format(dateOf(iso)))}</span>
      <span class="num">${iso.slice(8)}.${iso.slice(5, 7)}.</span>
      <span class="count">${count ? `${count} Termine` : "frei"}</span>
    </button>`);
  }
  strip.innerHTML = tabs.join("");
}

function renderFilter() {
  const used = new Set();
  for (const day of store.upcomingDays(VISIBLE_DAYS)) day.items.forEach((item) => used.add(item.category));
  const chips = [`<button class="chip" data-category="alle" aria-pressed="${ui.category === "alle"}">Alle</button>`];
  for (const category of CATEGORIES) {
    if (!used.has(category.id)) continue;
    chips.push(`<button class="chip" data-category="${category.id}" aria-pressed="${ui.category === category.id}" style="color:${category.color}">
      <span class="dot"></span>${escapeHTML(category.label)}</button>`);
  }
  $("#category-filter").innerHTML = chips.length > 1 ? chips.join("") : "";
}

function matchesFilter(item) {
  if (ui.category !== "alle" && item.category !== ui.category) return false;
  if (!ui.search) return true;
  const haystack = `${item.title} ${item.location} ${item.practitioner} ${item.note}`.toLocaleLowerCase("de-DE");
  return haystack.includes(ui.search);
}

function renderPlan() {
  const list = $("#plan-list");
  const today = store.todayISO();
  const days = store.upcomingDays(VISIBLE_DAYS)
    .filter((day) => ui.selectedDay === "alle" || day.date === ui.selectedDay);

  const hasAnyData = store.allDays().length > 0;
  $("#empty-state").hidden = hasAnyData;

  if (!days.length) {
    list.innerHTML = hasAnyData
      ? `<p class="day-empty">Für diesen Zeitraum ist nichts eingetragen. Ältere Tage stehen im Kalender.</p>`
      : "";
    return;
  }

  list.innerHTML = days.map((day) => {
    const items = day.items.filter(matchesFilter);
    const label = relativeDay(day.date);
    return `
      <section class="day-block" id="day-${day.date}">
        <div class="day-heading">
          <h2>${escapeHTML(fmtDay.format(dateOf(day.date)))}</h2>
          ${label ? `<span class="badge">${label}</span>` : ""}
          <button class="rescan" data-rescan="${day.date}">neu einlesen</button>
        </div>
        <div class="items">
          ${items.length
            ? items.map((item) => itemCard(day, item, today)).join("")
            : `<p class="day-empty">Keine Termine in dieser Auswahl.</p>`}
        </div>
      </section>`;
  }).join("");
}

function itemCard(day, item, today) {
  const clock = nowClock();
  const finish = endOf(item.time, item.duration);
  const isToday = day.date === today;
  const isNow = isToday && item.time <= clock && clock < finish;
  const isPast = isToday && finish <= clock;
  const meta = [item.location, item.practitioner].filter(Boolean)
    .map((value) => `<span>${escapeHTML(value)}</span>`).join("");

  return `
    <button class="item ${item.done ? "is-done" : ""} ${isNow ? "is-now" : ""} ${isPast ? "is-past" : ""}"
            style="--stripe:${categoryColor(item.category)}"
            data-edit="${item.id}" data-date="${day.date}">
      <div class="time">${escapeHTML(item.time || "--:--")}<small>bis ${escapeHTML(finish)}</small></div>
      <div class="stripe"></div>
      <div>
        <p class="title">${escapeHTML(item.title)}</p>
        ${meta ? `<p class="meta">${meta}</p>` : ""}
        <span class="tag">${escapeHTML(categoryLabel(item.category))}</span>
      </div>
    </button>`;
}

/* ------------------------------------------------------------- Kalender */

function openCalendar(iso = store.todayISO()) {
  ui.calendarMonth = iso.slice(0, 7);
  ui.calendarSelected = iso;
  renderCalendar();
  $("#calendar-dialog").showModal();
}

function renderCalendar() {
  const [year, month] = ui.calendarMonth.split("-").map(Number);
  $("#month-label").textContent = fmtMonth.format(new Date(year, month - 1, 1));

  const first = new Date(year, month - 1, 1);
  const offset = (first.getDay() + 6) % 7; // Woche beginnt am Montag
  const daysInMonth = new Date(year, month, 0).getDate();
  const today = store.todayISO();

  const cells = [];
  for (let index = 0; index < offset; index += 1) cells.push(`<span></span>`);
  for (let dayNumber = 1; dayNumber <= daysInMonth; dayNumber += 1) {
    const iso = `${ui.calendarMonth}-${String(dayNumber).padStart(2, "0")}`;
    const day = store.getDay(iso);
    const dots = day ? `<span class="dots">${day.items.slice(0, 4).map(() => "<i></i>").join("")}</span>` : "";
    cells.push(`<button class="month-cell ${day ? "has-plan" : ""} ${iso < today ? "is-past" : ""} ${iso === today ? "is-today" : ""}"
      data-cal-day="${iso}" aria-pressed="${iso === ui.calendarSelected}" ${day ? "" : "disabled"}>
      <span>${dayNumber}</span>${dots}</button>`);
  }
  $("#month-grid").innerHTML = cells.join("");
  renderCalendarDay();
}

function renderCalendarDay() {
  const iso = ui.calendarSelected;
  const day = store.getDay(iso);
  const container = $("#calendar-day");
  if (!day) {
    container.innerHTML = `<p class="day-empty">Für ${escapeHTML(fmtDay.format(dateOf(iso)))} ist nichts hinterlegt.</p>`;
    return;
  }
  const isArchive = iso < store.todayISO();
  container.innerHTML = `
    <h3>${escapeHTML(fmtDay.format(dateOf(iso)))} ${isArchive ? "· Archiv" : ""}</h3>
    <div class="items">${day.items.map((item) => itemCard(day, item, store.todayISO())).join("")}</div>`;
}

/* ------------------------------------------------- Scannen und Prüfen */

function startScan() {
  $("#file-input").value = "";
  $("#file-input").click();
}

async function handleFiles(files) {
  if (!files.length) return;
  const dialog = $("#review-dialog");
  $("#review-body").innerHTML = "";
  $("#review-foot").hidden = true;
  $("#review-progress").hidden = false;
  setProgress(0.02, "Vorbereitung …");
  if (!dialog.open) dialog.showModal();

  try {
    const pages = await readFiles(files, ({ label, ratio }) => setProgress(ratio, label));
    const lexicon = store.getLexicon();

    // Rohergebnis der Texterkennung festhalten. Scheitert eine Erkennung beim
    // Nutzer, laesst sich damit nachvollziehen, was sein Geraet tatsaechlich
    // gelesen hat -- ohne dass er ein Foto herausgeben muss und ohne dass
    // jemand raten muss. Nur im Arbeitsspeicher, nichts wird gespeichert.
    letzteDiagnose = {
      fassung: FASSUNG,
      zeitpunkt: new Date().toISOString(),
      geraet: navigator.userAgent,
      bildschirm: `${screen.width}x${screen.height} @${devicePixelRatio}`,
      seiten: pages.map((page) => ({
        name: page.name,
        entzerrt: Boolean(page.entzerrt),
        textLaenge: (page.text || "").length,
        text: (page.text || "").slice(0, 4000),
        tsv: (page.tsv || "").split("\n").slice(0, 700).join("\n"),
      })),
    };

    // Eine Seite kann mehrere Tage enthalten, und ein Tag kann sich über zwei
    // Seiten ziehen. Deshalb wird nach Datum gebündelt, nicht nach Seite.
    const byDate = new Map();
    const warnings = [];
    let unknownIndex = 0;

    let skipped = 0;

    for (const page of pages) {
      const parsed = parsePage(page.tsv, page.text, { lexicon });
      warnings.push(...parsed.warnings.map((text) => pages.length > 1 ? `${page.name}: ${text}` : text));
      skipped += parsed.skipped;
      for (const day of parsed.days) {
        const key = day.date || `ohne-datum-${unknownIndex += 1}`;
        const entry = byDate.get(key) || { date: day.date, items: [], sources: [], confidence: parsed.confidence };
        entry.items.push(...day.items);
        if (!entry.sources.includes(page.name)) entry.sources.push(page.name);
        byDate.set(key, entry);
      }
    }

    if (!byDate.size) {
      $("#review-progress").hidden = true;
      $("#review-body").innerHTML = `<div class="notice">Auf den gewählten Dateien wurden keine Termine gefunden.
        Häufige Ursachen: zu dunkles Foto, starke Schräglage oder ein sehr kleiner Ausschnitt.
        Am besten das Blatt flach hinlegen, von oben fotografieren und den ganzen Plan erfassen.
        Ein neuer Versuch kostet nichts – es geht nichts verloren.
        ${warnings.length ? `<ul>${warnings.map((text) => `<li>${escapeHTML(text)}</li>`).join("")}</ul>` : ""}</div>`;
      return;
    }

    ui.review = [...byDate.values()]
      .sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"))
      .map((day) => {
        day.items.sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));
        // Ein bereits vorhandener Tag wird standardmäßig ersetzt: Der neue Plan
        // ist der aktuellere. Zusammenführen bleibt als bewusste Wahl möglich.
        return { ...day, mode: "replace", existingCount: store.getDay(day.date)?.items.length || 0 };
      });
    // Zeilen ohne Uhrzeit gibt es auf jeder Seite ("Eigentraining Therme").
    // Eine zusammengefasste Zeile genügt -- pro Seite wäre es nur Rauschen.
    if (skipped) {
      warnings.push(`${skipped} Zeilen ohne Uhrzeit wurden nicht übernommen (etwa „Eigentraining Therme“ oder Hinweistexte). Bei Bedarf unten von Hand ergänzen.`);
    }
    ui.reviewWarnings = warnings;

    $("#review-progress").hidden = true;
    $("#review-foot").hidden = false;
    renderReview();
  } catch (error) {
    console.error(error);
    $("#review-progress").hidden = true;
    const fehltAufServer = error.missing?.length || /Tesseract is not defined|Texterkennung fehlt/.test(error.message);
    $("#review-body").innerHTML = fehltAufServer
      ? `<div class="notice conflict">
           <strong>Die Texterkennung ist auf dem Server nicht vollständig vorhanden.</strong>
           <p>${escapeHTML(error.message)}</p>
           <p>Beim Hochladen fehlen häufig die Unterordner <code>vendor</code> und <code>tessdata</code>
              oder einzelne Dateien daraus – oft bricht die Übertragung mittendrin ab.</p>
           <p><a href="./pruefen.html">Installation prüfen</a> zeigt Ihnen alle Dateien im Überblick.</p>
         </div>`
      : `<div class="notice conflict">Die Erkennung ist fehlgeschlagen: ${escapeHTML(error.message)}<br>
           Termine lassen sich jederzeit auch von Hand über „+ Termin“ eintragen.</div>`;
  } finally {
    releaseWorker();
  }
}

function setProgress(ratio, label) {
  $("#progress-bar").style.width = `${Math.max(2, Math.round(ratio * 100))}%`;
  $("#progress-text").textContent = label;
}

function renderReview() {
  const globalWarnings = (ui.reviewWarnings || []).length
    ? `<div class="notice"><strong>Hinweise zur Erkennung:</strong>
         <ul>${ui.reviewWarnings.map((text) => `<li>${escapeHTML(text)}</li>`).join("")}</ul></div>`
    : "";

  // Der wichtigste Satz für die Nutzer: Ein Fehler kostet nichts. Genau das
  // nimmt die Scheu, überhaupt zu fotografieren.
  const reassurance = `<p class="retry-note">Etwas falsch erkannt? Jeden Tag beliebig oft neu
    fotografieren – der neue Plan ersetzt den alten. Am besten das Blatt flach hinlegen
    und gerade von oben aufnehmen.</p>`;

  $("#review-body").innerHTML = globalWarnings + ui.review.map((day, dayIndex) => {
    const heading = day.date ? escapeHTML(fmtDay.format(dateOf(day.date))) : "Tag ohne erkanntes Datum";

    const conflict = day.existingCount
      ? `<div class="notice conflict">
           <strong>Für diesen Tag sind bereits ${day.existingCount} Termine gespeichert.</strong>
           <div class="conflict-choice">
             <label><input type="radio" name="mode-${dayIndex}" value="replace" data-mode="${dayIndex}" ${day.mode === "replace" ? "checked" : ""}>
               <span>Alten Tag <strong>ersetzen</strong> – der neue Plan gilt (empfohlen).</span></label>
             <label><input type="radio" name="mode-${dayIndex}" value="merge" data-mode="${dayIndex}" ${day.mode === "merge" ? "checked" : ""}>
               <span>Termine <strong>ergänzen</strong> – Bestehendes bleibt erhalten.</span></label>
           </div>
         </div>`
      : "";

    return `
      <section class="review-page" data-page="${dayIndex}">
        <div class="review-head">
          <label class="field"><span>Datum</span>
            <input type="date" data-page-date="${dayIndex}" value="${escapeHTML(day.date || "")}"></label>
          <div>
            <strong class="review-day">${heading}</strong>
            <span class="review-source">${escapeHTML(day.sources.join(", "))}${day.confidence ? ` · Lesequalität ${day.confidence} %` : ""}</span>
          </div>
        </div>
        ${conflict}
        ${day.items.map((item, itemIndex) => reviewRow(item, dayIndex, itemIndex)).join("")}
        <button class="ghost-button" data-add-row="${dayIndex}">+ Zeile ergänzen</button>
      </section>`;
  }).join("") + reassurance;
}

function reviewRow(item, dayIndex, itemIndex) {
  const fehltTitel = !item.title.trim();
  const flagged = fehltTitel || item.corrections?.length || (item.confidence && item.confidence < 70);
  const flag = fehltTitel
    ? `<span class="flag">Anwendung nicht erkannt – bitte eintragen</span>`
    : item.corrections?.length
      ? `<span class="flag">automatisch korrigiert: ${escapeHTML(item.corrections.join(", "))}</span>`
      : item.confidence && item.confidence < 70 ? `<span class="flag">unsicher erkannt – bitte prüfen</span>` : "";

  return `
    <div class="review-row ${flagged ? "is-flagged" : ""}" data-row="${dayIndex}:${itemIndex}">
      <input type="time" data-field="time" value="${escapeHTML(item.time)}" aria-label="Uhrzeit">
      <div class="fields">
        <input class="titel" data-field="title" value="${escapeHTML(item.title)}" placeholder="Anwendung eintragen" aria-label="Anwendung">
        <div class="pair">
          <input data-field="location" value="${escapeHTML(item.location)}" placeholder="Ort" aria-label="Ort">
          <input data-field="practitioner" value="${escapeHTML(item.practitioner)}" placeholder="Behandler" aria-label="Behandler">
        </div>
        ${flag}
      </div>
      <button class="drop" data-drop="${dayIndex}:${itemIndex}" aria-label="Zeile entfernen">×</button>
    </div>`;
}

function saveReview() {
  const days = ui.review || [];
  if (days.some((day) => !day.date)) {
    toast("Bitte zuerst für jeden Tag das Datum eintragen.");
    return;
  }

  let saved = 0;
  const uebersprungen = [];
  for (const day of days) {
    const items = day.items.filter((item) => item.title && item.time);
    if (!items.length) continue;
    const ergebnis = store.putDay(day.date, items, { mode: day.mode, source: day.sources.join(", ") });
    // Ein bereits vergangener Tag wird nicht angetastet -- siehe store.putDay.
    if (ergebnis && ergebnis.uebersprungen) { uebersprungen.push(day.date); continue; }
    saved += items.length;
  }
  store.flush();

  ui.review = null;
  ui.reviewWarnings = [];
  $("#review-dialog").close();
  render();
  if (uebersprungen.length) {
    const tage = uebersprungen.join(", ");
    toast(`${saved} Termine gespeichert. ${tage} liegt in der Vergangenheit und wurde nicht überschrieben.`, 6500);
  } else {
    toast(saved ? `${saved} Termine an ${days.length} Tag(en) gespeichert.` : "Es wurde nichts gespeichert.");
  }
}

/* --------------------------------------------------- Termin bearbeiten */

function openItem(date, id) {
  const dialog = $("#item-dialog");
  const form = $("#item-form");
  const day = store.getDay(date);
  const item = day?.items.find((entry) => entry.id === id);

  $("#item-category").innerHTML = CATEGORIES
    .map((category) => `<option value="${category.id}">${escapeHTML(category.label)}</option>`).join("");

  form.dataset.date = date;
  form.dataset.id = item?.id || "";
  $("#item-dialog-title").textContent = item ? "Termin bearbeiten" : "Neuer Termin";
  $("#item-delete").hidden = !item;

  form.date.value = date;
  form.time.value = item?.time || "09:00";
  form.duration.value = item?.duration || 30;
  form.title.value = item?.title || "";
  form.location.value = item?.location || "";
  form.practitioner.value = item?.practitioner || "";
  form.category.value = item?.category || "sonstiges";
  form.note.value = item?.note || "";

  dialog.showModal();
}

function submitItem(event) {
  event.preventDefault();
  const form = $("#item-form");
  const previousDate = form.dataset.date;
  const id = form.dataset.id;
  const date = form.date.value;
  if (!date || !form.title.value.trim()) return;

  const payload = {
    id: id || undefined,
    time: form.time.value,
    duration: Number(form.duration.value) || 30,
    title: form.title.value.trim(),
    location: form.location.value.trim(),
    practitioner: form.practitioner.value.trim(),
    category: form.category.value || categorize(form.title.value),
    note: form.note.value.trim(),
  };

  if (id && previousDate !== date) store.removeItem(previousDate, id);
  store.upsertItem(date, payload);
  store.flush();
  $("#item-dialog").close();
  render();
  toast("Termin gespeichert.");
}

/* ------------------------------------------------------------- Menü */

function openMenu() {
  const state = store.getState();
  $("#privacy-text").innerHTML = PRIVACY_TEXT;
  $("#profile-name").value = state.profile.name || "";
  $("#reminder").value = String(state.settings.reminder ?? 15);
  const days = store.allDays();
  const items = days.reduce((sum, day) => sum + day.items.length, 0);
  const bytes = new Blob([store.exportBackup()]).size;
  $("#storage-note").textContent =
    `${items} Termine an ${days.length} Tagen · ${(bytes / 1024).toFixed(1)} kB auf diesem Gerät gespeichert.`;
  $("#menu-dialog").showModal();
}

function exportCalendar() {
  const days = store.allDays().filter((day) => day.date >= store.todayISO());
  if (!days.length) { toast("Es stehen keine kommenden Termine an."); return; }
  download("behandlungsplan.ics", makeICS(days, { reminder: Number($("#reminder").value) }));
  toast("Kalenderdatei erstellt.");
}

function exportBackup() {
  speichern(`terminplan-sicherung-${store.todayISO()}.json`, store.exportBackup(), "application/json;charset=utf-8")
    .then((weg) => {
      if (weg === "abgebrochen") return;
      toast(weg === "geteilt" ? "Sicherung geteilt." : "Sicherung gespeichert (im Ordner „Downloads“).", 4500);
    });
}

/** Rohergebnis der letzten Erkennung -- siehe handleFiles. */
let letzteDiagnose = null;

/**
 * Speichert das Rohergebnis der letzten Erkennung als Datei.
 *
 * Gedacht fuer den Fall, dass eine Erkennung beim Nutzer scheitert: die Datei
 * zeigt, was die Texterkennung auf seinem Geraet gelesen hat. Damit laesst
 * sich die Ursache bestimmen, statt sie zu vermuten.
 */
function exportDiagnose() {
  if (!letzteDiagnose) {
    toast("Noch keine Erkennung gelaufen. Bitte zuerst einen Plan scannen.", 4200);
    return;
  }
  speichern(`diagnose-${store.todayISO()}.json`, JSON.stringify(letzteDiagnose, null, 1), "application/json;charset=utf-8")
    .then((weg) => {
      if (weg === "abgebrochen") return;
      toast(weg === "geteilt"
        ? "Diagnose geteilt. Die Datei enthält den erkannten Text, kein Foto."
        : "Diagnose gespeichert (im Ordner „Downloads“). Sie enthält den erkannten Text, kein Foto.", 6000);
    });
}

async function importBackup(file) {
  try {
    const text = await file.text();
    const merge = confirm("Bestehende Termine behalten und die Sicherung nur ergänzen?\n\nOK = ergänzen · Abbrechen = alles durch die Sicherung ersetzen");
    const ergebnis = store.importBackup(text, { mode: merge ? "merge" : "replace" });
    store.flush();
    render();
    toast(ergebnis.verworfen
      ? `${ergebnis.tage} Tage eingelesen, ${ergebnis.verworfen} unlesbare übersprungen.`
      : `Sicherung eingelesen: ${ergebnis.tage} Tage.`, 4200);
  } catch (error) {
    toast(`Die Datei konnte nicht gelesen werden: ${error.message}`);
  }
}

/**
 * Logo einsetzen, wenn eines danebenliegt.
 *
 * Statt den Anwender ins HTML greifen zu lassen, sucht die App selbst nach
 * einer Logodatei. Gesucht wird hoechstens einmal je Sitzung und nur nach
 * zwei Namen -- jeder Fehlversuch ist eine vergebliche Anfrage an den Server
 * und eine Fehlermeldung in der Browserkonsole. Findet sich nichts, bleibt
 * das Kalendersymbol stehen; ein leerer Platz waere schlechter.
 */
const LOGO_DATEIEN = ["./logo.png", "./logo.svg"];
const LOGO_MERKER = "federsee.logo";

/**
 * Das zweite Produktzeichen im Menü. Es ist ein Zusatz, keine Bedingung:
 * fehlt die Datei, bleibt die Zeile als reiner Text stehen. So laesst sich
 * das Logo spaeter nachreichen, ohne dass vorher etwas kaputt aussieht.
 *
 * Wie beim Kopf-Logo wird das Ergebnis fuer die Sitzung gemerkt. Sonst
 * kostete jedes Oeffnen des Menues eine vergebliche Anfrage an den Server
 * und eine Fehlermeldung in der Browserkonsole.
 */
const TAM2_DATEI = "./logo-tam2.png";
const TAM2_MERKER = "federsee.logo.tam2";

function ladeProduktLogos(kopflogo) {
  // Das FUGO-Zeichen ist dieselbe Datei wie im Kopf -- ohne zweite Anfrage.
  const fugo = $("#produkt-logo-fugo");
  if (fugo && kopflogo) { fugo.src = kopflogo; fugo.hidden = false; }

  const tam2 = $("#produkt-logo-tam2");
  if (!tam2) return;

  let gemerkt = null;
  try { gemerkt = sessionStorage.getItem(TAM2_MERKER); } catch {}
  if (gemerkt === "keins") return;
  if (gemerkt) { tam2.src = gemerkt; tam2.hidden = false; return; }

  const merke = (wert) => { try { sessionStorage.setItem(TAM2_MERKER, wert); } catch {} };
  const pruefung = new Image();
  pruefung.onload = () => { tam2.src = TAM2_DATEI; tam2.hidden = false; merke(TAM2_DATEI); };
  pruefung.onerror = () => merke("keins");
  pruefung.src = TAM2_DATEI;
}

function zeigeLogo(pfad) {
  $("#brand-logo").src = pfad;
  $("#brand-logo").hidden = false;
  $("#brand-fallback").hidden = true;
}

/** Bild als Datei vorhanden? Ein Treffer wird nicht erneut angefragt. */

function ladeLogo() {
  let gemerkt = null;
  try {
    gemerkt = sessionStorage.getItem(LOGO_MERKER);
  } catch {
    // Speicher nicht verfügbar -- dann wird eben jedes Mal gesucht.
  }
  if (gemerkt === "keins") { ladeProduktLogos(null); return; }
  if (gemerkt) { zeigeLogo(gemerkt); ladeProduktLogos(gemerkt); return; }

  const merke = (wert) => { try { sessionStorage.setItem(LOGO_MERKER, wert); } catch {} };

  const versuche = (index) => {
    if (index >= LOGO_DATEIEN.length) { merke("keins"); ladeProduktLogos(null); return; }
    const pruefung = new Image();
    pruefung.onload = () => { zeigeLogo(LOGO_DATEIEN[index]); merke(LOGO_DATEIEN[index]); ladeProduktLogos(LOGO_DATEIEN[index]); };
    pruefung.onerror = () => versuche(index + 1);
    pruefung.src = LOGO_DATEIEN[index];
  };
  versuche(0);
}

/* ------------------------------------------------------------ Erster Start */

/**
 * Beim ersten Öffnen werden der Anzeigename erfragt und der Datenschutzhinweis
 * gezeigt. Beides steht danach im Menü unter „Einstellungen & Daten“.
 */
function maybeWelcome() {
  const profile = store.getState().profile;
  if (profile.privacyAcceptedAt) return;

  $("#welcome-privacy").innerHTML = PRIVACY_TEXT;
  const dialog = $("#welcome-dialog");
  const input = $("#welcome-name");

  const finish = () => {
    store.setProfile({ name: input.value.trim(), privacyAcceptedAt: Date.now() });
    store.flush();
    dialog.close();
    renderGreeting();
  };

  $("#welcome-start").addEventListener("click", finish);
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") finish(); });
  dialog.showModal();
  setTimeout(() => input.focus(), 120);
}

/* ------------------------------------------------------------ Ereignisse */

function bind() {
  $("#file-input").addEventListener("change", (event) => handleFiles([...event.target.files]));
  $$("[data-open-scan]").forEach((button) => button.addEventListener("click", startScan));
  $("#add-item").addEventListener("click", () => openItem(ui.selectedDay === "alle" ? store.todayISO() : ui.selectedDay, null));
  $("#menu-button").addEventListener("click", openMenu);
  $("#calendar-button").addEventListener("click", () => openCalendar());

  $("#day-strip").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-day]");
    if (!tab) return;
    ui.selectedDay = tab.dataset.day;
    renderDayStrip();
    renderPlan();
  });

  $("#category-filter").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-category]");
    if (!chip) return;
    ui.category = ui.category === chip.dataset.category ? "alle" : chip.dataset.category;
    renderFilter();
    renderPlan();
  });

  let searchTimer = null;
  $("#search").addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    const value = event.target.value.trim().toLocaleLowerCase("de-DE");
    searchTimer = setTimeout(() => { ui.search = value; renderPlan(); }, 150);
  });

  $("#plan-list").addEventListener("click", (event) => {
    const rescan = event.target.closest("[data-rescan]");
    if (rescan) { startScan(); return; }
    const card = event.target.closest("[data-edit]");
    if (card) openItem(card.dataset.date, card.dataset.edit);
  });

  $("#calendar-day").addEventListener("click", (event) => {
    const card = event.target.closest("[data-edit]");
    if (card) { $("#calendar-dialog").close(); openItem(card.dataset.date, card.dataset.edit); }
  });

  $("#month-grid").addEventListener("click", (event) => {
    const cell = event.target.closest("[data-cal-day]");
    if (!cell) return;
    ui.calendarSelected = cell.dataset.calDay;
    renderCalendar();
  });
  $("#month-prev").addEventListener("click", () => { ui.calendarMonth = shiftMonth(ui.calendarMonth, -1); renderCalendar(); });
  $("#month-next").addEventListener("click", () => { ui.calendarMonth = shiftMonth(ui.calendarMonth, 1); renderCalendar(); });

  // Prüfansicht: Eingaben laufen direkt in das Zwischenergebnis.
  $("#review-body").addEventListener("input", (event) => {
    const target = event.target;
    const pageDate = target.dataset.pageDate;
    if (pageDate !== undefined) {
      const day = ui.review[Number(pageDate)];
      day.date = target.value;
      day.existingCount = store.getDay(day.date)?.items.length || 0;
      renderReview();
      return;
    }
    const row = target.closest("[data-row]");
    if (!row || !target.dataset.field) return;
    const [dayIndex, itemIndex] = row.dataset.row.split(":").map(Number);
    const item = ui.review[dayIndex].items[itemIndex];
    item[target.dataset.field] = target.value;
    if (target.dataset.field === "title") item.category = categorize(target.value);
  });

  $("#review-body").addEventListener("change", (event) => {
    const mode = event.target.dataset.mode;
    if (mode !== undefined) ui.review[Number(mode)].mode = event.target.value;
  });

  $("#review-body").addEventListener("click", (event) => {
    const drop = event.target.closest("[data-drop]");
    if (drop) {
      const [dayIndex, itemIndex] = drop.dataset.drop.split(":").map(Number);
      ui.review[dayIndex].items.splice(itemIndex, 1);
      renderReview();
      return;
    }
    const add = event.target.closest("[data-add-row]");
    if (add) {
      const day = ui.review[Number(add.dataset.addRow)];
      day.items.push({ id: crypto.randomUUID(), time: "", title: "", location: "", practitioner: "", note: "", category: "sonstiges", corrections: [] });
      renderReview();
    }
  });

  $("#review-save").addEventListener("click", saveReview);
  $("#review-cancel").addEventListener("click", () => { ui.review = null; ui.reviewWarnings = []; $("#review-dialog").close(); });

  $("#item-form").addEventListener("submit", submitItem);
  $("#item-delete").addEventListener("click", () => {
    const form = $("#item-form");
    if (!form.dataset.id || !confirm("Diesen Termin löschen?")) return;
    store.removeItem(form.dataset.date, form.dataset.id);
    store.flush();
    $("#item-dialog").close();
    render();
    toast("Termin gelöscht.");
  });

  $("#profile-name").addEventListener("change", (event) => {
    store.setProfile({ name: event.target.value.trim() });
    renderGreeting();
  });
  $("#reminder").addEventListener("change", (event) => store.setSetting("reminder", Number(event.target.value)));
  $("#export-ics").addEventListener("click", exportCalendar);
  $("#export-backup").addEventListener("click", exportBackup);
  $("#import-backup").addEventListener("click", () => $("#backup-input").click());
  $("#export-diagnose").addEventListener("click", exportDiagnose);
  $("#backup-input").addEventListener("change", (event) => event.target.files[0] && importBackup(event.target.files[0]));
  $("#clear-all").addEventListener("click", () => {
    if (!confirm("Wirklich alle Termine von diesem Gerät löschen?")) return;
    store.clearAll();
    store.flush();
    render();
    $("#menu-dialog").close();
    toast("Alle Daten wurden gelöscht.");
    maybeWelcome();
  });

  $$("[data-close]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));

  // Kopfbereich beim Scrollen verkleinern. Der Umschaltpunkt hat einen
  // Abstand nach oben und unten, damit die Leiste bei einer Bewegung um
  // wenige Pixel nicht hin- und herspringt.
  const topbar = document.querySelector(".topbar");
  let kompakt = false;
  const pruefeScroll = () => {
    const y = window.scrollY;
    if (!kompakt && y > 56) { kompakt = true; topbar.classList.add("is-kompakt"); }
    else if (kompakt && y < 24) { kompakt = false; topbar.classList.remove("is-kompakt"); }
  };
  window.addEventListener("scroll", pruefeScroll, { passive: true });
  pruefeScroll();

  // Dateien lassen sich auch am Rechner auf das Fenster ziehen.
  document.addEventListener("dragover", (event) => event.preventDefault());
  document.addEventListener("drop", (event) => {
    event.preventDefault();
    const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith("image/") || file.type === "application/pdf");
    if (files.length) handleFiles(files);
  });

  // Nichts darf beim Schließen der Seite verloren gehen.
  window.addEventListener("pagehide", store.flush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") store.flush(); });
}

function shiftMonth(value, delta) {
  const [year, month] = value.split("-").map(Number);
  const date = new Date(year, month - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ Start */

/** Traegt den Namen der Einrichtung dort ein, wo er im Text erscheint. */
function setzeBezeichnungen() {
  // Sichtbare Fassung: beantwortet die Frage "liegt das Update ueberhaupt
  // auf dem Server?" ohne Raten.
  const fassung = $("#fassung-note");
  if (fassung) fassung.textContent = `Fassung ${FASSUNG}`;
  document.title = ANWENDUNG.name;
  $("#brand-sub").textContent = ANWENDUNG.untertitel;
  $$("[data-anwendung]").forEach((element) => { element.textContent = ANWENDUNG.name; });
  const logo = $("#brand-logo");
  if (logo) logo.alt = ANWENDUNG.anbieter.name;
}

store.load();
bind();
setzeBezeichnungen();
render();
ladeLogo();
maybeWelcome();

/**
 * Der Plan muss von selbst aktuell bleiben -- Patienten verlassen sich darauf.
 * Aktualisiert wird jeweils zur vollen Minute, damit der nächste Termin genau
 * dann umspringt, wenn die Uhr weiterspringt, und nicht bis zu 59 Sekunden
 * später. Zusätzlich beim Zurückkehren zur Seite: auf dem Telefon stehen
 * Zeitgeber im Hintergrund still.
 */
let letzterTag = store.todayISO();

function aktualisiereAnsicht() {
  const heute = store.todayISO();
  if (heute !== letzterTag) {
    letzterTag = heute;
    ui.selectedDay = "alle";
  }
  render();
}

function planeNaechsteMinute() {
  const jetzt = new Date();
  const bisZurVollenMinute = 60000 - (jetzt.getSeconds() * 1000 + jetzt.getMilliseconds());
  setTimeout(() => {
    aktualisiereAnsicht();
    planeNaechsteMinute();
  }, bisZurVollenMinute + 40);
}

planeNaechsteMinute();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") aktualisiereAnsicht();
});
window.addEventListener("focus", aktualisiereAnsicht);

store.subscribe((_, detail) => {
  if (detail?.type === "storage-error") {
    toast("Der Speicher des Browsers ist voll. Bitte alte Tage über den Kalender löschen.", 6000);
  }
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js").catch(() => {}));
}
