/**
 * ClawMark — Fix Generator (#86)
 *
 * Uses LLM (Gemini) to analyze error context — stack trace, session replay,
 * blame info, related code — and generate a proposed code fix with
 * confidence scoring.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;
const MAX_FILE_CONTENT = 8000;  // chars to include in prompt
const MAX_CONTEXT_FILES = 3;

const SYSTEM_PROMPT = `You are an expert JavaScript/Node.js developer working on ClawMark, a web annotation and error monitoring platform. Your task is to analyze a runtime error and generate a targeted code fix.

Guidelines:
- Analyze the error message, stack trace, and source code carefully
- Generate the MINIMAL fix needed — do not refactor unrelated code
- Preserve existing code style (indentation, quotes, semicolons)
- Consider edge cases the fix might introduce
- If the fix requires changes to multiple files, include all changes
- Be honest about confidence — if the error is ambiguous or the fix is risky, say so

Respond with valid JSON:
{
  "confidence": number (0.0 to 1.0),
  "analysis": string (2-3 sentences explaining the root cause),
  "fix": {
    "files": [
      {
        "path": string (relative to repo root),
        "original": string (the exact code to replace — enough context to be unique),
        "replacement": string (the fixed code)
      }
    ],
    "description": string (1-2 sentences describing what the fix does),
    "test_plan": string (how to verify the fix works)
  },
  "risks": string (potential risks or side effects of this fix, or "none" if safe),
  "alternative": string | null (alternative approach if confidence < 0.8)
}

Rules:
- "original" must be an EXACT substring of the current file content (whitespace-sensitive)
- Include enough surrounding context in "original" to make the match unique
- confidence 0.9+: straightforward fix (typo, null check, off-by-one)
- confidence 0.7-0.9: likely correct but may need review
- confidence < 0.7: uncertain — provide alternative approach
- If you cannot determine a fix, set confidence to 0 and explain in analysis`;

/**
 * Build the user prompt with full error context.
 */
function buildFixPrompt(errorEvent, blameResult, opts = {}) {
    const parts = [];

    // Error info
    parts.push('## Error');
    parts.push(`**Type:** ${errorEvent.type || 'unknown'}`);
    parts.push(`**Message:** ${(errorEvent.message || '').slice(0, 500)}`);
    parts.push(`**Severity:** ${errorEvent.severity || 'error'}`);
    parts.push(`**URL:** ${errorEvent.url || 'N/A'}`);

    if (errorEvent.stack) {
        parts.push('\n**Stack Trace:**');
        parts.push('```');
        parts.push(errorEvent.stack.slice(0, 2000));
        parts.push('```');
    }

    // Blame info
    if (blameResult) {
        parts.push(`\n## Source File: \`${blameResult.sourceFile}\` (line ${blameResult.errorLine})`);

        if (blameResult.blame && blameResult.blame.commits.length > 0) {
            parts.push('\n**Git Blame (surrounding lines):**');
            parts.push('```');
            for (const c of blameResult.blame.commits) {
                parts.push(`L${c.finalLine}: ${c.content || ''}  // ${c.author} (${c.hash?.slice(0, 7)})`);
            }
            parts.push('```');
        }

        if (blameResult.recentChanges && blameResult.recentChanges.length > 0) {
            parts.push('\n**Recent changes to this file:**');
            for (const c of blameResult.recentChanges.slice(0, 3)) {
                parts.push(`- ${c.hash?.slice(0, 7)} ${c.author}: ${c.message}`);
            }
        }
    }

    // Source code context
    if (opts.fileContents) {
        parts.push('\n## File Contents');
        for (const [filePath, content] of Object.entries(opts.fileContents)) {
            parts.push(`\n### \`${filePath}\``);
            parts.push('```javascript');
            parts.push(content.slice(0, MAX_FILE_CONTENT));
            parts.push('```');
        }
    }

    // Reproduction context
    if (opts.reproduction) {
        parts.push('\n## Reproduction Steps');
        parts.push(opts.reproduction.slice(0, 1000));
    }

    // Session context
    if (opts.sessionContext) {
        parts.push('\n## Session Context');
        parts.push(opts.sessionContext.slice(0, 500));
    }

    return parts.join('\n');
}

/**
 * Read source file content around the error line.
 *
 * @param {string} filePath - Absolute path
 * @param {number} errorLine - Error line number
 * @param {number} [context=30] - Lines of context
 * @returns {string|null}
 */
function readSourceContext(filePath, errorLine, context = 30) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const start = Math.max(0, errorLine - context - 1);
        const end = Math.min(lines.length, errorLine + context);
        return lines.slice(start, end).map((l, i) => {
            const lineNum = start + i + 1;
            const marker = lineNum === errorLine ? '>>>' : '   ';
            return `${marker} ${lineNum}: ${l}`;
        }).join('\n');
    } catch {
        return null;
    }
}

/**
 * Generate a fix proposal using LLM.
 *
 * @param {object} params
 * @param {object} params.errorEvent - Perception event
 * @param {object} [params.blameResult] - Output from blame-analyzer
 * @param {string} params.repoRoot - Git repository root
 * @param {string} params.apiKey - Gemini API key
 * @param {object} [params.sessionContext] - Session correlation data
 * @param {Function} [params.callAI] - Override AI call (for testing)
 * @returns {Promise<{ confidence, analysis, fix, risks, alternative, isDraft }>}
 */
async function generateFix(params) {
    const { errorEvent, blameResult, repoRoot, apiKey, sessionContext, callAI } = params;
    const confidenceThreshold = params.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

    // Gather file contents for context
    const fileContents = {};
    if (blameResult && blameResult.sourceFile) {
        const absPath = path.resolve(repoRoot, blameResult.sourceFile);
        const content = readSourceContext(absPath, blameResult.errorLine);
        if (content) {
            fileContents[blameResult.sourceFile] = content;
        }
    }

    // Build prompt
    const userPrompt = buildFixPrompt(errorEvent, blameResult, {
        fileContents,
        reproduction: sessionContext?.report?.timeline,
        sessionContext: sessionContext?.correlation ? JSON.stringify({
            trigger: sessionContext.correlation.trigger,
            url: sessionContext.correlation.session?.url,
        }) : null,
    });

    // Call LLM
    const aiCall = callAI || require('../../ai').callGemini;

    let responseText;
    try {
        responseText = await aiCall(apiKey, SYSTEM_PROMPT, userPrompt);
    } catch (err) {
        return {
            confidence: 0,
            analysis: `LLM call failed: ${err.message}`,
            fix: null,
            risks: 'Could not generate fix',
            alternative: null,
            isDraft: true,
        };
    }

    // Parse and validate
    let result;
    try {
        result = JSON.parse(responseText);
    } catch {
        return {
            confidence: 0,
            analysis: 'LLM returned invalid JSON',
            fix: null,
            risks: 'Could not parse response',
            alternative: null,
            isDraft: true,
        };
    }

    return validateFixResult(result, confidenceThreshold);
}

/**
 * Validate and normalize the LLM fix result.
 */
function validateFixResult(raw, confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD) {
    const confidence = typeof raw.confidence === 'number'
        ? Math.max(0, Math.min(1, raw.confidence))
        : 0;

    const analysis = typeof raw.analysis === 'string'
        ? raw.analysis.slice(0, 1000)
        : 'No analysis provided';

    const risks = typeof raw.risks === 'string'
        ? raw.risks.slice(0, 500)
        : 'unknown';

    const alternative = typeof raw.alternative === 'string'
        ? raw.alternative.slice(0, 500)
        : null;

    let fix = null;
    if (raw.fix && typeof raw.fix === 'object') {
        const files = Array.isArray(raw.fix.files)
            ? raw.fix.files
                .filter(f => f && typeof f.path === 'string' && typeof f.original === 'string' && typeof f.replacement === 'string')
                .slice(0, 5)
                .map(f => ({
                    path: f.path.slice(0, 500),
                    original: f.original.slice(0, 5000),
                    replacement: f.replacement.slice(0, 5000),
                }))
            : [];

        if (files.length > 0) {
            fix = {
                files,
                description: typeof raw.fix.description === 'string' ? raw.fix.description.slice(0, 500) : '',
                test_plan: typeof raw.fix.test_plan === 'string' ? raw.fix.test_plan.slice(0, 500) : '',
            };
        }
    }

    const isDraft = confidence < confidenceThreshold;

    return { confidence, analysis, fix, risks, alternative, isDraft };
}

/**
 * Apply fix to files on disk (for validation before committing).
 *
 * @param {object} fix - Fix object from generateFix
 * @param {string} repoRoot - Git repository root
 * @returns {{ applied: string[], failed: string[] }}
 */
function applyFix(fix, repoRoot) {
    if (!fix || !fix.files) return { applied: [], failed: [] };

    const applied = [];
    const failed = [];

    for (const file of fix.files) {
        const absPath = path.resolve(repoRoot, file.path);

        // Path traversal guard
        if (!absPath.startsWith(repoRoot + path.sep)) {
            failed.push(`${file.path}: path traversal blocked`);
            continue;
        }

        try {
            const content = fs.readFileSync(absPath, 'utf-8');
            if (!content.includes(file.original)) {
                failed.push(`${file.path}: original code not found in file`);
                continue;
            }

            const updated = content.replace(file.original, file.replacement);
            fs.writeFileSync(absPath, updated, 'utf-8');
            applied.push(file.path);
        } catch (err) {
            failed.push(`${file.path}: ${err.message}`);
        }
    }

    return { applied, failed };
}

/**
 * Revert applied fix (restore original content).
 *
 * @param {object} fix - Fix object
 * @param {string} repoRoot - Git repository root
 */
function revertFix(fix, repoRoot) {
    if (!fix || !fix.files) return;

    for (const file of fix.files) {
        const absPath = path.resolve(repoRoot, file.path);
        if (!absPath.startsWith(repoRoot + path.sep)) continue;

        try {
            const content = fs.readFileSync(absPath, 'utf-8');
            if (content.includes(file.replacement)) {
                const reverted = content.replace(file.replacement, file.original);
                fs.writeFileSync(absPath, reverted, 'utf-8');
            }
        } catch {
            // Best effort
        }
    }
}

module.exports = {
    generateFix,
    validateFixResult,
    buildFixPrompt,
    readSourceContext,
    applyFix,
    revertFix,
    SYSTEM_PROMPT,
    DEFAULT_CONFIDENCE_THRESHOLD,
};
