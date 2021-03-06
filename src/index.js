import omit from 'lodash.omit';
import Proto from 'uberproto';
import filter from 'feathers-query-filters';
import errors from 'feathers-errors';
import { select } from 'feathers-commons';
import * as utils from './utils';

class Service {
  constructor (options) {
    if (!options) {
      throw new Error('Sequelize options have to be provided');
    }

    if (!options.Model) {
      throw new Error('You must provide a Sequelize Model');
    }

    this.paginate = options.paginate || {};
    this.Model = options.Model;
    this.id = options.id || 'id';
    this.events = options.events;
    this.raw = options.raw !== false;
  }

  extend (obj) {
    return Proto.extend(obj, this);
  }

  _find (params, getFilter = filter) {
    const { filters, query } = getFilter(params.query || {});
    const where = utils.getWhere(query);
    const order = utils.getOrder(filters.$sort);

    const q = Object.assign({
      where,
      order,
      limit: filters.$limit,
      offset: filters.$skip,
      raw: this.raw
    }, params.sequelize);

    if (filters.$select) {
      q.attributes = filters.$select;
    }

    return this.Model.findAndCount(q).then(result => {
      return {
        total: result.count,
        limit: filters.$limit,
        skip: filters.$skip || 0,
        data: result.rows
      };
    }).catch(utils.errorHandler);
  }

  find (params) {
    const paginate = (params && typeof params.paginate !== 'undefined') ? params.paginate : this.paginate;
    const result = this._find(params, where => filter(where, paginate));

    if (!paginate.default) {
      return result.then(page => page.data);
    }

    return result;
  }

  _get (id, params) {
    let promise;

    if (params.sequelize && params.sequelize.include) { // If eager-loading is used, we need to use the find method
      const where = utils.getWhere(params.query);

      // Attach 'where' constraints, if any were used.
      const q = Object.assign({
        where: Object.assign({id: id}, where)
      }, params.sequelize);

      promise = this.Model.findAll(q).then(result => {
        if (result.length === 0) {
          throw new errors.NotFound(`No record found for id '${id}'`);
        }

        return result[0];
      });
    } else {
      const options = Object.assign({ raw: this.raw }, params.sequelize);
      promise = this.Model.findById(id, options).then(instance => {
        if (!instance) {
          throw new errors.NotFound(`No record found for id '${id}'`);
        }

        return instance;
      });
    }

    return promise.then(select(params, this.id))
      .catch(utils.errorHandler);
  }

  // returns either the model intance for an id or all unpaginated
  // items for `params` if id is null
  _getOrFind (id, params) {
    if (id === null) {
      return this._find(params).then(page => page.data);
    }

    return this._get(id, params);
  }

  get (id, params) {
    return this._get(id, params).then(select(params, this.id));
  }

  create (data, params) {
    const options = Object.assign({raw: this.raw}, params.sequelize);
    const isArray = Array.isArray(data);
    let promise;

    if (isArray) {
      promise = this.Model.bulkCreate(data, options);
    } else {
      promise = this.Model.create(data, options);
    }

    return promise.then(result => {
      const sel = select(params, this.id);
      if (options.raw === false) {
        return result;
      }
      if (isArray) {
        return result.map(item => sel(item.toJSON()));
      }
      return sel(result.toJSON());
    }).catch(utils.errorHandler);
  }

  patch (id, data, params) {
    const where = Object.assign({}, filter(params.query || {}).query);
    const mapIds = page => page.data.map(current => current[this.id]);

    if (id !== null) {
      where[this.id] = id;
    }

    const options = Object.assign({}, params.sequelize, { where });

    // This is the best way to implement patch in sql, the other dialects 'should' use a transaction.
    if (this.Model.sequelize.options.dialect === 'postgres' && params.$returning !== false) {
      options.returning = true;
      return this.Model.update(omit(data, this.id), options)
            .then(results => {
              if (id === null) {
                return results[1];
              }

              if (!results[1].length) {
                throw new errors.NotFound(`No record found for id '${id}'`);
              }

              return results[1][0];
            })
            .then(select(params, this.id))
            .catch(utils.errorHandler);
    }

    // By default we will just query for the one id. For multi patch
    // we create a list of the ids of all items that will be changed
    // to re-query them after the update
    const ids = id === null ? this._find(params)
        .then(mapIds) : Promise.resolve([ id ]);

    return ids
      .then(idList => {
        // Create a new query that re-queries all ids that
        // were originally changed
        const findParams = Object.assign({}, params, {
          query: { [this.id]: { $in: idList } }
        });

        return this.Model.update(omit(data, this.id), options)
            .then(() => {
              if (params.$returning !== false) {
                return this._getOrFind(id, findParams);
              } else {
                return Promise.resolve([]);
              }
            });
      })
      .then(select(params, this.id))
      .catch(utils.errorHandler);
  }

  update (id, data, params) {
    const options = Object.assign({ raw: this.raw }, params.sequelize);

    if (Array.isArray(data)) {
      return Promise.reject(new errors.BadRequest('Not replacing multiple records. Did you mean `patch`?'));
    }

    // Force the {raw: false} option as the instance is needed to properly
    // update
    return this.Model.findById(id, { raw: false }).then(instance => {
      if (!instance) {
        throw new errors.NotFound(`No record found for id '${id}'`);
      }

      let copy = {};
      Object.keys(instance.toJSON()).forEach(key => {
        if (typeof data[key] === 'undefined') {
          copy[key] = null;
        } else {
          copy[key] = data[key];
        }
      });

      return instance.update(copy, options).then(instance => {
        if (options.raw === false) {
          return instance;
        }
        return instance.toJSON();
      });
    })
    .then(select(params, this.id))
    .catch(utils.errorHandler);
  }

  remove (id, params) {
    const opts = Object.assign({ raw: this.raw }, params);
    const where = Object.assign({}, filter(params.query || {}).query);
    if (id !== null) {
      where[this.id] = id;
    }

    const options = Object.assign({}, params.sequelize, { where });

    if (params.$returning !== false) {
      return this._getOrFind(id, opts).then(data => {
        return this.Model.destroy(options).then(() => data);
      })
        .then(select(params, this.id))
        .catch(utils.errorHandler);
    } else {
      return this.Model.destroy(options).then(() => Promise.resolve([]))
        .then(select(params, this.id))
        .catch(utils.errorHandler);
    }
  }
}

export default function init (options) {
  return new Service(options);
}

init.Service = Service;
