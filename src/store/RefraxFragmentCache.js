/**
 * Copyright (c) 2015-present, Joshua Hollenbeck
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */
const RefraxConstants = require('RefraxConstants');
const RefraxTools = require('RefraxTools');
const RefraxFragmentResult = require('RefraxFragmentResult');
const FRAGMENT_DEFAULT = RefraxConstants.defaultFragment;
const STATUS_PARTIAL = RefraxConstants.status.PARTIAL;
const STATUS_STALE = RefraxConstants.status.STALE;
const STATUS_COMPLETE = RefraxConstants.status.COMPLETE;
const TIMESTAMP_STALE = RefraxConstants.timestamp.stale;


/**
 * RefraxFragmentCache is the cache layer inside a store typically used for a single
 * resource type and manages all representations and collections of the given resource.
 *
 * Each action requires a Resource Descriptor which requires the following data:
 * @param {String} path The end-point URI where this resource is associated.
 * @param {String} [optional] id The unique id for a give resource.
 * @param {String} [optional] partial The fragment to associate the resource with.
 * @param {Array(String)} [optional] fragments A list of fragments we allow a fetch
 *   to use to compose a partial representation of data.
 *
 * TODO: Should we remove the need to understand status/timestamp externally?
 */
class RefraxFragmentCache {
  constructor() {
    this.fragments = {};
    this.queries = {};
  }

  /**
   * Will return a Stale resource when a given resource cannot be found by the
   * supplied descriptor.
   */
  fetch(descriptor) {
    var fragmentCache = this._getFragment(descriptor.partial)
      , resourceId = descriptor.id
      , result = null
      , resource = null
      , fragments, i, data, entries, entry;

    result = new RefraxFragmentResult();

    if (resourceId) {
      resource = fragmentCache[resourceId];

      if (resource) {
        result.status = resource.status;
        result.timestamp = resource.timestamp;
        result.data = resource.data;
      }

      if (!result.data) {
        // Create a new list of fragments with our global default being last at highest priority.
        fragments = [].concat(descriptor.fragments, FRAGMENT_DEFAULT);

        for (i = 0; i < fragments.length; i++) {
          fragmentCache = this._getFragment(fragments[i])[resourceId];

          if (fragmentCache && fragmentCache.data) {
            result.data = RefraxTools.extend({}, result.data || {}, fragmentCache.data || {});
            result.status = STATUS_PARTIAL;
          }
        }
      }
    }
    else if (descriptor.path) {
      resource = this.queries[descriptor.path];
      if (resource) {
        result.status = resource.status;
        result.timestamp = resource.timestamp;
      }

      if (!resource || !(data = resource.data)) {
        return result;
      }

      // Found a collection resource?
      if (RefraxTools.isArray(data)) {
        entries = RefraxTools.map(data, function(id) {
          var entry = fragmentCache[id];

          if (!entry) {
            throw new TypeError(
              'RefraxFragmentCache:fetch - Unexpected error, failure to find collection entry for `' + id + '`.'
            );
          }

          return RefraxTools.extend({}, entry.data);
        });

        result.data = entries;
      }
      else if (typeof(data) !== 'object') {
        entry = fragmentCache[data];
        if (!entry) {
          throw new TypeError(
            'RefraxFragmentCache:fetch - Unexpected error, failure to find entry for `' + data + '`.'
          );
        }

        result.data = RefraxTools.extend({}, entry.data);
      }
      // Query was for a non-id resource?
      else {
        result.data = RefraxTools.extend({}, data);
      }
    }

    if (!result.data && descriptor.coerce) {
      if (descriptor.coerce === 'collection') {
        result.data = [];
      }
    }

    return result;
  }

  /**
   * Update the metadata for a given resource.
   *
   * TODO: Maybe guard this more or change where metadata is stored as this method
   * could change the `data` property.
   */
  touch(descriptor, touch) {
    var fragmentCache = this._getFragment(descriptor.partial)
      , resourceId = descriptor.id;

    if (!touch) {
      return;
    }

    if (resourceId) {
      fragmentCache[resourceId] = RefraxTools.extend(fragmentCache[resourceId] || {}, touch);
    }
    else if (descriptor.path) {
      this.queries[descriptor.path] = RefraxTools.extend(this.queries[descriptor.path] || {}, touch);
    }
  }

  /**
   * Update the content for a given resource.
   */
  update(descriptor, data, status) {
    var fragmentCache = this._getFragment(descriptor.partial)
      , resourcePath = descriptor.path
      , result = {}
      , tmpId;

    // if no data is present (ie a 204 response) our data then becomes stale
    result = {
      status: status || STATUS_COMPLETE,
      timestamp: data ? Date.now() : TIMESTAMP_STALE
    };

    // Fragments
    if (descriptor.id) {
      fragmentCache[descriptor.id] = RefraxTools.extend({}, result, {
        data: data || fragmentCache[descriptor.id] && fragmentCache[descriptor.id].data
      });
    }
    else if (data) {
      if (RefraxTools.isArray(data)) {
        // normalize set into entries
        data = RefraxTools.map(data, function(item) {
          var itemId;

          if (!RefraxTools.isPlainObject(item)) {
            throw new TypeError('expected object type in array, found ' + typeof(item) + ' instead');
          }

          itemId = descriptor.idFrom(item);
          fragmentCache[itemId] = RefraxTools.extend({}, result, {data: item});
          return itemId;
        });
      }
      else if (data.id) {
        fragmentCache[data.id] = RefraxTools.extend({}, result, {data: data});
      }
    }

    // Queries
    if (resourcePath) {
      this.queries[resourcePath] = RefraxTools.extend({}, result, {
        data: this.queries[resourcePath] && this.queries[resourcePath].data
      });

      if (data) {
        tmpId = descriptor.idFrom(data);

        // TODO: Should we have to intentionally define a dataset as a collection?
        // Or is it ok to check our query cache to see if its an array and treat it
        // like a collection and just append our new data id into it
        if (tmpId && RefraxTools.isArray(this.queries[resourcePath].data)) {
          this.queries[resourcePath].data.push(tmpId);
        }
        else {
          this.queries[resourcePath].data = tmpId || data;
        }
      }
    }
  }

  /**
   * Invalidate all data
   *
   * NOTE: We opt to set value to undefined vs deleting the key itself due to
   * performance reasons (testing shows delete ~98% slower).
   */
  invalidate(descriptor, options = {}) {
    var clearData = !!options.clear
      , invalidator = function(item) {
        // not yet cached so we can skip
        if (!item) {
          return;
        }

        item.status = STATUS_STALE;
        item.timestamp = TIMESTAMP_STALE;
        if (clearData) {
          item.data = undefined;
        }
      };

    if (descriptor) {
      if (options.noQueries !== true) {
        RefraxTools.each(this.queries, function(query, path) {
          if (path === descriptor.path ||
              (descriptor.id &&
                 RefraxTools.isArray(query.data) &&
                 query.data.indexOf(descriptor.id) != -1)) {
            invalidator(query);
          }
        });
      }

      if (options.noFragments !== true && descriptor.id) {
        RefraxTools.each(this.fragments, function(fragment) {
          invalidator(fragment[descriptor.id]);
        });
      }
    }
    else {
      if (options.noQueries !== true) {
        RefraxTools.each(this.queries, invalidator);
      }

      if (options.noFragments !== true) {
        RefraxTools.each(this.fragments, function(fragment) {
          RefraxTools.each(fragment, invalidator);
        });
      }
    }
  }

  /**
   * Delete the content for a given resource.
   *
   * NOTE: We opt to set value to undefined vs deleting the key itself due to
   * performance reasons (testing shows delete ~98% slower).
   */
  destroy(descriptor) {
    var fragmentCache = this._getFragment(descriptor.partial)
      , resourcePath = descriptor.path
      , resourceID = descriptor.id;

    if (resourceID) {
      if (!fragmentCache[resourceID]) {
        return;
      }

      fragmentCache[resourceID] = undefined;
      // Remove our-self from any collection queries we know about
      RefraxTools.each(this.queries, function(query, path) {
        if (RefraxTools.isArray(query.data)) {
          var i = query.data.indexOf(resourceID);

          if (i !== -1) {
            query.data.splice(i, 1);
          }
        }
      });
    }
    else if (resourcePath && this.queries[resourcePath]) {
      this.queries[resourcePath] = undefined;
    }
  }

  _getFragment(fragment) {
    return this.fragments[fragment] ||
          (this.fragments[fragment] = {});
  }
}

export default RefraxFragmentCache;
