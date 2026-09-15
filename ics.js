/** Kalenderexport (.ics) -- für Patienten, die den Plan zusätzlich im eigenen Kalender wollen. */

const escapeICS = (value = "") => String(value)
  .replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");

/** Zeilen über 75 Oktetts müssen nach RFC 5545 umgebrochen werden. */
function fold(line) {
  if (line.length <= 73) return line;
  const parts = [line.slice(0, 73)];
  let rest = line.slice(73);
  while (rest.length > 72) { parts.push(` ${rest.slice(0, 72)}`); rest = rest.slice(72); }
  if (rest) parts.push(` ${rest}`);
  return parts.join("\r\n");
}

const stampFor = (isoDate, time) => `${isoDate.replaceAll("-", "")}T${time.replace(":", "")}00`;

function endStamp(isoDate, time, duration) {
  const start = new Date(`${isoDate}T${time}:00`);
  const end = new Date(start.getTime() + Number(duration || 30) * 60000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${end.getFullYear()}${pad(end.getMonth() + 1)}${pad(end.getDate())}T${pad(end.getHours())}${pad(end.getMinutes())}00`;
}

export function makeICS(days, { reminder = 15, calendarName = "Behandlungsplan" } = {}) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const rows = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "PRODID:-//Behandlungsplan//DE", `X-WR-CALNAME:${escapeICS(calendarName)}`,
  ];

  for (const day of days) {
    for (const item of day.items) {
      if (!item.time || !item.title) continue;
      rows.push("BEGIN:VEVENT");
      rows.push(`UID:${item.id}@behandlungsplan.local`);
      rows.push(`DTSTAMP:${stamp}`);
      rows.push(`DTSTART:${stampFor(day.date, item.time)}`);
      rows.push(`DTEND:${endStamp(day.date, item.time, item.duration)}`);
      rows.push(`SUMMARY:${escapeICS(item.title)}`);
      if (item.location) rows.push(`LOCATION:${escapeICS(item.location)}`);
      const description = [
        item.practitioner && `Durchführung: ${item.practitioner}`,
        item.note && item.note,
      ].filter(Boolean).join("\n");
      if (description) rows.push(`DESCRIPTION:${escapeICS(description)}`);
      if (reminder > 0) rows.push("BEGIN:VALARM", `TRIGGER:-PT${reminder}M`, "ACTION:DISPLAY", `DESCRIPTION:${escapeICS(item.title)}`, "END:VALARM");
      rows.push("END:VEVENT");
    }
  }

  rows.push("END:VCALENDAR");
  return `${rows.map(fold).join("\r\n")}\r\n`;
}

/**
 * Datei sichern -- auf dem Telefon ueber das Teilen-Menue.
 *
 * Ein gewoehnlicher Download landet auf dem iPhone in "Dateien -> Downloads".
 * Von dort muss der Nutzer sie erst wieder heraussuchen, um sie zu
 * verschicken. Das Teilen-Menue ueberspringt diesen Umweg: die Datei geht
 * direkt in Mail, Nachrichten oder wohin sonst.
 *
 * Kann das Geraet das nicht -- am Rechner ist das die Regel --, wird ganz
 * normal heruntergeladen. Bricht der Nutzer das Teilen ab, geschieht
 * ebenfalls nichts weiter; ein Abbruch ist kein Fehler.
 */
export async function speichern(filename, content, type = "application/json") {
  const datei = new File([content], filename, { type });
  if (navigator.canShare?.({ files: [datei] })) {
    try {
      await navigator.share({ files: [datei], title: filename });
      return "geteilt";
    } catch (fehler) {
      if (fehler?.name === "AbortError") return "abgebrochen";
      // Teilen ging schief -- dann eben herunterladen.
    }
  }
  download(filename, content, type);
  return "geladen";
}

export function download(filename, content, type = "text/calendar;charset=utf-8") {
  const blob = new Blob([content], { type });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}
