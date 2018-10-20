var cluster = require('cluster');
var scErrors = require('sc-errors');
var InvalidActionError = scErrors.InvalidActionError;
var ProcessExitError = scErrors.ProcessExitError;

var workerInitOptions = JSON.parse(process.env.workerInitOptions);
var processTermTimeout = 10000;
var forceKillTimeout = 15000;
var forceKillSignal = 'SIGHUP';

process.on('disconnect', function () {
  process.exit();
});

var scWorkerCluster;
var workers;
var hasExited = false;
var terminatedCount = 0;
var childExitLookup = {};
var isTerminating = false;
var isForceKillingWorkers = false;

var sendErrorToMaster = function (err) {
  var error = scErrors.dehydrateError(err, true);
  process.send({
    type: 'error',
    data: {
      pid: process.pid,
      error: error
    }
  });
};

var terminateNow = function () {
  if (!hasExited) {
    hasExited = true;
    process.exit();
  }
};

var terminate = function (immediate) {
  if (immediate) {
    terminateNow();
    return;
  }
  if (isTerminating) {
    return;
  }
  isTerminating = true;
  setTimeout(function () {
    terminateNow();
  }, processTermTimeout);
};

var killUnresponsiveWorkersNow = function () {
  (workers || []).forEach(function (worker, i) {
    if (!childExitLookup[i]) {
      process.kill(worker.process.pid, forceKillSignal);
      var errorMessage = 'No exit signal was received by worker with id ' + i +
      ' (PID: ' + worker.process.pid + ') before forceKillTimeout of ' + forceKillTimeout +
      ' ms was reached - As a result, kill signal ' + forceKillSignal + ' was sent to worker';

      var processExitError = new ProcessExitError(errorMessage);
      sendErrorToMaster(processExitError);
    }
  });
  isForceKillingWorkers = false;
};

var killUnresponsiveWorkers = function () {
  childExitLookup = {};
  if (isForceKillingWorkers) {
    return;
  }
  isForceKillingWorkers = true;
  setTimeout(function () {
    killUnresponsiveWorkersNow();
  }, forceKillTimeout);
};

process.on('message', function (masterPacket) {
  if (
    masterPacket.type == 'masterMessage' ||
    masterPacket.type == 'masterRequest' ||
    masterPacket.type == 'masterResponse'
  ) {
    var targetWorker = workers[masterPacket.workerId];
    if (targetWorker) {
      targetWorker.send(masterPacket);
    } else {
      if (masterPacket.type == 'masterMessage') {
        var errorMessage = 'Cannot send message to worker with id ' + masterPacket.workerId +
        ' because the worker does not exist';
        var notFoundError = new InvalidActionError(errorMessage);
        sendErrorToMaster(notFoundError);

      } else if (masterPacket.type == 'masterRequest') {
        var errorMessage = 'Cannot send request to worker with id ' + masterPacket.workerId +
        ' because the worker does not exist';
        var notFoundError = new InvalidActionError(errorMessage);
        sendErrorToMaster(notFoundError);

        process.send({
          type: 'workerClusterResponse',
          error: scErrors.dehydrateError(notFoundError, true),
          data: null,
          workerId: masterPacket.workerId,
          rid: masterPacket.cid
        });
      } else {
        var errorMessage = 'Cannot send response to worker with id ' + masterPacket.workerId +
        ' because the worker does not exist';

        var notFoundError = new InvalidActionError(errorMessage);
        sendErrorToMaster(notFoundError);
      }
    }
  } else {
    if (masterPacket.type == 'terminate') {
      if (masterPacket.data.killClusterMaster) {
        terminate(masterPacket.data.immediate);
      } else {
        killUnresponsiveWorkers();
      }
    }
    (workers || []).forEach(function (worker) {
      worker.send(masterPacket);
    });
  }
});

process.on('uncaughtException', function (err) {
  sendErrorToMaster(err);
  process.exit(1);
});

function SCWorkerCluster(options) {
  if (scWorkerCluster) {
    // SCWorkerCluster is a singleton; it can only be instantiated once per process.
    throw new InvalidActionError('Attempted to instantiate a worker cluster which has already been instantiated');
  }
  options = options || {};
  scWorkerCluster = this;

  if (options.run != null) {
    this.run = options.run;
  }

  this._init(workerInitOptions);
}

SCWorkerCluster.create = function (options) {
  return new SCWorkerCluster(options);
};

SCWorkerCluster.prototype._init = function (options) {
  if (options.schedulingPolicy != null) {
    cluster.schedulingPolicy = options.schedulingPolicy;
  }
  if (options.processTermTimeout != null) {
    processTermTimeout = options.processTermTimeout;
  }
  if (options.forceKillTimeout != null) {
    forceKillTimeout = options.forceKillTimeout;
  }
  if (options.forceKillSignal != null) {
    forceKillSignal = options.forceKillSignal;
  }

  cluster.setupMaster({
    exec: options.paths.appWorkerControllerPath
  });

  var workerCount = options.workerCount;
  var readyCount = 0;
  var isReady = false;
  workers = [];
  this.workers = workers;

  var launchWorker = function (i, respawn) {
    var workerInitOptions = options;
    workerInitOptions.id = i;

    var worker = cluster.fork({
      workerInitOptions: JSON.stringify(workerInitOptions)
    });
    workers[i] = worker;

    worker.on('error', sendErrorToMaster);

    worker.on('message', function (workerPacket) {
      if (workerPacket.type == 'ready') {
        process.send({
          type: 'workerStart',
          data: {
            id: i,
            pid: worker.process.pid,
            respawn: respawn || false
          }
        });

        if (!isReady && ++readyCount >= workerCount) {
          isReady = true;
          process.send({
            type: 'ready'
          });
        }
      } else {
        process.send(workerPacket);
      }
    });

    worker.on('exit', function (code, signal) {
      childExitLookup[i] = true;
      if (!isTerminating) {
        process.send({
          type: 'workerExit',
          data: {
            id: i,
            pid: worker.process.pid,
            code: code,
            signal: signal
          }
        });

        if (options.rebootWorkerOnCrash) {
          launchWorker(i, true);
        }
      } else if (++terminatedCount >= workers.length) {
        if (!hasExited) {
          hasExited = true;
          process.exit();
        }
      }
    });
  };

  for (var i = 0; i < workerCount; i++) {
    launchWorker(i);
  }

  this.run();
};

SCWorkerCluster.prototype.run = function () {};

module.exports = SCWorkerCluster;
