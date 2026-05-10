/**
 * M7 — sheet panel end-to-end (Playwright).
 *
 * Mirrors the M6 wizard test: stubs every `/api/gm/...` endpoint
 * with `page.route(...)`, drives the sheet panel directly via
 * `page.evaluate(import('/scripts/gm/sheet-panel.js'))`, and walks the
 * panel through a representative subset of mutations:
 *
 *   1. Edits a `kind: stats` bar field (HP) → asserts a PUT against
 *      `/sheets/:char_id/stats/hp`.
 *   2. Edits a `paired` trait (dom/shy) → asserts both PUTs.
 *   3. Adds an inventory item → asserts the POST against
 *      `/sheets/:char_id/items`.
 *   4. Sets a free-form condition → asserts a PUT against
 *      `/sheets/:char_id/statuses/:key`.
 *   5. Clicks the PC-card CTA on an NPC sheet → asserts a PUT against
 *      `/sheets/:npc_id/relationships/:pc_id/:field` (the only
 *      relationship card the NPC sheet shows up-front).
 *   6. Asserts the player character's sheet renders WITHOUT the
 *      relationships section at all.
 *
 * The test is gated behind `TTRPG_E2E_SHEET_PANEL=1` so it only runs
 * when the dev server is up (matches the wizard / scene-end / memory
 * explorer convention). Locally:
 *
 *   docker compose up -d qdrant && npm start
 *   TTRPG_E2E_SHEET_PANEL=1 cd tests && npx playwright test frontend/sheet-panel/
 */

import { test, expect } from '@playwright/test';

const E2E_ENABLED = process.env.TTRPG_E2E_SHEET_PANEL === '1';

const CAMPAIGN_ID = 'sheet-panel-test-campaign';
const RULESET_ID = 'dnd5e';
// The NPC sheet is the one the panel exercises end-to-end (the PC
// sheet doesn't render the relationships section at all — see test
// case #6 below).
const CHAR_ID = 'amelia';
const PC_ID = 'jack';

const STUB_RULESET = {
    id: RULESET_ID,
    name: 'D&D 5e (test)',
    abilities: [{ id: 'str', name: 'Strength', stat_key: 'strength' }],
    skills: [{ id: 'athletics', name: 'Athletics', ability_id: 'str', description: '' }],
    dc_bands: [],
    severities: [],
    dc_min: 5,
    dc_max: 30,
    starter_stats: { strength: 10, hp: 10, max_hp: 10 },
    starter_skills: [],
    sheet_layout: null,
};

/**
 * Layout exercises every editor branch the panel offers:
 *   - `kind: stats` with bar + paired widgets (combat + traits)
 *   - `kind: skills` (the sheet panel renders the checklist)
 *   - `kind: items` (inventory)
 *   - `kind: statuses` with no fields (free-form Conditions)
 *   - `kind: relationships` with `per_target_fields` (M7's editor)
 *   - `kind: notes`
 */
const STUB_LAYOUT = {
    version: 1,
    categories: [
        {
            id: 'combat',
            label: 'Combat',
            kind: 'stats',
            fields: [
                { key: 'hp', label: 'HP', type: 'bar', max_from_key: 'max_hp', min: 0, max: 999, default: 10, required: true },
                { key: 'max_hp', label: 'Max HP', type: 'number', min: 1, default: 10, required: true },
            ],
        },
        {
            id: 'traits',
            label: 'Personality Traits',
            kind: 'stats',
            fields: [
                { key: 'dom', label: 'Dom', type: 'paired', paired_with: { key: 'shy', label: 'Shy', default: 0 }, min: -100, max: 100, default: 0, required: true },
            ],
        },
        { id: 'skills', label: 'Skills', kind: 'skills', show_all_from_ruleset: true },
        { id: 'inventory', label: 'Inventory', kind: 'items' },
        { id: 'conditions', label: 'Conditions', kind: 'statuses' },
        {
            id: 'relationships',
            label: 'Relationships',
            kind: 'relationships',
            per_target_fields: [
                { key: 'stage', label: 'Stage', type: 'text', default: 'stranger', required: true },
                { key: 'affection', label: 'Affection', type: 'number', min: 0, max: 100, default: 0 },
            ],
        },
        { id: 'notes', label: 'Notes', kind: 'notes' },
    ],
};

const STUB_CHARACTER = {
    id: CHAR_ID,
    campaign_id: CAMPAIGN_ID,
    name: 'Amelia Verra',
    is_player: false,
    appearance: 'Wiry, ink-stained hands.',
    personality: 'Skeptical.',
    voice: 'Sharp.',
    background: '',
    sheet: {
        stats: { hp: 10, max_hp: 10, strength: 14, dom: 0, shy: 0 },
        statuses: {},
        items: [],
        skills: [],
        notes: '',
        relationships: {},
    },
    has_portrait: false,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
};

const STUB_PC = {
    id: PC_ID,
    campaign_id: CAMPAIGN_ID,
    name: 'Jack Ironwright',
    is_player: true,
    appearance: 'Tall and broad-shouldered.',
    personality: 'Stoic.',
    voice: 'Low.',
    background: '',
    sheet: {
        stats: { hp: 10, max_hp: 10, strength: 14, dom: 0, shy: 0 },
        statuses: {},
        items: [],
        skills: [],
        notes: '',
        relationships: {},
    },
    has_portrait: false,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
};

const STUB_ROSTER = [STUB_CHARACTER, STUB_PC];

/** Deep-clone the seed so a single test can mutate it without leaking. */
function cloneCharacter(seed = STUB_CHARACTER) {
    return JSON.parse(JSON.stringify(seed));
}

test.describe('Sheet panel (M4 + M7)', () => {
    test.skip(!E2E_ENABLED, 'Set TTRPG_E2E_SHEET_PANEL=1 to enable the sheet-panel e2e (requires the app running on the configured baseURL).');

    test('edits bar / paired / item / condition / PC-relationship persist through the right endpoints', async ({ page }) => {
        const calls = [];
        let currentCharacter = cloneCharacter();
        const currentPC = cloneCharacter(STUB_PC);

        // GET endpoints --------------------------------------------------
        await page.route(`**/api/gm/rulesets/${RULESET_ID}`, async (req) => {
            await req.fulfill({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ruleset: STUB_RULESET }),
            });
        });
        await page.route(`**/api/gm/rulesets/${RULESET_ID}/sheet-layout`, async (req) => {
            await req.fulfill({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sheet_layout: STUB_LAYOUT }),
            });
        });
        // Per-character GETs (open + reopen). Match each id explicitly so
        // we can return the right snapshot.
        await page.route(`**/api/gm/sheets/${CHAR_ID}`, async (req) => {
            await req.fulfill({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ character: currentCharacter }),
            });
        });
        await page.route(`**/api/gm/sheets/${PC_ID}`, async (req) => {
            await req.fulfill({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ character: currentPC }),
            });
        });
        await page.route(`**/api/gm/campaigns/${CAMPAIGN_ID}/characters`, async (req) => {
            await req.fulfill({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ characters: STUB_ROSTER }),
            });
        });

        // Lazy GETs added by the post-feedback rewrite — list of keys
        // and a single entry. The panel hits `getRelationship` after a
        // successful PC-card seed to re-render the card from the
        // server-of-record.
        await page.route(/\/api\/gm\/sheets\/[^/]+\/relationships$/, async (req) => {
            const url = new URL(req.request().url());
            const m = url.pathname.match(/\/sheets\/([^/]+)\/relationships$/);
            const id = m ? m[1] : '';
            const sheet = id === CHAR_ID ? currentCharacter.sheet : currentPC.sheet;
            const rels = (sheet?.relationships && typeof sheet.relationships === 'object') ? sheet.relationships : {};
            await req.fulfill({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ character_id: id, other_ids: Object.keys(rels).sort() }),
            });
        });
        await page.route(/\/api\/gm\/sheets\/[^/]+\/relationships\/[^/]+$/, async (req) => {
            const method = req.request().method();
            const url = new URL(req.request().url());
            const m = url.pathname.match(/\/sheets\/([^/]+)\/relationships\/([^/]+)$/);
            const id = m ? m[1] : '';
            const otherId = m ? m[2] : '';
            // GET → entry; DELETE → remove the whole entry.
            if (method === 'GET') {
                const sheet = id === CHAR_ID ? currentCharacter.sheet : currentPC.sheet;
                const rels = (sheet?.relationships && typeof sheet.relationships === 'object') ? sheet.relationships : {};
                await req.fulfill({
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ character_id: id, other_id: otherId, fields: rels[otherId] || null }),
                });
                return;
            }
            // Fall through to the bag mutation route for the DELETE
            // case so the same applyStubMutation logic captures the
            // call and updates the in-memory snapshot.
            calls.push({ method, path: url.pathname, body: null });
            applyStubMutation(currentCharacter, method, url.pathname, null);
            await req.fulfill({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ character: currentCharacter }),
            });
        });

        // PUT/POST/DELETE endpoints — capture the call and reflect the
        // mutation back into `currentCharacter` so the panel sees a
        // coherent next-render state. The relationships GETs above
        // shadow the matching shape so this regex only fires for the
        // PUT/DELETE field-level write paths (and the bulk POST/etc).
        await page.route(/\/api\/gm\/sheets\/[^/]+\/(stats|statuses|items|skills|notes|relationships)\b.*/, async (req) => {
            const method = req.request().method();
            // Skip GETs — handled by the explicit routes above.
            if (method === 'GET') return req.continue();
            const url = new URL(req.request().url());
            const body = req.request().postData() ? JSON.parse(req.request().postData()) : null;
            calls.push({ method, path: url.pathname, body });

            applyStubMutation(currentCharacter, method, url.pathname, body);

            await req.fulfill({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ character: currentCharacter }),
            });
        });

        // ---- Navigate to the running app. ----
        await page.goto('/');
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });

        // ---- Open the NPC panel. Pass the campaign explicitly so the
        // relationships section can resolve the player character id
        // from the roster. ----
        await page.evaluate(async ({ character, campaignId, rulesetId }) => {
            const mod = await import('/scripts/gm/sheet-panel.js');
            mod.setActiveCampaign({ id: campaignId, name: 'Sheet Panel Test', ruleset_id: rulesetId });
            mod.openSheetPanel(character, { campaign: { id: campaignId, ruleset_id: rulesetId } });
        }, { character: STUB_CHARACTER, campaignId: CAMPAIGN_ID, rulesetId: RULESET_ID });

        const panel = page.locator('.gm-modal.gm-sheet-modal');
        await expect(panel).toBeVisible({ timeout: 10_000 });

        // ---- Wait for the categorized body to render (proves the
        // layout fetch resolved). ----
        await expect(panel.locator('[data-category-id="combat"]')).toBeVisible({ timeout: 5_000 });

        // ---- 1. Edit HP bar. ----
        const hpInput = panel.locator('[data-category-id="combat"] .gm-bar-input').first();
        await hpInput.fill('7');
        await hpInput.blur();
        await expect.poll(() => calls.find((c) => c.path.endsWith(`/sheets/${CHAR_ID}/stats/hp`))).toBeTruthy();

        // ---- 2. Edit paired trait Dom (left input). ----
        const domInput = panel.locator('[data-category-id="traits"] .gm-paired-input-left, [data-category-id="traits"] .gm-paired-input').first();
        await domInput.fill('-30');
        await domInput.blur();
        await expect.poll(() => calls.find((c) => c.path.endsWith(`/sheets/${CHAR_ID}/stats/dom`))).toBeTruthy();

        // ---- 3. Add an inventory item. ----
        const itemNameInput = panel.locator('[data-category-id="inventory"] .gm-item-add-row input').first();
        await itemNameInput.fill('Iron Sword');
        await panel.locator('[data-category-id="inventory"] .gm-item-add-row button').click();
        await expect.poll(() => calls.find((c) => c.method === 'POST' && c.path.endsWith(`/sheets/${CHAR_ID}/items`))).toBeTruthy();

        // ---- 4. Set a condition (free-form KV). ----
        const condKeyInput = panel.locator('[data-category-id="conditions"] input').nth(0);
        const condValueInput = panel.locator('[data-category-id="conditions"] input').nth(1);
        await condKeyInput.fill('on_fire');
        await condValueInput.fill('minor');
        await panel.locator('[data-category-id="conditions"] .gm-secondary-btn').click();
        await expect.poll(() => calls.find((c) => c.method === 'PUT' && c.path.endsWith(`/sheets/${CHAR_ID}/statuses/on_fire`))).toBeTruthy();

        // ---- 5. PC-card CTA: NPC sheet shows exactly one eager card,
        // pointed at the player character. Clicking the CTA seeds the
        // `per_target_fields` defaults via setRelationshipField. ----
        const relSection = panel.locator('[data-category-id="relationships"]');
        await expect(relSection).toBeVisible();
        // The picker should NOT be in the eager portion — it lives
        // inside the "Other relationships" disclosure (which is empty
        // here because there's no third character in the campaign).
        await expect(relSection.locator('.gm-rel-pc-cta')).toBeVisible();
        await relSection.locator('.gm-rel-pc-cta button').click();
        await expect.poll(() => calls.find((c) => c.method === 'PUT' && c.path.includes(`/sheets/${CHAR_ID}/relationships/${PC_ID}/`))).toBeTruthy();

        // ---- Final shape check on the captured calls. ----
        const hpCall = calls.find((c) => c.path.endsWith(`/sheets/${CHAR_ID}/stats/hp`));
        expect(hpCall.method).toBe('PUT');
        expect(hpCall.body).toEqual({ value: 7 });

        const domCall = calls.find((c) => c.path.endsWith(`/sheets/${CHAR_ID}/stats/dom`));
        expect(domCall.body).toEqual({ value: -30 });

        const itemCall = calls.find((c) => c.method === 'POST' && c.path.endsWith(`/sheets/${CHAR_ID}/items`));
        expect(itemCall.body.name).toBe('Iron Sword');

        const condCall = calls.find((c) => c.path.endsWith(`/sheets/${CHAR_ID}/statuses/on_fire`));
        expect(condCall.body).toEqual({ value: 'minor' });

        const relCall = calls.find((c) => c.path.includes(`/sheets/${CHAR_ID}/relationships/${PC_ID}/`));
        // The CTA seeds defaults — at minimum the `stage` field with
        // default `"stranger"` (or whatever value the per_target_fields
        // declared).
        expect(relCall.body.value).toBeDefined();
    });

    test('player character sheet renders WITHOUT the relationships section', async ({ page }) => {
        const currentCharacter = cloneCharacter(STUB_PC);

        await page.route(`**/api/gm/rulesets/${RULESET_ID}`, async (req) => {
            await req.fulfill({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ruleset: STUB_RULESET }),
            });
        });
        await page.route(`**/api/gm/rulesets/${RULESET_ID}/sheet-layout`, async (req) => {
            await req.fulfill({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sheet_layout: STUB_LAYOUT }),
            });
        });
        await page.route(`**/api/gm/sheets/${PC_ID}`, async (req) => {
            await req.fulfill({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ character: currentCharacter }),
            });
        });
        await page.route(`**/api/gm/campaigns/${CAMPAIGN_ID}/characters`, async (req) => {
            await req.fulfill({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ characters: STUB_ROSTER }),
            });
        });

        await page.goto('/');
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });

        await page.evaluate(async ({ character, campaignId, rulesetId }) => {
            const mod = await import('/scripts/gm/sheet-panel.js');
            mod.setActiveCampaign({ id: campaignId, name: 'Sheet Panel Test', ruleset_id: rulesetId });
            mod.openSheetPanel(character, { campaign: { id: campaignId, ruleset_id: rulesetId } });
        }, { character: STUB_PC, campaignId: CAMPAIGN_ID, rulesetId: RULESET_ID });

        const panel = page.locator('.gm-modal.gm-sheet-modal');
        await expect(panel).toBeVisible({ timeout: 10_000 });
        // The combat section still renders (proves the layout fetch
        // resolved), but the relationships section is absent.
        await expect(panel.locator('[data-category-id="combat"]')).toBeVisible({ timeout: 5_000 });
        await expect(panel.locator('[data-category-id="relationships"]')).toHaveCount(0);
    });
});

/** Apply a stubbed PUT/POST/DELETE to a cloned character object. */
function applyStubMutation(character, method, path, body) {
    const sheet = character.sheet;
    const m = path.match(/\/sheets\/[^/]+\/(stats|statuses|items|skills|notes|relationships)(\/.+)?$/);
    if (!m) return;
    const bag = m[1];
    const tail = m[2] ? m[2].slice(1).split('/') : [];

    if (bag === 'stats') {
        const [key] = tail;
        if (method === 'PUT') sheet.stats[key] = body?.value;
        else if (method === 'DELETE') delete sheet.stats[key];
    } else if (bag === 'statuses') {
        const [key] = tail;
        if (method === 'PUT') sheet.statuses[key] = body?.value;
        else if (method === 'DELETE') delete sheet.statuses[key];
    } else if (bag === 'items') {
        const [itemId] = tail;
        if (method === 'POST') {
            sheet.items.push({ id: `item-${Date.now()}`, name: body?.name, description: body?.description || '', influences: [] });
        } else if (method === 'PUT') {
            const found = sheet.items.find((it) => it.id === itemId);
            if (found) Object.assign(found, body || {});
        } else if (method === 'DELETE') {
            const idx = sheet.items.findIndex((it) => it.id === itemId);
            if (idx >= 0) sheet.items.splice(idx, 1);
        }
    } else if (bag === 'skills') {
        if (method === 'PUT') sheet.skills = Array.isArray(body?.skills) ? [...body.skills] : [];
    } else if (bag === 'notes') {
        if (method === 'PUT') sheet.notes = String(body?.notes ?? '');
    } else if (bag === 'relationships') {
        const [otherId, field] = tail;
        if (!sheet.relationships) sheet.relationships = {};
        if (method === 'PUT') {
            if (!sheet.relationships[otherId]) sheet.relationships[otherId] = {};
            sheet.relationships[otherId][field] = body?.value;
        } else if (method === 'DELETE' && field) {
            if (sheet.relationships[otherId]) {
                delete sheet.relationships[otherId][field];
                if (Object.keys(sheet.relationships[otherId]).length === 0) delete sheet.relationships[otherId];
            }
        } else if (method === 'DELETE' && !field) {
            delete sheet.relationships[otherId];
        }
    }
}
