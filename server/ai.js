/**
 * ClawMark — AI Module
 *
 * Provides AI-powered routing recommendation using Google Gemini API.
 * No external dependencies — uses Node built-in https.
 */

'use strict';

const https = require('https');

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const REQUEST_TIMEOUT = 15000; // 15s
const MAX_RESPONSE_BYTES = 64 * 1024; // 64KB

/**
 * Call Gemini API with a prompt.
 *
 * @param {string} apiKey  Gemini API key
 * @param {string} systemPrompt  System instruction
 * @param {string} userPrompt  User message
 * @returns {Promise<string>}  Model response text
 */
async function callGemini(apiKey, systemPrompt, userPrompt) {
    const url = GEMINI_URL;
    const body = JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1024,
            responseMimeType: 'application/json',
        },
    });

    return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (err) => { if (!settled) { settled = true; reject(err); } };
        const succeed = (val) => { if (!settled) { settled = true; resolve(val); } };

        const req = https.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey,
            },
        }, (res) => {
            const chunks = [];
            let totalBytes = 0;
            res.on('data', (chunk) => {
                totalBytes += chunk.length;
                if (totalBytes > MAX_RESPONSE_BYTES) {
                    req.destroy();
                    fail(new Error('Response too large'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => {
                if (settled) return;
                const text = Buffer.concat(chunks).toString();
                if (res.statusCode !== 200) {
                    fail(new Error(`Gemini API error ${res.statusCode}`));
                    return;
                }
                try {
                    const data = JSON.parse(text);
                    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (!content) {
                        fail(new Error('Empty response from Gemini'));
                        return;
                    }
                    succeed(content);
                } catch (e) {
                    fail(new Error('Failed to parse Gemini response'));
                }
            });
        });
        req.on('error', (err) => fail(err));
        req.setTimeout(REQUEST_TIMEOUT, () => { req.destroy(); fail(new Error('Gemini API timeout')); });
        req.write(body);
        req.end();
    });
}

const SYSTEM_PROMPT = `You are ClawMark's routing engine. Given context about a web annotation (page URL, title, selected text, user note), recommend where to route it.

Your job:
1. Analyze the annotation context to understand what the user is reporting (bug, feature request, question, praise, general feedback).
2. Recommend the best routing target — an adapter type and configuration.
3. Provide a confidence score (0.0 to 1.0).
4. Optionally suggest a reusable routing rule the user could save.

Available adapter types: github-issue, webhook, lark, telegram

Respond with valid JSON matching this schema:
{
  "classification": "bug" | "feature_request" | "question" | "praise" | "general",
  "target_type": string,
  "target_config": object,
  "confidence": number,
  "reasoning": string,
  "suggested_rule": { "rule_type": string, "pattern": string, "target_type": string, "target_config": object } | null
}

Rules for target_config:
- For github-issue: { "repo": "owner/repo", "labels": [...], "assignees": [] }
- For webhook: { "url": "https://...", "method": "POST" }
- For lark/telegram: { "chat_id": "..." }

If the URL is from github.com, extract the repo and route to github-issue.
If you can identify the project/product from the URL or content, suggest the most relevant target.
If insufficient context, set confidence below 0.5 and use a generic target.`;

/**
 * Recommend a routing target for an annotation using AI.
 *
 * @param {object} params
 * @param {string} params.source_url       Page URL being annotated
 * @param {string} [params.source_title]   Page title
 * @param {string} [params.content]        User's annotation text
 * @param {string} [params.quote]          Text selected/highlighted on page
 * @param {string} [params.type]           Annotation type (comment, issue)
 * @param {string} [params.priority]       Annotation priority
 * @param {string[]} [params.tags]         User-provided tags
 * @param {object[]} [params.userRules]    User's existing routing rules
 * @param {object[]} [params.userEndpoints] User's saved endpoints
 * @param {string} params.apiKey           Gemini API key
 * @param {Function} [params.callAI]       Override AI call (for testing)
 * @returns {Promise<object>}  Recommendation result
 */
async function recommendRoute(params) {
    const {
        source_url, source_title, content, quote,
        type, priority, tags,
        userRules = [], userEndpoints = [],
        apiKey, callAI,
    } = params;

    if (!source_url) {
        throw new Error('source_url is required');
    }

    const userPrompt = buildUserPrompt({
        source_url, source_title, content, quote,
        type, priority, tags, userRules, userEndpoints,
    });

    const aiCall = callAI || callGemini;
    const responseText = await aiCall(apiKey, SYSTEM_PROMPT, userPrompt);

    // Parse and validate
    let result;
    try {
        result = JSON.parse(responseText);
    } catch {
        throw new Error('AI returned invalid JSON');
    }

    return validateRecommendation(result);
}

/**
 * Build the user prompt with all available context.
 */
const MAX_URL_LEN = 2048;
const MAX_TITLE_LEN = 500;
const MAX_CONTENT_LEN = 2000;
const MAX_QUOTE_LEN = 500;
const MAX_TAG_LEN = 100;
const MAX_TAGS = 20;

function buildUserPrompt({ source_url, source_title, content, quote, type, priority, tags, userRules, userEndpoints }) {
    const safeUrl = String(source_url).slice(0, MAX_URL_LEN);
    const parts = [`**Page URL:** <USER_INPUT>${safeUrl}</USER_INPUT>`];

    if (source_title) parts.push(`**Page Title:** <USER_INPUT>${String(source_title).slice(0, MAX_TITLE_LEN)}</USER_INPUT>`);
    if (quote) parts.push(`**Selected Text:** <USER_INPUT>${String(quote).slice(0, MAX_QUOTE_LEN)}</USER_INPUT>`);
    if (content) parts.push(`**User Note:** <USER_INPUT>${String(content).slice(0, MAX_CONTENT_LEN)}</USER_INPUT>`);
    if (type) parts.push(`**Type:** ${String(type).slice(0, 50)}`);
    if (priority) parts.push(`**Priority:** ${String(priority).slice(0, 50)}`);

    const safeTags = Array.isArray(tags) ? tags.slice(0, MAX_TAGS).map(t => String(t).slice(0, MAX_TAG_LEN)) : [];
    if (safeTags.length) parts.push(`**Tags:** ${safeTags.join(', ')}`);

    if (userEndpoints?.length > 0) {
        const epSummary = userEndpoints.map(ep => `- ${ep.name} (${ep.type})`).join('\n');
        parts.push(`**User's Saved Endpoints:**\n${epSummary}`);
    }

    if (userRules?.length > 0) {
        const ruleSummary = userRules.slice(0, 10).map(r =>
            `- ${r.rule_type}: ${r.pattern || '(default)'} → ${r.target_type}`
        ).join('\n');
        parts.push(`**User's Existing Rules:**\n${ruleSummary}`);
    }

    return parts.join('\n\n');
}

/**
 * Validate and normalize the AI recommendation.
 */
function validateTargetConfig(config, targetType) {
    if (!config || typeof config !== 'object') {
        return { repo: 'unknown', labels: ['clawmark'] };
    }
    const sanitized = {};
    switch (targetType) {
        case 'github-issue':
            sanitized.repo = typeof config.repo === 'string' ? config.repo.slice(0, 200) : 'unknown';
            sanitized.labels = Array.isArray(config.labels) ? config.labels.slice(0, 10).map(l => String(l).slice(0, 50)) : ['clawmark'];
            sanitized.assignees = Array.isArray(config.assignees) ? config.assignees.slice(0, 5).map(a => String(a).slice(0, 50)) : [];
            break;
        case 'webhook':
            sanitized.url = typeof config.url === 'string' && /^https:\/\//.test(config.url) ? config.url.slice(0, 2048) : '';
            sanitized.method = config.method === 'GET' ? 'GET' : 'POST';
            break;
        case 'lark':
        case 'telegram':
            sanitized.chat_id = typeof config.chat_id === 'string' ? config.chat_id.slice(0, 100) : '';
            break;
        default:
            return { repo: 'unknown', labels: ['clawmark'] };
    }
    return sanitized;
}

function validateRecommendation(raw) {
    const validTypes = ['github-issue', 'webhook', 'lark', 'telegram'];
    const classification = VALID_CLASSIFICATIONS.includes(raw.classification) ? raw.classification : 'general';
    const target_type = validTypes.includes(raw.target_type) ? raw.target_type : 'github-issue';
    const confidence = typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.5;
    const reasoning = typeof raw.reasoning === 'string' ? raw.reasoning.slice(0, 500) : '';

    const target_config = validateTargetConfig(raw.target_config, target_type);

    let suggested_rule = null;
    if (raw.suggested_rule && typeof raw.suggested_rule === 'object') {
        const sr = raw.suggested_rule;
        const validRuleTypes = ['url_pattern', 'content_type', 'tag_match'];
        if (validRuleTypes.includes(sr.rule_type) && sr.pattern && validTypes.includes(sr.target_type)) {
            suggested_rule = {
                rule_type: sr.rule_type,
                pattern: String(sr.pattern).slice(0, 500),
                target_type: sr.target_type,
                target_config: validateTargetConfig(sr.target_config, sr.target_type),
            };
        }
    }

    return { classification, target_type, target_config, confidence, reasoning, suggested_rule };
}

// ================================================================= Classification
//
// Classify an annotation into: bug, feature_request, question, praise, general.
// Lightweight — only returns classification + confidence.
// =================================================================

const VALID_CLASSIFICATIONS = ['bug', 'feature_request', 'question', 'praise', 'general'];

const CLASSIFICATION_PROMPT = `You are an annotation classifier. Given the context of a web annotation (page URL, title, selected text, user note), classify it into one of these categories:

- bug: Reports a defect, broken feature, or unexpected behavior
- feature_request: Suggests a new feature or improvement
- question: Asks for help, clarification, or information
- praise: Positive feedback, compliment, or appreciation
- general: Anything else (comments, observations, notes)

Respond with valid JSON:
{
  "classification": "bug" | "feature_request" | "question" | "praise" | "general",
  "confidence": number (0.0 to 1.0),
  "reasoning": string (1 sentence)
}`;

/**
 * Classify an annotation using AI.
 *
 * @param {object} params
 * @param {string} params.source_url       Page URL
 * @param {string} [params.source_title]   Page title
 * @param {string} [params.content]        User's note/message
 * @param {string} [params.quote]          Selected text
 * @param {string} [params.type]           Annotation type
 * @param {string} params.apiKey           Gemini API key
 * @param {Function} [params.callAI]       Override AI call (for testing)
 * @returns {Promise<{classification: string, confidence: number, reasoning: string}>}
 */
async function classifyAnnotation(params) {
    const { source_url, source_title, content, quote, type, apiKey, callAI } = params;

    if (!source_url && !content && !quote) {
        return { classification: 'general', confidence: 0, reasoning: 'Insufficient context' };
    }

    const parts = [];
    if (source_url) parts.push(`URL: <USER_INPUT>${String(source_url).slice(0, MAX_URL_LEN)}</USER_INPUT>`);
    if (source_title) parts.push(`Title: <USER_INPUT>${String(source_title).slice(0, MAX_TITLE_LEN)}</USER_INPUT>`);
    if (quote) parts.push(`Selected text: <USER_INPUT>${String(quote).slice(0, MAX_QUOTE_LEN)}</USER_INPUT>`);
    if (content) parts.push(`User note: <USER_INPUT>${String(content).slice(0, MAX_CONTENT_LEN)}</USER_INPUT>`);
    if (type) parts.push(`Type: ${String(type).slice(0, 50)}`);

    const aiCall = callAI || callGemini;
    const responseText = await aiCall(apiKey, CLASSIFICATION_PROMPT, parts.join('\n'));

    let result;
    try {
        result = JSON.parse(responseText);
    } catch {
        throw new Error('AI returned invalid JSON');
    }

    const classification = VALID_CLASSIFICATIONS.includes(result.classification) ? result.classification : 'general';
    const confidence = typeof result.confidence === 'number' ? Math.max(0, Math.min(1, result.confidence)) : 0.5;
    const reasoning = typeof result.reasoning === 'string' ? result.reasoning.slice(0, 500) : '';

    return { classification, confidence, reasoning };
}

// ================================================================= Tag Generation
//
// Generate 2-5 relevant tags for an annotation based on its content.
// =================================================================

const TAG_GENERATION_PROMPT = `You are a tag generator for web annotations. Given the context of an annotation (page URL, title, selected text, user note), generate 2-5 short, descriptive tags.

Rules:
- Tags should be lowercase, single words or short hyphenated phrases (e.g., "ui-bug", "performance", "documentation")
- Focus on the topic/subject, not generic labels
- Maximum 5 tags, minimum 2
- No duplicates
- English tags only

Respond with valid JSON:
{
  "tags": ["tag1", "tag2", ...],
  "reasoning": string (1 sentence explaining tag choices)
}`;

const MAX_TAG_RESULT_LEN = 50;
const MAX_GENERATED_TAGS = 5;

/**
 * Generate tags for an annotation using AI.
 *
 * @param {object} params
 * @param {string} [params.source_url]     Page URL
 * @param {string} [params.source_title]   Page title
 * @param {string} [params.content]        User's note/message
 * @param {string} [params.quote]          Selected text
 * @param {string} [params.type]           Annotation type
 * @param {string[]} [params.existingTags] Tags already on the item
 * @param {string} params.apiKey           Gemini API key
 * @param {Function} [params.callAI]       Override AI call (for testing)
 * @returns {Promise<{tags: string[], reasoning: string}>}
 */
async function generateTags(params) {
    const { source_url, source_title, content, quote, type, existingTags = [], apiKey, callAI } = params;

    if (!source_url && !content && !quote) {
        return { tags: [], reasoning: 'Insufficient context' };
    }

    const parts = [];
    if (source_url) parts.push(`URL: <USER_INPUT>${String(source_url).slice(0, MAX_URL_LEN)}</USER_INPUT>`);
    if (source_title) parts.push(`Title: <USER_INPUT>${String(source_title).slice(0, MAX_TITLE_LEN)}</USER_INPUT>`);
    if (quote) parts.push(`Selected text: <USER_INPUT>${String(quote).slice(0, MAX_QUOTE_LEN)}</USER_INPUT>`);
    if (content) parts.push(`User note: <USER_INPUT>${String(content).slice(0, MAX_CONTENT_LEN)}</USER_INPUT>`);
    if (type) parts.push(`Type: ${String(type).slice(0, 50)}`);
    if (existingTags.length > 0) parts.push(`Existing tags (do not duplicate): <USER_INPUT>${existingTags.join(', ')}</USER_INPUT>`);

    const aiCall = callAI || callGemini;
    const responseText = await aiCall(apiKey, TAG_GENERATION_PROMPT, parts.join('\n'));

    let result;
    try {
        result = JSON.parse(responseText);
    } catch {
        throw new Error('AI returned invalid JSON');
    }

    // Validate and sanitize tags
    if (!Array.isArray(result.tags)) {
        return { tags: [], reasoning: 'AI returned no tags' };
    }

    const existingLower = existingTags.map(t => t.toLowerCase());
    const tags = result.tags
        .filter(t => typeof t === 'string' && t.trim().length > 0)
        .map(t => t.toLowerCase().trim().replace(/[^a-z0-9-]/g, '').slice(0, MAX_TAG_RESULT_LEN))
        .filter(t => t.length > 0)
        .filter(t => !existingLower.includes(t));  // Case-insensitive dedup against existing

    // Deduplicate within generated
    const uniqueTags = [...new Set(tags)].slice(0, MAX_GENERATED_TAGS);

    const reasoning = typeof result.reasoning === 'string' ? result.reasoning.slice(0, 500) : '';

    return { tags: uniqueTags, reasoning };
}

// ================================================================= Clustering
//
// AI-powered grouping of similar annotations into thematic clusters.
// =================================================================

const CLUSTERING_PROMPT = `You are an annotation analyst. Given a list of recent web annotations, group them into thematic clusters based on similarity.

Rules:
- Each cluster should have a short descriptive label (2-5 words)
- Group by topic/theme, not by classification type
- Annotations can belong to at most one cluster
- Unclustered annotations should be omitted
- Maximum 10 clusters
- Order clusters by size (largest first)

Respond with valid JSON:
{
  "clusters": [
    {
      "label": string,
      "description": string (1 sentence),
      "item_ids": [string, ...],
      "severity": "high" | "medium" | "low"
    }
  ],
  "summary": string (1-2 sentences describing the overall picture)
}`;

const MAX_CLUSTER_ITEMS = 100;
const MAX_CLUSTERS = 10;

/**
 * Cluster recent annotations using AI.
 *
 * @param {object} params
 * @param {object[]} params.items         Items to cluster (from DB)
 * @param {string} params.apiKey          Gemini API key
 * @param {Function} [params.callAI]      Override AI call (for testing)
 * @returns {Promise<{clusters: object[], summary: string}>}
 */
async function clusterAnnotations(params) {
    const { items, apiKey, callAI } = params;

    if (!items || items.length === 0) {
        return { clusters: [], summary: 'No annotations to cluster' };
    }

    // Build item summaries for the prompt
    const itemSummaries = items.slice(0, MAX_CLUSTER_ITEMS).map(item => {
        const parts = [`ID: ${item.id}`];
        if (item.source_url) parts.push(`URL: <USER_INPUT>${String(item.source_url).slice(0, 200)}</USER_INPUT>`);
        if (item.source_title) parts.push(`Title: <USER_INPUT>${String(item.source_title).slice(0, 100)}</USER_INPUT>`);
        if (item.title) parts.push(`Note: <USER_INPUT>${String(item.title).slice(0, 200)}</USER_INPUT>`);
        if (item.quote) parts.push(`Quote: <USER_INPUT>${String(item.quote).slice(0, 200)}</USER_INPUT>`);
        if (item.classification) parts.push(`Classification: ${item.classification}`);
        if (item.tags) {
            try {
                const tags = typeof item.tags === 'string' ? JSON.parse(item.tags) : item.tags;
                if (Array.isArray(tags) && tags.length) parts.push(`Tags: <USER_INPUT>${tags.map(t => String(t).slice(0, 50)).join(', ')}</USER_INPUT>`);
            } catch { /* skip */ }
        }
        return parts.join(' | ');
    });

    const userPrompt = `Analyze these ${itemSummaries.length} annotations and group similar ones:\n\n${itemSummaries.join('\n')}`;

    const aiCall = callAI || callGemini;
    const responseText = await aiCall(apiKey, CLUSTERING_PROMPT, userPrompt);

    let result;
    try {
        result = JSON.parse(responseText);
    } catch {
        throw new Error('AI returned invalid JSON');
    }

    return validateClusters(result, items);
}

/**
 * Validate and normalize cluster results.
 */
function validateClusters(raw, items) {
    const validItemIds = new Set(items.map(i => i.id));
    const validSeverities = ['high', 'medium', 'low'];

    if (!Array.isArray(raw.clusters)) {
        return { clusters: [], summary: 'AI returned no clusters' };
    }

    const clusters = raw.clusters
        .slice(0, MAX_CLUSTERS)
        .map(c => {
            if (!c || typeof c !== 'object') return null;

            const label = typeof c.label === 'string' ? c.label.slice(0, 100) : 'Unnamed cluster';
            const description = typeof c.description === 'string' ? c.description.slice(0, 500) : '';
            const severity = validSeverities.includes(c.severity) ? c.severity : 'medium';

            // Only keep item_ids that exist in the input
            const item_ids = Array.isArray(c.item_ids)
                ? c.item_ids.filter(id => typeof id === 'string' && validItemIds.has(id)).slice(0, MAX_CLUSTER_ITEMS)
                : [];

            if (item_ids.length === 0) return null;

            return { label, description, item_ids, count: item_ids.length, severity };
        })
        .filter(Boolean)
        .sort((a, b) => b.count - a.count);

    const summary = typeof raw.summary === 'string' ? raw.summary.slice(0, 500) : '';

    return { clusters, summary };
}

module.exports = { recommendRoute, validateRecommendation, buildUserPrompt, validateTargetConfig, classifyAnnotation, VALID_CLASSIFICATIONS, generateTags, clusterAnnotations, validateClusters };
