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
    const url = `${GEMINI_URL}?key=${apiKey}`;
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
        const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
            const chunks = [];
            let totalBytes = 0;
            res.on('data', (chunk) => {
                totalBytes += chunk.length;
                if (totalBytes > MAX_RESPONSE_BYTES) {
                    req.destroy();
                    reject(new Error('Response too large'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString();
                if (res.statusCode !== 200) {
                    reject(new Error(`Gemini API error ${res.statusCode}: ${text.slice(0, 200)}`));
                    return;
                }
                try {
                    const data = JSON.parse(text);
                    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (!content) {
                        reject(new Error('Empty response from Gemini'));
                        return;
                    }
                    resolve(content);
                } catch (e) {
                    reject(new Error(`Failed to parse Gemini response: ${e.message}`));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(REQUEST_TIMEOUT, () => { req.destroy(); reject(new Error('Gemini API timeout')); });
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
function buildUserPrompt({ source_url, source_title, content, quote, type, priority, tags, userRules, userEndpoints }) {
    const parts = [`**Page URL:** ${source_url}`];

    if (source_title) parts.push(`**Page Title:** ${source_title}`);
    if (quote) parts.push(`**Selected Text:** ${quote.slice(0, 500)}`);
    if (content) parts.push(`**User Note:** ${content.slice(0, 1000)}`);
    if (type) parts.push(`**Type:** ${type}`);
    if (priority) parts.push(`**Priority:** ${priority}`);
    if (tags?.length) parts.push(`**Tags:** ${tags.join(', ')}`);

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
function validateRecommendation(raw) {
    const validTypes = ['github-issue', 'webhook', 'lark', 'telegram'];
    const validClassifications = ['bug', 'feature_request', 'question', 'praise', 'general'];

    const classification = validClassifications.includes(raw.classification) ? raw.classification : 'general';
    const target_type = validTypes.includes(raw.target_type) ? raw.target_type : 'github-issue';
    const confidence = typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.5;
    const reasoning = typeof raw.reasoning === 'string' ? raw.reasoning.slice(0, 500) : '';

    const target_config = (raw.target_config && typeof raw.target_config === 'object')
        ? raw.target_config
        : { repo: 'unknown', labels: ['clawmark'] };

    let suggested_rule = null;
    if (raw.suggested_rule && typeof raw.suggested_rule === 'object') {
        const sr = raw.suggested_rule;
        const validRuleTypes = ['url_pattern', 'content_type', 'tag_match'];
        if (validRuleTypes.includes(sr.rule_type) && sr.pattern && validTypes.includes(sr.target_type)) {
            suggested_rule = {
                rule_type: sr.rule_type,
                pattern: String(sr.pattern).slice(0, 500),
                target_type: sr.target_type,
                target_config: (sr.target_config && typeof sr.target_config === 'object') ? sr.target_config : target_config,
            };
        }
    }

    return { classification, target_type, target_config, confidence, reasoning, suggested_rule };
}

module.exports = { recommendRoute, callGemini, buildUserPrompt, validateRecommendation, SYSTEM_PROMPT };
