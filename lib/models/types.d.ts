// Typen fuer die Modell-Definitionen (nur fuer den Typecheck, keine Laufzeitwirkung)

export type RegType = 'U16' | 'S16' | 'U32' | 'S32';

export interface RegisterDef {
    addr: number;
    key: string;
    type: RegType;
    factor?: number;
    unit?: string;
    group: 'live' | 'settings';
    rw?: boolean;
    desc: string;
}

/** [bit, state, name, writable?, feature?] */
export type BitDef = [number, string, string, boolean?, string?];

export interface WriteDef {
    min?: number;
    max?: number;
    /** Register, dessen aktueller Wert die Untergrenze liefert */
    minFrom?: number;
    /** Register, dessen aktueller Wert die Obergrenze liefert */
    maxFrom?: number;
}

export interface MappingDef {
    state?: string;
    name?: string;
    role?: string;
    unit?: string;
    bool?: boolean;
    states?: Record<number, string>;
    transform?: (value: number, raw: number) => number | string | boolean;
    invalid?: number[];
    write?: WriteDef;
    bits?: BitDef[];
    feature?: string;
    /** Register wird nur intern fuer die Statistik verwendet (kein eigener Datenpunkt) */
    stat?: boolean;
}

export interface ModelDef {
    id: string;
    label: string;
    manufacturer: string;
    /** Registertabelle (bereits mit Erweiterungen zusammengefuehrt) */
    registers: RegisterDef[];
    mapping: Record<number, MappingDef>;
    /** Adressen, die das Geraet mit "Illegal Data Address" ablehnt; Lesebloecke werden darum herum gebildet */
    invalidAddresses: number[];
    /** Merkmale des Modells */
    features: {
        /** Anzahl Stufen der internen Zusatzheizung (0 = keine) */
        ibhStages: number;
        /** Leistung je Stufe in kW (nur Anzeige/Doku) */
        ibhStepKw?: number;
        cooling: boolean;
        zone2: boolean;
        tbh: boolean;
    };
    /** Plausibilitaetspruefung beim Start: Register -> erwarteter Wert (skaliert) */
    expect?: Record<number, number>;
    /** Register, aus dem die Modell-Plausibilitaet gelesen wird, mit Text fuer das Log */
    notes?: string;
}
