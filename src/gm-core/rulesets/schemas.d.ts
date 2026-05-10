/**
 * Ruleset shape (Phase 6).
 *
 * A loaded ruleset is the merge of three on-disk YAML files:
 *
 *   - skills.yaml        -- abilities + skills (with skill-to-ability mapping)
 *   - dc_guidance.yaml   -- DC bands and clamp range
 *   - consequences.yaml  -- failure-severity ladder
 *
 * Plus the per-ruleset starter pack (`starter_stats`, `starter_skills`) the
 * character wizard uses at create time. Phase 5's in-memory registry seeded
 * those; Phase 6 keeps the same surface so the wizard does not change.
 */

export type SeverityLevel = 'minor' | 'moderate' | 'severe' | 'lethal' | string;

export interface Ability {
    /** Short id used in LLM-facing schemas, e.g. "str". */
    id: string;
    /** Display name, e.g. "Strength". */
    name: string;
    /** Key under `character.sheet.stats` that holds this ability's score. */
    stat_key: string;
}

export interface Skill {
    id: string;
    name: string;
    /** The id of the Ability this skill is keyed to. Source of truth. */
    ability_id: string;
    description: string;
}

export interface DcBand {
    id: string;
    dc: number;
    label: string;
    description: string;
}

export interface Severity {
    id: SeverityLevel;
    label: string;
    description: string;
}

export interface Ruleset {
    id: string;
    name: string;
    abilities: Ability[];
    skills: Skill[];
    dc_bands: DcBand[];
    severities: Severity[];
    /** Lower clamp for DCs; defaults to the lowest band's dc. */
    dc_min: number;
    /** Upper clamp for DCs; defaults to the highest band's dc. */
    dc_max: number;
    /** Starter sheet seed used by the character wizard. */
    starter_stats: Record<string, number | string>;
    starter_skills: string[];
    /**
     * Category-driven sheet layout (M1). Concatenated from this ruleset's
     * own `sheet_layout.yaml` (combat-side categories) plus the universal
     * social overlay at `data/sheet-layouts/universal-social.yaml`. The
     * sheet panel, wizard, sidebar, and prompt YAML renderer all walk
     * this layout.
     *
     * Null when neither file is loadable (the in-memory fallback ruleset
     * sets this to null; consumers should treat it as "use the legacy
     * flat KV grid").
     */
    sheet_layout: SheetLayout | null;
}

export interface RulesetIdSummary {
    id: string;
    name: string;
    source: 'user' | 'bundled' | 'fallback';
}

/* --------- Sheet layout (M1) --------- */

export type SheetFieldType = 'number' | 'bar' | 'text' | 'paired';

export interface PairedFieldOpposite {
    key: string;
    label: string;
    /** Default for the opposite-side stat key (e.g. shy when key=dom). */
    default?: number;
}

export interface SheetField {
    /** Stat / status / relationship sub-field key written into the sheet bag. */
    key: string;
    /** Display label rendered in the editor and the prompt YAML. */
    label: string;
    type: SheetFieldType;
    /** Render a slot for this field even if the underlying bag has no value. */
    required?: boolean;
    /** Default value to seed at character-create time. */
    default?: number | string;
    /** Numeric clamp lower bound (bar / number / paired). */
    min?: number;
    /** Numeric clamp upper bound (bar / number / paired). */
    max?: number;
    /**
     * For `type: bar` — when the bar's max should be read from another
     * stat key on the same sheet (e.g. HP whose max is `max_hp`). The
     * editor uses this to compute the fill ratio dynamically.
     */
    max_from_key?: string;
    /** Right-side leg of a paired trait (e.g. {key:'shy', label:'Shy'}). */
    paired_with?: PairedFieldOpposite;
    /** Optional prompt-side hint; not rendered in the editor. */
    description?: string;
}

export type SheetCategoryKind = 'stats' | 'statuses' | 'skills' | 'items' | 'relationships' | 'notes';

export interface SheetCategory {
    id: string;
    label: string;
    /**
     * Which sheet bag this category writes to. Special-cased renderers:
     *   - `stats` / `statuses`        -> KV grid driven by `fields[]`.
     *   - `skills`                    -> checklist; `show_all_from_ruleset` drives "always render every ruleset skill".
     *   - `items`                     -> list editor over `sheet.items[]`.
     *   - `relationships`             -> per-other-character mini-grid driven by `per_target_fields[]`.
     *   - `notes`                     -> single textarea over `sheet.notes`.
     */
    kind: SheetCategoryKind;
    /** Field schema for stats / statuses categories. */
    fields?: SheetField[];
    /** Field schema for relationships categories (one per target). */
    per_target_fields?: SheetField[];
    /** Skills-only: render every ruleset skill as a row, proficient or not. */
    show_all_from_ruleset?: boolean;
    /** When true, the wizard surfaces a dedicated step for this category. */
    wizard_step?: boolean;
    /** When true, the left sidebar's compact card pulls this category in. */
    sidebar_highlight?: boolean;
    /** Optional prompt-side hint; not rendered in the editor. */
    description?: string;
}

export interface SheetLayout {
    version: number;
    categories: SheetCategory[];
}
