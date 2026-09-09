# Federsee Terminplan

Webapp, mit der Patientinnen und Patienten ihren Behandlungsplan fotografieren
oder als PDF hochladen. Die Termine werden erkannt, einmal geprüft und liegen
danach dauerhaft auf dem eigenen Gerät – ohne Anmeldung, ohne Server, ohne
Datenübertragung.

## Hochladen auf Strato

Den kompletten Ordnerinhalt per FTP in das Webverzeichnis kopieren
(z. B. `/terminplan/`). Es ist keine Datenbank und kein PHP nötig.

```
index.html  styles.css  app.js  store.js  parser.js  ocr.js  ics.js
service-worker.js  manifest.webmanifest  icon.svg  .htaccess
vendor/     (Texterkennung und PDF-Anzeige)
tessdata/   (deutsches Sprachmodell, ca. 7 MB)
```

Zwei Voraussetzungen:

1. **HTTPS muss aktiv sein.** Ohne HTTPS erlauben Browser weder Kamera noch
   Offline-Betrieb. Bei Strato im Kundenbereich unter „SSL-Verwaltung“.
2. **`.htaccess` muss mit übertragen werden.** Viele FTP-Programme blenden
   Dateien mit führendem Punkt aus; im FTP-Programm „versteckte Dateien
   anzeigen“ einschalten.

Nach einer Aktualisierung genügt es, die geänderten Dateien zu überschreiben.
Der Service Worker holt den Programmcode zuerst aus dem Netz, neue Versionen
kommen also ohne Zutun der Nutzer an.

## Wie die App aufgebaut ist

| Datei | Aufgabe |
|---|---|
| `store.js` | Datenhaltung und Speicherung auf dem Gerät |
| `parser.js` | Aus erkanntem Text wird ein Tagesplan |
| `ocr.js` | Fotos und PDF-Dateien werden zu Text |
| `ics.js` | Kalenderdatei für Apple, Google und Outlook |
| `app.js` | Oberfläche und Ablauf |

### Der Tag ist die Einheit, nicht der einzelne Termin

Ein Scan ergibt immer genau einen Tagesplan. Wird derselbe Tag erneut
eingelesen, ersetzt der neue Plan den alten vollständig – nach Rückfrage, mit
„ersetzen“ als Voreinstellung, weil der neuere Plan der gültige ist.

Das ist bewusst so gewählt: Ein Abgleich einzelner Termine müsste raten, ob
eine gelesene Zeile ein neuer Termin oder eine veränderte Fassung eines
bestehenden ist. Genau daran scheitern solche Apps – entweder entstehen
Dubletten, oder neue Termine werden als vermeintliche Dubletten verworfen.
Auf Tagesebene stellt sich die Frage nicht.

### Warum die Erkennung zeilenweise arbeitet

Ein früherer Ansatz hat feste Spaltengrenzen aus den Tabellenüberschriften
abgeleitet. Fehlte eine Überschrift oder war sie verlesen, verschoben sich alle
Spalten: Behandlernamen landeten in der Ortsspalte, Anwendungen blieben leer.

Stattdessen:

1. Wörter werden zu Zeilen gruppiert – die stabilste Information, die eine
   Texterkennung liefert.
2. Innerhalb der Zeile trennen die tatsächlichen Wortabstände die Zellen.
   Der Schwellwert leitet sich aus der Schrifthöhe ab und funktioniert damit
   unabhängig von Auflösung und Zoomstufe.
3. Jede Zelle wird inhaltlich eingeordnet – ist das ein Ort, eine Person, eine
   Anwendung? – und nicht über ihre Position.
4. Zeilen ohne Uhrzeit, die direkt unter einem Termin stehen, gelten als dessen
   Fortsetzung („Krankengymnastik im“ + „Bewegungsbad“).

### Wie falsch gelesene Namen korrigiert werden

Behandlungspläne wiederholen dieselben Anwendungen, Räume und Namen über
Wochen. Jeder bestätigte Eintrag wird gezählt und bildet ein Wörterbuch, das
nur auf diesem Gerät liegt. Beim nächsten Scan wird jede Zelle dagegen
abgeglichen: „Muler“ wird zu „Müller“, sobald „Müller“ einmal bestätigt wurde.
Für Anwendungen gibt es zusätzlich eine Grundliste gängiger Reha-Leistungen.

Die Toleranz wächst mit der Wortlänge, bleibt aber eng genug, dass aus
„Bad 2“ nie „Bad 3“ wird. Jede Korrektur wird in der Prüfansicht angezeigt,
ebenso jede Zeile, die die Texterkennung selbst als unsicher meldet.

**Gespeichert wird nie ohne Prüfung.** Das Erkennungsergebnis landet zuerst in
einer bearbeitbaren Liste. Erst „Speichern“ schreibt es in den Plan.

## Datenschutz

Bilder, PDF-Dateien und Termine verlassen das Gerät nicht. Die Texterkennung
läuft vollständig im Browser; die Sprachdatei wird vom eigenen Server geladen.
Die Inhaltssicherheitsrichtlinie in der `.htaccess` unterbindet jede Verbindung
nach außen.

Weil die Daten nur lokal liegen, gilt: Wer den Browserspeicher löscht oder das
Gerät wechselt, verliert den Plan. Dafür gibt es im Menü unter „Gerätewechsel &
Sicherung“ eine Sicherungsdatei zum Speichern und Wiedereinlesen.

## Prüfen vor dem Hochladen

Ein einfacher Webserver genügt; Module und Service Worker funktionieren nicht
über `file://`:

```bash
python3 -m http.server 8099
# danach http://127.0.0.1:8099 aufrufen
```

## Fremdbestandteile

- [Tesseract.js](https://github.com/naptha/tesseract.js) – Texterkennung (Apache 2.0)
- [pdf.js](https://github.com/mozilla/pdf.js) – PDF-Verarbeitung (Apache 2.0, Lizenz in `vendor/pdf.js-LICENSE.txt`)
