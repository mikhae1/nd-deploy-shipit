/**
 * Update given target in shipit enviroment with release history
 * See also rollback task
 */

var seq = require('nd-seq');
var utils = require('nd-utils');
var chalk = require('chalk');
var inquirer = require('inquirer');
var path = require('path');
var argv = require('yargs').argv;

module.exports = function(shipit) {
  shipit.task('update', function(taskCallback) {
    // global init
    require('./init')(shipit);
    var lib = require('./lib')(shipit);

    // task init
    var config = shipit.config.remote.update;
    var startUpdatePath = path.join(config.path.releases, 'current-update');
    var lastWorkedPath = path.join(config.path.releases, 'last-worked');
    var releasePath = path.join(config.path.releases, taskUid());
    var logPath = path.join(__dirname, './update.log');
    var needFallback = false;
    var runMigrations = false;

    argv = require('yargs')
      .usage('Usage: $0 update -t "target1 [target2] ..."')
      // .demand(['t'])
      .help('h')
      .alias('h', 'help')
      .argv;

    if (argv.t) {
      cmdSelTasks(function(err, selTasks) {
        if (err) return taskCallback(err);
        return doTasks(selTasks);
      });
    } else {
      promptSelTasks(function(err, selTasks) {
        if (err) return taskCallback(err);
        return doTasks(selTasks);
      });
    }

    function doTasks(selTasks) {
      shipit.enableLog(logPath);
      shipit.on('task_stop', sendLog);
      shipit.on('task_err', sendLog);
      seq(
        resetDir,
        copy,
        saveHead,
        update,
        checkMigrations,
        confirmUpdateRelease,
        setLastWorked,
        setCurRelease,
        confirmRestart,
        runRestartScript,
        showStatus,
        cleanOldReleases,
        function(err) {
          if (err) {
            if (needFallback) {
              shipit.log(chalk.bgRed('Warning: Current release is changed!'));
              shipit.log('To rollback run: ln -nfs `readlink ' + lastWorkedPath + '` ' + config.path.current.replace(/\/$/, ''));
            }
            return taskCallback(err);
          }
          return taskCallback();
        });

      ////////////////////

      function resetDir(cb) {
        if (!shipit.config.remote.owner) return cb(null);

        shipit.log('> Reseting directory rights: ');
        var resetCmd;
        if (shipit.config.remote.resetDirScript) {
          resetCmd = shipit.config.remote.resetDirScript;
        } else {
          resetCmd = 'sudo /usr/bin/chown -R ' + shipit.config.remote.owner + ':' + shipit.config.remote.owner + ' ' + shipit.config.remote.path +
            ' && sudo /usr/bin/chmod -R g+w ' + shipit.config.remote.path;
        }

        shipit.remote(resetCmd, function(err, res) {
          if (err) return cb(err);

          shipit.log('%s: dir is reseted to "%s:%s"', shipit.config.servers, shipit.config.remote.owner, shipit.config.remote.owner);
          return cb(null);
        });
      }

      function copy(cb) {
        shipit.log('> Copying current release...');
        var cmdCheckDir = [
          'if [[ -d "' + startUpdatePath + '" ]] ; then',
          'echo "Previous failed update is found. Removing it..."',
          'rm -Rf ' + startUpdatePath,
          'fi',
          'cp -r --preserve=links ' + config.path.current + '/ ' + startUpdatePath,
          'rm -f ' + path.join(startUpdatePath, '*.log')
        ].join('\n');

        shipit.remote(cmdCheckDir, cb);
      }

      function saveHead(cb) {
        shipit.log('> Saving current reflogs...');
        var tasks = {};
        for (var id in selTasks) {
          if (!selTasks.hasOwnProperty(id)) continue;
          tasks[id] = shipit.remoteFactory('cd ' + path.join(startUpdatePath, selTasks[id].path) + ' && git rev-parse HEAD');
        }

        seq(tasks, function(err, res) {
          if (err) return cb(err);

          for (var id in res) {
            if (!res.hasOwnProperty(id)) continue;
            selTasks[id].oldHead = res[id][0].stdout.trim();
          }
          return cb(null);
        });
      }

      function update(cb) {
        shipit.log('> Installing updates...');
        var branch, cmd;
        var tasks = [];
        for (var id in selTasks) {
          if (!selTasks.hasOwnProperty(id)) continue;
          if (selTasks[id].branch) {
            branch = selTasks[id].branch;
          } else {
            branch = '';
          }

          cmd = [
            'cd ' + path.join(startUpdatePath, selTasks[id].path) + ' && ',
            'git fetch' + ' && ',
            'git checkout ' + branch + ' && ',
            'git reset --hard origin/' + branch,
          ].join('\n');
          tasks.push(shipit.remoteFactory(cmd, id + '/git pull'));

          cmd = [
            'cd ' + path.join(startUpdatePath, selTasks[id].path) + ' && ',
            'npm install' + ' && ',
            'git diff --name-status ' + selTasks[id].oldHead + '..'
          ].join('\n');
          tasks.push(shipit.remoteFactory(cmd, id + '/npm install'));

        }
        tasks.push(cb);
        seq.apply(this, tasks);
      }

      function checkMigrations(cb) {
        shipit.log('> Checking the migrations: ');
        var counter = 0;
        for (var id in selTasks) {
          if (!selTasks.hasOwnProperty(id)) continue;
          counter++;
          shipit.log(' ..checking for "%s"', id);
          checker(selTasks[id], function(err, res) {
            if (err) shipit.log(err); // don't stop on error
            counter--;
            if (counter === 0) {
              return cb(null);
            }
          });
        }

        function checker(task, cb) {
          var configName = 'config.json';
          var re = /(migrations\/.*\.(sql|js))/ig;
          shipit.remote('cd ' + path.join(startUpdatePath, task.path) + ' && git diff --name-status ' + task.oldHead + '..',
            function(err, res) {
              if (err) return cb(err);

              if (!re.test(res[0].stdout)) {
                shipit.log('No migrations found');
                return cb(null);
              }

              shipit.log(chalk.inverse('Migrations are found!'));
              runMigrations = true;
              shipit.log('Migrations: ', chalk.bold(res[0].stdout.match(re).join(', ')));
              var arr;
              var migrations = [];
              while ((arr = re.exec(res[0].stdout)) !== null) {
                migrations.push(arr[0]);
              }

              shipit.remote('cd ' + shipit.config.remote.path +
                ' && cat ./' + configName,
                function(err, res) {
                  if (err) {
                    shipit.log('config not found');
                    return cb(null);
                  }

                  shipit.log('Parsing config: ');
                  var config;
                  try {
                    config = JSON.parse(res[0].stdout);
                  } catch (e) {
                    shipit.log(e);
                    return cb('Can\'t parse the ' + configName);
                  }
                  shipit.log('OK!');

                  var cmd = 'mysql -h' + config.mysql.host + ' -u' + config.mysql.user + ' -p\'' + config.mysql.password + '\' ' + config.mysql.database;
                  shipit.log('You should run: ');
                  for (var i = 0; i < migrations.length; i++) {
                    shipit.log(chalk.red(cmd + ' < ' + migrations[i]));
                  }

                  return cb(null);
                });
            });
        }
      }

      function confirmUpdateRelease(cb) {
        var tasks = [];
        for (var id in selTasks) {
          if (!selTasks.hasOwnProperty(id)) continue;

          tasks.push(shipit.remoteFactory('cd ' + path.join(startUpdatePath, selTasks[id].path) +
            ' && git log --oneline -n5', 'git log for ' + id + ':'));
        }

        tasks.push(confirm);
        tasks.push(cb);
        seq.apply(this, tasks);

        function confirm(cb) {
          if (runMigrations) shipit.log(chalk.red('You should run the migrations!'));
          inquirer.prompt([{
            type: 'confirm',
            message: 'Do you want to set this release as current (install it)?',
            name: 'confirm'
          }], function(ans) {
            if (!ans.confirm) {
              shipit.log('task was stopped by user');
              return taskCallback();
            }
            return cb(null);
          });
        }
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

      function setCurRelease(cb) {
        shipit.log('> Linking the new release as current...');
        seq(
          shipit.remoteFactory('mv ' + startUpdatePath + ' ' + releasePath),
          shipit.remoteFactory('ln -nfs ' + releasePath + ' ' + config.path.current.replace(/\/$/, '')),
          function(err, result) {
            if (err) return cb(err);

            needFallback = true;
            return cb(null);
          });
      }

      function cleanOldReleases(cb) {
        shipit.log('> Keeping "%d" last releases, cleaning others', shipit.config.keepReleases);
        lib.getRemoteDirs(config.path.releases, function(err, dirs) {
          if (err && err !== 'unsynced') return cb(err);

          var releaseRe = /\w+-[\d\d\.]+-(\d+)/;
          var filtered = dirs.filter(function(val) {
            return releaseRe.test(val);
          });

          if (filtered.length <= shipit.config.keepReleases) return cb(null);

          var sorted = filtered.sort(function(a, b) {
            // reverse order
            return parseInt(b.match(releaseRe)[1]) - parseInt(a.match(releaseRe)[1]);
          });

          var tasks = [];
          sorted.slice(shipit.config.keepReleases, sorted.length).forEach(function(dirname) {
            tasks.push(shipit.remoteFactory('rm -Rf ' + path.join(config.path.releases, dirname)));
          });
          seq(tasks, function(err) {
            if (err) shipit.log(err);
            return cb(null);
          });
        });
      }

      function confirmRestart(cb) {
        shipit.remote('readlink ' + config.path.current.replace(/\/$/, ''), function(err, res) {
          if (err) return cb(err);
          if (res[0].stdout.trim() !== releasePath) return cb('current release don\'t changed');

          inquirer.prompt([{
            type: 'confirm',
            message: 'Do you want to restart the servers?',
            name: 'confirm'
          }], function(ans) {
            if (!ans.confirm) {
              shipit.log('task was stopped by user');
              return taskCallback();
            }
            return cb(null);
          });
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

      function showStatus(cb) {
        shipit.log(chalk.yellow('Server status: '));
        setTimeout(function() {
          shipit.remote(shipit.config.remote.showStatusScript, cb);
        }, 2000);
      }
    }

    ////////////////////

    function promptSelTasks(cb) {
      var prompts = [];
      var choices;

      // get remote dirs for the recursive tasks first
      var tasks = {};
      for (var id in config.targets) {
        if (config.targets[id].recursive) {
          tasks[id] = remoteDirsFac(path.join(config.path.current, config.targets[id].path));
        }
      }

      function remoteDirsFac(remotePath) {
        return function(cb) {
          lib.getRemoteDirs(remotePath, function(err, childDirs) {
            if (err) return cb(err);
            return cb(null, childDirs);
          });
        };
      }

      seq(tasks, function(err, childDirs) {
        if (err) return cb(err);
        selTasks(childDirs);
      });

      function selTasks(childDirs) {
        for (var id in config.targets) {
          choices = [];
          if (config.targets[id].recursive) {
            for (var i = 0; i < childDirs[id].length; i++) {
              choices.push({
                name: childDirs[id][i],
                checked: true
              });
            }
          } else {
            choices.push({
              name: id,
              checked: true
            });
          }
          prompts.push({
            type: 'checkbox',
            message: 'Select updagate tasks for: ' + (config.targets[id].description || '') + ' [' + config.targets[id].path + ']',
            name: id,
            choices: choices
          });
        }

        inquirer.prompt(prompts, function(res) {
          var selTasks = {};
          var emptyFlag = true;
          var rtaskId;
          // resolve recursive tasks
          for (var taskId in res) {
            if (!res.hasOwnProperty(taskId)) continue;

            if (res[taskId].length > 0) {
              emptyFlag = false;
              if (!config.targets[taskId].recursive) {
                selTasks[taskId] = config.targets[taskId];
              } else {
                res[taskId].forEach(function(dirname) {
                  rtaskId = taskId + '/' + dirname;
                  selTasks[rtaskId] = utils.copy(config.targets[taskId]);
                  selTasks[rtaskId].path = path.join(selTasks[rtaskId].path, dirname);
                });
              }
            }
          }
          if (emptyFlag) return cb('You must choose at least one task to continue');
          return cb(null, selTasks);
        });
      }
    }

    function cmdSelTasks(cb) {
      var rtaskId, childDirs, cmds;
      var params = argv.t;

      if (params.indexOf(' ') > 0) {
        cmds = params.split(' ');
      } else {
        cmds = [params];
      }

      resolveTasks(function(err, allTasks) {
        if (err) return cb(err);

        var selTasks = {};
        cmds.forEach(function(cmd) {
          if (allTasks.hasOwnProperty(cmd)) {
            selTasks[cmd] = allTasks[cmd];
          } else {
            if (config.targets.hasOwnProperty(cmd) && config.targets[cmd].recursive) {
              for (var id in allTasks) {
                if (allTasks[id]._parentId === cmd) {
                  selTasks[id] = allTasks[id];
                  delete allTasks[id]._parentId;
                }
              }
            } else {
              return cb('unknown option: ' + cmd);
            }
          }
        });

        return cb(null, selTasks);
      });

      function resolveTasks(cb) {
        var count = 0;
        var allTasks = {};
        // resolve recursive targets
        for (var n in config.targets) {
          if (!config.targets.hasOwnProperty(n)) return;

          if (config.targets[n].recursive) {
            count++;
            lib.getRemoteDirs(config.path.current, function(err, childDirs) {
              if (err) return cb(err);

              count--;
              childDirs.forEach(function(dirname) {
                rtaskId = n + '/' + dirname;
                allTasks[rtaskId] = utils.copy(config.targets[n]);
                allTasks[rtaskId].path = path.join(config.targets[n].path, dirname);
                allTasks[rtaskId]._parentId = n;
              });
            });
          } else {
            allTasks[n] = config.targets[n];
          }
        }

        if (count === 0) {
          return cb(null, allTasks);
        }
      }
    }

    function sendLog() {
      shipit.log('> Sending log to remote host..');
      var dst;
      if (!needFallback) {
        dst = startUpdatePath;
      } else {
        dst = releasePath;
      }

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

    function taskUid() {
      return 'release-' + uidSuffix();

      function uidSuffix() {
        var d = new Date(),
          uid = d.valueOf(),
          mydt = ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + '.' + d.getFullYear();
        return mydt + '-' + uid;
      }
    }
  });
};
