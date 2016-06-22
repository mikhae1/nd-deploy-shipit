/**
 * Fetch given pull request, merge it locally and push it to origin.
 * Without arguments it gives handy list of all opened pull requests for the enviroment.
 */

var argv = require('yargs').argv;
var chalk = require('chalk');
var seq = require('nd-seq');
var inquirer = require('inquirer');
var fs = require('fs');

var tpl = [
  '# Source global definitions',
  'if [ -f /etc/bashrc ]; then',
  '    . /etc/bashrc',
  'fi',
  '# Prompt',
  'source ~/.git-prompt.sh',
  'PS1=\'{{prompt}} \'',
  '# Vars',
  'export ndir="{{ndir}}"',
  'export nduser="{{nduser}}"',
  'export ndlog="{{ndlog}}"',
  'export ndqlog="{{ndqlog}}"',
  '# Aliases',
  'alias g="git"',
  'alias s="sudo"',
  'alias hg="history | grep"',
  'alias ndlog="tail -n200 -f $ndlog"',
  'alias ndqlog="tail -n200 -f $ndqlog"',
  'alias ndreload="{{ndreload}} && sleep 1 && ndlog"',
  'alias ndchdir="{{ndchdir}}"',
  '# Alias for git completions to work on "g":',
  'source /etc/bash_completion.d/git',
  '__git_complete g __git_main',
  '# User specific functions',
  'if [[ $- =~ "i" ]]',
  'then',
  '    cd $ndir && git status -sb && git log -1',
  'fi'
].join('\n');

// var prompts = {
//   dev: '\\[\\e[42m\\][DEV]\\[\\e[0;32m\\][\\u@\\h \\W]\\$\\[\\e[0m\\]',
//   test: '\\[\\e[46m\\][TEST]\\[\\e[0;36m\\][\\u@\\h \\W]\\$\\[\\e[0m\\]',
//   prod: '\\[\\e[41m\\][PROD]\\[\\e[0;31m\\][\\u@\\h \\W]\\$\\[\\e[0m\\]'
// };

var prompts = {
  dev: '\\[\\e[0;32m\\][\\u@\\h]\\[\\e[0;30m\\]$(__git_ps1 "#%s")\\[\\e[0m\\] \\w \\[\\e[0;32m\\]\\$\\[\\e[0m\\]',
  test: '\\[\\e[0;93m\\][\\u@\\h]\\[\\e[0;30m\\]$(__git_ps1 "#%s")\\[\\e[0m\\] \\w \\[\\e[0;93m\\]\\$\\[\\e[0m\\]',
  prod: '\\[\\e[0;31m\\][\\u@\\h]\\[\\e[0;30m\\]$(__git_ps1 "#%s")\\[\\e[0m\\] \\w \\[\\e[0;31m\\]\\$\\[\\e[0m\\]',
  staging: '\\[\\e[0;34m\\][\\u@\\h]\\[\\e[0;30m\\]$(__git_ps1 "#%s")\\[\\e[0m\\] \\w \\[\\e[0;34m\\]\\$\\[\\e[0m\\]',
};

var dstFile = '/tmp/.bashrc';
var dstUser = 'mmekhanov';
var filesToCopy = [{
  src: '/tmp/.bashrc',
  dst: '~/.bashrc'
}, {
  src: '~/bashrc/.gitconfig',
  dst: '~/.gitconfig'
}, {
  src: '~/bashrc/.vimrc',
  dst: '~/.vimrc'
}, {
  src: '~/.vim/colors/monokai.vim',
  dst: '~/.vim/colors/monokai.vim'
}, {
  src: '~/.git-prompt.sh',
  dst: '~/.git-prompt.sh'
}];

module.exports = function(shipit) {
  shipit.task('bashrc', function(taskCallback) {
    require('./init')(shipit);
    var out = tpl;
    var config = shipit.config.remote;

    argv = require('yargs')
      .usage('Usage: $0 bashrc [-f [dev|test|prod]]')
      .alias('f', 'force')
      .help('h')
      .alias('h', 'help')
      .argv;

    seq(
      genBashrc,
      confirmUpload,
      upload,
      taskCallback
    );

    function genBashrc(cb) {
      if (argv.f) {
        shipit.log('force option: ', argv.f);
        out = out.replace('{{prompt}}', prompts[argv.f]);
      } else {
        if (shipit.environment.indexOf('dev') > 0) {
          out = out.replace('{{prompt}}', prompts.dev);
        } else if (shipit.environment.indexOf('test') > 0) {
          out = out.replace('{{prompt}}', prompts.test);
        } else if (shipit.environment.indexOf('prod') > 0) {
          out = out.replace('{{prompt}}', prompts.prod);
        } else if (shipit.environment.indexOf('staging') > 0) {
          out = out.replace('{{prompt}}', prompts.staging);
        } else {
          shipit.log('Can\'t detect bashrc server enviroment');
          // TODO:
          // inquirer.prompt([{
          //   type: 'input',
          //   message: 'Enter enviroment type: dev, test, prod?',
          //   name: 'confirm'
          // }], function(ans) {
          return taskCallback('unknown_env');
        }
      }

      if (config.path) {
        out = out.replace('{{ndir}}', config.path);
      } else if (config.targets.noodoo) {
        out = out.replace('{{ndir}}', config.targets.noodoo.path);
      } else if (config.targets) {
        // FIXME: add a menu
        out = out.replace('{{ndir}}', config.targets[Object.keys(config.targets)[0]].path);
      }

      if (config.owner) out = out.replace('{{nduser}}', config.owner);
      if (config.log) {
        if (typeof config.log === 'object') {
          out = out.replace('{{ndlog}}', config.log.noodoo);
          out = out.replace('{{ndqlog}}', config.log.queue);
        } else {
          out = out.replace('{{ndlog}}', config.log);
          out = out.replace('{{ndqlog}}', config.log.split('.log')[0] + '-queue.log');
        }
      } else {
        out = out.replace('{{ndlog}}', '/var/log/noodoo.log');
        out = out.replace('{{ndqlog}}', '/var/log/noodoo-queue.log');
      }
      if (config.restartScript) {
        if (config.restartScript.indexOf('sudo') !== 0) {
          out = out.replace('{{ndreload}}', 'sudo ' + config.restartScript);
        } else {
          out = out.replace('{{ndreload}}', config.restartScript);
        }
      }
      if (config.resetDirScript) out = out.replace('{{ndchdir}}', config.resetDirScript);

      // remove empty
      out = out.replace(/{{.*}}/ig, '');

      shipit.log('Generated bashrc:');
      console.log(out);
      fs.writeFile(dstFile, out, function(err) {
        if (err) return cb(err);

        shipit.log(dstFile + ' is saved');
        cb(null);
      });

    }

    function confirmUpload(cb) {
      shipit.log('> Files to copy:', filesToCopy);
      inquirer.prompt([{
        type: 'confirm',
        message: 'Upload this files to ' + shipit.config.servers + ' for ' + dstUser + '?',
        name: 'confirm'
      }], function(ans) {
        if (!ans.confirm) {
          shipit.log('the task was stopped by the user');
          return taskCallback();
        }
        cb(null);
      });
    }

    function upload(cb) {
      var tasks = [];

      var servers = Array.isArray(shipit.config.servers) ? shipit.config.servers : [shipit.config.servers];
      // FIXME: a hack
      for (var i = 0; i < shipit.pool.connections.length; i++) {
        shipit.pool.connections[i].remote.user = dstUser;
      }

      tasks.push(shipit.remoteFactory('mkdir -p ~/.vim/colors'));
      servers.forEach(function(srv) {
        var dst = srv.split('@')[1];
        filesToCopy.forEach(function(f){
          tasks.push(shipit.remoteFactory('cp -r ' + f.dst + ' ' + f.dst + '.old || true', 'backuping ' + f.dst));
          tasks.push(shipit.localFactory('scp -r ' + f.src + ' ' + dstUser + '@' + dst + ':' + f.dst));
        });
      });
      tasks.push(cb);
      seq.apply(seq, tasks);
    }
  });
};
