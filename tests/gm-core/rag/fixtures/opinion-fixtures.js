/**
 * Fixture transcripts for the opinion-extractor prompt tuning + lock-in
 * regression test (Phase 7 / `prompt-tune-opinion`).
 *
 * Each fixture has:
 *   - `name`              human-readable label.
 *   - `character`         the active character whose voice the extractor
 *                         is asked to capture.
 *   - `transcriptTail`    a recent-transcript excerpt formatted as the
 *                         loop would format it (`Name: text` per line).
 *   - `lastMessage`       the actor's most-recent utterance — this is
 *                         the line the extractor decides on.
 *   - `expected`          ground-truth: { is_significant, memories?[] }.
 *                         Used both to author the system prompt and to
 *                         score future prompt variants.
 *
 * The current locked prompt (`writers/opinion.js` SYSTEM_PROMPT) is
 * the best of the three variants a `best-of-n-runner` subagent ran
 * against this fixture set; future prompt edits should preserve the
 * matching expected behaviour or update the fixture intentionally.
 *
 * The extractor is run by the unit test against a fake LLM that
 * returns the exact `expected` payload, so the tests do not require
 * a real model. The fixtures themselves are the regression surface.
 */

const amelia = {
    id: 'amelia',
    campaign_id: 'demo',
    name: 'Amelia',
    is_player: false,
    appearance: 'A wiry rogue in a green hood.',
    personality: 'Observant; slow to trust; loyal once won.',
    voice: 'Wry; understated; rare smiles.',
    background: 'Grew up running messages on the Old Roads.',
    sheet: { stats: {}, statuses: {}, items: [], skills: [], notes: '' },
    st_card_avatar: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
};

const bran = {
    ...amelia,
    id: 'bran',
    name: 'Bran',
    appearance: 'A bearded blacksmith in a leather apron.',
    personality: 'Plainspoken; values clear talk over flourish.',
    voice: 'Low; deliberate; one-sentence answers.',
    background: 'Forged the king\'s guard\'s blades for ten years.',
};

export const OPINION_FIXTURES = [
    {
        name: 'amelia commits to a debt — clear opinion-formation',
        character: amelia,
        transcriptTail: [
            'Player: I draw my sword and step between the wolf and Amelia.',
            'Narrator: The wolf hesitates, then bolts. Amelia exhales for the first time in a minute.',
        ].join('\n'),
        lastMessage: 'I owe you my life, stranger. I do not say that lightly. When you need me, ask.',
        expected: {
            is_significant: true,
            memories: [
                {
                    content: 'I owe the stranger my life and have promised them my service when they call.',
                    importance: 0.85,
                    valence: 0.8,
                    tags: ['debt', 'promise', 'stranger'],
                },
            ],
        },
    },
    {
        name: 'bran reveals a secret — character-defining beat',
        character: bran,
        transcriptTail: [
            'Player: Why did you hide the heirloom hammer in the smithy wall?',
            'Bran: *long silence*',
        ].join('\n'),
        lastMessage: 'Because the king\'s guard would have melted it. My grandfather forged that hammer for the rebellion. It is not a tool — it is a name.',
        expected: {
            is_significant: true,
            memories: [
                {
                    content: 'The heirloom hammer is my grandfather\'s — a relic of the rebellion the king\'s guard would destroy.',
                    importance: 0.9,
                    valence: 0.4,
                    tags: ['hammer', 'rebellion', 'grandfather', 'secret'],
                },
            ],
        },
    },
    {
        name: 'pure narration — false-positive guard must hold',
        character: amelia,
        transcriptTail: [
            'Narrator: A breeze stirs the ash leaves. The road forks ahead.',
            'Player: We take the left fork.',
        ].join('\n'),
        lastMessage: 'Looks like rain.',
        expected: { is_significant: false, memories: [] },
    },
    {
        name: 'banter / greeting — false-positive guard must hold',
        character: bran,
        transcriptTail: [
            'Player: Morning, smith.',
            'Narrator: Bran nods over the anvil without looking up.',
        ].join('\n'),
        lastMessage: 'Morning. Cold one.',
        expected: { is_significant: false, memories: [] },
    },
];
