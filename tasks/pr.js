/**
 * Fetch given pull request, merge it locally and push it to origin.
 * Without arguments it gives handy list of all opened pull requests for the enviroment.
 */

var inquirer = require('inquirer');
var github = require('octonode');
var argv = require('yargs').argv;
var chalk = require('chalk');
var seq = require('nd-seq');


module.exports = function(shipit) {
  shipit.task('pr', function(taskCallback) {
    require('./init')(shipit);

    argv = require('yargs')
      .usage('Usage: $0 PR [-p [url|pr]]')
      .example('$0 PR -p pull/86/head:feature/new')
      .example('$0 PR -p https://github.com/orichards/n-gathering/pull/86', 'github personal token required')
      .example('$0 PR -p 86', 'github personal token required')
      //.demand(['p'])
      .help('h')
      .alias('h', 'help')
      .argv;

    if (!argv.p) {
      return listOpenPR(taskCallback);
    }

    seq(
      init,
      gitUpdate,
      gitPullPR,
      confirmPush,
      gitPush,
      taskCallback
    );

    function init(cb) {
      if (/^pull\/\d+\/head\:\w+/.test(argv.p)) {
        shipit.config.purl = argv.p;
        return cb(null);
      }

      getOpenPR(function(err, res) {
        if (err) return cb(err);

        if (/^\d+$/.test(argv.p)) {
          if (res.hasOwnProperty(argv.p)) {
            shipit.config.purl = res[argv.p].purl;
          } else {
            return cb('Unknown pr number: ' + argv.p);
          }
        } else if (/^https\:\/\//.test(argv.p)) {
          for (var key in res) {
            if (res[key].html_url.trim() === argv.p.trim()) {
              console.log(res[key].html_url);
              shipit.config.purl = res[key].purl;
              break;
            }
          }
        }
        if (!shipit.config.purl) return cb('Unknown PR: ' + argv.p);
        return cb(null);
      });
    }

    function gitUpdate(cb) {
      shipit.log('> Fetching updates: ');
      shipit.local('git checkout ' + shipit.config.branch + ' && git fetch && git diff --name-status origin/' + shipit.config.branch + ' && git reset --hard origin/' + shipit.config.branch, {
        cwd: shipit.config.local.path
      }, function(err, res) {
        if (err) return cb(err);

        shipit.log(chalk.green('"%s" is reset to "origin/%s"'), shipit.config.branch, shipit.config.branch);
        return cb(null);
      });
    }

    function gitPullPR(cb) {
      shipit.log('> Fetching PR: ');
      shipit.local('git pull --no-ff origin ' + shipit.config.purl, {
        cwd: shipit.config.local.path
      }, function(err, res) {
        if (err) return cb(err);

        shipit.log(chalk.green('"%s" is merged to "origin/%s"'), shipit.config.purl, shipit.config.branch);
        return cb(null);
      });
    }

    function confirmPush(cb) {
      shipit.local('git log --pretty=format:\"%h %ad | %s%d [%an]\" --graph --date=short -n10 && echo "\n" && git diff --name-status @{1}..', {
        cwd: shipit.config.local.path
      }, function(err, res) {
        if (err) return cb(err);
        inquirer.prompt([{
          type: 'confirm',
          message: 'Push "' + shipit.config.branch + '" to "origin/' + shipit.config.branch + '"?',
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

    function gitPush(cb) {
      shipit.log('> Pushing new version to origin: ');
      shipit.local('git push origin ' + shipit.config.branch + ':' + shipit.config.branch, {
        cwd: shipit.config.local.path
      }, function(err, res) {
        if (err) return cb(err);

        shipit.log(chalk.green('"%s" is pushed to "origin/%s"'), shipit.config.branch, shipit.config.branch);
        return cb(null);
      });
    }

    function getOpenPR(cb) {
      var client;

      if (shipit.config.githubToken) {
        client = github.client(shipit.config.githubToken);
      } else {
        client = github.client();
      }

      var re = /^origin.*github.com[:\/](.*)\/(.*).git.*\(fetch\)/i;

      shipit.log('Loading open pull requests from origin: ');
      shipit.local('git remote -v', {
        cwd: shipit.config.local.path,
        stdout: 'pipe'
      }, function(err, res) {
        if (err) return cb(err);
        if (res.stdout.search(re) === -1) return cb('Can\'t get remote origin');

        var url = '/repos/' + res.stdout.match(re)[1] + '/' + res.stdout.match(re)[2] + '/pulls';
        client.get(url, {}, function(err, status, body, headers) {
          if (err) return cb(err);

          //console.log(body);
          var out = {};
          for (var key in body) {
            if (body[key].state === 'open') {
              body[key].purl = 'pull/' + body[key].number + '/head:' + body[key].head.ref;
              out[body[key].number.toString()] = body[key];
            }
          }
          return cb(null, out);
        });
      });
    }

    function listOpenPR(cb) {
      getOpenPR(function(err, res) {
        if (err) {
          if (shipit.config.githubToken) {
            shipit.log('You should configure valid github token: ', shipit.config.githubToken);
            return cb(err);
          } else {
            return cb('You should provide pull request to install');
          }
        }

        shipit.log(chalk.bold('Choose one of this pull requests: '));
        var c = 0;
        for (var key in res) {
          shipit.log('  ' + key + '.', res[key].html_url, chalk.dim(res[key].purl));
          c++;
        }
        shipit.log(chalk.bold('Total: ', c));
        return cb(null);
      });
    }

  });


  shipit.task('PR', ['pr']); // just alias
};
