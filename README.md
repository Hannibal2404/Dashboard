# Küchen-Dashboard

Wanddisplay fürs iPad (Querformat) plus Einkaufsliste fürs Handy. Reines HTML/JS, GitHub Pages.

- `index.html`: Dashboard mit Uhr, Diashow, Gassi, Diesel und Einkaufsliste
- `liste.html`: Einkaufsliste fürs Handy
- `lib.js`: Gist-Sync für die Liste und Auto-Update der Seite

**Daten:** Gassi und Diesel lesen `dashboard.json` aus den Repos `Wetter` und `Tanken`.
Die Fotos liegen nur im Speicher des iPads (IndexedDB) und werden nie hochgeladen.
Die Einkaufsliste ist ein geheimer Gist `einkaufsliste.json`. Den Token (Recht `gist`)
gibt man pro Gerät einmal ein, er bleibt im localStorage des Geräts.
