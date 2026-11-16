![Logo](admin/midea-heatpump.png)

# ioBroker.midea-heatpump

**[English version](README.md)**

Adapter für Midea-Luft-Wasser-Wärmepumpen (M-Thermal-Protokoll) über Modbus – direkt per RS-485, per Modbus TCP oder als RTU-Telegramme über TCP (z. B. ESP32-Bridge mit `stream_server`).

## Unterstützte Modelle

| Modell | Status |
|---|---|
| Midea MHC-V8WD2RN7 (R290, 8 kW, Monoblock, Zusatzheizung 3/6/9 kW) | getestet |

Eine automatische Modellerkennung ist über Modbus nicht möglich, das Modell wird in der Instanz-Konfiguration gewählt. Beim Start prüft der Adapter das Register „Unit capacity“ (123) und warnt, wenn es nicht zum gewählten Modell passt.

### Weitere Modelle ergänzen

1. Datei unter `lib/models/` anlegen. Gemeinsame Register und Zuordnungen kommen aus `midea-common.js`, mit `extendModel()` werden nur die Abweichungen beschrieben (Leistung, Stufen der Zusatzheizung, ungültige Adressen, zusätzliche oder entfallende Register).
2. Das Modell in `lib/models/index.js` eintragen.
3. Die Auswahl im Dropdown in `admin/jsonConfig.json` ergänzen.

## Funktionen

- **Sprechende Datenpunkte**: Temperaturen, Betrieb, Status-Bits, Einstellungen des Servicemenüs, Heizkurve. Ein Register erscheint genau einmal. Register ohne Zuordnung landen optional als Rohwert unter `Register.*`.
- **Robuste Abfrage**:
  - Messwerte (Register < 200) werden jeden Zyklus gelesen, Einstellungen (≥ 200) seltener.
  - Bleibt eine Antwort aus, wird die Anfrage wiederholt, ohne die Verbindung zu trennen. Neu verbunden wird erst nach 3 Anfragen in Folge ohne Antwort.
  - Zwischen zwei Anfragen liegt eine einstellbare Pause.
  - Vom Gerät abgelehnte Adressen („Illegal Data Address“) lernt der Adapter selbst und liest sie künftig nicht mehr (`info.invalidAddresses`).
- **Statistik** (bleibt bei einem Neustart erhalten):
  - Stromverbrauch je Betriebsart (Heizen/Warmwasser/Standby) aus einem geeichten Stromzähler
  - Wärme je Betriebsart aus einem Wärmemengenzähler, aufgeteilt nach Leistung bzw. Laufzeit
  - COP je Tag und Betriebsart
  - Tageswerte der internen Gerätezähler, getrennt unter `Tageswerte.WP intern`
  - Verdichterstarts und -laufzeit je Tag und Betriebsart, mittlere Laufzeit je Start
  - Heizstab: aktuelle Leistung, geschätzter Strom und Laufzeit je Tag
  - Desinfektionserkennung (die WP meldet nicht, ob eine Desinfektion läuft)
  - Soll-Vorlauf aus Heizkurve oder festem Sollwert, Spreizung Vorlauf/Rücklauf
- **Schnellabfrage des Wärmemengenzählers** (optional): Ein boolescher Datenpunkt wird gesetzt, solange die WP heizt oder Warmwasser macht, plus Nachlauf.
- **Schreiben** (nur wenn in der Konfiguration erlaubt):
  - Warmwasser-Soll
  - fester Soll-Vorlauf Zone 1 (Grenzen aus Reg. 203/204)
  - Warmwasser erzwingen
  - Warmwasser ein/aus
  - Zone 1 ein/aus
  - Heizkurve
  - Leisemodus und Leisemodus-Stufe
  - ECO-Modus
  - Klimakurve Zone 1
  - eigene Heizkurve (T1SetH1/2, T4H1/2)

  Werte außerhalb der Grenzen werden abgelehnt. Bitfelder werden frisch gelesen, ein Bit geändert und zurückgeschrieben. Nach jedem Schreiben wird das Register zurückgelesen und der Datenpunkt bestätigt.

## Konfiguration (Beispiel ESP-Bridge)

| Einstellung | Wert |
|---|---|
| Verbindungsart | RTU über TCP |
| IP / Port | IP der Bridge, Port des stream_server (z. B. 5021) |
| Geräteadresse | 1 |
| Abfrageintervall | 10 s |
| Einstellungs-Intervall | 300 s |
| Antwort-Timeout | 3000 ms |
| Pause zwischen Anfragen | 250 ms |
| Wiederholungen | 1 |
| Maximale Adresslücke | 0 |

Hinweis: Der stream_server nimmt pro Port in der Regel nur einen Client sinnvoll an. Der Modbus-Adapter darf dann nicht gleichzeitig auf denselben Port zugreifen.

## Umzug vom Node-RED-Flow

Das Skript `tools/migration_von_flow.js` (ioBroker-JavaScript) überträgt die heutigen Tageswerte und die InfluxDB-Einstellungen mit denselben Aliasen von `0_userdata.0.Wärmepumpe.*` auf die Datenpunkte des Adapters. Grafana läuft dadurch unverändert weiter. Zuerst einmal mit `DRY_RUN = true` ausführen.

## Installation

```bash
iob url https://github.com/MMeinhardt1/ioBroker.midea-heatpump
iob add midea-heatpump
```

## Changelog

### 0.1.0 (2026-11-15)

- Erstveröffentlichung: Midea MHC-V8WD2RN7, Statistik aus dem bisherigen Node-RED-Flow, Schreibzugriff mit Grenzprüfung

## License

MIT License, Copyright (c) 2026 MMeinhardt1
