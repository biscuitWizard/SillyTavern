/**
 * Ask agent loop — the out-of-fiction GM advisor.
 *
 * Modeled on `director/loop.js` but with a different tool set and
 * purpose. The Ask loop receives the player's question, the full PC
 * sheet, RAG context, and a set of tools (mutate_sheet, mutate_identity,
 * add_lore, search_memory, answer_player). It uses forced tool calling
 * (`tool_choice: 'required'`) and loops until `answer_player` is called
 * or the step cap is reached.
 *
 * Unlike the Director loop, the Ask loop is NOT a scene-time construct —
 * it operates outside of fiction and cannot dispatch narrator/actor beats.
 */

import { askTools } from './tools.js';
import { buildAskLoopSystem, buildAskLoopUser } from './prompts.js';
import { LlmError } from '../llm/errors.js';
import { writeAddLore } from '../rag/writers/lore-add.js';
import { buildMemoryRecord } from '../rag/schemas.js';
import { deriveAskLoreId } from './ids.js';
import * as askStore from './store.js';

const MAX_STEPS = 6;

/**
 * @typedef {object} AskLoopEvent
 * @property {string} kind   'status' | 'tool_step' | 'answer' | 'error' | 'identity_edit_request'
 * @property {string} [phase]
 * @property {string} [tool]
 * @property {string} [summary]
 * @property {string} [reply]
 * @property {string} [lore_id]
 * @property {string} [code]
 * @property {string} [message]
 * @property {object} [detail]
 */

/**
 * @param {{
 *   directories: import('../../users.js').UserDirectoryList,
 *   campaign: import('../campaigns/schemas.js').Campaign,
 *   playerCharacter: import('../library/schemas.js').Character | null,
 *   recentSceneHeadlines: string[],
 *   question: string,
 *   client: import('../llm/client.js').LlmClient,
 *   memoryService: import('../rag/service.d.ts').MemoryService | null,
 *   mutateSheet?: (characterId: string, op: any) => Promise<any>,
 *   updateCharacter?: (characterId: string, patch: any) => Promise<any>,
 *   findCharacter?: (id: string) => any,
 *   sceneIndex?: number,
 *   signal?: AbortSignal,
 *   emit: (ev: AskLoopEvent) => Promise<void> | void,
 * }} args
 */
export async function runAskLoop(args) {
    const {
        directories, campaign, playerCharacter, recentSceneHeadlines,
        question, client, memoryService, mutateSheet, updateCharacter,
        findCharacter, sceneIndex = 0, signal, emit,
    } = args;

    const trimmed = String(question || '').trim();
    if (!trimmed) throw new Error('ask loop: question is required');

    const playerEntry = await askStore.append(directories, campaign.id, {
        role: 'player',
        text: trimmed,
    });

    let loreHits = [];
    let characterHits = [];
    let journalHits = [];
    if (memoryService) {
        try {
            loreHits = await memoryService.for_world({
                campaignId: campaign.id,
                queryText: trimmed,
                limit: 6,
            });
        } catch (_) { /* non-fatal */ }
        if (playerCharacter) {
            try {
                const slice = await memoryService.for_character({
                    campaignId: campaign.id,
                    characterId: playerCharacter.id,
                    queryText: trimmed,
                });
                characterHits = slice.character || [];
                journalHits = slice.player_journal || [];
            } catch (_) { /* non-fatal */ }
        }
    }

    const transcript = askStore.readAll(directories, campaign.id);
    const tailEntries = transcript
        .filter(e => e.id !== playerEntry.id)
        .slice(-12);

    /** @type {import('../llm/client.js').ChatMessage[]} */
    const history = [
        { role: 'system', content: buildAskLoopSystem() },
        { role: 'user', content: buildAskLoopUser({
            campaign: { name: campaign.name, brief: campaign.brief, addendum: campaign.addendum },
            playerCharacter,
            recentSceneHeadlines,
            loreHits,
            characterHits,
            journalHits,
            transcriptTail: tailEntries,
            question: trimmed,
        }) },
    ];

    /** @type {AskLoopEvent[]} */
    const steps = [];

    for (let step = 0; step < MAX_STEPS; step++) {
        if (signal?.aborted) {
            await emit({ kind: 'error', code: 'aborted', message: 'Ask loop aborted' });
            return;
        }

        await emit({ kind: 'status', phase: 'thinking' });

        let call;
        try {
            call = await client.tool({
                messages: history,
                tools: askTools,
                tool_choice: 'required',
                signal,
                role: 'ask',
            });
        } catch (err) {
            await emit({
                kind: 'error',
                code: err instanceof LlmError ? err.code : 'unknown',
                message: `ask: ${err?.message || err}`,
            });
            return;
        }

        const toolName = call.name;
        const toolArgs = call.arguments || {};

        history.push({
            role: 'assistant',
            content: null,
            tool_calls: [{
                id: call.id,
                type: 'function',
                function: {
                    name: call.name,
                    arguments: call.raw_arguments || JSON.stringify(toolArgs),
                },
            }],
        });

        if (toolName === 'answer_player') {
            const reply = String(toolArgs.reply || '').trim();
            if (!reply) {
                history.push({ role: 'tool', tool_call_id: call.id, content: 'Error: reply was empty. Call answer_player again with a non-empty reply.' });
                continue;
            }

            let loreId = null;
            if (memoryService && toolArgs.lore_candidate && typeof toolArgs.lore_candidate === 'object') {
                loreId = await tryWriteAskLore({
                    memoryService, campaignId: campaign.id, sceneIndex,
                    playerEntry, candidate: toolArgs.lore_candidate,
                });
            }

            const gmEntry = await askStore.append(directories, campaign.id, {
                role: 'gm',
                text: reply,
                lore_id: loreId,
            });

            await emit({
                kind: 'answer',
                reply,
                lore_id: loreId,
                detail: { steps, player_entry: playerEntry, gm_entry: gmEntry },
            });
            return;
        }

        let toolResult = '';

        if (toolName === 'mutate_sheet') {
            const result = await handleMutateSheet({
                toolArgs, mutateSheet, findCharacter, emit,
            });
            toolResult = result.summary;
            steps.push({ kind: 'tool_step', tool: 'mutate_sheet', summary: result.summary });
            await emit({ kind: 'tool_step', tool: 'mutate_sheet', summary: result.summary, detail: result.detail });
        } else if (toolName === 'mutate_identity') {
            const result = await handleMutateIdentity({
                toolArgs, findCharacter, updateCharacter, emit,
            });
            toolResult = result.summary;
            steps.push({ kind: 'tool_step', tool: 'mutate_identity', summary: result.summary });
            await emit({ kind: 'tool_step', tool: 'mutate_identity', summary: result.summary });
        } else if (toolName === 'search_memory') {
            const result = await handleSearchMemory({
                toolArgs, memoryService, campaignId: campaign.id, playerCharacter,
            });
            toolResult = result.summary;
            steps.push({ kind: 'tool_step', tool: 'search_memory', summary: result.summary });
        } else if (toolName === 'add_lore') {
            const result = await handleAddLore({
                toolArgs, memoryService, campaignId: campaign.id, sceneIndex,
            });
            toolResult = result.summary;
            steps.push({ kind: 'tool_step', tool: 'add_lore', summary: result.summary });
            await emit({ kind: 'tool_step', tool: 'add_lore', summary: result.summary });
        } else {
            toolResult = `Unknown tool "${toolName}". Use answer_player to respond.`;
        }

        history.push({
            role: 'tool',
            tool_call_id: call.id,
            content: toolResult,
        });
    }

    await emit({
        kind: 'error',
        code: 'step_cap',
        message: 'Ask loop reached step cap without calling answer_player.',
    });
}

async function handleMutateSheet({ toolArgs, mutateSheet, findCharacter, emit }) {
    const charId = String(toolArgs.character_id || '').trim();
    const ops = Array.isArray(toolArgs.ops) ? toolArgs.ops : [];
    if (!charId || !ops.length) {
        return { summary: 'mutate_sheet: missing character_id or ops.', detail: null };
    }
    if (typeof mutateSheet !== 'function') {
        return { summary: 'mutate_sheet: not configured.', detail: null };
    }
    const results = [];
    let updated = null;
    for (const op of ops) {
        try {
            const result = await mutateSheet(charId, op);
            if (result) updated = result;
            results.push({ op: op.op, ok: true, summary: `${op.op} ${op.key || op.name || op.item_id || ''}` });
        } catch (err) {
            results.push({ op: op.op, ok: false, summary: `${op.op} failed: ${err?.message || err}` });
        }
    }
    const okCount = results.filter(r => r.ok).length;
    const summary = `Sheet updated: ${okCount}/${results.length} ops applied. ${results.map(r => r.summary).join('; ')}`;
    return { summary, detail: { ops_applied: results, sheet: updated?.sheet } };
}

async function handleMutateIdentity({ toolArgs, findCharacter, updateCharacter, emit }) {
    const charId = String(toolArgs.character_id || '').trim();
    const field = String(toolArgs.field || '').trim();
    const value = String(toolArgs.value ?? '');

    if (!charId || !field) {
        return { summary: 'mutate_identity: missing character_id or field.' };
    }

    const character = findCharacter ? findCharacter(charId) : null;
    if (!character) {
        return { summary: `mutate_identity: character "${charId}" not found.` };
    }

    if (character.is_player) {
        await emit({
            kind: 'identity_edit_request',
            detail: {
                character_id: charId,
                character_name: character.name,
                field,
                current_value: String(character[field] ?? ''),
                proposed_value: value,
                rationale: String(toolArgs.rationale || ''),
            },
        });
        return { summary: `identity_edit_request for ${character.name}.${field} submitted for player approval.` };
    }

    if (typeof updateCharacter === 'function') {
        await updateCharacter(charId, { [field]: value });
    }
    return { summary: `identity_mutated: ${character.name}.${field} updated.` };
}

async function handleSearchMemory({ toolArgs, memoryService, campaignId, playerCharacter }) {
    const query = String(toolArgs.query || '').trim();
    const kind = String(toolArgs.kind || 'world_lore');
    if (!query) return { summary: 'search_memory: empty query.' };
    if (!memoryService) return { summary: 'search_memory: no memory service available.' };

    try {
        const hits = await memoryService.search({
            campaignId,
            kind,
            characterId: kind === 'character_memory' && playerCharacter ? playerCharacter.id : undefined,
            queryText: query,
            limit: 5,
        });
        if (!hits.length) return { summary: `search_memory (${kind}): no results for "${query}".` };
        const lines = hits.map(h => `- ${h.record?.content ? h.record.content.slice(0, 200) : '(empty)'}`);
        return { summary: `search_memory (${kind}): ${hits.length} results:\n${lines.join('\n')}` };
    } catch (err) {
        return { summary: `search_memory failed: ${err?.message || err}` };
    }
}

async function handleAddLore({ toolArgs, memoryService, campaignId, sceneIndex }) {
    const title = String(toolArgs.title || '').trim();
    const body = String(toolArgs.body || '').trim();
    if (!title || !body) return { summary: 'add_lore: missing title or body.' };
    if (!memoryService) return { summary: 'add_lore: no memory service available.' };

    try {
        const result = await writeAddLore({
            memoryService,
            campaignId,
            sceneId: '',
            sceneIndex,
            directorStepIndex: 0,
            decision: { title, body, tags: toolArgs.tags || [] },
        });
        if (result.wrote) {
            return { summary: `add_lore committed: "${title}".` };
        }
        return { summary: 'add_lore: write failed.' };
    } catch (err) {
        return { summary: `add_lore failed: ${err?.message || err}` };
    }
}

async function tryWriteAskLore({ memoryService, campaignId, sceneIndex, playerEntry, candidate }) {
    const title = String(candidate?.title || '').trim();
    const content = String(candidate?.content || '').trim();
    if (!title || !content) return null;

    const tags = Array.isArray(candidate.tags)
        ? candidate.tags.map(String).map(t => t.trim().toLowerCase()).filter(Boolean).slice(0, 8)
        : [];
    const entryKind = candidate.entry_kind || 'custom';

    const id = deriveAskLoreId({
        campaignId,
        askEntryId: playerEntry.id,
        content: `${title}\n${content}`,
    });
    const record = buildMemoryRecord({
        id,
        kind: 'world_lore',
        scope_id: campaignId,
        content: `${title}\n\n${content}`,
        tags,
        importance: 0.55,
        valence: 0,
        temporally_blind: false,
        source: `ask_mode:${playerEntry.id}`,
        scene_index: sceneIndex,
        world_lore: {
            origin: 'generated',
            source_type: 'ask_mode',
            scene_id: null,
            entry_kind: entryKind,
            title,
        },
    });
    try {
        await memoryService.write({ campaignId, record });
        return id;
    } catch (err) {
        console.warn('[gm.ask] lore write failed', err?.message || err);
        return null;
    }
}
