'use strict';

const assert = require('node:assert');
const { buildBlocks, decode, encode } = require('../lib/decoder');
const { Statistics } = require('../lib/statistics');
const { MODELS, getModel, extendModel } = require('../lib/models');

describe('Modelle', () => {
    it('jedes Modell hat eindeutige Registeradressen und gueltige Zuordnungen', () => {
        for (const m of MODELS) {
            const addrs = m.registers.map(r => r.addr);
            assert.strictEqual(new Set(addrs).size, addrs.length, `${m.id}: doppelte Adressen`);
            for (const a of Object.keys(m.mapping)) {
                assert.ok(addrs.includes(Number(a)), `${m.id}: Zuordnung fuer unbekanntes Register ${a}`);
            }
            const states = [];
            for (const map of Object.values(m.mapping)) {
                if (map.state) {
                    states.push(map.state);
                }
                (map.bits || []).forEach(b => states.push(b[1]));
            }
            assert.strictEqual(new Set(states).size, states.length, `${m.id}: doppelte Datenpunkte`);
        }
    });
    it('extendModel ueberschreibt einzelne Register und Zuordnungen', () => {
        const base = getModel('midea-mhc-v8wd2rn7');
        const m = extendModel(base, { id: 'x', label: 'X', expect: { 123: 12 }, mapping: { 269: null } });
        assert.strictEqual(m.expect[123], 12);
        assert.strictEqual(m.mapping[269], undefined);
        assert.ok(base.mapping[269]);
    });
});

describe('Lesebloecke', () => {
    const r = (addr, type = 'U16') => ({ addr, key: `r${addr}`, type, group: 'live', desc: '' });
    it('fasst zusammenhaengende Register zusammen, auch 32 Bit', () => {
        const b = buildBlocks([r(143, 'U32'), r(145, 'U32'), r(148), r(150)], {
            maxGap: 0,
            maxQty: 60,
            invalid: new Set(),
        });
        assert.deepStrictEqual(
            b.map(x => [x.start, x.qty]),
            [
                [143, 4],
                [148, 1],
                [150, 1],
            ],
        );
    });
    it('ueberbrueckt Luecken nur bis maxGap und nie ueber ungueltige Adressen', () => {
        const regs = [r(210), r(212), r(213), r(215), r(216)];
        assert.deepStrictEqual(
            buildBlocks(regs, { maxGap: 2, maxQty: 60, invalid: new Set() }).map(x => [x.start, x.qty]),
            [[210, 7]],
        );
        assert.deepStrictEqual(
            buildBlocks(regs, { maxGap: 2, maxQty: 60, invalid: new Set([214]) }).map(x => [x.start, x.qty]),
            [
                [210, 4],
                [215, 2],
            ],
        );
    });
    it('dekodiert Vorzeichen, 32 Bit und Faktor', () => {
        assert.strictEqual(decode(r(107, 'S16'), [65531], 107).value, -5);
        assert.strictEqual(decode({ ...r(143, 'U32'), factor: 0.01 }, [1, 34464], 143).value, 1000);
        assert.strictEqual(encode(r(11, 'S16'), -3), 65533);
    });
});

describe('Statistik', () => {
    function make() {
        const out = {};
        const s = new Statistics({ heatMeter: true }, (rel, val) => {
            out[rel] = val;
        });
        return { s, out };
    }
    it('ordnet Stromverbrauch der Betriebsart zu, Standby ist der Rest', () => {
        const { s, out } = make();
        s.onRegister(198, 0, 0);
        s.onMeter(100);
        s.setReady();
        s.update();
        s.onRegister(198, 16, 16); // Heizen
        s.onMeter(101.5);
        s.onRegister(198, 32, 32); // Warmwasser
        s.onMeter(102);
        s.onRegister(198, 0, 0); // Standby
        s.onMeter(102.2);
        s.update();
        assert.strictEqual(out['Stromverbrauch.Heizen_heute'], 1.5);
        assert.strictEqual(out['Stromverbrauch.Warmwasser_heute'], 0.5);
        assert.strictEqual(out['Stromverbrauch.Gesamt_heute'], 2.2);
        assert.strictEqual(out['Stromverbrauch.Standby_heute'], 0.2);
    });
    it('verwirft einen einzelnen kleineren Zaehlerwert (Lesefehler)', () => {
        const { s, out } = make();
        s.onMeter(100);
        s.setReady();
        s.update();
        s.onMeter(0);
        s.update();
        assert.strictEqual(out['Stromverbrauch.Gesamt_heute'], 0);
    });
    it('zaehlt Verdichterstarts und ordnet sie der Betriebsart zu', () => {
        const { s, out } = make();
        s.onRegister(100, 0, 0);
        s.setReady();
        s.update();
        s.onRegister(198, 16, 16);
        s.onRegister(100, 40, 40);
        s.update();
        assert.strictEqual(out['Verdichter.Starts_heute'], 1);
        assert.strictEqual(out['Verdichter.Heizen.Starts_heute'], 1);
        assert.strictEqual(out['Verdichter.laeuft'], true);
    });
    it('erkennt eine Desinfektion an der Speichertemperatur', () => {
        const { s, out } = make();
        s.setReady();
        s.onRegister(4, 50, 50);
        s.onRegister(220, 65, 65);
        s.onRegister(198, 32, 32);
        s.onRegister(115, 51, 51);
        assert.strictEqual(out['Status.Desinfektion_laeuft'], false);
        s.onRegister(115, 66, 66);
        assert.strictEqual(out['Status.Desinfektion_laeuft'], true);
        s.onRegister(198, 0, 0);
        assert.strictEqual(out['Status.Desinfektion_laeuft'], false);
        assert.strictEqual(out['Desinfektion.Letzte_T5_max'], 66);
        assert.strictEqual(out['Desinfektion.Letzte_Ziel_erreicht'], true);
    });
    it('Soll-Vorlauf: Heizkurve (Reg. 136) oder fester Wert (Reg. 11)', () => {
        const { s, out } = make();
        s.onRegister(11, 37, 37);
        s.onRegister(136, 33, 33);
        s.onRegister(5, 4096, 4096);
        s.update();
        assert.strictEqual(out['Temperaturen.Vorlauf_Soll'], 33);
        s.onRegister(5, 0, 0);
        s.update();
        assert.strictEqual(out['Temperaturen.Vorlauf_Soll'], 37);
    });
    it('Heizstab: Leistung aus Stufen und konfigurierter Leistung', () => {
        const { s, out } = make();
        s.onRegister(250, 3000, 30);
        s.onRegister(251, 3000, 30);
        s.onRegister(129, 3, 3);
        assert.strictEqual(out['Heizstab.Leistung_aktuell'], 6000);
        assert.strictEqual(out['Status.Heizstab_laeuft'], true);
    });
    it('Tageswechsel schreibt gestern-Werte und setzt heute zurueck', () => {
        const { s, out } = make();
        const day1 = new Date(2026, 10, 14, 23, 59).getTime();
        const day2 = new Date(2026, 10, 15, 0, 1).getTime();
        s.onMeter(100);
        s.setReady();
        s.update(day1);
        s.onRegister(198, 16, 16);
        s.onMeter(103);
        s.update(day1);
        s.update(day2);
        assert.strictEqual(out['Stromverbrauch.Heizen_gestern'], 3);
        assert.strictEqual(out['Stromverbrauch.Gesamt_heute'], 0);
        assert.strictEqual(out['Stromverbrauch.Intern.Datum'], '2026-11-15');
    });
    it('stellt Tageswerte nach Neustart wieder her', () => {
        const { s, out } = make();
        const today = new Date();
        const pad = n => String(n).padStart(2, '0');
        const d = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
        s.restore({
            'Stromverbrauch.Intern.Datum': d,
            'Stromverbrauch.Intern.Zaehler_Start': 100,
            'Stromverbrauch.Heizen_heute': 2,
            'Stromverbrauch.Warmwasser_heute': 1,
            'Verdichter.Intern.Datum': d,
            'Verdichter.Starts_heute': 4,
        });
        s.onMeter(104);
        s.setReady();
        s.update();
        assert.strictEqual(out['Stromverbrauch.Heizen_heute'], 2);
        assert.strictEqual(out['Stromverbrauch.Gesamt_heute'], 4);
        assert.strictEqual(out['Stromverbrauch.Standby_heute'], 1);
        assert.strictEqual(out['Verdichter.Starts_heute'], 4);
    });
});
