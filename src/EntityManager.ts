import { objectify } from 'radash';
import stringHash from 'string-hash';

import type { Config, EntityItem, EntityMap, ShardBump } from './Config';
import { configSchema, type ParsedConfig } from './ParsedConfig';

/**
 * Null or undefined.
 */
export type Nil = null | undefined;

/**
 * Tests whether a value is Nil.
 *
 * @param value - Value.
 * @returns true if value is null or undefined.
 */
export const isNil = (value: unknown): value is Nil =>
  value === null || value === undefined;

/**
 * Injectable logger interface.
 *
 * @category Options
 */
export interface Logger {
  debug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * EntityManager constructor options.
 *
 * @category Options
 */
export interface EntityManagerOptions {
  /**
   * Logger object.
   *
   * @defaultValue `console`
   */
  logger?: Logger;

  /**
   * Default maximum number of shards to query in parallel.
   *
   * @defaultValue `10`
   */
  throttle?: number;
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
> {
  #config: ParsedConfig;
  // eslint-disable-next-line no-unused-private-class-members
  #logger: Logger;
  // eslint-disable-next-line no-unused-private-class-members
  #throttle: number;

  /**
   * Create an EntityManager instance.
   *
   * @param options - EntityManager options.
   */
  constructor(
    config: Config<M, HashKey, RangeKey>,
    { logger = console, throttle = 10 }: EntityManagerOptions = {},
  ) {
    this.#config = configSchema.parse(config);
    this.#logger = logger;
    this.#throttle = throttle;
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
   */
  getShardBump(entity: keyof EntityMap, timestamp: number): ShardBump {
    return [...this.config.entities[entity].shardBumps]
      .reverse()
      .find((bump) => bump.timestamp <= timestamp)!;
  }

  /**
   * Encode a generated property value. Returns a string or undefined if atomicity requirement not met.
   *
   * @param entity - Entity token.
   * @param item - Entity item.
   * @param property - Generated property name.
   *
   * @returns Encoded generated property value.
   */
  encodeGeneratedProperty<
    Entity extends keyof EntityMap,
    Item extends EntityItem<Entity, EntityMap, HashKey, RangeKey>,
  >(
    entity: Entity,
    item: Item,
    property: keyof EntityMap[Entity],
  ): string | undefined {
    try {
      // Validate entity property.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!this.config.entities[entity].generated[property])
        throw new Error(`unknown generated property`);

      const { atomic, elements, sharded } =
        this.config.entities[entity].generated[property];

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

      this.#logger.debug('encoded generated property', {
        entity,
        item,
        property,
        encoded,
      });

      return encoded;
    } catch (error) {
      if (error instanceof Error)
        this.#logger.debug(error.message, { entity, item, property });

      throw error;
    }
  }

  /**
   * Decode a generated property value. Returns a partial EntityItem.
   *
   * @param entity - Entity token.
   * @param value - Encoded generated property value.
   *
   * @returns Partial EntityItem with decoded properties decoded from `value`.
   */
  decodeGeneratedProperty<
    Entity extends keyof EntityMap,
    Item extends EntityItem<Entity, EntityMap, HashKey, RangeKey>,
  >(entity: Entity, value: string): Partial<Item> {
    try {
      // Handle degenerate case.
      if (!value) return {};

      // Split value into keys.
      const keys = value.split(this.config.generatedKeyDelimiter);

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
          ([, value]) => value,
        ),
      );

      this.#logger.debug('decoded generated property', {
        entity,
        value,
        decoded,
      });

      return decoded as Partial<Item>;
    } catch (error) {
      if (error instanceof Error)
        this.#logger.debug(error.message, { entity, value });

      throw error;
    }
  }

  /**
   * Update the hash key on an EntityItem. Mutates `item`.
   *
   * @param entity - Entity token.
   * @param item - EntityItem.
   * @param overwrite - Overwrite existing shard key (default `false`).
   *
   * @returns Mutated `item` with updated hash key.
   */
  updateItemHashKey<
    Entity extends keyof EntityMap,
    Item extends EntityItem<Entity, EntityMap, HashKey, RangeKey>,
  >(entity: Entity, item: Item, overwrite = false): Item {
    try {
      // Return current item if hashKey exists and overwrite is false.
      if (item[this.config.hashKey as keyof Item] && !overwrite) {
        this.#logger.debug('did not overwrite existing entity item hash key', {
          entity,
          item,
          overwrite,
        });

        return item;
      }

      // Get item timestamp property & validate.
      const timestamp: number = item[
        this.config.entities[entity].timestampProperty as keyof Item
      ] as unknown as number;

      if (isNil(timestamp)) throw new Error(`missing item timestamp property`);

      // Find first entity sharding bump before timestamp.
      const { nibbleBits, nibbles } = this.getShardBump(entity, timestamp);

      let hashKey = `${entity}${this.config.shardKeyDelimiter}`;

      if (nibbles) {
        // Radix is the numerical base of the shardKey.
        const radix = 2 ** nibbleBits;

        // Get item unique property & validate.
        const uniqueId = item[
          this.config.entities[entity].uniqueProperty as keyof Item
        ] as unknown as string;

        if (isNil(timestamp)) throw new Error(`missing item unique property`);

        hashKey += (stringHash(uniqueId) % (nibbles * radix))
          .toString(radix)
          .padStart(nibbles, '0');
      }

      Object.assign(item, { [this.config.hashKey]: hashKey });

      this.#logger.debug('updated entity item hash key', {
        entity,
        overwrite,
        item,
      });

      return item;
    } catch (error) {
      if (error instanceof Error)
        this.#logger.debug(error.message, { entity, item, overwrite });

      throw error;
    }
  }

  /**
   * Update the range key on an EntityItem. Mutates `item`.
   *
   * @param entity - Entity token.
   * @param item - EntityItem.
   * @param overwrite - Overwrite existing shard key (default `false`).
   *
   * @returns Mutated `item` with updated range key.
   */
  updateItemRangeKey<
    Entity extends keyof EntityMap,
    Item extends EntityItem<Entity, EntityMap, HashKey, RangeKey>,
  >(entity: Entity, item: Item, overwrite = false): Item {
    try {
      // Return current item if rangeKey exists and overwrite is false.
      if (item[this.config.rangeKey as keyof Item] && !overwrite) {
        this.#logger.debug('did not overwrite existing entity item range key', {
          entity,
          item,
          overwrite,
        });

        return item;
      }

      // Get item unique property & validate.
      const uniqueProperty =
        item[this.config.entities[entity].uniqueProperty as keyof Item];

      if (isNil(uniqueProperty))
        throw new Error(`missing item unique property`);

      // Update range key.
      Object.assign(item, {
        [this.config.rangeKey]: [
          this.config.entities[entity].uniqueProperty,
          uniqueProperty,
        ].join(this.config.generatedValueDelimiter),
      });

      this.#logger.debug('updated entity item range key', {
        entity,
        overwrite,
        item,
      });

      return item;
    } catch (error) {
      if (error instanceof Error)
        this.#logger.debug(error.message, { entity, item, overwrite });

      throw error;
    }
  }

  /**
   * Update generated properties on an EntityItem. Mutates `item`.
   *
   * @param entity - Entity token.
   * @param item - EntityItem.
   * @param overwrite - Overwrite existing generated properties (default `false`).
   *
   * @returns Mutated `item` with updated generated properties.
   */
  updateItemGeneratedProperties<
    Entity extends keyof EntityMap,
    Item extends EntityItem<Entity, EntityMap, HashKey, RangeKey>,
  >(entity: Entity, item: Item, overwrite = false): Item {
    try {
      // Update hash key.
      this.updateItemHashKey(entity, item, overwrite);

      // Update range key.
      this.updateItemRangeKey(entity, item, overwrite);

      // Update generated properties.
      for (const property in this.config.entities[entity].generated) {
        if (overwrite || isNil(item[property as keyof Item])) {
          const encoded = this.encodeGeneratedProperty(entity, item, property);

          if (encoded) Object.assign(item, { [property]: encoded });
          else delete item[property as keyof Item];
        }
      }

      this.#logger.debug('updated entity item generated properties', {
        entity,
        overwrite,
        item,
      });

      return item;
    } catch (error) {
      if (error instanceof Error)
        this.#logger.debug(error.message, { entity, item, overwrite });

      throw error;
    }
  }

  /**
   * Strips generated properties from an EntityItem. Mutates `item`.
   *
   * @param entity - Entity token.
   * @param item - EntityItem.
   *
   * @returns Mutated `item` without generated properties.
   */
  stripItemGeneratedProperties<
    Entity extends keyof EntityMap,
    Item extends EntityItem<Entity, EntityMap, HashKey, RangeKey>,
  >(entity: Entity, item: Item): Item {
    // Delete hash & range keys.
    delete item[this.config.hashKey as keyof Item];
    delete item[this.config.rangeKey as keyof Item];

    // Delete generated properties.
    for (const property in this.config.entities[entity].generated)
      delete item[property as keyof Item];

    this.#logger.debug('stripped entity item generated properties', {
      entity,
      item,
    });

    return item;
  }
}
