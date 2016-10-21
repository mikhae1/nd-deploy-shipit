/**
 * Sync given shipit enviroment to the origin
 */

var chalk = require('chalk');
var inquirer = require('inquirer');
var seq = require('nd-seq');
var utils = require('nd-utils');
var argv = require('yargs').argv;
var path = require('path');


module.exports = function(shipit) {
  shipit.task('sync', function(taskCallback) {
    // global init
    require('./init')(shipit);
    var lib = require('./lib')(shipit);

    argv = require('yargs')
      .usage('Usage: $0 sync [-f]')
      .boolean('f')
      .alias('f', 'force')
      .describe('f', 'Don\'t check server\'s current branch to be equal to the configured one')
      .help('h')
      .alias('h', 'help')
      .argv;

    if (shipit.config.remote.hasOwnProperty('targets')) {
      promptSelTasks(function(err, selTasks) {
        if (err) return taskCallback(err);
        return doTasks(prepareTargets(selTasks));
      });
    } else {
      var selTasks = {};
      selTasks[path.basename(shipit.config.remote.path)] = shipit.config.remote;

      return doTasks(prepareTargets(selTasks));
    }

    /**
     * All target's options are listed here..
     */
    function prepareTargets(selTasks) {
      var targets = {};
      for (var task in selTasks) {
        targets[task] = utils.copy(selTasks[task]);
        targets[task].branch = targets[task].branch || shipit.config.remote.branch || shipit.config.branch;
        targets[task].owner = targets[task].owner || shipit.config.remote.owner || shipit.config.owner;
        targets[task].openUrl = targets[task].openUrl || shipit.config.remote.openUrl;
        targets[task].migrateTask = targets[task].migrateTask || shipit.config.remote.migrateTask;
      }
      return targets;
    }

    function doTasks(targets) {

      seq(
        // target's unique
        targetLoop,

        // server's general
        confirmRestart,
        runRestartScript,
        showStatus,
        dovReport,
        taskCallback
      );

      function slog(text) {
        var args = Array.prototype.slice.call(arguments, 1);
        args.unshift(chalk.yellow(text));

        return function(next) {
          console.log.apply(console, args);
          next();
        };
      }

      function targetLoop(cb) {
        var tasks = [];
        for (var key in targets) {
          tasks.push(slog('Synchronizing ' + key + '...'));
          tasks.push(targetFactory(targets[key], key));
          tasks.push(slog('The ' + key + ' is synchronized with origin!'));
        }
        tasks.push(cb);

        seq.apply(seq, tasks);
      }

      function targetFactory(target, targetName) {
        return function(next) {
          var runMigrations = false;
          var runNpmInstall = false;
          var runEditConfig = false;
          var runReindex = false;
          var runFXMigrations = false;

          seq(
            checkBranch,
            resetDir,
            gitFetch,
            checkMigrations,
            checkFXMigrations,
            checkPackageJson,
            checkConfigSample,
            checkIndexes,
            confirmUpdate,
            changeCurBranch,
            gitSrvUpdate,
            npmInstall,
            runMigrateTask,
            //resetDir,
            showResults,
            next
          );

          function checkBranch(cb) {
            if (argv.f) {
              shipit.log('> skipping branch test');
              return cb(null);
            }

            shipit.log('> Checking git repo:');
            shipit.remote('cd ' + target.path + ' && git rev-parse --abbrev-ref HEAD', function(err, res) {
              if (err) return cb(err);

              for (var i = 0; i < res.length; i++) {
                if (res[i].stdout.trim() !== target.branch) {
                  shipit.log('Current branch is "' + res[i].stdout.trim() + '", but configured "' + target.branch + '"');
                  return cb(new Error('branchCheckFailed'));
                }
              }
              return cb(null);
            });
          }

          function resetDir(cb) {
            shipit.log('> Reseting directory rights: ');
            var resetCmd;
            if (shipit.config.remote.resetDirScript) {
              resetCmd = shipit.config.remote.resetDirScript;
            } else {
              resetCmd = 'sudo /usr/bin/chown -R ' + target.owner + ':' + target.owner + ' ' +
                target.path + ' && sudo /usr/bin/chmod -R g+w ' + target.path;
            }

            shipit.remote(resetCmd, function(err, res) {
              if (err) return cb(err);

              shipit.log('%s: dir %s reset to "%s:%s"', shipit.config.servers, target.path, target.owner, target.owner);
              return cb(null);
            });
          }

          function gitFetch(cb) {
            shipit.log('> Fetching updates: ');
            shipit.remote('cd ' + target.path +
              ' && git fetch', cb
            );
          }

          function checkMigrations(cb) {
            shipit.log('> Checking db migrations: ');
            var configName = 'config.json';
            var re = /(migrations\/.*\.(sql|js))/ig;

            shipit.mute();
            shipit.remote('cd ' + target.path +
              ' && git diff --name-only origin/' + target.branch,
              function(err, res) {
                shipit.unmute();

                if (err) return cb(err);

                if (!re.test(res[0].stdout)) {
                  shipit.log(chalk.dim('No migrations are found'));
                  return cb(null);
                }

                shipit.log(chalk.bgYellow('Migrations are found: ' + res[0].stdout.match(re).length + ' new'));
                runMigrations = true;

                var arr;
                var migrations = [];
                while ((arr = re.exec(res[0].stdout)) !== null) {
                  migrations.push(arr[0]);
                }

                for (var i = 0; i < migrations.length; i++) {
                  shipit.log('%s. %s', i + 1, migrations[i]);
                }

                shipit.remote('cd ' + target.path +
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

                    var cmd = 'mysql -h' + config.mysql.host + ' -u' + config.mysql.user + ' -p\'' + config.mysql.password + '\' ' + config.mysql.database;
                    shipit.log('You should run: ');
                    for (var i = 0; i < migrations.length; i++) {
                      shipit.log(cmd + ' < ' + migrations[i]);
                    }

                    return cb(null);
                  });
              });
          }

          function checkFXMigrations(cb) {
            shipit.log('> Checking fx migrations: ');
            var re = /(migrations\/flexible\/.*\.xml)/ig;

            shipit.mute();
            shipit.remote('cd ' + target.path +
              ' && git diff --name-only origin/' + target.branch,
              function(err, res) {
                shipit.unmute();

                if (err) return cb(err);

                if (!re.test(res[0].stdout)) {
                  shipit.log(chalk.dim('No fx migrations are found'));
                  return cb(null);
                }

                shipit.log(chalk.bgYellow('FX migrations are found: ' + res[0].stdout.match(re).length + ' new'));
                runFXMigrations = true;

                var arr;
                var migrations = [];
                while ((arr = re.exec(res[0].stdout)) !== null) {
                  migrations.push(arr[0]);
                }

                for (var i = 0; i < migrations.length; i++) {
                  shipit.log('%s. %s', i + 1, migrations[i]);
                }


                cb(null);
              });
          }

          function checkPackageJson(cb) {
            shipit.log('> Checking package.json changes: ');
            shipit.remote('cd ' + target.path +
              ' && git diff ..origin/' + target.branch + ' package.json | grep \'^+\'' +
              ' | awk \'!/package.json/\' | awk \'!/version/\'',
              function(err, res) {
                if (err) return cb(err);

                if (!res[0].stdout) {
                  shipit.log(chalk.dim('No new packages are found'));
                  return cb(null);
                }

                shipit.log(chalk.bgYellow('New packages are found!'));
                shipit.log('You should run "npm install" to install them!');
                runNpmInstall = true;
                return cb(null);
              });
          }

          function checkConfigSample(cb) {
            shipit.log('> Checking config file changes...');
            var configRe = /(config.(js|json)\.sample)/ig;
            shipit.mute();
            shipit.remote('cd ' + target.path + ' && ls', function(err, res) {
              shipit.unmute();

              if (err) return cb(err);

              if (!configRe.test(res[0].stdout)) {
                shipit.log('no config sample is found..');
                return cb(null);
              }

              var configName = res[0].stdout.match(configRe)[0];

              shipit.remote('cd ' + target.path +
                ' && git diff ..origin/' + target.branch + ' ' + configName,
                function(err, res) {
                  if (err) return cb(err);

                  if (!res[0].stdout) {
                    shipit.log(chalk.dim('No config changes are found'));
                    return cb(null);
                  }

                  // for easy copy/paste
                  console.log(res[0].stdout);

                  shipit.log(chalk.bgYellow('Config changes are found!'));
                  shipit.log('You should edit the config file!');
                  runEditConfig = true;

                  return cb(null);
                });
            });
          }

          function checkIndexes(cb) {
            shipit.log('> Checking changes in indexes.js...');
            var fnameRe = /(indexes.js)/ig;
            shipit.mute();
            shipit.remote('cd ' + target.path + ' && ls', function(err, res) {
              shipit.unmute();

              if (err) return cb(err);

              if (!fnameRe.test(res[0].stdout)) {
                shipit.log('indexes.js not found');
                return cb(null);
              }

              var fileName = res[0].stdout.match(fnameRe)[0];

              shipit.remote('cd ' + target.path +
                ' && git diff ..origin/' + target.branch + ' ' + fileName,
                function(err, res) {
                  if (err) return cb(err);

                  if (!res[0].stdout) {
                    shipit.log(chalk.dim('indexes.js changes not found'));
                    return cb(null);
                  }

                  shipit.log(chalk.bgYellow('indexes.js changes are found!'));
                  shipit.log('You should rebuild sphinx indexes');
                  runReindex = true;

                  return cb(null);
                });
            });
          }

          function confirmUpdate(cb) {
            shipit.log('> Files to be updated:');
            shipit.remote('cd ' + target.path +
              ' && git diff --color --name-status ..origin/' + target.branch,
              function(err, res) {
                if (err) return cb(err);

                if (runMigrations) {
                  if (target.migrateTask) {
                    shipit.log(chalk.bgRed('You should run task `migrate`!'));
                  } else {
                    shipit.log(chalk.bgRed('You should run the migrations!'));
                  }
                }

                if (runEditConfig) shipit.log(chalk.bgRed('You should edit the config file!'));
                if (runReindex) shipit.log(chalk.bgRed('You should rebuild Sphinx indexes'));
                if (runFXMigrations) shipit.log(chalk.bgRed('You should run task `migrate_flexible`!'));

                inquirer.prompt([{
                  type: 'confirm',
                  message: 'Do you want to update the ' + chalk.yellow(targetName) + ' ?',
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

          function changeCurBranch(cb) {
            if (!argv.f) return cb(null);

            shipit.log('> Changing current git branch: ');
            shipit.remote('cd ' + target.path +
              ' && git checkout ' + target.branch, cb);
          }

          function gitSrvUpdate(cb) {
            shipit.log('> Updating servers: ');
            shipit.remote('cd ' + target.path +
              ' && git reset --hard origin/' + target.branch,
              function(err, res) {
                if (err) return cb(err);

                shipit.log(chalk.green('The ') + chalk.yellow(targetName) + chalk.green(' is reset to "origin/' + target.branch + '"'));
                return cb(null);
              });
          }

          function npmInstall(cb) {
            if (runNpmInstall) shipit.log(chalk.red('New modules were found, you should run "npm intall"!'));

            inquirer.prompt([{
              type: 'confirm',
              message: 'Do you want to run npm install?',
              name: 'confirm',
              default: runNpmInstall
            }], function(ans) {
              if (!ans.confirm) return cb(null);
              shipit.remote('cd ' + target.path + ' && npm install', cb);
            });
          }

          function runMigrateTask(cb) {
            if (!(runMigrations && target.migrateTask)) return cb(null);

            var env = target.branch === 'master' ? 'production' : 'development';
            var ndPath = targets.hasOwnProperty('noodoo') ?
              targets.noodoo.path : path.join(target.path, '..', '..');
            var cmd = 'cd ' + ndPath + ' && NODE_ENV=' + env +
              ' node tasks ' + path.basename(target.path) + '/migrate';

            shipit.log('You should run: ');
            shipit.log(chalk.yellow(cmd));

            inquirer.prompt([{
              type: 'confirm',
              message: 'Do you want to run migrate task?',
              name: 'confirm',
              default: false
            }], function(ans) {
              if (!ans.confirm) return cb(null);
              shipit.remoteSingle(cmd, cb);
            });
          }

          function showResults(cb) {
            shipit.log('> Results: ');
            shipit.remote('cd ' + target.path +
              ' && echo "Git log:" && git log --color --oneline -n5' +
              ' && echo "\nLast changed files:" && git diff --color --name-status @{1}.. || true', cb);
          }
        };
      }

      function confirmRestart(cb) {
        inquirer.prompt([{
          type: 'confirm',
          message: 'Do you want to restart the servers?',
          name: 'confirm'
        }], function(ans) {
          if (!ans.confirm) {
            shipit.log('task was stopped by user');

            return dovReport(taskCallback);
          }
          return cb(null);
        });
      }

      function runRestartScript(cb) {
        shipit.log('> Restarting servers: ');

        var openUrls = [];
        for (var key in targets) {
          if (targets[key].openUrl) openUrls.push(targets[key].openUrl);
        }

        shipit.remoteOneByOne(shipit.config.remote.restartScript, {
            openUrls: openUrls
          },
          function(err, res) {
            if (err) return cb(err);

            shipit.log(chalk.green('All nodes from "%s" are restarted'), shipit.config.servers);

            // for (var key in targets) {
            //   console.log(targets[key]);
            //   if (targets[key].openUrl) open(targets[key].openUrl);
            // }
            return cb(null);
          });
      }

      function showStatus(cb) {
        shipit.log('> Server status: ');
        setTimeout(function() {
          shipit.remote(shipit.config.remote.showStatusScript, cb);
        }, 2000);
      }

      function dovReport(cb) {
        var tasks = [];
        for (var key in targets) {
          tasks.push(reportFactory(targets[key], key));
        }
        tasks.push(cb);
        seq.apply(seq, tasks);

        function reportFactory(target, targetName) {
          return function(next) {
            shipit.log('> Checking release');
            var tagRe = /v(\d+.\d+.\d+)$/i;
            shipit.remote('cd ' + target.path + ' && git describe --tags', function(err, res) {
              if (err) return next(null);

              if (!tagRe.test(res[0].stdout.trim())) return next(null);

              shipit.log('release is found!');
              var tag = res[0].stdout.trim().match(tagRe)[1];

              shipit.mute();
              shipit.remote('cd ' + target.path + ' && cat ./CHANGELOG.md', function(err, res) {
                shipit.unmute();

                if (err) return next(err);

                var data = res[0].stdout.trim();
                var lines = data.split('\n');
                var block = [];
                var count = 0;

                for (var i = 0; i < lines.length; i++) {
                  if (lines[i].indexOf('##') === 0) count++;
                  if (count === 2) block.push(lines[i]);
                  if (count === 3) break;
                }
                block.splice(0, 1);

                console.log('<b>Версия ' + tag + ' для ' + targetName + ' собрана и установлена на PROD.</b>');
                console.log('Список изменений:');
                block.forEach(function(line) {
                  if (line && line.trim() !== '') console.log(line);
                });
                return next(null);
              });
            });
          };
        }
      }
    }

    function promptSelTasks(cb) {
      var prompts = [];
      var choices;
      var config = shipit.config.remote;

      // get remote dirs for the recursive tasks first
      var tasks = {};
      for (var id in config.targets) {
        if (config.targets[id].recursive) {
          tasks[id] = remoteDirsFac(config.targets[id].path);
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
        choices = [];
        for (var id in config.targets) {
          if (config.targets[id].recursive) {
            for (var i = 0; i < childDirs[id].length; i++) {
              choices.push({
                name: id + '/' + childDirs[id][i],
                checked: false
              });
            }
          } else {
            choices.push({
              name: id,
              checked: false
            });
          }
          choices.push(new inquirer.Separator());
        }
        choices.pop(); // last separator

        prompts.push({
          type: 'checkbox',
          message: 'Select target to update: ',
          name: 'tasks',
          choices: choices,
        });

        inquirer.prompt(prompts, function(res) {
          var selTasks = {};
          var count = 0;
          var rtaskId, dirname;

          for (var taskId in res) {
            if (!res.hasOwnProperty(taskId)) continue;

            for (var i = 0; i < res[taskId].length; i++) {
              count++;
              if (config.targets[res[taskId][i]]) {
                selTasks[res[taskId][i]] = config.targets[res[taskId][i]];
              } else {
                rtaskId = res[taskId][i].split('/')[0];
                dirname = res[taskId][i].split('/')[1];
                selTasks[res[taskId][i]] = utils.copy(config.targets[rtaskId]);
                selTasks[res[taskId][i]].path = path.join(selTasks[res[taskId][i]].path, dirname);
              }
            }
          }

          if (count === 0) return cb('You must choose at least one task to continue');

          return cb(null, selTasks);
        });
      }
    }
  });
};
