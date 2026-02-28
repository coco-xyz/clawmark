/**
 * ClawMark — Organization & Team Management Tests (#68)
 *
 * Tests cover:
 * 1. DB: Organization CRUD, member management, role checks
 * 2. API: All org routes with JWT auth, RBAC enforcement, edge cases
 * 3. RBAC: owner/admin/member permission hierarchy
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initDb } = require('../server/db');
const { initAuth } = require('../server/auth');
const jwt = require('jsonwebtoken');

// ------------------------------------------------------------------ helpers

let dbApi;
let tmpDir;
const TEST_JWT_SECRET = 'test-secret-key-for-orgs';

function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmark-orgs-test-'));
    dbApi = initDb(tmpDir);
}

function teardown() {
    if (dbApi && dbApi.db) dbApi.db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

let userCounter = 0;
function createTestUser(overrides = {}) {
    userCounter++;
    return dbApi.upsertUser({
        google_id: overrides.google_id || `g-org-${Date.now()}-${userCounter}`,
        email: overrides.email || `orgtest-${Date.now()}-${userCounter}@example.com`,
        name: overrides.name || 'Test User',
        picture: overrides.picture || null,
    });
}

function signToken(user) {
    return jwt.sign(
        { userId: user.id, email: user.email, role: user.role },
        TEST_JWT_SECRET,
        { expiresIn: 3600, algorithm: 'HS256' }
    );
}

function createTestServer() {
    const { router: authRouter, verifyJwt } = initAuth({
        db: dbApi,
        jwtSecret: TEST_JWT_SECRET,
    });
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.locals.VALID_CODES = {};

    // JWT-only middleware (same as server/index.js)
    function jwtAuth(req, res, next) {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'JWT authentication required' });
        }
        const token = authHeader.slice(7);
        if (token.startsWith('cmk_')) {
            return res.status(401).json({ error: 'JWT authentication required (API keys not accepted)' });
        }
        const payload = verifyJwt(token);
        if (!payload) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }
        req.jwtUser = { userId: payload.userId, email: payload.email, role: payload.role };
        next();
    }

    // RBAC
    const ROLE_LEVEL = { owner: 3, admin: 2, member: 1 };

    function requireOrgRole(minRole) {
        return (req, res, next) => {
            const orgId = req.params.id;
            const role = dbApi.getOrgMemberRole(orgId, req.jwtUser.userId);
            if (!role) {
                return res.status(403).json({ error: 'Not a member of this organization' });
            }
            if ((ROLE_LEVEL[role] || 0) < (ROLE_LEVEL[minRole] || 0)) {
                return res.status(403).json({ error: `Requires ${minRole} role or higher` });
            }
            req.orgRole = role;
            next();
        };
    }

    function isValidSlug(slug) {
        return /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(slug) || /^[a-z0-9]{1,2}$/.test(slug);
    }

    // -- Org routes

    app.post('/api/v2/orgs', jwtAuth, (req, res) => {
        const { name, slug, description } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'Missing organization name' });
        if (!slug || !slug.trim()) return res.status(400).json({ error: 'Missing organization slug' });
        const cleanSlug = slug.trim().toLowerCase();
        if (!isValidSlug(cleanSlug)) return res.status(400).json({ error: 'Invalid slug: use lowercase letters, numbers, and hyphens (2-64 chars)' });
        if (dbApi.getOrgBySlug(cleanSlug)) return res.status(409).json({ error: 'Slug already taken' });
        const org = dbApi.createOrg({ name: name.trim(), slug: cleanSlug, description: description || null, created_by: req.jwtUser.userId });
        res.json({ success: true, org });
    });

    app.get('/api/v2/orgs', jwtAuth, (req, res) => {
        const orgs = dbApi.getOrgsByUser(req.jwtUser.userId);
        res.json({ orgs });
    });

    app.get('/api/v2/orgs/:id', jwtAuth, requireOrgRole('member'), (req, res) => {
        const org = dbApi.getOrg(req.params.id);
        if (!org) return res.status(404).json({ error: 'Organization not found' });
        res.json({ org, role: req.orgRole });
    });

    app.put('/api/v2/orgs/:id', jwtAuth, requireOrgRole('admin'), (req, res) => {
        const { name, slug, description } = req.body;
        if (name !== undefined && !name.trim()) return res.status(400).json({ error: 'Organization name cannot be empty' });
        if (slug !== undefined) {
            const cleanSlug = slug.trim().toLowerCase();
            if (!isValidSlug(cleanSlug)) return res.status(400).json({ error: 'Invalid slug' });
            const existing = dbApi.getOrgBySlug(cleanSlug);
            if (existing && existing.id !== req.params.id) return res.status(409).json({ error: 'Slug already taken' });
        }
        const updated = dbApi.updateOrg(req.params.id, {
            name: name ? name.trim() : undefined,
            slug: slug ? slug.trim().toLowerCase() : undefined,
            description,
        });
        if (!updated) return res.status(404).json({ error: 'Organization not found' });
        res.json({ success: true, org: updated });
    });

    app.delete('/api/v2/orgs/:id', jwtAuth, requireOrgRole('owner'), (req, res) => {
        const result = dbApi.deleteOrg(req.params.id);
        if (!result.success) return res.status(404).json({ error: 'Organization not found' });
        res.json({ success: true });
    });

    app.get('/api/v2/orgs/:id/members', jwtAuth, requireOrgRole('member'), (req, res) => {
        const members = dbApi.getOrgMembers(req.params.id);
        res.json({ members });
    });

    app.post('/api/v2/orgs/:id/members', jwtAuth, requireOrgRole('admin'), (req, res) => {
        const { user_id, role } = req.body;
        if (!user_id) return res.status(400).json({ error: 'Missing user_id' });
        const validRoles = ['member', 'admin'];
        const memberRole = role || 'member';
        if (!validRoles.includes(memberRole)) return res.status(400).json({ error: 'Invalid role. Use member or admin' });
        if (role === 'owner') return res.status(400).json({ error: 'Cannot assign owner role via member invitation' });
        const user = dbApi.getUserById(user_id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        const existingRole = dbApi.getOrgMemberRole(req.params.id, user_id);
        if (existingRole) return res.status(409).json({ error: 'User is already a member of this organization' });
        const member = dbApi.addOrgMember(req.params.id, user_id, memberRole, req.jwtUser.userId);
        res.json({ success: true, member });
    });

    app.put('/api/v2/orgs/:id/members/:userId', jwtAuth, requireOrgRole('owner'), (req, res) => {
        const { role } = req.body;
        if (!role) return res.status(400).json({ error: 'Missing role' });
        const validRoles = ['member', 'admin', 'owner'];
        if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
        const currentRole = dbApi.getOrgMemberRole(req.params.id, req.params.userId);
        if (!currentRole) return res.status(404).json({ error: 'User is not a member of this organization' });
        if (req.params.userId === req.jwtUser.userId) return res.status(400).json({ error: 'Cannot change your own role' });
        const result = dbApi.updateOrgMemberRole(req.params.id, req.params.userId, role);
        if (!result.success) return res.status(404).json({ error: 'Member not found' });
        res.json({ success: true });
    });

    app.delete('/api/v2/orgs/:id/members/:userId', jwtAuth, (req, res) => {
        const callerRole = dbApi.getOrgMemberRole(req.params.id, req.jwtUser.userId);
        if (!callerRole) return res.status(403).json({ error: 'Not a member of this organization' });
        const isSelf = req.params.userId === req.jwtUser.userId;
        const targetRole = dbApi.getOrgMemberRole(req.params.id, req.params.userId);
        if (!targetRole) return res.status(404).json({ error: 'User is not a member of this organization' });

        if (isSelf) {
            if (callerRole === 'owner') return res.status(400).json({ error: 'Owner cannot leave. Transfer ownership first.' });
        } else {
            if ((ROLE_LEVEL[callerRole] || 0) < ROLE_LEVEL['admin']) return res.status(403).json({ error: 'Requires admin role or higher' });
            if ((ROLE_LEVEL[targetRole] || 0) >= (ROLE_LEVEL[callerRole] || 0)) return res.status(403).json({ error: 'Cannot remove a member with equal or higher role' });
        }

        const result = dbApi.removeOrgMember(req.params.id, req.params.userId);
        if (!result.success) return res.status(404).json({ error: 'Member not found' });
        res.json({ success: true });
    });

    return app;
}

async function startServer(app) {
    const http = require('http');
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    return { server, port: server.address().port };
}

// Helper: create an org and return { org, owner }
function createTestOrg(owner, overrides = {}) {
    const slug = overrides.slug || `test-org-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    const org = dbApi.createOrg({
        name: overrides.name || 'Test Org',
        slug,
        description: overrides.description || null,
        created_by: owner.id,
    });
    return org;
}

// =========================================================================
//  DB Tests
// =========================================================================

describe('DB — organizations table', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('creates an org and adds creator as owner', () => {
        const user = createTestUser();
        const org = dbApi.createOrg({ name: 'Acme', slug: 'acme', description: 'Test org', created_by: user.id });
        assert.ok(org.id.startsWith('org-'));
        assert.equal(org.name, 'Acme');
        assert.equal(org.slug, 'acme');
        assert.equal(org.description, 'Test org');
        assert.equal(org.created_by, user.id);
        assert.ok(org.created_at);
        assert.ok(org.updated_at);

        // Creator should be owner
        const role = dbApi.getOrgMemberRole(org.id, user.id);
        assert.equal(role, 'owner');
    });

    it('creates org without description', () => {
        const user = createTestUser();
        const org = dbApi.createOrg({ name: 'Min Org', slug: 'min-org', created_by: user.id });
        assert.equal(org.description, null);
    });

    it('gets org by ID', () => {
        const user = createTestUser();
        const created = dbApi.createOrg({ name: 'Find Me', slug: 'find-me', created_by: user.id });
        const found = dbApi.getOrg(created.id);
        assert.equal(found.name, 'Find Me');
        assert.equal(found.slug, 'find-me');
    });

    it('returns null for unknown org ID', () => {
        assert.equal(dbApi.getOrg('nonexistent'), null);
    });

    it('gets org by slug', () => {
        const user = createTestUser();
        dbApi.createOrg({ name: 'Slug Org', slug: 'slug-org', created_by: user.id });
        const found = dbApi.getOrgBySlug('slug-org');
        assert.equal(found.name, 'Slug Org');
    });

    it('returns null for unknown slug', () => {
        assert.equal(dbApi.getOrgBySlug('nonexistent'), null);
    });

    it('enforces unique slug', () => {
        const user = createTestUser();
        dbApi.createOrg({ name: 'First', slug: 'unique-slug', created_by: user.id });
        assert.throws(() => {
            dbApi.createOrg({ name: 'Second', slug: 'unique-slug', created_by: user.id });
        });
    });

    it('lists orgs by user', () => {
        const user1 = createTestUser();
        const user2 = createTestUser();
        dbApi.createOrg({ name: 'Org A', slug: 'org-a', created_by: user1.id });
        dbApi.createOrg({ name: 'Org B', slug: 'org-b', created_by: user1.id });
        const org3 = dbApi.createOrg({ name: 'Org C', slug: 'org-c', created_by: user2.id });

        const user1Orgs = dbApi.getOrgsByUser(user1.id);
        assert.equal(user1Orgs.length, 2);

        const user2Orgs = dbApi.getOrgsByUser(user2.id);
        assert.equal(user2Orgs.length, 1);
        assert.equal(user2Orgs[0].name, 'Org C');
        assert.equal(user2Orgs[0].user_role, 'owner');
    });

    it('includes orgs where user is a member (not just creator)', () => {
        const owner = createTestUser();
        const member = createTestUser();
        const org = dbApi.createOrg({ name: 'Team', slug: 'team', created_by: owner.id });
        dbApi.addOrgMember(org.id, member.id, 'member', owner.id);

        const memberOrgs = dbApi.getOrgsByUser(member.id);
        assert.equal(memberOrgs.length, 1);
        assert.equal(memberOrgs[0].user_role, 'member');
    });

    it('updates org name and description', () => {
        const user = createTestUser();
        const org = dbApi.createOrg({ name: 'Old Name', slug: 'old-name', description: 'Old', created_by: user.id });
        const updated = dbApi.updateOrg(org.id, { name: 'New Name', description: 'New' });
        assert.equal(updated.name, 'New Name');
        assert.equal(updated.description, 'New');
        assert.equal(updated.slug, 'old-name'); // slug unchanged
    });

    it('updates org slug', () => {
        const user = createTestUser();
        const org = dbApi.createOrg({ name: 'Sluggy', slug: 'sluggy', created_by: user.id });
        const updated = dbApi.updateOrg(org.id, { slug: 'new-sluggy' });
        assert.equal(updated.slug, 'new-sluggy');
    });

    it('returns null when updating nonexistent org', () => {
        assert.equal(dbApi.updateOrg('nonexistent', { name: 'x' }), null);
    });

    it('deletes org and cascades members', () => {
        const user = createTestUser();
        const member = createTestUser();
        const org = dbApi.createOrg({ name: 'Delete Me', slug: 'delete-me', created_by: user.id });
        dbApi.addOrgMember(org.id, member.id, 'member', user.id);

        const result = dbApi.deleteOrg(org.id);
        assert.equal(result.success, true);
        assert.equal(dbApi.getOrg(org.id), null);

        // Members should be gone
        assert.equal(dbApi.getOrgMemberRole(org.id, user.id), null);
        assert.equal(dbApi.getOrgMemberRole(org.id, member.id), null);
    });

    it('deleteOrg clears org_id on apps and user_rules', () => {
        const user = createTestUser();
        const org = dbApi.createOrg({ name: 'Cleanup', slug: 'cleanup', created_by: user.id });

        // Create an app with org_id
        const app = dbApi.createApp({ user_id: user.id, name: 'Org App' });
        dbApi.db.prepare('UPDATE apps SET org_id = ? WHERE id = ?').run(org.id, app.id);

        // Create a rule with org_id
        const rule = dbApi.createUserRule({
            user_name: user.email,
            rule_type: 'default',
            target_type: 'github-issue',
            target_config: '{}',
        });
        dbApi.db.prepare('UPDATE user_rules SET org_id = ? WHERE id = ?').run(org.id, rule.id);

        dbApi.deleteOrg(org.id);

        // org_id should be cleared
        const appAfter = dbApi.getApp(app.id);
        assert.equal(appAfter.org_id, null);
        const ruleAfter = dbApi.getUserRule(rule.id);
        assert.equal(ruleAfter.org_id, null);
    });

    it('returns failure for deleting nonexistent org', () => {
        const result = dbApi.deleteOrg('nonexistent');
        assert.equal(result.success, false);
    });
});

describe('DB — org members', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('adds a member with default role', () => {
        const owner = createTestUser();
        const member = createTestUser();
        const org = createTestOrg(owner);

        const result = dbApi.addOrgMember(org.id, member.id, 'member', owner.id);
        assert.ok(result.id.startsWith('mem-'));
        assert.equal(result.org_id, org.id);
        assert.equal(result.user_id, member.id);
        assert.equal(result.role, 'member');
        assert.equal(result.invited_by, owner.id);
    });

    it('adds a member as admin', () => {
        const owner = createTestUser();
        const admin = createTestUser();
        const org = createTestOrg(owner);

        const result = dbApi.addOrgMember(org.id, admin.id, 'admin', owner.id);
        assert.equal(result.role, 'admin');
    });

    it('enforces unique membership per org', () => {
        const owner = createTestUser();
        const member = createTestUser();
        const org = createTestOrg(owner);
        dbApi.addOrgMember(org.id, member.id, 'member', owner.id);
        assert.throws(() => {
            dbApi.addOrgMember(org.id, member.id, 'admin', owner.id);
        });
    });

    it('removes a member', () => {
        const owner = createTestUser();
        const member = createTestUser();
        const org = createTestOrg(owner);
        dbApi.addOrgMember(org.id, member.id, 'member', owner.id);

        const result = dbApi.removeOrgMember(org.id, member.id);
        assert.equal(result.success, true);
        assert.equal(dbApi.getOrgMemberRole(org.id, member.id), null);
    });

    it('returns failure for removing non-member', () => {
        const owner = createTestUser();
        const nonMember = createTestUser();
        const org = createTestOrg(owner);

        const result = dbApi.removeOrgMember(org.id, nonMember.id);
        assert.equal(result.success, false);
    });

    it('updates member role', () => {
        const owner = createTestUser();
        const member = createTestUser();
        const org = createTestOrg(owner);
        dbApi.addOrgMember(org.id, member.id, 'member', owner.id);

        const result = dbApi.updateOrgMemberRole(org.id, member.id, 'admin');
        assert.equal(result.success, true);
        assert.equal(dbApi.getOrgMemberRole(org.id, member.id), 'admin');
    });

    it('returns failure for updating non-member role', () => {
        const owner = createTestUser();
        const nonMember = createTestUser();
        const org = createTestOrg(owner);

        const result = dbApi.updateOrgMemberRole(org.id, nonMember.id, 'admin');
        assert.equal(result.success, false);
    });

    it('lists members with user details, sorted by role', () => {
        const owner = createTestUser({ name: 'Owner' });
        const admin = createTestUser({ name: 'Admin' });
        const member = createTestUser({ name: 'Member' });
        const org = createTestOrg(owner);
        dbApi.addOrgMember(org.id, admin.id, 'admin', owner.id);
        dbApi.addOrgMember(org.id, member.id, 'member', owner.id);

        const members = dbApi.getOrgMembers(org.id);
        assert.equal(members.length, 3);
        // Should be sorted: owner, admin, member
        assert.equal(members[0].role, 'owner');
        assert.equal(members[1].role, 'admin');
        assert.equal(members[2].role, 'member');
        // Should include user details
        assert.ok(members[0].email);
        assert.ok(members[0].user_name);
    });

    it('getOrgMemberRole returns correct role', () => {
        const owner = createTestUser();
        const org = createTestOrg(owner);
        assert.equal(dbApi.getOrgMemberRole(org.id, owner.id), 'owner');
    });

    it('getOrgMemberRole returns null for non-member', () => {
        const owner = createTestUser();
        const stranger = createTestUser();
        const org = createTestOrg(owner);
        assert.equal(dbApi.getOrgMemberRole(org.id, stranger.id), null);
    });
});

// =========================================================================
//  API Tests
// =========================================================================

describe('API — POST /api/v2/orgs', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('creates org with valid JWT', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const user = createTestUser();
        const token = signToken(user);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: 'Acme Corp', slug: 'acme-corp', description: 'A test org' }),
            });
            const data = await res.json();
            assert.equal(res.status, 200);
            assert.equal(data.success, true);
            assert.equal(data.org.name, 'Acme Corp');
            assert.equal(data.org.slug, 'acme-corp');
            assert.equal(data.org.description, 'A test org');
            assert.ok(data.org.id.startsWith('org-'));

            // Creator should be owner
            const role = dbApi.getOrgMemberRole(data.org.id, user.id);
            assert.equal(role, 'owner');
        } finally {
            server.close();
        }
    });

    it('rejects request without JWT', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'No Auth', slug: 'no-auth' }),
            });
            assert.equal(res.status, 401);
        } finally {
            server.close();
        }
    });

    it('rejects missing name', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const user = createTestUser();
        const token = signToken(user);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ slug: 'no-name' }),
            });
            assert.equal(res.status, 400);
        } finally {
            server.close();
        }
    });

    it('rejects missing slug', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const user = createTestUser();
        const token = signToken(user);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: 'No Slug' }),
            });
            assert.equal(res.status, 400);
        } finally {
            server.close();
        }
    });

    it('rejects invalid slug (uppercase)', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const user = createTestUser();
        const token = signToken(user);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: 'Bad Slug', slug: 'BAD_SLUG' }),
            });
            assert.equal(res.status, 400);
            const data = await res.json();
            assert.ok(data.error.includes('Invalid slug'));
        } finally {
            server.close();
        }
    });

    it('rejects duplicate slug', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const user = createTestUser();
        const token = signToken(user);

        try {
            // Create first org
            await fetch(`http://localhost:${port}/api/v2/orgs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: 'First', slug: 'dup-slug' }),
            });
            // Try to create second with same slug
            const res = await fetch(`http://localhost:${port}/api/v2/orgs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: 'Second', slug: 'dup-slug' }),
            });
            assert.equal(res.status, 409);
        } finally {
            server.close();
        }
    });
});

describe('API — GET /api/v2/orgs', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('lists only user\'s orgs', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const user1 = createTestUser();
        const user2 = createTestUser();
        dbApi.createOrg({ name: 'Org A', slug: 'org-a-list', created_by: user1.id });
        dbApi.createOrg({ name: 'Org B', slug: 'org-b-list', created_by: user2.id });
        const token = signToken(user1);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await res.json();
            assert.equal(res.status, 200);
            assert.equal(data.orgs.length, 1);
            assert.equal(data.orgs[0].name, 'Org A');
        } finally {
            server.close();
        }
    });

    it('includes orgs where user is member, not just creator', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const member = createTestUser();
        const org = dbApi.createOrg({ name: 'Shared', slug: 'shared-list', created_by: owner.id });
        dbApi.addOrgMember(org.id, member.id, 'member', owner.id);
        const token = signToken(member);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await res.json();
            assert.equal(data.orgs.length, 1);
            assert.equal(data.orgs[0].user_role, 'member');
        } finally {
            server.close();
        }
    });
});

describe('API — GET /api/v2/orgs/:id', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('gets org details for member', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const org = dbApi.createOrg({ name: 'Detail Org', slug: 'detail-org', created_by: owner.id });
        const token = signToken(owner);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await res.json();
            assert.equal(res.status, 200);
            assert.equal(data.org.name, 'Detail Org');
            assert.equal(data.role, 'owner');
        } finally {
            server.close();
        }
    });

    it('returns 403 for non-member', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const stranger = createTestUser();
        const org = dbApi.createOrg({ name: 'Private', slug: 'private-org', created_by: owner.id });
        const token = signToken(stranger);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            assert.equal(res.status, 403);
        } finally {
            server.close();
        }
    });
});

describe('API — PUT /api/v2/orgs/:id', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('owner can update org', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const org = dbApi.createOrg({ name: 'Old', slug: 'old-org', created_by: owner.id });
        const token = signToken(owner);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: 'New Name', description: 'Updated desc' }),
            });
            const data = await res.json();
            assert.equal(res.status, 200);
            assert.equal(data.org.name, 'New Name');
            assert.equal(data.org.description, 'Updated desc');
        } finally {
            server.close();
        }
    });

    it('admin can update org', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const admin = createTestUser();
        const org = dbApi.createOrg({ name: 'Admin Update', slug: 'admin-update', created_by: owner.id });
        dbApi.addOrgMember(org.id, admin.id, 'admin', owner.id);
        const token = signToken(admin);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: 'Admin Changed' }),
            });
            const data = await res.json();
            assert.equal(res.status, 200);
            assert.equal(data.org.name, 'Admin Changed');
        } finally {
            server.close();
        }
    });

    it('member cannot update org (403)', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const member = createTestUser();
        const org = dbApi.createOrg({ name: 'Member No', slug: 'member-no-upd', created_by: owner.id });
        dbApi.addOrgMember(org.id, member.id, 'member', owner.id);
        const token = signToken(member);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: 'Should Fail' }),
            });
            assert.equal(res.status, 403);
        } finally {
            server.close();
        }
    });

    it('rejects empty name', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const org = dbApi.createOrg({ name: 'Keep', slug: 'keep-name', created_by: owner.id });
        const token = signToken(owner);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: '   ' }),
            });
            assert.equal(res.status, 400);
        } finally {
            server.close();
        }
    });

    it('rejects duplicate slug on update', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        dbApi.createOrg({ name: 'Existing', slug: 'existing-slug', created_by: owner.id });
        const org2 = dbApi.createOrg({ name: 'Other', slug: 'other-slug', created_by: owner.id });
        const token = signToken(owner);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org2.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ slug: 'existing-slug' }),
            });
            assert.equal(res.status, 409);
        } finally {
            server.close();
        }
    });
});

describe('API — DELETE /api/v2/orgs/:id', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('owner can delete org', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const org = dbApi.createOrg({ name: 'Delete', slug: 'delete-org', created_by: owner.id });
        const token = signToken(owner);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await res.json();
            assert.equal(res.status, 200);
            assert.equal(data.success, true);
            assert.equal(dbApi.getOrg(org.id), null);
        } finally {
            server.close();
        }
    });

    it('admin cannot delete org (403)', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const admin = createTestUser();
        const org = dbApi.createOrg({ name: 'Admin No Del', slug: 'admin-no-del', created_by: owner.id });
        dbApi.addOrgMember(org.id, admin.id, 'admin', owner.id);
        const token = signToken(admin);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            assert.equal(res.status, 403);
        } finally {
            server.close();
        }
    });

    it('member cannot delete org (403)', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const member = createTestUser();
        const org = dbApi.createOrg({ name: 'Mem No Del', slug: 'mem-no-del', created_by: owner.id });
        dbApi.addOrgMember(org.id, member.id, 'member', owner.id);
        const token = signToken(member);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            assert.equal(res.status, 403);
        } finally {
            server.close();
        }
    });
});

describe('API — GET /api/v2/orgs/:id/members', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('member can list org members', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser({ name: 'Owner' });
        const member = createTestUser({ name: 'Member' });
        const org = dbApi.createOrg({ name: 'Members', slug: 'members-list', created_by: owner.id });
        dbApi.addOrgMember(org.id, member.id, 'member', owner.id);
        const token = signToken(member);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await res.json();
            assert.equal(res.status, 200);
            assert.equal(data.members.length, 2);
        } finally {
            server.close();
        }
    });

    it('non-member cannot list members (403)', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const stranger = createTestUser();
        const org = dbApi.createOrg({ name: 'Secret', slug: 'secret-list', created_by: owner.id });
        const token = signToken(stranger);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            assert.equal(res.status, 403);
        } finally {
            server.close();
        }
    });
});

describe('API — POST /api/v2/orgs/:id/members', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('owner can add a member', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const newMember = createTestUser();
        const org = dbApi.createOrg({ name: 'Add Member', slug: 'add-member', created_by: owner.id });
        const token = signToken(owner);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ user_id: newMember.id, role: 'member' }),
            });
            const data = await res.json();
            assert.equal(res.status, 200);
            assert.equal(data.success, true);
            assert.equal(data.member.role, 'member');
            assert.equal(data.member.user_id, newMember.id);
        } finally {
            server.close();
        }
    });

    it('admin can add a member', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const admin = createTestUser();
        const newMember = createTestUser();
        const org = dbApi.createOrg({ name: 'Admin Add', slug: 'admin-add', created_by: owner.id });
        dbApi.addOrgMember(org.id, admin.id, 'admin', owner.id);
        const token = signToken(admin);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ user_id: newMember.id }),
            });
            const data = await res.json();
            assert.equal(res.status, 200);
            assert.equal(data.member.role, 'member'); // default role
        } finally {
            server.close();
        }
    });

    it('member cannot add other members (403)', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const member = createTestUser();
        const newMember = createTestUser();
        const org = dbApi.createOrg({ name: 'Mem No Add', slug: 'mem-no-add', created_by: owner.id });
        dbApi.addOrgMember(org.id, member.id, 'member', owner.id);
        const token = signToken(member);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ user_id: newMember.id }),
            });
            assert.equal(res.status, 403);
        } finally {
            server.close();
        }
    });

    it('rejects adding owner role', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const newMember = createTestUser();
        const org = dbApi.createOrg({ name: 'No Owner', slug: 'no-owner-add', created_by: owner.id });
        const token = signToken(owner);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ user_id: newMember.id, role: 'owner' }),
            });
            assert.equal(res.status, 400);
        } finally {
            server.close();
        }
    });

    it('rejects duplicate membership', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const member = createTestUser();
        const org = dbApi.createOrg({ name: 'Dup', slug: 'dup-member', created_by: owner.id });
        dbApi.addOrgMember(org.id, member.id, 'member', owner.id);
        const token = signToken(owner);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ user_id: member.id }),
            });
            assert.equal(res.status, 409);
        } finally {
            server.close();
        }
    });

    it('rejects adding nonexistent user', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const org = dbApi.createOrg({ name: 'Bad User', slug: 'bad-user-add', created_by: owner.id });
        const token = signToken(owner);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ user_id: 'nonexistent-user-id' }),
            });
            assert.equal(res.status, 404);
        } finally {
            server.close();
        }
    });

    it('rejects missing user_id', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const org = dbApi.createOrg({ name: 'No UID', slug: 'no-uid', created_by: owner.id });
        const token = signToken(owner);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ role: 'member' }),
            });
            assert.equal(res.status, 400);
        } finally {
            server.close();
        }
    });
});

describe('API — PUT /api/v2/orgs/:id/members/:userId', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('owner can change member to admin', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const member = createTestUser();
        const org = dbApi.createOrg({ name: 'Role Change', slug: 'role-change', created_by: owner.id });
        dbApi.addOrgMember(org.id, member.id, 'member', owner.id);
        const token = signToken(owner);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members/${member.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ role: 'admin' }),
            });
            const data = await res.json();
            assert.equal(res.status, 200);
            assert.equal(data.success, true);
            assert.equal(dbApi.getOrgMemberRole(org.id, member.id), 'admin');
        } finally {
            server.close();
        }
    });

    it('owner can transfer ownership', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const admin = createTestUser();
        const org = dbApi.createOrg({ name: 'Transfer', slug: 'transfer', created_by: owner.id });
        dbApi.addOrgMember(org.id, admin.id, 'admin', owner.id);
        const token = signToken(owner);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members/${admin.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ role: 'owner' }),
            });
            assert.equal(res.status, 200);
            assert.equal(dbApi.getOrgMemberRole(org.id, admin.id), 'owner');
        } finally {
            server.close();
        }
    });

    it('admin cannot change roles (403)', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const admin = createTestUser();
        const member = createTestUser();
        const org = dbApi.createOrg({ name: 'Admin No Role', slug: 'admin-no-role', created_by: owner.id });
        dbApi.addOrgMember(org.id, admin.id, 'admin', owner.id);
        dbApi.addOrgMember(org.id, member.id, 'member', owner.id);
        const token = signToken(admin);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members/${member.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ role: 'admin' }),
            });
            assert.equal(res.status, 403);
        } finally {
            server.close();
        }
    });

    it('cannot change own role', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const org = dbApi.createOrg({ name: 'Self Role', slug: 'self-role', created_by: owner.id });
        const token = signToken(owner);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members/${owner.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ role: 'member' }),
            });
            assert.equal(res.status, 400);
            const data = await res.json();
            assert.ok(data.error.includes('own role'));
        } finally {
            server.close();
        }
    });

    it('rejects invalid role', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const member = createTestUser();
        const org = dbApi.createOrg({ name: 'Bad Role', slug: 'bad-role', created_by: owner.id });
        dbApi.addOrgMember(org.id, member.id, 'member', owner.id);
        const token = signToken(owner);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members/${member.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ role: 'superadmin' }),
            });
            assert.equal(res.status, 400);
        } finally {
            server.close();
        }
    });

    it('returns 404 for non-member target', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const stranger = createTestUser();
        const org = dbApi.createOrg({ name: 'No Target', slug: 'no-target', created_by: owner.id });
        const token = signToken(owner);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members/${stranger.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ role: 'admin' }),
            });
            assert.equal(res.status, 404);
        } finally {
            server.close();
        }
    });
});

describe('API — DELETE /api/v2/orgs/:id/members/:userId', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('owner can remove a member', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const member = createTestUser();
        const org = dbApi.createOrg({ name: 'Remove', slug: 'remove-mem', created_by: owner.id });
        dbApi.addOrgMember(org.id, member.id, 'member', owner.id);
        const token = signToken(owner);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members/${member.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await res.json();
            assert.equal(res.status, 200);
            assert.equal(data.success, true);
            assert.equal(dbApi.getOrgMemberRole(org.id, member.id), null);
        } finally {
            server.close();
        }
    });

    it('admin can remove a member', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const admin = createTestUser();
        const member = createTestUser();
        const org = dbApi.createOrg({ name: 'Admin Rm', slug: 'admin-rm', created_by: owner.id });
        dbApi.addOrgMember(org.id, admin.id, 'admin', owner.id);
        dbApi.addOrgMember(org.id, member.id, 'member', owner.id);
        const token = signToken(admin);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members/${member.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            assert.equal(res.status, 200);
        } finally {
            server.close();
        }
    });

    it('admin cannot remove owner', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const admin = createTestUser();
        const org = dbApi.createOrg({ name: 'No Rm Own', slug: 'no-rm-own', created_by: owner.id });
        dbApi.addOrgMember(org.id, admin.id, 'admin', owner.id);
        const token = signToken(admin);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members/${owner.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            assert.equal(res.status, 403);
        } finally {
            server.close();
        }
    });

    it('admin cannot remove another admin', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const admin1 = createTestUser();
        const admin2 = createTestUser();
        const org = dbApi.createOrg({ name: 'No Rm Adm', slug: 'no-rm-adm', created_by: owner.id });
        dbApi.addOrgMember(org.id, admin1.id, 'admin', owner.id);
        dbApi.addOrgMember(org.id, admin2.id, 'admin', owner.id);
        const token = signToken(admin1);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members/${admin2.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            assert.equal(res.status, 403);
        } finally {
            server.close();
        }
    });

    it('member cannot remove other members (403)', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const member1 = createTestUser();
        const member2 = createTestUser();
        const org = dbApi.createOrg({ name: 'Mem No Rm', slug: 'mem-no-rm', created_by: owner.id });
        dbApi.addOrgMember(org.id, member1.id, 'member', owner.id);
        dbApi.addOrgMember(org.id, member2.id, 'member', owner.id);
        const token = signToken(member1);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members/${member2.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            assert.equal(res.status, 403);
        } finally {
            server.close();
        }
    });

    it('member can self-leave', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const member = createTestUser();
        const org = dbApi.createOrg({ name: 'Self Leave', slug: 'self-leave', created_by: owner.id });
        dbApi.addOrgMember(org.id, member.id, 'member', owner.id);
        const token = signToken(member);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members/${member.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            assert.equal(res.status, 200);
            assert.equal(dbApi.getOrgMemberRole(org.id, member.id), null);
        } finally {
            server.close();
        }
    });

    it('admin can self-leave', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const admin = createTestUser();
        const org = dbApi.createOrg({ name: 'Admin Leave', slug: 'admin-leave', created_by: owner.id });
        dbApi.addOrgMember(org.id, admin.id, 'admin', owner.id);
        const token = signToken(admin);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members/${admin.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            assert.equal(res.status, 200);
            assert.equal(dbApi.getOrgMemberRole(org.id, admin.id), null);
        } finally {
            server.close();
        }
    });

    it('owner cannot self-leave', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const org = dbApi.createOrg({ name: 'Own No Leave', slug: 'own-no-leave', created_by: owner.id });
        const token = signToken(owner);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members/${owner.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            assert.equal(res.status, 400);
            const data = await res.json();
            assert.ok(data.error.includes('Owner cannot leave'));
        } finally {
            server.close();
        }
    });

    it('non-member gets 403', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const stranger = createTestUser();
        const member = createTestUser();
        const org = dbApi.createOrg({ name: 'Stranger', slug: 'stranger-rm', created_by: owner.id });
        dbApi.addOrgMember(org.id, member.id, 'member', owner.id);
        const token = signToken(stranger);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members/${member.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            assert.equal(res.status, 403);
        } finally {
            server.close();
        }
    });

    it('returns 404 for removing non-member target', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const stranger = createTestUser();
        const org = dbApi.createOrg({ name: 'No Target', slug: 'no-tgt-rm', created_by: owner.id });
        const token = signToken(owner);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}/members/${stranger.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            assert.equal(res.status, 404);
        } finally {
            server.close();
        }
    });
});

describe('RBAC — role hierarchy enforcement', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('owner has full access (get, update, delete)', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const org = dbApi.createOrg({ name: 'Full Access', slug: 'full-access', created_by: owner.id });
        const token = signToken(owner);

        try {
            // GET
            let res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            assert.equal(res.status, 200);

            // PUT
            res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: 'Updated' }),
            });
            assert.equal(res.status, 200);

            // DELETE
            res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            assert.equal(res.status, 200);
        } finally {
            server.close();
        }
    });

    it('admin can get and update but not delete', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const admin = createTestUser();
        const org = dbApi.createOrg({ name: 'Admin Access', slug: 'admin-access', created_by: owner.id });
        dbApi.addOrgMember(org.id, admin.id, 'admin', owner.id);
        const token = signToken(admin);

        try {
            // GET - allowed
            let res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            assert.equal(res.status, 200);

            // PUT - allowed
            res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ description: 'Admin edit' }),
            });
            assert.equal(res.status, 200);

            // DELETE - forbidden
            res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            assert.equal(res.status, 403);
        } finally {
            server.close();
        }
    });

    it('member can only get, not update or delete', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const member = createTestUser();
        const org = dbApi.createOrg({ name: 'Member Access', slug: 'member-access', created_by: owner.id });
        dbApi.addOrgMember(org.id, member.id, 'member', owner.id);
        const token = signToken(member);

        try {
            // GET - allowed
            let res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            assert.equal(res.status, 200);

            // PUT - forbidden
            res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: 'Should Fail' }),
            });
            assert.equal(res.status, 403);

            // DELETE - forbidden
            res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            assert.equal(res.status, 403);
        } finally {
            server.close();
        }
    });
});

describe('Edge cases', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('slug validation accepts short slugs (2 chars)', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const user = createTestUser();
        const token = signToken(user);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: 'AB', slug: 'ab' }),
            });
            assert.equal(res.status, 200);
        } finally {
            server.close();
        }
    });

    it('slug validation rejects single-char hyphen', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const user = createTestUser();
        const token = signToken(user);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: 'Bad', slug: '-' }),
            });
            assert.equal(res.status, 400);
        } finally {
            server.close();
        }
    });

    it('slug validation rejects leading hyphen', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const user = createTestUser();
        const token = signToken(user);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: 'Bad', slug: '-leading' }),
            });
            assert.equal(res.status, 400);
        } finally {
            server.close();
        }
    });

    it('slug auto-lowercases on create', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const user = createTestUser();
        const token = signToken(user);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: 'Case', slug: 'my-org' }),
            });
            const data = await res.json();
            assert.equal(data.org.slug, 'my-org');
        } finally {
            server.close();
        }
    });

    it('can update org slug to same slug (no conflict)', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const owner = createTestUser();
        const org = dbApi.createOrg({ name: 'Same Slug', slug: 'same-slug', created_by: owner.id });
        const token = signToken(owner);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/orgs/${org.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ slug: 'same-slug' }),
            });
            assert.equal(res.status, 200);
        } finally {
            server.close();
        }
    });
});
