/**
 * Ask-mode tool definitions.
 *
 * The Ask agent loop uses forced tool calling (`tool_choice: 'required'`)
 * with a small set of tools. `answer_player` is the terminal tool — when
 * called, the loop ends and the reply is surfaced.
 */

/** @type {import('../llm/client.js').ToolDefinition[]} */
export const askTools = [
    {
        type: 'function',
        function: {
            name: 'answer_player',
            description: 'Return the final answer to the player. This ends the Ask exchange. Use this AFTER performing any requested mutations.',
            parameters: {
                type: 'object',
                properties: {
                    reply: {
                        type: 'string',
                        description: 'The GM\'s out-of-fiction answer to the player. 1-4 short paragraphs of clear, conversational prose.',
                    },
                    lore_candidate: {
                        type: ['object', 'null'],
                        description: 'Set when the answer reveals a NEW durable world fact. Set to null otherwise.',
                        properties: {
                            title: { type: 'string' },
                            content: { type: 'string' },
                            tags: { type: 'array', items: { type: 'string' }, maxItems: 8 },
                            entry_kind: {
                                type: 'string',
                                enum: [
                                    'location', 'faction', 'culture', 'people', 'history',
                                    'magic', 'artifact', 'bestiary', 'cosmology', 'language',
                                    'pantheon', 'custom',
                                ],
                            },
                        },
                        required: ['title', 'content', 'tags', 'entry_kind'],
                    },
                },
                required: ['reply', 'lore_candidate'],
                additionalProperties: false,
            },
            strict: false,
        },
    },
    {
        type: 'function',
        function: {
            name: 'mutate_sheet',
            description: 'Apply one or more mechanical edits to the player character\'s sheet (stats, statuses, items). Use when the player explicitly asks you to update their sheet.',
            parameters: {
                type: 'object',
                properties: {
                    character_id: { type: 'string', description: 'The PC\'s character id.' },
                    ops: {
                        type: 'array',
                        description: 'Ordered list of sheet mutation operations.',
                        items: {
                            type: 'object',
                            properties: {
                                op: {
                                    type: 'string',
                                    enum: ['set_stat', 'adjust_stat', 'clear_stat', 'set_status', 'clear_status', 'add_item', 'update_item', 'remove_item'],
                                },
                                key: { type: 'string' },
                                value: {},
                                delta: { type: 'number' },
                                name: { type: 'string' },
                                description: { type: 'string' },
                                item_id: { type: 'string' },
                                influences: { type: 'array', items: { type: 'string' } },
                            },
                            required: ['op'],
                        },
                    },
                    rationale: {
                        type: 'string',
                        minLength: 80,
                        maxLength: 600,
                        description: 'Reason out loud BEFORE choosing the action. Required structure (one short sentence per part): (1) What did the player ask? (2) What is the expected outcome? (3) Why this tool? (4) What do I tell the player next?',
                    },
                },
                required: ['character_id', 'ops', 'rationale'],
                additionalProperties: false,
            },
            strict: false,
        },
    },
    {
        type: 'function',
        function: {
            name: 'mutate_identity',
            description: 'Rewrite one of the player character\'s permanent identity fields. Use ONLY for major, lasting changes the player explicitly asked for.',
            parameters: {
                type: 'object',
                properties: {
                    character_id: { type: 'string' },
                    field: {
                        type: 'string',
                        enum: ['appearance', 'personality', 'voice', 'background'],
                    },
                    value: { type: 'string', description: 'The replacement text for this field.' },
                    rationale: {
                        type: 'string',
                        minLength: 80,
                        maxLength: 600,
                        description: 'Reason out loud BEFORE choosing the action. Required structure (one short sentence per part): (1) What did the player ask? (2) What is the expected outcome? (3) Why this tool? (4) What do I tell the player next?',
                    },
                },
                required: ['character_id', 'field', 'value', 'rationale'],
                additionalProperties: false,
            },
            strict: false,
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_memory',
            description: 'Search campaign memories (world lore, character memories, player journal) for relevant information. Use when the player asks about something and you need more context.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The search query.' },
                    kind: {
                        type: 'string',
                        enum: ['world_lore', 'character_memory', 'player_journal'],
                        description: 'Which memory collection to search.',
                    },
                },
                required: ['query', 'kind'],
                additionalProperties: false,
            },
            strict: false,
        },
    },
    {
        type: 'function',
        function: {
            name: 'add_lore',
            description: 'Record a new world fact into the campaign lore. Use when the player establishes new canonical information.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string' },
                    body: { type: 'string' },
                    tags: { type: 'array', items: { type: 'string' }, maxItems: 8 },
                    rationale: {
                        type: 'string',
                        minLength: 80,
                        maxLength: 600,
                        description: 'Reason out loud BEFORE choosing the action. Required structure (one short sentence per part): (1) What did the player ask? (2) What is the expected outcome? (3) Why this tool? (4) What do I tell the player next?',
                    },
                },
                required: ['title', 'body', 'tags', 'rationale'],
                additionalProperties: false,
            },
            strict: false,
        },
    },
];
