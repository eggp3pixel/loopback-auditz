import _debug from './debug';

const debug = _debug();
const warn = (options, ...rest) => {
  if (!options.silenceWarnings) {
    console.warn(...rest);
  }
};
const utils = require('loopback-datasource-juggler/lib/utils');


export default (Model, bootOptions = {}) => {
  debug('Auditz mixin for Model %s', Model.modelName);
  let app;

  const options = Object.assign({
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
    deletedAt: 'deletedAt',
    createdBy: 'createdBy',
    updatedBy: 'updatedBy',
    deletedBy: 'deletedBy',
    unknownUser: 0,
    remoteCtx: 'remoteCtx',
    scrub: false,
    required: true,
    validateUpsert: false, // default to turning validation off
    silenceWarnings: false,
    revisions: {
      name: 'revisions',
      dataSource: 'db',
      autoMigrate: true,
    },
  }, bootOptions);

  options.revisionsModelName = (typeof options.revisions === 'object' && options.revisions.name) ?
    options.revisions.name : 'revisions';
  debug('options', options);

  const properties = Model.definition.properties;
  const idName = Model.dataSource.idName(Model.modelName);

  let scrubbed = {};
  if (options.scrub !== false) {
    let propertiesToScrub = options.scrub;
    if (!Array.isArray(propertiesToScrub)) {
      propertiesToScrub = Object.keys(properties)
        .filter(prop => !properties[prop][idName] && prop !== options.deletedAt && prop !== options.deletedBy);
    }
    scrubbed = propertiesToScrub.reduce((obj, prop) => ({ ...obj, [prop]: null }), {});
  }

  if (!options.validateUpsert && Model.settings.validateUpsert) {
    Model.settings.validateUpsert = false;
    warn(options, `${Model.pluralModelName} settings.validateUpsert was overridden to false`);
  }

  if (Model.settings.validateUpsert && options.required) {
    warn(options, `Upserts for ${Model.pluralModelName} will fail when
          validation is turned on and time stamps are required`);
  }

  Model.settings.validateUpsert = options.validateUpsert;

  Model.defineProperty(options.createdAt, {type: Date, required: options.required, defaultFn: 'now'});
  Model.defineProperty(options.updatedAt, {type: Date, required: options.required});
  Model.defineProperty(options.deletedAt, {type: Date, required: false});

  Model.defineProperty(options.createdBy, {type: Number, required: false});
  Model.defineProperty(options.updatedBy, {type: Number, required: false});
  Model.defineProperty(options.deletedBy, {type: Number, required: false});

  Model.observe('after save', (ctx, next) => {
    if (!options.revisions) {
      return next();
    }
    debug('ctx.options', ctx.options);

    // determine the currently logged in user. Default to options.unknownUser
    let currentUser = options.unknownUser;

    if (ctx.options[options.remoteCtx]) {
      if (ctx.options[options.remoteCtx].req.accessToken) {
        currentUser = ctx.options[options.remoteCtx].req.accessToken.userId;
      }
    }

    Model.getApp((err, a) => {
      if (err) {
        console.error('Cannot get app! ', err);
        return next(err);
      }
      app = a;
      let ipForwarded = '';
      let ip = '127.0.0.1';
      if (ctx.options.remoteCtx) {
        ipForwarded = ctx.options.remoteCtx.req.headers['x-forwarded-for'];
        ip = ctx.options.remoteCtx.req.connection.remoteAddress;
      }
      // If it's a new instance, set the createdBy to currentUser
      if (ctx.isNewInstance) {
        app.models[options.revisionsModelName].create({
          action: 'create',
          table_name: Model.modelName,
          row_id: ctx.instance.id,
          old: null,
          new: ctx.instance,
          user: currentUser,
          ip: ip,
          ip_forwarded: ipForwarded,
        }, next);
      } else {
        if (ctx.options && ctx.options.delete) {
          if (ctx.options.oldInstance) {
            app.models[options.revisionsModelName].create({
              action: 'delete',
              table_name: Model.modelName,
              row_id: ctx.options.oldInstance.id,
              old: ctx.options.oldInstance,
              new: null,
              user: currentUser,
              ip: ip,
              ip_forwarded: ipForwarded,
            }, next);
          } else if (ctx.options.oldInstances) {
            const entries = ctx.options.oldInstances.map(inst => {
              return {
                action: 'delete',
                table_name: Model.modelName,
                row_id: inst.id,
                old: inst,
                new: null,
                user: currentUser,
                ip: ip,
                ip_forwarded: ipForwarded,
              };
            });
            app.models[options.revisionsModelName].create(entries, next);
          } else {
            warn(options, 'Cannot register delete without old instance! Options: %j', ctx.options);
            return next();
          }
        } else {
          if (ctx.options.oldInstance && ctx.instance) {
            const inst = ctx.instance;
            app.models[options.revisionsModelName].create({
              action: 'update',
              table_name: Model.modelName,
              row_id: inst.id,
              old: ctx.options.oldInstance,
              new: inst,
              user: currentUser,
              ip: ip,
              ip_forwarded: ipForwarded,
            }, next);
          } else if (ctx.options.oldInstances) {
            const updatedIds = ctx.options.oldInstances.map(inst => { return inst.id; });
            let newInst = {};
            const query = {where: {[ idName ]: {inq: updatedIds}}};
            app.models[Model.modelName].find(query, (error, newInstances) => {
              if (error) {
                return next(error);
              }
              newInstances.forEach(inst => {
                newInst[ inst[ idName ] ] = inst;
              });
              const entries = ctx.options.oldInstances.map(inst => {
                return {
                  action: 'update',
                  table_name: Model.modelName,
                  row_id: inst.id,
                  old: inst,
                  new: newInst[inst.id],
                  user: currentUser,
                  ip: ip,
                  ip_forwarded: ipForwarded,
                };
              });
              app.models[options.revisionsModelName].create(entries, next);
            });
          } else {
            warn(options, 'Cannot register update without old and new instance. Options: %j', ctx.options);
            warn(options, 'instance: %j', ctx.instance);
            warn(options, 'data: %j', ctx.data);
            return next();
          }
        }
      }
    });
  });

  function getOldInstance(ctx, cb) {
    if (options.revisions) {
      if (typeof ctx.isNewInstance === 'undefined' || !ctx.isNewInstance) {
        let id = ctx.instance ? ctx.instance.id : null;
        if (!id) {
          id = ctx.data ? ctx.data.id : null;
        }
        if (!id && ctx.where) {
          id = ctx.where.id;
        }
        if (!id && ctx.options.remoteCtx) {
          id = ctx.options.remoteCtx.req && ctx.options.remoteCtx.req.args ?
            ctx.options.remoteCtx.req.args.id : null;
        }
        if (id) {
          Model.findById(id, {deleted: true}, (err, oldInstance) => {
            if (err) {
              console.error(err);
              cb(err);
            } else {
              cb(null, oldInstance);
            }
          });
        } else {
          const query = {where: ctx.where} || {};
          Model.find(query, (err, oldInstances) => {
            if (err) {
              console.error(err);
              cb(err);
            } else {
              if (oldInstances.length > 1) {
                return cb(null, oldInstances);
              } else if (oldInstances.length === 0) {
                return cb();
              }
              cb(null, oldInstances[0]);
            }
          });
        }
      } else {
        cb();
      }
    } else {
      cb();
    }
  }

  Model.observe('before save', (ctx, next) => {
    const softDelete = ctx.options.delete;

    getOldInstance(ctx, (err, result) => {
      if (err) {
        console.error(err);
        return next(err);
      }

      if (Array.isArray(result)) {
        ctx.options.oldInstances = result;
      } else {
        ctx.options.oldInstance = result;
      }
      // determine the currently logged in user. Default to options.unknownUser
      let currentUser = options.unknownUser;

      if (ctx.options[options.remoteCtx]) {
        if (ctx.options[options.remoteCtx].req.accessToken) {
          currentUser = ctx.options[options.remoteCtx].req.accessToken.userId;
        }
      }

      // If it's a new instance, set the createdBy to currentUser
      if (ctx.isNewInstance) {
        debug('Setting %s.%s to %s', ctx.Model.modelName, options.createdBy, currentUser);
        ctx.instance[options.createdBy] = currentUser;
      } else {
        // if the createdBy and createdAt are sent along in the data to save, remove the keys
        // as we don't want to let the user overwrite it
        if (ctx.instance) {
          delete ctx.instance[options.createdBy];
          delete ctx.instance[options.createdAt];
        } else {
          delete ctx.data[options.createdBy];
          delete ctx.data[options.createdAt];
        }
      }

      if (ctx.options && ctx.options.skipUpdatedAt) { return next(); }
      let keyAt = options.updatedAt;
      let keyBy = options.updatedBy;
      // Since soft deletes replace the actual delete by an update, we set the option
      // 'delete' in the overridden delete functions that perform updates.
      // We now have to determine if we need to set updatedAt/updatedBy or
      // deletedAt/deletedBy
      if (softDelete) {
        keyAt = options.deletedAt;
        keyBy = options.deletedBy;
      }
      if (ctx.instance) {
        ctx.instance[keyAt] = new Date();
        ctx.instance[keyBy] = currentUser;
      } else {
        ctx.data[keyAt] = new Date();
        ctx.data[keyBy] = currentUser;
      }
      return next();
    });
  });

  Model.destroyAll = function softDestroyAll(where, cb) {
    let query = where || {};
    let callback = cb;
    if (typeof where === 'function') {
      callback = where;
      query = {};
    }
    return Model.updateAll(query, { ...scrubbed }, {delete: true})
      .then(result => (typeof callback === 'function') ? callback(null, result) : result)
      .catch(error => (typeof callback === 'function') ? callback(error) : Promise.reject(error));
  };

  Model.remove = Model.destroyAll;
  Model.deleteAll = Model.destroyAll;

  Model.destroyById = function softDestroyById(id, opt, cb) {
    const callback = (cb === undefined && typeof opt === 'function') ? opt : cb;
    let newOpt = {delete: true};
    if (typeof opt === 'object') {
      newOpt.remoteCtx = opt.remoteCtx;
    }

    return Model.updateAll({ [idName]: id }, { ...scrubbed}, newOpt)
      .then(result => (typeof callback === 'function') ? callback(null, result) : result)
      .catch(error => (typeof callback === 'function') ? callback(error) : Promise.reject(error));
  };

  Model.removeById = Model.destroyById;
  Model.deleteById = Model.destroyById;

  Model.prototype.destroy = function softDestroy(opt, cb) {
    const callback = (cb === undefined && typeof opt === 'function') ? opt : cb;

    return this.updateAttributes({ ...scrubbed }, {delete: true})
      .then(result => (typeof cb === 'function') ? callback(null, result) : result)
      .catch(error => (typeof cb === 'function') ? callback(error) : Promise.reject(error));
  };

  Model.prototype.remove = Model.prototype.destroy;
  Model.prototype.delete = Model.prototype.destroy;

  // Emulate default scope but with more flexibility.
  const queryNonDeleted = {[options.deletedAt]: null};

  const _findOrCreate = Model.findOrCreate;
  Model.findOrCreate = function findOrCreateDeleted(query = {}, ...rest) {
    if (!query.deleted) {
      if (!query.where || Object.keys(query.where).length === 0) {
        query.where = queryNonDeleted;
      } else {
        query.where = { and: [ query.where, queryNonDeleted ] };
      }
    }

    return _findOrCreate.call(Model, query, ...rest);
  };

  const _find = Model.find;
  Model.find = function findDeleted(query = {}, ...rest) {
    if (!query.deleted) {
      if (!query.where || Object.keys(query.where).length === 0) {
        query.where = queryNonDeleted;
      } else {
        query.where = { and: [ query.where, queryNonDeleted ] };
      }
    }

    return _find.call(Model, query, ...rest);
  };

  const _count = Model.count;
  Model.count = function countDeleted(where = {}, ...rest) {
    // Because count only receives a 'where', there's nowhere to ask for the deleted entities.
    let whereNotDeleted;
    if (!where || Object.keys(where).length === 0) {
      whereNotDeleted = queryNonDeleted;
    } else {
      whereNotDeleted = { and: [ where, queryNonDeleted ] };
    }
    return _count.call(Model, whereNotDeleted, ...rest);
  };

  const _update = Model.update;
  Model.update = Model.updateAll = function updateDeleted(where = {}, ...rest) {
    // Because update/updateAll only receives a 'where', there's nowhere to ask for the deleted entities.
    let whereNotDeleted;
    if (!where || Object.keys(where).length === 0) {
      whereNotDeleted = queryNonDeleted;
    } else {
      whereNotDeleted = { and: [ where, queryNonDeleted ] };
    }
    return _update.call(Model, whereNotDeleted, ...rest);
  };

  function _setupRevisionsModel(opts, cb) {
    const callback = cb || utils.createPromiseCallback();
    const autoUpdate = (opts.revisions === true || (typeof opts.revisions === 'object' && opts.revisions.autoUpdate));
    const dsName = (typeof opts.revisions === 'object' && opts.revisions.dataSource) ?
      opts.revisions.dataSource : 'db';

    const revisionsDef = require('./models/revision.json');
    let settings = {};
    for (let s in revisionsDef) {
      if (s !== 'name' && s !== 'properties') {
        settings[s] = revisionsDef[s];
      }
    }

    const revisionsModel = app.dataSources[dsName].createModel(
      options.revisionsModelName,
      revisionsDef.properties,
      settings
    );
    const revisions = require('./models/revision')(revisionsModel, opts);

    app.model(revisions);


    if (autoUpdate) {
      // create or update the revisions table
      app.dataSources[dsName].autoupdate([options.revisionsModelName], (error) => {
        if (error) {
          callback(error);
        }
        callback(null, app.models[options.revisionsModelName]);
      });
    }
  }

  if (options.revisions) {
    Model.getApp((err, a) => {
      if (err) {
        return console.error(err);
      }
      app = a;
      if (!app.models[options.revisionsModelName]) {
        _setupRevisionsModel(options, (error) => {
          if (error) {
            return console.error(error);
          }
        });
      }
    });
  }
};