/**
 * ClawMark — Auto-Fix Pipeline Tests (#86)
 *
 * Tests blame analysis, fix generation, PR formatting, notifier, and consumer.
 * Run: node --test test/auto-fix.test.js
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
    parseStackTrace, parseFrame, resolveFilePath,
    parseBlamePorcelain, parseGitLog, analyzeBlame,
} = require('../server/agent/auto-fix/blame-analyzer');

const {
    validateFixResult, buildFixPrompt, readSourceContext, applyFix, revertFix,
    DEFAULT_CONFIDENCE_THRESHOLD,
} = require('../server/agent/auto-fix/fix-generator');

const {
    generateBranchName, buildCommitMessage, buildMrDescription,
} = require('../server/agent/auto-fix/pr-creator');

const {
    formatNotification,
} = require('../server/agent/auto-fix/notifier');

// ── Blame Analyzer Tests ────────────────────────────────────────────

describe('Blame Analyzer', () => {
    describe('parseStackTrace', () => {
        it('parses V8 stack trace with function names', () => {
            const stack = `Error: something broke
    at MyClass.method (/app/server/handler.js:42:15)
    at processRequest (/app/server/router.js:100:8)
    at Server.emit (node:events:519:28)`;

            const frames = parseStackTrace(stack);
            assert.equal(frames.length, 3);
            assert.equal(frames[0].func, 'MyClass.method');
            assert.equal(frames[0].file, '/app/server/handler.js');
            assert.equal(frames[0].line, 42);
            assert.equal(frames[0].col, 15);
            assert.equal(frames[1].func, 'processRequest');
            assert.equal(frames[1].line, 100);
        });

        it('parses anonymous frames', () => {
            const stack = `Error: fail
    at /app/lib/utils.js:10:5`;

            const frames = parseStackTrace(stack);
            assert.equal(frames.length, 1);
            assert.equal(frames[0].func, '<anonymous>');
            assert.equal(frames[0].file, '/app/lib/utils.js');
            assert.equal(frames[0].line, 10);
        });

        it('returns empty for null/empty stack', () => {
            assert.deepEqual(parseStackTrace(null), []);
            assert.deepEqual(parseStackTrace(''), []);
            assert.deepEqual(parseStackTrace('No stack trace here'), []);
        });

        it('limits to MAX_FRAMES', () => {
            const lines = Array.from({ length: 20 }, (_, i) =>
                `    at fn${i} (/app/file${i}.js:${i + 1}:1)`
            );
            const frames = parseStackTrace('Error\n' + lines.join('\n'));
            assert.equal(frames.length, 5);
        });
    });

    describe('parseFrame', () => {
        it('parses function frame', () => {
            const frame = parseFrame('at foo.bar (/a/b.js:10:20)');
            assert.deepEqual(frame, { func: 'foo.bar', file: '/a/b.js', line: 10, col: 20 });
        });

        it('parses bare frame', () => {
            const frame = parseFrame('at /a/b.js:5:3');
            assert.deepEqual(frame, { func: '<anonymous>', file: '/a/b.js', line: 5, col: 3 });
        });

        it('returns null for unparseable line', () => {
            assert.equal(parseFrame('not a frame'), null);
            assert.equal(parseFrame('at <unknown>'), null);
        });
    });

    describe('resolveFilePath', () => {
        const repoRoot = '/repo';

        it('resolves relative path', () => {
            const result = resolveFilePath('server/handler.js', repoRoot);
            assert.equal(result, '/repo/server/handler.js');
        });

        it('strips URL prefix', () => {
            const result = resolveFilePath('http://localhost:3000/server/handler.js', repoRoot);
            assert.equal(result, '/repo/server/handler.js');
        });

        it('strips webpack prefix', () => {
            const result = resolveFilePath('webpack-internal:///server/handler.js', repoRoot);
            assert.equal(result, '/repo/server/handler.js');
        });

        it('blocks path traversal', () => {
            assert.equal(resolveFilePath('../etc/passwd', repoRoot), null);
            assert.equal(resolveFilePath('../../secret', repoRoot), null);
        });

        it('returns null for empty input', () => {
            assert.equal(resolveFilePath('', repoRoot), null);
            assert.equal(resolveFilePath(null, repoRoot), null);
        });

        it('tries source roots after direct resolution', () => {
            // Direct resolution /repo/handler.js succeeds first
            const result = resolveFilePath('handler.js', repoRoot, { sourceRoots: ['src'] });
            assert.equal(result, '/repo/handler.js');
            // Source root used when file ref doesn't resolve directly
            // (e.g., when file is in a subdirectory not matching direct path)
        });
    });

    describe('parseBlamePorcelain', () => {
        it('parses porcelain output', () => {
            const output = [
                'abc1234567890123456789012345678901234567 10 10 1',
                'author Alice',
                'author-time 1700000000',
                '\tconst x = 1;',
                'def4567890123456789012345678901234567890 11 11 1',
                'author Bob',
                'author-time 1700001000',
                '\tconst y = 2;',
            ].join('\n');

            const commits = parseBlamePorcelain(output);
            assert.equal(commits.length, 2);
            assert.equal(commits[0].author, 'Alice');
            assert.equal(commits[0].finalLine, 10);
            assert.equal(commits[0].content, 'const x = 1;');
            assert.equal(commits[1].author, 'Bob');
            assert.equal(commits[1].content, 'const y = 2;');
        });

        it('returns empty for null input', () => {
            assert.deepEqual(parseBlamePorcelain(null), []);
            assert.deepEqual(parseBlamePorcelain(''), []);
        });
    });

    describe('parseGitLog', () => {
        it('parses log output', () => {
            const output = 'abc1234\nAlice\n2024-01-15T10:00:00+00:00\nfix: bug\n---\ndef5678\nBob\n2024-01-14T10:00:00+00:00\nfeat: new\n---\n';
            const entries = parseGitLog(output);
            assert.equal(entries.length, 2);
            assert.equal(entries[0].hash, 'abc1234');
            assert.equal(entries[0].author, 'Alice');
            assert.equal(entries[0].message, 'fix: bug');
        });
    });

    describe('analyzeBlame', () => {
        it('returns null when no frames are found', async () => {
            const result = await analyzeBlame({ stack: null, source: null, line: null }, '/repo');
            assert.equal(result, null);
        });

        it('uses source/line fallback when stack is empty', async () => {
            // Mock exec returns empty blame/log output
            const mockExec = async () => '';
            const result = await analyzeBlame(
                { stack: '', source: 'server/index.js', line: 5 },
                '/repo',
                { execFn: mockExec }
            );
            // resolveFilePath('/repo', 'server/index.js') resolves directly
            // and mock exec succeeds with empty output
            assert.ok(result !== null);
            assert.equal(result.sourceFile, 'server/index.js');
            assert.equal(result.errorLine, 5);
            assert.equal(result.errorFunc, '<error-source>');
        });
    });
});

// ── Fix Generator Tests ─────────────────────────────────────────────

describe('Fix Generator', () => {
    describe('validateFixResult', () => {
        it('validates a good fix result', () => {
            const raw = {
                confidence: 0.92,
                analysis: 'Null pointer dereference on optional field',
                fix: {
                    files: [
                        { path: 'server/handler.js', original: 'x.foo', replacement: 'x?.foo' },
                    ],
                    description: 'Add optional chaining for nullable field',
                    test_plan: 'Run unit tests with null input',
                },
                risks: 'none',
                alternative: null,
            };

            const result = validateFixResult(raw, 0.8);
            assert.equal(result.confidence, 0.92);
            assert.equal(result.isDraft, false);
            assert.equal(result.fix.files.length, 1);
            assert.equal(result.fix.files[0].path, 'server/handler.js');
        });

        it('marks as draft when below threshold', () => {
            const result = validateFixResult({ confidence: 0.5, analysis: 'unclear', fix: null }, 0.8);
            assert.equal(result.isDraft, true);
            assert.equal(result.fix, null);
        });

        it('clamps confidence to [0, 1]', () => {
            assert.equal(validateFixResult({ confidence: 1.5 }).confidence, 1);
            assert.equal(validateFixResult({ confidence: -0.5 }).confidence, 0);
        });

        it('handles missing fields', () => {
            const result = validateFixResult({});
            assert.equal(result.confidence, 0);
            assert.equal(result.analysis, 'No analysis provided');
            assert.equal(result.fix, null);
            assert.equal(result.isDraft, true);
        });

        it('filters invalid fix files', () => {
            const raw = {
                confidence: 0.9,
                analysis: 'test',
                fix: {
                    files: [
                        { path: 'a.js', original: 'old', replacement: 'new' },
                        { path: null, original: 'x', replacement: 'y' },
                        'not an object',
                    ],
                    description: 'desc',
                    test_plan: 'plan',
                },
            };
            const result = validateFixResult(raw);
            assert.equal(result.fix.files.length, 1);
        });
    });

    describe('buildFixPrompt', () => {
        it('builds prompt with error info', () => {
            const prompt = buildFixPrompt(
                { type: 'js-error', message: 'Cannot read property', severity: 'error', url: 'https://test.com' },
                null
            );
            assert.ok(prompt.includes('js-error'));
            assert.ok(prompt.includes('Cannot read property'));
        });

        it('includes blame info when available', () => {
            const prompt = buildFixPrompt(
                { type: 'js-error', message: 'err', stack: 'at x (y:1:1)' },
                {
                    sourceFile: 'server/handler.js',
                    errorLine: 42,
                    blame: { commits: [{ finalLine: 42, content: 'bad code', author: 'Alice', hash: 'abc1234' }] },
                    recentChanges: [{ hash: 'abc1234', author: 'Alice', message: 'fix something' }],
                }
            );
            assert.ok(prompt.includes('server/handler.js'));
            assert.ok(prompt.includes('Alice'));
        });

        it('includes file contents and reproduction', () => {
            const prompt = buildFixPrompt(
                { type: 'js-error', message: 'err' },
                null,
                { fileContents: { 'a.js': 'const x = 1;' }, reproduction: 'Step 1: click button' }
            );
            assert.ok(prompt.includes('const x = 1;'));
            assert.ok(prompt.includes('Step 1'));
        });
    });

    describe('applyFix / revertFix', () => {
        it('returns empty for null fix', () => {
            const result = applyFix(null, '/repo');
            assert.deepEqual(result, { applied: [], failed: [] });
        });

        it('blocks path traversal', () => {
            const fix = { files: [{ path: '../../../etc/passwd', original: 'x', replacement: 'y' }] };
            const result = applyFix(fix, '/repo');
            assert.equal(result.failed.length, 1);
            assert.ok(result.failed[0].includes('path traversal'));
        });
    });
});

// ── PR Creator Tests ────────────────────────────────────────────────

describe('PR Creator', () => {
    describe('generateBranchName', () => {
        it('generates valid branch name', () => {
            const name = generateBranchName('42', 'Cannot read property "foo" of null');
            assert.ok(name.startsWith('autofix/42-'));
            assert.ok(!name.includes('"'));
            assert.ok(!name.includes(' '));
        });

        it('truncates long descriptions', () => {
            const longMsg = 'x'.repeat(200);
            const name = generateBranchName('1', longMsg);
            assert.ok(name.length <= 60); // autofix/1- = 10 + 40 max
        });

        it('handles empty message', () => {
            const name = generateBranchName('5', '');
            assert.equal(name, 'autofix/5-error');
        });
    });

    describe('buildCommitMessage', () => {
        it('builds commit with error info', () => {
            const msg = buildCommitMessage(
                { type: 'js-error', message: 'null ref' },
                { description: 'Added null check' },
                { sourceFile: 'handler.js', errorLine: 10 }
            );
            assert.ok(msg.startsWith('fix: [AutoFix][JS]'));
            assert.ok(msg.includes('null ref'));
            assert.ok(msg.includes('handler.js:10'));
            assert.ok(msg.includes('Auto-generated'));
        });

        it('handles missing fields', () => {
            const msg = buildCommitMessage({}, { description: 'fix' }, null);
            assert.ok(msg.includes('[AutoFix]'));
        });
    });

    describe('buildMrDescription', () => {
        it('builds full MR description', () => {
            const desc = buildMrDescription(
                { type: 'js-error', severity: 'error', message: 'null ref', url: 'https://test.com' },
                {
                    confidence: 0.95,
                    isDraft: false,
                    analysis: 'Missing null check on optional field',
                    fix: {
                        files: [{ path: 'handler.js', original: 'x', replacement: 'y' }],
                        description: 'Add null guard',
                        test_plan: 'Run test suite',
                    },
                    risks: 'none',
                    alternative: null,
                },
                { sourceFile: 'handler.js', errorLine: 42, recentChanges: [] },
                { gitlab_issue_id: '99', gitlab_issue_url: 'https://git.example.com/issues/99', count: 15 }
            );

            assert.ok(desc.includes('95%'));
            assert.ok(desc.includes('Missing null check'));
            assert.ok(desc.includes('handler.js'));
            assert.ok(desc.includes('Closes #99'));
            assert.ok(desc.includes('Auto-generated'));
        });

        it('marks draft in confidence display', () => {
            const desc = buildMrDescription(
                { type: 'js-error', severity: 'error', message: 'err' },
                { confidence: 0.5, isDraft: true, analysis: 'uncertain', fix: null, risks: 'high', alternative: 'Manual fix' },
                null,
                null
            );
            assert.ok(desc.includes('Draft'));
            assert.ok(desc.includes('Manual fix'));
        });
    });
});

// ── Notifier Tests ──────────────────────────────────────────────────

describe('Notifier', () => {
    const mockEvent = { type: 'js-error', message: 'null ref', severity: 'error', url: 'https://test.com', fingerprint: 'abc123' };
    const mockFix = { confidence: 0.9, isDraft: false, analysis: 'Null check missing', fix: { description: 'Add guard', files: [{ path: 'a.js' }] } };
    const mockMr = { iid: 42, url: 'https://git.example.com/mr/42' };
    const mockIssue = { gitlab_issue_id: '10', gitlab_issue_url: 'https://git.example.com/issues/10', count: 5 };

    describe('formatNotification', () => {
        it('formats default payload', () => {
            const payload = formatNotification({
                errorEvent: mockEvent, fixResult: mockFix, mr: mockMr, issue: mockIssue,
            });
            assert.equal(payload.event_type, 'autofix.submitted');
            assert.equal(payload.fix.confidence, 0.9);
            assert.equal(payload.merge_request.iid, 42);
            assert.equal(payload.issue.count, 5);
        });

        it('formats Slack payload', () => {
            const payload = formatNotification({
                errorEvent: mockEvent, fixResult: mockFix, mr: mockMr, issue: mockIssue,
                template: 'slack',
            });
            assert.ok(payload.attachments);
            assert.ok(payload.attachments[0].title.includes('AutoFix'));
            assert.equal(payload.attachments[0].title_link, mockMr.url);
        });

        it('formats Lark payload', () => {
            const payload = formatNotification({
                errorEvent: mockEvent, fixResult: mockFix, mr: mockMr, issue: mockIssue,
                template: 'lark',
            });
            assert.equal(payload.msg_type, 'interactive');
            assert.ok(payload.card.header.title.content.includes('AutoFix'));
        });

        it('indicates draft in title', () => {
            const payload = formatNotification({
                errorEvent: mockEvent,
                fixResult: { ...mockFix, isDraft: true },
                mr: mockMr,
                template: 'slack',
            });
            assert.ok(payload.attachments[0].title.includes('Draft'));
        });

        it('handles missing optional fields', () => {
            const payload = formatNotification({
                errorEvent: { type: 'error' },
                fixResult: { confidence: 0.5, isDraft: true },
                mr: { iid: 1, url: 'http://x' },
            });
            assert.equal(payload.event_type, 'autofix.submitted');
        });
    });
});

// ── Consumer Integration Tests ──────────────────────────────────────

describe('AutoFixConsumer', () => {
    const AutoFixConsumer = require('../server/agent/auto-fix/consumer');

    it('can be instantiated with required opts', () => {
        const consumer = new AutoFixConsumer({
            db: {},
            app_id: 'test',
            repoRoot: '/tmp/repo',
            gitlab: { token: 'x', project_id: '1' },
            geminiApiKey: 'key',
        });
        assert.equal(consumer.appId, 'test');
        assert.equal(consumer.confidenceThreshold, 0.8);
        assert.equal(consumer.maxAttempts, 3);
    });

    it('respects custom configuration', () => {
        const consumer = new AutoFixConsumer({
            db: {},
            app_id: 'custom',
            repoRoot: '/tmp/repo',
            gitlab: { token: 'x', project_id: '1' },
            geminiApiKey: 'key',
            pollInterval: 120000,
            maxAttempts: 5,
            batchSize: 10,
            confidenceThreshold: 0.6,
            baseBranch: 'main',
        });
        assert.equal(consumer.pollInterval, 120000);
        assert.equal(consumer.maxAttempts, 5);
        assert.equal(consumer.batchSize, 10);
        assert.equal(consumer.confidenceThreshold, 0.6);
        assert.equal(consumer.baseBranch, 'main');
    });

    it('start and stop control the timer', () => {
        const mockDb = {
            getAutoFixCandidates: () => [],
        };
        const consumer = new AutoFixConsumer({
            db: mockDb,
            app_id: 'test',
            repoRoot: '/tmp/repo',
            gitlab: { token: 'x', project_id: '1' },
            geminiApiKey: 'key',
            pollInterval: 999999, // long interval to avoid actual polls
        });

        consumer.start();
        assert.ok(consumer._timer !== null);

        consumer.stop();
        assert.equal(consumer._timer, null);
    });

    it('skips poll when busy', async () => {
        let pollCount = 0;
        const mockDb = {
            getAutoFixCandidates: () => { pollCount++; return []; },
        };
        const consumer = new AutoFixConsumer({
            db: mockDb,
            app_id: 'test',
            repoRoot: '/tmp/repo',
            gitlab: { token: 'x', project_id: '1' },
            geminiApiKey: 'key',
        });

        consumer._busy = true;
        await consumer._poll();
        assert.equal(pollCount, 0); // should not have called getAutoFixCandidates
    });

    it('processes empty candidate list gracefully', async () => {
        const mockDb = {
            getAutoFixCandidates: () => [],
        };
        const consumer = new AutoFixConsumer({
            db: mockDb,
            app_id: 'test',
            repoRoot: '/tmp/repo',
            gitlab: { token: 'x', project_id: '1' },
            geminiApiKey: 'key',
        });

        await consumer._poll();
        assert.equal(consumer._busy, false);
    });

    it('marks issue failed when no events found', async () => {
        let fixStatus = null;
        const mockDb = {
            getAutoFixCandidates: () => [{ fingerprint: 'fp1', fix_attempt_count: 0 }],
            updateAutoFixStatus: (params) => { fixStatus = params.fix_status; },
            getPerceptionEventsByFingerprint: () => [],
        };
        const consumer = new AutoFixConsumer({
            db: mockDb,
            app_id: 'test',
            repoRoot: '/tmp/repo',
            gitlab: { token: 'x', project_id: '1' },
            geminiApiKey: 'key',
        });

        await consumer._poll();
        assert.equal(fixStatus, 'failed');
    });
});
