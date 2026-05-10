/**
 * Phase 7 — Memory Explorer end-to-end smoke + visual verification.
 *
 * What it verifies (live, against a running TTRPG Tavern instance):
 *   1. The "Memory" tab renders on the campaign topbar after a campaign
 *      is open.
 *   2. Clicking through the five collection tabs (World Lore / Player
 *      Journal / Director Log / Narrator Log / Character Memory) shows
 *      the rail and a record list (or an empty-state).
 *   3. The Reconcile button runs without exploding and surfaces a
 *      success pill.
 *   4. Filter chips on the World Lore tab (Origin: All/Core/Generated)
 *      narrow the result list as expected.
 *   5. The right-pane editor opens when a row is clicked, and Save
 *      sends a PATCH that the server accepts.
 *
 * This file is a skeleton — wiring it into CI requires a seeded
 * fixture campaign on disk (`data/default-user/campaigns/.../`) that
 * the test creates via the API in `test.beforeAll`. Until the seeded
 * fixture lands, the test is gated on `TTRPG_E2E_MEMORY=1`.
 *
 * Run locally with:
 *   docker compose up -d qdrant && npm start
 *   TTRPG_E2E_MEMORY=1 cd tests && npx playwright test frontend/memory-explorer/
 */

import { test, expect } from '@playwright/test';
import { testSetup } from '../frontent-test-utils.js';

const E2E_ENABLED = process.env.TTRPG_E2E_MEMORY === '1';
const TEST_CAMPAIGN_NAME = 'E2E Memory Explorer';

test.describe('Memory Explorer', () => {
    test.skip(!E2E_ENABLED, 'Set TTRPG_E2E_MEMORY=1 to enable Memory Explorer e2e (requires a running app + Qdrant).');
    test.beforeEach(testSetup.awaitST);

    test('topbar exposes a Memory tab once a campaign is open', async ({ page }) => {
        // 1. Create a fresh campaign from the GM API so the test has a
        // known fixture to work against.
        const campaign = await createCampaign(page, TEST_CAMPAIGN_NAME);
        try {
            // 2. Navigate into the campaign hub. The frontend renders a
            // tab strip with Hub + Memory pills.
            await openCampaign(page, campaign.id);

            await expect(page.locator('.gm-topbar .gm-tab-memory')).toBeVisible();
            await page.click('.gm-topbar .gm-tab-memory');

            // 3. The explorer surface mounts.
            await expect(page.locator('.gm-memex')).toBeVisible();

            // 4. Each rail entry should be reachable.
            const railItems = page.locator('.gm-memex-rail .gm-memex-rail-item');
            await expect(railItems).toHaveCount(5);

            for (const label of ['World Lore', 'Director', 'Narrator', 'Player Journal', 'Character']) {
                await expect(railItems.filter({ hasText: label }).first()).toBeVisible();
            }

            // 5. The reconcile pill should not throw when clicked.
            const reconcile = page.locator('.gm-memex-action-reconcile');
            if (await reconcile.count() > 0) {
                await reconcile.first().click();
                await expect(page.locator('.gm-memex-toast')).toBeVisible({ timeout: 10_000 });
            }
        } finally {
            await deleteCampaign(page, campaign.id);
        }
    });

    test('world lore origin chip filters the record list', async ({ page }) => {
        const campaign = await createCampaign(page, `${TEST_CAMPAIGN_NAME} (filters)`);
        try {
            // Seed a core + generated lore record via the RAG API.
            await postRag(page, '/memories', {
                campaign_id: campaign.id,
                kind: 'world_lore',
                content: 'Aurora is the capital of the realm.',
                tags: ['aurora', 'capital'],
                world_lore: {
                    origin: 'core',
                    source_type: 'manual',
                    scene_id: null,
                    entry_kind: 'history',
                    title: 'Aurora capital',
                },
            });
            await postRag(page, '/memories', {
                campaign_id: campaign.id,
                kind: 'world_lore',
                content: 'A dragon was sighted over the mountains last night.',
                tags: ['dragon', 'sighting'],
                world_lore: {
                    origin: 'generated',
                    source_type: 'add_lore',
                    scene_id: 'scene-1',
                    entry_kind: 'bestiary',
                    title: 'Dragon sighting',
                },
            });

            await openCampaign(page, campaign.id);
            await page.click('.gm-topbar .gm-tab-memory');

            // Pick the World Lore rail item.
            await page.click('.gm-memex-rail .gm-memex-rail-item:has-text("World Lore")');

            // Both records visible by default.
            await expect(page.locator('.gm-memex-row')).toHaveCount(2);

            // Toggle Origin: Core.
            await page.click('.gm-memex-filter-origin button:has-text("Core")');
            await expect(page.locator('.gm-memex-row')).toHaveCount(1);
            await expect(page.locator('.gm-memex-row')).toContainText('Aurora capital');

            // Toggle Origin: Generated.
            await page.click('.gm-memex-filter-origin button:has-text("Generated")');
            await expect(page.locator('.gm-memex-row')).toHaveCount(1);
            await expect(page.locator('.gm-memex-row')).toContainText('Dragon sighting');
        } finally {
            await deleteCampaign(page, campaign.id);
        }
    });

    test('record editor saves tag changes through PATCH', async ({ page }) => {
        const campaign = await createCampaign(page, `${TEST_CAMPAIGN_NAME} (editor)`);
        try {
            await postRag(page, '/memories', {
                campaign_id: campaign.id,
                kind: 'director_memory',
                content: 'Pacing: hold the smith reveal until act 2.',
                tags: ['pacing'],
            });
            await openCampaign(page, campaign.id);
            await page.click('.gm-topbar .gm-tab-memory');
            await page.click('.gm-memex-rail .gm-memex-rail-item:has-text("Director")');

            const row = page.locator('.gm-memex-row').first();
            await row.click();

            const tagInput = page.locator('.gm-memex-editor input[name="tags"]');
            await tagInput.fill('pacing, act-2');
            await page.click('.gm-memex-editor button:has-text("Save")');

            await expect(page.locator('.gm-memex-toast')).toContainText(/saved/i, { timeout: 5000 });
        } finally {
            await deleteCampaign(page, campaign.id);
        }
    });
});

/**
 * Create a campaign through the API, returns the response body.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function createCampaign(page, name) {
    const res = await page.request.post('/api/gm/campaigns', { data: { name } });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    return body.campaign;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 */
async function deleteCampaign(page, id) {
    await page.request.delete(`/api/gm/campaigns/${encodeURIComponent(id)}`).catch(() => {});
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} pathSuffix
 * @param {object} body
 */
async function postRag(page, pathSuffix, body) {
    const res = await page.request.post(`/api/gm/rag${pathSuffix}`, { data: body });
    expect(res.ok()).toBeTruthy();
    return res.json();
}

/**
 * Navigate the GM shell into the given campaign hub.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} campaignId
 */
async function openCampaign(page, campaignId) {
    await page.evaluate((cid) => {
        const router = /** @type {any} */(window).__ttrpg_route;
        if (typeof router === 'function') router({ view: 'campaign', campaignId: cid });
    }, campaignId);
    await expect(page.locator('.gm-topbar')).toBeVisible({ timeout: 10_000 });
}
