'use strict';

const { REGISTERS, MAPPING } = require('./midea-common');

/**
 * Midea MHC-V8WD2RN7 — R290-Monoblock, 8 kW, eingebaute Zusatzheizung 9 kW (3 Stufen: 3/6/9 kW).
 * Geprueft am 07.11.2026 (Servicemenue, Modbus-Mitschnitt).
 *
 * @type {import('./types').ModelDef}
 */
module.exports = {
    id: 'midea-mhc-v8wd2rn7',
    label: 'Midea MHC-V8WD2RN7 (R290, 8 kW, Monoblock)',
    manufacturer: 'Midea',
    registers: REGISTERS,
    mapping: MAPPING,
    // Vom Geraet nachweislich mit "Illegal Data Address" abgelehnt (Import der Registerliste, November 2026).
    // Weitere ungueltige Adressen lernt der Adapter zur Laufzeit selbst (Block wird dann einzeln gelesen).
    invalidAddresses: [200, 214, 223, 228, 236, 239],
    features: {
        ibhStages: 3,
        ibhStepKw: 3,
        cooling: true,
        zone2: false,
        tbh: true,
    },
    // Register 123 "Unit capacity" meldet die Leistungsklasse in kW
    expect: { 123: 8 },
};
