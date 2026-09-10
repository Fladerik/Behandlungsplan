# Federsee Terminplan

Designed by **FUGO Labs** — [cameraorganizer.com](https://www.cameraorganizer.com)

Die Anwendung übernimmt das Blau von FUGO als Hauptfarbe; das Orange von
TaM² bleibt dem Verweis auf diese zweite Anwendung vorbehalten.

Webapp, mit der Patientinnen und Patienten ihren Behandlungsplan fotografieren
oder als PDF hochladen. Die Termine werden erkannt, einmal geprüft und liegen
danach dauerhaft auf dem eigenen Gerät – ohne Anmeldung, ohne Server, ohne
Datenübertragung.

## Hochladen auf Strato

Die App ist für eine öffentliche Adresse gedacht, die alle Patientinnen und
Patienten aufrufen – etwa per QR-Code:

```
https://www.cameraorganizer.com/federsee/
```

Den kompletten Ordnerinhalt per FTP in dieses Verzeichnis kopieren. Es ist
keine Datenbank, kein PHP und kein Benutzerkonto nötig. Alle Pfade im Code sind
relativ, das Unterverzeichnis funktioniert daher ohne Anpassung.

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

### Wie die App für die Patienten funktioniert

Jede Person ruft dieselbe Adresse auf und arbeitet vollständig unabhängig:
kein Login, kein Serverkonto, keine gemeinsame Datenbank. Fotos und Termine
werden auf dem eigenen Gerät verarbeitet und dort gespeichert; sie überstehen
das Schließen des Tabs und des Browsers.

Beim ersten Start werden nur ein frei wählbarer Anzeigename erfragt und der
Datenschutzhinweis gezeigt. Danach begrüßt die App nach Tageszeit – bis 11:00
Uhr „Guten Morgen“, bis 18:00 Uhr „Hallo“, danach „Guten Abend“.

## Wie die App aufgebaut ist

| Datei | Aufgabe |
|---|---|
| `store.js` | Datenhaltung und Speicherung auf dem Gerät |
| `parser.js` | Aus erkanntem Text wird ein Tagesplan |
| `deskew.js` | Blatt im Foto finden und geradeziehen |
| `pruefen.html` | Prüft nach dem Hochladen, ob alle Dateien angekommen sind |
| `rechtliches.html` | Impressum und Datenschutzerklärung |
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

### Schiefe Aufnahmen werden geradegezogen

Ein Handyfoto zeigt das Blatt fast nie rechtwinklig. Für die Texterkennung ist
das der größte Störfaktor: Die Spalten rutschen gegeneinander, und die
Behandlerspalte landet in der Zeile darunter.

`deskew.js` sucht deshalb das Blatt im Bild – hell auf dunklerem Grund,
Schwellwert nach Otsu, größte zusammenhängende Fläche – bestimmt seine vier
Ecken und rechnet es perspektivisch auf ein Rechteck zurück.

Zwei Dinge sind dabei wichtig:

- **Im Zweifel wird nicht entzerrt.** Findet sich keine plausible Blattkontur
  (mindestens ein Viertel des Bildes, gegenüberliegende Kanten ähnlich lang,
  keine zusammenfallenden Ecken), bleibt das Bild unverändert. Ein falsch
  entzerrtes Bild wäre schlechter als ein schiefes.
- **Nur wenn es nötig ist.** Jede Umrechnung tastet das Bild neu ab und kostet
  etwas Schärfe. Bei leicht schiefen Aufnahmen schadet das mehr, als es nützt,
  weil die Zeilenzusammenführung solche Fälle ohnehin auffängt. Gemessen an
  Testaufnahmen: rund 5 Grad Kippung ergeben einen Verzerrungswert von 0,076,
  rund 11 Grad einen von 0,155. Die Schwelle liegt bei 0,12.

### Warum die Spaltenposition zählt – und wann nicht

Hat ein Plan eine Spaltenüberschrift („Zeit | Haus | Behandlungsstelle |
Heilmittel | Behandler"), ist die Position das verlässlichste Signal, das er
hergibt: Die Klinik druckt jeden Tag dieselbe Tabelle. Die Überschriften
liefern die Spaltenanker, und jede Zelle wird der Spalte zugeordnet, deren
Bereich ihre linke Kante trifft.

Fehlt die Überschrift oder ist sie unlesbar, greift die inhaltliche
Zuordnung: Ist diese Zelle ein Ort, eine Person oder eine Anwendung? Diese
Rückfallebene ist der Grund, warum ein fehlender Tabellenkopf nicht mehr –
wie in der Vorgängerversion – alle Spalten verschiebt.

Zwei weitere Eigenheiten echter Pläne sind berücksichtigt:

- **Umbrüche innerhalb einer Zelle** („Haus am" / „Gsundbrunnen") gehören zu
  ihrer eigenen Spalte, nicht an die Anwendung. Unterschieden werden sie am
  Zeilenabstand: Ein Umbruch klebt mit rund 0,3 Zeilenhöhen an der Zeile
  darüber, eine neue Tabellenzeile hat ab 0,65 deutlich mehr Abstand.
- **Hinweistexte** zwischen den Terminen („In der Zeit von 7 - 9 Uhr ist der
  Raum geöffnet") enthalten selbst Uhrzeiten. Sie werden erkannt und
  übersprungen, damit daraus keine Phantomtermine entstehen.

Zeilen ohne Uhrzeit („Eigentraining Therme") werden nicht übernommen. Die
Prüfansicht nennt ihre Anzahl, damit nichts unbemerkt verloren geht.

### Das richtige Jahr

Nennt eine Datumszeile kein Jahr, wird es aus dem Zusammenhang bestimmt. Der
Ernstfall ist ein Aufenthalt über Silvester: Wird ein Plan Ende Dezember
gescannt und nennt eine Zeile „Samstag 02. Januar", gehört dieser Tag ins
Folgejahr. Das laufende Jahr einzusetzen legt den Termin ein Jahr in die
Vergangenheit – er taucht in der Hauptansicht nie auf.

Entschieden wird in zwei Stufen: Nennt der Text einen Wochentag, ist das Jahr
damit eindeutig bestimmt, denn derselbe Kalendertag fällt in benachbarten
Jahren auf verschiedene Wochentage. Sonst gewinnt das Jahr, dessen Datum dem
Bezugstag am nächsten liegt.

### Kein geratenes Datum

Auf Klinikplänen steht im Seitenkopf das Anreise- und Druckdatum, nicht der
Tag der Termine. Das richtige Datum steht im Tabellenkörper
(„Freitag 11. September 2026"), und daran werden die Tage getrennt.

Steht im Kopfbereich überhaupt eines der Wörter Anreise, Abreise oder
gedruckt, wird von dort **kein** Datum mehr übernommen – dann bleibt das Feld
leer und die Prüfansicht fordert zur Eingabe auf. Ein leeres Datumsfeld fällt
beim Prüfen auf, ein falsches nicht.

### Der nächste Termin

Die wichtigste Information der App steht im blauen Kasten ganz oben. Maßgeblich
ist dabei das **Ende** eines Termins, nicht sein Beginn: Wer um 09:10 auf das
Telefon schaut, soll sehen, wo er gerade sein muss – nicht schon den
übernächsten Termin. Läuft ein Termin, steht dort „Läuft gerade" und die
verbleibende Zeit.

Aktualisiert wird jeweils **zur vollen Minute**, nicht in einem festen
60-Sekunden-Takt ab Seitenaufruf. Sonst springt die Anzeige bis zu 59 Sekunden
zu spät um. Zusätzlich beim Zurückkehren zur Seite, denn auf dem Telefon stehen
Zeitgeber im Hintergrund still.

### Wie falsch gelesene Namen korrigiert werden

Behandlungspläne wiederholen dieselben Anwendungen, Räume und Namen über
Wochen. Jeder bestätigte Eintrag wird gezählt und bildet ein Wörterbuch, das
nur auf diesem Gerät liegt. Beim nächsten Scan wird jede Zelle dagegen
abgeglichen: „Muler“ wird zu „Müller“, sobald „Müller“ einmal bestätigt wurde.
Für Anwendungen und Orte gibt es zusätzlich einen Grundwortschatz, damit schon
der erste Scan sitzt. Die Texterkennung verliert regelmäßig Anfangsbuchstaben –
aus „Sporthalle" wird „orthalle", aus „Haus" wird „Has". Dagegen hilft kein
besseres Modell, sondern nur der Abgleich mit dem, was auf dem Plan überhaupt
stehen kann. Mehrteilige Angaben werden zusätzlich Wort für Wort geprüft, damit
auch „Treff orthalle" wieder zu „Treff Sporthalle" wird.

Die Toleranz wächst mit der Wortlänge, bleibt aber eng genug, dass aus
„Raum 2“ nie „Raum 5“ wird – Kandidaten mit abweichenden Ziffern werden gar
nicht erst verglichen.

Bei Behandlernamen kommt eine Regel hinzu, die ohne Wörterbuch auskommt: Die
Texterkennung verliert dort regelmäßig den Anfangsbuchstaben, aus „Frau M.
Stubenrauch" wird „rau M. Stubenrauch". Die Anrede ist aus sich heraus
erkennbar und wird wieder zusammengesetzt – eng gefasst, damit aus dem
Nachnamen „Rau" nicht „Frau" wird.

Ein Wort, das im Grundwortschatz vorkommt, wird nie ersetzt. Ohne diese Regel
machte die stückweise Korrektur aus dem korrekten „Wartebereich" das längere
„KG-Wartebereich".

Pro Begriff führt das Wörterbuch nur **eine** Schreibweise. Sonst sammelt es
Verlesungsvarianten an und normalisiert später womöglich auf die falsche
davon. Unterscheiden sich zwei Fassungen nur in Zeichen, die im Deutschen
nicht vorkommen („Bewegı.ther.Sch.“ gegen „Beweg.ther.Sch.“), setzt sich die
sauberere durch.

Jede Korrektur wird in der Prüfansicht angezeigt, ebenso jede Zeile, die die
Texterkennung selbst als unsicher meldet.

**Gespeichert wird nie ohne Prüfung.** Das Erkennungsergebnis landet zuerst in
einer bearbeitbaren Liste. Erst „Speichern“ schreibt es in den Plan.

## Farben und Logo anpassen

Alle Blautöne der App leiten sich aus fünf Werten am Anfang von `styles.css`
ab (`--marke-900` bis `--marke-100`). Um den Markenton zu ändern, genügt es,
diese zu ersetzen — an keiner anderen Stelle steht eine Blauangabe fest im
Code. Das Orange für TaM² steht darunter als `--tam-orange`.

**Das Logo braucht keinen Eingriff in den Code.** Legen Sie eine Datei
`logo.png` (oder `logo.svg`) neben `index.html` — die App findet sie beim
Start und setzt sie ein. Liegt keine da, bleibt das neutrale
Kalendersymbol stehen. Am besten eignet sich ein quadratisches Bild.

Um aus der Doppelvorlage mit beiden App-Symbolen zwei einzelne Dateien zu
machen:

```bash
python3 werkzeuge/logos-trennen.py vorlage.png
# ergibt logo-fugo.png und logo-tam2.png
```

Das Werkzeug sucht die Kacheln anhand ihrer leuchtenden Ränder, schneidet sie
frei und füllt sie quadratisch auf. Es funktioniert unabhängig von der Größe
der Vorlage.

## Impressum

`rechtliches.html` enthält Impressum und Datenschutzerklärung, verlinkt aus der
Fußzeile und aus dem Menü. Die Angaben nach § 5 DDG sind eingetragen.

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
