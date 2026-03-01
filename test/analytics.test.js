/**
 * Tests for analytics features:
 * 1. DB analytics methods — trends, summary, hot topics, clustering data
 * 2. AI clustering — clusterAnnotations, validateClusters
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initDb } = require('../server/db');
const { clusterAnnotations, validateClusters } = require('../server/ai');

// ------------------------------------------------------------------ helpers

let dbApi;
let tmpDir;

function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmark-analytics-'));
    dbApi = initDb(tmpDir);
}

function teardown() {
    dbApi.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
}

function createTestItem(overrides = {}) {
    return dbApi.createItem({
        app_id: 'test-app',
        doc: '/test',
        type: 'issue',
        title: 'Test item',
        created_by: 'tester',
        source_url: 'https://example.com',
        source_title: 'Example',
        tags: ['bug'],
        ...overrides,
    });
}

// Mock AI for clustering tests
function mockClusterAI(response) {
    return async () => JSON.stringify(response);
}

// ------------------------------------------------------------------ DB analytics

describe('getAnalyticsSummary', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('returns empty stats for fresh database', () => {
        const summary = dbApi.getAnalyticsSummary('test-app');
        assert.equal(summary.total, 0);
        assert.deepEqual(summary.byStatus, []);
        assert.deepEqual(summary.byType, []);
        assert.deepEqual(summary.byClassification, []);
        assert.deepEqual(summary.topUrls, []);
        assert.deepEqual(summary.topTags, []);
    });

    it('returns correct totals after creating items', () => {
        createTestItem();
        createTestItem({ type: 'discuss' });
        createTestItem({ source_url: 'https://other.com', source_title: 'Other' });

        const summary = dbApi.getAnalyticsSummary('test-app');
        assert.equal(summary.total, 3);
        assert.ok(summary.byStatus.some(s => s.status === 'open'));
    });

    it('counts types correctly', () => {
        createTestItem({ type: 'issue' });
        createTestItem({ type: 'issue' });
        createTestItem({ type: 'discuss' });

        const summary = dbApi.getAnalyticsSummary('test-app');
        const issues = summary.byType.find(t => t.type === 'issue');
        const discussions = summary.byType.find(t => t.type === 'discuss');
        assert.equal(issues.count, 2);
        assert.equal(discussions.count, 1);
    });

    it('aggregates tag counts', () => {
        createTestItem({ tags: ['bug', 'ui'] });
        createTestItem({ tags: ['bug', 'performance'] });
        createTestItem({ tags: ['ui'] });

        const summary = dbApi.getAnalyticsSummary('test-app');
        const bugTag = summary.topTags.find(t => t.tag === 'bug');
        const uiTag = summary.topTags.find(t => t.tag === 'ui');
        assert.equal(bugTag.count, 2);
        assert.equal(uiTag.count, 2);
    });

    it('lists top URLs by count', () => {
        createTestItem({ source_url: 'https://a.com' });
        createTestItem({ source_url: 'https://a.com' });
        createTestItem({ source_url: 'https://b.com' });

        const summary = dbApi.getAnalyticsSummary('test-app');
        assert.equal(summary.topUrls[0].source_url, 'https://a.com');
        assert.equal(summary.topUrls[0].count, 2);
    });

    it('includes classification breakdown', () => {
        const item1 = createTestItem();
        const item2 = createTestItem();
        dbApi.updateItemClassification(item1.id, 'bug', 0.9);
        dbApi.updateItemClassification(item2.id, 'bug', 0.8);

        const summary = dbApi.getAnalyticsSummary('test-app');
        const bugs = summary.byClassification.find(c => c.classification === 'bug');
        assert.equal(bugs.count, 2);
    });

    it('scopes to app_id', () => {
        createTestItem({ app_id: 'app-a' });
        createTestItem({ app_id: 'app-b' });

        const summaryA = dbApi.getAnalyticsSummary('app-a');
        const summaryB = dbApi.getAnalyticsSummary('app-b');
        assert.equal(summaryA.total, 1);
        assert.equal(summaryB.total, 1);
    });
});

describe('getAnalyticsTrends', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('returns daily trend data', () => {
        createTestItem();
        createTestItem();

        const trends = dbApi.getAnalyticsTrends({ app_id: 'test-app', period: 'day', days: 7 });
        assert.ok(Array.isArray(trends));
        assert.ok(trends.length > 0);
        assert.equal(trends[0].count, 2);
    });

    it('returns empty trends for no data', () => {
        const trends = dbApi.getAnalyticsTrends({ app_id: 'test-app', period: 'day', days: 7 });
        assert.deepEqual(trends, []);
    });

    it('groups by classification when requested', () => {
        const item1 = createTestItem();
        const item2 = createTestItem();
        dbApi.updateItemClassification(item1.id, 'bug', 0.9);
        dbApi.updateItemClassification(item2.id, 'feature_request', 0.8);

        const trends = dbApi.getAnalyticsTrends({ app_id: 'test-app', period: 'day', days: 7, group_by: 'classification' });
        assert.ok(trends.length >= 2);
        assert.ok(trends.some(t => t.group_value === 'bug'));
        assert.ok(trends.some(t => t.group_value === 'feature_request'));
    });

    it('supports weekly period', () => {
        createTestItem();
        const trends = dbApi.getAnalyticsTrends({ app_id: 'test-app', period: 'week', days: 30 });
        assert.ok(Array.isArray(trends));
        assert.ok(trends[0].period.includes('W'));
    });

    it('supports monthly period', () => {
        createTestItem();
        const trends = dbApi.getAnalyticsTrends({ app_id: 'test-app', period: 'month', days: 365 });
        assert.ok(Array.isArray(trends));
        assert.ok(/^\d{4}-\d{2}$/.test(trends[0].period));
    });
});

describe('getHotTopics', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('returns empty when no recent items', () => {
        const hot = dbApi.getHotTopics({ app_id: 'test-app', hours: 24, threshold: 2 });
        assert.deepEqual(hot.hotUrls, []);
        assert.deepEqual(hot.hotClassifications, []);
        assert.deepEqual(hot.hotTags, []);
    });

    it('detects hot URLs', () => {
        createTestItem({ source_url: 'https://hot.com' });
        createTestItem({ source_url: 'https://hot.com' });
        createTestItem({ source_url: 'https://cold.com' });

        const hot = dbApi.getHotTopics({ app_id: 'test-app', hours: 24, threshold: 2 });
        assert.equal(hot.hotUrls.length, 1);
        assert.equal(hot.hotUrls[0].source_url, 'https://hot.com');
        assert.equal(hot.hotUrls[0].count, 2);
    });

    it('detects hot tags', () => {
        createTestItem({ tags: ['login', 'auth'] });
        createTestItem({ tags: ['login', 'mobile'] });

        const hot = dbApi.getHotTopics({ app_id: 'test-app', hours: 24, threshold: 2 });
        const loginTag = hot.hotTags.find(t => t.tag === 'login');
        assert.ok(loginTag);
        assert.equal(loginTag.count, 2);
    });

    it('respects threshold', () => {
        createTestItem({ source_url: 'https://a.com' });
        createTestItem({ source_url: 'https://a.com' });

        const hot3 = dbApi.getHotTopics({ app_id: 'test-app', hours: 24, threshold: 3 });
        assert.equal(hot3.hotUrls.length, 0);

        const hot2 = dbApi.getHotTopics({ app_id: 'test-app', hours: 24, threshold: 2 });
        assert.equal(hot2.hotUrls.length, 1);
    });

    it('includes window metadata', () => {
        const hot = dbApi.getHotTopics({ app_id: 'test-app', hours: 48, threshold: 5 });
        assert.equal(hot.window_hours, 48);
        assert.equal(hot.threshold, 5);
    });
});

describe('getRecentItemsForClustering', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('returns recent items within the time window', () => {
        createTestItem();
        createTestItem();

        const items = dbApi.getRecentItemsForClustering({ app_id: 'test-app', days: 7, limit: 100 });
        assert.equal(items.length, 2);
        assert.ok(items[0].id);
        assert.ok(items[0].source_url);
    });

    it('respects limit', () => {
        createTestItem();
        createTestItem();
        createTestItem();

        const items = dbApi.getRecentItemsForClustering({ app_id: 'test-app', days: 7, limit: 2 });
        assert.equal(items.length, 2);
    });

    it('returns only necessary columns', () => {
        createTestItem();
        const items = dbApi.getRecentItemsForClustering({ app_id: 'test-app', days: 7, limit: 10 });
        assert.ok(items[0].id);
        assert.ok(items[0].created_at);
        // Should not include full metadata or messages
        assert.equal(items[0].metadata, undefined);
        assert.equal(items[0].messages, undefined);
    });
});

// ------------------------------------------------------------------ AI clustering

describe('clusterAnnotations', () => {
    const testItems = [
        { id: 'item-1', source_url: 'https://a.com', title: 'Login bug', classification: 'bug', tags: '["login"]' },
        { id: 'item-2', source_url: 'https://a.com', title: 'Login broken on mobile', classification: 'bug', tags: '["login","mobile"]' },
        { id: 'item-3', source_url: 'https://b.com', title: 'Add dark mode', classification: 'feature_request', tags: '["ui"]' },
    ];

    it('clusters items with valid AI response', async () => {
        const result = await clusterAnnotations({
            items: testItems,
            apiKey: 'test',
            callAI: mockClusterAI({
                clusters: [
                    { label: 'Login issues', description: 'Login bugs', item_ids: ['item-1', 'item-2'], severity: 'high' },
                    { label: 'UI requests', description: 'UI feature requests', item_ids: ['item-3'], severity: 'low' },
                ],
                summary: 'Login bugs and UI requests',
            }),
        });

        assert.equal(result.clusters.length, 2);
        assert.equal(result.clusters[0].label, 'Login issues');
        assert.equal(result.clusters[0].count, 2);
        assert.equal(result.clusters[0].severity, 'high');
        assert.ok(result.summary.length > 0);
    });

    it('returns empty clusters when no items', async () => {
        const result = await clusterAnnotations({
            items: [],
            apiKey: 'test',
        });
        assert.deepEqual(result.clusters, []);
    });

    it('filters out invalid item_ids', async () => {
        const result = await clusterAnnotations({
            items: testItems,
            apiKey: 'test',
            callAI: mockClusterAI({
                clusters: [
                    { label: 'Test', description: 'Test', item_ids: ['item-1', 'nonexistent'], severity: 'medium' },
                ],
                summary: 'Test',
            }),
        });

        assert.equal(result.clusters[0].count, 1);
        assert.deepEqual(result.clusters[0].item_ids, ['item-1']);
    });

    it('throws when AI returns invalid JSON', async () => {
        await assert.rejects(
            () => clusterAnnotations({
                items: testItems,
                apiKey: 'test',
                callAI: async () => 'not json',
            }),
            { message: 'AI returned invalid JSON' }
        );
    });

    it('handles AI returning non-array clusters', async () => {
        const result = await clusterAnnotations({
            items: testItems,
            apiKey: 'test',
            callAI: mockClusterAI({ clusters: 'not-an-array', summary: 'failed' }),
        });
        assert.deepEqual(result.clusters, []);
    });

    it('sorts clusters by size (largest first)', async () => {
        const result = await clusterAnnotations({
            items: testItems,
            apiKey: 'test',
            callAI: mockClusterAI({
                clusters: [
                    { label: 'Small', description: 'Small', item_ids: ['item-3'], severity: 'low' },
                    { label: 'Large', description: 'Large', item_ids: ['item-1', 'item-2'], severity: 'high' },
                ],
                summary: 'Test',
            }),
        });

        assert.equal(result.clusters[0].label, 'Large');
        assert.equal(result.clusters[1].label, 'Small');
    });

    it('limits to MAX_CLUSTERS (10)', async () => {
        const manyItems = Array.from({ length: 15 }, (_, i) => ({
            id: `item-${i}`, source_url: `https://${i}.com`, title: `Item ${i}`,
        }));
        const manyClusters = Array.from({ length: 15 }, (_, i) => ({
            label: `Cluster ${i}`, description: `Cluster ${i}`, item_ids: [`item-${i}`], severity: 'medium',
        }));

        const result = await clusterAnnotations({
            items: manyItems,
            apiKey: 'test',
            callAI: mockClusterAI({ clusters: manyClusters, summary: 'Many clusters' }),
        });

        assert.ok(result.clusters.length <= 10);
    });
});

describe('validateClusters', () => {
    const items = [
        { id: 'a' }, { id: 'b' }, { id: 'c' },
    ];

    it('validates and normalizes cluster data', () => {
        const result = validateClusters({
            clusters: [
                { label: 'Test', description: 'Test desc', item_ids: ['a', 'b'], severity: 'high' },
            ],
            summary: 'Overall summary',
        }, items);

        assert.equal(result.clusters[0].label, 'Test');
        assert.equal(result.clusters[0].count, 2);
        assert.equal(result.summary, 'Overall summary');
    });

    it('defaults severity to medium for invalid values', () => {
        const result = validateClusters({
            clusters: [{ label: 'Test', item_ids: ['a'], severity: 'critical' }],
            summary: '',
        }, items);
        assert.equal(result.clusters[0].severity, 'medium');
    });

    it('removes clusters with no valid item_ids', () => {
        const result = validateClusters({
            clusters: [
                { label: 'Valid', item_ids: ['a'], severity: 'low' },
                { label: 'Invalid', item_ids: ['x', 'y'], severity: 'low' },
            ],
            summary: '',
        }, items);
        assert.equal(result.clusters.length, 1);
        assert.equal(result.clusters[0].label, 'Valid');
    });

    it('truncates long label and description', () => {
        const result = validateClusters({
            clusters: [{
                label: 'x'.repeat(200),
                description: 'y'.repeat(600),
                item_ids: ['a'],
                severity: 'medium',
            }],
            summary: 'z'.repeat(600),
        }, items);
        assert.equal(result.clusters[0].label.length, 100);
        assert.equal(result.clusters[0].description.length, 500);
        assert.equal(result.summary.length, 500);
    });

    it('handles null/undefined cluster entries', () => {
        const result = validateClusters({
            clusters: [null, undefined, { label: 'Valid', item_ids: ['a'], severity: 'low' }],
            summary: '',
        }, items);
        assert.equal(result.clusters.length, 1);
    });

    it('returns empty for missing clusters array', () => {
        const result = validateClusters({ summary: 'test' }, items);
        assert.deepEqual(result.clusters, []);
    });
});
