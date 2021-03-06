/**
 * Copyright (c) 2015-present, Joshua Hollenbeck
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { ResourceDescriptor } from '../resource/descriptor';
import { RefraxOptions, RefraxParameters } from '../util/composableHash';
import { Configurable } from '../util/configurable';
import {
  cleanIdentifier,
  each,
  extend,
  invariant,
  isPlainObject,
  select,
  warning
} from '../util/tools';
import { IActionType, IKeyValue, TStackItem } from '../util/types';
import { createSchemaCollection } from './createSchemaCollection';
import { createSchemaNamespace } from './createSchemaNamespace';
import { createSchemaResource } from './createSchemaResource';
import { SchemaNode } from './node';

const SchemaAccescessorMixins: IKeyValue[] = [];

// @todo Do we need serialization comparison or is strict equality good enough?
// function serializer() {
//   let stack = []
//     , keys = [];
//
//   return function(key, value) {
//     if (stack.length > 0) {
//       const thisPos = stack.indexOf(this);
//       if (~thisPos) {
//         stack.splice(thisPos + 1);
//         keys.splice(thisPos, Infinity, key);
//       }
//       else {
//         stack.push(this);
//         keys.push(key);
//       }
//
//       const valuePos = stack.indexOf(value);
//       if (~valuePos) {
//         if (stack[0] === value) {
//           value = '[Circular ~]';
//         }
//         else {
//           value = '[Circular ~.' + keys.slice(0, valuePos).join('.') + ']';
//         }
//       }
//     }
//     else {
//       stack.push(value);
//     }
//
//     return value;
//   };
// }
//
// function stringify(obj) {
//   return JSON.stringify(obj, serializer());
// }

// Determine if a "part" of a stack is comparable to another based on nodes only
const compareStackNodes = (part: TStackItem[], stack: TStackItem[]) => {
  part = select(part, (obj: TStackItem) =>
    obj instanceof SchemaNode);
  stack = select(stack, (obj: TStackItem) =>
    obj instanceof SchemaNode);
  stack = stack.slice(Math.max(stack.length - part.length, 0));

  if (stack.length !== part.length) {
    return false;
  }

  const size = stack.length;
  for (let i = 0; i < size; i++) {
    if (stack[i] !== part[i]) {
      return false;
    }
  }

  return true;
  // return stringify(part) === stringify(stack);
};

const enumerateNodeLeafs = (node: SchemaNode,
                            stack: TStackItem[],
                            iterator: (key: string, node: SchemaNode, stack: TStackItem[]) => void) => {
  each(node.leafs, (leaf: IKeyValue, key: string) => {
    if (leaf.stack === null || compareStackNodes(leaf.stack, stack)) {
      iterator(key, leaf.node, stack.concat(leaf.node));
    }
  });
};

const createLeaf = (parent: SchemaPath,
                    detached: boolean,
                    identifier: SchemaPath | SchemaNode | string,
                    leafNode?: SchemaPath | SchemaNode) => {
  const node: SchemaNode = parent.__node;
  const stack: TStackItem[] = parent.__stack;

  if (identifier instanceof SchemaNode) {
    leafNode = identifier;
    identifier = null!;
  }
  else if (identifier instanceof SchemaPathClass) {
    leafNode = identifier.__node;
    identifier = null!;
  }

  if (leafNode instanceof SchemaPathClass) {
    leafNode = leafNode.__node;
  }
  else if (!(leafNode instanceof SchemaNode)) {
    throw new TypeError(
      'SchemaPath:addLeaf - Expected leaf of type SchemaPath or SchemaNode'
    );
  }

  if (!identifier && !(identifier = leafNode.identifier)) {
    throw new TypeError(
      'SchemaPath:addLeaf - Failed to add leaf with no inherit identifier.'
    );
  }

  identifier = cleanIdentifier(identifier as string);
  node.leafs[identifier] = { node: leafNode, stack: detached ? stack : null };

  Object.defineProperty(parent, identifier, {
    get: () =>
      createSchemaPath(leafNode as SchemaNode, stack.concat(leafNode!))
  });
};

export class SchemaPathClass extends Configurable {
  static mixins: IKeyValue[] = SchemaAccescessorMixins;

  __node: SchemaNode;
  __stack: TStackItem[];

  constructor(node: SchemaNode, stack?: TStackItem[], clone?: SchemaPath) {
    super();

    // tslint:disable-next-line:max-line-length
    invariant(node instanceof SchemaNode, `SchemaPath - Expected node of type SchemaNode but found \`${typeof(node)}\``);

    if (!stack) {
      stack = [node];
    }

    this.__node = node;
    this.__stack = stack;

    each(SchemaAccescessorMixins, (mixin: IKeyValue) => {
      extend(this, mixin);
    });

    if (clone) {
      this._options.extend(clone._options);
      this._parameters.extend(clone._parameters);
      this._queryParams.extend(clone._queryParams);
    }

    enumerateNodeLeafs(node, stack, (key: string, leafNode: SchemaNode, leafStack: TStackItem[]) => {
      Object.defineProperty(this, key, {
        get: () =>
          createSchemaPath(leafNode, leafStack)
      });
    });
  }

  toString(): string {
    return 'SchemaPath';
  }

  clone(): SchemaPath {
    return createSchemaPath(this.__node, this.__stack, this as any as SchemaPath) as any as SchemaPath;
  }

  enumerateLeafs(iterator: (key: string, path: SchemaPath) => void): void {
    enumerateNodeLeafs(this.__node, this.__stack, (key: string,
                                                   leafNode: SchemaNode,
                                                   leafStack: TStackItem[]) => {
      const schemaPath = createSchemaPath(leafNode, leafStack.concat([
        this._options,
        this._parameters,
        this._queryParams
      ]));
      iterator(key, schemaPath as any as SchemaPath);
    });
  }

  inspect(result: IKeyValue = {}): IKeyValue {
    this.enumerateLeafs((_key: string, schemaPath: SchemaPath) => {
      const descriptor = new ResourceDescriptor(null, IActionType.inspect, schemaPath.__stack);
      result[descriptor.path] = descriptor;
      schemaPath.inspect(result);
    });

    return result;
  }

  invalidate(options: IKeyValue = {}): void {
    invariant(isPlainObject(options), `invalidate expected argument of type \`Object\` but found ${options}`);

    const stack = this.__stack.concat(
      this._options,
      this._parameters,
      this._queryParams
    );

    // @deprecated
    if (options.params) {
      warning(
        false,
        '`SchemaPath.invalidate use of option `params` is deprecated. Please use' +
        ' `SchemaPath.withParams(...) instead.'
      );

      stack.push(new RefraxParameters(options.params));
    }

    // @deprecated
    if (options.paramsGenerator) {
      warning(
        false,
        '`SchemaPath.invalidate use of option `paramsGenerator` is deprecated. Please use' +
        ' `SchemaPath.withParams(...) instead.'
      );

      stack.push(new RefraxParameters(options.paramsGenerator));
    }

    const descriptor = new ResourceDescriptor(null, IActionType.get, stack);

    if (descriptor.valid) {
      if (descriptor.store) {
        descriptor.store.invalidate(descriptor, options);
      }

      if (options.cascade === true) {
        this.invalidateLeafs(options);
      }
    }
  }

  invalidateLeafs(options: IKeyValue = {}): void {
    invariant(isPlainObject(options), `invalidateLeafs expected argument of type \`Object\` but found ${options}`);

    const stackTop = [
      new RefraxOptions({
        errorOnInvalid: options.errorOnInvalid !== undefined ? options.errorOnInvalid : options.cascade !== true
      })
    ];

    // @deprecated
    if (options.params) {
      warning(
        false,
        '`SchemaPath.invalidate use of option `params` is deprecated. Please use' +
        ' `SchemaPath.withParams(...) instead.'
      );

      stackTop.push(new RefraxParameters(options.params));
    }

    // @deprecated
    if (options.paramsGenerator) {
      warning(
        false,
        '`SchemaPath.invalidate use of option `paramsGenerator` is deprecated. Please use' +
        ' `SchemaPath.withParams(...) instead.'
      );

      stackTop.push(new RefraxParameters(options.paramsGenerator));
    }

    this.enumerateLeafs((_key: string, schemaPath: SchemaPath) => {
      const stack = ([] as TStackItem[]).concat(schemaPath.__stack, stackTop);
      const descriptor = new ResourceDescriptor(null, IActionType.get, stack);

      if (descriptor.valid) {
        if (descriptor.store) {
          descriptor.store.invalidate(descriptor, options);
        }

        if (options.cascade === true) {
          schemaPath.invalidateLeafs(options);
        }
      }
    });
  }

  addLeaf(leaf: SchemaPath | SchemaNode): this;
  addLeaf(identifier: string, leaf: SchemaPath | SchemaNode): this;
  addLeaf(identifier: SchemaPath | SchemaNode | string, leaf?: SchemaPath | SchemaNode): this {
    createLeaf(this as any as SchemaPath, false, identifier, leaf);

    return this;
  }

  addDetachedLeaf(leaf: SchemaPath): this;
  addDetachedLeaf(identifier: string, leaf: SchemaPath | SchemaNode): this;
  addDetachedLeaf(identifier: SchemaPath | SchemaNode | string, leaf?: SchemaPath | SchemaNode): this {
    createLeaf(this as any as SchemaPath, true, identifier, leaf);

    return this;
  }

  addCollection(path: string, options?: IKeyValue): SchemaPath {
    const collection = createSchemaCollection(path, options);
    createLeaf(this as any as SchemaPath, true, collection);

    return collection;
  }

  addResource(path: string, options?: IKeyValue): SchemaPath {
    const resource = createSchemaResource(path, options);
    createLeaf(this as any as SchemaPath, true, resource);

    return resource;
  }

  addNamespace(path: string, options?: IKeyValue): SchemaPath {
    const namespace = createSchemaNamespace(path, options);
    createLeaf(this as any as SchemaPath, true, namespace);

    return namespace;
  }
}

export interface ISchemaPathAccessor {
  [key: string]: SchemaPath;
}

export type SchemaPath = SchemaPathClass & ISchemaPathAccessor;

export const createSchemaPath = (node: SchemaNode, stack?: TStackItem[], clone?: SchemaPath) =>
  new SchemaPathClass(node, stack, clone) as any as SchemaPath;
