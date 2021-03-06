var config = require('konphyg')(__dirname + '/../config');
var logger = require('nlogger').logger(module);
var nimble = require('nimble');
var util = require("util");
var path = require('path');
var fs = require('fs');

var env = (!process.env.NODE_ENV) ? "development" : process.env.NODE_ENV;
var wokCfg = config('workspace');

var Workspace = function(config, driver, callback) {
  this._ctags = {
    "start": null,
    "stop": null,
    "destroy": null
  };
  this._initialized = false;
  this._config = config;
  this._driver = driver;
  this.base_path = path.join(wokCfg.path, "workspace" + this._config.workspace);

  var obj = this;

  nimble.series([
    function(next_cb) {
      // Create workspace directory
      fs.exists(obj.base_path, function (exists) {
        if (exists) {
          next_cb();
          return;
        }

        fs.mkdir(obj.base_path, function(err) {
          if (err)
            callback(err);
          else
            next_cb();
        });
      });
    },
    function(next_cb) {
      // Create workspace config file
      var conf_file = path.join(obj.base_path, "config.json");
      fs.exists(conf_file, function (exists) {
        if (exists) {
          next_cb();
          return;
        }

        fs.writeFile(conf_file, JSON.stringify(obj._config), function (err) {
          if (err)
            callback(err);
          else
            next_cb();
        });
      });
    },
    function(next_cb) {
      // Create driver directory
      var driver_path = path.join(obj.base_path, obj._config.driver);
      fs.exists(driver_path, function (exists) {
        if (exists) {
          next_cb();
          return;
        }

        fs.mkdir(driver_path, function(err) {
          if (err)
            callback(err);
          else
            next_cb();
        });
      });
    }
  ], function() {
      driver.create(obj, function(err) {
        obj._initialized = (err == null);

        if (obj._initialized) {
          obj._attend = false;
          driver.on("stopped", function(workspace, name) {
            var rsp = {
              "workspace": workspace,
              "nodes": []
            }
            rsp["nodes"].push({
              "name": name,
              "state": "halted"
            });
            obj.emit("update", JSON.stringify(rsp));
          });
          driver.on("ip changed", function(workspace, name, eth, ip) {
            var iface = {
              "interface": eth,
              "ip": ip
            };

            var rsp = {
              "workspace": workspace,
              "nodes": []
            };

            rsp["nodes"].push({
              "name": name,
              "interfaces": [iface]
            });

            obj.emit("update", JSON.stringify(rsp));
          });
        }

        callback(err);
      });
  });
}

/**********************************************************/
/* This class is able to emit events.                     */
/* Next are the events emitted by this class:             */
/* -update:                                               */
/*    Emitted when there is any change in the workspace   */
/* -destroy:                                              */
/*    Emitted when the workspace is destroyed             */
/**********************************************************/

util.inherits(Workspace, require('events').EventEmitter);

Workspace.prototype.configureAMQP = function(connection) {
  if (!this._initialized) {
    callback("Workspace " + this._config.workspace + " is not initialized");
    return;
  }

  if (this._attend)
    return;

  this._initStartQueue(connection);
  this._initStopQueue(connection);
  this._initDestroyQueue(connection);

  this._attend = true;
}

Workspace.prototype.stopAMQP = function(connection) {
  if (!this._initialized) {
    callback("Workspace " + this._config.workspace + " is not initialized");
    return;
  }

  if (!this._attend)
    return;

  this._startQueue.unsubscribe(this._ctags["start"]);
  this._stopQueue.unsubscribe(this._ctags["stop"]);
  this._destroyQueue.unsubscribe(this._ctags["destroy"]);

  this._attend = false;
}

Workspace.prototype.getBaseDirectory = function() {
  return path.join(this.base_path, this._config.driver);
}

Workspace.prototype.getProperty = function(name) {
  return this._config[name];
}

Workspace.prototype._startVM = function(req, callback) {
  if (!req.workspace && !req.parameters) {
    callback("VMC protocol error");
    return;
  }

  var rsp = [];
  var count = 0;

  for (var i = 0; i < req.parameters.length; i++) {
    this._driver.startVM(this, req.parameters[i], function(config) {
      return function(err, port) {
        var node = {
          "name": config.name
        }

        if (err) {
          node["state"] = "halted";
          node["cause"] = err;
        } else {
          node["state"] = "started";
          node["port"] = port;
        }

        rsp.push(node);

        if (++count == req.parameters.length)
          callback(rsp);
      }
    }(req.parameters[i]));
  }
}

Workspace.prototype._stopVM = function(req) {
  if (!req.workspace && !req.parameters) {
    logger.error("VMC protocol error");
    return;
  }

  for (var i = 0; i < req.parameters.length; i++) {
    this._driver.stopVM(this, req.parameters[i], function(config) {
      return function(err) {
        if (err)
          logger.error("Node " + config.name + ": " + err);
      }
    }(req.parameters[i]));
  }
}

Workspace.prototype._initStartQueue = function(connection) {
  var workspace = this;

  // Configure start queue
  var name = 'workspace.' + env + "." + this._config.workspace.toString() +
                                                                    '.vm_start';
  this._startQueue = connection.queue(name, {durable: false, autoDelete: true},
                                                            function (queue) {
    queue.bind("");

    queue.on('queueBindOk', function() {
      logger.debug('Queue ' + queue.name + ' bound');
      queue.subscribe(function (msg, headers, deliveryInfo) {
        if (!workspace._attend) {
          console.log("TODO: this request must not be attended");
          return;
        }

        workspace._startVM(msg, function(nodes) {
          var rsp = {
            "workspace": workspace._config.workspace,
            "nodes": nodes
          }
          workspace.emit("update", JSON.stringify(rsp));
        });
      }).addCallback(function(ok) {
        workspace._ctags["start"] = ok.consumerTag;
      });
    });
  });
}

Workspace.prototype._initStopQueue = function(connection) {
  var workspace = this;

  // Configure stop queue
  var name = 'workspace.' + env + "." + this._config.workspace.toString() +
                                                                     '.vm_stop';
  this._stopQueue = connection.queue(name, {durable: false, autoDelete: true},
                                                            function (queue) {
    queue.bind("");

    queue.on('queueBindOk', function() {
      logger.debug('Queue ' + queue.name + ' bound');
      queue.subscribe(function (msg, headers, deliveryInfo) {
        if (!workspace._attend) {
          console.log("TODO: this request must not be attended");
          return;
        }

        workspace._stopVM(msg);
      }).addCallback(function(ok) {
        workspace._ctags["stop"] = ok.consumerTag;
      });
    });
  });
}

Workspace.prototype._initDestroyQueue = function(connection) {
  var workspace = this;

  // Configure destroy queue
  var name = 'workspace.' + env + "." + this._config.workspace.toString() +
                                                                     '.destroy';
  this._destroyQueue = connection.queue(name, {durable: false, autoDelete: true},
                                                            function (queue) {
    queue.bind("");

    queue.on('queueBindOk', function() {
      logger.debug('Queue ' + queue.name + ' bound');
      queue.subscribe(function (msg, headers, deliveryInfo) {
        if (!workspace._attend) {
          console.log("TODO: this request must not be attended");
          return;
        }

        workspace._driver.destroy(workspace, function(err) {
          if (err)
            logger.error(err);
          else
            rmdir(workspace.base_path, function(err) {
              var id = workspace._config.workspace.toString();

              if (err)
                logger.error("Can not destroy workspace" + id);
              else {
                logger.debug("Deleted workspace" + id);
                workspace.stopAMQP();
                workspace.emit("destroy");
              }
            });
        });
      }).addCallback(function(ok) {
        workspace._ctags["destroy"] = ok.consumerTag;
      });
    });
  });
}

module.exports = Workspace;

function recursiveRmdir(cfg, dirs, callback) {
  if (dirs.length == 0 && cfg.pending == 0) {
    while (cfg.rmdirs.length > 0) {
      cfg.pending++;
      fs.rmdir(cfg.rmdirs.pop(), function(err) {
        if (err)
          cfg.err = true;

        if (--cfg.pending == 0)
          callback(cfg.err);
      });
    }
    return;
  }

  while (dirs.length > 0) {
    var dir = dirs.pop();
    cfg.rmdirs.push(dir);
    cfg.pending++;
    fs.readdir(dir, function(dir) {
      return function(err, files) {
        cfg.pending--;

        if (err) {
          cfg.err = true;
          recursiveRmdir(cfg, dirs, callback);
        } else {
          for (var i = 0; i < files.length; i++) {
            var count = 0;
            var file = path.join(dir,files[i]);
            cfg.pending++;
            fs.stat(file, function(file) {
              return function(err, stats) {
                cfg.pending--;

                if (err) {
                  cfg.err = true;
                  return;
                }

                if (stats.isDirectory()) {
                  dirs.push(file);
                  if (++count == files.length)
                      recursiveRmdir(cfg, dirs, callback);
                } else {
                  cfg.pending++;
                  fs.unlink(file, function(err) {
                    cfg.pending--;
                    if (++count == files.length)
                      recursiveRmdir(cfg, dirs, callback);
                  });
                }
              }
            }(file));
          }
        }
      }
    }(dir));
  }
}

function rmdir(dir, callback) {
  recursiveRmdir({err: false, pending: 0, rmdirs: []}, [dir], callback);
}
