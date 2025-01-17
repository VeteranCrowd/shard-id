import { sort } from '@karmaniverous/entity-tools';
import lzString from 'lz-string';
import { isInt, parallel, unique } from 'radash';

import type { BaseConfigMap } from './BaseConfigMap';
import { dehydratePageKeyMap } from './dehydratePageKeyMap';
import type { EntityItem } from './EntityItem';
import type { EntityManager } from './EntityManager';
import type { QueryOptions } from './QueryOptions';
import type { QueryResult } from './QueryResult';
import { rehydratePageKeyMap } from './rehydratePageKeyMap';
import type { WorkingQueryResult } from './WorkingQueryResult';

const { compressToEncodedURIComponent, decompressFromEncodedURIComponent } =
  lzString;

/**
 * Query a database entity across shards in a provider-generic fashion.
 *
 * @remarks
 * The provided {@link ShardQueryFunction | `ShardQueryFunction`} performs the actual query of individual data pages on individual shards. This function is presumed to express provider-specific query logic, including any necessary indexing or search constraints.
 *
 * Individual shard query results will be combined, deduped by {@link Config.uniqueProperty} property value, and sorted by {@link QueryOptions.sortOrder | `sortOrder`}.
 *
 * In queries on sharded data, expect the leading and trailing edges of returned data pages to interleave somewhat with preceding & following pages.
 *
 * Unsharded query results should sort & page as expected.
 *
 * @param entityManager - {@link EntityManager | `EntityManager`} instance.
 * @param options - {@link QueryOptions | `QueryOptions`} object.
 *
 * @returns {@link QueryResult} object.
 *
 * @throws Error if {@link QueryOptions.pageKeyMap | `pageKeyMap`} keys do not match {@link QueryOptions.shardQueryMap | `shardQueryMap`} keys.
 */
export async function query<C extends BaseConfigMap>(
  entityManager: EntityManager<C>,
  options: QueryOptions<C>,
): Promise<QueryResult<C>> {
  try {
    // Get defaults.
    const { defaultLimit, defaultPageSize } =
      entityManager.config.entities[options.entityToken];

    // Extract params.
    const {
      entityToken,
      limit = defaultLimit,
      item,
      pageKeyMap,
      pageSize = defaultPageSize,
      shardQueryMap,
      sortOrder = [],
      timestampFrom = 0,
      timestampTo = Date.now(),
      throttle = entityManager.config.throttle,
    } = options;

    // Validate params.
    if (!(limit === Infinity || (isInt(limit) && limit >= 1)))
      throw new Error('limit must be a positive integer or Infinity.');

    if (!(isInt(pageSize) && pageSize >= 1))
      throw new Error('pageSize must be a positive integer');

    // Rehydrate pageKeyMap.
    const [hashKeyToken, rehydratedPageKeyMap] = rehydratePageKeyMap(
      entityManager,
      entityToken,
      Object.keys(shardQueryMap),
      item,
      pageKeyMap
        ? (JSON.parse(
            decompressFromEncodedURIComponent(pageKeyMap),
          ) as string[])
        : undefined,
      timestampFrom,
      timestampTo,
    );

    // Shortcut if pageKeyMap is empty.
    if (!Object.keys(rehydratedPageKeyMap).length)
      return {
        count: 0,
        items: [],
        pageKeyMap: compressToEncodedURIComponent(JSON.stringify([])),
      };

    // Iterate search over pages.
    let workingResult = {
      items: [],
      pageKeyMap: rehydratedPageKeyMap,
    } as WorkingQueryResult<C>;

    do {
      // TODO: This loop will blow up as shards scale, since at a minimum it will return shardCount * pageSize
      // items, which may be >> limit. Probably the way to fix entityManager is to limit the number of shards queried per
      // iteration in order to keep shardsQueried * pageSize > (limit - items.length) but only just.

      // TODO: Test for invalid characters (path delimiters) in index keys & shard key values.

      // Query every shard on every index in pageKeyMap.
      const shardQueryResults = await parallel(
        throttle,
        Object.entries(rehydratedPageKeyMap).flatMap(
          ([indexToken, indexPageKeys]) =>
            Object.entries(indexPageKeys).map(([hashKey, pageKey]) => [
              indexToken,
              hashKey,
              pageKey,
            ]),
        ) as [string, string, EntityItem<C> | undefined][],
        async ([indexToken, hashKey, pageKey]: [
          string,
          string,
          EntityItem<C> | undefined,
        ]) => ({
          indexToken,
          queryResult: await shardQueryMap[indexToken](
            hashKey,
            pageKey,
            pageSize,
          ),
          hashKey,
        }),
      );

      // Reduce shardQueryResults & updateworkingRresult.
      workingResult = shardQueryResults.reduce<WorkingQueryResult<C>>(
        ({ items, pageKeyMap }, { indexToken, queryResult, hashKey }) => {
          Object.assign(rehydratedPageKeyMap[indexToken], {
            [hashKey]: queryResult.pageKey,
          });

          return {
            items: [...items, ...queryResult.items],
            pageKeyMap,
          };
        },
        workingResult,
      );
    } while (
      // Repeat while pages remain & limit is not reached.
      Object.values(workingResult.pageKeyMap).some((indexPageKeys) =>
        Object.values(indexPageKeys).some((pageKey) => pageKey !== undefined),
      ) &&
      workingResult.items.length < limit
    );

    // Dedupe & sort working result.
    workingResult.items = sort(
      unique(workingResult.items, (item) =>
        (
          item[
            entityManager.config.entities[entityToken]
              .uniqueProperty as keyof EntityItem<C>
          ] as string | number
        ).toString(),
      ),
      sortOrder,
    );

    const result = {
      count: workingResult.items.length,
      items: workingResult.items,
      pageKeyMap: compressToEncodedURIComponent(
        JSON.stringify(
          dehydratePageKeyMap(
            entityManager,
            entityToken,
            workingResult.pageKeyMap,
          ),
        ),
      ),
    } as QueryResult<C>;

    entityManager.logger.debug('queried entityToken across shards', {
      options,
      hashKeyToken,
      rehydratedPageKeyMap,
      workingResult,
      result,
    });

    return result;
  } catch (error) {
    if (error instanceof Error)
      entityManager.logger.error(error.message, options);

    throw error;
  }
}
