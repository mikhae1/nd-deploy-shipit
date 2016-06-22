/**
 * Show gitlog
 */

var path = require('path');
var fs = require('fs');
var chalk = require('chalk');
var seq = require('nd-seq');

module.exports = function(shipit) {
  shipit.task('ver', function(taskCallback) {
    require('./init')(shipit);

    var version = '';
    var config = shipit.config;

    seq(
      gitUpdate,

      shipit.localFactory('git log --oneline --color -n20', {
        cwd: config.local.path
      }),

      shipit.localFactory('git describe --abbrev=0 --tags', {
        cwd: config.local.path
      }),

      taskCallback
    );

    function gitUpdate(cb) {
      shipit.log('> Fetching updates:');
      shipit.local('git checkout ' + config.branch +
        ' && git fetch ' +
        ' && git reset --hard origin/' + config.branch,
        {
          cwd: config.local.path
        }, function(err, res) {
          if (err) return cb(err);

          shipit.log(chalk.green('"%s" is reset to "origin/%s"'), config.branch, config.branch);
          return cb(null);
      });
    }


    function copy2clipboard(cb) {
      shipit.local('echo "' + version + '" | pbcopy', 'copying to clipboard..', cb);
    }

  });
};
