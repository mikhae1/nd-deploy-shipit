/**
 * Show log
 */

var argv = require('yargs').argv;
var seq = require('nd-seq');

module.exports = function(shipit) {
  shipit.task('log', function(taskCallback) {
    require('./init')(shipit);

    var path = logPath(shipit.config.remote.log);

    seq(
      shipit.log('> Server log:'),
      shipit.remote('tail -n100 -f ' + path + ' | grep -v "nd-db:time"'),
      taskCallback
    );

    function logPath(log) {
      if (typeof log === 'object') return log[argv.t || 'noodoo'];

      return log || '/var/log/noodoo/noodoo.log';
    }
  });

};
