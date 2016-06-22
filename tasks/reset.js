/**
 * Reset last repo changes
 */

var seq = require('nd-seq');

module.exports = function(shipit) {
  shipit.task('reset', function(taskCallback) {
    require('./init')(shipit);

    var config = shipit.config;

    seq(
      shipit.localFactory('git reset --hard', {
        cwd: config.local.path
      }),
      taskCallback
    );
  });
};
