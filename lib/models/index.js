'use strict';

/**
 * Liste aller unterstuetzten Modelle. Ein neues Modell:
 *  1. Datei unter lib/models/ anlegen (Vorlage: midea-mhc-v8wd2rn7.js; gemeinsame Register aus midea-common.js
 *     uebernehmen und nur Abweichungen ueberschreiben, siehe extendModel()).
 *  2. Hier in MODELS eintragen.
 *  3. In admin/jsonConfig.json beim Dropdown "model" ergaenzen.
 */

/** @type {import('./types').ModelDef[]} */
const MODELS = [require('./midea-mhc-v8wd2rn7')];

/**
 * Modell anhand der ID holen.
 *
 * @param {string} id - Modell-ID aus der Konfiguration
 * @returns {import('./types').ModelDef | undefined} Modell
 */
function getModel(id) {
    return MODELS.find(m => m.id === id);
}

/**
 * Hilfsfunktion fuer abgeleitete Modelle: uebernimmt ein Basismodell und ersetzt/ergaenzt einzelne Teile.
 * Register und Zuordnungen werden pro Adresse ueberschrieben; `null` in mapping entfernt eine Zuordnung.
 *
 * @param {import('./types').ModelDef} base - Basismodell
 * @param {Partial<import('./types').ModelDef> & { id: string, label: string }} changes - Abweichungen
 * @returns {import('./types').ModelDef} neues Modell
 */
function extendModel(base, changes) {
    const regs = new Map(base.registers.map(r => [r.addr, r]));
    for (const r of changes.registers || []) {
        regs.set(r.addr, r);
    }
    const mapping = { ...base.mapping };
    for (const [addr, m] of Object.entries(changes.mapping || {})) {
        if (m === null) {
            delete mapping[addr];
        } else {
            mapping[addr] = m;
        }
    }
    return {
        ...base,
        ...changes,
        registers: [...regs.values()].sort((a, b) => a.addr - b.addr),
        mapping,
        features: { ...base.features, ...(changes.features || {}) },
        invalidAddresses: changes.invalidAddresses || base.invalidAddresses,
    };
}

module.exports = { MODELS, getModel, extendModel };
