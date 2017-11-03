// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2015 Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

console.log('ThingEngine-GNOME starting up...');

const Q = require('q');
const events = require('events');
Q.longStackSupport = true;

const Engine = require('thingengine-core');
const AssistantDispatcher = require('./assistant');

const Config = require('./config');

var _engine, _ad;
var _waitReady;
var _running;
var _stopped;
var platform;

const DBUS_CONTROL_PATH = '/edu/stanford/Almond/BackgroundService';

const DBUS_CONTROL_INTERFACE = {
    name: 'edu.stanford.Almond.BackgroundService',
    methods: {
        Stop: ['', ''],
        GetHistory: ['', 'a(uuua{ss})'],
        HandleCommand: ['s', ''],
        HandleParsedCommand: ['ss', ''],
        StartOAuth2: ['s', '(bsa{ss})'],
        HandleOAuth2Callback: ['sa{sv}', 'b'],
        CreateDevice: ['a{sv}', 'b'],
        DeleteDevice: ['s', 'b'],
        UpgradeDevice: ['s', 'b'],
        GetDeviceInfos: ['', 'aa{sv}'],
        GetDeviceInfo: ['s', 'a{sv}'],
        CheckDeviceAvailable: ['s', 'u'],
        GetAppInfos: ['', 'aa{sv}'],
        DeleteApp: ['s', ''],
        SetCloudId: ['ss', 'b'],
        SetServerAddress: ['sus', 'b']
    },
    signals: {
        'NewMessage': ['uuua{ss}'],
        'RemoveMessage': ['u']
    }
}

// marshall one a{ss} into something that dbus-native will like
function marshallASS(obj) {
    return Object.keys(obj).map((key) => [key, obj[key]]);
}

class AppControlChannel extends events.EventEmitter {
    // handle control methods here...

    Stop() {
        if (_running)
            _engine.stop();
        else
            _stopped = true;
    }

    GetHistory() {
        return _ad.getHistory().then((history) => history.map(([id, type, direction, message]) => [id, type, direction, marshallASS(message)]));
    }

    HandleCommand(command) {
        return _ad.handleCommand(command);
    }

    HandleParsedCommand(title, json) {
        return _ad.handleParsedCommand(title, json);
    }

    StartOAuth2(kind) {
        return _engine.devices.factory.runOAuth2(kind, null).then(function(result) {
            if (result === null)
                return [false, '', {}];
            else
                return [true, result[0], result[1]];
        });
    }

    HandleOAuth2Callback(kind, req) {
        return _engine.devices.factory.runOAuth2(kind, req).then(() => {
            return true;
        });
    }

    CreateDevice(state) {
        return _engine.devices.loadOneDevice(state, true).then(() => {
            return true;
        });
    }

    DeleteDevice(uniqueId) {
        var device = _engine.devices.getDevice(uniqueId);
        if (device === undefined)
            return false;

        _engine.devices.removeDevice(device);
        return true;
    }

    UpgradeDevice(kind) {
        return _engine.devices.factory.updateFactory(kind).then(() => {
            return true;
        });
    }

    GetDeviceInfos() {
        return _waitReady.then(function() {
            var devices = _engine.devices.getAllDevices();

            return devices.map(function(d) {
                return [['uniqueId', ['s', d.uniqueId]],
                        ['name', ['s', d.name || "Unknown device"]],
                        ['description', ['s', d.description || "Description not available"]],
                        ['kind', ['s', d.kind]],
                        ['ownerTier', ['s', d.ownerTier]],
                        ['version', ['u', d.constructor.version || 0]],
                        ['isTransient', ['b', d.isTransient]],
                        ['isOnlineAccount', ['b', d.hasKind('online-account')]],
                        ['isDataSource', ['b', d.hasKind('data-source')]],
                        ['isThingEngine', ['b', d.hasKind('thingengine-system')]]];
            });
        }, function(e) {
            return [];
        });
    }

    GetDeviceInfo(uniqueId) {
        return _waitReady.then(function() {
            var d = _engine.devices.getDevice(uniqueId);
            if (d === undefined)
                throw new Error('Invalid device ' + uniqueId);

            return [['uniqueId', ['s', d.uniqueId]],
                    ['name', ['s', d.name || "Unknown device"]],
                    ['description', ['s', d.description || "Description not available"]],
                    ['kind', ['s', d.kind]],
                    ['ownerTier', ['s', d.ownerTier]],
                    ['version', ['u', d.constructor.version || 0]],
                    ['isTransient', ['b', d.isTransient]],
                    ['isOnlineAccount', ['b', d.hasKind('online-account')]],
                    ['isDataSource', ['b', d.hasKind('data-source')]],
                    ['isThingEngine', ['b', d.hasKind('thingengine-system')]]];
        });
    }

    CheckDeviceAvailable(uniqueId) {
        return _waitReady.then(function() {
            var d = _engine.devices.getDevice(uniqueId);
            if (d === undefined)
                return -1;

            return d.checkAvailable();
        });
    }

    GetAppInfos() {
        return _waitReady.then(function() {
            var apps = _engine.apps.getAllApps();

            return apps.map(function(a) {
                var app =  [['uniqueId', ['s', a.uniqueId]],
                            ['name', ['s', a.name || "Some app"]],
                            ['description', ['s', a.description || a.name || "Some app"]],
                            ['icon', ['s', a.icon || '']],
                            ['isRunning', ['b', a.isRunning]],
                            ['isEnabled', ['b', a.isEnabled]],
                            ['error', ['s', a.error ? a.error.message : '']]];
                return app;
            });
        });
    }

    DeleteApp(uniqueId) {
        return _waitReady.then(function() {
            var app = _engine.apps.getApp(uniqueId);
            if (app === undefined)
                return false;

            return _engine.apps.removeApp(app).then(() => true);
        });
    }

    SetCloudId(cloudId, authToken) {
        if (_engine.devices.hasDevice('thingengine-own-cloud'))
            return false;
        if (!platform.setAuthToken(authToken))
            return false;

        // we used to call loadOneDevice() with thingengine kind, tier: cloud here
        // but is incompatible with syncing the developer key (and causes
        // spurious device database writes)
        // instead we set the platform state and reopen the connection
        platform.getSharedPreferences().set('cloud-id', cloudId);
        _engine.tiers.reopenOne('cloud').done();
        return true;
    }

    SetServerAddress(serverHost, serverPort, authToken) {
        if (_engine.devices.hasDevice('thingengine-own-server'))
            return false;
        if (authToken !== null) {
            if (!platform.setAuthToken(authToken))
                return false;
        }

        _engine.devices.loadOneDevice({ kind: 'org.thingpedia.builtin.thingengine',
                                        tier: 'server',
                                        host: serverHost,
                                        port: serverPort,
                                        own: true }, true).done();
        return true;
    }
}

function main() {
    platform = require('./platform').newInstance();

    console.log('GNOME platform initialized');

    console.log('Creating engine...');
    _engine = new Engine(platform, { thingpediaUrl: process.env.THINGPEDIA_URL || Config.THINGPEDIA_URL });

    _ad = new AssistantDispatcher(_engine, controlChannel);
    platform.setAssistant(_ad);

    var controlChannel = new AppControlChannel();
    _ad.on('NewMessage', (id, type, direction, msg) => controlChannel.emit('NewMessage', id, type, direction, marshallASS(msg)));
    _ad.on('RemoveMessage', (id) => controlChannel.emit('RemoveMessage', id));

    var bus = platform.getCapability('dbus-session');
    bus.exportInterface(controlChannel, '/edu/stanford/Almond/BackgroundService', DBUS_CONTROL_INTERFACE);

    Q.ninvoke(bus, 'requestName', 'edu.stanford.Almond.BackgroundService', 0).then(function() {
        console.log('Control channel ready');

        _waitReady = Promise.all([_engine.open(), _ad.start()]);
        return _waitReady;
    }).then(function() {
        _ad.startConversation();
        _running = true;
        if (_stopped)
            return;
        return _engine.run();
    }).catch(function(error) {
        console.log('Uncaught exception: ' + error.message);
        console.log(error.stack);
    }).finally(function() {
        return _engine.close();
    }).catch(function(error) {
        console.log('Exception during stop: ' + error.message);
        console.log(error.stack);
    }).finally(function() {
        console.log('Cleaning up');
        platform.exit();
    }).done();
}

main();

