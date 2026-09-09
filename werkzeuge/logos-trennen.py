#!/usr/bin/env python3
"""
Trennt das Doppelbild der beiden App-Symbole in zwei einzelne PNG-Dateien.

Die Vorlage zeigt TaM² (links, orange) und FUGO (rechts, blau) nebeneinander
auf schwarzem Grund. Gesucht werden nicht feste Bildpunkte, sondern die
tatsaechlichen Kacheln: Der Hintergrund ist nahezu schwarz, die Kacheln haben
leuchtende Raender. Damit funktioniert der Zuschnitt auch, wenn die Vorlage in
einer anderen Groesse vorliegt.

Aufruf:  python3 werkzeuge/logos-trennen.py vorlage.png [zielordner]
Ergebnis: logo-fugo.png und logo-tam2.png
"""

import sys
from pathlib import Path

from PIL import Image


# Ab diesem Helligkeitswert gilt eine Bildspalte als Teil einer Kachel.
# Gemessen wird der HELLSTE Punkt der Spalte, nicht der Durchschnitt: Die
# Kacheln sind selbst fast schwarz, nur ihre Raender und die Schrift leuchten.
# Ein Durchschnitt bliebe deshalb unter jeder brauchbaren Schwelle.
SCHWELLE = 60

# Rand, der um die gefundene Kachel stehen bleibt, damit der Leuchtrand nicht
# angeschnitten wird -- als Anteil der Kachelbreite.
LUFT = 0.02


def spalten_helligkeit(bild):
    """Hellster Punkt je Bildspalte."""
    grau = bild.convert("L")
    breite, hoehe = grau.size
    werte = grau.load()
    return [max(werte[x, y] for y in range(0, hoehe, 2)) for x in range(breite)]


def bereiche_finden(helligkeit, mindestbreite, luecke=12):
    """
    Zusammenhaengende helle Abschnitte -- je einer je Kachel.

    Kurze dunkle Unterbrechungen innerhalb einer Kachel (etwa zwischen
    Leuchtrand und Schriftband) trennen sie nicht: erst eine Luecke von
    mehreren Bildpunkten gilt als Zwischenraum.
    """
    hell = [wert > SCHWELLE for wert in helligkeit]
    bereiche = []
    start = None
    dunkel = 0

    for x, ist_hell in enumerate(hell):
        if ist_hell:
            if start is None:
                start = x
            dunkel = 0
        elif start is not None:
            dunkel += 1
            if dunkel > luecke:
                ende = x - dunkel
                if ende - start >= mindestbreite:
                    bereiche.append((start, ende))
                start = None
                dunkel = 0

    if start is not None and len(hell) - start >= mindestbreite:
        bereiche.append((start, len(hell)))
    return bereiche


def zeilen_zuschneiden(bild, links, rechts):
    """Oberen und unteren Rand der Kachel bestimmen."""
    ausschnitt = bild.crop((links, 0, rechts, bild.height)).convert("L")
    werte = ausschnitt.load()
    breite, hoehe = ausschnitt.size
    zeilen = [max(werte[x, y] for x in range(0, breite, 2)) for y in range(hoehe)]
    oben = next((y for y, wert in enumerate(zeilen) if wert > SCHWELLE), 0)
    unten = next((y for y in range(hoehe - 1, -1, -1) if zeilen[y] > SCHWELLE), hoehe - 1)
    return oben, unten + 1


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    quelle = Path(sys.argv[1])
    ziel = Path(sys.argv[2]) if len(sys.argv) > 2 else quelle.parent
    ziel.mkdir(parents=True, exist_ok=True)

    bild = Image.open(quelle).convert("RGB")
    bereiche = bereiche_finden(spalten_helligkeit(bild), bild.width * 0.15)

    if len(bereiche) != 2:
        print(f"Es wurden {len(bereiche)} Kacheln gefunden, erwartet waren zwei.")
        print("Die Vorlage sollte beide Symbole nebeneinander auf dunklem Grund zeigen.")
        return 1

    # Links steht TaM² (orange), rechts FUGO (blau).
    namen = ["logo-tam2.png", "logo-fugo.png"]
    for (links, rechts), name in zip(bereiche, namen):
        oben, unten = zeilen_zuschneiden(bild, links, rechts)
        luft = int((rechts - links) * LUFT)
        kachel = bild.crop((
            max(0, links - luft),
            max(0, oben - luft),
            min(bild.width, rechts + luft),
            min(bild.height, unten + luft),
        ))
        # Quadratisch auffuellen, damit das Symbol in jeder Umgebung sauber sitzt.
        kante = max(kachel.size)
        quadrat = Image.new("RGB", (kante, kante), (0, 0, 0))
        quadrat.paste(kachel, ((kante - kachel.width) // 2, (kante - kachel.height) // 2))
        quadrat.save(ziel / name)
        print(f"{name}: {quadrat.width}x{quadrat.height}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
