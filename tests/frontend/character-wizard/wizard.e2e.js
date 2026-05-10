/**
 * M6 — Character wizard end-to-end (Playwright).
 *
 * Walks the layout-driven character wizard through Identity → Background
 * → Abilities (kind: stats) → Skills (kind: skills) → Confirm and asserts
 * the POST body shape sent to `/api/gm/campaigns/:cid/characters`.
 *
 * Backend is fully stubbed via `page.route(...)`:
 *
 *   - GET  /api/gm/campaigns/:id          → minimal campaign with ruleset_id
 *   - GET  /api/gm/rulesets/:id           → minimal 5e-shaped ruleset
 *   - GET  /api/gm/rulesets/:id/sheet-layout → minimal layout
 *                                              (one `kind: stats` + one `kind: skills`)
 *   - POST /api/gm/campaigns/:id/characters  → captures the request body to a
 *                                              closure variable; returns the
 *                                              created character.
 *
 * The wizard is driven directly by `page.evaluate(...)` importing
 * `openCharacterWizard` from the public ESM module, so the test does
 * NOT depend on the campaign-main shell being rendered.
 *
 * Like the other `tests/frontend/**.e2e.js` skeletons (scene-end,
 * memory-explorer), this test is gated behind a dedicated env var so
 * it does not run in CI by default. Run locally with:
 *
 *   docker compose up -d qdrant && npm start
 *   TTRPG_E2E_WIZARD=1 cd tests && npx playwright test frontend/character-wizard/
 */

import { test, expect } from '@playwright/test';

const E2E_ENABLED = process.env.TTRPG_E2E_WIZARD === '1';

const CAMPAIGN_ID = 'wizard-test-campaign';
const RULESET_ID = 'dnd5e';

/** Minimal stub ruleset — only the fields the wizard actually reads. */
const STUB_RULESET = {
    id: RULESET_ID,
    name: 'D&D 5e (test)',
    abilities: [{ id: 'str', name: 'Strength', stat_key: 'strength' }],
    skills: [{ id: 'athletics', name: 'Athletics', ability_id: 'str', description: '' }],
    dc_bands: [],
    severities: [],
    dc_min: 5,
    dc_max: 30,
    starter_stats: { strength: 10 },
    starter_skills: [],
    sheet_layout: null,
};

/** Minimal layout: one `kind: stats` step + one `kind: skills` step. */
const STUB_LAYOUT = {
    version: 1,
    categories: [
        {
            id: 'abilities',
            label: 'Abilities',
            kind: 'stats',
            wizard_step: true,
            fields: [
                {
                    key: 'strength',
                    label: 'STR',
                    type: 'number',
                    default: 10,
                    min: 1,
                    max: 30,
                    required: true,
                },
            ],
        },
        {
            id: 'skills',
            label: 'Skills',
            kind: 'skills',
            wizard_step: true,
            show_all_from_ruleset: true,
        },
    ],
};

test.describe('Character wizard (M6)', () => {
    test.skip(!E2E_ENABLED, 'Set TTRPG_E2E_WIZARD=1 to enable the character-wizard e2e (requires the app running on the configured baseURL).');

    test('walks Identity → Background → Abilities → Skills → Confirm and POSTs the right body shape', async ({ page }) => {
        /** Captures the POST body the wizard sends. */
        let capturedBody = null;

        // ---- Stub the GM HTTP surface BEFORE navigating. ----
        await page.route(`**/api/gm/campaigns/${CAMPAIGN_ID}`, async (routeReq) => {
            await routeReq.fulfill({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    campaign: {
                        id: CAMPAIGN_ID,
                        name: 'Wizard Test',
                        ruleset_id: RULESET_ID,
                    },
                }),
            });
        });

        await page.route(`**/api/gm/rulesets/${RULESET_ID}`, async (routeReq) => {
            await routeReq.fulfill({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ruleset: STUB_RULESET }),
            });
        });

        await page.route(`**/api/gm/rulesets/${RULESET_ID}/sheet-layout`, async (routeReq) => {
            await routeReq.fulfill({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sheet_layout: STUB_LAYOUT }),
            });
        });

        await page.route(`**/api/gm/campaigns/${CAMPAIGN_ID}/characters`, async (routeReq) => {
            capturedBody = JSON.parse(routeReq.request().postData() || '{}');
            await routeReq.fulfill({
                status: 201,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    character: { id: 'jack', ...capturedBody },
                    opening: null,
                    opening_error: null,
                }),
            });
        });

        // ---- Navigate to the running app. ----
        await page.goto('/');
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });

        // ---- Open the wizard directly. We import the ESM module from
        // the page context so the test does not depend on the
        // campaign-main shell being rendered. ----
        await page.evaluate(async (campaignId) => {
            const mod = await import('/scripts/gm/character-wizard.js');
            mod.openCharacterWizard(campaignId);
        }, CAMPAIGN_ID);

        // The wizard mounts an overlay with `.gm-modal.gm-wizard`.
        const panel = page.locator('.gm-modal.gm-wizard');
        await expect(panel).toBeVisible({ timeout: 10_000 });

        // ---- Step 1: Identity ----
        await panel.locator('.gm-modal-input').first().fill('Jack');
        const textareas = panel.locator('.gm-modal-textarea');
        await textareas.nth(0).fill('Tall and broad-shouldered.');
        await textareas.nth(1).fill('Stoic.');
        await panel.locator('.gm-modal-input').nth(1).fill('Low and clipped.');
        await panel.locator('.gm-modal-footer .gm-primary-btn').click();

        // ---- Step 2: Background ----
        await panel.locator('.gm-modal-textarea').first().fill('Born by the river country.');
        await panel.locator('.gm-modal-footer .gm-primary-btn').click();

        // ---- Step 3: Abilities (kind: stats) — change the seeded value. ----
        // Wait for the layout-driven section to mount.
        await expect(panel.locator('[data-category-id="abilities"]')).toBeVisible({ timeout: 5_000 });
        const strInput = panel.locator('[data-category-id="abilities"] .gm-sheet-field input[type="number"]').first();
        await strInput.fill('14');
        await strInput.blur();
        await panel.locator('.gm-modal-footer .gm-primary-btn').click();

        // ---- Step 4: Skills (kind: skills) — toggle Athletics. ----
        await expect(panel.locator('[data-category-id="skills"]')).toBeVisible();
        await panel.locator('[data-category-id="skills"] input[type="checkbox"]').first().check();
        await panel.locator('.gm-modal-footer .gm-primary-btn').click();

        // ---- Step 5: Confirm — preview should render the picked values. ----
        await expect(panel.locator('.gm-sheet-section').first()).toBeVisible();
        await panel.locator('.gm-modal-footer .gm-primary-btn').click();

        // ---- Wait for the wizard to close after a successful POST. ----
        await expect(panel).toBeHidden({ timeout: 5_000 });

        // ---- Assertions on the captured POST body. ----
        expect(capturedBody).not.toBeNull();
        expect(capturedBody.name).toBe('Jack');
        expect(capturedBody.is_player).toBe(true);
        expect(capturedBody.background).toBe('Born by the river country.');
        expect(capturedBody.sheet).toBeDefined();
        expect(capturedBody.sheet.stats).toBeDefined();
        expect(capturedBody.sheet.stats.strength).toBe(14);
        expect(capturedBody.sheet.skills).toEqual(['athletics']);
        // Bags that are empty should be dropped — the wizard never sent
        // `items` / `notes` / `statuses`, and the layout has no statuses
        // defaults, so the body should not carry empty placeholders.
        expect(capturedBody.sheet.items).toBeUndefined();
        expect(capturedBody.sheet.notes).toBeUndefined();
    });
});
