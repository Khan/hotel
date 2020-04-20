'use strict';

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

const fs = require('fs');
const mkdirp = require('mkdirp');

var _require = require('./common');

const hotelDir = _require.hotelDir,
      confFile = _require.confFile;

// Create dir

mkdirp.sync(hotelDir);

// Defaults
const defaults = {
  port: 2000,
  host: '127.0.0.1',
  timeout: 5000,
  tld: 'localhost',
  mechanism: 'redirect',
  // Replace with your network proxy IP (1.2.3.4:5000) if any
  // For example, if you're behind a corporate proxy
  proxy: false,
  // Set to false to disable automatic running on startup.
  autostart: true

  // Create empty conf it it doesn't exist
};if (!fs.existsSync(confFile)) fs.writeFileSync(confFile, '{}');

// Read file
const conf = JSON.parse(fs.readFileSync(confFile));

// Assign defaults and export
module.exports = _extends({}, defaults, conf);