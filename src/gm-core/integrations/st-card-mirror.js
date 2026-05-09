/**
 * Mirror a TTRPG Tavern Character into a SillyTavern v2 character card so the
 * scene view (which leans on ST's chat substrate) has a real avatar/name
 * carrier on disk.
 *
 * The card lives at `{handle}/characters/{slug}.png`, embeds chara_card_v2 +
 * ccv3 metadata via `src/character-card-parser.js`, and uses the default
 * fallback avatar PNG as the image canvas. Subsequent renames / updates are
 * idempotent — the character's wizard `id` provides a stable slug.
 */

import fs from 'node:fs';
import path from 'node:path';

import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { write as writeCardMetadata } from '../../character-card-parser.js';
import { humanizedDateTime } from '../../util.js';

/** @typedef {import('../library/schemas.js').Character} Character */

const DEFAULT_AVATAR_PATH = path.resolve('./public/img/ai4.png');

/**
 * @param {Character} character
 */
function buildCardPayload(character) {
    const name = character.name;
    const description = [
        character.appearance && `Appearance: ${character.appearance}`,
        character.background && `Background: ${character.background}`,
    ].filter(Boolean).join('\n\n');

    /** @type {object} */
    const card = {
        name,
        description,
        personality: character.personality || '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        creatorcomment: 'Mirrored from TTRPG Tavern character card.',
        avatar: 'none',
        chat: `${name} - ${humanizedDateTime()}`,
        talkativeness: 0.5,
        fav: false,
        tags: ['ttrpg-tavern'],
        spec: 'chara_card_v2',
        spec_version: '2.0',
        create_date: character.created_at,
        data: {
            name,
            description,
            personality: character.personality || '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            creator_notes: 'Mirrored from TTRPG Tavern character card.',
            system_prompt: '',
            post_history_instructions: '',
            tags: ['ttrpg-tavern'],
            creator: 'TTRPG Tavern',
            character_version: '1.0',
            alternate_greetings: [],
            extensions: {
                talkativeness: 0.5,
                fav: false,
                world: '',
                tt_character_id: character.id,
                tt_campaign_id: character.campaign_id,
                tt_voice: character.voice || '',
            },
        },
    };
    return card;
}

/**
 * Pick a deterministic file slug for a character. Prefer the character's
 * stable id (already slugified by `library/store.js`) so renames don't
 * orphan old cards.
 *
 * @param {Character} character
 */
function cardSlug(character) {
    return sanitize(character.id) || sanitize(character.name) || 'tt-character';
}

/**
 * Write or refresh the ST v2 card for the given Character. Returns the
 * `<filename>.png` we wrote (relative to the user's `characters` dir) so the
 * caller can persist `Character.st_card_avatar`.
 *
 * Best-effort: any error is logged and `null` is returned; the upstream
 * Character JSON is the source of truth either way.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {Character} character
 * @returns {string | null}
 */
export function writeStCardForCharacter(directories, character) {
    try {
        if (!fs.existsSync(directories.characters)) {
            fs.mkdirSync(directories.characters, { recursive: true });
        }
        if (!fs.existsSync(DEFAULT_AVATAR_PATH)) {
            console.warn('[gm] default avatar PNG missing, skipping ST card mirror');
            return null;
        }

        const slug = cardSlug(character);
        const fileName = `${slug}.png`;
        const outputPath = path.join(directories.characters, fileName);

        const baseImage = fs.readFileSync(DEFAULT_AVATAR_PATH);
        const cardJson = JSON.stringify(buildCardPayload(character));
        const buffer = writeCardMetadata(baseImage, cardJson);
        writeFileAtomicSync(outputPath, buffer);
        return fileName;
    } catch (err) {
        console.warn('[gm] failed to mirror character to ST card', err);
        return null;
    }
}

/**
 * Best-effort delete of the previously-mirrored ST card for a character.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {Character} character
 */
export function removeStCardForCharacter(directories, character) {
    try {
        const fileName = character.st_card_avatar || `${cardSlug(character)}.png`;
        const outputPath = path.join(directories.characters, sanitize(fileName));
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch (err) {
        console.warn('[gm] failed to remove mirrored ST card', err);
    }
}
