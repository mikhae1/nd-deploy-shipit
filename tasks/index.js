module.exports = function (shipit) {
  require('./sync')(shipit);
  require('./pr')(shipit);
  require('./build-release')(shipit);
  require('./update')(shipit);
  require('./rollback')(shipit);
  require('./bashrc')(shipit);
  require('./ver')(shipit);
  require('./branch-update')(shipit);
  require('./log')(shipit);
  require('./reset')(shipit);
};

