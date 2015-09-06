/**
 * Created by xiayongfeng on 2014/8/20.
 */

// server是否输出debug信息
var DEBUG_LOG = true;

var app = require('http').createServer(monitor),
    io = require('socket.io').listen(app, {origins: "*:*", log: DEBUG_LOG});

io.setMaxListeners(0);

//var cookieParser = require('cookie');
var request = require('request');
var flow = require('nimble');
var urlParser = require('url');
var qsParser = require('querystring');

// 日志记录
var Log = require('log'),
    fs = require('fs'),
    logger = new Log('debug', fs.createWriteStream('app.log'));


// 用于根据cookie验证用户身份
// 记得设置
var AUTH_API = '';
// 用于校验后端请求的token
// 记得设置
var TOKEN_FOR_BACKEND = '';

// 存储socket连接
var userSocketMapper = {
        'site_message': {}
    },
    socketUserMapper = {};

// connection失败的响应
var responseFailure = function (socket) {
    socket.emit('ok', 'NO');
    socket.disconnect('unauthorized');
};

// 监控页面
function monitor(req, res) {
    var urlObj = urlParser.parse(req.url),
        queryArgs = qsParser.parse(urlObj.query);
    if (queryArgs.token !== TOKEN_FOR_BACKEND || /^\/info\/?$/.test(urlObj.pathname) === false) {
        res.statusCode = 404;
        res.end('不存在该页面！');
        return;
    }

    res.setHeader('Content-Type', 'application/json');
    var connectionCount = 0,
        namespaceUserSocketMapper = {},
        namespaceList,
        namespaceUserList,
        namespaceUserSocketList;

    // keys: namespace
    namespaceList = Object.keys(userSocketMapper);
    namespaceUserSocketMapper.__namespace_count = namespaceList.length;
    namespaceList.forEach(function (item) {
        // keys: user_id
        namespaceUserList = Object.keys(userSocketMapper[item]);
        namespaceUserSocketMapper[item] = {__user_count: namespaceUserList.length};
        Object.keys(userSocketMapper[item]).forEach(function (innerItem) {
            // keys: socket_id
            namespaceUserSocketList = Object.keys(userSocketMapper[item][innerItem]);
            namespaceUserSocketMapper[item][innerItem] = {__connection_count: namespaceUserSocketList.length};
            connectionCount += namespaceUserSocketList.length;
        });
    });
    var serverInfo = {
        connection_count: connectionCount,
        namespace_user_socket_mapper: namespaceUserSocketMapper
    };
    res.end(JSON.stringify(serverInfo, null, "    "));
}

// 站内信
var siteMessage = io.of('/site_message');
siteMessage.on('connection', function (socket) {
    // 如何解析cookie？
    // var cookies = cookieParser.parse(socket.manager.handshaken[socket.id].headers.cookie);
    // console.log(cookies);

    var cookies = socket.manager.handshaken[socket.id].headers.cookie;
    var userID = -1;

    var requestOptions = {
        url: AUTH_API,
        headers: {
            Cookie: cookies
        }
    };

    // 串行化
    flow.series([
        //
        function (callback) {
            // 基于Cookie进行身份验证
            request.get(requestOptions, function (error, response, body) {
                if (error) {
                    logger.warning('Failed to request ' + AUTH_API + ', error: ' + error);
                    callback();
                    return;
                }
                if (response.statusCode == 200) {
                    var respContent;
                    try {
                        respContent = JSON.parse(body);
                    } catch (err) {
                        logger.warning('Failed to parse response body, body: ' + body + ', error: ' + err);
                        callback();
                        return;
                    }
                    if (respContent.code == 200) {
                        userID = respContent.user_id;
                    } else {
                        logger.warning('failed to identify user, result: ' + JSON.stringify(respContent));
                    }
                    callback();
                    return;
                }
                logger.warning(AUTH_API + ', response error, statusCode: ' + response.statusCode);
                callback();
            });
        },
        //
        function (callback) {
            if (userID == -1) {
                logger.info('Failed to check user with cookie, cookie: ' + JSON.stringify(cookies));
                responseFailure(socket);
                callback();
                return;
            }

            var siteMsgUserSockets = userSocketMapper.site_message,
                userIDExist = siteMsgUserSockets.hasOwnProperty(userID);

            // 限定一个用户同时仅能有20个连接
            if (userIDExist && Object.keys(siteMsgUserSockets[userID]).length >= 20) {
                responseFailure(socket);
                callback();
                return;
            }

            if (!userIDExist) {
                siteMsgUserSockets[userID] = {};
            }
            // 存储当前socket用于之后的多播
            siteMsgUserSockets[userID][socket.id] = socket;
            socketUserMapper[socket.id] = userID;
            // 响应一个事件？可以省略
            socket.emit('ok', 'YES');
            callback();
        }
    ]);

    // 客户端关闭连接时的处理
    socket.on('disconnect', function () {
        console.log('socket disconnect');
        if (socketUserMapper.hasOwnProperty(socket.id)) {
            var userID = socketUserMapper[socket.id];
            if (userSocketMapper.site_message[userID].hasOwnProperty(socket.id)) {
                delete userSocketMapper.site_message[userID][socket.id];
                if (Object.keys(userSocketMapper.site_message[userID]).length === 0) {
                    delete userSocketMapper.site_message[userID];
                }
            }
            delete socketUserMapper[socket.id];
        }
    });
});

var siteMessageBackend = io.of('/site_message_backend');
siteMessageBackend.on('connection', function (socket) {
    socket.on('new_message_from_backend', function (data) {
        // 校验token
        if (!data.hasOwnProperty('token') || data.token != TOKEN_FOR_BACKEND
            || !data.hasOwnProperty('msg_type')
            || (data.msg_type != 'public' && !data.hasOwnProperty('user_id'))
            ) {
            logger.warning('Can not identify this request event, data: ' + JSON.stringify(data));
            socket.disconnect('invalid message');
            return;
        }

        // 广播public消息
        if (data.msg_type === 'public') {
            siteMessage.emit('new-message', data.message);
            // 提示有新消息
            siteMessage.emit('has-new-msg', {has_new: true});
            return;
        }

        // 私有消息
        if (userSocketMapper.site_message.hasOwnProperty(data.user_id)) {
            var siteMsgUserSockets = userSocketMapper.site_message[data.user_id];
            for (var socketID in siteMsgUserSockets) {
                if (siteMsgUserSockets.hasOwnProperty(socketID)) {
                    siteMsgUserSockets[socketID].emit('new-message', data.message);
                    // 提示有新消息
                    siteMsgUserSockets[socketID].emit('has-new-msg', {has_new: true});
                }
            }
            return;
        }
        // 是否需要记录不存在当前user_id的实时连接的消息推送？
    });
});


app.listen(8899);
