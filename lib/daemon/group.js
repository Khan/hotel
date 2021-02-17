'use strict';

var _slicedToArray = function () { function sliceIterator(arr, i) { var _arr = []; var _n = true; var _d = false; var _e = undefined; try { for (var _i = arr[Symbol.iterator](), _s; !(_n = (_s = _i.next()).done); _n = true) { _arr.push(_s.value); if (i && _arr.length === i) break; } } catch (err) { _d = true; _e = err; } finally { try { if (!_n && _i["return"]) _i["return"](); } finally { if (_d) throw _e; } } return _arr; } return function (arr, i) { if (Array.isArray(arr)) { return arr; } else if (Symbol.iterator in Object(arr)) { return sliceIterator(arr, i); } else { throw new TypeError("Invalid attempt to destructure non-iterable instance"); } }; }();

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const url = require('url');
const once = require('once');
const getPort = require('get-port');
const matcher = require('matcher');
const respawn = require('respawn');
const afterAll = require('after-all');
const httpProxy = require('http-proxy');
const serverReady = require('server-ready');
const log = require('./log');
const tcpProxy = require('./tcp-proxy');
const daemonConf = require('../conf');
const getCmd = require('../get-cmd');

module.exports = () => new Group();

class Group extends EventEmitter {
  constructor() {
    super();

    this._list = {};
    this._proxy = httpProxy.createProxyServer({
      xfwd: true
    });
  }

  _output(id, data) {
    this.emit('output', id, data);
  }

  _log(mon, logFile, data) {
    mon.tail = mon.tail.concat(data).split('\n').slice(-100).join('\n');

    if (logFile) {
      fs.appendFile(logFile, data, err => {
        if (err) log(err.message);
      });
    }
  }

  _change() {
    this.emit('change', this._list);
  }

  //
  // Conf
  //

  list() {
    return this._list;
  }

  find(id) {
    return this._list[id];
  }

  add(id, conf) {
    if (conf.target) {
      log(`Add target ${id}`);
      this._list[id] = conf;
      this._change();
      return;
    }

    log(`Add server ${id}`);

    const HTTP_PROXY = `http://127.0.0.1:${daemonConf.port}/proxy.pac`;

    conf.env = _extends({}, process.env, conf.env);

    if (conf.httpProxyEnv) {
      conf.env = _extends({
        HTTP_PROXY,
        HTTPS_PROXY: HTTP_PROXY,
        http_proxy: HTTP_PROXY,
        https_proxy: HTTP_PROXY
      }, conf.env);
    }

    if (conf.mechanism) {
      log(`adding env.mechanism:${conf.mechanism}`);
      conf.env = _extends({
        mechanism: conf.mechanism
      }, conf.env);
    }

    let logFile;
    if (conf.out) {
      logFile = path.resolve(conf.cwd, conf.out);
    }

    const command = getCmd(conf.cmd);

    const mon = respawn(command, _extends({}, conf, {
      maxRestarts: 0
    }));

    this._list[id] = mon;

    // Add proxy config
    mon.xfwd = conf.xfwd || false;
    mon.changeOrigin = conf.changeOrigin || false;

    // Emit output
    mon.on('stdout', data => this._output(id, data));
    mon.on('stderr', data => this._output(id, data));
    mon.on('warn', data => this._output(id, data));

    // Emit change
    mon.on('start', () => this._change());
    mon.on('stop', () => this._change());
    mon.on('crash', () => this._change());
    mon.on('sleep', () => this._change());
    mon.on('exit', () => this._change());

    // Log status
    mon.on('start', () => log(id, 'has started'));
    mon.on('stop', () => log(id, 'has stopped'));
    mon.on('crash', () => log(id, 'has crashed'));
    mon.on('sleep', () => log(id, 'is sleeping'));
    mon.on('exit', () => log(id, 'child process has exited'));

    // Handle logs
    mon.tail = '';

    mon.on('stdout', data => this._log(mon, logFile, data));
    mon.on('stderr', data => this._log(mon, logFile, data));
    mon.on('warn', data => this._log(mon, logFile, data));

    mon.on('start', () => {
      mon.tail = '';

      if (logFile) {
        fs.unlink(logFile, err => {
          if (err) log(err.message);
        });
      }
    });

    this._change();
  }

  remove(id, cb) {
    const item = this.find(id);
    if (item) {
      delete this._list[id];
      this._change();

      if (item.stop) {
        item.stop(cb);
        item.removeAllListeners();
        return;
      }
    }

    cb && cb();
  }

  stopAll(cb) {
    const next = afterAll(cb);

    Object.keys(this._list).forEach(key => {
      if (this._list[key].stop) {
        this._list[key].stop(next());
      }
    });
  }

  update(id, conf) {
    this.remove(id, () => this.add(id, conf));
  }

  //
  // Hostname resolver
  //

  resolve(str) {
    log(`Resolve ${str}`);
    const arr = Object.keys(this._list).sort().reverse().map(h => ({
      host: h,
      isStrictMatch: matcher.isMatch(str, h),
      isWildcardMatch: matcher.isMatch(str, `*.${h}`)
    }));

    const strictMatch = arr.find(h => h.isStrictMatch);
    const wildcardMatch = arr.find(h => h.isWildcardMatch);

    if (strictMatch) return strictMatch.host;
    if (wildcardMatch) return wildcardMatch.host;
  }

  //
  // Middlewares
  //

  exists(req, res, next) {
    // Resolve using either hostname `app.tld`
    // or id param `http://localhost:2000/app`
    const tld = new RegExp(`.${daemonConf.tld}$`);
    const id = req.params.id ? this.resolve(req.params.id) : this.resolve(req.hostname.replace(tld, ''));

    // Find item
    const item = this.find(id);

    // Not found
    if (!id || !item) {
      const msg = `Can't find server id: ${id}`;
      log(msg);
      return res.status(404).send(msg);
    }

    req.hotel = {
      id,
      item
    };

    next();
  }

  start(req, res, next) {
    const item = req.hotel.item;


    if (item.start) {
      if (item.env.PORT) {
        item.start();
        next();
      } else {
        getPort().then(port => {
          item.env.PORT = port;
          item.start();
          next();
        }).catch(error => {
          next(error);
        });
      }
    } else {
      next();
    }
  }

  stop(req, res, next) {
    const item = req.hotel.item;


    if (item.stop) {
      item.stop();
    }

    next();
  }

  proxyWeb(req, res, target) {
    var _req$hotel$item = req.hotel.item;
    const xfwd = _req$hotel$item.xfwd,
          changeOrigin = _req$hotel$item.changeOrigin;


    this._proxy.web(req, res, {
      target,
      xfwd,
      changeOrigin
    }, err => {
      log('Proxy - Error', err.message);
      const server = req.hotel.item;
      const view = server.start ? 'server-error' : 'target-error';
      res.status(502).render(view, {
        err,
        serverReady,
        server
      });
    });
  }

  proxy(req, res) {
    var _ref = req.headers.host && req.headers.host.split(':'),
        _ref2 = _slicedToArray(_ref, 2);

    const hostname = _ref2[0],
          port = _ref2[1];
    const item = req.hotel.item;

    // Handle case where port is set
    // http://app.localhost:5000 should proxy to http://localhost:5000

    if (port) {
      const target = item.env.HOST ? `http://${item.env.HOST}:${port}` : `http://127.0.0.1:${port}`;

      log(`Proxy - http://${req.headers.host} → ${target}`);
      return this.proxyWeb(req, res, target);
    }

    // Make sure to send only one response
    const send = once(() => {
      const target = item.target;


      log(`Proxy - http://${hostname} → ${target}`);
      this.proxyWeb(req, res, target);
    });

    if (item.start) {
      // Set target
      item.target = item.env.HOST ? `http://${item.env.HOST}:${item.env.PORT}` : `http://127.0.0.1:${item.env.PORT}`;
      // If server stops, no need to wait for timeout
      item.once('stop', send);

      // When PORT is open, proxy
      serverReady(item.env.PORT, send);
    } else {
      // Send immediatly if item is not a server started by a command
      send();
    }
  }

  redirect(req, res) {
    const id = req.params.id;
    const item = req.hotel.item;

    let path = req.params[0] || '';

    // Make sure to send only one response
    const send = once(() => {
      let target = item.target + (item.target.endsWith('/') ? '' : '/') + path;
      let parsedUrl = url.parse(req.url);
      if (parsedUrl.search) {
        target = target + parsedUrl.search;
      }

      if (item.env && item.env.mechanism === 'proxy') {
        // Adjusting the request is the easiest way to proxy the correct url
        req.url = target;
        log(`Proxy - ${id} → ${target}`);
        this.proxyWeb(req, res, item.target);
      } else {
        log(`Redirect - ${id} → ${target}`);
        res.redirect(307, target);
      }
    });

    if (item.start) {
      // Set target
      item.target = item.env.HOST ? `http://${item.env.HOST}:${item.env.PORT}` : `http://${req.hostname}:${item.env.PORT}`;

      // If server stops, no need to wait for timeout
      item.once('stop', send);

      // When PORT is open, redirect
      serverReady(item.env.PORT, item.env.HOST, send);
    } else {
      // Send immediatly if item is not a server started by a command
      send();
    }
  }

  parseHost(host) {
    var _host$split = host.split(':'),
        _host$split2 = _slicedToArray(_host$split, 2);

    const hostname = _host$split2[0],
          port = _host$split2[1];

    const tld = new RegExp(`.${daemonConf.tld}$`);
    const id = this.resolve(hostname.replace(tld, ''));
    return { id, hostname, port };
  }

  // Needed to proxy WebSocket from CONNECT
  handleUpgrade(req, socket, head) {
    if (req.headers.host) {
      const host = req.headers.host;

      var _parseHost = this.parseHost(host);

      const id = _parseHost.id,
            port = _parseHost.port;

      const item = this.find(id);

      if (item) {
        let target;
        if (port && port !== '80') {
          target = `ws://127.0.0.1:${port}`;
        } else if (item.start) {
          target = item.env.HOST ? `ws://${item.env.HOST}:${item.env.PORT}` : `ws://127.0.0.1:${item.env.PORT}`;
        } else {
          var _url$parse = url.parse(item.target);

          const hostname = _url$parse.hostname;

          target = `ws://${hostname}`;
        }
        log(`WebSocket - ${host} → ${target}`);
        this._proxy.ws(req, socket, head, { target }, err => {
          log('WebSocket - Error', err.message);
        });
      } else {
        log(`WebSocket - No server matching ${id}`);
      }
    } else {
      log('WebSocket - No host header found');
    }
  }

  // Handle CONNECT, used by WebSockets and https when accessing .localhost domains
  handleConnect(req, socket, head) {
    if (req.headers.host) {
      const host = req.headers.host;

      var _parseHost2 = this.parseHost(host);

      const id = _parseHost2.id,
            hostname = _parseHost2.hostname,
            port = _parseHost2.port;

      // If https make socket go through https proxy on 2001
      // TODO find a way to detect https and wss without relying on port number

      if (port === '443') {
        return tcpProxy.proxy(socket, daemonConf.port + 1, hostname);
      }

      const item = this.find(id);

      if (item) {
        if (port && port !== '80') {
          const HOST = item.env.HOST;

          log(`Connect - proxy socket to ${port}`);
          tcpProxy.proxy(socket, port, HOST || '127.0.0.1');
        } else if (item.start) {
          var _item$env = item.env;
          const PORT = _item$env.PORT,
                HOST = _item$env.HOST;

          log(`Connect - proxy socket to ${PORT}`);
          tcpProxy.proxy(socket, PORT, HOST || '127.0.0.1');
        } else {
          var _url$parse2 = url.parse(item.target);

          const hostname = _url$parse2.hostname,
                port = _url$parse2.port;

          const targetPort = port || 80;
          log(`Connect - ${host} → ${hostname}:${port}`);
          tcpProxy.proxy(socket, targetPort, hostname);
        }
      } else {
        log(`Connect - Can't find server for ${id}`);
        socket.end();
      }
    } else {
      log('Connect - No host header found');
    }
  }
}