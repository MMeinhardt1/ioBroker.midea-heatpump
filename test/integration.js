'use strict';

const path = require('node:path');
const assert = require('node:assert');
const { tests } = require('@iobroker/testing');
const { startSimulator } = require('./simulator');

const PORT = 15021;
const REGS = {
    0: 6,
    1: 3,
    4: 50,
    5: 4096 + 16,
    7: 0,
    11: 37,
    15: 1,
    16: 1,
    18: 4,
    20: 0,
    100: 45,
    101: 3,
    104: 30,
    105: 35,
    107: 65531,
    108: 60,
    109: 2,
    110: 36,
    115: 48,
    116: 2600,
    117: 700,
    122: 812,
    123: 8,
    129: 8,
    130: 12,
    136: 36,
    138: 134,
    143: 0,
    144: 50000,
    145: 1,
    146: 20000,
    148: 520,
    150: 130,
    151: 400,
    158: 1,
    159: 0,
    162: 0,
    163: 40000,
    172: 0,
    173: 30000,
    176: 0,
    177: 10000,
    187: 41,
    198: 16 + 256 + 512 + 1024,
    203: 0x3c37,
    204: 0x1919,
    210: 42177,
    212: 5,
    213: 10,
    215: 46,
    216: 65526,
    220: 65,
    221: 210,
    222: 15,
    229: 5,
    230: 2,
    231: 25,
    232: 65521,
    233: 65531,
    234: 5,
    235: 30,
    241: 90,
    242: 30,
    250: 30,
    251: 30,
    252: 0,
    265: 45,
    266: 30,
    267: 65526,
    268: 15,
    269: 1,
    272: 2,
};
// 241 ist im Modell nicht als ungueltig bekannt -> der Adapter soll es lernen
const INVALID = new Set([200, 214, 223, 228, 236, 239, 241]);

tests.integration(path.join(__dirname, '..'), {
    allowedExitCodes: [11],
    defineAdditionalTests({ suite }) {
        suite('Abfrage gegen Simulator (RTU ueber TCP)', getHarness => {
            let sim;
            let n = 0;
            before(async () => {
                sim = await startSimulator({
                    port: PORT,
                    registers: { ...REGS },
                    invalid: INVALID,
                    drop: req => req.fc === 3 && ++n % 25 === 0, // jede 25. Leseanfrage bleibt unbeantwortet
                });
            });
            after(() => sim && sim.server.close());

            it('liest Register, legt Datenpunkte an, schreibt mit Pruefung', async function () {
                this.timeout(90_000);
                const harness = getHarness();
                await harness.changeAdapterConfig('midea-heatpump', {
                    native: {
                        model: 'midea-mhc-v8wd2rn7',
                        connectionType: 'tcprtu',
                        host: ' 127.0.0.1, ', // typo on purpose: must be cleaned up by the adapter
                        port: PORT,
                        unitId: 1,
                        pollInterval: 5,
                        settingsInterval: 60,
                        timeout: 500,
                        requestDelay: 20,
                        retries: 1,
                        maxGap: 0,
                        logRawValues: true,
                        maxBlock: 60,
                        createRawStates: true,
                        allowWrite: true,
                    },
                });
                await harness.startAdapterAndWait();
                await new Promise(r => setTimeout(r, 12_000));
                const ns = 'midea-heatpump.0.';
                const get = async id => {
                    const s = await harness.states.getStateAsync(ns + id);
                    return s ? s.val : undefined;
                };
                assert.strictEqual(await get('info.connection'), true, 'verbunden');
                assert.ok((await get('info.responseMsMax')) >= 0, 'response time state');
                assert.strictEqual(await get('Temperaturen.Aussen'), -5);
                assert.strictEqual(await get('Temperaturen.Vorlauf'), 36);
                assert.strictEqual(await get('Temperaturen.Spreizung'), 6);
                assert.strictEqual(await get('Betrieb.Durchfluss'), 1.34);
                assert.strictEqual(await get('Status.Heizbetrieb'), true);
                assert.strictEqual(await get('Status.Betrieb_Text'), 'Heizen');
                assert.strictEqual(await get('Einstellungen.Vorlauf_Heizen_max'), 55);
                assert.strictEqual(await get('Einstellungen.Service.WW_Prioritaet'), true);
                assert.strictEqual(await get('Einstellungen.Heizflaeche_Zone1'), 'RAD (Heizkörper)');
                assert.strictEqual(await get('Heizstab.IBH1_Leistung_konfiguriert'), 3000);
                assert.strictEqual(await get('Temperaturen.Vorlauf_Soll'), 36);
                assert.strictEqual(await get('Temperaturen.Vorlauf_Soll_Quelle'), 'Heizkurve (Reg. 136)');
                assert.strictEqual(
                    await get('Register.101_Operating_mode'),
                    3,
                    'Rohwert fuer nicht zugeordnetes Register',
                );
                assert.strictEqual(await get('Tageswerte.WP intern.Strom_heute'), 0);
                assert.deepStrictEqual(
                    JSON.parse(String(await get('info.invalidAddresses'))),
                    [241],
                    'ungueltige Adresse gelernt',
                );
                // keine Doppelungen: zugeordnete Register haben keinen Rohwert-Datenpunkt
                const raw = await harness.objects.getObjectAsync(`${ns}Register.107_T4`);
                assert.strictEqual(raw, null);
                const tOut = await get('info.timeouts');
                const retriesOk = await get('info.retriesOk');
                assert.ok(
                    tOut > 0 && retriesOk > 0,
                    `ausgelassene Antworten wiederholt (timeouts ${tOut}, ok ${retriesOk})`,
                );

                // Schreiben innerhalb der Grenzen
                await harness.states.setStateAsync(`${ns}Temperaturen.Warmwasser_Soll`, { val: 52, ack: false });
                await new Promise(r => setTimeout(r, 2_000));
                assert.strictEqual(sim.registers[4], 52, 'Register 4 geschrieben');
                assert.strictEqual(await get('Temperaturen.Warmwasser_Soll'), 52);
                // ausserhalb der Grenzen (Reg. 203/204: 25..55) -> abgelehnt
                await harness.states.setStateAsync(`${ns}Steuerung.Vorlauf_Soll_Zone1`, { val: 70, ack: false });
                await new Promise(r => setTimeout(r, 2_000));
                assert.strictEqual(sim.registers[11], 37, 'Register 11 unveraendert');
                // Bit schreiben (Leisemodus = Reg. 5 Bit 6), andere Bits bleiben erhalten
                await harness.states.setStateAsync(`${ns}Funktion.Leisemodus`, { val: true, ack: false });
                await new Promise(r => setTimeout(r, 2_000));
                assert.strictEqual(sim.registers[5], 4096 + 16 + 64, 'Bit 6 gesetzt, Rest unveraendert');
                assert.strictEqual(await get('Funktion.Leisemodus'), true);
            });
        });
    },
});
