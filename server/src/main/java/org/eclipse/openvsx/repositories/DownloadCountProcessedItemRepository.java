/********************************************************************************
 * Copyright (c) 2021 Precies. Software and others
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 ********************************************************************************/
package org.eclipse.openvsx.repositories;

import java.util.List;

import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.Repository;

import org.eclipse.openvsx.entities.DownloadCountProcessedItem;

public interface DownloadCountProcessedItemRepository extends Repository<DownloadCountProcessedItem, Long> {

    @Query(
        "select dc.name from DownloadCountProcessedItem dc where dc.success = true and dc.storageType = ?1 and dc.name in(?2)"
    )
    List<String> findAllSucceededDownloadCountProcessedItemsByStorageTypeAndNameIn(
            String storageType,
            List<String> names
    );

    @Query(
        "select dc.name from DownloadCountProcessedItem dc where dc.success = false and dc.storageType = ?1 and dc.name in(?2)"
    )
    List<String> findAllFailedDownloadCountProcessedItemsByStorageTypeAndNameIn(String storageType, List<String> names);
}
