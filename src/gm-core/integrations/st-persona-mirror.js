/**
 * Mirror the player's character name into ST's active persona by editing
 * `{handle}/settings.json` directly. Best-effort: any failure is logged and
 * silently swallowed so the caller's create/update flow still succeeds.
 *
 * Touches only the keys we own:
 *   - `power_user.personas[<avatar>] = <name>`
 *   - `power_user.persona_descriptions[<avatar>] = { description, ... }` (created if missing)
 *   - `power_user.default_persona = <avatar>`
 *   - `user_avatar = <avatar>`
 */

import fs from 'node:fs';
import path from 'node:path';

import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { SETTINGS_FILE } from '../../constants.js';

/** @typedef {import('../library/schemas.js').Character} Character */

const TT_PERSONA_AVATAR_PREFIX = 'tt-persona-';

/**
 * @param {Character} character
 * @returns {string} the avatar id used as the persona key
 */
function personaAvatarId(character) {
    const slug = sanitize(character.id) || sanitize(character.name) || 'pc';
    return `${TT_PERSONA_AVATAR_PREFIX}${slug}.png`;
}

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {Character} character
 * @returns {string | null} The persona avatar id we set, or null on failure.
 */
export function mirrorCharacterToPersona(directories, character) {
    try {
        const settingsPath = path.join(directories.root, SETTINGS_FILE);
        if (!fs.existsSync(settingsPath)) {
            console.warn('[gm] persona mirror: settings.json missing, skipping');
            return null;
        }

        const raw = fs.readFileSync(settingsPath, 'utf8');
        let settings;
        try {
            settings = JSON.parse(raw);
        } catch (err) {
            console.warn('[gm] persona mirror: settings.json is not valid JSON, skipping');
            return null;
        }

        if (!settings.power_user || typeof settings.power_user !== 'object') {
            settings.power_user = {};
        }
        const pu = settings.power_user;
        if (!pu.personas || typeof pu.personas !== 'object') pu.personas = {};
        if (!pu.persona_descriptions || typeof pu.persona_descriptions !== 'object') pu.persona_descriptions = {};

        const avatarId = personaAvatarId(character);
        const description = [
            character.appearance && `Appearance: ${character.appearance}`,
            character.personality && `Personality: ${character.personality}`,
            character.voice && `Voice: ${character.voice}`,
            character.background && `Background: ${character.background}`,
        ].filter(Boolean).join('\n\n');

        pu.personas[avatarId] = character.name;
        const existingDescriptor = pu.persona_descriptions[avatarId];
        pu.persona_descriptions[avatarId] = {
            description,
            position: existingDescriptor?.position ?? 0,
            depth: existingDescriptor?.depth ?? 4,
            role: existingDescriptor?.role ?? 0,
            lorebook: existingDescriptor?.lorebook ?? '',
            title: existingDescriptor?.title ?? '',
            connections: existingDescriptor?.connections ?? [],
        };
        pu.default_persona = avatarId;
        settings.user_avatar = avatarId;

        writeFileAtomicSync(settingsPath, JSON.stringify(settings, null, 4), { encoding: 'utf8' });
        return avatarId;
    } catch (err) {
        console.warn('[gm] persona mirror failed', err);
        return null;
    }
}
