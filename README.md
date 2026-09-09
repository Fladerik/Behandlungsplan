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

Ein eingelesener Tagesplan ersetzt den gespeicherten Tag vollständig – nach
Rückfrage, mit „ersetzen“ als Voreinstellung, weil der neuere Plan der gültige
ist. Gestrichene Anwendungen verschwinden dabei, hinzugekommene erscheinen.

Das ist bewusst so gewählt: Ein Abgleich einzelner Termine müsste raten, ob
eine gelesene Zeile ein neuer Termin oder eine veränderte Fassung eines
bestehenden ist. Genau daran scheitern solche Apps – entweder entstehen
Dubletten, oder neue Termine werden als vermeintliche Dubletten verworfen.
Auf Tagesebene stellt sich die Frage nicht.

### Eine Seite ist nicht ein Tag

Echte Klinikpläne bündeln mehrere Tage auf einem Blatt, und ein Tag kann sich
über zwei Blätter ziehen. Die Tage werden deshalb nicht an den Seitengrenzen
getrennt, sondern an den Datumszeilen im Tabellenkörper
(„Freitag 04. September 2026“).

Das Datum im Seitenkopf wird dafür ausdrücklich **nicht** verwendet: Dort
stehen Anreise, Abreise und der Druckzeitpunkt. Wer den Kopf ausliest, trägt
alle Termine auf dem Anreisetag ein. Erst wenn im Tabellenkörper keine
Datumszeile steht, dient der Kopf als Rückfallebene – unter Ausschluss der
Zeilen zu Anreise, Abreise und Druckdatum.

Zusätzlich wird geprüft, ob der genannte Wochentag zum Datum passt. Tut er das
nicht, erscheint ein Hinweis in der Prüfansicht statt eines stillen Fehlers.

### Warum die Spaltenposition zählt – und wann nicht

Hat ein Plan eine Spaltenüberschrift („Zeit | Haus | Behandlungsstelle |
Heilmittel | Behandler“), ist die Position das verlässlichste Signal, das er
hergibt: Die Klinik druckt jeden Tag dieselbe Tabelle. Die Überschriften
liefern die Spaltenanker, und jede Zelle wird der Spalte zugeordnet, deren
Bereich ihre linke Kante trifft.

Fehlt die Überschrift oder ist sie unlesbar, greift die inhaltliche
Zuordnung: Ist diese Zelle ein Ort, eine Person oder eine Anwendung? Diese
Rückfallebene ist der Grund, warum ein fehlender Tabellenkopf nicht mehr –
wie in der Vorgängerversion – alle Spalten verschiebt.

Zwei weitere Eigenheiten echter Pläne sind berücksichtigt:

- **Umbrüche innerhalb einer Zelle** („Haus am“ / „Gsundbrunnen“) gehören zu
  ihrer eigenen Spalte, nicht an die Anwendung. Unterschieden werden sie am
  Zeilenabstand: Ein Umbruch klebt mit rund 0,3 Zeilenhöhen an der Zeile
  darüber, eine neue Tabellenzeile hat ab 0,65 deutlich mehr Abstand.
- **Hinweistexte** zwischen den Terminen („In der Zeit von 7 - 9 Uhr ist der
  Raum geöffnet“, „Öffnungszeiten der Therme: Mo - So 10 -22 Uhr“) enthalten
  selbst Uhrzeiten. Sie werden erkannt und übersprungen, damit daraus keine
  Phantomtermine entstehen.

Zeilen ohne Uhrzeit („Eigentraining Therme“) werden nicht übernommen. Die
Prüfansicht nennt ihre Anzahl, damit nichts unbemerkt verloren geht.

### Wie falsch gelesene Namen korrigiert werden

Behandlungspläne wiederholen dieselben Anwendungen, Räume und Namen über
Wochen. Jeder bestätigte Eintrag wird gezählt und bildet ein Wörterbuch, das
nur auf diesem Gerät liegt. Beim nächsten Scan wird jede Zelle dagegen
abgeglichen: „Muler“ wird zu „Müller“, sobald „Müller“ einmal bestätigt wurde.
Für Anwendungen gibt es zusätzlich eine Grundliste gängiger Reha-Leistungen.

Die Toleranz wächst mit der Wortlänge, bleibt aber eng genug, dass aus
„Raum 2“ nie „Raum 5“ wird – Kandidaten mit abweichenden Ziffern werden gar
nicht erst verglichen.

Pro Begriff führt das Wörterbuch nur **eine** Schreibweise. Sonst sammelt es
Verlesungsvarianten an und normalisiert später womöglich auf die falsche
davon. Unterscheiden sich zwei Fassungen nur in Zeichen, die im Deutschen
nicht vorkommen („Bewegı.ther.Sch.“ gegen „Beweg.ther.Sch.“), setzt sich die
sauberere durch.

Jede Korrektur wird in der Prüfansicht angezeigt, ebenso jede Zeile, die die
Texterkennung selbst als unsicher meldet.

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
