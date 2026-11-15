'use strict';

/*
 * ioBroker.midea-heatpump
 * Midea-Luft-Wasser-Waermepumpen ueber Modbus (RTU ueber TCP, Modbus TCP oder RS-485).
 */

const utils = require('@iobroker/adapter-core');
const ModbusConnection = require('./lib/modbus');
const { buildBlocks, decode, encode } = require('./lib/decoder');
const { getModel } = require('./lib/models');
const { Statistics } = require('./lib/statistics');

const STAT_TICK_MS = 30_000;
const FAST_POLL_REPEAT_MS = 5 * 60_000;
const RECONNECT_AFTER_FAILURES = 3;

class MideaHeatpump extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter-Optionen
     */
    constructor(options) {
        super({ ...options, name: 'midea-heatpump' });
        /** @type {ModbusConnection | null} */
        this.modbus = null;
        /** @type {import('./lib/models/types').ModelDef | undefined} */
        this.model = undefined;
        /** @type {Statistics | null} */
        this.stats = null;
        this._stopped = false;
        this._pollTimer = null;
        this._tickTimer = null;
        this._lastSettingsRead = 0;
        this._firstCycleDone = false;
        /** @type {Set<number>} */
        this._invalid = new Set();
        /** @type {import('./lib/models/types').RegisterDef[]} */
        this._registers = [];
        /** zuletzt geschriebene Werte je Datenpunkt (nur bei Aenderung schreiben) */
        this._last = new Map();
        /** angelegte Objekte (relative ID -> Promise) */
        this._objects = new Map();
        /** zuletzt angezeigte Werte je Register (nach transform) */
        this._values = {};
        /** beschreibbare Datenpunkte: relative ID -> Ziel */
        this._writable = new Map();
        this._fast = { on: undefined, sentAt: 0, followUpUntil: 0 };
        this._modelChecked = false;
        /** @type {Record<string, boolean>} */
        this._features = {};

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // =====================================================================================
    // Start
    // =====================================================================================

    /**
     * Adapter gestartet.
     */
    async onReady() {
        const cfg = this.config;
        await this.setStateAsync('info.connection', { val: false, ack: true });

        this.model = getModel(cfg.model);
        if (!this.model) {
            this.log.error(`Unbekanntes Modell "${cfg.model}" – bitte in der Instanz-Konfiguration ein Modell wählen`);
            return;
        }
        if (cfg.connectionType !== 'serial' && !cfg.host) {
            this.log.error('Keine IP-Adresse konfiguriert');
            return;
        }
        this.log.info(`Modell: ${this.model.label}`);

        this._features = {
            ibh: this.model.features.ibhStages > 0,
            tbh: this.model.features.tbh && !!cfg.hasTbh,
            zone2: this.model.features.zone2 && !!cfg.hasZone2,
            cooling: this.model.features.cooling,
        };
        this._registers = this.model.registers.filter(r => {
            const m = this.model.mapping[r.addr];
            return !(m && m.feature && !this._features[m.feature]);
        });
        this.model.invalidAddresses.forEach(a => this._invalid.add(a));
        await this._loadLearnedInvalid();

        await this._createObjects();

        this.stats = new Statistics(
            {
                minKwhCop: Number(cfg.minKwhCop) || 0.2,
                heatMeter: !!cfg.heatMeterStateId,
                diMargin: Number(cfg.diMargin) || 2,
                diWeekday: Number(cfg.diWeekday) >= 0 ? Number(cfg.diWeekday) : null,
                diTime: cfg.diTime || '',
                diWindowMin: Number(cfg.diWindowMin) || 30,
            },
            (rel, val, name, unit, role) => this._put(rel, val, { name, unit, role }),
            (type, data) => this.log.debug(`[statistik] ${type} ${JSON.stringify(data)}`),
        );
        await this._restoreStatistics();
        await this._subscribeMeters();
        this.subscribeStates('*');

        this.modbus = new ModbusConnection(
            {
                connectionType: cfg.connectionType || 'tcprtu',
                host: cfg.host,
                port: Number(cfg.port) || 502,
                serialPort: cfg.serialPort,
                baudRate: Number(cfg.baudRate) || 9600,
                parity: cfg.parity || 'none',
                stopBits: Number(cfg.stopBits) || 1,
                unitId: Number(cfg.unitId) || 1,
                timeout: Number(cfg.timeout) || 3000,
                requestDelay: Math.max(0, Number(cfg.requestDelay) || 0),
                retries: Math.max(0, Math.min(3, Number(cfg.retries ?? 1))),
            },
            this,
        );

        this._tickTimer = this.setInterval(() => this._tick(), STAT_TICK_MS);
        await this._connectAndPoll();
    }

    /**
     * Zur Laufzeit gelernte ungueltige Adressen laden.
     */
    async _loadLearnedInvalid() {
        const st = await this.getStateAsync('info.invalidAddresses');
        if (st && typeof st.val === 'string' && st.val) {
            try {
                const arr = JSON.parse(st.val);
                if (Array.isArray(arr)) {
                    arr.forEach(a => this._invalid.add(Number(a)));
                }
            } catch {
                // ignorieren
            }
        }
    }

    // =====================================================================================
    // Objekte
    // =====================================================================================

    /**
     * Datenpunkte fuer alle Register des Modells anlegen.
     */
    async _createObjects() {
        const m = this.model;
        const allowWrite = !!this.config.allowWrite;
        const existing = new Set();
        for (const reg of this._registers) {
            const map = m.mapping[reg.addr];
            if (map && map.stat && !map.state && !map.bits) {
                continue; // nur intern fuer die Statistik
            }
            if (map && map.bits) {
                for (const [bit, id, name, writable, feature] of map.bits) {
                    if (feature && !this._features[feature]) {
                        continue;
                    }
                    const w = allowWrite && !!writable;
                    await this._ensureObject(id, {
                        name,
                        type: 'boolean',
                        role: w ? 'switch' : 'indicator',
                        read: true,
                        write: w,
                    });
                    existing.add(id);
                    if (w) {
                        this._writable.set(id, { reg, bit });
                    }
                }
                continue;
            }
            if (map && map.state) {
                const w = allowWrite && !!map.write;
                const sample = map.transform ? map.transform(0, 0) : 0;
                /** @type {Partial<ioBroker.StateCommon>} */
                const common = {
                    name: map.name || reg.desc,
                    type: map.bool ? 'boolean' : typeof sample === 'string' ? 'string' : 'number',
                    role: map.role || 'value',
                    unit: map.unit ?? reg.unit ?? undefined,
                    read: true,
                    write: w,
                };
                if (map.states) {
                    common.states = map.states;
                }
                if (w && !map.bool && map.write.min !== undefined) {
                    common.min = map.write.min;
                }
                if (w && !map.bool && map.write.max !== undefined) {
                    common.max = map.write.max;
                }
                await this._ensureObject(map.state, common, { register: reg.addr });
                existing.add(map.state);
                if (w) {
                    this._writable.set(map.state, { reg, map });
                }
                continue;
            }
            if (this.config.createRawStates !== false) {
                const id = this._rawId(reg);
                await this._ensureObject(
                    id,
                    {
                        name: reg.desc,
                        type: 'number',
                        role: 'value',
                        unit: reg.unit || undefined,
                        read: true,
                        write: false,
                    },
                    { register: reg.addr },
                );
                existing.add(id);
            }
        }
        const info = [
            ['info.model', 'Gewähltes Modell', 'string', 'info.name'],
            ['info.requests', 'Modbus-Anfragen seit Start', 'number', 'value'],
            ['info.timeouts', 'Ausgebliebene Antworten seit Start', 'number', 'value'],
            ['info.retriesOk', 'Davon im zweiten Versuch beantwortet', 'number', 'value'],
            ['info.failures', 'Anfragen ohne Antwort (auch nach Wiederholung)', 'number', 'value'],
            ['info.lastTimeout', 'Zeitpunkt der letzten ausgebliebenen Antwort', 'number', 'date'],
            ['info.cycleMs', 'Dauer des letzten Abfragezyklus', 'number', 'value'],
            ['info.invalidAddresses', 'Zur Laufzeit gelernte ungültige Registeradressen (JSON)', 'string', 'json'],
        ];
        for (const [id, name, type, role] of info) {
            await this._ensureObject(id, {
                name,
                type: /** @type {ioBroker.CommonType} */ (type),
                role,
                read: true,
                write: false,
                unit: id === 'info.cycleMs' ? 'ms' : undefined,
            });
        }
        await this.setStateAsync('info.model', { val: m.label, ack: true });
    }

    /**
     * Datenpunkt-ID fuer den Rohwert eines Registers.
     *
     * @param {import('./lib/models/types').RegisterDef} reg - Register
     * @returns {string} relative ID
     */
    _rawId(reg) {
        return `Register.${String(reg.addr).padStart(3, '0')}_${reg.key}`;
    }

    /**
     * Objekt (und fehlende Ordner darueber) anlegen bzw. aktualisieren – je ID nur einmal pro Start.
     *
     * @param {string} id - relative ID
     * @param {Partial<ioBroker.StateCommon>} common - common
     * @param {object} [native] - native
     * @returns {Promise<void>}
     */
    _ensureObject(id, common, native) {
        let p = this._objects.get(id);
        if (!p) {
            p = (async () => {
                const parts = id.split('.');
                for (let i = 1; i < parts.length; i++) {
                    const fid = parts.slice(0, i).join('.');
                    if (fid === 'info' || this._objects.has(`#${fid}`)) {
                        continue;
                    }
                    this._objects.set(`#${fid}`, Promise.resolve());
                    await this.setObjectNotExistsAsync(fid, {
                        type: 'folder',
                        common: { name: parts[i - 1] },
                        native: {},
                    });
                }
                const c = { ...common };
                if (c.unit === undefined || c.unit === '') {
                    delete c.unit;
                }
                await this.extendObjectAsync(id, {
                    type: 'state',
                    common: /** @type {ioBroker.StateCommon} */ (c),
                    native: native || {},
                });
            })();
            this._objects.set(id, p);
        }
        return p;
    }

    /**
     * Wert eines berechneten Datenpunkts schreiben (Objekt wird bei Bedarf angelegt), nur bei Aenderung.
     *
     * @param {string} rel - relative ID
     * @param {ioBroker.StateValue} val - Wert
     * @param {{ name: string, unit?: string, role?: string }} meta - Beschreibung
     */
    _put(rel, val, meta) {
        if (val === undefined || (typeof val === 'number' && !isFinite(val))) {
            return;
        }
        if (this._last.get(rel) === val) {
            return;
        }
        this._last.set(rel, val);
        const type = typeof val === 'boolean' ? 'boolean' : typeof val === 'number' ? 'number' : 'string';
        const role = meta.role || (type === 'boolean' ? 'indicator' : type === 'number' ? 'value' : 'text');
        this._ensureObject(rel, { name: meta.name, type, role, unit: meta.unit || undefined, read: true, write: false })
            .then(() => this.setStateAsync(rel, { val, ack: true }))
            .catch(e => this.log.warn(`Datenpunkt ${rel}: ${e.message}`));
    }

    /**
     * Wert eines Register-Datenpunkts schreiben (Objekt existiert bereits), nur bei Aenderung.
     *
     * @param {string} rel - relative ID
     * @param {ioBroker.StateValue} val - Wert
     * @param {boolean} [force] - auch ohne Aenderung schreiben (Bestaetigung nach Schreibbefehl)
     */
    _set(rel, val, force) {
        if (!force && this._last.get(rel) === val) {
            return;
        }
        this._last.set(rel, val);
        this.setStateAsync(rel, { val, ack: true }).catch(e => this.log.warn(`Datenpunkt ${rel}: ${e.message}`));
    }

    // =====================================================================================
    // Statistik: Wiederherstellen, Fremd-Datenpunkte
    // =====================================================================================

    /**
     * Tageswerte aus den eigenen Datenpunkten wiederherstellen.
     */
    async _restoreStatistics() {
        try {
            const states = await this.getStatesAsync('*');
            const rel = {};
            const prefix = `${this.namespace}.`;
            for (const [id, st] of Object.entries(states || {})) {
                if (st) {
                    rel[id.slice(prefix.length)] = st.val;
                }
            }
            this.stats.restore(rel);
        } catch (e) {
            this.log.warn(`Tageswerte konnten nicht wiederhergestellt werden: ${e.message}`);
        }
    }

    /**
     * Zaehler-Datenpunkte abonnieren und Startwerte lesen.
     */
    async _subscribeMeters() {
        const cfg = this.config;
        for (const id of [cfg.meterStateId, cfg.heatMeterStateId, cfg.heatPowerStateId]) {
            if (!id) {
                continue;
            }
            const obj = await this.getForeignObjectAsync(id);
            if (!obj) {
                this.log.warn(`Datenpunkt ${id} existiert nicht – bitte Konfiguration prüfen`);
                continue;
            }
            this.subscribeForeignStates(id);
            const st = await this.getForeignStateAsync(id);
            if (st) {
                this._onMeterState(id, st);
            }
        }
    }

    /**
     * @param {string} id - Fremd-Datenpunkt
     * @param {ioBroker.State} state - Wert
     */
    _onMeterState(id, state) {
        const v = Number(state.val);
        if (state.val === null || state.val === '' || !isFinite(v)) {
            return;
        }
        const cfg = this.config;
        if (id === cfg.meterStateId) {
            this.stats.onMeter(v * (Number(cfg.meterFactor) || 1));
        } else if (id === cfg.heatMeterStateId) {
            this.stats.onHeatMeter(v * (Number(cfg.heatMeterFactor) || 1));
        } else if (id === cfg.heatPowerStateId) {
            this.stats.onHeatPower(v);
        }
    }

    // =====================================================================================
    // Verbindung und Abfrage
    // =====================================================================================

    /**
     * Verbinden und Abfrage starten (bei Fehler erneut nach 30 s).
     */
    async _connectAndPoll() {
        if (this._stopped) {
            return;
        }
        const ok = await this.modbus.connect();
        if (this._stopped) {
            return;
        }
        await this.setStateAsync('info.connection', { val: ok, ack: true });
        if (ok) {
            this.log.info(
                `Verbunden mit ${this.config.connectionType === 'serial' ? this.config.serialPort : `${this.config.host}:${this.config.port}`}`,
            );
            this._poll();
        } else {
            this._pollTimer = this.setTimeout(() => this._connectAndPoll(), 30_000);
        }
    }

    /**
     * Naechsten Zyklus planen.
     *
     * @param {number} ms - Wartezeit
     */
    _scheduleNext(ms) {
        if (this._stopped) {
            return;
        }
        if (this._pollTimer) {
            this.clearTimeout(this._pollTimer);
        }
        this._pollTimer = this.setTimeout(() => this._poll(), ms);
    }

    /**
     * Ein Abfragezyklus.
     */
    async _poll() {
        if (this._stopped) {
            return;
        }
        const pollMs = Math.max(5, Number(this.config.pollInterval) || 10) * 1000;
        const settingsMs = Math.max(60, Number(this.config.settingsInterval) || 300) * 1000;
        const t0 = Date.now();
        const withSettings = t0 - this._lastSettingsRead >= settingsMs;
        const regs = this._registers.filter(r => r.group === 'live' || withSettings);
        const blocks = buildBlocks(regs, {
            maxGap: Math.max(0, Number(this.config.maxGap) || 0),
            maxQty: Math.max(1, Math.min(120, Number(this.config.maxBlock) || 60)),
            invalid: this._invalid,
        });
        let complete = true;
        for (const b of blocks) {
            if (this._stopped) {
                return;
            }
            const ok = await this._readBlock(b);
            if (!ok) {
                complete = false;
            }
            if (!this.modbus.connected || this.modbus.stats.consecutiveFailures >= RECONNECT_AFTER_FAILURES) {
                break;
            }
        }
        if (withSettings && complete) {
            this._lastSettingsRead = t0;
        }
        await this._afterCycle(Date.now() - t0, complete);

        if (!this.modbus.connected || this.modbus.stats.consecutiveFailures >= RECONNECT_AFTER_FAILURES) {
            this.log.warn(
                `Wärmepumpe antwortet nicht (${this.modbus.stats.consecutiveFailures} Anfragen ohne Antwort) – verbinde neu`,
            );
            await this.setStateAsync('info.connection', { val: false, ack: true });
            await this.modbus.disconnect();
            this._pollTimer = this.setTimeout(() => this._connectAndPoll(), 5_000);
            return;
        }
        this._scheduleNext(Math.max(500, pollMs - (Date.now() - t0)));
    }

    /**
     * Einen Block lesen. Lehnt das Geraet ihn als ungueltig ab, werden seine Register einzeln gelesen
     * und die abgelehnten Adressen gemerkt.
     *
     * @param {{ start: number, qty: number, regs: import('./lib/models/types').RegisterDef[] }} b - Block
     * @returns {Promise<boolean>} true, wenn alle Register gelesen wurden
     */
    async _readBlock(b) {
        try {
            const data = await this.modbus.readHolding(b.start, b.qty);
            for (const reg of b.regs) {
                const d = decode(reg, data, b.start);
                if (d) {
                    this._handleValue(reg, d.raw, d.value);
                }
            }
            return true;
        } catch (err) {
            if (err.kind === 'illegal' && b.regs.length > 1) {
                this.log.info(
                    `Block ${b.start}-${b.start + b.qty - 1} abgelehnt (Illegal Data Address) – lese einzeln`,
                );
                let all = true;
                for (const reg of b.regs) {
                    const n = reg.type === 'U32' || reg.type === 'S32' ? 2 : 1;
                    const ok = await this._readBlock({ start: reg.addr, qty: n, regs: [reg] });
                    all = all && ok;
                }
                return all;
            }
            if (err.kind === 'illegal') {
                const addr = b.regs[0].addr;
                this._invalid.add(addr);
                this.log.warn(
                    `Register ${addr} (${b.regs[0].key}) wird vom Gerät abgelehnt und künftig nicht mehr gelesen`,
                );
                await this._saveLearnedInvalid();
                return false;
            }
            if (err.kind === 'timeout') {
                this.log.debug(`Block ${b.start}-${b.start + b.qty - 1}: keine Antwort`);
            } else {
                this.log.warn(`Block ${b.start}-${b.start + b.qty - 1}: ${err.message}`);
            }
            return false;
        }
    }

    /**
     * Gelernte ungueltige Adressen speichern.
     */
    async _saveLearnedInvalid() {
        const learned = [...this._invalid].filter(a => !this.model.invalidAddresses.includes(a)).sort((x, y) => x - y);
        await this.setStateAsync('info.invalidAddresses', { val: JSON.stringify(learned), ack: true });
    }

    /**
     * Gelesenen Registerwert verteilen: Statistik, sprechende Datenpunkte, Rohwert.
     *
     * @param {import('./lib/models/types').RegisterDef} reg - Register
     * @param {number} raw - Rohwert
     * @param {number} value - skalierter Wert
     * @param {boolean} [force] - auch ohne Aenderung schreiben
     */
    _handleValue(reg, raw, value, force) {
        this.stats.onRegister(reg.addr, value, raw);
        const map = this.model.mapping[reg.addr];
        if (map && map.bits) {
            for (const [bit, id, , , feature] of map.bits) {
                if (!feature || this._features[feature]) {
                    this._set(id, ((raw >> bit) & 1) === 1, force);
                }
            }
            this._values[reg.addr] = raw;
            return;
        }
        if (map && map.state) {
            if (map.invalid && map.invalid.includes(raw)) {
                return;
            }
            const val = map.transform ? map.transform(value, raw) : map.bool ? value !== 0 : value;
            this._values[reg.addr] = val;
            this._set(map.state, val, force);
            return;
        }
        this._values[reg.addr] = value;
        if (!map && this.config.createRawStates !== false) {
            this._set(this._rawId(reg), value, force);
        }
    }

    /**
     * Nach jedem Zyklus: Statistik und Diagnose.
     *
     * @param {number} cycleMs - Dauer
     * @param {boolean} complete - alle Bloecke gelesen
     */
    async _afterCycle(cycleMs, complete) {
        if (!this._firstCycleDone && complete) {
            this._firstCycleDone = true;
            this.stats.setReady();
            this._checkModel();
        }
        this.stats.update();
        const s = this.modbus.stats;
        this._set('info.requests', s.requests);
        this._set('info.timeouts', s.timeouts);
        this._set('info.retriesOk', s.retriesOk);
        this._set('info.failures', s.failures);
        if (s.lastTimeout) {
            this._set('info.lastTimeout', s.lastTimeout);
        }
        this._set('info.cycleMs', cycleMs);
        this._fastPoll();
    }

    /**
     * Plausibilitaet des gewaehlten Modells pruefen.
     */
    _checkModel() {
        if (this._modelChecked || !this.model.expect) {
            return;
        }
        this._modelChecked = true;
        for (const [addr, expected] of Object.entries(this.model.expect)) {
            const got = this.stats.raw[addr];
            if (got !== undefined && got !== expected) {
                this.log.warn(
                    `Register ${addr} meldet ${got}, für ${this.model.label} erwartet: ${expected} – ist das richtige Modell gewählt?`,
                );
            }
        }
    }

    /**
     * 30-s-Takt: Statistik aktualisieren.
     */
    _tick() {
        if (this.stats) {
            this.stats.update();
            this._fastPoll();
        }
    }

    // Schnellabfrage des Waermemengenzaehlers anfordern, solange die WP heizt oder Warmwasser macht (+ Nachlauf)
    _fastPoll() {
        const id = this.config.fastPollStateId;
        if (!id || !this.stats || !this.stats.mode) {
            return;
        }
        const now = Date.now();
        const f = this._fast;
        const running = this.stats.mode === 'Heizen' || this.stats.mode === 'Warmwasser';
        let want = f.on;
        if (running) {
            want = true;
            f.followUpUntil = 0;
        } else if (f.on === undefined) {
            want = false;
        } else if (f.on === true) {
            if (!f.followUpUntil) {
                f.followUpUntil = now + Math.max(0, Number(this.config.fastPollFollowUpMin) || 0) * 60_000;
            }
            if (now >= f.followUpUntil) {
                want = false;
                f.followUpUntil = 0;
            }
        }
        if (want !== f.on || now - f.sentAt >= FAST_POLL_REPEAT_MS) {
            f.on = want;
            f.sentAt = now;
            this.setForeignStateAsync(id, { val: want, ack: false }).catch(e =>
                this.log.warn(`Schnellabfrage ${id}: ${e.message}`),
            );
        }
    }

    // =====================================================================================
    // Schreiben
    // =====================================================================================

    /**
     * @param {string} id - Datenpunkt
     * @param {ioBroker.State | null | undefined} state - Wert
     */
    async onStateChange(id, state) {
        if (!state) {
            return;
        }
        if (!id.startsWith(`${this.namespace}.`)) {
            if (this.stats) {
                this._onMeterState(id, state);
            }
            return;
        }
        if (state.ack) {
            return;
        }
        const rel = id.slice(this.namespace.length + 1);
        const target = this._writable.get(rel);
        if (!target) {
            return;
        }
        try {
            await this._write(rel, target, state.val);
        } catch (e) {
            this.log.error(`Schreiben ${rel} fehlgeschlagen: ${e.message}`);
            await this._reread(target.reg, true);
        }
    }

    /**
     * @param {string} rel - Datenpunkt
     * @param {{ reg: import('./lib/models/types').RegisterDef, bit?: number, map?: import('./lib/models/types').MappingDef }} t - Ziel
     * @param {ioBroker.StateValue} val - Wert
     */
    async _write(rel, t, val) {
        if (!this.modbus || !this.modbus.connected) {
            throw new Error('keine Verbindung zur Wärmepumpe');
        }
        const reg = t.reg;
        let raw;
        if (t.bit !== undefined) {
            // Bitfeld: aktuellen Wert frisch lesen, ein Bit aendern, zurueckschreiben
            const cur = (await this.modbus.readHolding(reg.addr, 1))[0];
            const on = val === true || val === 1 || val === 'true';
            raw = on ? cur | (1 << t.bit) : cur & ~(1 << t.bit);
            if (raw === cur) {
                await this._reread(reg, true);
                return;
            }
        } else {
            const w = t.map.write;
            let num = typeof val === 'boolean' ? (val ? 1 : 0) : Number(val);
            if (!isFinite(num)) {
                throw new Error(`ungültiger Wert ${val}`);
            }
            num = Math.round(num * 100) / 100;
            const min = w.minFrom !== undefined ? this._values[w.minFrom] : w.min;
            const max = w.maxFrom !== undefined ? this._values[w.maxFrom] : w.max;
            if ((typeof min === 'number' && num < min) || (typeof max === 'number' && num > max)) {
                throw new Error(`Wert ${num} außerhalb ${min ?? '–'} … ${max ?? '–'}`);
            }
            raw = encode(reg, num);
        }
        this.log.info(`Schreibe ${rel} = ${val} (Register ${reg.addr}, Rohwert ${raw})`);
        await this.modbus.writeRegister(reg.addr, raw);
        await this._reread(reg, true);
    }

    /**
     * Ein Register erneut lesen und Datenpunkte bestaetigen.
     *
     * @param {import('./lib/models/types').RegisterDef} reg - Register
     * @param {boolean} force - auch ohne Aenderung schreiben
     */
    async _reread(reg, force) {
        try {
            const n = reg.type === 'U32' || reg.type === 'S32' ? 2 : 1;
            const data = await this.modbus.readHolding(reg.addr, n);
            const d = decode(reg, data, reg.addr);
            if (d) {
                this._handleValue(reg, d.raw, d.value, force);
                this.stats.update();
            }
        } catch (e) {
            this.log.warn(`Register ${reg.addr} konnte nach dem Schreiben nicht gelesen werden: ${e.message}`);
        }
    }

    // =====================================================================================
    // Ende
    // =====================================================================================

    /**
     * @param {() => void} callback - Rueckruf
     */
    async onUnload(callback) {
        this._stopped = true;
        try {
            if (this._pollTimer) {
                this.clearTimeout(this._pollTimer);
            }
            if (this._tickTimer) {
                this.clearInterval(this._tickTimer);
            }
            if (this.stats) {
                this.stats.update();
            }
            if (this.modbus) {
                await this.modbus.disconnect();
            }
            await this.setStateAsync('info.connection', { val: false, ack: true });
        } catch {
            // ignorieren
        }
        callback();
    }
}

if (require.main !== module) {
    module.exports = options => new MideaHeatpump(options);
} else {
    new MideaHeatpump();
}
