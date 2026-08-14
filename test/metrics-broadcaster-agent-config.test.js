import assert from 'node:assert/strict';
import test from 'node:test';
import { MetricsBroadcaster } from '../src/durable/MetricsBroadcaster.js';

globalThis.WebSocketRequestResponsePair = class WebSocketRequestResponsePair {
  constructor(request, response) {
    this.request = request;
    this.response = response;
  }
};

function makeBroadcaster(webSockets = []) {
  return new MetricsBroadcaster({
    setWebSocketAutoResponse() {},
    getWebSockets() {
      return webSockets;
    },
    storage: {
      async get() {
        return null;
      },
      async put() {}
    }
  }, { DB: {} });
}

function makeDescriptor(md5 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') {
  return {
    serialized: 'collect_interval=0&report_interval=60&reset_day=1&schema_version=3&custom_ct=&custom_cu=&custom_cm=&custom_bd=&interface=',
    md5,
    config: {
      collect_interval: 0,
      report_interval: 60,
      reset_day: 1,
      schema_version: 3,
      custom_ct: '',
      custom_cu: '',
      custom_cm: '',
      custom_bd: '',
      interface: ''
    },
    correction: null
  };
}

test('WSS agent config state only requests ack for fields in current report', () => {
  const broadcaster = makeBroadcaster();
  assert.deepEqual(
    broadcaster._getAgentConfigState({}, { configSchema: '3', configMd5: 'none' }),
    { schema: '3', md5: 'none', requested: false }
  );
  assert.deepEqual(
    broadcaster._getAgentConfigState({ config_md5: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, { configSchema: '3', configMd5: 'none' }),
    { schema: '3', md5: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', requested: true }
  );
});

test('WSS agent ack suggests realtime or idle report interval', () => {
  const broadcaster = makeBroadcaster();
  assert.equal(broadcaster._getAgentNextWssReportAfterMs(60000, true), 3000);
  assert.equal(broadcaster._getAgentNextWssReportAfterMs(60000, false), 60000);
  assert.equal(broadcaster._getAgentNextWssReportAfterMs(30000, true), 2000);
});

test('WSS agent context uses current report interval from payload', async () => {
  const broadcaster = makeBroadcaster();
  let serialized = null;
  const context = await broadcaster._resolveAgentContext({
    serializeAttachment(value) {
      serialized = value;
    }
  }, {
    kind: 'agent-report',
    authenticated: true,
    serverId: 'server-1',
    historyPartitionId: 42,
    reportIntervalMs: 60000,
    configSchema: '3',
    configMd5: 'none'
  }, {
    id: 'server-1',
    report_interval: 120
  });

  assert.equal(context.reportIntervalMs, 120000);
  assert.equal(serialized.reportIntervalMs, 120000);
});

test('WSS agent config ack is skipped when report omits config state', async () => {
  const broadcaster = makeBroadcaster();
  let loads = 0;
  broadcaster._loadAgentConfigDescriptor = async () => {
    loads += 1;
    return makeDescriptor();
  };

  const ack = await broadcaster._buildAgentConfigAck({
    attachment: {
      configSchema: '3',
      configMd5: 'none'
    },
    serverId: 'server-1',
    agentConfig: { schema: '3', md5: 'none', requested: false }
  });

  assert.equal(loads, 0);
  assert.equal(ack, null);
});

test('WSS agent config ack is built when report includes config state', async () => {
  const broadcaster = makeBroadcaster();
  let loads = 0;
  broadcaster._loadAgentConfigDescriptor = async () => {
    loads += 1;
    return makeDescriptor();
  };

  const ack = await broadcaster._buildAgentConfigAck({
    attachment: {},
    serverId: 'server-1',
    agentConfig: { schema: '3', md5: 'none', requested: true }
  });

  assert.equal(loads, 1);
  assert.equal(ack.has_config, true);
  assert.equal(ack.config_md5, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(ack.body, makeDescriptor().serialized);
  assert.equal(ack.config_body, makeDescriptor().serialized);
  assert.equal(ack.payload.report_interval, 60);
  assert.equal(Object.prototype.hasOwnProperty.call(ack, 'config'), false);
});

test('WSS agent config push uses string body and structured payload', () => {
  const sent = [];
  const ws = {
    deserializeAttachment() {
      return {
        kind: 'agent-report',
        authenticated: true,
        serverId: 'server-1',
        configSchema: '3',
        configMd5: 'none'
      };
    },
    send(message) {
      sent.push(JSON.parse(message));
    }
  };
  const broadcaster = makeBroadcaster([ws]);

  const result = broadcaster._pushAgentConfigFrame('server-1', makeDescriptor());

  assert.deepEqual(result, { matched: 1, delivered: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'config');
  assert.equal(sent[0].body, makeDescriptor().serialized);
  assert.equal(sent[0].config_body, makeDescriptor().serialized);
  assert.equal(sent[0].payload.report_interval, 60);
  assert.equal(Object.prototype.hasOwnProperty.call(sent[0], 'config'), false);
});
