/**
 * Shared I/O helpers for the GM core stores.
 *
 * Stores under `src/gm-core/` are JSON-on-disk per ADR 0003. They all need:
 *   - atomic writes (so a crash mid-write does not leave a half-file),
 *   - ensure-directory before write,
 *   - consistent slug generation for ids,
 *   - read-or-default helpers.
 */

import fs from 'node:fs';
import path from 'node:path';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

/**
 * Ensure a directory exists; create recursively if not.
 * @param {string} dir
 */
export function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/**
 * Read a JSON file. Returns `fallback` if the file does not exist; throws on
 * other I/O errors and on parse errors.
 * @template T
 * @param {string} filePath
 * @param {T} fallback
 * @returns {T}
 */
export function readJson(filePath, fallback) {
    if (!fs.existsSync(filePath)) {
        return fallback;
    }
    const text = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(text);
}

/**
 * Write a JSON file atomically. Ensures the parent directory exists.
 * @param {string} filePath
 * @param {unknown} data
 */
export function writeJson(filePath, data) {
    ensureDir(path.dirname(filePath));
    writeFileAtomicSync(filePath, JSON.stringify(data, null, 4), 'utf8');
}

/**
 * Slugify a free-form string into a filesystem-safe id. Lowercases, replaces
 * runs of non-alphanumeric characters with `-`, and trims leading/trailing
 * dashes. Returns an empty string if nothing usable remains; callers are
 * expected to fall back to a uuid-style id.
 * @param {string} input
 * @returns {string}
 */
export function slugify(input) {
    if (!input) return '';
    return String(input)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
}

/**
 * Build a unique id from a name. If `slugify(name)` collides with an existing
 * id in `existing`, append a short suffix derived from the current time.
 * @param {string} name
 * @param {Iterable<string>} existing
 * @returns {string}
 */
export function uniqueId(name, existing) {
    const base = slugify(name) || 'item';
    const taken = new Set(existing);
    if (!taken.has(base)) return base;
    const suffix = Date.now().toString(36).slice(-4);
    let candidate = `${base}-${suffix}`;
    let n = 2;
    while (taken.has(candidate)) {
        candidate = `${base}-${suffix}-${n++}`;
    }
    return candidate;
}

/**
 * Current ISO 8601 timestamp.
 * @returns {string}
 */
export function nowIso() {
    return new Date().toISOString();
}

/**
 * Recursively remove a directory if it exists. No-op when missing.
 * @param {string} dir
 */
export function removeDir(dir) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
