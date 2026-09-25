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

/// <reference types="@fastly/js-compute" />
import { KVStore } from 'fastly:kv-store';
import { Logger } from 'fastly:logger';
import { SecretStore } from 'fastly:secret-store';

import {
    BLOCK_KEY_PREFIX,
    CONFIG_KEY,
    HEADER_RATE_LIMIT_TOKEN,
    isCharged,
    parseConfig,
    rateLimitedResponseInit,
    resolveCustomer,
    secondsBlocked,
    stripRateLimitHeaders,
    tagOriginRequest,
    usageRecord,
} from './ratelimit.js';

// Names of the resources linked to the service; see fastly.toml.
const KV_STORE = 'ratelimit';
const SECRET_STORE = 'ratelimit';
const SECRET_NAME = 'edge-shared-secret';
const BACKEND = 'origin';
const USAGE_LOG = 'usage';

addEventListener('fetch', event => event.respondWith(handle(event)));

async function handle(event) {
    const request = event.request;
    const clientIp = event.client.address;
    const store = new KVStore(KV_STORE);

    const config = parseConfig(await readText(store, CONFIG_KEY));
    const customer = resolveCustomer(config, await tokenHash(request), clientIp);

    if (customer) {
        const blocked = secondsBlocked(await readText(store, BLOCK_KEY_PREFIX + customer), nowSeconds());
        if (blocked > 0) {
            return new Response('{ "message": "Too many requests!" }', rateLimitedResponseInit(blocked));
        }
    }

    // without the secret the origin cannot trust the edge and counts the request itself, so the
    // edge must not count it as well
    const secret = await new SecretStore(SECRET_STORE).get(SECRET_NAME);
    const countedHere = customer !== null && secret !== null;

    const upstream = new Request(request);
    tagOriginRequest(upstream.headers, {
        secret: secret ? secret.plaintext() : '',
        customer: countedHere ? customer : null,
        clientIp,
    });

    const response = await fetch(upstream, { backend: BACKEND });
    const served = new Response(response.body, response);
    stripRateLimitHeaders(served.headers);

    if (countedHere && isCharged(served.status)) {
        new Logger(USAGE_LOG).log(usageRecord({
            time: new Date(),
            customer,
            clientIp,
            url: new URL(request.url).pathname,
            status: served.status,
        }));
    }
    return served;
}

async function readText(store, key) {
    const entry = await store.get(key);
    return entry ? entry.text() : null;
}

async function tokenHash(request) {
    const token = request.headers.get(HEADER_RATE_LIMIT_TOKEN);
    if (!token) {
        return null;
    }

    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}
