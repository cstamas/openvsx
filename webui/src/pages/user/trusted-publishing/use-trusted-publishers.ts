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

import { useContext } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { MainContext } from '../../../context';
import { TrustedPublisher, TrustedPublisherProvider, TrustedPublisherRequest } from '../../../extension-registry-types';
import { controllerFromSignal } from '../../../query-client';

export const trustedPublisherKeys = {
    providers: (namespace: string) => ['user', 'trusted-publisher-providers', namespace] as const,
    publishers: (namespace: string) => ['user', 'trusted-publishers', namespace] as const
};

/**
 * Fails when trusted publishing is disabled server-side or the current user
 * cannot manage the namespace, so an error means "feature unavailable".
 */
export const useTrustedPublisherProviders = (namespace: string) => {
    const { service } = useContext(MainContext);
    return useQuery({
        queryKey: trustedPublisherKeys.providers(namespace),
        queryFn: ({ signal }) => service.getTrustedPublisherProviders(controllerFromSignal(signal), namespace)
    });
};

/** Providers of several namespaces at once, keyed by namespace; failed probes yield empty lists. */
export const useAllTrustedPublisherProviders = (namespaces: string[]) => {
    const { service } = useContext(MainContext);
    return useQueries({
        queries: namespaces.map(namespace => ({
            queryKey: trustedPublisherKeys.providers(namespace),
            queryFn: ({ signal }: { signal?: AbortSignal }) =>
                service.getTrustedPublisherProviders(controllerFromSignal(signal), namespace)
        })),
        combine: results => ({
            isLoading: results.some(result => result.isLoading),
            providersByNamespace: Object.fromEntries(
                namespaces.map((namespace, index) => [namespace, results[index]?.data ?? []])
            ) as Record<string, readonly TrustedPublisherProvider[]>
        })
    });
};

export const useTrustedPublishers = (namespace: string) => {
    const { service } = useContext(MainContext);
    return useQuery({
        queryKey: trustedPublisherKeys.publishers(namespace),
        queryFn: ({ signal }) => service.getTrustedPublishers(controllerFromSignal(signal), namespace)
    });
};

/** The publishers of several namespaces flattened into one list. */
export const useAllTrustedPublishers = (namespaces: string[]) => {
    const { service } = useContext(MainContext);
    return useQueries({
        queries: namespaces.map(namespace => ({
            queryKey: trustedPublisherKeys.publishers(namespace),
            queryFn: ({ signal }: { signal?: AbortSignal }) =>
                service.getTrustedPublishers(controllerFromSignal(signal), namespace)
        })),
        combine: results => ({
            isLoading: results.some(result => result.isLoading),
            publishers: results.flatMap(result => result.data ?? []) as TrustedPublisher[]
        })
    });
};

export const useRegisterTrustedPublisher = () => {
    const { service } = useContext(MainContext);
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (request: TrustedPublisherRequest) => service.registerTrustedPublisher(request.namespace, request),
        onSuccess: (_result, request) => {
            queryClient.invalidateQueries({ queryKey: trustedPublisherKeys.publishers(request.namespace) });
        }
    });
};

export const useDeleteTrustedPublisher = () => {
    const { service } = useContext(MainContext);
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ namespace, id }: { namespace: string; id: number }) =>
            service.deleteTrustedPublisher(namespace, id),
        onSuccess: (_result, { namespace }) => {
            queryClient.invalidateQueries({ queryKey: trustedPublisherKeys.publishers(namespace) });
        }
    });
};
