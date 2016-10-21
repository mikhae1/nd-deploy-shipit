/**
 * Build new release locally and push it to origin
 */

var path = require('path');
var fs = require('fs');
var chalk = require('chalk');
var inquirer = require('inquirer');
var seq = require('nd-seq');
var argv = require('yargs').argv;
var moment = require('moment');

var Semver = function (x, y, z) {
  this.x = x;
  this.y = y;
  this.z = z;
};
Semver.prototype.toString = function() {
  return this.x + '.' + this.y + '.' + this.z;
};

var ver = new Semver(0 ,0, 0);
var reVer = /(\d+)\.(\d+)\.(\d+)/;
var dovReport = '';

module.exports = function(shipit) {
  shipit.task('build', function(taskCallback) {
    require('./init')(shipit);

    argv = require('yargs')
      .usage('Usage: $0 build <release-version>')
      .example('$0 build -v 1.6.2')
      .describe('v', 'Specify build version in semver format: X.Y.Z')
      .alias('v', 'version')
      .alias('p', ['patch'])
      .describe('p', 'Build patch version: X.Y.Z+1')
      .alias('n', 'minor')
      .describe('n', 'Build minor version: X.Y+1.0')
      .demand(2, 'No release version specified')
      .help('h')
      .alias('h', 'help')
      .argv;

    seq(
      gitReset,
      gitUpdate,
      parseVersion,
      updatePackageJson,
      updateChangelog,
      commit,
      addTag,
      confirm,
      gitPush,
      gitPushTags,
      printDovReport,
      copy2clipboard,
      taskCallback
    );

    function gitReset(branch, cb) {
      shipit.log('> Reseting branch "%s"', shipit.config.branch);
      shipit.local('git reset --hard origin/' + shipit.config.branch, {
        cwd: shipit.config.local.path
      }, cb);
    }

    function gitUpdate(cb) {
      shipit.log('> Fetching updates:');
      shipit.local('git checkout ' + shipit.config.branch + ' && git fetch && git diff --name-status origin/' + shipit.config.branch + ' && git reset --hard origin/' + shipit.config.branch, {
        cwd: shipit.config.local.path
      }, function(err, res) {
        if (err) return cb(err);
        shipit.log(chalk.green('"%s" is reset to "origin/%s"'), shipit.config.branch, shipit.config.branch);
        return cb(null);
      });
    }

    function parseVersion(cb) {
      if (argv.v) return parse(argv.v);

      shipit.local('git describe --abbrev=0 --tags', {
        cwd: shipit.config.local.path
      }, function(err, res) {
        if (err) return cb(err);
        parse(res.stdout);
      });

      function parse(versionString) {
        var s = versionString.trim();

        ver.x = parseInt(s.match(reVer)[1], 10);
        ver.y = parseInt(s.match(reVer)[2], 10);
        ver.z = parseInt(s.match(reVer)[3], 10);

        if (argv.p) ver.z++;
        if (argv.n) {
          ver.y++;
          ver.z = 0;
        }

        shipit.log('> Release version: %s.%s.%s', ver.x, ver.y, ver.z);
        return cb(null);
      }
    }

    function updatePackageJson(cb) {
      shipit.log('> Edit package.json');
      var file = path.join(shipit.config.local.path, 'package.json');
      var content = fs.readFileSync(file, 'utf8');
      content = content.replace(
        /"version":.*"(\d+.\d+.\d+)"/i,
        '"version": "' + ver.toString() + '"'
      );
      fs.writeFileSync(file, content, 'utf8');
      return cb(null);
    }

    function updateChangelog(cb) {
      shipit.log('> Edit CHANGELOG.md');
      var file = path.join(shipit.config.local.path, 'CHANGELOG.md');
      var data = fs.readFileSync(file).toString();
      var lines = data.split('\n');
      var insertlineNumber = 1;

      var urlRe = /(^.*https:\/\/github.com\/.*\/compare\/)/im;
      var url = data.match(urlRe);
      if (url) {
        console.log('> inserting compare url...');
        url = url[0];
        var prev = 'v' + data.match(/##\s(\d+\.\d+\.\d+)/i)[1];
        url = url + prev + '...' + 'v' + ver.toString();
      }

      var ts = moment().format('YYYY-MM-DD HH:mm');
      var insertion = '\n## ' + ver.toString() + ' ' + ts;
      if (url) insertion += '\n\n' + url;

      lines.splice(insertlineNumber, 0, insertion);

      var text = lines.join('\n');

      fs.writeFile(file, text, function(err) {
        if (err) return cb(err);
        return cb(null);
      });
    }

    function commit(cb) {
      var m = 'Version ' + ver.toString();
      shipit.log('> Creating commit "%s"', m);
      shipit.local('git commit -am "' + m + '"', {
        cwd: shipit.config.local.path
      }, function(err, res) {
        if (err) return cb(err);

        shipit.log(chalk.green('Commit added'));
        return cb(null);
      });
    }

    function addTag(cb) {
      var tag = 'v' + ver.toString();
      shipit.log('> Adding new tag "%s"', tag);
      shipit.local('git tag ' + tag, {
        cwd: shipit.config.local.path
      }, function(err, res) {
        if (err) return cb(err);

        shipit.log(chalk.green('Tag added'));
        return cb(null);
      });
    }

    function removeTag(cb) {
      var tag = 'v' + ver.toString();
      shipit.log('> Removing new tag locally "%s"', tag);
      shipit.local('git tag -d ' + tag, {
        cwd: shipit.config.local.path
      }, function(err, res) {
        if (err) return cb(err);

        shipit.log(chalk.green('Tag removed'));
        return cb(null);
      });
    }

    function confirm(cb) {
      shipit.local('head -n20 CHANGELOG.md && echo "++++" && head package.json && git hist -n10', {
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
            return removeTag(taskCallback);
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

    function gitPushTags(cb) {
      shipit.log('> Pushing tags to origin: ');
      shipit.local('git push origin --tags', {
        cwd: shipit.config.local.path
      }, function(err, res) {
        if (err) return cb(err);

        shipit.log(chalk.green('all tags are pushed to origin'));
        return cb(null);
      });
    }

    function printDovReport(cb) {
      dovReport = '<b>Собран релиз ' + ver.toString() + ' для ' +
        path.basename(shipit.config.local.path) + ' и установлен на PROD.</b>\n';

      var file = path.join(shipit.config.local.path, 'CHANGELOG.md');
      var block = [];
      var count = 0;
      //var reTag = /^##/;

      var readline = require('readline');
      var fs = require('fs');
      var fstream = fs.createReadStream(file);

      var rl = readline.createInterface({
        input: fstream
      });

      rl.on('line', function(line) {
        // console.log(line);
        // there is no documented way to close/shutdown/abort/destroy
        // a generic Readable stream as of Node 5.3.0.
        if (count > 2) return;

        if (line.indexOf('##') !== -1) count++;
        // save all between second and third "##""
        if (count === 2) block.push(line);
      }).on('close', done);

      function done() {
        block.splice(0, 1);
        dovReport += 'Список изменений:\n';
        //console.log('<ul>');
        block.forEach(function(line) {
          if (line && line.trim().length > 0) {
            console.log(line);
            dovReport += line + '\n';
          }
        });

        // console.log(dovReport);
        cb(null);
      }
    }

    function copy2clipboard(cb) {
      shipit.local('echo "' + dovReport + '" | pbcopy', 'copying to clipboard..', cb);
    }
  });
};
