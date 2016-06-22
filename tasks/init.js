/**
 * General init
 */

var fs = require('fs');
var path = require('path');
var chalk = require('chalk');
var sshPool = require('ssh-pool');
var inquirer = require('inquirer');
var seq = require('nd-seq');
var open = require('open');
var os = require('os');

var slice = Array.prototype.slice;


module.exports = function(shipit) {
  //var lib = require('./lib')(shipit);

  shipit.localFactory = localFactory;
  shipit.remoteFactory = remoteFactory;
  shipit.log = log;
  shipit.remoteOneByOne = remoteOneByOne;
  shipit.remoteSingle = remoteSingle;
  shipit.enableLog = enableLog;
  shipit.mute = mute;
  shipit.unmute = unmute;

  var stdout_write;
  function mute() {
    stdout_write = process.stdout._write;
    process.stdout._write = function(chunk, encoding, callback) {
      callback();
    };
  }

  function unmute() {
    process.stdout._write = stdout_write;
  }

  // read github token from file and store it in options
  if (shipit.config.hasOwnProperty('githubToken') && typeof shipit.config.githubToken === 'string') {
    if (fs.existsSync(shipit.config.githubToken)) {
      shipit.config.githubToken = fs.readFileSync(shipit.config.githubToken, 'utf8').trim();
    }
  }

  function localFactory(cmd, opts, text) {
    if (typeof opts !== 'object') {
      text = opts;
      opts = {};
    }

    return cmdFactory(cmd, opts, text, 'local');
  }

  function remoteFactory(cmd, opts, text) {
    if (typeof opts !== 'object') {
      text = opts;
      opts = {};
    }

    return cmdFactory(cmd, opts, text, 'remote');
  }

  function cmdFactory(cmd, opts, text, type) {
    return function(next) {
      if (text) shipit.log('> ' + text);

      var fn = shipit[type];

      if (!fn) throw new Error('Unknown fn type ' + type);

      fn.call(shipit, cmd, opts, next);
    };
  }

  // enable fancy colors
  function log(text) {
    var format = slice.call(arguments, 1);

    format.unshift(chalk.yellow(text));

    console.log.apply(console, format);
  }

  function enableLog(logfile) {
    var logfile = logfile || path.join(__dirname, 'update.log');
    var origstdout = process.stdout.write,
      origstderr = process.stderr.write,
      outfile = logfile,
      errfile = logfile;

    // remove the file ignoring any errors
    try {
      fs.unlinkSync(logfile);
    } catch (e) {}

    process.stdout.write = function(chunk) {
      fs.appendFile(outfile, chunk);
      origstdout.apply(this, arguments);
    };

    process.stderr.write = function(chunk) {
      fs.appendFile(errfile, chunk);
      origstderr.apply(this, arguments);
    };

    if (shipit.config.hasOwnProperty('remote') && shipit.config.remote.log) {
      shipit.on('task_stop', sendLog);
      shipit.on('task_err', sendLog);
    }

    function sendLog() {
      shipit.log('> Sending log to remote host..');
      var dst = shipit.config.remote.log;

      var tasks = [];
      for (var i = 0; i < shipit.config.servers.length; i++) {
        tasks.push(shipit.localFactory(
          'scp ' + logfile + ' ' + shipit.config.servers[i] + ':' + dst));
      }
      seq.apply(this, tasks, function(err) {
        if (err) shipit.log('Can\'t send logfile!', logPath);
      });
    }

    function getUserInfo(cb) {
      var user = {
        user: process.env.USER || process.env.USERNAME,
        hostname: os.hostname(),
        home: process.env.HOME,
        platform: os.platform(),
      };
      // shipit.remote('bash -c \'echo $USER: $SSH_CLIENT\'', function(err, res) {
      shipit.remote('set | grep -i USER | grep -v grep && set | grep -i SSH_CLIENT | grep -v grep', function(err, res) {
        if (err) return cb(err);

        user.ssh = res[0].stdout.trim();
        return cb(null, user);
      });
    }

    getUserInfo(function(err, info) {
      if (err) shipit.log(chalk.red(err));
      for (var key in info) {
        shipit.log(chalk.dim(key, info[key]));
      }
    });
  }

  /**
   * Run remote command on the configured servers in series
   */
  function remoteSerial(cmd, next) {
    var tasks = [];
    var remoteSingleSeq = thunkify(remoteSingle);

    for (var i = 0; i < shipit.config.servers.length; i++) {
      tasks.push(remoteSingleSeq(shipit.config.servers[i], cmd));
    }
    tasks.push(next);
    seq.apply(seq, tasks);
  }

  /**
   * Run remote command on the single server
   */
  function remoteSingle(cmd, next) {
    var srv = shipit.config.servers[0];
    var connection = new sshPool.Connection({
      remote: srv,
      log: console.log.bind(console),
      stdout: process.stdout,
      stderr: process.stderr
    });

    connection.run(cmd, next);
  }

  function remoteOneByOne(cmd, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    var counter = 0;
    var tasks = [];

    for (var i = 0; i < shipit.config.servers.length; i++) {
      tasks.push(runRemote(cmd, shipit.config.servers[i]));
    }
    tasks.push(cb);
    seq.apply(this, tasks);

    function runRemote(cmd, srv) {
      var tasks = [];
      return function(cb) {
        var connection = new sshPool.Connection({
          remote: srv,
          log: console.log.bind(console),
          stdout: process.stdout,
          stderr: process.stderr
        });

        // run beofre and after tasks if needed
        if (opts.before) tasks.push(runCmd(opts.before));
        tasks.push(mainCmd);
        if (opts.after) tasks.push(runCmd(opts.after));
        tasks.push(cb);
        seq.apply(this, tasks);

        function mainCmd(cb) {
          connection.run(cmd, function(err, res) {
            if (err) return cb(err);

            // shipit.log(res.stderr);
            // shipit.log(res.stdout);

            // multiple targets support
            var urls = [];
            if (opts.openUrl) {
              urls.push(opts.openUrl);
            } else if (opts.openUrls) {
              opts.openUrls.forEach(function(url) {
                urls.push(url);
              });
            } else if (shipit.config.hasOwnProperty('remote') && shipit.config.remote.hasOwnProperty('openUrl')) {
              urls.push(shipit.config.remote.openUrl);
            }

            if (urls.length > 0) {
              urls.forEach(function(url) {
                open(url);
              });
            }

            if (counter < shipit.config.servers.length - 1) {
              inquirer.prompt([{
                type: 'confirm',
                message: 'Continue task on the next server?',
                name: 'confirm'
              }], function(ans) {
                if (!ans.confirm) {
                  shipit.log('task was stopped by user');
                  return cb();
                }
                counter++;
                return cb(null);
              });
            } else {
              return cb(null);
            }
          });
        }

        function runCmd(cmd) {
          return function(cb) {
            connection.run(cmd, function(err, res) {
              if (err) return cb(err);
              shipit.log(res.stderr);
              shipit.log(res.stdout);
              return cb(null);
            });
          };
        }

      };
    }
  }
};
