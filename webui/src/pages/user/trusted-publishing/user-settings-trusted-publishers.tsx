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

import { FunctionComponent, useContext, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Box, Button, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { TrustedPublisher, TrustedPublisherProvider } from '../../../extension-registry-types';
import { DelayedLoadIndicator } from '../../../components/delayed-load-indicator';
import { MainContext } from '../../../context';
import { controllerFromSignal } from '../../../query-client';
import { useReportedQuery } from '../../../hooks/use-reported-query';
import { PublisherList } from './publisher-list';
import { RegisterTrustedPublisherDialog, TrustedPublishingDocsLink } from './register-trusted-publisher-dialog';
import {
    useAllTrustedPublisherProviders,
    useAllTrustedPublishers,
    useDeleteTrustedPublisher
} from './use-trusted-publishers';

// Stable order across namespaces: namespace, then extension, then registration id.
const byNamespaceExtensionId = (a: TrustedPublisher, b: TrustedPublisher): number =>
    a.namespace.localeCompare(b.namespace) || a.extension.localeCompare(b.extension) || a.id - b.id;

// Providers are configured server-side, so the per-namespace lists overlap; keep each id once.
const dedupeById = (providers: readonly TrustedPublisherProvider[]): TrustedPublisherProvider[] =>
    providers.filter((provider, index, all) => all.findIndex(p => p.id === provider.id) === index);

/** Settings tab showing the trusted publishers of every namespace the user belongs to as one stack. */
export const UserSettingsTrustedPublishers: FunctionComponent = () => {
    const { service, user, handleError } = useContext(MainContext);
    const namespacesQuery = useReportedQuery(
        useQuery({
            queryKey: ['user', 'namespaces'],
            queryFn: ({ signal }) => service.getNamespaces(controllerFromSignal(signal)),
            enabled: user != null
        })
    );
    const namespaces = namespacesQuery.data ?? [];

    // the providers probe doubles as the feature/permission check per namespace
    const providerQueries = useAllTrustedPublisherProviders(namespaces.map(ns => ns.name));
    const manageableNamespaces = namespaces.filter(
        ns => (providerQueries.providersByNamespace[ns.name] ?? []).length > 0
    );
    const publisherQueries = useAllTrustedPublishers(manageableNamespaces.map(ns => ns.name));
    const deletePublisher = useDeleteTrustedPublisher();
    const [dialogOpen, setDialogOpen] = useState(false);

    const loading =
        namespacesQuery.isLoading ||
        providerQueries.isLoading ||
        publisherQueries.isLoading ||
        deletePublisher.isPending;
    const publishers = [...publisherQueries.publishers].sort(byNamespaceExtensionId);
    const providers = dedupeById(
        manageableNamespaces.flatMap(ns => providerQueries.providersByNamespace[ns.name] ?? [])
    );

    const remove = async (publisher: TrustedPublisher) => {
        try {
            await deletePublisher.mutateAsync({ namespace: publisher.namespace, id: publisher.id });
        } catch (err) {
            handleError(err);
        }
    };

    return (
        <>
            <Box
                sx={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    flexDirection: { xs: 'column', sm: 'column', md: 'row', lg: 'row', xl: 'row' },
                    alignItems: { xs: 'center', sm: 'center', md: 'normal', lg: 'normal', xl: 'normal' }
                }}>
                <Box>
                    <Typography variant='h5' gutterBottom>
                        Trusted Publishers
                    </Typography>
                </Box>
                {manageableNamespaces.length > 0 ? (
                    <Box sx={{ display: 'flex', flexWrap: 'wrap' }}>
                        <Box sx={{ mr: 1, mb: 1 }}>
                            <Button variant='outlined' startIcon={<AddIcon />} onClick={() => setDialogOpen(true)}>
                                Add a trusted publisher
                            </Button>
                        </Box>
                    </Box>
                ) : null}
            </Box>
            <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
                Let CI/CD workflows publish your extensions without long-lived access tokens. The workflow authenticates
                with a short-lived OIDC token at publish time, accepted only when its repository, workflow and (if set)
                environment match a registration. <TrustedPublishingDocsLink />
            </Typography>
            <DelayedLoadIndicator loading={loading} />
            {publishers.length > 0 ? (
                <PublisherList
                    publishers={publishers}
                    providers={providers}
                    loading={deletePublisher.isPending}
                    rowDetail='namespace/extension'
                    onDelete={remove}
                />
            ) : !loading ? (
                <Typography variant='body1'>
                    {manageableNamespaces.length === 0
                        ? 'Trusted publishers are registered per namespace — create or join a namespace first.'
                        : 'No trusted publishers registered yet.'}
                </Typography>
            ) : null}
            <RegisterTrustedPublisherDialog
                open={dialogOpen}
                onClose={() => setDialogOpen(false)}
                namespaces={manageableNamespaces.map(ns => ({
                    name: ns.name,
                    extensionNames: Object.keys(ns.extensions)
                }))}
                providers={providers}
            />
        </>
    );
};
