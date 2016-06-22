/**
 * Build new release locally and push it to origin
 */

var inquirer = require('inquirer');
var seq = require('nd-seq');
var argv = require('yargs').argv;

module.exports = function(shipit) {
  shipit.task('bupd', function(taskCallback) {
    require('./init')(shipit);

    argv = require('yargs')
      .usage('Usage: $0 bupd -b <branch-name>')
      .example('$0 build -b test')
      .alias('b', ['branch'])
      .describe('b', 'Update branch')
      .help('h')
      .alias('h', 'help')
      .argv;

    var branches = ['test', 'staging', 'development'];
    if (argv.branch) branches = [argv.branch];

    var isOK, isPush;

    seq(
      branchLoop,
      taskCallback
    );

    function branchLoop(cb) {
      var tasks = [];
      branches.forEach(function(branch) {
        tasks = tasks.concat([
          seqFactory(gitReset, branch),
          seqFactory(gitMergeMaster, branch),
          seqFactory(checkChangelog, branch),
          seqFactory(confirm, branch),
          seqFactory(gitPush, branch)
        ]);
      });

      tasks.push(cb);

      seq.apply(seq, tasks);
    
      function seqFactory(func, branch) {
        return function(next) {
          return func(branch, next);
        };
      }
    }

    function gitReset(branch, cb) {
      isOK = true;
      shipit.log('> Reseting branch "%s"', branch);
      shipit.local('git checkout ' + branch + 
        ' && git fetch && git reset --hard origin/' + branch, {
        cwd: shipit.config.local.path
      }, cb);
    }

    function gitMergeMaster(branch, cb) {
      shipit.log('> Merging "master" into "%s"', branch);
      shipit.local('git pull origin master', {
        cwd: shipit.config.local.path
      }, cb);
    }

    function checkChangelog(branch, cb) {
      // all changes should be in one single section between ##master and ## x.y.z 
      
      seq(
        checkSingleSection,
        checkPlacement,
        cb
      );
      
      function checkSingleSection(branch, next) {
        shipit.local('git diff -U0 origin/master CHANGELOG.md | grep "@@" | wc -l', {
          cwd: shipit.config.local.path
        }, function(err, res) {
          if (err) return next(err);

          if (res.stdout.trim() !== '1') isOK = false;

          return next(null);
        });        
      }
      
      function checkPlacement(next) {
        shipit.log('Running CHANGELOG checks...');
        var reMaster = /##\smaster/i;
        var reVer = /##\s(\d+)\.(\d+)\.(\d+)/;
        var reDiff = /^[+-]\s/;

        shipit.local('git diff -U10 origin/master CHANGELOG.md', {
          cwd: shipit.config.local.path
        }, function(err, res) {
          if (err) return next(err);

          if (res.stdout.trim() === '') {
            isOK = true;
            return next(null);
          }

          var lines = res.stdout.split('\n');
          var masterFound, afterMasterSection;
          for (var i = 0; i < lines.length; i++) {
            if (reMaster.test(lines[i])) masterFound = true;
            if (masterFound && reVer.test(lines[i])) afterMasterSection = true;
            if (afterMasterSection) {
              console.log(lines[i]);
              if (reDiff.test(lines[i].trim())) {
                isOK = false;
                break;
              }
            }
          }

          return next(null);
        });        
      }
    }

    function confirm(branch, cb) {
      shipit.local('git diff origin/master CHANGELOG.md', {
        cwd: shipit.config.local.path
      }, function(err, res) {
        if (err) return cb(err);
        inquirer.prompt([{
          type: 'confirm',
          message: 'Push branch "' + branch + '" to "origin/' + branch + '"?',
          name: 'confirm',
          default: isOK
        }], function(ans) {
          if (!ans.confirm) {
            shipit.log('task was canceled');
            isPush = false;
            return gitReset(branch, cb);
          }

          isPush = true;
          return cb(null);
        });
      });
    }

    function gitPush(branch, cb) {
      if (!isPush) return cb(null);

      shipit.log('> Pushing new version of "%s" to origin:', branch);
      shipit.local('git push origin ' + branch + ':' + branch, {
        cwd: shipit.config.local.path
      }, cb);
    }
  });
};
