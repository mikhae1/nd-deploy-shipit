/**
 * Rollback for the update task
 * It will find previous release and will install it
 */

var path = require('path');
var inquirer = require('inquirer');
var argv = require('yargs').argv;
var chalk = require('chalk');
var seq = require('nd-seq');

module.exports = function(shipit) {
  shipit.task('rollback', function(taskCallback) {
    // global init
    require('./init')(shipit);
    var lib = require('./lib')(shipit);

    // task init
    var config = shipit.config.remote.update;
    var lastWorkedPath = path.join(config.path.releases, 'last-worked');
    var logPath = path.join(__dirname, './rollback.log');
    var releasePath;
    var prevPath;

    shipit.enableLog(logPath);
    shipit.on('task_stop', sendLog);
    shipit.on('task_err', sendLog);

    seq(
      readCur,
      findPrev,
      confirmRollback,
      setLastWorked,
      rollback,
      checkCur,
      confirmRestart,
      runRestartScript,
      taskCallback
    );

    function readCur(cb) {
      shipit.remote('readlink ' + config.path.current.replace(/\/$/, ''), function(err, res) {
        if (err) {
          shipit.log('Can\'t find current release dir :(');
          return cb(err);
        }

        releasePath = res[0].stdout.trim();
        shipit.log(chalk.green('> Found current release: ', releasePath));
        return cb();
      });
    }

    function findPrev(cb) {
      shipit.log('> Reading aviable releases...');
      lib.getRemoteDirs(config.path.releases, function(err, dirs) {
        if (err) return cb(err);

        var releaseRe = /\w+-[\d\d\.]+-(\d+)/;
        var filtered = dirs.filter(function(val) {
          return releaseRe.test(val);
        });

        var sorted = filtered.sort(function(a, b) {
          return parseInt(parseInt(a.match(releaseRe)[1] - b.match(releaseRe)[1]));
        });

        var rindex = sorted.indexOf(path.basename(releasePath));
        if (rindex !== -1) {
          if (rindex !== 0) {
            prevPath = path.join(config.path.releases, sorted[rindex - 1]);
            shipit.log(chalk.green('> Found previous release: ' + prevPath));
            return cb();
          } else {
            shipit.log(chalk.bgRed('Current release is the oldest one!'));
            return taskCallback();
          }
        } else {
          return cb('Can\'t find current release in ' + config.path.releases);
        }
      });
    }

    function confirmRollback(cb) {
      var tasks = [];

      lib.getAllTasks(function(err, allTasks) {
        if (err) return cb(err);

        for (var id in allTasks) {
          if (!allTasks.hasOwnProperty(id)) continue;

          tasks.push(shipit.remoteFactory('cd ' + path.join(prevPath, allTasks[id].path) +
            ' && git log --pretty=format:\"%h %ad | %s%d [%an]\" --graph --date=short -n5',
            'git log for ' + path.basename(prevPath) + ':' + id));
        }

        tasks.push(confirm);
        tasks.push(cb);
        seq.apply(this, tasks);

        function confirm(cb) {
          inquirer.prompt([{
            type: 'confirm',
            message: 'Do you want to rollback?',
            name: 'confirm'
          }], function(ans) {
            if (!ans.confirm) {
              shipit.log('task was stopped by user');
              return taskCallback();
            }
            return cb(null);
          });
        }
      });
    }

    function setLastWorked(cb) {
      shipit.log('> Saving link to current working app...');
      var curPath;
      // `` don't work in shpit.remote
      shipit.remote('readlink ' + config.path.current.replace(/\/$/, ''), function(err, res) {
        if (err) return cb(err);
        curPath = res[0].stdout.trim();
        shipit.remote('ln -nfs ' + curPath + ' ' + lastWorkedPath.replace(/\/$/, ''), cb);
      });
    }

    function rollback(cb) {
      shipit.log('> Starting rollback');
      shipit.remote('ln -nfs ' + prevPath + ' ' + config.path.current.replace(/\/$/, ''), cb);
    }

    function checkCur(cb) {
      shipit.remote('readlink ' + config.path.current.replace(/\/$/, ''), function(err, res) {
        if (err) return cb(err);

        releasePath = res[0].stdout.trim(); // save for sendLog
        if (releasePath !== prevPath) {
          return cb('current release don\'t changed');
        } else {
          shipit.log(chalk.green('> ' + releasePath + ' is set as current'));
          return cb();
        }
      });
    }

    function confirmRestart(cb) {
      inquirer.prompt([{
        type: 'confirm',
        message: 'Do you want to restart the servers?',
        name: 'confirm'
      }], function(ans) {
        if (!ans.confirm) {
          shipit.log('task was stopped by user');
          return taskCallback();
        }
        return cb();
      });
    }

    function runRestartScript(cb) {
      shipit.log('Restarting servers: ');
      shipit.remoteOneByOne(shipit.config.remote.restartScript,
        function(err, res) {
          if (err) return cb(err);

          shipit.log(chalk.green('All nodes from ' + shipit.config.servers + ' were restarted'));
          return cb(null);
        });
    }

    ///////////////////////

    function sendLog() {
      shipit.log('> Sending log to remote host..');
      var dst = releasePath;

      var tasks = [];
      for (var i = 0; i < shipit.config.servers.length; i++) {
        tasks.push(shipit.localFactory(
          'scp ' + logPath + ' ' + shipit.config.servers[i] + ':' + dst));
      }

      seq.apply(this, tasks, function(err) {
        if (err) {
          shipit.log('Can\'t send logfile!', logPath);
        }
      });
    }
  });
};
