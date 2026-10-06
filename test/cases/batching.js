'use strict';

/*
Request coalescing on v1 real/query: one request with all serials per tick.
*/

const fixtures = require('../fixtures');

module.exports = async (t) => {
  const httpFor = (client) => client.calls.filter((c) => c.path === '/op/v1/device/real/query');

  // three devices, two of them on one serial, all polling in the same tick
  const client = fixtures.makeRoutedClient();
  const [a, b, c] = await Promise.all([
    client.getDeviceRealTimeData({ sn: 'SN-1', variables: ['pvPower'] }),
    client.getDeviceRealTimeData({ sn: 'SN-1', variables: ['SoC', 'batTemperature'] }),
    client.getDeviceRealTimeData({ sn: 'SN-2', variables: ['pvPower', 'feedin'] }),
  ]);

  const sent = httpFor(client);
  t.eq(sent.length, 1, 'three device polls became one HTTP request');
  t.eq([...sent[0].body.sns].sort().join(','), 'SN-1,SN-2', 'serials were unioned into one sns array');
  t.eq([...sent[0].body.variables].sort().join(','), 'SoC,batTemperature,feedin,pvPower'.split(',').sort().join(','), 'variable sets were unioned');
  t.ok(a === b && b === c, 'every caller got the same combined response');

  // a later tick must not reuse the previous batch
  await client.getDeviceRealTimeData({ sn: 'SN-1', variables: ['pvPower'] });
  t.eq(httpFor(client).length, 2, 'the next tick issues its own request');

  // a caller that arrives a few microtasks late - because it awaited something first - must still
  // land in the same batch rather than opening a second request
  const late = fixtures.makeRoutedClient();
  await Promise.all([
    late.getDeviceRealTimeData({ sn: 'SN-1', variables: ['pvPower'] }),
    late.getDeviceRealTimeData({ sn: 'SN-2', variables: ['pvPower'] }),
    (async () => {
      await Promise.resolve();
      await Promise.resolve();
      return late.getDeviceRealTimeData({ sns: ['SN-3'], variables: ['todayYield'] });
    })(),
  ]);
  t.eq(httpFor(late).length, 1, 'a late caller still joins the same batch');

  // a failing batch must reject every waiter, not hang one of them
  const broken = fixtures.makeClient({
    post: async () => {
      throw new Error('boom');
    },
  });
  const results = await Promise.allSettled([
    broken.getDeviceRealTimeData({ sn: 'SN-1', variables: ['pvPower'] }),
    broken.getDeviceRealTimeData({ sn: 'SN-2', variables: ['pvPower'] }),
  ]);
  t.ok(results.every((r) => r.status === 'rejected'), 'a failed batch rejects all of its callers');

  // v1 takes at most 50 serials per request: a larger batch is asked in chunks and joined
  const Client = fixtures.app('lib/FoxEssClient.js');
  const many = Array.from({ length: Client.MAX_SNS_PER_QUERY + 5 }, (_, i) => `SN-${i}`);
  const chunked = fixtures.makeClient({
    post: async ({ body }) => ({
      errno: 0,
      result: JSON.parse(body).sns.map((deviceSN) => ({ deviceSN, datas: [] })),
    }),
  });
  const joined = await Promise.all(many.map((sn) => chunked.getDeviceRealTimeData({ sn, variables: ['pvPower'] })));
  const requests = httpFor(chunked);
  t.eq(requests.length, 2, `${many.length} serials are asked in two requests`);
  t.ok(requests.every((r) => r.body.sns.length <= Client.MAX_SNS_PER_QUERY), 'no request carries more than 50 serials');
  t.eq(joined[0].result.length, many.length, 'every caller gets the answers of all chunks');
};
