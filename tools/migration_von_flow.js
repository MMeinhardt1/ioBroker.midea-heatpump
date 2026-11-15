// Umzug vom Node-RED-Flow (0_userdata.0.Wärmepumpe.*) auf den Adapter midea-heatpump.0
// Typ: JavaScript (ioBroker-Skript). Voraussetzung: in der javascript-Instanz "Kommando setObject erlauben".
//
// Ablauf:
//  1. Node-RED-Tab "Wärmepumpe" deaktivieren und modbus.1 stoppen (die Bridge erlaubt nur einen Client je Port).
//  2. midea-heatpump-Instanz konfigurieren, aber NOCH NICHT starten (bzw. wieder stoppen).
//  3. Dieses Skript mit DRY_RUN = true starten und das Log prüfen, dann mit DRY_RUN = false erneut starten.
//  4. midea-heatpump.0 starten.
//
// Was das Skript macht:
//  - Für jeden Datenpunkt unter 0_userdata.0.Wärmepumpe wird der gleichnamige Datenpunkt unter midea-heatpump.0
//    angelegt (falls nicht vorhanden), mit gleichem common und gleichem Wert. Damit setzt der Adapter die heutigen
//    Tageswerte, Startzählerstände und Verdichterstarts nahtlos fort.
//  - Die InfluxDB-Einstellungen (inkl. Alias) werden übernommen und beim alten Datenpunkt deaktiviert.
//    Weil der Alias gleich bleibt, laufen die Grafana-Abfragen unverändert weiter und die Historie bleibt durchgehend.
//  - Die alten Datenpunkte werden NICHT gelöscht (dafür später wp_alte_dps_loeschen.js).

const DRY_RUN = true;
const ALT = '0_userdata.0.Wärmepumpe.';
const NEU = 'midea-heatpump.0.';
const INFLUX = 'influxdb.0';

// Datenpunkte, die es im Adapter unter anderem Namen gibt oder nicht mehr gibt
const UMBENENNEN = {
    // alt (relativ): neu (relativ) oder null = nicht übernehmen
};

(async () => {
    const ids = [];
    $(`state[id=${ALT}*]`).each(id => ids.push(id));
    let angelegt = 0;
    let influx = 0;
    let werte = 0;
    let uebersprungen = 0;
    for (const altId of ids) {
        const rel0 = altId.slice(ALT.length);
        const rel = Object.prototype.hasOwnProperty.call(UMBENENNEN, rel0) ? UMBENENNEN[rel0] : rel0;
        if (rel === null) {
            uebersprungen++;
            continue;
        }
        const neuId = NEU + rel;
        const altObj = await getObjectAsync(altId);
        if (!altObj) {
            continue;
        }
        let neuObj = await getObjectAsync(neuId);
        const cust = altObj.common && altObj.common.custom && altObj.common.custom[INFLUX];

        if (!neuObj) {
            const common = JSON.parse(JSON.stringify(altObj.common));
            common.write = false;
            if (DRY_RUN) {
                log(`[DRY] anlegen ${neuId}${cust && cust.enabled ? ` (Influx ${cust.aliasId || ''})` : ''}`);
            } else {
                await setObjectAsync(neuId, { type: 'state', common, native: {} });
            }
            angelegt++;
            neuObj = { common };
        } else if (cust && cust.enabled) {
            if (DRY_RUN) {
                log(`[DRY] Influx übernehmen ${neuId} (${cust.aliasId || ''})`);
            } else {
                await extendObjectAsync(neuId, { common: { custom: { [INFLUX]: cust } } });
            }
        }
        if (cust && cust.enabled) {
            influx++;
            if (!DRY_RUN) {
                await extendObjectAsync(altId, { common: { custom: { [INFLUX]: { ...cust, enabled: false } } } });
            }
        }
        // Wert übernehmen (nur wenn der neue Datenpunkt noch keinen hat)
        const st = await getStateAsync(altId);
        const stNeu = (await existsStateAsync(neuId)) ? await getStateAsync(neuId) : null;
        if (st && st.val !== null && st.val !== undefined && (!stNeu || stNeu.val === null)) {
            if (!DRY_RUN) {
                await setStateAsync(neuId, { val: st.val, ack: true });
            }
            werte++;
        }
    }
    log(
        `${DRY_RUN ? '[DRY] ' : ''}${ids.length} alte Datenpunkte: ${angelegt} neu angelegt, ${influx} mit Influx übernommen, ${werte} Werte übernommen, ${uebersprungen} übersprungen`,
    );
    if (DRY_RUN) {
        log('Prüfen, dann DRY_RUN = false setzen und erneut starten. Danach midea-heatpump.0 starten.');
    }
    stopScript();
})();
