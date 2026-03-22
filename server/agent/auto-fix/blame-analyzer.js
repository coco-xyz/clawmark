/**
 * ClawMark — Blame Analyzer (#86)
 *
 * Parses stack traces to identify source files and lines, then uses
 * git blame to find the last committer and recent changes for the
 * error location.
 */

'use strict';

const { execFile } = require('child_process');
const path = require('path');

const MAX_FRAMES = 5;
const BLAME_TIMEOUT = 10000; // 10s

/**
 * Parse a stack trace string into structured frames.
 *
 * Supports V8-style traces:
 *   at functionName (file:line:col)
 *   at file:line:col
 *
 * @param {string} stack - Raw stack trace
 * @returns {Array<{ func: string, file: string, line: number, col: number }>}
 */
function parseStackTrace(stack) {
    if (!stack) return [];

    const frames = [];
    const lines = stack.split('\n');

    for (const raw of lines) {
        const trimmed = raw.trim();
        if (!trimmed.startsWith('at ')) continue;

        const frame = parseFrame(trimmed);
        if (frame && frame.file && frame.line) {
            frames.push(frame);
        }
        if (frames.length >= MAX_FRAMES) break;
    }

    return frames;
}

/**
 * Parse a single stack frame line.
 */
function parseFrame(line) {
    // "at funcName (file:line:col)"
    const parenMatch = line.match(/^at\s+(.+?)\s+\((.+):(\d+):(\d+)\)$/);
    if (parenMatch) {
        return {
            func: parenMatch[1],
            file: parenMatch[2],
            line: parseInt(parenMatch[3], 10),
            col: parseInt(parenMatch[4], 10),
        };
    }

    // "at file:line:col"
    const directMatch = line.match(/^at\s+(.+):(\d+):(\d+)$/);
    if (directMatch) {
        return {
            func: '<anonymous>',
            file: directMatch[1],
            line: parseInt(directMatch[2], 10),
            col: parseInt(directMatch[3], 10),
        };
    }

    return null;
}

/**
 * Resolve a URL or path from a stack trace to a local file path.
 * Strips protocol + domain, then resolves relative to repoRoot.
 *
 * @param {string} fileRef - File reference from stack trace
 * @param {string} repoRoot - Root of the git repository
 * @param {object} [opts]
 * @param {string[]} [opts.sourceRoots] - Directories to search for the file
 * @returns {string|null} Resolved absolute path, or null if not resolvable
 */
function resolveFilePath(fileRef, repoRoot, opts = {}) {
    if (!fileRef || !repoRoot) return null;

    // Strip URL prefix (http://host:port/path → path)
    let relative = fileRef
        .replace(/^https?:\/\/[^/]+\/?/, '')
        .replace(/^file:\/\//, '');

    // Strip webpack/vite prefixes
    relative = relative
        .replace(/^webpack(-internal)?:\/\/\//, '')
        .replace(/^\.\//g, '');

    // Prevent path traversal
    if (relative.includes('..')) return null;

    // Try direct resolution
    const direct = path.resolve(repoRoot, relative);
    if (direct.startsWith(repoRoot + path.sep)) return direct;

    // Try source roots
    const sourceRoots = opts.sourceRoots || ['src', 'server', 'lib', 'extension', 'dashboard/src'];
    for (const root of sourceRoots) {
        const candidate = path.resolve(repoRoot, root, relative);
        if (candidate.startsWith(repoRoot + path.sep)) return candidate;
    }

    return null;
}

/**
 * Run `git blame` on a specific file and line range.
 *
 * @param {string} repoRoot - Git repo root
 * @param {string} filePath - Absolute path to the file
 * @param {number} line - Center line number
 * @param {object} [opts]
 * @param {number} [opts.context=3] - Lines of context around the target line
 * @param {Function} [opts.execFn] - Override for execFile (testing)
 * @returns {Promise<{ commits: Array<{ hash, author, date, line, content }>, file: string }>}
 */
async function gitBlame(repoRoot, filePath, line, opts = {}) {
    const context = opts.context ?? 3;
    const startLine = Math.max(1, line - context);
    const endLine = line + context;

    const relPath = path.relative(repoRoot, filePath);
    const args = ['blame', '--porcelain', `-L${startLine},${endLine}`, '--', relPath];

    const exec = opts.execFn || execFilePromise;
    const stdout = await exec('git', args, { cwd: repoRoot, timeout: BLAME_TIMEOUT });

    return { commits: parseBlamePorcelain(stdout), file: relPath };
}

/**
 * Parse git blame --porcelain output into structured data.
 */
function parseBlamePorcelain(output) {
    if (!output) return [];

    const commits = [];
    const lines = output.split('\n');
    let current = null;
    const commitInfo = {};

    for (const line of lines) {
        // New blame entry: "<hash> <orig-line> <final-line> [<num-lines>]"
        const headerMatch = line.match(/^([0-9a-f]{40})\s+(\d+)\s+(\d+)/);
        if (headerMatch) {
            if (current) commits.push(current);
            const hash = headerMatch[1];
            current = {
                hash,
                origLine: parseInt(headerMatch[2], 10),
                finalLine: parseInt(headerMatch[3], 10),
                author: commitInfo[hash]?.author || null,
                date: commitInfo[hash]?.date || null,
                content: null,
            };
            continue;
        }

        if (!current) continue;

        if (line.startsWith('author ')) {
            current.author = line.slice(7);
            if (!commitInfo[current.hash]) commitInfo[current.hash] = {};
            commitInfo[current.hash].author = current.author;
        } else if (line.startsWith('author-time ')) {
            const ts = parseInt(line.slice(12), 10);
            current.date = new Date(ts * 1000).toISOString();
            if (!commitInfo[current.hash]) commitInfo[current.hash] = {};
            commitInfo[current.hash].date = current.date;
        } else if (line.startsWith('\t')) {
            current.content = line.slice(1);
        }
    }

    if (current) commits.push(current);
    return commits;
}

/**
 * Get recent git log for a file.
 *
 * @param {string} repoRoot
 * @param {string} filePath - Absolute path
 * @param {object} [opts]
 * @param {number} [opts.limit=5]
 * @param {Function} [opts.execFn]
 * @returns {Promise<Array<{ hash, author, date, message }>>}
 */
async function gitLog(repoRoot, filePath, opts = {}) {
    const limit = opts.limit ?? 5;
    const relPath = path.relative(repoRoot, filePath);
    const args = ['log', `--max-count=${limit}`, '--format=%H%n%an%n%aI%n%s%n---', '--', relPath];

    const exec = opts.execFn || execFilePromise;
    const stdout = await exec('git', args, { cwd: repoRoot, timeout: BLAME_TIMEOUT });

    return parseGitLog(stdout);
}

function parseGitLog(output) {
    if (!output) return [];

    const entries = output.split('\n---\n').filter(Boolean);
    return entries.map(entry => {
        const [hash, author, date, ...msgParts] = entry.split('\n');
        return { hash, author, date, message: msgParts.join('\n') };
    }).filter(e => e.hash);
}

/**
 * Full blame analysis for an error event.
 *
 * @param {object} errorEvent - Perception event { stack, source, line, url }
 * @param {string} repoRoot - Git repository root
 * @param {object} [opts]
 * @returns {Promise<{ frames, blame, recentChanges, sourceFile } | null>}
 */
async function analyzeBlame(errorEvent, repoRoot, opts = {}) {
    const frames = parseStackTrace(errorEvent.stack);
    if (frames.length === 0 && errorEvent.source && errorEvent.line) {
        frames.push({
            func: '<error-source>',
            file: errorEvent.source,
            line: errorEvent.line,
            col: 0,
        });
    }

    if (frames.length === 0) return null;

    // Try each frame until we find one that resolves to a file
    for (const frame of frames) {
        const resolved = resolveFilePath(frame.file, repoRoot, opts);
        if (!resolved) continue;

        try {
            const blame = await gitBlame(repoRoot, resolved, frame.line, opts);
            const recentChanges = await gitLog(repoRoot, resolved, opts);

            return {
                frames,
                blame,
                recentChanges,
                sourceFile: path.relative(repoRoot, resolved),
                errorLine: frame.line,
                errorFunc: frame.func,
            };
        } catch {
            // File might not exist in repo — try next frame
            continue;
        }
    }

    return null;
}

/**
 * Promise wrapper around execFile.
 */
function execFilePromise(cmd, args, opts) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { ...opts, maxBuffer: 1024 * 1024 }, (err, stdout) => {
            if (err) return reject(err);
            resolve(stdout);
        });
    });
}

module.exports = {
    parseStackTrace,
    parseFrame,
    resolveFilePath,
    gitBlame,
    gitLog,
    parseBlamePorcelain,
    parseGitLog,
    analyzeBlame,
};
