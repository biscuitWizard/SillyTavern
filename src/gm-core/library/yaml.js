/**
 * Render a CharacterSheet to YAML for inclusion in actor prompts (Phase 5+).
 *
 * Implemented now because the prompt builders live next to the schema; the
 * runtime caller arrives in Phase 5.
 *
 * @param {import('./schemas.js').CharacterSheet} sheet
 * @returns {string}
 */
export function renderSheetYaml(sheet) {
    if (!sheet) return '';
    const lines = [];

    if (sheet.stats && Object.keys(sheet.stats).length) {
        lines.push('stats:');
        for (const [key, value] of Object.entries(sheet.stats)) {
            lines.push(`  ${key}: ${formatScalar(value)}`);
        }
    }

    if (sheet.statuses && Object.keys(sheet.statuses).length) {
        lines.push('statuses:');
        for (const [key, value] of Object.entries(sheet.statuses)) {
            lines.push(`  ${key}: ${formatScalar(value)}`);
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

    if (sheet.notes) {
        lines.push('notes: |');
        for (const noteLine of String(sheet.notes).split('\n')) {
            lines.push(`  ${noteLine}`);
        }
    }

    return lines.join('\n');
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
