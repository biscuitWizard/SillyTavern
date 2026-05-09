/**
 * Mock campaign data for the Phase 1 visual proof-of-concept.
 *
 * Real campaigns will live as JSON files under
 * `{handle}/campaigns/{campaign_id}/campaign.json` and be served via
 * `GET /api/gm/campaigns`. This file goes away as soon as that endpoint
 * lands.
 */

/**
 * @typedef {object} MockCampaign
 * @property {string} id
 * @property {string} name
 * @property {string} brief
 * @property {string} ruleset
 * @property {string} bannerTheme One of: shadows, frontier, hollow, default.
 * @property {string} lastPlayed Display string (e.g. "2 days ago").
 * @property {number} sceneCount
 */

/** @type {MockCampaign[]} */
export const mockCampaigns = [
    {
        id: 'ironhold-shadows',
        name: 'Shadows of Ironhold',
        brief: 'A dwarven hold has gone dark; whispers of an old pact stir in the deep. Your party walks the unlit halls, lantern-light barely keeping the silence at bay.',
        ruleset: 'D&D 5e',
        bannerTheme: 'shadows',
        lastPlayed: '2 days ago',
        sceneCount: 7,
    },
    {
        id: 'salt-flats-quietus',
        name: 'The Salt Flats Quietus',
        brief: 'A lone marshal rides into a frontier town where the wells have all turned to glass. The locals have stopped speaking. You suspect they have not stopped listening.',
        ruleset: 'D&D 5e',
        bannerTheme: 'frontier',
        lastPlayed: 'last week',
        sceneCount: 3,
    },
    {
        id: 'hollow-vow',
        name: 'The Hollow Vow',
        brief: 'A ranger returns to the verdant glade she swore to protect, and finds it impossibly larger than before. Something inside has been growing in her absence.',
        ruleset: 'Custom (homebrew)',
        bannerTheme: 'hollow',
        lastPlayed: 'never',
        sceneCount: 0,
    },
];
