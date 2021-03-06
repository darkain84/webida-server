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

var url = require('url');
var utils = require('./utils');
var _ = require('lodash');

//var mongojs = require('mongojs');
var querystring = require('querystring');

var logger = require('./log-manager');
var config = require('./conf-manager').conf;

//var tdb = null;

var authUrl = url.parse(config.authHostUrl);
var fsUrl = url.parse(config.fsHostUrl);

/* check protocol only with auth url */
var proto = (authUrl.protocol === 'https:' ? require('https') : require('http'));

var ClientError = utils.ClientError;
var ServerError = utils.ServerError;

exports.init = function (db) {
    logger.info('auth-manager initialize. (' + db + ')');
    /*tdb = mongojs(db, ['tokeninfo']);
    tdb.tokeninfo.ensureIndex({expireDate: 1}, {expireAfterSeconds: 0});
    tdb.tokeninfo.ensureIndex({token: 1}, {unique: true});*/
};

function requestTokenInfo(token, callback) {
    var path = '/webida/api/oauth/verify?token=' + token;
    var options = {
        hostname: authUrl.hostname,
        port: authUrl.port,
        path: path
    };

    logger.info('req', options);
    function handleResponse(err, res, body) {
        if (err) { return callback(err); }

        var tokenInfo;
        if (res.statusCode === 200) {
            try {
                tokenInfo = JSON.parse(body).data;
            } catch (e) {
                logger.error('Invalid verifyToken reponse:', arguments);
                return callback(500);
            }
            return callback(0, tokenInfo);
        } else if (res.statusCode === 419) {
            return callback(419);
        } else {
            return callback(500);
        }
    }

    var req = proto.request(options, function (res) {
        var data = '';
        logger.info('res', res.statusCode);
        res.setEncoding('utf8');
        res.on('data', function (chunk) {
            logger.info('data chunk', chunk);
            data += chunk;
        });
        res.on('end', function (){
            logger.info('end', data);
            handleResponse(null, res, data);
        });
    });
    req.on('error', function (err) {
        handleResponse(err);
    });
    req.end();
}

function checkExpired(info, callback) {
    if (!info) {
        return callback(500);
    }

    /*if (info.expireTime === 'INFINITE') {
        return callback(0, info);
    }*/
    if (info.validityPeriod <= 0) { // INFINITE
        return callback(0, info);
    }

    var current = new Date().getTime();
    var expire = new Date(info.expireTime).getTime();
    logger.info('checkExpired', current, info, expire);
    if (expire - current < 0) {
        return callback(419);
    } else {
        return callback(0, info);
    }
}

function _verifyToken(token, callback) {
    /*if (!tdb) {
        logger.debug('auth-manager is not initialized.');
        return callback(400);
    }*/
    if (!token) {
        logger.debug('token is null');
        return callback(400);
    }

    /*isTokenRegistered(token, function (err, tokenInfo) {
        if (err) {
            logger.debug(err);
            return callback(500);
        }

        if (!tokenInfo) {*/
    requestTokenInfo(token, function (err, info) {
        if (err) {
            logger.debug('requestTokenInfo failed', err);
            return callback(err);
        }
        return checkExpired(info, callback);
    });
        /*} else {
            checkExpired(tokenInfo, callback);
        }
    });*/
}
exports._verifyToken = _verifyToken;

function getTokenVerifier(errHandler) {
    var verifyToken = function (req, res, next) {
        /*if (!tdb) {
            logger.debug('auth-manager is not initialized');
            return res.status(500).send(utils.fail('Internal Server Error'));
        }*/

        /* jshint camelcase: false */
        var token = req.headers.authorization || req.access_token ||
            req.query.access_token ||  req.parsedUrl.query.access_token;
        if (!token) {
            return errHandler(utils.err('TokenNotSpecified'), req, res, next);
        }
        logger.info('verifyToken', token);

        _verifyToken(token, function (err, info) {
            if (err) {
                logger.info('_verifyToken failed', err);
                console.error('_verifyToken failed', err);
                errHandler(err, req, res, next);
            } else {
                req.user = info;
                next();
            }
        });
    };
    return verifyToken;
}
exports.getTokenVerifier = getTokenVerifier;

function getUserInfo(req, res, next) {
    getTokenVerifier(function errorHandler(err, req, res, next) {
        if (err) {
            if (err.name === 'TokenNotSpecified') {
                return next();
            } else if (err === 419)  {
                return res.status(err).send(utils.fail('Access token is invalid or expired'));
            } else {
                return res.status(err).send(utils.fail('Internal server error'));
            }
        } else {
            return next();
        }
    })(req, res, next);
}
exports.getUserInfo = getUserInfo;
function ensureLogin(req, res, next) {
    /* jshint unused:false */
    getTokenVerifier(function errorHandler(err, req, res, next) {
        if (err.name === 'TokenNotSpecified') {
            return res.status(400).send(utils.fail('Access token is required'));
        } else if (err === 419)  {
            return res.status(err).send(utils.fail('Access token is invalid or expired'));
        } else {
            return res.status(err).send(utils.fail('Internal server error'));
        }
        //next();
    })(req, res, next);
}
exports.ensureLogin = ensureLogin;
exports.verifyToken = ensureLogin; // deprecated

function ensureAdmin(req, res, next) {
    ensureLogin(req, res, function () {
        if (!req.user.isAdmin) {
            return res.status(400).send(utils.fail('Unauthorized Access'));
        }
        next();
    });
}
exports.ensureAdmin = ensureAdmin;

function verifySession(token, callback) {
    if (!token) {
        logger.debug('token is null');
        return callback(400);
    }

    requestTokenInfo(token, function (err, info) {
        if (err) {
            logger.debug('requestTokenInfo failed', err);
            return callback(err);
        }
        return checkExpired(info, callback);
    });
}

exports.verifySession = verifySession;

function checkAuthorize(aclInfo, res, next) {
    logger.info('checkAuthorize', aclInfo);
    var path = '/checkauthorize?uid=' + aclInfo.uid +
        '&action=' + aclInfo.action +
        '&rsc=' + aclInfo.rsc;
    var options = {
        hostname: authUrl.hostname,
        port: authUrl.port,
        path: encodeURI(path)
    };
    var cb = next;
    var req = proto.request(options, function(response) {
        var data = '';
        response.setEncoding('utf8');
        response.on('data', function (chunk) {
            logger.info('checkAuthorize data chunk', chunk);
            data += chunk;
        });
        response.on('end', function (){
            if (response.statusCode === 200) {
                return cb();
            } else if (response.statusCode === 401) {
                return res.status(401).send(utils.fail('Not authorized.'));
            } else {
                return res.status(500).send(utils.fail('Internal server error(checking authorization)'));
            }
        });
    });

    req.on('error', function(e) {
        return res.send(500, utils.fail(e));
    });

    req.end();
}
exports.checkAuthorize = checkAuthorize;

function checkAuthorizeMulti(aclInfo, res, next) {
    logger.info('checkAuthorizeMulti', aclInfo);
    var path = '/checkauthorizemulti?uid=' + aclInfo.uid +
        '&action=' + aclInfo.action +
        '&rsc=' + aclInfo.rsc +
        '&fsid=' + aclInfo.fsid;
    var cb = next;
    var options = {
        hostname: authUrl.hostname,
        port: authUrl.port,
        path: encodeURI(path)
    };

    var req = proto.request(options, function(response) {
        var data = '';
        response.setEncoding('utf8');
        response.on('data', function (chunk) {
            logger.info('data chunk', chunk);
            data += chunk;
        });
        response.on('end', function (){
            if (response.statusCode === 200) {
                return cb();
            } else if (response.statusCode === 401) {
                return res.send(401, utils.fail('Not authorized.'));
            } else {
                return res.send(500, utils.fail('Internal server error(checking authorization)'));
            }
        });
    });

    req.on('error', function(e) {
        return res.send(500, utils.fail(e));
    });

    req.end();
}
exports.checkAuthorizeMulti = checkAuthorizeMulti;


function createPolicy(policy, token, callback) {
    logger.info('createPolicy', policy);

    var data = querystring.stringify({
        name: policy.name,
        action: JSON.stringify(policy.action),
        resource: JSON.stringify(policy.resource)
    });
    var path = '/webida/api/acl/createpolicy?access_token=' + token;
    var options = {
        hostname: authUrl.hostname,
        port: authUrl.port,
        path: path,
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': data.length
        }
    };

    var req = proto.request(options, function(response) {
        var data = '';
        response.setEncoding('utf8');
        response.on('data', function (chunk) {
            logger.info('createPolicy data chunk', chunk);
            data += chunk;
        });
        response.on('end', function (){
            if (response.statusCode === 200) {
                try {
                    return callback(null, JSON.parse(data).data);
                } catch (e) {
                    logger.error('Invalid createpolicy response');
                    return callback(new ServerError('Invalid createpolicy response'));
                }
            } else {
                return callback(new ServerError('createPolicy failed'),
                    policy);
            }
        });
    });


    req.on('error', function(e) {
        return callback(e);
    });

    req.write(data);

    req.end();
}
exports.createPolicy = createPolicy;

function deletePolicy(pid, token, callback) {
    logger.info('deletePolicy', pid);
    var template = _.template('/webida/api/acl/deletepolicy?' +
        'access_token=<%= token %>&pid=<%= pid %>');
    var path = template({ token: token, pid: pid });

    var options = {
        hostname: authUrl.hostname,
        port: authUrl.port,
        path: path,
    };

    var req = proto.request(options, function(response) {
        var data = '';
        response.setEncoding('utf8');
        response.on('data', function (chunk) {
            logger.info('deletePolicy data chunk', chunk);
            data += chunk;
        });
        response.on('end', function (){
            if (response.statusCode === 200) {
                return callback(null, pid);
            } else {
                return callback(new ServerError('deletePolicy failed'),
                    pid);
            }
        });
    });

    req.on('error', function(e) {
        return callback(e);
    });

    req.end();
}
exports.deletePolicy = deletePolicy;

function assignPolicy(id, pid, token, callback) {
    logger.info('assignPolicy', id, pid);
    var path = '/webida/api/acl/assignpolicy' +
        '?pid=' + pid +
        '&user=' + id +
        '&access_token=' + token;
    var options = {
        hostname: authUrl.hostname,
        port: authUrl.port,
        path: path
    };

    var req = proto.request(options, function(response) {
        var data = '';
        response.setEncoding('utf8');
        response.on('data', function (chunk) {
            logger.info('assignPolicy data chunk', chunk);
            data += chunk;
        });
        response.on('end', function (){
            if (response.statusCode === 200) {
                return callback(null);
            } else {
                return callback(new ServerError('assignPolicy failed'));
            }
        });
    });


    req.on('error', function(e) {
        return callback(e);
    });

    req.end();
}
exports.assignPolicy = assignPolicy;

function removePolicy(pid, token, callback) {
    logger.info('removePolicy', pid);
    var template = _.template('/webida/api/acl/removepolicy?' +
        'access_token=<%= token %>&pid=<%= pid %>');
    var path = template({ token: token, pid: pid });

    var options = {
        hostname: authUrl.hostname,
        port: authUrl.port,
        path: path,
    };

    var req = proto.request(options, function(response) {
        var data = '';
        response.setEncoding('utf8');
        response.on('data', function (chunk) {
            logger.info('removePolicy data chunk', chunk);
            data += chunk;
        });
        response.on('end', function (){
            if (response.statusCode === 200) {
                return callback(null, pid);
            } else {
                return callback(new ServerError('removePolicy failed'),
                    pid);
            }
        });
    });

    req.on('error', function(e) {
        return callback(e);
    });

    req.end();
}
exports.removePolicy = removePolicy;

function getPolicy(policyRule, token, callback) {
    logger.info('getPolicy', policyRule);
    policyRule.action = JSON.stringify(policyRule.action);
    policyRule.resource = JSON.stringify(policyRule.resource);

    /* TODO: define & use another API such as getpolicy */
    var template = _.template('/webida/api/acl/getownedpolicy?' +
        'access_token=<%= token %>');
    var path = template({ token: token });

    var options = {
        hostname: authUrl.hostname,
        port: authUrl.port,
        path: path,
    };

    var req = proto.request(options, function(response) {
        var data = '';
        response.setEncoding('utf8');
        response.on('data', function (chunk) {
            logger.info('getPolicy data chunk', chunk);
            data += chunk;
        });
        response.on('end', function (){
            if (response.statusCode !== 200) {
                return callback(new ServerError('getPolicy failed'));
            }

            var policies;
            var policy = null;
            try {
                policies = JSON.parse(data).data;
            } catch (e) {
                logger.error('Invalid getownedpolicy response');
                return callback(new ServerError('Invalid getownedpolicy response'));
            }
            policies = _.filter(policies, _.matches(policyRule));
            if (policies.length) {
                policy = policies[0];
            }
            callback(null, policy);
        });
    });

    req.on('error', function(e) {
        return callback(e);
    });

    req.end();
}
exports.getPolicy = getPolicy;

function updatePolicyResource(oldPath, newPath, token, callback) {
    logger.info('updatePolicyResource', oldPath, newPath);
    var path = '/webida/api/acl/updatepolicyrsc' +
        '?src=' + oldPath +
        '&dst=' + newPath +
        '&access_token=' + token;
    var options = {
        hostname: authUrl.hostname,
        port: authUrl.port,
        path: encodeURI(path)
    };

    var req = proto.request(options, function(response) {
        var data = '';
        response.setEncoding('utf8');
        response.on('data', function (chunk) {
            logger.info('updatePolicyResource data chunk', chunk);
            data += chunk;
        });
        response.on('end', function (){
            if (response.statusCode === 200) {
                return callback(null);
            } else {
                return callback(new ServerError('updatePolicyResource failed'));
            }
        });
    });


    req.on('error', function(e) {
        return callback(e);
    });

    req.end();
}
exports.updatePolicyResource = updatePolicyResource;

function getFSInfo(fsid, token, callback) {
    var path = '/webida/api/fs/' + fsid +
        '?access_token=' + token;
    var options = {
        hostname: fsUrl.hostname,
        port: fsUrl.port,
        path: path
    };
    logger.info('getFSInfo', fsid, token, options);

    var req = proto.request(options, function(response) {
        var data = '';
        response.setEncoding('utf8');
        response.on('data', function (chunk) {
            logger.info('getFSInfo data chunk', chunk);
            data += chunk;
        });
        response.on('end', function (){
            if (response.statusCode === 200) {
                try {
                    return callback(null, JSON.parse(data).data);
                } catch (e) {
                    logger.error('Invalid fs response');
                    return callback(new ServerError('Invalid fs response'));
                }
            } else if (response.statusCode === 401) {
                return callback(new ClientError(401, 'Not authorized'));
            } else {
                return callback(new ServerError('Internal error while check createPolicy authority.'));
            }
        });
    });

    req.on('error', function(e) {
        return callback(e);
    });

    req.end();
}
exports.getFSInfo = getFSInfo;
