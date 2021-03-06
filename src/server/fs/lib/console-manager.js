/*
 * Copyright (c) 2012-2015 S-Core Co., Ltd.
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *     http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

var childProc = require('child_process');
var fsMgr = require('./fs-manager');
var Resource = fsMgr.Resource;
var ptyjs = require('pty.js');
var path = require('path');
var _ = require('lodash');
var express = require('express');

var socketio = require('socket.io');
var ss = require('socket.io-stream');

var authMgr = require('../../common/auth-manager');
var utils = require('../../common/utils');
var logger = require('../../common/log-manager');
var config = require('../../common/conf-manager').conf;
var container = require('./container').container;
var containerExec = container.getContainerExec;

var ClientError = utils.ClientError;
var ServerError = utils.ServerError;

var execTable = {};
function removeProc(proc) {
    if (execTable[proc.pid]) {
        logger.debug('Remove proc', proc.pid);

        proc.removeAllListeners();
        if (proc._timeoutId) {
            clearTimeout(proc._timeoutId);
            proc._timeoutId = null;
        }

        if (proc._cexec) {
            proc._cexec.destroy();
            proc._cexec = null;
        }

        delete execTable[proc.pid];
    }
}

function termProc(proc) {
    var cexec = proc._cexec;
    if (cexec) {
        logger.debug('terminate process container', proc.pid);
        cexec.kill('SIGKILL', function (err) {
            if (err) {
                /* TODO: retry termProc again */
                logger.warn('Failed to kill container exec', err);
            }
            removeProc(proc);
        });
    }
}

function addProc(proc, cexec, timeout) {
    logger.debug('Add proc', proc.pid);
    proc._cexec = cexec;
    cexec.setProc(proc);
    proc._stdout = '';
    proc._stderr = '';
    if (timeout) {
        proc._timeoutId = setTimeout(function () {
            logger.debug('Timeout proc', proc.pid);
            termProc(proc);
        }, config.services.fs.exec.timeoutSecs * 1000);
    }
    execTable[proc.pid] = proc;
}

/* cleanup all process on execTable */
process.on('exit', function () {
    _.forOwn(execTable, function (proc) {
        logger.debug('terminate', proc.pid);
        termProc(proc);
    });
});

function startProc(cwdRsc, cexec, callback) {
    var cmd = cexec.getCmd();
    var args = cexec.getArgs();

    logger.debug('Exec start', cmd, args);

    // TODO env will be removed
    var env = _.clone(process.env);
    env.HOME = cwdRsc.wfs.getRootPath();
    env.PATH = path.resolve(__dirname, '../bin') + ':' + env.PATH;

    /* execute command */
    var proc = childProc.spawn(cmd, args, {
        cwd: cwdRsc.localPath,
        detached: false,
        env: env
    });

    addProc(proc, cexec, true);

    proc.stdout.on('data', function (data) {
        proc._stdout += data;
    });

    proc.stderr.on('data', function (data) {
        proc._stderr += data;
    });

    proc.on('exit', function (code) {
        logger.debug('Exec close', proc.pid, 'code:'+code, 'stdout:'+proc._stdout, 'stderr:'+proc._stderr);
        removeProc(proc);
        /*
        if (code === 0) {
            return callback(code, proc._stdout, proc._stderr);
        }
        */
        if (code === null) {
            return callback(new Error('Abnormal exit'), proc._stdout, proc._stderr);
        }
        callback(null, proc._stdout, proc._stderr, code);
    });

    proc.on('error', function (err) {
        logger.debug('Exec error', proc.pid, err, proc._stdout, proc._stderr);
        removeProc(proc);
        if (err.errno === 'EPERM') {
            callback(new ClientError('Exec timeout'), proc._stdout, proc._stderr);
        } else {
            callback(new ServerError('Exec failed'), proc._stdout, proc._stderr);
        }
    });
}

function exec(cwdUrl, cmdInfo, callback) {
    var cwdRsc = new Resource(cwdUrl);
    /*
     * request.info is command information
     * info.cmd : command
     * info.args : command arguments
     */
    var cmd = cmdInfo.cmd;
    var args = cmdInfo.args;
    if (!cmd) {
        return callback('Command is not specified.');
    }

    containerExec(cwdRsc.wfs, cmd, args,
            {cwd: cwdRsc.pathname}, function (err, cexec) {
        if (err) {
            return callback(err);
        }
        startProc(cwdRsc, cexec, callback);
    });
}

function registerTerminalService(httpServer) {
    if (!container.supportTerminal()) {
        logger.debug('Container did not support terminal. ' +
                'So terminal service cannot be run.');
        return;
    }
    var io = socketio(httpServer);

    var customResponse = Object.create(express.response);
    io.use(function (socket, next) {
        var req = socket.request;
        req.parsedUrl = require('url').parse(req.url);
        req.query = require('querystring').parse(req.parsedUrl.query);
        logger.debug('io.use: ', req.url, req.headers);
        customResponse.send = function (result) {
            logger.debug('custom send:', arguments, this);
            if (this.statusCode >= 400) {
                next(new Error(result));
            } else {
                next();
            }
        };
        authMgr.ensureLogin(req, customResponse, next);
    });
    io.of('pty').on('connection', function (socket) {
        ss(socket).on('new', function (stream, options) {
            var req = socket.request;
            var async = require('async');
            var fsid = req.query.fsid;
            var userId = req.user.userId;
            async.waterfall([
                function (next) {
                    /* get wfs by fsid */
                    fsMgr.getWfsByFsid(fsid, next);
                },
                function (wfs, next) {
                    /* get wfs owner */
                    wfs.getOwner(_.partialRight(next, wfs));
                },
                function (ownerId, wfs, next) {
                    /* check wfs access permission */
                    if (ownerId === userId) {
                        return next(null, wfs);
                    }
                    return next(new Error('User(' + userId + ') has no permission to FS(' + fsid + ')'));
                },
                function (wfs, next) {
                    containerExec(wfs, null, null, {interactive: true}, next);
                },
                function (cexec, next) {
                    /* execute terminal container */
                    var pid;
                    var cwd = options.cwd;
                    var cmd = cexec.getCmd();
                    var args = cexec.getArgs();

                    var pty = ptyjs.spawn(cmd, args, {
                        name: 'xterm-color',
                        cols: options.columns,
                        rows: options.rows
                    });

                    pid = pty.pid;
                    logger.debug('Start terminal: ', pid, cmd, args, options);
                    addProc(pty, cexec, false);
                    socket.on('disconnect', function () {
                        logger.debug('Disconnect terminal: ', pid);
                        termProc(pty);
                    });
                    pty.on('exit', function () {
                        logger.debug('Exit terminal: ', pid);
                        cexec.setProc(null);
                        socket.disconnect(true);
                    });

                    return next(null, pty, cexec, cwd);
                },
                function (pty, cexec, cwd, next) {
                    /* change directory & clear terminal */
                    var pos;
                    var msg = '';
                    var KEYWORD = 'WSDKTERMINAL';
                    var cmd;
                    var cpid;
                    var STATE = Object.freeze({
                        SEARCH:0,
                        NEWLINE:1,
                        CPID:2,
                        DONE:3});
                    var state = STATE.SEARCH;

                    if (!cwd) {
                        cwd = '';
                    }
                    cwd = path.join('.', cwd);

                    cmd = 'cd ' + cwd + ';';
                    cmd += 'echo ' + KEYWORD + ';';
                    cmd += 'echo ${BASHPID};';
                    cmd += 'history -c; history -r\r';
                    KEYWORD += '\r';

                    pty.pause();
                    pty.write(cmd);
                    var dropMsg = function() {
                        /* accumulate all data from lxc */
                        var c;
                        while (null !== (c = pty.socket.read())) {
                            msg += c;
                        }

                        /* find keyword */
                        while ((state !== STATE.DONE) &&
                                (pos = msg.indexOf(KEYWORD)) !== -1) {
                            /* parse & get cpid */
                            if (state === STATE.CPID) {
                                cpid = parseInt(msg.substr(0, pos));
                                cexec.setCPid(cpid);
                            }

                            /* discard data with keyword */
                            msg = msg.substr(pos + KEYWORD.length);
                            state++;
                            if (state === STATE.NEWLINE) {
                                KEYWORD = '\n';
                            }
                        }

                        if (state === STATE.DONE) {
                            pty.removeListener('readable', dropMsg);
                            pty.resume();
                            if (msg.length !== 0) {
                                stream.write(msg);
                            }
                            return next(null, pty);
                        }
                    };
                    pty.on('readable', dropMsg);
                },
            ], function (err, pty) {
                if (err) {
                    logger.debug('terminal failed: ', err.message);
                    socket.disconnect(true);
                } else {
                    /* bind to client */
                    stream.pipe(pty).pipe(stream);
                }
            });
        });
    });

    logger.debug('Terminal service is running');
}

exports.exec = exec;

exports.registerTerminalService = registerTerminalService;

exports.router = new express.Router();

exports.router.post('/webida/api/fs/exec/:fsid/*',
    authMgr.verifyToken,
    function (req, res, next) {
        var rsc = 'fs:' + req.params.fsid + '/*';
        authMgr.checkAuthorize({uid:req.user.uid, action:'fs:exec', rsc:rsc}, res, next);
    },
    utils.keepConnect(),
    function (req, res) {
        var fsid = req.params.fsid;
        var cwdPath = path.join('/', req.params[0]);
        logger.info('exec path = ', cwdPath);
        var cwdUrl = 'wfs://' + fsid + cwdPath;
        var cmdInfo = JSON.parse(req.body.info);
        var sessionID = req.body.sessionID;
        var uid = req.user && req.user.uid;
        if (uid === undefined) {
            return res.sendfail(new ClientError('invalid uid'));
        }

        fsMgr.checkLock(fsid, cwdPath, cmdInfo, function(err) {
            if (err) {
                return res.sendfail(err);
            }
            exec(cwdUrl, cmdInfo, function (err, stdout, stderr, ret) {
                if (err) {
                    return res.sendfail(err);
                }
                fsMgr.updateByExec(cmdInfo,uid, fsid, cwdPath, cwdUrl, sessionID, function() {
                    return res.sendok({stdout: stdout, stderr: stderr, ret:ret});
                });
            });
        });
    }
);
