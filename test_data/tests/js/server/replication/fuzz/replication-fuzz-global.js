/*jshint globalstrict:false, strict:false, unused: false */
/*global assertEqual, assertTrue, arango, print, ARGUMENTS */

////////////////////////////////////////////////////////////////////////////////
/// @brief test the replication
///
/// @file
///
/// DISCLAIMER
///
/// Copyright 2010-2021 triagens GmbH, Cologne, Germany
///
/// Licensed under the Apache License, Version 2.0 (the "License");
/// you may not use this file except in compliance with the License.
/// You may obtain a copy of the License at
///
///     http://www.apache.org/licenses/LICENSE-2.0
///
/// Unless required by applicable law or agreed to in writing, software
/// distributed under the License is distributed on an "AS IS" BASIS,
/// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
/// See the License for the specific language governing permissions and
/// limitations under the License.
///
/// Copyright holder is triAGENS GmbH, Cologne, Germany
///
/// @author Jan Steemann
/// @author Tomasz Mielech
/// @author Copyright 2017, triAGENS GmbH, Cologne, Germany
////////////////////////////////////////////////////////////////////////////////

var jsunity = require("jsunity");
let url = require('url');
var arangodb = require("@arangodb");
var db = arangodb.db;
const request = require("@arangodb/request");

const reconnectRetry = require('@arangodb/replication-common').reconnectRetry;
var replication = require("@arangodb/replication");
let compareTicks = replication.compareTicks;
var console = require("console");
var internal = require("internal");
var leaderEndpoint = arango.getEndpoint();

const options = internal.parseArgv(ARGUMENTS, 0);
var isCluster = arango.getRole() === 'COORDINATOR';
var isSingle = arango.getRole() === 'SINGLE';
const replStateBeforeStart = replication.globalApplier.stateAll();

const havePreconfiguredReplication = isSingle && (
  (replStateBeforeStart['_system'].state.running === true) ||
    (replStateBeforeStart['_system'].state.phase === 'inactive')
);

const followerURL = url.parse(options['args']);
const followerCreds = followerURL.auth.split(':');
const followerEndpoint = followerURL.protocol + '//' + followerURL.host; // host contains hostname and port


function getCollectionChecksum(baseUrl, jwt, database, colName) {
  var res;
  try {
    let args = {
       url: baseUrl.replace(/^tcp:/, 'http:').replace(/^ssl:/, 'https:') +
         '/_db/' + database + '/_api/collection/' + colName + '/checksum',
       auth: {
         bearer: jwt,
       },
       timeout: 300
    }
    res = request.get(args);
  } catch (x) {
    print('can not get collection checksum' + x)
    throw x;
  }
  return JSON.parse(res.body).checksum;
}

////////////////////////////////////////////////////////////////////////////////
/// @brief test suite
////////////////////////////////////////////////////////////////////////////////

function ReplicationSuite() {
  'use strict';
  var cn = "UnitTestsReplication";

  var connectToLeader = function() {
    reconnectRetry(leaderEndpoint, db._name(), followerCreds[0], followerCreds[1]);
    db._flushCache();
  };

  var connectToFollower = function() {
    print(followerEndpoint);
    reconnectRetry(followerEndpoint, db._name(), followerCreds[0], followerCreds[1]);
    db._flushCache();
  };


  var collectionChecksum = function(name) {
    if (isCluster) {
      let csa = db._query('RETURN md5(FOR doc IN @@col SORT doc._key RETURN [doc._key, doc._rev])', {'@col':name}).toArray();
      return csa[0];
    } else {
      return db._collection(name).checksum(false, true).checksum;
    }
  };

  var collectionCount = function(name) {
    return db._collection(name).count();
  };

  var compare = function(leaderFunc, followerFuncFinal) {
    db._useDatabase("_system");
    db._flushCache();
    if (isSingle) {
      connectToFollower();
      if (!havePreconfiguredReplication) {
        let syncResult = replication.setupReplicationGlobal({
          endpoint: leaderEndpoint,
          username: "root",
          password: "",
          verbose: true,
          includeSystem: false,
          requireFromPresent: true,
          incremental: true,
          autoResync: true,
          autoResyncRetries: 5
        });
      }
    }
    let state = {};
    connectToLeader();
    leaderFunc(state);

    // use lastLogTick as of now
    if (!isCluster) {
      state.lastLogTick = replication.logger.state().state.lastUncommittedLogTick;
    } else {
      state.lastLogTick = 0;
      db._useDatabase('_system');
      db._databases().forEach(function(d) {
        db._useDatabase(d);
        db._collections().forEach(col => {
          if (col.name()[0] !== '_') {
            state.lastLogTick += col.count() + 1;
          }
        });
      });
    }

    db._useDatabase("_system");
    let allDatabases = db._databases();

    connectToFollower();
    if (isCluster) {
      while (allDatabases.length !== db._databases().length) {
        print('D ' + allDatabases.length + " !== " + db._databases().length);
        internal.sleep(1);
      }
      let count = 0;
      let lastLogTick = 0;
      while ((lastLogTick !== state.lastLogTick) && (count < 500)) {
        lastLogTick = 0;
        count += 1;
        db._flushCache();
        db._useDatabase('_system');
        db._databases().forEach(function(d) {
          db._useDatabase(d);
          db._collections().forEach(col => {
            if (col.name()[0] !== '_') {
              lastLogTick += col.count() + 1;
            }
          });
        });
        if (lastLogTick !== state.lastLogTick) {
          print('. ' + lastLogTick + " !== " + state.lastLogTick);
          internal.wait(1);
          db._flushCache();
        }
      }
      db._useDatabase('_system');
    } else {

      var printed = false;

      while (true) {
        let followerState = replication.globalApplier.state();

        if (followerState.state.lastError.errorNum > 0) {
          console.topic("replication=error", "follower has errored:", JSON.stringify(followerState.state.lastError));
          throw JSON.stringify(followerState.state.lastError);
        }

        if (!followerState.state.running) {
          console.topic("replication=error", "follower is not running");
          break;
        }

        if (compareTicks(followerState.state.lastAppliedContinuousTick, state.lastLogTick) >= 0 ||
            compareTicks(followerState.state.lastProcessedContinuousTick, state.lastLogTick) >= 0) { // ||
          console.topic("replication=debug", "follower has caught up. state.lastLogTick:", state.lastLogTick, "followerState.lastAppliedContinuousTick:", followerState.state.lastAppliedContinuousTick, "followerState.lastProcessedContinuousTick:", followerState.state.lastProcessedContinuousTick);
          break;
        }

        if (!printed) {
          console.topic("replication=debug", "waiting for follower to catch up");
          printed = true;
        }
        internal.wait(0.5, false);
      }
    }
    db._flushCache();
    followerFuncFinal(state);
  };

  return {

    setUp: function() {
      db._useDatabase("_system");
    },

    tearDown: function() {
      db._useDatabase("_system");
      connectToLeader();

      connectToFollower();
      if (isSingle && !havePreconfiguredReplication) {
        print("deleting replication");
        replication.globalApplier.forget();
      }
    },

    testFuzzGlobal: function() {
      connectToLeader();

      compare(
        function(state) {
          let pickDatabase = function() {
            db._useDatabase('_system');
            let dbs;
            while (true) {
              dbs = db._databases().filter(function(db) {
                return ((db !== '_system') && !db.startsWith('system_'));
              });
              if (dbs.length !== 0) {
                break;
              }
              createDatabase();
            }
            let d = dbs[Math.floor(Math.random() * dbs.length)];
            db._useDatabase(d);
          };

          let pickCollection = function() {
            let collections;
            while (true) {
              collections = db._collections().filter(function(c) { return c.name()[0] !== '_' && c.type() === 2; });
              if (collections.length !== 0) {
                break;
              }
              return createCollection();
            }
            return collections[Math.floor(Math.random() * collections.length)];
          };

          let pickEdgeCollection = function() {
            let collections;
            while (true) {
              collections = db._collections().filter(function(c) { return c.name()[0] !== '_' && c.type() === 3; });
              if (collections.length !== 0) {
                break;
              }
              return createEdgeCollection();
            }
            return collections[Math.floor(Math.random() * collections.length)];
          };

          let insert = function() {
            let collection = pickCollection();
            collection.insert({ value: Date.now() });
          };

          let insertOverwrite = function() {
            let collection = pickCollection();
            collection.insert({ _key: "test", value: Date.now() }, { overwrite: true });
          };

          let remove = function() {
            let collection = pickCollection();
            if (collection.count() === 0) {
              let k = collection.insert({});
              collection.remove(k);
              return;
            }
            collection.remove(collection.any());
          };

          let replace = function() {
            let collection = pickCollection();
            if (collection.count() === 0) {
              let k = collection.insert({});
              collection.replace(k, { value2: Date.now() });
              return;
            }
            collection.replace(collection.any(), { value2: Date.now() });
          };

          let update = function() {
            let collection = pickCollection();
            if (collection.count() === 0) {
              let k = collection.insert({});
              collection.update(k, { value2: Date.now() });
              return;
            }
            collection.update(collection.any(), { value2: Date.now() });
          };

          let insertEdge = function() {
            let collection = pickEdgeCollection();
            collection.insert({ _from: "test/v1", _to: "test/v2", value: Date.now() });
          };

          let insertOrReplace = function() {
            let collection = pickCollection();
            db._executeTransaction({
              collections: { write: [collection.name()] },
              action: function(params) {
                let collection = params.cn, db = require("internal").db;
                let key = "test" + Math.floor(Math.random() * 10000);
                try {
                  db[collection].insert({ _key: key, value: Date.now() });
                } catch (err) {
                  db[collection].replace(key, { value2: Date.now() });
                }
              },
              params: { cn: collection.name() }
            });
          };

          let insertOrUpdate = function() {
            let collection = pickCollection();
            db._executeTransaction({
              collections: { write: [collection.name()] },
              action: function(params) {
                let collection = params.cn, db = require("internal").db;
                let key = "test" + Math.floor(Math.random() * 10000);
                try {
                  db[collection].insert({ _key: key, value: Date.now() });
                } catch (err) {
                  db[collection].update(key, { value2: Date.now() });
                }
              },
              params: { cn: collection.name() }
            });
          };

          let insertMulti = function() {
            let collection = pickCollection();
            db._executeTransaction({
              collections: { write: [collection.name()] },
              action: function(params) {
                let collection = params.cn, db = require("internal").db;
                db[collection].insert({ value1: Date.now() });
                db[collection].insert({ value2: Date.now() });
              },
              params: { cn: collection.name() }
            });
          };

          let removeMulti = function() {
            let collection = pickCollection();
            db._executeTransaction({
              collections: { write: [collection.name()] },
              action: function(params) {
                let collection = params.cn, db = require("internal").db;
                if (db[collection].count() < 2) {
                  let k1 = db[collection].insert({});
                  let k2 = db[collection].insert({});
                  db[collection].remove(k1);
                  db[collection].remove(k2);
                  return;
                }
                db[collection].remove(db[collection].any());
                db[collection].remove(db[collection].any());
              },
              params: { cn: collection.name() }
            });
          };

          let removeInsert = function() {
            let collection = pickCollection();
            db._executeTransaction({
              collections: { write: [collection.name()] },
              action: function(params) {
                let collection = params.cn, db = require("internal").db;
                if (db[collection].count() === 0) {
                  db[collection].insert({ value: Date.now() });
                }
                db[collection].remove(db[collection].any());
                db[collection].insert({ value: Date.now() });
              },
              params: { cn: collection.name() }
            });
          };

          let insertRemove = function() {
            let collection = pickCollection();
            db._executeTransaction({
              collections: { write: [collection.name()] },
              action: function(params) {
                let collection = params.cn, db = require("internal").db;
                let k = db[collection].insert({ value: Date.now() });
                db[collection].remove(k);
              },
              params: { cn: collection.name() }
            });
          };

          let insertBatch = function() {
            let collection = pickCollection();
            db._executeTransaction({
              collections: { write: [collection.name()] },
              action: function(params) {
                let collection = params.cn, db = require("internal").db;
                for (let i = 0; i < 1000; ++i) {
                  db[collection].insert({ value1: Date.now() });
                }
              },
              params: { cn: collection.name() }
            });
          };

          let createCollection = function() {
            let name = "test" + internal.genRandomAlphaNumbers(16) + Date.now();
            return db._create(name);
          };

          let createEdgeCollection = function() {
            let name = "edge" + internal.genRandomAlphaNumbers(16) + Date.now();
            return db._createEdgeCollection(name);
          };

          let dropCollection = function() {
            let collection = pickCollection();
            db._drop(collection.name());
          };

          let renameCollection = function() {
            let name = internal.genRandomAlphaNumbers(16) + Date.now();
            let collection = pickCollection();
            collection.rename("fuchs" + name);
          };

          let changeCollection = function() {
            let collection = pickCollection();
            collection.properties({ waitForSync: false });
          };

          let truncateCollection = function() {
            let collection = pickCollection();
            collection.truncate({ compact: false });
          };

          let createIndex = function () {
            let name = internal.genRandomAlphaNumbers(16) + Date.now();
            let collection = pickCollection();
            collection.ensureIndex({
              type: Math.random() >= 0.5 ? "hash" : "skiplist",
              fields: [ name ],
              sparse: Math.random() > 0.5
            });
          };

          let dropIndex = function () {
            let collection = pickCollection();
            let indexes = collection.getIndexes();
            if (indexes.length > 1) {
              collection.dropIndex(indexes[1]);
            }
          };

          let createDatabase = function() {
            db._useDatabase('_system');
            let name = "test" + internal.genRandomAlphaNumbers(16) + Date.now();
            print("Creating " + name);
            return db._createDatabase(name);
          };

          let dropDatabase = function () {
            pickDatabase();
            let name = db._name();
            db._useDatabase('_system');
            print("dropping Database " + name)
            db._dropDatabase(name);
          };

          let ops = [
            { name: "insert", func: insert },
            { name: "insertOverwrite", func: insertOverwrite },
            { name: "remove", func: remove },
            { name: "replace", func: replace },
            { name: "update", func: update },
            { name: "insertEdge", func: insertEdge },
            { name: "insertOrReplace", func: insertOrReplace },
            { name: "insertOrUpdate", func: insertOrUpdate },
            { name: "insertMulti", func: insertMulti },
            { name: "removeMulti", func: removeMulti },
            { name: "removeInsert", func: removeInsert },
            { name: "insertRemove", func: insertRemove },
            { name: "insertBatch", func: insertBatch },
            { name: "createCollection", func: createCollection },
            { name: "dropCollection", func: dropCollection },
            { name: "changeCollection", func: changeCollection },
            { name: "truncateCollection", func: truncateCollection },
            { name: "createIndex", func: createIndex },
            { name: "dropIndex", func: dropIndex },
            { name: "createDatabase", func: createDatabase },
            { name: "dropDatabase", func: dropDatabase },
          ];
          if (!isCluster) {
            ops.push({ name: "renameCollection", func: renameCollection });
          }

          const jwtExist = options.hasOwnProperty('jwt1') && options.hasOwnProperty('jwt2')
          for (let i = 0; i < 3000; ++i) {
            pickDatabase();
            let op = ops[Math.floor(Math.random() * ops.length)];
            print(Date() + " - " + op.name);
            op.func();
            if (isCluster && jwtExist) {
              let leaderChecksum = getCollectionChecksum(leaderEndpoint, options.jwt1, '_system', '_users');
              let followerChecksum;
              let checksumCount = 0;
              while (leaderChecksum !== followerChecksum) {
                followerChecksum = getCollectionChecksum(followerEndpoint, options.jwt2, '_system', '_users');
                if (leaderChecksum !== followerChecksum) {
                  print('C');
                  if (checksumCount > 20) {
                    throw Exception("_users collection isn't getting in sync!")
                  }
                  internal.wait(1);
                  checksumCount += 1;
                }
              }
            }
          }
          if (isCluster) {
            for (let i = 0; i < 300; i++) {
              internal.sleep(1);
              print(".");
            }
          }
          let total = "";
          let databases = {};
          let dbNames = [];
          db._useDatabase('_system');

          db._databases().forEach(function(d) {
            if (d === '_system') {
              return;
            }
            dbNames.push(d);
            db._useDatabase(d);

            let colnames = [];

            db._collections().filter(function(c) { return c.name()[0] !== '_'; }).forEach(function(c) {
              colnames.push(c.name());
            });

            let sortNames = colnames.sort();

            let oneDB = '';
            sortNames.forEach(function(name) {
              oneDB += " " + name + "-" + db[name].count() + "-" + collectionChecksum(name);
              db[name].indexes().forEach(function(index) {
                delete index.selectivityEstimate;
                total += " " + index.type + "-" + JSON.stringify(index.fields);
              });
            });
            databases[d] = oneDB;
          });

          state.state = '';
          dbNames.sort().forEach(dbName => {
            state.state += ' ' + dbName + databases[dbName] + ' - ';
          });
        },

        function(state) {
          let total = "";
          let databases = {};
          let dbNames = [];
          db._useDatabase('_system');
          db._databases().forEach(function(d) {
            if (d === '_system') {
              return;
            }
            db._useDatabase(d);
            dbNames.push(d);
            db._useDatabase(d);

            let colnames = [];

            db._collections().filter(function(c) { return c.name()[0] !== '_'; }).forEach(function(c) {
              colnames.push(c.name());
            });

            let sortNames = colnames.sort();

            let oneDB = '';
            sortNames.forEach(function(name) {
              oneDB += " " + name + "-" + db[name].count() + "-" + collectionChecksum(name);
              db[name].indexes().forEach(function(index) {
                delete index.selectivityEstimate;
                total += " " + index.type + "-" + JSON.stringify(index.fields);
              });
            });
            databases[d] = oneDB;
          });

          total = '';
          dbNames.sort().forEach(dbName => {
            total += ' ' + dbName + databases[dbName] + ' - ';
          });

          const diff = (diffMe, diffBy) => diffMe.split(diffBy).join('');
          assertEqual(total, state.state, diff(total, state.state));
        }
      );
    }

  };
}

////////////////////////////////////////////////////////////////////////////////
/// @brief executes the test suite
////////////////////////////////////////////////////////////////////////////////

jsunity.run(ReplicationSuite);

return jsunity.done();
