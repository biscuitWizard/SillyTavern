/**
 * Render a CharacterSheet to YAML for inclusion in actor prompts.
 *
 * Two modes:
 *   - **Layout-aware (M3)**: when called with a `SheetLayout`, the
 *     renderer walks the layout's categories and emits one YAML block
 *     per category, using the category id as the YAML key (e.g.
 *     `abilities:`, `combat:`, `relationships:`). Stat keys present on
 *     disk but absent from any `kind: stats` category are emitted under
 *     a final `other:` block so player-added KVs survive forever.
 *   - **Flat fallback**: when called with no layout (or an empty one),
 *     emits the legacy `stats:` / `statuses:` / `skills:` / `items:` /
 *     `notes:` / `relationships:` blocks. Tests written before M1 and
 *     callers that don't carry the layout (e.g. character-cards
 *     fallbacks, debug dumps) keep working.
 *
 * Per-actor isolation invariant (pinned in
 * `tests/gm-core/actor-prompts.test.js`): the renderer only ever reads
 * from the sheet you pass in. Relationships are rendered straight from
 * `sheet.relationships`; there is no campaign-side mirror to leak from.
 *
 * @param {import('./schemas.js').CharacterSheet | null | undefined} sheet
 * @param {import('../rulesets/schemas.d.ts').SheetLayout | null} [layout]
 * @returns {string}
 */
export function renderSheetYaml(sheet, layout = null) {
    if (!sheet) return '';
    if (layout && Array.isArray(layout.categories) && layout.categories.length) {
        return renderLayoutYaml(sheet, layout);
    }
    return renderFlatYaml(sheet);
}

/**
 * Walk the layout and emit one block per category. Stat keys that are
 * not declared in any `kind: stats` category fall through to an
 * `other:` block at the end so user-added KVs are still visible to the
 * actor.
 *
 * @param {import('./schemas.js').CharacterSheet} sheet
 * @param {import('../rulesets/schemas.d.ts').SheetLayout} layout
 */
function renderLayoutYaml(sheet, layout) {
    const lines = [];
    const stats = (sheet.stats && typeof sheet.stats === 'object') ? sheet.stats : {};
    const statuses = (sheet.statuses && typeof sheet.statuses === 'object') ? sheet.statuses : {};
    const items = Array.isArray(sheet.items) ? sheet.items : [];
    const skills = Array.isArray(sheet.skills) ? sheet.skills : [];
    const notes = typeof sheet.notes === 'string' ? sheet.notes : '';
    const relationships = (sheet.relationships && typeof sheet.relationships === 'object') ? sheet.relationships : {};

    // Track which stat / status keys are claimed by some category so we
    // can flush the leftovers under `other:` at the end.
    const claimedStatKeys = new Set();
    const claimedStatusKeys = new Set();

    let emittedSomething = false;

    for (const category of layout.categories) {
        if (!category || !category.id) continue;
        const blockLines = [];
        switch (category.kind) {
            case 'stats':
                emitStatsCategory(category, stats, claimedStatKeys, blockLines);
                break;
            case 'statuses':
                emitStatusesCategory(category, statuses, claimedStatusKeys, blockLines);
                break;
            case 'skills':
                emitSkillsCategory(category, skills, blockLines);
                break;
            case 'items':
                emitItemsCategory(items, blockLines);
                break;
            case 'notes':
                emitNotesCategory(notes, blockLines);
                break;
            case 'relationships':
                emitRelationshipsCategory(relationships, blockLines);
                break;
            default:
                break;
        }
        if (blockLines.length) {
            lines.push(`${category.id}:`);
            for (const line of blockLines) lines.push(`  ${line}`);
            emittedSomething = true;
        }
    }

    // Fallthrough: stats present on disk but unmentioned by any category.
    /** @type {string[]} */
    const otherStats = [];
    for (const [key, value] of Object.entries(stats)) {
        if (!claimedStatKeys.has(key)) otherStats.push(`${formatKey(key)}: ${formatScalar(value)}`);
    }
    /** @type {string[]} */
    const otherStatuses = [];
    for (const [key, value] of Object.entries(statuses)) {
        if (!claimedStatusKeys.has(key)) otherStatuses.push(`${formatKey(key)}: ${formatScalar(value)}`);
    }
    if (otherStats.length || otherStatuses.length) {
        lines.push('other:');
        if (otherStats.length) {
            lines.push('  stats:');
            for (const line of otherStats) lines.push(`    ${line}`);
        }
        if (otherStatuses.length) {
            lines.push('  statuses:');
            for (const line of otherStatuses) lines.push(`    ${line}`);
        }
        emittedSomething = true;
    }

    if (!emittedSomething) return '';
    return lines.join('\n');
}

/**
 * Emit the rows of a `kind: stats` category. We only emit fields the
 * sheet actually carries — declaring `required: true` reserves the
 * UI slot, not the prompt slot. Paired traits emit both legs (with the
 * `paired_with` leg drawing from `sheet.stats[paired.key]`).
 *
 * @param {import('../rulesets/schemas.d.ts').SheetCategory} category
 * @param {Record<string, number | string>} stats
 * @param {Set<string>} claimed
 * @param {string[]} out
 */
function emitStatsCategory(category, stats, claimed, out) {
    const fields = Array.isArray(category.fields) ? category.fields : [];
    for (const field of fields) {
        if (!field || !field.key) continue;
        claimed.add(field.key);
        if (field.paired_with?.key) claimed.add(field.paired_with.key);
        if (Object.prototype.hasOwnProperty.call(stats, field.key)) {
            out.push(`${formatKey(field.key)}: ${formatScalar(stats[field.key])}`);
        }
        if (field.paired_with?.key && Object.prototype.hasOwnProperty.call(stats, field.paired_with.key)) {
            out.push(`${formatKey(field.paired_with.key)}: ${formatScalar(stats[field.paired_with.key])}`);
        }
    }
}

/**
 * @param {import('../rulesets/schemas.d.ts').SheetCategory} category
 * @param {Record<string, string>} statuses
 * @param {Set<string>} claimed
 * @param {string[]} out
 */
function emitStatusesCategory(category, statuses, claimed, out) {
    const fields = Array.isArray(category.fields) ? category.fields : [];
    if (fields.length) {
        for (const field of fields) {
            if (!field || !field.key) continue;
            claimed.add(field.key);
            if (Object.prototype.hasOwnProperty.call(statuses, field.key)) {
                out.push(`${formatKey(field.key)}: ${formatScalar(statuses[field.key])}`);
            }
        }
    } else {
        // `kind: statuses` without explicit fields means "render every
        // status key on the sheet" (today's `Conditions` behaviour).
        for (const [key, value] of Object.entries(statuses)) {
            claimed.add(key);
            out.push(`${formatKey(key)}: ${formatScalar(value)}`);
        }
    }
}

/**
 * @param {import('../rulesets/schemas.d.ts').SheetCategory} _category
 * @param {string[]} skills
 * @param {string[]} out
 */
function emitSkillsCategory(_category, skills, out) {
    for (const skill of skills) {
        out.push(`- ${formatScalar(skill)}`);
    }
}

/**
 * @param {import('./schemas.js').Item[]} items
 * @param {string[]} out
 */
function emitItemsCategory(items, out) {
    for (const item of items) {
        if (!item) continue;
        out.push(`- name: ${formatScalar(item.name)}`);
        if (item.description) out.push(`  description: ${formatScalar(item.description)}`);
        if (Array.isArray(item.influences) && item.influences.length) {
            out.push(`  influences: [${item.influences.map(formatScalar).join(', ')}]`);
        }
    }
}

/**
 * @param {string} notes
 * @param {string[]} out
 */
function emitNotesCategory(notes, out) {
    if (!notes) return;
    out.push('|');
    for (const noteLine of String(notes).split('\n')) {
        out.push(`  ${noteLine}`);
    }
}

/**
 * Per-other-character relationships block. Only the actor whose sheet
 * was passed in contributes — the renderer never reads any other
 * character's record (per-actor isolation invariant).
 *
 * @param {Record<string, Record<string, number | string>>} relationships
 * @param {string[]} out
 */
function emitRelationshipsCategory(relationships, out) {
    for (const [otherId, fields] of Object.entries(relationships)) {
        if (!fields || typeof fields !== 'object') continue;
        const fieldEntries = Object.entries(fields);
        if (!fieldEntries.length) continue;
        out.push(`${formatKey(otherId)}:`);
        for (const [field, value] of fieldEntries) {
            out.push(`  ${formatKey(field)}: ${formatScalar(value)}`);
        }
    }
}

/**
 * Legacy flat dump (no layout).
 *
 * @param {import('./schemas.js').CharacterSheet} sheet
 */
function renderFlatYaml(sheet) {
    const lines = [];

    if (sheet.stats && Object.keys(sheet.stats).length) {
        lines.push('stats:');
        for (const [key, value] of Object.entries(sheet.stats)) {
            lines.push(`  ${formatKey(key)}: ${formatScalar(value)}`);
        }
    }

    if (sheet.statuses && Object.keys(sheet.statuses).length) {
        lines.push('statuses:');
        for (const [key, value] of Object.entries(sheet.statuses)) {
            lines.push(`  ${formatKey(key)}: ${formatScalar(value)}`);
        }
    }

    if (Array.isArray(sheet.skills) && sheet.skills.length) {
        lines.push('skills:');
        for (const skill of sheet.skills) {
            lines.push(`  - ${formatScalar(skill)}`);
        }
    }

    if (Array.isArray(sheet.items) && sheet.items.length) {
        lines.push('items:');
        for (const item of sheet.items) {
            lines.push(`  - name: ${formatScalar(item.name)}`);
            if (item.description) lines.push(`    description: ${formatScalar(item.description)}`);
            if (Array.isArray(item.influences) && item.influences.length) {
                lines.push(`    influences: [${item.influences.map(formatScalar).join(', ')}]`);
            }
        }
    }

    if (sheet.relationships && typeof sheet.relationships === 'object' && Object.keys(sheet.relationships).length) {
        let any = false;
        const relLines = ['relationships:'];
        for (const [otherId, fields] of Object.entries(sheet.relationships)) {
            if (!fields || typeof fields !== 'object') continue;
            const entries = Object.entries(fields);
            if (!entries.length) continue;
            any = true;
            relLines.push(`  ${formatKey(otherId)}:`);
            for (const [field, value] of entries) {
                relLines.push(`    ${formatKey(field)}: ${formatScalar(value)}`);
            }
        }
        if (any) lines.push(...relLines);
    }

    if (sheet.notes) {
        lines.push('notes: |');
        for (const noteLine of String(sheet.notes).split('\n')) {
            lines.push(`  ${noteLine}`);
        }
    }

    return lines.join('\n');
}

/**
 * Quote a key when it would otherwise confuse a YAML parser (whitespace,
 * leading punctuation, reserved characters). Plain ASCII identifiers
 * round-trip through unquoted.
 *
 * @param {string} key
 */
function formatKey(key) {
    const s = String(key);
    if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(s)) return s;
    return JSON.stringify(s);
}

/** @param {unknown} value */
function formatScalar(value) {
    if (value === null || value === undefined) return '~';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    const str = String(value);
    if (/[:#\n"'\-{}\[\]&*!|>%@`]/.test(str) || /^\s|\s$/.test(str)) {
        return JSON.stringify(str);
    }
    return str;
}
