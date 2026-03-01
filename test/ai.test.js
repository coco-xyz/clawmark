/**
 * Tests for server/ai.js — AI routing recommendation
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { recommendRoute, buildUserPrompt, validateRecommendation, validateTargetConfig, classifyAnnotation, generateTags } = require('../server/ai');

// Mock AI that returns a valid recommendation
function mockAI(response) {
    return async (_apiKey, _system, _user) => JSON.stringify(response);
}

const VALID_RECOMMENDATION = {
    classification: 'bug',
    target_type: 'github-issue',
    target_config: { repo: 'coco-xyz/clawmark', labels: ['bug'] },
    confidence: 0.85,
    reasoning: 'URL is from GitHub, annotation mentions a UI bug',
    suggested_rule: {
        rule_type: 'url_pattern',
        pattern: 'github.com/coco-xyz/clawmark/**',
        target_type: 'github-issue',
        target_config: { repo: 'coco-xyz/clawmark', labels: ['bug'] },
    },
};

describe('recommendRoute', () => {
    it('returns recommendation with valid AI response', async () => {
        const result = await recommendRoute({
            source_url: 'https://github.com/coco-xyz/clawmark/issues/1',
            source_title: 'Issue #1',
            content: 'The button does not work',
            apiKey: 'test-key',
            callAI: mockAI(VALID_RECOMMENDATION),
        });

        assert.equal(result.classification, 'bug');
        assert.equal(result.target_type, 'github-issue');
        assert.equal(result.target_config.repo, 'coco-xyz/clawmark');
        assert.equal(result.confidence, 0.85);
        assert.ok(result.reasoning.length > 0);
        assert.ok(result.suggested_rule);
        assert.equal(result.suggested_rule.rule_type, 'url_pattern');
    });

    it('throws when source_url is missing', async () => {
        await assert.rejects(
            () => recommendRoute({ apiKey: 'test', callAI: mockAI(VALID_RECOMMENDATION) }),
            { message: 'source_url is required' }
        );
    });

    it('throws when AI returns invalid JSON', async () => {
        await assert.rejects(
            () => recommendRoute({
                source_url: 'https://example.com',
                apiKey: 'test',
                callAI: async () => 'not json',
            }),
            { message: 'AI returned invalid JSON' }
        );
    });

    it('passes user context to AI prompt', async () => {
        let capturedPrompt = '';
        const result = await recommendRoute({
            source_url: 'https://example.com/page',
            source_title: 'Test Page',
            content: 'This feature is broken',
            quote: 'feature is broken',
            type: 'issue',
            priority: 'high',
            tags: ['bug', 'urgent'],
            userRules: [{ rule_type: 'url_pattern', pattern: 'example.com/*', target_type: 'webhook' }],
            userEndpoints: [{ name: 'My Webhook', type: 'webhook' }],
            apiKey: 'test',
            callAI: async (_key, _sys, user) => {
                capturedPrompt = user;
                return JSON.stringify(VALID_RECOMMENDATION);
            },
        });

        assert.ok(capturedPrompt.includes('https://example.com/page'));
        assert.ok(capturedPrompt.includes('Test Page'));
        assert.ok(capturedPrompt.includes('This feature is broken'));
        assert.ok(capturedPrompt.includes('feature is broken'));
        assert.ok(capturedPrompt.includes('issue'));
        assert.ok(capturedPrompt.includes('high'));
        assert.ok(capturedPrompt.includes('bug'));
        assert.ok(capturedPrompt.includes('My Webhook'));
        assert.ok(capturedPrompt.includes('url_pattern'));
    });
});

describe('validateRecommendation', () => {
    it('returns valid recommendation unchanged', () => {
        const result = validateRecommendation(VALID_RECOMMENDATION);
        assert.equal(result.classification, 'bug');
        assert.equal(result.target_type, 'github-issue');
        assert.equal(result.confidence, 0.85);
    });

    it('normalizes invalid classification to general', () => {
        const result = validateRecommendation({ ...VALID_RECOMMENDATION, classification: 'invalid' });
        assert.equal(result.classification, 'general');
    });

    it('normalizes invalid target_type to github-issue', () => {
        const result = validateRecommendation({ ...VALID_RECOMMENDATION, target_type: 'invalid' });
        assert.equal(result.target_type, 'github-issue');
    });

    it('clamps confidence to [0, 1]', () => {
        assert.equal(validateRecommendation({ ...VALID_RECOMMENDATION, confidence: 1.5 }).confidence, 1);
        assert.equal(validateRecommendation({ ...VALID_RECOMMENDATION, confidence: -0.5 }).confidence, 0);
    });

    it('defaults confidence to 0.5 when non-numeric', () => {
        assert.equal(validateRecommendation({ ...VALID_RECOMMENDATION, confidence: 'high' }).confidence, 0.5);
    });

    it('truncates reasoning to 500 chars', () => {
        const longReasoning = 'x'.repeat(600);
        const result = validateRecommendation({ ...VALID_RECOMMENDATION, reasoning: longReasoning });
        assert.equal(result.reasoning.length, 500);
    });

    it('returns null suggested_rule for invalid rule data', () => {
        const result = validateRecommendation({
            ...VALID_RECOMMENDATION,
            suggested_rule: { rule_type: 'invalid', pattern: 'x', target_type: 'webhook' },
        });
        assert.equal(result.suggested_rule, null);
    });

    it('returns null suggested_rule when missing pattern', () => {
        const result = validateRecommendation({
            ...VALID_RECOMMENDATION,
            suggested_rule: { rule_type: 'url_pattern', target_type: 'webhook' },
        });
        assert.equal(result.suggested_rule, null);
    });

    it('handles missing target_config gracefully', () => {
        const result = validateRecommendation({ classification: 'bug', target_type: 'webhook', confidence: 0.5 });
        assert.ok(result.target_config);
        assert.equal(typeof result.target_config, 'object');
    });

    it('handles completely empty input', () => {
        const result = validateRecommendation({});
        assert.equal(result.classification, 'general');
        assert.equal(result.target_type, 'github-issue');
        assert.equal(result.confidence, 0.5);
        assert.equal(result.reasoning, '');
        assert.equal(result.suggested_rule, null);
    });

    it('accepts all valid classifications', () => {
        for (const cls of ['bug', 'feature_request', 'question', 'praise', 'general']) {
            const result = validateRecommendation({ ...VALID_RECOMMENDATION, classification: cls });
            assert.equal(result.classification, cls);
        }
    });

    it('accepts all valid target types', () => {
        for (const t of ['github-issue', 'webhook', 'lark', 'telegram']) {
            const result = validateRecommendation({ ...VALID_RECOMMENDATION, target_type: t });
            assert.equal(result.target_type, t);
        }
    });
});

describe('buildUserPrompt', () => {
    it('includes source_url', () => {
        const prompt = buildUserPrompt({ source_url: 'https://example.com' });
        assert.ok(prompt.includes('https://example.com'));
    });

    it('includes all optional fields when provided', () => {
        const prompt = buildUserPrompt({
            source_url: 'https://example.com',
            source_title: 'My Page',
            content: 'Bug report',
            quote: 'broken button',
            type: 'issue',
            priority: 'high',
            tags: ['bug'],
            userEndpoints: [{ name: 'EP1', type: 'webhook' }],
            userRules: [{ rule_type: 'url_pattern', pattern: '*.com', target_type: 'webhook' }],
        });

        assert.ok(prompt.includes('My Page'));
        assert.ok(prompt.includes('Bug report'));
        assert.ok(prompt.includes('broken button'));
        assert.ok(prompt.includes('issue'));
        assert.ok(prompt.includes('high'));
        assert.ok(prompt.includes('bug'));
        assert.ok(prompt.includes('EP1'));
        assert.ok(prompt.includes('url_pattern'));
    });

    it('truncates long content and quote', () => {
        const prompt = buildUserPrompt({
            source_url: 'https://example.com',
            content: 'x'.repeat(3000),
            quote: 'y'.repeat(1000),
        });
        // content truncated to 2000, quote to 500
        assert.ok(!prompt.includes('x'.repeat(2001)));
        assert.ok(!prompt.includes('y'.repeat(501)));
    });

    it('omits sections when optional fields are empty', () => {
        const prompt = buildUserPrompt({
            source_url: 'https://example.com',
            userEndpoints: [],
            userRules: [],
        });
        assert.ok(!prompt.includes('Saved Endpoints'));
        assert.ok(!prompt.includes('Existing Rules'));
    });

    it('wraps user content in USER_INPUT delimiters', () => {
        const prompt = buildUserPrompt({
            source_url: 'https://example.com',
            source_title: 'Test',
            content: 'note',
            quote: 'selected',
        });
        assert.ok(prompt.includes('<USER_INPUT>https://example.com</USER_INPUT>'));
        assert.ok(prompt.includes('<USER_INPUT>Test</USER_INPUT>'));
        assert.ok(prompt.includes('<USER_INPUT>note</USER_INPUT>'));
        assert.ok(prompt.includes('<USER_INPUT>selected</USER_INPUT>'));
    });

    it('handles tags as string gracefully (converts to empty array)', () => {
        const prompt = buildUserPrompt({
            source_url: 'https://example.com',
            tags: 'not-an-array',
        });
        assert.ok(!prompt.includes('Tags'));
    });

    it('limits number of tags', () => {
        const manyTags = Array.from({ length: 30 }, (_, i) => `tag${i}`);
        const prompt = buildUserPrompt({
            source_url: 'https://example.com',
            tags: manyTags,
        });
        assert.ok(prompt.includes('tag0'));
        assert.ok(prompt.includes('tag19'));
        assert.ok(!prompt.includes('tag20'));
    });
});

describe('validateTargetConfig', () => {
    it('validates github-issue config', () => {
        const result = validateTargetConfig({ repo: 'coco-xyz/test', labels: ['bug'], assignees: ['user1'] }, 'github-issue');
        assert.equal(result.repo, 'coco-xyz/test');
        assert.deepEqual(result.labels, ['bug']);
        assert.deepEqual(result.assignees, ['user1']);
    });

    it('validates webhook config — requires https', () => {
        const result = validateTargetConfig({ url: 'http://evil.com', method: 'POST' }, 'webhook');
        assert.equal(result.url, '');
        const valid = validateTargetConfig({ url: 'https://hooks.slack.com/x', method: 'POST' }, 'webhook');
        assert.equal(valid.url, 'https://hooks.slack.com/x');
    });

    it('validates telegram/lark config', () => {
        const result = validateTargetConfig({ chat_id: '123456' }, 'telegram');
        assert.equal(result.chat_id, '123456');
    });

    it('returns default config for null input', () => {
        const result = validateTargetConfig(null, 'github-issue');
        assert.equal(result.repo, 'unknown');
    });

    it('returns default for unknown target type', () => {
        const result = validateTargetConfig({ foo: 'bar' }, 'unknown');
        assert.equal(result.repo, 'unknown');
    });
});

// Mock AI for classification tests
function mockClassifyAI(classification, confidence = 0.9) {
    return async () => JSON.stringify({ classification, confidence, reasoning: 'Test reasoning' });
}

describe('classifyAnnotation', () => {
    it('classifies a bug report', async () => {
        const result = await classifyAnnotation({
            source_url: 'https://example.com',
            content: 'The button is broken',
            apiKey: 'test',
            callAI: mockClassifyAI('bug', 0.95),
        });
        assert.equal(result.classification, 'bug');
        assert.equal(result.confidence, 0.95);
        assert.ok(result.reasoning.length > 0);
    });

    it('classifies a feature request', async () => {
        const result = await classifyAnnotation({
            source_url: 'https://example.com',
            content: 'It would be nice to have dark mode',
            apiKey: 'test',
            callAI: mockClassifyAI('feature_request', 0.88),
        });
        assert.equal(result.classification, 'feature_request');
    });

    it('returns general with 0 confidence when no context provided', async () => {
        const result = await classifyAnnotation({ apiKey: 'test' });
        assert.equal(result.classification, 'general');
        assert.equal(result.confidence, 0);
    });

    it('normalizes invalid classification to general', async () => {
        const result = await classifyAnnotation({
            source_url: 'https://example.com',
            apiKey: 'test',
            callAI: mockClassifyAI('invalid_type'),
        });
        assert.equal(result.classification, 'general');
    });

    it('clamps confidence to [0, 1]', async () => {
        const result = await classifyAnnotation({
            source_url: 'https://example.com',
            apiKey: 'test',
            callAI: async () => JSON.stringify({ classification: 'bug', confidence: 1.5 }),
        });
        assert.equal(result.confidence, 1);
    });

    it('throws when AI returns invalid JSON', async () => {
        await assert.rejects(
            () => classifyAnnotation({
                source_url: 'https://example.com',
                apiKey: 'test',
                callAI: async () => 'not json',
            }),
            { message: 'AI returned invalid JSON' }
        );
    });

    it('works with only quote provided', async () => {
        const result = await classifyAnnotation({
            quote: 'Why is this not working?',
            apiKey: 'test',
            callAI: mockClassifyAI('question', 0.82),
        });
        assert.equal(result.classification, 'question');
    });

    it('works with only content provided', async () => {
        const result = await classifyAnnotation({
            content: 'Great product!',
            apiKey: 'test',
            callAI: mockClassifyAI('praise', 0.9),
        });
        assert.equal(result.classification, 'praise');
    });

    it('accepts all valid classifications', async () => {
        for (const cls of ['bug', 'feature_request', 'question', 'praise', 'general']) {
            const result = await classifyAnnotation({
                source_url: 'https://example.com',
                apiKey: 'test',
                callAI: mockClassifyAI(cls),
            });
            assert.equal(result.classification, cls);
        }
    });

    it('truncates long reasoning', async () => {
        const result = await classifyAnnotation({
            source_url: 'https://example.com',
            apiKey: 'test',
            callAI: async () => JSON.stringify({
                classification: 'bug',
                confidence: 0.9,
                reasoning: 'x'.repeat(600),
            }),
        });
        assert.equal(result.reasoning.length, 500);
    });
});

// Mock AI for tag generation tests
function mockTagAI(tags, reasoning = 'Test reasoning') {
    return async () => JSON.stringify({ tags, reasoning });
}

describe('generateTags', () => {
    it('generates tags from content', async () => {
        const result = await generateTags({
            source_url: 'https://example.com',
            content: 'Login button does not work on mobile',
            apiKey: 'test',
            callAI: mockTagAI(['login', 'mobile', 'ui-bug']),
        });
        assert.deepEqual(result.tags, ['login', 'mobile', 'ui-bug']);
        assert.ok(result.reasoning.length > 0);
    });

    it('returns empty tags when no context provided', async () => {
        const result = await generateTags({ apiKey: 'test' });
        assert.deepEqual(result.tags, []);
    });

    it('deduplicates against existing tags', async () => {
        const result = await generateTags({
            source_url: 'https://example.com',
            content: 'Bug report',
            existingTags: ['bug', 'urgent'],
            apiKey: 'test',
            callAI: mockTagAI(['bug', 'login', 'urgent', 'mobile']),
        });
        assert.ok(!result.tags.includes('bug'));
        assert.ok(!result.tags.includes('urgent'));
        assert.ok(result.tags.includes('login'));
        assert.ok(result.tags.includes('mobile'));
    });

    it('deduplicates within generated tags', async () => {
        const result = await generateTags({
            source_url: 'https://example.com',
            apiKey: 'test',
            callAI: mockTagAI(['bug', 'bug', 'login']),
        });
        const bugCount = result.tags.filter(t => t === 'bug').length;
        assert.equal(bugCount, 1);
    });

    it('limits to MAX_GENERATED_TAGS (5)', async () => {
        const result = await generateTags({
            source_url: 'https://example.com',
            apiKey: 'test',
            callAI: mockTagAI(['a', 'b', 'c', 'd', 'e', 'f', 'g']),
        });
        assert.ok(result.tags.length <= 5);
    });

    it('normalizes tags to lowercase', async () => {
        const result = await generateTags({
            source_url: 'https://example.com',
            apiKey: 'test',
            callAI: mockTagAI(['BUG', 'Login', 'UI-Issue']),
        });
        assert.deepEqual(result.tags, ['bug', 'login', 'ui-issue']);
    });

    it('strips invalid characters from tags', async () => {
        const result = await generateTags({
            source_url: 'https://example.com',
            apiKey: 'test',
            callAI: mockTagAI(['bug!', 'lo gin', 'ui_bug', 'good-tag']),
        });
        assert.deepEqual(result.tags, ['bug', 'login', 'uibug', 'good-tag']);
    });

    it('filters out empty/non-string tags', async () => {
        const result = await generateTags({
            source_url: 'https://example.com',
            apiKey: 'test',
            callAI: mockTagAI(['bug', '', null, 123, 'valid']),
        });
        assert.deepEqual(result.tags, ['bug', 'valid']);
    });

    it('throws when AI returns invalid JSON', async () => {
        await assert.rejects(
            () => generateTags({
                source_url: 'https://example.com',
                apiKey: 'test',
                callAI: async () => 'not json',
            }),
            { message: 'AI returned invalid JSON' }
        );
    });

    it('handles AI returning non-array tags gracefully', async () => {
        const result = await generateTags({
            source_url: 'https://example.com',
            apiKey: 'test',
            callAI: async () => JSON.stringify({ tags: 'not-an-array' }),
        });
        assert.deepEqual(result.tags, []);
    });
});
