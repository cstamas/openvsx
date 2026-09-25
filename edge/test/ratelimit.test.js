/******************************************************************************
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * See the NOTICE file(s) distributed with this work for additional
 * information regarding copyright ownership.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * https://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 *****************************************************************************/

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
    HEADER_CLIENT_IP,
    HEADER_EDGE_CUSTOMER,
    HEADER_EDGE_SECRET,
    isCharged,
    parseCidr,
    parseConfig,
    resolveCustomer,
    secondsBlocked,
    stripRateLimitHeaders,
    tagOriginRequest,
    usageRecord,
} from '../src/ratelimit.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');

// the same fixture as CustomerServiceTest, so both sides are checked against one table
const config = parseConfig(JSON.stringify({
    version: 1,
    customers: [
        { name: 'test', cidrs: ['1.1.1.0/24'], tokenHashes: [sha256('rl-token')] },
        { name: 'malformed', cidrs: ['not-a-cidr-block'], tokenHashes: [] },
    ],
}));

describe('resolveCustomer', () => {
    it('matches addresses inside a customer block, as CustomerServiceTest does', () => {
        assert.equal(resolveCustomer(config, null, '1.1.1.1'), 'test');
        assert.equal(resolveCustomer(config, null, '1.1.1.10'), 'test');
        assert.equal(resolveCustomer(config, null, '2.2.2.2'), null);
    });

    it('prefers a known rate limit token over the address', () => {
        assert.equal(resolveCustomer(config, sha256('rl-token'), '2.2.2.2'), 'test');
        assert.equal(resolveCustomer(config, sha256('unknown'), '2.2.2.2'), null);
    });

    it('resolves nobody for malformed and IPv6 addresses', () => {
        assert.equal(resolveCustomer(config, null, 'unknown'), null);
        assert.equal(resolveCustomer(config, null, ''), null);
        assert.equal(resolveCustomer(config, null, '2001:db8::1'), null);
    });

    it('picks the least specific block, as the origin trie does', () => {
        const overlapping = parseConfig(JSON.stringify({
            customers: [
                { name: 'narrow', cidrs: ['10.1.0.0/16'] },
                { name: 'wide', cidrs: ['10.0.0.0/8'] },
            ],
        }));
        assert.equal(resolveCustomer(overlapping, null, '10.1.2.3'), 'wide');
    });

    it('resolves nobody without a readable configuration', () => {
        for (const text of [null, '', '{not json']) {
            assert.equal(resolveCustomer(parseConfig(text), null, '1.1.1.1'), null);
        }
    });
});

describe('parseCidr', () => {
    it('treats a block with host bits set as that single address, as the origin does', () => {
        assert.deepEqual(parseCidr('1.1.1.1/24'), { address: 0x01010101, mask: 0xffffffff, prefix: 32 });
    });

    it('rejects what the origin skips', () => {
        for (const text of ['not-a-cidr-block', '1.1.1.0/33', '256.1.1.0/24', '::/0', '1.1.1.0/24/1']) {
            assert.equal(parseCidr(text), null, text);
        }
    });

    it('accepts a bare address and the whole range', () => {
        assert.equal(parseCidr('1.2.3.4').prefix, 32);
        assert.deepEqual(parseCidr('0.0.0.0/0'), { address: 0, mask: 0, prefix: 0 });
    });
});

describe('secondsBlocked', () => {
    it('counts down to the stored reset epoch and stops blocking after it', () => {
        assert.equal(secondsBlocked('1060', 1000), 60);
        assert.equal(secondsBlocked('1000', 1000), 0);
        assert.equal(secondsBlocked(null, 1000), 0);
        assert.equal(secondsBlocked('garbage', 1000), 0);
    });
});

describe('headers', () => {
    it('overwrites edge headers a client tried to forge', () => {
        const headers = new Headers({
            [HEADER_EDGE_SECRET]: 'forged',
            [HEADER_EDGE_CUSTOMER]: 'someone-else',
            [HEADER_CLIENT_IP]: '9.9.9.9',
        });

        tagOriginRequest(headers, { secret: 's3cret', customer: null, clientIp: '1.1.1.1' });

        assert.equal(headers.get(HEADER_EDGE_SECRET), 's3cret');
        assert.equal(headers.get(HEADER_EDGE_CUSTOMER), '');
        assert.equal(headers.get(HEADER_CLIENT_IP), '1.1.1.1');
    });

    it('removes per-client rate limit headers from responses', () => {
        const headers = new Headers({ 'X-RateLimit-Remaining': '7', 'X-RateLimit-Limit': '10', 'Content-Type': 'x' });

        stripRateLimitHeaders(headers);

        assert.deepEqual([...headers.keys()], ['content-type']);
    });
});

describe('isCharged', () => {
    it('does not charge a request the origin rejected for being over the tier', () => {
        assert.equal(isCharged(429), false);
    });

    it('charges every other response, errors included', () => {
        for (const status of [200, 302, 304, 404, 500, 503]) {
            assert.equal(isCharged(status), true, String(status));
        }
    });
});

describe('usageRecord', () => {
    it('carries the fields EdgeUsageService reads', () => {
        const record = JSON.parse(usageRecord({
            time: new Date('2026-09-25T10:00:00Z'),
            customer: 'test',
            clientIp: '1.1.1.1',
            url: '/api/-/search',
            status: 200,
        }));
        assert.deepEqual(record, {
            ts: '2026-09-25T10:00:00.000Z', customer: 'test', ip: '1.1.1.1', url: '/api/-/search', status: 200,
        });
    });
});
