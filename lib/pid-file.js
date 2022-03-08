'use strict';

const fs = require('fs');

var _require = require('./common');

const pidFile = _require.pidFile;


module.exports = {
  create,
  read,
  remove
};

function create() {
  console.log('create', pidFile, process.pid);
  return fs.writeFileSync(pidFile, String(process.pid));
}

function read() {
  if (fs.existsSync(pidFile)) {
    return fs.readFileSync(pidFile, 'utf-8');
  }
}

function remove() {
  if (fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }
}