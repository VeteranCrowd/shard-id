import {
  isNil,
  type PropertiesOfType,
  sort,
  type SortOrder,
  type StringifiableTypes,
  type TypeMap,
} from '@karmaniverous/entity-tools';
import lzString from 'lz-string';
import {
  cluster,
  isInt,
  mapValues,
  objectify,
  parallel,
  range,
  shake,
  unique,
  zipToObject,
} from 'radash';
import stringHash from 'string-hash';

import type { Config, EntityItem, EntityMap, ShardBump } from './Config';
import { configSchema, type ParsedConfig } from './ParsedConfig';

const { compressToEncodedURIComponent, decompressFromEncodedURIComponent } =
  lzString;

const str2indexable = <IndexableTypes extends TypeMap>(
  type: keyof IndexableTypes,
  value?: string,
): IndexableTypes[keyof IndexableTypes] | undefined => {
  if (!value) return;

  switch (type) {
    case 'string':
      return value as IndexableTypes[keyof IndexableTypes];
    case 'number':
      return Number(value) as IndexableTypes[keyof IndexableTypes];
    case 'boolean':
      return (value === 'true') as IndexableTypes[keyof IndexableTypes];
    case 'bigint':
      return BigInt(value) as IndexableTypes[keyof IndexableTypes];
    default:
      throw new Error(
        `unsupported indexable type '${(type as string | undefined) ?? ''}'`,
      );
  }
};

/**
 * A two-layer map of page keys, used to query the next page of data across a set of indexes and on each shard of a given hash key.
 *
 * The keys of the outer object are the keys of the {@link QueryMap | `QueryMap`} object passed with the {@link EntityManager.query | `query`} method {@link QueryOptions.queryMap | options}. Each should correspond to a {@link ConfigEntity.indexes | `Config` entity index} for the given {@link Entity | `Entity`}.
 *
 * The keys of the inner object are the shard space for `hashKey` as constrained by the {@link QueryOptions | query options} timestamps.
 *
 * The values of the inner object are the page key objects returned by the previous database query on the related index & shard. An `undefined` value indicates that there are no more pages to query for that index & shard.
 *
 * @typeParam Item - The item type being queried. This will geerally be an {@link EntityItem | `EntityItem`} object.
 * @typeParam IndexableTypes - The {@link TypeMap | `TypeMap`} identifying property types that can be indexed.
 */
export type PageKeyMap<
  Item extends Record<string, unknown>,
  IndexableTypes extends TypeMap = StringifiableTypes,
> = Record<
  string,
  Record<
    string,
    | Partial<
        Pick<Item, PropertiesOfType<Item, IndexableTypes[keyof IndexableTypes]>>
      >
    | undefined
  >
>;

/**
 * A result returned by a {@link ShardQueryFunction | `ShardQueryFunction`} querying an individual shard.
 *
 * @typeParam Item - The {@link EntityItem | `EntityItem`} type being queried. 
 * @typeParam IndexableTypes - The {@link TypeMap | `TypeMap`} identifying property types that can be indexed.

* @category Query
 */
export interface ShardQueryResult<
  Item extends EntityItem<EntityToken, M, HashKey, RangeKey>,
  EntityToken extends keyof M & string,
  M extends EntityMap,
  HashKey extends string = 'hashKey',
  RangeKey extends string = 'rangeKey',
  IndexableTypes extends TypeMap = StringifiableTypes,
> {
  /** The number of records returned. */
  count: number;

  /** The returned records. */
  items: Item[];

  /** The page key for the next query on this shard. */
  pageKey?: Partial<
    Pick<Item, PropertiesOfType<Item, IndexableTypes[keyof IndexableTypes]>>
  >;
}

/**
 * A query function that returns a single page of results from an individual
 * shard. This function will typically be composed dynamically to express a
 * specific query index & logic. The arguments to this function will be
 * provided by the {@link EntityManager.query | `EntityManager.query`} method, which assembles many returned
 * pages queried across multiple shards into a single query result.
 *
 * @param haskKey - The key of the individual shard being queried.
 * @param pageKey - The page key returned by the previous query on this shard.
 * @param pageSize - The maximum number of items to return from this query.
 *
 * @category Query
 */
export type ShardQueryFunction<
  Item extends EntityItem<EntityToken, M, HashKey, RangeKey>,
  EntityToken extends keyof M & string,
  M extends EntityMap,
  HashKey extends string = 'hashKey',
  RangeKey extends string = 'rangeKey',
  IndexableTypes extends TypeMap = StringifiableTypes,
> = (
  hashKey: string,
  pageKey?: Partial<
    Pick<Item, PropertiesOfType<Item, IndexableTypes[keyof IndexableTypes]>>
  >,
  pageSize?: number,
) => Promise<
  ShardQueryResult<Item, EntityToken, M, HashKey, RangeKey, IndexableTypes>
>;

/**
 * Options passed to the {@link EntityManager.query | `EntityManager.query`} method.
 *
 * @category Query
 */
export interface QueryOptions<
  Item extends EntityItem<EntityToken, M, HashKey, RangeKey>,
  EntityToken extends keyof M & string,
  M extends EntityMap,
  HashKey extends string,
  RangeKey extends string,
  IndexableTypes extends TypeMap,
> {
  /** Identifies the entity to be queried. Key of {@link Config | `EntityManager.config.entities`}. */
  entityToken: EntityToken;

  /**
   * Identifies the entity key across which the query will be sharded. Key of
   * {@link Config | `EntityManager.config.entities.<entityToken>.keys`}.
   */
  hashKey: string;

  /**
   * A partial {@link EntityItem | `EntityItem`} object containing at least the properties specified in
   * {@link Config | `EntityManager.config.entities.<entityToken>.keys.<keyToken>.elements`}, except for the properties specified in {@link Config | `EntityManager.config.tokens`}.
   *
   * This data will be used to generate query keys across all shards.
   */
  item?: Item;

  /**
   * The target maximum number of records to be returned by the query across
   * all shards.
   *
   * The actual number of records returned will be a product of {@link QueryOptions.pageSize | `pageSize`} and the
   * number of shards queried, unless limited by available records in a given
   * shard.
   */
  limit?: number;

  /**
   * {@link QueryResult.pageKeyMap | `pageKeyMap`} returned by the previous iteration of this query.
   */
  pageKeyMap?: string;

  /**
   * The maximum number of records to be returned by each individual query to a
   * single shard (i.e. {@link ShardQueryFunction | `ShardQueryFunction`} execution).
   *
   * Note that, within a given {@link EntityManager.query | `query`} method execution, these queries will be
   * repeated until either available data is exhausted or the {@link QueryOptions.limit | `limit`} value is
   * reached.
   */
  pageSize?: number;

  /**
   * Each key in this object is a valid entity index token. Each value is a valid
   * {@link ShardQueryFunction | 'ShardQueryFunction'} that specifies the query of a single page of data on a
   * single shard for the mapped index.
   *
   * This allows simultaneous queries on multiple sort keys to share a single
   * page key, e.g. to match the same string against `firstName` and `lastName`
   * properties without performing a table scan for either.
   */
  queryMap: Record<
    string,
    ShardQueryFunction<Item, EntityToken, M, HashKey, RangeKey, IndexableTypes>
  >;

  /**
   * A {@link SortOrder | `SortOrder`} object specifying the sort order of the result set. Defaults to `[]`.
   */
  sortOrder?: SortOrder<Item>;

  /**
   * Lower limit to query shard space.
   *
   * Only valid if the query is constrained along the dimension used by the
   * {@link Config | `EntityManager.config.entities.<entityToken>.sharding.timestamptokens.timestamp`}
   * function to generate `shardKey`.
   *
   * @defaultValue `0`
   */
  timestampFrom?: number;

  /**
   * Upper limit to query shard space.
   *
   * Only valid if the query is constrained along the dimension used by the
   * {@link Config | `EntityManager.config.entities.<entityToken>.sharding.timestamptokens.timestamp`}
   * function to generate `shardKey`.
   *
   * @defaultValue `Date.now()`
   */
  timestampTo?: number;

  /**
   * The maximum number of shards to query in parallel. Overrides options `throttle`.
   *
   * @defaultValue `options.throttle`
   */
  throttle?: number;
}

/**
 * A result returned by a query across multiple shards, where each shard may
 * receive multiple page queries via a dynamically-generated {@link ShardQueryFunction | `ShardQueryFunction`}.
 *
 * @category Query
 */
export interface QueryResult<
  Item extends EntityItem<EntityToken, M, HashKey, RangeKey>,
  EntityToken extends keyof M & string,
  M extends EntityMap,
  HashKey extends string,
  RangeKey extends string,
> {
  /** Total number of records returned across all shards. */
  count: number;

  /** The returned records. */
  items: Item[];

  /**
   * A compressed, two-layer map of page keys, used to query the next page of
   * data for a given sort key on each shard of a given hash key.
   */
  pageKeyMap: string;
}

/**
 * A QueryResult object with rehydrated pageKeyMap.
 *
 * @category Query
 */
export interface WorkingQueryResult<
  Item extends EntityItem<EntityToken, M, HashKey, RangeKey>,
  EntityToken extends keyof M & string,
  M extends EntityMap,
  HashKey extends string,
  RangeKey extends string,
  IndexableTypes extends TypeMap = StringifiableTypes,
> {
  /** The returned records. */
  items: Item[];

  /**
   * A compressed, two-layer map of page keys, used to query the next page of
   * data for a given sort key on each shard of a given hash key.
   */
  pageKeyMap: PageKeyMap<Item, IndexableTypes>;
}

/**
 * The EntityManager class applies a configuration-driven sharded data model &
 * query strategy to NoSql data.
 *
 * @category Entity Manager
 */
export class EntityManager<
  M extends EntityMap,
  HashKey extends string,
  RangeKey extends string,
  IndexableTypes extends TypeMap,
> {
  #config: ParsedConfig;

  /**
   * Create an EntityManager instance.
   *
   * @param options - EntityManager options.
   */
  constructor(config: Config<M, HashKey, RangeKey, IndexableTypes>) {
    this.#config = configSchema.parse(config);
  }

  /**
   * Validate that an entity is defined in the EntityManager config.
   *
   * @param entity - Entity token.
   *
   * @throws `Error` if `entity` is invalid.
   */
  private validateEntityToken(entityToken: string): void {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!this.config.entities[entityToken])
      throw new Error('invalid entity token');
  }

  /**
   * Validate that an entity index is defined in EntityManager config.
   *
   * @param entity - Entity token.
   * @param index - Index token.
   *
   * @throws `Error` if `entity` is invalid.
   * @throws `Error` if `index` is invalid.
   */
  private validateEntityIndexToken(
    entityToken: string,
    indexToke: string,
  ): void {
    this.validateEntityToken(entityToken);

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!this.config.entities[entityToken].indexes[indexToke])
      throw new Error('invalid entity index token');
  }

  /**
   * Validate that an entity generated property is defined in EntityManager
   * config.
   *
   * @param entity - Entity token.
   * @param property - Entity generated property.
   * @param sharded - Whether the generated property is sharded. `undefined`
   * indicates no constraint.
   *
   * @throws `Error` if `entity` is invalid.
   * @throws `Error` if `property` is invalid.
   * @throws `Error` if `sharded` is specified & does not match `property`
   * sharding.
   */
  private validateEntityGeneratedProperty(
    entityToken: string,
    property: string,
    sharded?: boolean,
  ): void {
    this.validateEntityToken(entityToken);

    const generated = this.config.entities[entityToken].generated[property];

    if (!generated && property !== this.config.hashKey)
      throw new Error('invalid entity generated property');

    if (
      sharded !== undefined &&
      ((generated && sharded !== generated.sharded) ||
        (!sharded && property === this.config.hashKey))
    )
      throw new Error(
        `entity generated property ${sharded ? 'not ' : ''}sharded`,
      );
  }

  /**
   * Get the current EntityManager Config object.
   *
   * @returns Current config object.
   */
  get config(): ParsedConfig {
    return this.#config;
  }

  /**
   * Set the current config.
   *
   * @param value - ParsedConfig object.
   */
  set config(value) {
    this.#config = configSchema.parse(value);
  }

  /**
   * Get first entity shard bump before timestamp.
   *
   * @param entity - Entity token.
   * @param timestamp - Timestamp in milliseconds.
   *
   * @returns Shard bump object.
   *
   * @throws `Error` if `entity` is invalid.
   */
  getShardBump(entityToken: keyof M & string, timestamp: number): ShardBump {
    // Validate params.
    this.validateEntityToken(entityToken);

    return [...this.config.entities[entityToken].shardBumps]
      .reverse()
      .find((bump) => bump.timestamp <= timestamp)!;
  }

  /**
   * Encode a generated property value. Returns a string or undefined if atomicity requirement not met.
   *
   * @param item - Entity item.
   * @param entity - Entity token.
   * @param property - Generated property name.
   *
   * @returns Encoded generated property value.
   *
   * @throws `Error` if `entity` is invalid.
   * @throws `Error` if `property` is invalid.
   *
   */
  encodeGeneratedProperty<
    Item extends EntityItem<EntityToken, M, HashKey, RangeKey>,
    EntityToken extends keyof M & string,
  >(
    item: Partial<Item>,
    entityToken: EntityToken,
    property: keyof M[EntityToken] & string,
  ): string | undefined {
    try {
      // Validate params.
      this.validateEntityGeneratedProperty(entityToken, property);

      const { atomic, elements, sharded } =
        this.config.entities[entityToken].generated[property]!;

      // Map elements to [element, value] pairs.
      const elementMap = elements.map((element) => [
        element,
        item[element as keyof Item],
      ]);

      // Validate atomicity requirement.
      if (atomic && elementMap.some(([, value]) => isNil(value))) return;

      // Encode property value.
      const encoded = [
        ...(sharded ? [item[this.config.hashKey as keyof Item]] : []),
        ...elementMap.map(([element, value]) =>
          [element, (value ?? '').toString()].join(
            this.config.generatedValueDelimiter,
          ),
        ),
      ].join(this.config.generatedKeyDelimiter);

      console.debug('encoded generated property', {
        item,
        entityToken,
        property,
        encoded,
      });

      return encoded;
    } catch (error) {
      if (error instanceof Error)
        console.error(error.message, { item, entityToken, property });

      throw error;
    }
  }

  /**
   * Decode a generated property value. Returns a partial EntityItem.
   *
   * @param encoded - Encoded generated property value.
   * @param entity - Entity token.
   *
   * @returns Partial EntityItem with decoded properties decoded from `value`.
   *
   * @throws `Error` if `entity` is invalid.
   */
  decodeGeneratedProperty<
    Item extends EntityItem<EntityToken, M, HashKey, RangeKey>,
    EntityToken extends keyof M & string,
  >(encoded: string, entityToken: EntityToken): Partial<Item> {
    try {
      // Validate params.
      this.validateEntityToken(entityToken);

      // Handle degenerate case.
      if (!encoded) return {};

      // Split encoded into keys.
      const keys = encoded.split(this.config.generatedKeyDelimiter);

      // Initiate result with hashKey if sharded.
      const decoded = keys[0].includes(this.config.shardKeyDelimiter)
        ? { [this.config.hashKey]: keys.shift() }
        : {};

      // Split keys into values & validate.
      const values = keys.map((key) => {
        const pair = key.split(this.config.generatedValueDelimiter);

        if (pair.length !== 2)
          throw new Error(`invalid generated property value '${key}'`);

        return pair;
      });

      // Assign decoded properties.
      Object.assign(
        decoded,
        objectify(
          values,
          ([key]) => key,
          ([key, value]) =>
            str2indexable<IndexableTypes>(
              this.config.entities[entityToken].types[key],
              value,
            ),
        ),
      );

      console.debug('decoded generated property', {
        encoded,
        entityToken,
        decoded,
      });

      return decoded as Partial<Item>;
    } catch (error) {
      if (error instanceof Error)
        console.error(error.message, { encoded, entityToken });

      throw error;
    }
  }

  /**
   * Update the hash key on an EntityItem. Mutates `item`.
   *
   * @param item - EntityItem.
   * @param entity - Entity token.
   * @param overwrite - Overwrite existing shard key (default `false`).
   *
   * @returns Mutated `item` with updated hash key.
   *
   * @throws `Error` if `entity` is invalid.
   */
  updateItemHashKey<
    Item extends EntityItem<EntityToken, M, HashKey, RangeKey>,
    EntityToken extends keyof M & string,
  >(item: Item, entityToken: EntityToken, overwrite = false): Item {
    try {
      // Validate params.
      this.validateEntityToken(entityToken);

      // Return current item if hashKey exists and overwrite is false.
      if (item[this.config.hashKey as keyof Item] && !overwrite) {
        console.debug('did not overwrite existing entity item hash key', {
          item,
          entityToken,
          overwrite,
        });

        return item;
      }

      // Get item timestamp property & validate.
      const timestamp: number = item[
        this.config.entities[entityToken].timestampProperty as keyof Item
      ] as unknown as number;

      if (isNil(timestamp)) throw new Error(`missing item timestamp property`);

      // Find first entity sharding bump before timestamp.
      const { charBits, chars } = this.getShardBump(entityToken, timestamp);

      let hashKey = `${entityToken}${this.config.shardKeyDelimiter}`;

      if (chars) {
        // Radix is the numerical base of the shardKey.
        const radix = 2 ** charBits;

        // Get item unique property & validate.
        const uniqueId =
          item[this.config.entities[entityToken].uniqueProperty as keyof Item];

        if (isNil(uniqueId)) throw new Error(`missing item unique property`);

        hashKey += (stringHash(uniqueId.toString()) % (chars * radix))
          .toString(radix)
          .padStart(chars, '0');
      }

      Object.assign(item, { [this.config.hashKey]: hashKey });

      console.debug('updated entity item hash key', {
        entityToken,
        overwrite,
        item,
      });

      return item;
    } catch (error) {
      if (error instanceof Error)
        console.error(error.message, { item, entityToken, overwrite });

      throw error;
    }
  }

  /**
   * Update the range key on an EntityItem. Mutates `item`.
   *
   * @param item - EntityItem.
   * @param entity - Entity token.
   * @param overwrite - Overwrite existing shard key (default `false`).
   *
   * @returns Mutated `item` with updated range key.
   *
   * @throws `Error` if `entity` is invalid.
   * @throws `Error` if `item` unique property is missing.
   */
  updateItemRangeKey<
    Item extends EntityItem<EntityToken, M, HashKey, RangeKey>,
    EntityToken extends keyof M & string,
  >(
    item: Partial<Item>,
    entityToken: EntityToken,
    overwrite = false,
  ): Partial<Item> {
    try {
      // Validate params.
      this.validateEntityToken(entityToken);

      // Return current item if rangeKey exists and overwrite is false.
      if (item[this.config.rangeKey as keyof Item] && !overwrite) {
        console.debug('did not overwrite existing entity item range key', {
          item,
          entityToken,
          overwrite,
        });

        return item;
      }

      // Get item unique property & validate.
      const uniqueProperty =
        item[this.config.entities[entityToken].uniqueProperty as keyof Item];

      if (isNil(uniqueProperty))
        throw new Error(`missing item unique property`);

      // Update range key.
      Object.assign(item, {
        [this.config.rangeKey]: [
          this.config.entities[entityToken].uniqueProperty,
          uniqueProperty,
        ].join(this.config.generatedValueDelimiter),
      });

      console.debug('updated entity item range key', {
        entityToken,
        overwrite,
        item,
      });

      return item;
    } catch (error) {
      if (error instanceof Error)
        console.error(error.message, { item, entityToken, overwrite });

      throw error;
    }
  }

  /**
   * Update generated properties on an EntityItem. Mutates `item`.
   *
   * @param item - EntityItem.
   * @param entity - Entity token.
   * @param overwrite - Overwrite existing generated properties (default `false`).
   *
   * @returns Mutated `item` with updated generated properties.
   *
   * @throws `Error` if `entity` is invalid.
   */
  updateItemGeneratedProperties<
    Item extends EntityItem<EntityToken, M, HashKey, RangeKey>,
    EntityToken extends keyof M & string,
  >(item: Item, entityToken: EntityToken, overwrite = false): Item {
    try {
      // Validate params.
      this.validateEntityToken(entityToken);

      // Update hash key.
      this.updateItemHashKey(item, entityToken, overwrite);

      // Update range key.
      this.updateItemRangeKey(item, entityToken, overwrite);

      // Update generated properties.
      for (const property in this.config.entities[entityToken].generated) {
        if (overwrite || isNil(item[property as keyof Item])) {
          const encoded = this.encodeGeneratedProperty(
            item,
            entityToken,
            property,
          );

          if (encoded) Object.assign(item, { [property]: encoded });
          else delete item[property as keyof Item];
        }
      }

      console.debug('updated entity item generated properties', {
        entityToken,
        overwrite,
        item,
      });

      return item;
    } catch (error) {
      if (error instanceof Error)
        console.error(error.message, { entityToken, overwrite, item });

      throw error;
    }
  }

  /**
   * Strips generated properties from an EntityItem. Mutates `item`.
   *
   * @param item - EntityItem.
   * @param entity - Entity token.
   *
   * @returns Mutated `item` without generated properties.
   *
   * @throws `Error` if `entity` is invalid.
   */
  stripItemGeneratedProperties<
    Item extends EntityItem<EntityToken, M, HashKey, RangeKey>,
    EntityToken extends keyof M & string,
  >(item: Item, entityToken: EntityToken): Item {
    try {
      // Validate params.
      this.validateEntityToken(entityToken);

      // Delete hash & range keys.
      delete item[this.config.hashKey as keyof Item];
      delete item[this.config.rangeKey as keyof Item];

      // Delete generated properties.
      for (const property in this.config.entities[entityToken].generated)
        delete item[property as keyof Item];

      console.debug('stripped entity item generated properties', {
        entityToken,
        item,
      });

      return item;
    } catch (error) {
      if (error instanceof Error)
        console.error(error.message, { item, entityToken });

      throw error;
    }
  }

  /**
   * Unwraps an entity index into deduped, sorted, ungenerated elements.
   *
   * @param index - Index token.
   * @param entity - Entity token.
   *
   * @returns Deduped, sorted array of ungenerated index component elements.
   *
   * @throws `Error` if `entity` is invalid.
   * @throws `Error` if `index` is invalid.
   */
  unwrapIndex<EntityToken extends keyof M & string>(
    index: string,
    entityToken: EntityToken,
  ) {
    try {
      // Validate params.
      this.validateEntityIndexToken(entityToken, index);

      const generated = this.config.entities[entityToken].generated;
      const generatedKeys = Object.keys(shake(generated));

      return this.config.entities[entityToken].indexes[index]
        .map((component) =>
          component === this.config.hashKey
            ? this.config.hashKey
            : component === this.config.rangeKey
              ? this.config.entities[entityToken].uniqueProperty
              : generatedKeys.includes(component)
                ? generated[component]!.elements
                : component,
        )
        .flat()
        .sort();
    } catch (error) {
      if (error instanceof Error)
        console.error(error.message, { index, entityToken });

      throw error;
    }
  }

  /**
   * Condense a partial EntityItem into a delimited string representing the
   * ungenerated component elements of a Config entity index.
   *
   * @remarks
   * Reverses {@link EntityManager.rehydrateIndexItem | `rehydrateIndexItem`}.
   *
   * To create the output value, this method:
   *
   * * Unwraps `index` components into deduped, sorted, ungenerated elements.
   * * Joins index component values from `item` with generated key delimiter.
   *
   * `item` must be populated with all required index component elements!
   *
   * @param item - EntityItem object.
   * @param entity - Entity token.
   * @param index - Entity index token.
   * @param omit - Index components to omit from the output value.
   *
   * @returns Dehydrated index.
   *
   * @throws `Error` if `entity` is invalid.
   * @throws `Error` if `index` is invalid.
   */
  dehydrateIndexItem<
    Item extends EntityItem<EntityToken, M, HashKey, RangeKey>,
    EntityToken extends keyof M & string,
  >(
    item: Partial<Item> | undefined,
    entityToken: EntityToken,
    indexToken: string,
    omit: string[] = [],
  ): string {
    try {
      // Validate params.
      this.validateEntityIndexToken(entityToken, indexToken);

      // Handle degenerate case.
      if (!item) return '';

      // Unwrap index elements.
      const elements = this.unwrapIndex(indexToken, entityToken).filter(
        (element) => !omit.includes(element),
      );

      // Join index element values.
      const dehydrated = elements
        .map((element) => item[element as keyof Item]?.toString() ?? '')
        .join(this.config.generatedKeyDelimiter);

      console.debug('dehydrated index', {
        item,
        entityToken,
        indexToken,
        elements,
        dehydrated,
      });

      return dehydrated;
    } catch (error) {
      if (error instanceof Error)
        console.error(error.message, { item, entityToken, indexToken });

      throw error;
    }
  }

  /**
   * Convert a delimited string into a partial EntityItem representing the ungenerated component elements of a Config entity index.
   *
   * @remarks
   * Reverses {@link EntityManager.dehydrateIndexItem | `dehydrateIndexItem`}.
   *
   * {@link EntityManager.dehydrateIndexItem | `dehydrateIndexItem`} alphebetically sorts unwrapped index elements during
   * the dehydration process. This method assumes delimited element values are
   * presented in the same order.
   *
   * @param dehydrated - Dehydrated index.
   * @param entity - Entity token.
   * @param index - Entity index token.
   * @param omit - Index components omitted from `dehydrated`.
   *
   * @returns Rehydrated index.
   *
   * @throws `Error` if `entity` is invalid.
   * @throws `Error` if `index` is invalid.
   */
  rehydrateIndexItem<
    Item extends EntityItem<EntityToken, M, HashKey, RangeKey>,
    EntityToken extends keyof M & string,
  >(
    dehydrated: string,
    entityToken: EntityToken,
    indexToken: string,
    omit: string[] = [],
  ): Partial<Item> {
    try {
      // Validate params.
      this.validateEntityIndexToken(entityToken, indexToken);

      // Unwrap index elements.
      const elements = this.unwrapIndex(indexToken, entityToken).filter(
        (element) => !omit.includes(element),
      );

      // Split dehydrated value & validate.
      const values = dehydrated.split(this.config.generatedKeyDelimiter);

      if (elements.length !== values.length)
        throw new Error('index rehydration key-value mismatch');

      // Assign values to elements.
      const rehydrated = shake(
        zipToObject(
          elements,
          values.map((value, i) =>
            str2indexable<IndexableTypes>(
              this.config.entities[entityToken].types[elements[i]],
              value,
            ),
          ),
        ),
      ) as Partial<Item>;

      console.debug('rehydrated index', {
        dehydrated,
        entityToken,
        indexToken,
        elements,
        values,
        rehydrated,
      });

      return rehydrated;
    } catch (error) {
      if (error instanceof Error)
        console.error(error.message, { dehydrated, entityToken, indexToken });

      throw error;
    }
  }

  /**
   * Dehydrate a {@link PageKeyMap | `PageKeyMap`} object into an array of dehydrated page keys.
   *
   * @param pageKeyMap - PageKeyMap object to dehydrate.
   * @param entity - Entity token.
   *
   * @returns  Array of dehydrated page keys.
   *
   * @throws `Error` if `entity` is invalid.
   * @throws `Error` if any `pageKeyMap` index is invalid.
   *
   * @remarks
   * In the returned array, an empty string member indicates the corresponding
   * page key is `undefined`.
   *
   * An empty returned array indicates all page keys are `undefined`.
   */
  dehydratePageKeyMap<
    Item extends EntityItem<EntityToken, M, HashKey, RangeKey>,
    EntityToken extends keyof M & string,
  >(
    pageKeyMap: PageKeyMap<Item, IndexableTypes>,
    entityToken: EntityToken,
  ): string[] {
    try {
      // Validate params.
      this.validateEntityToken(entityToken);

      // Shortcut empty pageKeyMap.
      if (!Object.keys(pageKeyMap).length) {
        const dehydrated: string[] = [];

        console.debug('dehydrated empty page key map', {
          pageKeyMap,
          entityToken,
          dehydrated,
        });

        return dehydrated;
      }

      // Extract, sort & validate indexs.
      const indexes = Object.keys(pageKeyMap).sort();
      indexes.map((index) => this.validateEntityIndexToken(entityToken, index));

      // Extract & sort hash keys.
      const hashKeys = Object.keys(pageKeyMap[indexes[0]]);

      // Dehydrate page keys.
      let dehydrated: string[] = [];

      for (const index of indexes) {
        for (const hashKey of hashKeys) {
          // Undefineed pageKey.
          if (!pageKeyMap[index][hashKey]) {
            dehydrated.push('');
            continue;
          }

          // Compose item from page key
          const item = Object.entries(pageKeyMap[index][hashKey]).reduce<
            Partial<EntityItem<EntityToken, M, HashKey, RangeKey>>
          >((item, [property, value]) => {
            if (
              property in this.config.entities[entityToken].generated ||
              property === this.config.rangeKey
            )
              Object.assign(
                item,
                this.decodeGeneratedProperty(value as string, entityToken),
              );
            else Object.assign(item, { [property]: value });

            return item;
          }, {});

          // Dehydrate index from item.
          dehydrated.push(
            this.dehydrateIndexItem(item, entityToken, index, [
              this.config.hashKey,
            ]),
          );
        }
      }

      // Replace with empty array if all pageKeys are empty strings.
      if (dehydrated.every((pageKey) => pageKey === '')) dehydrated = [];

      console.debug('dehydrated page key map', {
        pageKeyMap,
        entityToken,
        indexes,
        hashKeys,
        dehydrated,
      });

      return dehydrated;
    } catch (error) {
      if (error instanceof Error)
        console.error(error.message, { entityToken, pageKeyMap });

      throw error;
    }
  }

  /**
   * Return an array of hashKey values covering the shard space bounded by
   * `timestampFrom` & `timestampTo`.
   *
   * @param entity - Entity token.
   * @param timestampFrom - Lower timestanp limit. Defaults to `0`.
   * @param timestampTo - Upper timestamp limit. Defaults to `Date.now()`.
   *
   * @returns Array of hashKey values.
   *
   * @throws `Error` if `entity` is invalid.
   */
  getHashKeySpace(
    entityToken: keyof M & string,
    timestampFrom = 0,
    timestampTo = Date.now(),
  ): string[] {
    try {
      // Validate params.
      this.validateEntityToken(entityToken);

      const { shardBumps } = this.config.entities[entityToken];

      const hashKeySpace = shardBumps
        .filter(
          (bump, i) =>
            (i === shardBumps.length - 1 ||
              shardBumps[i + 1].timestamp > timestampFrom) &&
            bump.timestamp <= timestampTo,
        )
        .flatMap(({ charBits, chars }) => {
          const radix = 2 ** charBits;

          return chars
            ? [...range(0, radix ** chars - 1)].map((char) =>
                char.toString(radix).padStart(chars, '0'),
              )
            : '';
        })
        .map(
          (shardKey) =>
            `${entityToken}${this.config.shardKeyDelimiter}${shardKey}`,
        );

      console.debug('generated hash key space', {
        entityToken,
        timestampFrom,
        timestampTo,
        hashKeySpace,
      });

      return hashKeySpace;
    } catch (error) {
      if (error instanceof Error)
        console.error(error.message, {
          entityToken,
          timestampFrom,
          timestampTo,
        });

      throw error;
    }
  }

  /**
   * Rehydrate an array of dehydrated page keys into a {@link PageKeyMap | `PageKeyMap`} object.
   *
   * @param dehydrated - Array of dehydrated page keys or undefined if new query.
   * @param entity - Entity token.
   * @param indexes - Array of `entity` index tokens.
   * @param timestampFrom - Lower timestanp limit. Defaults to `0`.
   * @param timestampTo - Upper timestamp limit. Defaults to `Date.now()`.
   *
   * @returns Rehydrated {@link PageKeyMap | `PageKeyMap`} object.
   *
   * @throws `Error` if `entity` is invalid.
   * @throws `Error` if `indexes` is empty.
   * @throws `Error` if any `indexes` are invalid.
   * @throws `Error` if `dehydrated` has invalid length.
   */
  rehydratePageKeyMap<
    Item extends EntityItem<EntityToken, M, HashKey, RangeKey>,
    EntityToken extends keyof M & string,
  >(
    dehydrated: string[] | undefined,
    entityToken: EntityToken,
    indexTokens: string[],
    timestampFrom = 0,
    timestampTo = Date.now(),
  ): PageKeyMap<Item, IndexableTypes> {
    try {
      // Validate params.
      if (!indexTokens.length) throw new Error('indexTokens empty');
      indexTokens.map((index) =>
        this.validateEntityIndexToken(entityToken, index),
      );

      // Shortcut empty dehydrated.
      if (dehydrated && !dehydrated.length) return {};

      // Get hash key space.
      const hashKeySpace = this.getHashKeySpace(
        entityToken,
        timestampFrom,
        timestampTo,
      );

      // Default dehydrated.
      dehydrated ??= [
        ...range(1, hashKeySpace.length * indexTokens.length, ''),
      ];

      // Validate dehydrated length
      if (dehydrated.length !== hashKeySpace.length * indexTokens.length)
        throw new Error('dehydrated length mismatch');

      // Rehydrate pageKeys.
      const rehydrated = mapValues(
        zipToObject(indexTokens, cluster(dehydrated, hashKeySpace.length)),
        (dehydratedIndexPageKeyMaps, index) =>
          zipToObject(hashKeySpace, (hashKey, i) => {
            if (!dehydratedIndexPageKeyMaps[i]) return;

            const item = {
              [this.config.hashKey]: hashKey,
              ...this.rehydrateIndexItem(
                dehydratedIndexPageKeyMaps[i],
                entityToken,
                index,
                [this.config.hashKey],
              ),
            };

            this.updateItemRangeKey(item, entityToken);

            return zipToObject(
              this.config.entities[entityToken].indexes[index],
              (component) =>
                this.config.entities[entityToken].generated[component]
                  ? this.encodeGeneratedProperty(item, entityToken, component)!
                  : item[component],
            );
          }),
      );

      console.debug('rehydrated page key map', {
        dehydrated,
        entityToken,
        indexTokens,
        rehydrated,
      });

      return rehydrated as PageKeyMap<Item, IndexableTypes>;
    } catch (error) {
      if (error instanceof Error)
        console.error(error.message, {
          dehydrated,
          entityToken,
          indexTokens,
        });

      throw error;
    }
  }

  /**
   * Query an entity across shards in a provider-generic fashion.
   *
   * @remarks
   * The provided {@link ShardQueryFunction | `ShardQueryFunction`} performs the actual query of individual
   * data pages on individual shards. This function is presumed to express
   * provider-specific query logic, including any necessary indexing or search
   * constraints.
   *
   * Shards will generally not be in alignment with provided sort
   * indexes. The resulting data set will therefore NOT be sorted despite any
   * sort imposed by `shardQuery`, and will require an additional sort to
   * present a sorted result to the end user.
   *
   * As a result, returned data pages will also be somewhat unordered. Expect
   * the leading and trailing edges of returned data pages to interleave
   * somewhat with preceding & following pages.
   *
   * Unsharded query results should sort & page as expected.
   *
   * @param options - Query options.
   *
   * @returns Query results combined across shards.
   *
   * @throws Error if `pageKeyMap` keys do not match `queryMap` keys.
   */
  async query<
    Item extends EntityItem<EntityToken, M, HashKey, RangeKey>,
    EntityToken extends keyof M & string,
  >({
    entityToken,
    hashKey,
    item,
    limit,
    pageKeyMap,
    pageSize,
    queryMap,
    sortOrder = [],
    timestampFrom = 0,
    timestampTo = Date.now(),
    throttle = this.config.throttle,
  }: QueryOptions<
    Item,
    EntityToken,
    M,
    HashKey,
    RangeKey,
    IndexableTypes
  >): Promise<QueryResult<Item, EntityToken, M, HashKey, RangeKey>> {
    try {
      // Get defaults.
      const { defaultLimit, defaultPageSize } =
        this.config.entities[entityToken];
      limit ??= defaultLimit;
      pageSize ??= defaultPageSize;

      // Validate params.
      this.validateEntityGeneratedProperty(entityToken, hashKey, true);

      if (!(limit === Infinity || (isInt(limit) && limit >= 1)))
        throw new Error('limit must be a positive integer or Infinity.');

      if (!(isInt(pageSize) && pageSize >= 1))
        throw new Error('pageSize must be a positive integer');

      // Rehydrate pageKeyMap.
      const rehydratedPageKeyMap = this.rehydratePageKeyMap(
        pageKeyMap
          ? (JSON.parse(
              decompressFromEncodedURIComponent(pageKeyMap),
            ) as string[])
          : undefined,
        entityToken,
        Object.keys(queryMap),
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
      } as WorkingQueryResult<Item, EntityToken, M, HashKey, RangeKey>;

      do {
        // TODO: This loop will blow up as shards scale, since at a minimum it will return shardCount * pageSize
        // items, which may be >> limit. Probably the way to fix this is to limit the number of shards queried per
        // iteration in order to keep shardsQueried * pageSize > (limit - items.length) but only just.

        // TODO: Test for invalid characters (path delimiters) in index keys & shard key values.

        // Query every shard on every index in pageKeyMap.
        const shardQueryResults = await parallel(
          throttle,
          Object.entries(rehydratedPageKeyMap).flatMap(
            ([index, indexPageKeys]) =>
              Object.entries(indexPageKeys).map(([hashKey, pageKey]) => [
                index,
                hashKey,
                pageKey,
              ]),
          ) as [string, string, Item | undefined][],
          async ([index, hashKey, pageKey]: [
            string,
            string,
            Item | undefined,
          ]) => ({
            index,
            queryResult: await queryMap[index](hashKey, pageKey, pageSize),
            hashKey,
          }),
        );

        // Reduce shardQueryResults & updateworkingRresult.
        workingResult = shardQueryResults.reduce<
          WorkingQueryResult<Item, EntityToken, M, HashKey, RangeKey>
        >(({ items, pageKeyMap }, { index, queryResult, hashKey }) => {
          Object.assign(rehydratedPageKeyMap[index], {
            [hashKey]: queryResult.pageKey,
          });

          return {
            items: [...items, ...queryResult.items],
            pageKeyMap,
          };
        }, workingResult);
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
              this.config.entities[entityToken].uniqueProperty as keyof Item
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
            this.dehydratePageKeyMap(workingResult.pageKeyMap, entityToken),
          ),
        ),
      } as QueryResult<Item, EntityToken, M, HashKey, RangeKey>;

      console.debug('queried entityToken across shards', {
        entityToken,
        hashKey,
        item,
        limit,
        pageKeyMap,
        pageSize,
        queryMap,
        timestampFrom,
        timestampTo,
        throttle,
        rehydratedPageKeyMap,
        workingResult,
        result,
      });

      return result;
    } catch (error) {
      if (error instanceof Error)
        console.error(error.message, {
          entityToken,
          hashKey,
          item,
          limit,
          pageKeyMap,
          pageSize,
          queryMap,
          timestampFrom,
          timestampTo,
          throttle,
        });

      throw error;
    }
  }
}
