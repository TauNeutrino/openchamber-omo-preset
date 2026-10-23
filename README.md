# Omo Preset

Eine OpenChamber-Extension, die das aktive Preset von **oh-my-opencode-slim** anzeigt und wechselt — ohne TUI und ohne die Config von Hand zu bearbeiten.

- Panel auf der rechten Leiste und Sektion im Work-Status-Panel.
- Zeigt aktives Preset, Herkunft (`Global` / `Projekt`) und die Agent→Modell-Zuordnung des aktiven Presets.
- Dropdown aller Presets mit dem Orchestrator-Modell als Entscheidungshilfe.
- Bestätigungsdialog vor jedem Wechsel; Abbruch schreibt nichts.
- Schreibt ausschließlich den Schlüssel `preset`. Kommentare, Reihenfolge und Formatierung der JSONC-Datei bleiben erhalten.

## Installation

1. OpenChamber → Settings → Extensions → Ordner installieren.
2. Diesen Ordner auswählen (der Ordner mit `package.json`).
3. Die angefragten Berechtigungen bestätigen: `filesystem` für die globale Config, `files` für den Projekt-Override.

Es gibt keine Remote-Installation und keinen eigenen Service. Das Manifest deklariert `apiVersion: 1`, einen Panel-Beitrag und dieselbe Seite als Work-Status-Sektion.

## Verhalten

### Ebenen

Gelesen werden, in dieser Reihenfolge:

| Ebene | Pfad |
| --- | --- |
| Global | `~/.config/opencode/oh-my-opencode-slim.json`, sonst `.jsonc` |
| Projekt | `.opencode/oh-my-opencode-slim.json`, sonst `.jsonc` (relativ zum geöffneten Projekt) |

Ein Projekt-Override gewinnt, sobald er `preset` setzt. Ein Wechsel schreibt in **die Ebene, aus der das aktive Preset stammt** — ein Override bleibt also ein Override, genau wie in der Referenz-Implementierung und in der OpenChamber-API. Das Panel legt keinen Projekt-Override an; es ändert nur eine vorhandene Auswahl.

Definiert der Projekt-Override eine eigene `presets`-Map, entscheidet diese Map, welche Namen dort geschrieben werden dürfen; sonst erbt er die globale Map. Ein Name, der in der Zielebene nicht definiert ist, wird ohne Schreibvorgang abgelehnt.

### Anwenden

Nach der Bestätigung liest die Extension die Zieldatei **erneut**, prüft Preset-Name und Zielebene gegen den frischen Inhalt und schreibt erst dann. Nur `preset` wird per `jsonc-parser` `modify`/`applyEdits` ersetzt; danach wird das Ergebnis erneut geparst und gegen die ursprüngliche `presets`-Map verglichen. Schlägt eine Prüfung fehl, wird nichts geschrieben.

Die Extension startet den Managed Service **nicht** neu. Der Hinweis im Panel sagt es klar:

> Wirksam nach Neustart des Managed Service (Settings → Apply & Restart).

Ohne Neustart läuft der bestehende Service weiter mit dem alten Preset; neue Sessions nach dem Neustart verwenden das neue.

### Fehlerzustände

- Config fehlt: Hinweis mit beiden erwarteten Pfaden, kein Schreibvorgang.
- Config nicht parsebar: Fehlermeldung mit Fehlercode und Offset, kein Schreibvorgang.
- Aktives Preset nicht in der zuständigen `presets`-Map: Fehlermeldung, kein Schreibvorgang.
- Projekt-Override nicht lesbar (z. B. Berechtigung entzogen): Fehlermeldung statt stiller Annahme, keine Schreibvorgänge.

## Entwicklung

```bash
npm install
npm run build        # src/panel.ts -> panel/main.js (klassisches IIFE)
npm test             # JSONC-/Ebenen-Unit-Tests (node:test)
npm run type-check   # tsc --noEmit
npm run check        # build + IIFE-Check + Manifest-Check + Tests
```

`panel/main.js` wird mitgebaut und liegt im Repo, weil der Host keine TypeScript-Dateien kompiliert und kein ESM im iframe lädt. Der Build nutzt esbuild als devDependency; Laufzeit-Abhängigkeiten sind nur `@openchamber/sdk` (wird in das Bundle gezogen) und `jsonc-parser`.

`npm run check:iife` prüft mit `node --check`, dass das Artefakt ein klassisches Script ohne `import`/`export` ist. `npm run check:manifest` validiert `package.json` mit dem echten SDK-Parser (`parseManifestJson`), prüft `apiVersion`, die Einträge und die filesystem-Globs.

### Warum keine relativen filesystem-Globs?

`contributes.filesystem` akzeptiert laut SDK nur Muster, die mit `/` oder `~/` beginnen (`isGuestFilesystemPattern`); ein relativer Eintrag wie `.opencode/oh-my-opencode-slim.json` wäre `invalid-filesystem` und würde die Installation ablehnen. Der Projekt-Override läuft deshalb über die relative Pfadform der Datei-API und die Capability `files`, die das SDK ausdrücklich für Pfade innerhalb des geöffneten Projekts vorsieht. Das Panel fragt `ready.directory` ab und zeigt ohne Projekt nur die globale Ebene.

## Bewusst nicht im Scope

- Presets anlegen, bearbeiten oder löschen (bleibt Aufgabe von oms / der Config).
- Managed-Service-Restart aus der Extension.
- Einen Projekt-Override erzeugen, wenn keiner existiert.

## Validierung

Automatisiert:

- 22 Unit-Tests für Lesen/Schreiben: `.json` und `.jsonc`, Kommentare, Reihenfolge, CRLF, BOM, Einrückung, Einfügen eines fehlenden `preset`, Ablehnung von Parse-Fehlern und unbekannten Presets, Ebenen-Auflösung.
- Build-Artefakt: klassisches IIFE ohne `import`/`export`, per `node --check` geprüft.
- Manifest: mit `parseManifestJson` aus `@openchamber/sdk/schemas` validiert.

Manuell gegen einen Mock-Host im Browser geprüft (nicht Teil des Repos): Anzeige mit globalem und Projekt-Override, Dropdown, Bestätigen/Abbrechen, Fehlerzustände, Schreiben in `.jsonc` mit erhaltenem Kommentar, erneutes Lesen vor dem Schreiben, `setHeight` im Status-Surface.

Nicht geprüft: echter Installations- und Ladetest in OpenChamber, Verhalten des Managed-Service-Restarts, Light-Theme im Host, mobile/VSCode-Surfaces.
