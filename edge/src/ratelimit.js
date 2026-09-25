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

// Pure request-path logic, kept free of `fastly:*` imports so it runs under plain `node --test`.

export const HEADER_RATE_LIMIT_TOKEN = 'X-RateLimit-Token';
export const HEADER_EDGE_SECRET = 'X-OpenVSX-Edge-Secret';
export const HEADER_EDGE_CUSTOMER = 'X-OpenVSX-Edge-Customer';
export const HEADER_CLIENT_IP = 'X-OpenVSX-Client-IP';

export const CONFIG_KEY = 'ratelimit-config';
export const BLOCK_KEY_PREFIX = 'block:';

const RATE_LIMIT_RESPONSE_HEADERS = ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'];

/**
 * Parses the document EdgeConfigService publishes into lookup structures.
 * A missing or unreadable document resolves nobody, so every request is served.
 */
export function parseConfig(text) {
    const tokens = new Map();
    const networks = [];
    if (!text) {
        return { tokens, networks };
    }

    let document;
    try {
        document = JSON.parse(text);
    } catch {
        return { tokens, networks };
    }

    for (const customer of document.customers ?? []) {
        for (const hash of customer.tokenHashes ?? []) {
            tokens.set(hash, customer.name);
        }
        for (const cidr of customer.cidrs ?? []) {
            const network = parseCidr(cidr);
            if (network) {
                networks.push({ ...network, customer: customer.name });
            }
        }
    }

    // CustomerService's trie answers with the least specific block containing the address
    networks.sort((a, b) => a.prefix - b.prefix);
    return { tokens, networks };
}

/**
 * Mirrors IdentityService: a known rate limit token wins, then the client address.
 * `tokenHash` is the hex SHA-256 of the X-RateLimit-Token header, or null without one.
 */
export function resolveCustomer(config, tokenHash, clientIp) {
    if (tokenHash && config.tokens.has(tokenHash)) {
        return config.tokens.get(tokenHash);
    }

    const address = parseIPv4(clientIp);
    if (address === null) {
        return null;
    }

    const match = config.networks.find(network => (address & network.mask) >>> 0 === network.address);
    return match ? match.customer : null;
}

/**
 * Seconds until a block stored as a unix epoch expires, or 0 when there is none or it has passed.
 */
export function secondsBlocked(value, nowSeconds) {
    const resetAt = Number.parseInt(value ?? '', 10);
    return Number.isFinite(resetAt) && resetAt > nowSeconds ? resetAt - nowSeconds : 0;
}

export function rateLimitedResponseInit(retryAfterSeconds) {
    return {
        status: 429,
        headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(retryAfterSeconds),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(retryAfterSeconds),
        },
    };
}

/**
 * Replaces whatever the client sent in the edge headers, so the origin can trust them.
 */
export function tagOriginRequest(headers, { secret, customer, clientIp }) {
    headers.set(HEADER_EDGE_SECRET, secret);
    headers.set(HEADER_EDGE_CUSTOMER, customer ?? '');
    headers.set(HEADER_CLIENT_IP, clientIp);
}

/**
 * The origin computes these per client; replayed from the cache they would describe someone else.
 */
export function stripRateLimitHeaders(headers) {
    for (const name of RATE_LIMIT_RESPONSE_HEADERS) {
        headers.delete(name);
    }
}

/**
 * Whether a response is charged to the customer's tier. A request the origin rejected for being
 * over the tier is not, as the origin does not charge one it rejects either.
 */
export function isCharged(status) {
    return status !== 429;
}

export function usageRecord({ time, customer, clientIp, url, status }) {
    return JSON.stringify({ ts: time.toISOString(), customer, ip: clientIp, url, status });
}

export function parseIPv4(text) {
    const parts = typeof text === 'string' ? text.split('.') : [];
    if (parts.length !== 4) {
        return null;
    }

    let address = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part) || Number(part) > 255) {
            return null;
        }
        address = address * 256 + Number(part);
    }
    return address >>> 0;
}

/**
 * Parses an IPv4 CIDR block like CustomerService does. IPv6 is skipped, as the origin only
 * matches IPv4, and a block written with host bits set covers that one address only.
 */
export function parseCidr(text) {
    const [addressText, prefixText, ...rest] = String(text).trim().split('/');
    const address = parseIPv4(addressText);
    if (address === null || rest.length > 0) {
        return null;
    }

    let prefix = 32;
    if (prefixText !== undefined) {
        if (!/^\d{1,2}$/.test(prefixText) || Number(prefixText) > 32) {
            return null;
        }
        prefix = Number(prefixText);
    }

    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if (((address & mask) >>> 0) !== address) {
        return { address, mask: 0xffffffff, prefix: 32 };
    }
    return { address, mask, prefix };
}
