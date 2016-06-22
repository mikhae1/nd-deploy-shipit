var gulp = require('gulp');
var path = require('path');
var fs = require('fs');
var inquirer = require('inquirer');
var exec = require('child_process').exec;
var seq = require('nd-seq');
var utils = require('nd-utils');
var argv = process.argv;


var config;
if (fs.existsSync('./deploy.json')) {
  config = require('./deploy.json');
} else if (fs.existsSync('../deploy.json')) {
  config = require('./deploy.json');
} else {
  console.error('Can\'t find "deploy.json" file');
  process.exit(1);
}

var startUpdateDir = path.join(config.path.releases, 'current-update');
var lastWorkedDir = path.join(config.path.releases, 'last-worked');


gulp.task('default', ['update']);


/**
 * This task provides two interfaces: 
 *   1) no arguments: menu with checkboxes
 *   2) '-c' argument: command line interface
 */
gulp.task('update', function(gulpCallback) {
  if (argv.length > 2 && argv.indexOf('-c') !== -1) {
    parseCmdLine(function(err, selTasks) {
      if (err) return execError(err);
      return doTasks(selTasks);
    });
  } else if (argv.indexOf('-h') !== -1 || argv.indexOf('--help') !== -1) {
    console.log('Usage: -c "node1[/subdir1] [node2/[subdir2]]...[nodeX/[subdirX]]"');
    console.log();
    return gulpCallback();
  } else {
    selectTasks(function(err, selTasks) {
      if (err) return execError(err);
      return doTasks(selTasks);
    });
  }

  function doTasks(selTasks) {
    enableLog(config.path.log);
    colorPrint('Selected tasks: "' + Object.keys(selTasks).join(' ') + '"', 'dim');
    var needFallback = false;

    seq(
      copy,
      update,
      changeLastWorked,
      changeCurRelease,
      removeOldCopies,
      restartServer,
      function(err) {
        if (err) {
          if (needFallback) {
            colorPrint('You should perform rollback to last working release. Don\'t run update task ' +
              'before you rollback to pervious configuration!', 'fgRed');
            colorPrint('To rollback make: ln -sf `readlink ' + lastWorkedDir + '` ' + config.path.app.replace(/\/$/, ''), 'fgRed');
          }
          return execError(err);
        }
        return gulpCallback();
      });

    function copy(cb) {
      console.log('Copying current app...');
      var tasks = [];
      if (fs.existsSync(startUpdateDir)) {
        console.log('Previous failed update found. Removing it...');
        tasks.push(cmdFactory('rm -Rf ' + startUpdateDir));
      }
      tasks.push(cmdFactory('cp -R ' + config.path.app + '/ ' + startUpdateDir));
      tasks.push(cb);
      seq.apply(this, tasks);
    }

    function update(cb) {
      console.log('Starting updates...');
      var tasks = [];
      for (var id in selTasks) {
        if (!selTasks.hasOwnProperty(id)) continue;

        tasks.push(cmdFactory('git pull && npm install', path.join(startUpdateDir, selTasks[id].path), 'updating ' + id));
      }
      tasks.push(cb);
      seq.apply(this, tasks);
    }

    function changeLastWorked(cb) {
      console.log('Saving link to current working app...');
      cmdFactory('rm -Rf ' + lastWorkedDir + ' && ln -s `readlink ' + config.path.app.replace(/\/$/, '') + '` ' + lastWorkedDir)(cb);
    }

    function changeCurRelease(cb) {
      console.log('Linking new release as current...');
      var curUpdateDir = path.join(config.path.releases, taskUid().get());
      seq(
        cmdFactory('mv ' + startUpdateDir + ' ' + curUpdateDir),
        cmdFactory('rm -R ' + config.path.app.replace(/\/$/, '') + ' && ln -s ' + curUpdateDir + ' ' + config.path.app.replace(/\/$/, '')),
        function(err, result) {
          if (err) return cb(err);

          needFallback = true;
          return cb(null);
        });
    }

    function removeOldCopies(cb) {
      console.log('Removing old copies...');
      var allDirs = getDirsSync(config.path.releases);
      var dirRegexp = /\w+-[\d\d\.]+-(\d+)/;

      var filtered = allDirs.filter(function(val) {
        return dirRegexp.test(val);
      });

      if (filtered.length <= config.maxBackups) return cb(null);

      var sorted = filtered.sort(function(a, b) {
        // reverse order
        return parseInt(b.match(dirRegexp)[1]) - parseInt(a.match(dirRegexp)[1]);
      });

      var tasks = [];
      sorted.slice(config.maxBackups, sorted.length).forEach(function(dirname) {
        tasks.push(cmdFactory('rm -Rf ' + path.join(config.path.releases, dirname)));
      });

      tasks.push(cb);
      seq.apply(this, tasks);
    }

    function restartServer(cb) {
      if (config.path.hasOwnProperty('restartScript')) {
        console.log('Running server restart script...');
        cmdFactory(config.path.restartScript, path.dirname(config.path.restartScript))(cb);
      } else {
        console.log('No server restart script found...');
        return cb(null);
      }
    }
  }

});

function parseCmdLine(cb) {
  var rtaskId, childDirs, cmds;
  var params = argv[argv.indexOf('-c') + 1];
  if (typeof params == 'string' && params.length > 0) {
    cmds = params.split(' ');
  }
  if (!cmds) return cb('unknown options: ' + params);

  var allTasks = {};
  // resolve recursive nodes
  for (var n in config.nodes) {
    if (!config.nodes.hasOwnProperty(n)) return;

    if (config.nodes[n].recursive) {
      childDirs = getDirsSync(path.join(config.path.app, config.nodes[n].path));
      childDirs.forEach(function(dirname) {
        rtaskId = n + '/' + dirname;
        allTasks[rtaskId] = utils.copy(config.nodes[n]);
        allTasks[rtaskId].path = path.join(config.nodes[n].path, dirname);
        allTasks[rtaskId]._parentId = n;
      });
    } else {
      allTasks[n] = config.nodes[n];
    }
  }

  var selTasks = {};
  cmds.forEach(function(cmd) {
    if (allTasks.hasOwnProperty(cmd)) {
      selTasks[cmd] = allTasks[cmd];
    } else {
      if (config.nodes.hasOwnProperty(cmd) && config.nodes[cmd].recursive) {
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
}

function selectTasks(cb) {
  var prompts = [];
  var choices, childDirs;

  for (var id in config.nodes) {
    if (!config.nodes.hasOwnProperty(id)) continue;

    choices = [];
    if (config.nodes[id].recursive) {
      childDirs = getDirsSync(path.join(config.path.app, config.nodes[id].path));
      for (var i = 0; i < childDirs.length; i++) {
        choices.push({
          name: childDirs[i],
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
      message: 'Select updagate tasks for: ' + (config.nodes[id].description || '') + ' [' + config.nodes[id].path + ']',
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
        if (!config.nodes[taskId].recursive) {
          selTasks[taskId] = config.nodes[taskId];
        } else {
          res[taskId].forEach(function(dirname) {
            rtaskId = taskId + '/' + dirname;
            selTasks[rtaskId] = utils.copy(config.nodes[taskId]);
            selTasks[rtaskId].path = path.join(selTasks[rtaskId].path, dirname);
          });
        }
      }
    }
    if (emptyFlag) return cb('You must choose at least one task to continue..');
    return cb(null, selTasks);
  });
}

function getDirsSync(dirname) {
  // TODO: error handling, empty dirs check
  if (!fs.existsSync(dirname)) return execError('Can\'t resolve path: ' + dirname);
  return fs.readdirSync(dirname).filter(function(file) {
    return fs.statSync(path.join(dirname, file)).isDirectory();
  });
}

function taskUid() {
  var suffix = uidSuffix();

  function uidSuffix() {
    var d = new Date(),
      uid = d.valueOf(),
      mydt = ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + '.' + d.getFullYear();
    return mydt + '-' + uid;
  }

  return {
    get: function(name) {
      var name = name || 'copy';
      return name + '-' + suffix;
    }
  };
}

function cmdFactory(cmd, curworkdir, text) {
  return function(cb) {
    var cb = cb || function() {};
    var cwd;
    if (typeof curworkdir === 'string') {
      cwd = curworkdir;
      colorPrint('> cd ' + cwd + ' && ' + cmd);
    } else {
      cwd = __dirname;
      colorPrint('> ' + cmd);
    }

    if (text) {
      colorPrint('* ' + text, 'dim');
    }

    var ps = exec(cmd, {
      cwd: cwd,
      maxBuffer: 1024 * 5000 // empirical
    }, function(error, stdout, stderr) {
      if (error) return cb(error);
      return cb(null);
    });
    ps.stdout.pipe(process.stdout);
    ps.stderr.pipe(process.stderr);
  };
}

function execError(error, stdout, stderr) {
  console.error('\nError:', error);
  if (stdout) {
    console.error(stderr);
  }
  if (stderr) {
    console.error(stderr);
  }
  return process.exit(1);
}

function colorPrint(text, color) {
  var colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    underscore: '\x1b[4m',
    blink: '\x1b[5m',
    reverse: '\x1b[7m',
    hidden: '\x1b[8m',
    fgBlack: '\x1b[30m',
    fgRed: '\x1b[31m',
    fgGreen: '\x1b[32m',
    fgYellow: '\x1b[33m',
    fgBlue: '\x1b[34m',
    fgMagenta: '\x1b[35m',
    fgCyan: '\x1b[36m',
    fgWhite: '\x1b[37m',
    bgBlack: '\x1b[40m',
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m',
    bgMagenta: '\x1b[45m',
    bgCyan: '\x1b[46m',
    bgWhite: '\x1b[47m'
  };

  var c = colors.bright;
  if (colors.hasOwnProperty(color)) c = colors[color];
  console.log(c + text + colors.reset);
}

function enableLog(logfile) {
  var origstdout = process.stdout.write,
    origstderr = process.stderr.write,
    outfile = logfile,
    errfile = logfile;

  // remove the file ignoring any errors
  try {
    fs.unlinkSync(logfile);
  } catch (e) {}

  process.stdout.write = function(chunk) {
    fs.appendFile(outfile, chunk.replace(/\x1b\[[0-9;]*m/g, ''));
    origstdout.apply(this, arguments);
  };

  process.stderr.write = function(chunk) {
    fs.appendFile(errfile, chunk.replace(/\x1b\[[0-9;]*m/g, ''));
    origstderr.apply(this, arguments);
  };
}