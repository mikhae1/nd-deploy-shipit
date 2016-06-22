/**
 * Common fuctions for all tasks
 */

var chalk = require('chalk');

module.exports = function(shipit) {
  return {
    getRemoteDirs: function getRemoteDirs(path2dir, cb) {
      shipit.remote('cd ' + path2dir + ' && ls -d */ | cut -f1 -d"/"', function(err, res) {
        if (err) return cb(err);

        var alldirs = [];
        var unsynced = false;
        var first = res[0].stdout;
        var maxdirs = [];
        for (var i = 0; i < res.length; i++) {
          alldirs[i] = res[i].stdout.trim().split('\n');
          if (first != res[i].stdout && !unsynced) {
            unsynced = true;
            shipit.log(chalk.bgRed('WARNING: Unsynced directories between the servers!'));
            shipit.log(shipit.config.servers[0] + ' dirs: \n' + first);
            shipit.log(shipit.config.servers[i] + ' dirs: \n' + res[i].stdout);
          }
          if (alldirs[i].length > maxdirs.length) {
            maxdirs = alldirs[i];
          }
        }

        if (unsynced) return cb('unsynced', maxdirs, alldirs);
        return cb(null, maxdirs, alldirs);
      });
    }
  };
};
