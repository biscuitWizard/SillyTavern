/**
 * Character drawer DOM smoke test (Playwright).
 *
 * Verifies that:
 *   - `#gm-character-drawer` exists in the DOM after boot
 *   - The drawer shows "Open a campaign" when no campaign is loaded
 *   - The ST panels (#rm_ch_create_block, etc.) are hidden
 */

import { test, expect } from '@playwright/test';
import { testSetup } from '../frontent-test-utils.js';

test.describe('Character drawer', () => {
    test('drawer mount exists in the DOM', async ({ page }) => {
        await testSetup.awaitST({ page });
        const drawer = page.locator('#gm-character-drawer');
        await expect(drawer).toBeAttached();
    });

    test('shows empty state text when no campaign is open', async ({ page }) => {
        await testSetup.awaitST({ page });
        const emptyText = page.locator('.gm-drawer-empty-text');
        await expect(emptyText).toContainText('Open a campaign');
    });

    test('ST character panels are hidden', async ({ page }) => {
        await testSetup.awaitST({ page });
        const createBlock = page.locator('#rm_ch_create_block');
        await expect(createBlock).toBeHidden();
        const groupBlock = page.locator('#rm_group_chats_block');
        await expect(groupBlock).toBeHidden();
        const charBlock = page.locator('#rm_characters_block');
        await expect(charBlock).toBeHidden();
    });
});
