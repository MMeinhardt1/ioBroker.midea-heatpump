'use strict';

/**
 * Berechnete Werte der Waermepumpe (Portierung des Node-RED-Flows "WP dekodieren + Tageswerte").
 *
 *  - Strom je Betriebsart aus dem geeichten Stromzaehler (Fremd-Datenpunkt), Standby als Rest
 *  - Waerme je Betriebsart aus dem Waermemengenzaehler (Fremd-Datenpunkt), verteilt nach Leistung bzw. Laufzeit
 *  - Tageswerte der internen Geraetezaehler (Schaetzwerte der WP, getrennt unter "Tageswerte.WP intern")
 *  - Verdichterstarts und -laufzeit je Tag und Betriebsart
 *  - Heizstab: Leistung, geschaetzter Strom und Laufzeit je Tag
 *  - Desinfektionserkennung, Soll-Vorlauf (Heizkurve oder fester Wert), Spreizung
 *
 * Die Klasse kennt kein ioBroker: Ausgaben laufen ueber put(), Ereignisse ueber event(). So ist sie testbar.
 */

const T = 'value.temperature';
const BIN = ['Heizen', 'Warmwasser']; // gezaehlte Betriebsarten, der Rest ist Standby
const SV_MODES = ['Heizen', 'Warmwasser', 'Standby'];
const VMODI = ['Gesamt', 'Heizen', 'Warmwasser'];
const IP = 'Tageswerte.WP intern.';
const GROUPS = [
    { id: 'Gesamt', label: 'WP intern: ', path: IP, sp: '', sReg: 143, wReg: 145 },
    { id: 'Heizen', label: 'WP intern Heizen: ', path: `${IP}Heizen.`, sp: 'Heizen_', sReg: 162, wReg: 158 },
    {
        id: 'Warmwasser',
        label: 'WP intern Warmwasser: ',
        path: `${IP}Warmwasser.`,
        sp: 'Warmwasser_',
        sReg: 176,
        wReg: 172,
    },
];

const r2 = x => Math.round(x * 100) / 100;
const r3 = x => Math.round(x * 1000) / 1000;
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const lt = d => `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/**
 * @typedef {object} StatOptions
 * @property {number} minKwhCop - unter diesem Tagesverbrauch wird der COP mit 0 gemeldet
 * @property {boolean} heatMeter - Waermemengenzaehler vorhanden
 * @property {number} powerMaxAgeMs - so lange gilt ein Leistungswert des WMZ als aktuell
 * @property {number} minPowerCoverage - Anteil der Laufzeit mit Leistungswert, ab dem nach Leistung verteilt wird
 * @property {number} startAssignMs - Frist, in der ein Verdichterstart einer Betriebsart zugeordnet wird
 * @property {number} diMargin - K ueber Warmwasser-Soll, ab der eine Ladung als Desinfektion gilt
 * @property {number} diDefaultTarget - Desinfektions-Zieltemperatur, falls Reg. 220 fehlt
 * @property {number} diDefaultDhwSet - Warmwasser-Soll, falls Reg. 4 fehlt
 * @property {number|null} diWeekday - geplanter Wochentag (0 = So) oder null
 * @property {string} diTime - geplante Uhrzeit "HH:MM" oder ''
 * @property {number} diWindowMin - Ladung bis so viele Minuten nach Planzeit = Desinfektion
 */

/** @type {StatOptions} */
const DEFAULTS = {
    minKwhCop: 0.2,
    heatMeter: false,
    powerMaxAgeMs: 3 * 60000,
    minPowerCoverage: 0.8,
    startAssignMs: 120000,
    diMargin: 2,
    diDefaultTarget: 65,
    diDefaultDhwSet: 55,
    diWeekday: null,
    diTime: '',
    diWindowMin: 30,
};

/**
 * Berechnete Werte (Tageswerte, Verdichter, Heizstab, Desinfektion, Soll-Vorlauf).
 */
class Statistics {
    /**
     * @param {Partial<StatOptions>} options - Optionen
     * @param {(rel: string, val: ioBroker.StateValue, name: string, unit?: string, role?: string) => void} put - Wert ausgeben
     * @param {(type: string, data: object) => void} [event] - Ereignis (fuers Debug-Log)
     */
    constructor(options, put, event) {
        this.o = { ...DEFAULTS, ...options };
        this.put = put;
        this.event = event || (() => undefined);
        this.ready = false;
        /** zuletzt gelesene (skalierte) Registerwerte */
        this.raw = {};
        const c = {};
        c.sv = { Heizen: 0, Warmwasser: 0, Standby: 0 };
        c.hv = { Heizen: 0, Warmwasser: 0 };
        c.pend = {};
        c.pint = { Heizen: 0, Warmwasser: 0 };
        c.tint = { Heizen: 0, Warmwasser: 0 };
        c.pcov = 0;
        c.vs = { Gesamt: 0, Heizen: 0, Warmwasser: 0 };
        c.vl = { Gesamt: 0, Heizen: 0, Warmwasser: 0 };
        c.hs = { kwh: 0, h: 0 };
        c.di = {};
        c.grp = {};
        GROUPS.forEach(g => {
            c.grp[g.id] = { c: {}, pend: {}, start: {}, heute: {}, datum: null };
        });
        this.c = c;
    }

    /** Nach dem ersten vollstaendigen Abfragezyklus aufrufen: ab jetzt wird gerechnet und gebucht. */
    setReady() {
        this.ready = true;
    }

    // ------------------------------------------------------------------ Wiederherstellung

    /**
     * Gespeicherte Tageswerte nach einem Neustart uebernehmen.
     *
     * @param {Record<string, ioBroker.StateValue>} st - eigene Datenpunkte (relative ID -> Wert)
     */
    restore(st) {
        const c = this.c;
        const num = id => (typeof st[id] === 'number' && isFinite(st[id]) ? st[id] : null);
        const str = id => (st[id] != null && st[id] !== '' ? String(st[id]) : null);
        GROUPS.forEach(g => {
            const gr = c.grp[g.id];
            const ss = num(`${IP}Intern.${g.sp}Strom_Start`);
            const ws = num(`${IP}Intern.${g.sp}Waerme_Start`);
            if (ss != null) {
                gr.start.strom = ss;
            }
            if (ws != null) {
                gr.start.waerme = ws;
            }
            const sh = num(`${g.path}Strom_heute`);
            const wh = num(`${g.path}Waerme_heute`);
            if (sh != null) {
                gr.heute.strom = sh;
            }
            if (wh != null) {
                gr.heute.waerme = wh;
            }
            gr.datum = str(`${IP}Intern.${g.sp}Datum`);
        });
        VMODI.forEach(m => {
            const p = m === 'Gesamt' ? 'Verdichter.' : `Verdichter.${m}.`;
            const s = num(`${p}Starts_heute`);
            const l = num(`${p}Laufzeit_h_heute`);
            if (s != null) {
                c.vs[m] = s;
            }
            if (l != null) {
                c.vl[m] = l;
            }
        });
        c.vDatum = str('Verdichter.Intern.Datum');
        const hk = num('Heizstab.Strom_heute');
        const hh = num('Heizstab.Laufzeit_h_heute');
        if (hk != null) {
            c.hs.kwh = hk;
        }
        if (hh != null) {
            c.hs.h = hh;
        }
        c.hsDatum = str('Heizstab.Intern.Datum');
        c.svDatum = str('Stromverbrauch.Intern.Datum');
        const ms = num('Stromverbrauch.Intern.Zaehler_Start');
        if (ms != null) {
            c.mStart = ms;
        }
        SV_MODES.forEach(m => {
            const v = num(`Stromverbrauch.${m}_heute`);
            if (v != null) {
                c.sv[m] = v;
            }
        });
        BIN.forEach(m => {
            const v = num(`Tageswerte.${m}.Waerme_heute`);
            if (v != null) {
                c.hv[m] = v;
            }
        });
        const d = str('Desinfektion.Letzte');
        if (d) {
            this.event('restore', { desinfektion_letzte: d });
        }
    }

    // ------------------------------------------------------------------ Eingaenge

    /**
     * Registerwert verarbeiten.
     *
     * @param {number} addr - Adresse
     * @param {number} v - skalierter Wert
     * @param {number} raw - Rohwert
     */
    onRegister(addr, v, raw) {
        const c = this.c;
        const now = Date.now();
        this._accumulate(now);
        this.raw[addr] = v;
        const g = GROUPS.find(x => x.sReg === addr || x.wReg === addr);
        if (g) {
            this._setCounter(c.grp[g.id], g.sReg === addr ? 'strom' : 'waerme', v);
        }
        if (addr === 110) {
            c.tVl = v;
        }
        if (addr === 104) {
            c.tRl = v;
        }
        if ((addr === 110 || addr === 104) && c.tVl != null && c.tRl != null) {
            this.put(
                'Temperaturen.Spreizung',
                Math.round((c.tVl - c.tRl) * 10) / 10,
                'Spreizung Vorlauf − Rücklauf',
                'K',
                T,
            );
        }
        if (addr === 100) {
            const an = v > 0;
            if (an && c.vOn === false && this.ready) {
                c.vs.Gesamt += 1;
                c.vStartPend = now;
                this._accumulate(now);
            }
            c.vOn = an;
            this.put('Verdichter.laeuft', an, 'Verdichter läuft (Frequenz > 0)', '', 'indicator.working');
        }
        if (addr === 198) {
            const w = raw;
            const ww = (w >> 5) & 1;
            const hz = (w >> 4) & 1;
            const ku = (w >> 3) & 1;
            this.put(
                'Status.Betrieb_Text',
                ww ? 'Warmwasser' : hz ? 'Heizen' : ku ? 'Kühlen' : 'Standby',
                'Aktueller Betrieb',
                '',
                'text',
            );
            this.put('Tageswerte.Heizen.Heizen', hz === 1, 'Heizbetrieb aktiv', '', 'indicator.working');
            this.put('Tageswerte.Warmwasser.Warmwasser', ww === 1, 'Warmwasserbetrieb aktiv', '', 'indicator.working');
            const newMode = ww ? 'Warmwasser' : hz ? 'Heizen' : 'Standby'; // Kuehlen zaehlt als Standby
            if (c.mode !== newMode) {
                if (this.ready) {
                    this._flushAll();
                }
                this.event('betriebsart', {
                    von: c.mode || null,
                    nach: newMode,
                    strom: c.m ?? null,
                    waerme: c.h ?? null,
                });
                c.mode = newMode;
                if (BIN.includes(newMode)) {
                    c.lastActive = newMode;
                }
            }
        }
        if (addr === 129) {
            this.put('Status.Heizstab_laeuft', (raw & 3) !== 0, 'Heizstab (IBH1/IBH2) läuft', '', 'indicator.working');
        }
        if (addr === 129 || addr === 250 || addr === 251) {
            const w = Math.round(this.raw[129] || 0);
            const p1 = this.raw[250] || 0;
            const p2 = this.raw[251] || 0;
            c.hsW = (w & 1 ? p1 : 0) + (w & 2 ? p2 : 0);
            this.put(
                'Heizstab.Leistung_aktuell',
                Math.round(c.hsW),
                'Heizstab: Leistung jetzt (konfigurierte Leistung der eingeschalteten Stufen)',
                'W',
                'value.power',
            );
        }
        if (addr === 198 || addr === 115 || addr === 4) {
            this._diCheck(now);
        }
    }

    /**
     * Zaehlerstand Stromzaehler (kWh).
     *
     * @param {number} kwh - Zaehlerstand
     */
    onMeter(kwh) {
        this._accumulate(Date.now());
        this._acceptMeter('m', kwh);
    }

    /**
     * Zaehlerstand Waermemengenzaehler (kWh).
     *
     * @param {number} kwh - Zaehlerstand
     */
    onHeatMeter(kwh) {
        this._accumulate(Date.now());
        this._acceptMeter('h', kwh);
    }

    /**
     * Leistung Waermemengenzaehler (kW).
     *
     * @param {number} kw - Leistung
     */
    onHeatPower(kw) {
        this._accumulate(Date.now());
        this.c.pP = kw;
        this.c.pTs = Date.now();
    }

    /** @returns {string|undefined} aktuelle Betriebsart (Heizen/Warmwasser/Standby) */
    get mode() {
        return this.c.mode;
    }

    // ------------------------------------------------------------------ Berechnung

    /**
     * Tageswerte, Verdichter, Heizstab und Soll-Vorlauf berechnen (nach jedem Zyklus und im 30-s-Takt).
     *
     * @param {number} [nowMs] - Zeitpunkt (fuer Tests)
     */
    update(nowMs) {
        const now = nowMs ?? Date.now();
        this._accumulate(now);
        if (this.ready) {
            this._internalCounters(now);
            this._meterDayValues(now);
            this._compressor(now);
            this._heater(now);
        }
        this._flowSetpoint();
    }

    /**
     * COP aus Waerme und Strom (0 unter Mindestverbrauch).
     *
     * @param {number} w - Waerme (kWh)
     * @param {number} s - Strom (kWh)
     * @returns {number} COP
     */
    _cop(w, s) {
        return s >= this.o.minKwhCop ? r2(w / s) : 0;
    }

    /**
     * Interner Geraetezaehler: kleinerer Wert nur, wenn er zweimal in Folge kommt.
     *
     * @param {object} gr - Zaehlergruppe
     * @param {string} field - strom | waerme
     * @param {number} val - Zaehlerstand
     */
    _setCounter(gr, field, val) {
        const prev = gr.c[field];
        if (prev == null || val >= prev) {
            gr.c[field] = val;
            delete gr.pend[field];
            return;
        }
        if (gr.pend[field] === val) {
            gr.c[field] = val;
            delete gr.pend[field];
        } else {
            gr.pend[field] = val;
        }
    }

    // Kleinerer Zaehlerwert wird nur akzeptiert, wenn er zweimal in Folge kommt (Schutz vor Lesefehlern)
    /**
     * Geeichter Zaehler: kleinerer Wert nur, wenn er zweimal in Folge kommt (Schutz vor Lesefehlern).
     *
     * @param {string} k - 'm' = Strom, 'h' = Waerme
     * @param {number} val - Zaehlerstand
     */
    _acceptMeter(k, val) {
        const c = this.c;
        const prev = c[k];
        if (prev == null || val >= prev) {
            c[k] = val;
            delete c.pend[k];
            return;
        }
        if (c.pend[k] === val) {
            c[k] = val;
            delete c.pend[k];
        } else {
            c.pend[k] = val;
            this.event('zaehler_ausreisser', { zaehler: k, bisher: prev, neu: val });
        }
    }

    /**
     * Zuwachs seit der letzten Grenze der aktuellen Betriebsart zuordnen.
     *
     * @param {string} vk - Schluessel Zaehlerstand
     * @param {string} lk - Schluessel letzter Stand
     * @param {Record<string, number>} bins - Summen je Betriebsart
     */
    _flushBins(vk, lk, bins) {
        const c = this.c;
        if (c[vk] == null) {
            return;
        }
        if (c[lk] == null || c[vk] < c[lk]) {
            c[lk] = c[vk];
            return;
        }
        const d = c[vk] - c[lk];
        if (d > 0) {
            if (BIN.includes(c.mode)) {
                bins[c.mode] = (bins[c.mode] || 0) + d;
            }
            c[lk] = c[vk];
        }
    }

    /**
     * Laufzeiten und Leistungen bis jetzt der aktuellen Betriebsart zuschreiben.
     *
     * @param {number} now - Zeitpunkt (ms)
     */
    _accumulate(now) {
        const c = this.c;
        if (c.vT != null && c.vOn) {
            const dtv = Math.max(0, now - c.vT) / 3600000;
            if (dtv < 1) {
                c.vl.Gesamt += dtv;
                if (BIN.includes(c.mode)) {
                    c.vl[c.mode] += dtv;
                }
            }
        }
        c.vT = now;
        if (c.hsT != null && c.hsW > 0) {
            const dth = Math.max(0, now - c.hsT) / 3600000;
            if (dth < 1) {
                c.hs.kwh += (c.hsW / 1000) * dth;
                c.hs.h += dth;
            }
        }
        c.hsT = now;
        if (c.vStartPend) {
            if (BIN.includes(c.mode)) {
                c.vs[c.mode] += 1;
                c.vStartPend = 0;
            } else if (now - c.vStartPend > this.o.startAssignMs) {
                c.vStartPend = 0;
            }
        }
        if (c.pT != null && BIN.includes(c.mode)) {
            const dt = Math.max(0, now - c.pT) / 3600000;
            if (dt < 1) {
                c.tint[c.mode] += dt;
                if (c.pP != null && c.pTs != null && now - c.pTs <= this.o.powerMaxAgeMs) {
                    c.pint[c.mode] += c.pP * dt;
                    c.pcov += dt;
                }
            }
        }
        c.pT = now;
    }

    /**
     * Aufsummierte Leistung/Laufzeit fuer die Waermeverteilung zuruecksetzen.
     */
    _resetHeatAcc() {
        this.c.pint = { Heizen: 0, Warmwasser: 0 };
        this.c.tint = { Heizen: 0, Warmwasser: 0 };
        this.c.pcov = 0;
    }

    /**
     * Zuwachs des Waermemengenzaehlers auf Heizen/Warmwasser verteilen.
     */
    _bookHeat() {
        const c = this.c;
        if (c.h == null) {
            return;
        }
        if (c.hLast == null || c.h < c.hLast) {
            c.hLast = c.h;
            this._resetHeatAcc();
            return;
        }
        const d = c.h - c.hLast;
        if (d <= 0) {
            return;
        }
        const ps = c.pint.Heizen + c.pint.Warmwasser;
        const ts = c.tint.Heizen + c.tint.Warmwasser;
        let anteilH;
        let basis;
        const abdeckung = ts > 0 ? c.pcov / ts : 0;
        if (ps > 0 && abdeckung >= this.o.minPowerCoverage) {
            anteilH = c.pint.Heizen / ps;
            basis = 'leistung';
        } else if (ts > 0) {
            anteilH = c.tint.Heizen / ts;
            basis = 'laufzeit';
        } else if (BIN.includes(c.mode)) {
            anteilH = c.mode === 'Heizen' ? 1 : 0;
            basis = 'betriebsart';
        } else if (c.lastActive) {
            anteilH = c.lastActive === 'Heizen' ? 1 : 0;
            basis = 'letzte_betriebsart';
        } else {
            anteilH = null;
            basis = 'nicht_zuordenbar';
        }
        if (anteilH !== null) {
            c.hv.Heizen = (c.hv.Heizen || 0) + d * anteilH;
            c.hv.Warmwasser = (c.hv.Warmwasser || 0) + d * (1 - anteilH);
        }
        this.event('waerme_verteilung', {
            kwh: d,
            basis,
            anteil_heizen: anteilH === null ? null : r3(anteilH),
            abdeckung: r3(abdeckung),
        });
        c.hLast = c.h;
        this._resetHeatAcc();
    }

    /**
     * Strom und Waerme bis jetzt zuordnen.
     */
    _flushAll() {
        this._flushBins('m', 'svLast', this.c.sv);
        if (this.o.heatMeter) {
            this._bookHeat();
        }
    }

    /**
     * Strom-Tageswerte; Gesamt aus Zaehlerdifferenz, Standby als Rest.
     *
     * @returns {{H: number, W: number, G: number, S: number}} Tageswerte
     */
    _dayValues() {
        const c = this.c;
        const H = c.sv.Heizen || 0;
        const W = c.sv.Warmwasser || 0;
        const G = Math.max(0, c.m - c.mStart);
        return { H, W, G, S: Math.max(0, G - H - W) };
    }

    /**
     * Liegt der Zeitpunkt im geplanten Desinfektionsfenster?
     *
     * @param {number} t - Zeitpunkt (ms)
     * @returns {boolean} true im Fenster
     */
    _diPlanned(t) {
        const o = this.o;
        if (
            o.diWeekday === null ||
            o.diWeekday === undefined ||
            o.diWeekday < 0 ||
            !/^\d{1,2}:\d{2}$/.test(o.diTime || '')
        ) {
            return false;
        }
        const d = new Date(t);
        const [hh, mm] = o.diTime.split(':').map(Number);
        const plan = new Date(d);
        plan.setHours(hh, mm, 0, 0);
        if (d.getDay() !== o.diWeekday) {
            return false;
        }
        const diff = (t - plan.getTime()) / 60000;
        return diff >= -5 && diff <= o.diWindowMin;
    }

    /**
     * Desinfektion erkennen und Ergebnis der letzten Desinfektion schreiben.
     *
     * @param {number} now - Zeitpunkt (ms)
     */
    _diCheck(now) {
        const c = this.c;
        const di = c.di;
        const ww = c.mode === 'Warmwasser';
        const t5 = this.raw[115];
        const soll = this.raw[4] != null ? this.raw[4] : this.o.diDefaultDhwSet;
        if (ww && !di.wwStart) {
            di.wwStart = now;
            di.t5Start = t5;
            di.t5Max = t5;
            di.aktiv = this._diPlanned(now);
            di.grund = di.aktiv ? 'zeitplan' : null;
        }
        if (ww && di.wwStart) {
            if (t5 != null) {
                di.t5Max = Math.max(di.t5Max == null ? t5 : di.t5Max, t5);
            }
            if (!di.aktiv && t5 != null && t5 >= soll + this.o.diMargin) {
                di.aktiv = true;
                di.grund = 'temperatur';
            }
        }
        if (!ww && di.wwStart) {
            if (di.aktiv) {
                const dauer = Math.round((now - di.wwStart) / 60000);
                this.put(
                    'Desinfektion.Letzte',
                    lt(new Date(di.wwStart)),
                    'Desinfektion: Beginn der letzten erkannten Desinfektion',
                    '',
                    'text',
                );
                this.put(
                    'Desinfektion.Letzte_Dauer_min',
                    dauer,
                    'Desinfektion: Dauer der letzten Ladung',
                    'min',
                    'value',
                );
                this.put('Desinfektion.Letzte_T5_max', di.t5Max, 'Desinfektion: höchste Speichertemperatur', '°C', T);
                const ziel = this.raw[220] != null ? Math.round(this.raw[220]) : this.o.diDefaultTarget;
                this.put(
                    'Desinfektion.Letzte_Ziel_erreicht',
                    di.t5Max != null && di.t5Max >= ziel,
                    'Desinfektion: Zieltemperatur (Reg. 220) erreicht',
                    '',
                    'indicator',
                );
                this.event('desinfektion', {
                    beginn: lt(new Date(di.wwStart)),
                    dauer_min: dauer,
                    t5_start: di.t5Start,
                    t5_max: di.t5Max,
                    grund: di.grund,
                });
            }
            c.di = {};
        }
        this.put(
            'Status.Desinfektion_laeuft',
            !!c.di.aktiv,
            'Desinfektion läuft (erkannt aus Warmwasserladung über Soll bzw. Zeitplan)',
            '',
            'indicator.working',
        );
    }

    // Soll-Vorlauf Zone 1: mit aktiver Heizkurve (Reg. 5 Bit 12) gilt Reg. 136, sonst Reg. 11
    /**
     * Soll-Vorlauf Zone 1 aus Heizkurve oder festem Wert.
     */
    _flowSetpoint() {
        const r5 = this.raw[5];
        const r136 = this.raw[136];
        const kurve = r5 != null ? ((Math.round(r5) >> 12) & 1) === 1 : r136 != null && Math.round(r136) !== 255;
        const v = this.raw[kurve ? 136 : 11];
        if (v == null || Math.round(v) === 255) {
            return;
        }
        this.put(
            'Temperaturen.Vorlauf_Soll',
            Math.round(v),
            'Soll-Vorlauf Zone 1 (mit Heizkurve Reg. 136, ohne Heizkurve Reg. 11)',
            '°C',
            T,
        );
        this.put(
            'Temperaturen.Vorlauf_Soll_Quelle',
            kurve ? 'Heizkurve (Reg. 136)' : 'fester Sollwert (Reg. 11)',
            'Quelle des Soll-Vorlaufs',
            '',
            'text',
        );
    }

    /**
     * Tageswerte der internen Geraetezaehler.
     *
     * @param {number} now - Zeitpunkt (ms)
     */
    _internalCounters(now) {
        const today = ymd(new Date(now));
        GROUPS.forEach(g => {
            const gr = this.c.grp[g.id];
            const c = gr.c;
            if (c.strom == null || c.waerme == null) {
                return;
            }
            const newDay = gr.datum !== today;
            const missing = gr.start.strom == null || gr.start.waerme == null;
            const reset = !missing && (c.strom < gr.start.strom || c.waerme < gr.start.waerme);
            if (newDay || missing || reset) {
                if (newDay && gr.datum && gr.heute.strom != null && gr.heute.waerme != null) {
                    this.put(
                        `${g.path}Strom_gestern`,
                        r2(gr.heute.strom),
                        `${g.label}Stromverbrauch gestern`,
                        'kWh',
                        'value.energy',
                    );
                    this.put(
                        `${g.path}Waerme_gestern`,
                        r2(gr.heute.waerme),
                        `${g.label}Wärmeerzeugung gestern`,
                        'kWh',
                        'value.energy',
                    );
                    this.put(
                        `${g.path}COP_gestern`,
                        this._cop(gr.heute.waerme, gr.heute.strom),
                        `${g.label}COP gestern`,
                        '',
                        'value',
                    );
                }
                gr.start = { strom: c.strom, waerme: c.waerme };
                gr.datum = today;
                this.put(
                    `${IP}Intern.${g.sp}Strom_Start`,
                    c.strom,
                    `${g.label}Zählerstand Strom um 00:00`,
                    'kWh',
                    'value.energy',
                );
                this.put(
                    `${IP}Intern.${g.sp}Waerme_Start`,
                    c.waerme,
                    `${g.label}Zählerstand Wärme um 00:00`,
                    'kWh',
                    'value.energy',
                );
                this.put(`${IP}Intern.${g.sp}Datum`, today, `${g.label}Datum der Startwerte`, '', 'text');
            }
            const s = r2(c.strom - gr.start.strom);
            const w = r2(c.waerme - gr.start.waerme);
            gr.heute = { strom: s, waerme: w };
            this.put(`${g.path}Strom_heute`, s, `${g.label}Stromverbrauch heute`, 'kWh', 'value.energy');
            this.put(`${g.path}Waerme_heute`, w, `${g.label}Wärmeerzeugung heute`, 'kWh', 'value.energy');
            this.put(`${g.path}COP_heute`, this._cop(w, s), `${g.label}COP heute`, '', 'value');
        });
    }

    /**
     * Geeichte Tageswerte aus Strom- und Waermemengenzaehler.
     *
     * @param {number} now - Zeitpunkt (ms)
     */
    _meterDayValues(now) {
        const c = this.c;
        if (c.m == null) {
            return;
        }
        const heat = this.o.heatMeter && c.h != null;
        const today = ymd(new Date(now));
        if (c.mStart == null) {
            c.mStart = c.m - ((c.sv.Heizen || 0) + (c.sv.Warmwasser || 0) + (c.sv.Standby || 0));
            this.put(
                'Stromverbrauch.Intern.Zaehler_Start',
                r3(c.mStart),
                'Zählerstand Stromzähler um 00:00',
                'kWh',
                'value.energy',
            );
        }
        if (c.svDatum !== today) {
            this._flushAll();
            if (c.svDatum) {
                const d = this._dayValues();
                this.put(
                    'Stromverbrauch.Heizen_gestern',
                    r3(d.H),
                    'Stromverbrauch Heizen gestern',
                    'kWh',
                    'value.energy',
                );
                this.put(
                    'Stromverbrauch.Warmwasser_gestern',
                    r3(d.W),
                    'Stromverbrauch Warmwasser gestern',
                    'kWh',
                    'value.energy',
                );
                this.put(
                    'Stromverbrauch.Standby_gestern',
                    r3(d.S),
                    'Stromverbrauch Stand-By gestern',
                    'kWh',
                    'value.energy',
                );
                this.put(
                    'Stromverbrauch.Gesamt_gestern',
                    r3(d.G),
                    'Stromverbrauch gesamt gestern',
                    'kWh',
                    'value.energy',
                );
                this.put(
                    'Tageswerte.Heizen.Strom_gestern',
                    r2(d.H),
                    'Heizen: Stromverbrauch gestern',
                    'kWh',
                    'value.energy',
                );
                this.put(
                    'Tageswerte.Warmwasser.Strom_gestern',
                    r2(d.W),
                    'Warmwasser: Stromverbrauch gestern',
                    'kWh',
                    'value.energy',
                );
                if (heat) {
                    this.put(
                        'Tageswerte.Heizen.Waerme_gestern',
                        r2(c.hv.Heizen),
                        'Heizen: Wärmeerzeugung gestern',
                        'kWh',
                        'value.energy',
                    );
                    this.put(
                        'Tageswerte.Warmwasser.Waerme_gestern',
                        r2(c.hv.Warmwasser),
                        'Warmwasser: Wärmeerzeugung gestern',
                        'kWh',
                        'value.energy',
                    );
                    this.put(
                        'Tageswerte.Heizen.COP_gestern',
                        this._cop(c.hv.Heizen, d.H),
                        'Heizen: COP gestern',
                        '',
                        'value',
                    );
                    this.put(
                        'Tageswerte.Warmwasser.COP_gestern',
                        this._cop(c.hv.Warmwasser, d.W),
                        'Warmwasser: COP gestern',
                        '',
                        'value',
                    );
                }
            }
            c.sv = { Heizen: 0, Warmwasser: 0, Standby: 0 };
            c.hv = { Heizen: 0, Warmwasser: 0 };
            c.mStart = c.m;
            c.svDatum = today;
            this.put('Stromverbrauch.Intern.Datum', today, 'Datum der heute-Werte', '', 'text');
            this.put(
                'Stromverbrauch.Intern.Zaehler_Start',
                r3(c.mStart),
                'Zählerstand Stromzähler um 00:00',
                'kWh',
                'value.energy',
            );
        }
        this._flushAll();
        const d = this._dayValues();
        this.put('Stromverbrauch.Heizen_heute', r3(d.H), 'Stromverbrauch Heizen heute', 'kWh', 'value.energy');
        this.put('Stromverbrauch.Warmwasser_heute', r3(d.W), 'Stromverbrauch Warmwasser heute', 'kWh', 'value.energy');
        this.put('Stromverbrauch.Standby_heute', r3(d.S), 'Stromverbrauch Stand-By heute', 'kWh', 'value.energy');
        this.put('Stromverbrauch.Gesamt_heute', r3(d.G), 'Stromverbrauch gesamt heute', 'kWh', 'value.energy');
        this.put('Tageswerte.Heizen.Strom_heute', r2(d.H), 'Heizen: Stromverbrauch heute', 'kWh', 'value.energy');
        this.put(
            'Tageswerte.Warmwasser.Strom_heute',
            r2(d.W),
            'Warmwasser: Stromverbrauch heute',
            'kWh',
            'value.energy',
        );
        if (heat) {
            this.put(
                'Tageswerte.Heizen.Waerme_heute',
                r2(c.hv.Heizen),
                'Heizen: Wärmeerzeugung heute',
                'kWh',
                'value.energy',
            );
            this.put(
                'Tageswerte.Warmwasser.Waerme_heute',
                r2(c.hv.Warmwasser),
                'Warmwasser: Wärmeerzeugung heute',
                'kWh',
                'value.energy',
            );
            this.put('Tageswerte.Heizen.COP_heute', this._cop(c.hv.Heizen, d.H), 'Heizen: COP heute', '', 'value');
            this.put(
                'Tageswerte.Warmwasser.COP_heute',
                this._cop(c.hv.Warmwasser, d.W),
                'Warmwasser: COP heute',
                '',
                'value',
            );
        }
    }

    /**
     * Verdichterstarts und -laufzeit je Tag.
     *
     * @param {number} now - Zeitpunkt (ms)
     */
    _compressor(now) {
        const c = this.c;
        const today = ymd(new Date(now));
        const pfad = m => `Verdichter.${m === 'Gesamt' ? '' : `${m}.`}`;
        const txt = m => (m === 'Gesamt' ? '' : `${m}: `);
        const jeStart = m => (c.vs[m] > 0 ? Math.round(((c.vl[m] * 60) / c.vs[m]) * 10) / 10 : 0);
        if (c.vDatum !== today) {
            if (c.vDatum) {
                VMODI.forEach(m => {
                    this.put(`${pfad(m)}Starts_gestern`, c.vs[m], `${txt(m)}Verdichterstarts gestern`, '', 'value');
                    this.put(
                        `${pfad(m)}Laufzeit_h_gestern`,
                        r2(c.vl[m]),
                        `${txt(m)}Verdichterlaufzeit gestern`,
                        'h',
                        'value',
                    );
                    if (c.vs[m] > 0) {
                        this.put(
                            `${pfad(m)}Laufzeit_je_Start_min_gestern`,
                            jeStart(m),
                            `${txt(m)}Mittlere Laufzeit je Start gestern`,
                            'min',
                            'value',
                        );
                    }
                });
                this.event('verdichter_tag', { datum: c.vDatum, starts: c.vs, laufzeit_h: c.vl });
            }
            c.vs = { Gesamt: 0, Heizen: 0, Warmwasser: 0 };
            c.vl = { Gesamt: 0, Heizen: 0, Warmwasser: 0 };
            c.vDatum = today;
            this.put('Verdichter.Intern.Datum', today, 'Verdichter: Datum der heute-Werte', '', 'text');
        }
        VMODI.forEach(m => {
            this.put(`${pfad(m)}Starts_heute`, c.vs[m], `${txt(m)}Verdichterstarts heute`, '', 'value');
            this.put(`${pfad(m)}Laufzeit_h_heute`, r2(c.vl[m]), `${txt(m)}Verdichterlaufzeit heute`, 'h', 'value');
            this.put(
                `${pfad(m)}Laufzeit_je_Start_min_heute`,
                jeStart(m),
                `${txt(m)}Mittlere Laufzeit je Start heute`,
                'min',
                'value',
            );
        });
    }

    /**
     * Heizstab: geschaetzter Strom und Laufzeit je Tag.
     *
     * @param {number} now - Zeitpunkt (ms)
     */
    _heater(now) {
        const c = this.c;
        const today = ymd(new Date(now));
        if (c.hsDatum !== today) {
            if (c.hsDatum) {
                this.put(
                    'Heizstab.Strom_gestern',
                    r2(c.hs.kwh),
                    'Heizstab: Stromverbrauch gestern (Schätzung aus konfigurierter Leistung)',
                    'kWh',
                    'value.energy',
                );
                this.put('Heizstab.Laufzeit_h_gestern', r2(c.hs.h), 'Heizstab: Laufzeit gestern', 'h', 'value');
                this.event('heizstab_tag', { datum: c.hsDatum, kwh: r3(c.hs.kwh), h: r3(c.hs.h) });
            }
            c.hs = { kwh: 0, h: 0 };
            c.hsDatum = today;
            this.put('Heizstab.Intern.Datum', today, 'Heizstab: Datum der heute-Werte', '', 'text');
        }
        this.put(
            'Heizstab.Strom_heute',
            r2(c.hs.kwh),
            'Heizstab: Stromverbrauch heute (Schätzung aus konfigurierter Leistung)',
            'kWh',
            'value.energy',
        );
        this.put('Heizstab.Laufzeit_h_heute', r2(c.hs.h), 'Heizstab: Laufzeit heute', 'h', 'value');
    }
}

module.exports = { Statistics, GROUPS };
