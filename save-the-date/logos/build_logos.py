"""Baut aus den vektorisierten Logos die 'epischen' Varianten fürs Plakat.

steelers-epic.svg: Schriftzug in Chrom mit Neon-Glow, Flammen als grüne Leuchtspur, Sterne in Gold.
landshut-epic.svg: Wappen-Badge kreisrund freigestellt, mit Glanz-Sweep und Goldrand-Glühen.
Aufruf: python3 save-the-date/logos/build_logos.py
"""
import re
from pathlib import Path

HERE = Path(__file__).parent


def paths(svg_file):
    return re.findall(r'<path d="([^"]+)" fill="[^"]+" transform="translate\(([^,]+),([^)]+)\)"/>',
                      (HERE / svg_file).read_text())


def path_tags(items):
    return "\n".join(f'<path d="{d}" transform="translate({x},{y})"/>' for d, x, y in items)


schrift = paths("steelers-trace-schrift.svg")
grau = paths("steelers-trace-sterne-flammen.svg")
sterne = [p for p in grau if float(p[2]) < 300]
flammen = [p for p in grau if float(p[2]) >= 300]

steelers = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="-140 -140 2176 1492">
<defs>
  <linearGradient id="chrom" gradientUnits="userSpaceOnUse" x1="0" y1="180" x2="0" y2="1000">
    <stop offset="0" stop-color="#ffffff"/><stop offset=".34" stop-color="#eefff6"/>
    <stop offset=".47" stop-color="#9fb8ab"/><stop offset=".5" stop-color="#3f5249"/>
    <stop offset=".55" stop-color="#d9f7e6"/><stop offset=".75" stop-color="#ffffff"/>
    <stop offset="1" stop-color="#a9cbb8"/>
  </linearGradient>
  <linearGradient id="flamme" gradientUnits="userSpaceOnUse" x1="1850" y1="0" x2="0" y2="0">
    <stop offset="0" stop-color="#ffffff"/><stop offset=".3" stop-color="#d4ffe6"/>
    <stop offset=".6" stop-color="#5dffa6"/><stop offset="1" stop-color="#1fe57a"/>
  </linearGradient>
  <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff7d1"/><stop offset=".45" stop-color="#ffd34d"/>
    <stop offset=".55" stop-color="#c58a00"/><stop offset="1" stop-color="#ffe58a"/>
  </linearGradient>
  <filter id="g40" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="40"/></filter>
  <filter id="g16" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="16"/></filter>
</defs>
<!-- Flammen: Leuchtspur -->
<g fill="#2bff88" filter="url(#g16)" opacity=".7">{path_tags(flammen)}</g>
<g fill="url(#flamme)">{path_tags(flammen)}</g>
<!-- Sterne: Gold -->
<g fill="#ffd34d" filter="url(#g40)" opacity=".9">{path_tags(sterne)}</g>
<g fill="url(#gold)" stroke="#fff6cc" stroke-width="6">{path_tags(sterne)}</g>
<!-- Schriftzug: Glow, dunkle Kontur, Chrom -->
<g fill="#2bff88" filter="url(#g40)">{path_tags(schrift)}</g>
<g fill="#003a1b" stroke="#003a1b" stroke-width="44" stroke-linejoin="round">{path_tags(schrift)}</g>
<g fill="none" stroke="#2bff88" stroke-width="16" stroke-linejoin="round" filter="url(#g16)">{path_tags(schrift)}</g>
<g fill="none" stroke="#2bff88" stroke-width="10" stroke-linejoin="round">{path_tags(schrift)}</g>
<g fill="url(#chrom)">{path_tags(schrift)}</g>
</svg>
'''
(HERE / "steelers-epic.svg").write_text(steelers)

trace = (HERE / "landshut-trace.svg").read_text()
inner = trace[trace.index("<path"):trace.rindex("</svg>")]
landshut = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1422 1422">
<defs>
  <clipPath id="kreis"><circle cx="711" cy="711" r="706"/></clipPath>
  <linearGradient id="sweep" x1="0" y1="0" x2="1" y2="1">
    <stop offset=".28" stop-color="#fff" stop-opacity="0"/><stop offset=".36" stop-color="#fff" stop-opacity=".55"/>
    <stop offset=".40" stop-color="#fff" stop-opacity=".1"/><stop offset=".44" stop-color="#fff" stop-opacity=".35"/>
    <stop offset=".5" stop-color="#fff" stop-opacity="0"/>
  </linearGradient>
  <radialGradient id="tiefe" cx=".5" cy=".42" r=".6">
    <stop offset=".75" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".45"/>
  </radialGradient>
</defs>
<g clip-path="url(#kreis)">
{inner}
<rect width="1422" height="1422" fill="url(#tiefe)"/>
<rect width="1422" height="1422" fill="url(#sweep)"/>
</g>
<circle cx="711" cy="711" r="700" fill="none" stroke="#fff3b0" stroke-width="10" stroke-opacity=".8"/>
</svg>
'''
(HERE / "landshut-epic.svg").write_text(landshut)
print("ok", len(schrift), len(sterne), len(flammen))
