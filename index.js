var logger = require('nlogger').logger(module);
var nimble = require('nimble');
var path = require('path');
var fs = require('fs');

var daemon_info = JSON.parse(fs.readFileSync('package.json', 'utf8'))

var drivers = {};
var driverinfo = {};
var exiting = false;
var driver_count = 0;

function shutdown() {
  var count = 0;
  exiting = true;

  logger.info("Stop plugins.");
  for (var driver in drivers)
    if (driver.running)
      driver.stop(function(err) {
        if (err)
          logger.error(err);

        if (++count == driver_count)
          logger.info('All plugin have been stopped.');
      });
    else if (++count == driver_count)
      logger.info('All plugin have been stopped.');
}

logger.info('Daemon ', daemon_info.name, ' version ',
  daemon_info.version, ' starting.');

nimble.series([
  function(callback) {
    logger.info("Install signal handlers.");

    process.on('SIGINT', function() {
      logger.debug('Got a SIGINT');
      shutdown();
    });

    process.on('SIGHUP', function() {
      logger.debug('Got a SIGHUP');
      shutdown();
    });

    process.on('exit', function () {
      logger.info('Daemon ', daemon_info.name, ' exit.');
    });

    callback();
  },
  function(callback) {
    if (exiting) {
      logger.debug("Skipping drivers loading.");
      callabck();
    }

    logger.info("Load drivers.");
    var driver_dir = path.join(__dirname, "lib", "drivers");

    fs.readdir(driver_dir, function(err, files) {
      if (err) {
        logger.error(err);
        throw err;
      }

      var count = 0;
      for (var i = 0; i < files.length; i++) {
        var module_dir = path.join(driver_dir, files[i]);
        fs.readFile(path.join(module_dir, 'package.json'), 'utf8',
          function(err, data) {
            if (err)
              logger.error(err);
            else {
              try {
                var info = JSON.parse(data);
                var Driver = require(module_dir);

                if (!info.name) {
                  logger.warn("Missing name driver ", module_dir);
                  return
                }

                logger.debug("Found driver:\n", data);
                drivers[info.name] = new Driver;
                driverinfo[info.name] = data;
                driver_count++;
              } catch (err) {
                logger.error(err);
              }
            }

            if (++count == files.length)
              callback();
        });
      }
    });
  },
  function(callback) {
    if (exiting) {
      logger.debug("Skipping drivers initialization.");
      callabck();
    }

    logger.info("Start drivers.");
    var count = 0;
    for (var driver in drivers)
      drivers[driver].start(function(err) {
        if (err)
          logger.error(err);
        else if (exiting)
          drivers[driver].stop(function(err) {
            if (err)
              logger.error(err);
          });

        if (++count == driver_count)
          callback();
      });
  }
], function() {
  logger.info('Daemon ', daemon_info.name, ' is now running.');
});
