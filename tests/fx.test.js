'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createEffects, GIFT_FX, buildFxPayload, videoPlan } = require('../lib/effects');

function store() {
  return { vidu: { host: 'api.vidu.cn', api_key: 'Token test' } };
}

test('GIFT_FX 目录包含 4 个具名直播特效模板且参数正确', () => {
  assert.equal(GIFT_FX.wizard_of_oz.template, 'wizard_of_oz');
  assert.equal(GIFT_FX.wizard_of_oz.host, 'api.vidu.com');
  assert.equal(GIFT_FX.wizard_of_oz.aspect_ratio, '1:1');
  assert.equal(GIFT_FX.wizard_of_oz.bgm, true);
  assert.equal(GIFT_FX.angel_wings.template, 'Angel_Wings_live');
  assert.equal(GIFT_FX.angel_wings.host, 'api.vidu.com');
  assert.equal(GIFT_FX.boxing_punch.template, 'Live_boxing_punch');
  assert.equal(GIFT_FX.boxing_punch.host, 'api.vidu.cn');
  assert.equal(GIFT_FX.boxing_punch.aspect_ratio, '9:16');
  assert.equal(GIFT_FX.boxing_punch.enhance, false);
  assert.equal(GIFT_FX.cream_prank.template, 'Live_cream_smearing_prank');
  assert.equal(GIFT_FX.cream_prank.icon, '🎂');
  for (const fx of Object.values(GIFT_FX)) {
    assert.ok(fx.label && fx.icon, `${fx.key} 需要中文标签与图标`);
  }
});

test('buildFxPayload 按目录生成具名模板请求体', () => {
  const payload = buildFxPayload(GIFT_FX.boxing_punch, 'img://avatar');
  assert.deepEqual(payload, {
    template: 'Live_boxing_punch', images: ['img://avatar'],
    aspect_ratio: '9:16', bgm: true, enhance: false,
  });
  const oz = buildFxPayload(GIFT_FX.wizard_of_oz, 'img://avatar');
  assert.equal(oz.template, 'wizard_of_oz');
  assert.equal(oz.aspect_ratio, '1:1');
  assert.equal(oz.bgm, true);
  assert.ok(!('enhance' in oz), '未定义 enhance 时不写该字段');
});

test('buildFxPayload 调用方可覆盖 aspect_ratio/bgm/enhance', () => {
  const payload = buildFxPayload(GIFT_FX.wizard_of_oz, 'img', { aspect_ratio: '9:16', bgm: false });
  assert.equal(payload.aspect_ratio, '9:16');
  assert.equal(payload.bgm, false);
});

test('buildFxPayload 缺少形象图或目录项时报错', () => {
  assert.throws(() => buildFxPayload(GIFT_FX.wizard_of_oz, ''), /形象图/);
  assert.throws(() => buildFxPayload(null, 'img'), /template/);
});

test('createTask 走 fx 具名模板：dry_run 记录 host 与 payload', async () => {
  const effects = createEffects({ dataDir: 'data-test-fx', dryRun: true });
  const task = await effects.createTask(store(), { kind: 'effect', fx: 'wizard_of_oz', image_uri: 'img://a' });
  assert.equal(task.fx, 'wizard_of_oz');
  assert.equal(task.host, 'api.vidu.com');
  assert.equal(task.state, 'dry_run');
  assert.equal(task.payload.template, 'wizard_of_oz');
  assert.equal(task.payload.aspect_ratio, '1:1');
  assert.equal(task.payload.bgm, true);
});

test('createTask 未知 fx 回落到普通目录（服务端已在入口拦截）', async () => {
  const effects = createEffects({ dataDir: 'data-test-fx', dryRun: true });
  const task = await effects.createTask(store(), { kind: 'effect', fx: 'not_exist', image_uri: 'img://a' });
  assert.equal(task.fx, undefined);
  assert.equal(task.payload.template, 'motion_control_2');
});

test('createMotionSync dry_run 记录 image2dance 参数', async () => {
  const effects = createEffects({ dataDir: 'data-test-fx', dryRun: true });
  const task = await effects.createMotionSync(store(), { image_uri: 'img://a', video_url: 'https://cdn.example.com/dance.mp4' });
  assert.equal(task.kind, 'motion_sync');
  assert.equal(task.state, 'dry_run');
  assert.deepEqual(task.payload, { image_url: 'img://a', video_url: 'https://cdn.example.com/dance.mp4' });
});

test('createMotionSync 校验参考视频须为公网 URL 或 ssupload 引用', async () => {
  const effects = createEffects({ dataDir: 'data-test-fx', dryRun: true });
  await assert.rejects(
    () => effects.createMotionSync(store(), { image_uri: 'img://a', video_url: 'not-a-url' }),
    /参考视频/,
  );
});

test('真实模式下 fx 特效请求发往目录指定的 host', async () => {
  const calls = [];
  const effects = createEffects({
    dataDir: 'data-test-fx', dryRun: false,
    transport: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ task_id: 'vx-1', state: 'processing' }) };
    },
  });
  const task = await effects.createTask(store(), { kind: 'effect', fx: 'cream_prank', image_uri: 'img://a' });
  assert.equal(task.task_id, 'vx-1');
  assert.equal(calls[0].url, 'https://api.vidu.cn/ent/v2/template');
  assert.equal(calls[0].body.template, 'Live_cream_smearing_prank');
  assert.equal(calls[0].body.aspect_ratio, '9:16');
  assert.equal(calls[0].body.enhance, false);
});

/* ---------- Motion Sync 上传管线（实测 2026-11-04：ssupload 必须三步走完，缺 finish 报 ImageFormatInvalid） ---------- */

function mockTransport(log, imageBuffer) {
  return async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/tools/v2/files/uploads') && init.method === 'POST') {
      log.push(['create', JSON.parse(init.body)]);
      return { ok: true, json: async () => ({ id: 'up-1', put_url: 'https://s3.example/put' }) };
    }
    if (u === 'https://s3.example/put') {
      log.push(['put', { meta: init.headers?.['x-amz-meta-image-width'], bytes: init.body?.length }]);
      return { ok: true, headers: { get: k => (k.toLowerCase() === 'etag' ? '"etag-1"' : null) } };
    }
    if (u.includes('/finish')) {
      log.push(['finish', JSON.parse(init.body)]);
      return { ok: true, json: async () => ({}) };
    }
    if (/^https?:\/\//.test(u) && !init.method && imageBuffer) {
      log.push(['download', u]);
      return { ok: true, arrayBuffer: async () => imageBuffer.slice().buffer };
    }
    log.push(['image2dance', JSON.parse(init.body)]);
    return { ok: true, json: async () => ({ task_id: 'ms-1', state: 'processing' }) };
  };
}

const ONE_PX_JPG = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00fbfa28a2803ffd9'.match(/../g).map(h => parseInt(h, 16)),
);

test('Motion Sync 真实模式：data URI 形象图自动走 create→PUT→finish 转 ssupload', async () => {
  const log = [];
  const effects = createEffects({ dataDir: 'data-test-fx', dryRun: false, transport: mockTransport(log, null) });
  const task = await effects.createMotionSync(store(), { image_uri: `data:image/jpeg;base64,${ONE_PX_JPG.toString('base64')}`, video_url: 'ssupload:?id=vid-9' });
  assert.equal(task.task_id, 'ms-1');
  const names = log.map(x => x[0]);
  assert.deepEqual(names, ['create', 'put', 'finish', 'image2dance']);
  assert.equal(log[0][1].metadata['image-width'], '1', 'JPG 尺寸应被解析进 metadata');
  assert.equal(log[2][1].etag, '"etag-1"', 'finish 必须带 ETag');
  assert.equal(log[3][1].video_url, 'ssupload:?id=vid-9', 'ssupload 引用直接透传');
  assert.match(log[3][1].image_url, /^ssupload:\?id=up-1$/, '形象图须转为 ssupload 引用');
});

test('Motion Sync 真实模式：公网形象图先下载再上传，ssupload 视频透传', async () => {
  const log = [];
  const effects = createEffects({ dataDir: 'data-test-fx', dryRun: false, transport: mockTransport(log, ONE_PX_JPG) });
  await effects.createMotionSync(store(), { image_uri: 'https://cdn.example.com/a.jpg', video_url: 'ssupload:?id=vid-2' });
  const names = log.map(x => x[0]);
  assert.deepEqual(names, ['download', 'create', 'put', 'finish', 'image2dance']);
  assert.equal(log[4][1].image_url, 'ssupload:?id=up-1');
  assert.equal(log[4][1].video_url, 'ssupload:?id=vid-2');
});

test('Motion Sync dry_run 不发起上传且 payload 截断防膨胀', async () => {
  const log = [];
  const effects = createEffects({ dataDir: 'data-test-fx', dryRun: true, transport: mockTransport(log, null) });
  const big = `data:image/jpeg;base64,${'A'.repeat(5000)}`;
  const task = await effects.createMotionSync(store(), { image_uri: big, video_url: 'https://cdn.example.com/d.mp4' });
  assert.equal(log.length, 0, 'dry_run 不应产生任何请求');
  assert.ok(task.payload.image_url.length <= 48);
});

test('Motion Sync 校验参考视频格式与图源类型', async () => {
  const effects = createEffects({ dataDir: 'data-test-fx', dryRun: false, transport: mockTransport([], null) });
  await assert.rejects(() => effects.createMotionSync(store(), { image_uri: 'img', video_url: 'https://x/d.mp4' }), /形象图/);
});

test('uploadMedia 缺 ETag 时报错（finish 无法确认）', async () => {
  const transport = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/tools/v2/files/uploads') && init.method === 'POST') return { ok: true, json: async () => ({ id: 'up-1', put_url: 'https://s3.example/put' }) };
    if (u === 'https://s3.example/put') return { ok: true, headers: { get: () => null } };
    return { ok: true, json: async () => ({}) };
  };
  const effects = createEffects({ dataDir: 'data-test-fx', dryRun: false, transport });
  await assert.rejects(
    () => effects.uploadMedia(store(), { buffer: Buffer.from('x'), content_type: 'image/jpeg', metadata: {} }),
    /ETag/,
  );
});

/* ---------- 参考视频适配：image2dance 要求宽高 ≤2048px、2-30 秒（实测 1440×2560 报 InternalServiceFailure） ---------- */

test('videoPlan 合规视频原样通过', () => {
  assert.deepEqual(videoPlan({ width: 1080, height: 1920, duration: 6.1 }), { scale: 1, trim: false, width: 1080, height: 1920 });
});

test('videoPlan 超限等比缩到 2048 以内并保持偶数', () => {
  const plan = videoPlan({ width: 1440, height: 2560, duration: 6.1 });
  assert.equal(plan.scale, 0.8);
  assert.equal(plan.height, 2048);
  assert.equal(plan.width % 2, 0);
  assert.equal(plan.trim, false);
});

test('videoPlan 超 30 秒标记裁剪', () => {
  const plan = videoPlan({ width: 720, height: 1280, duration: 47 });
  assert.equal(plan.trim, true);
  assert.equal(plan.scale, 1);
});

test('videoPlan 时长不足 2 秒报错', () => {
  assert.throws(() => videoPlan({ width: 720, height: 1280, duration: 1 }), /2-30 秒/);
  assert.throws(() => videoPlan({ width: 720, height: 1280, duration: 0 }), /2-30 秒/);
});

test('Motion Sync 真实模式：超限参考视频先转码再上传', async () => {
  const log = [];
  const transport = mockTransport(log, ONE_PX_JPG);
  const effects = createEffects({
    dataDir: 'data-test-fx', dryRun: false, transport,
    probeVideo: async () => ({ width: 1440, height: 2560, duration: 6.11 }),
    transcodeVideo: async (input, output, plan) => { log.push(['transcode', plan]); require('node:fs').writeFileSync(output, Buffer.from('mp4')); return output; },
  });
  const task = await effects.createMotionSync(store(), { image_uri: 'https://cdn.example.com/a.jpg', video_url: `data:video/mp4;base64,${Buffer.from('fake-mp4').toString('base64')}` });
  assert.equal(task.task_id, 'ms-1');
  const transcode = log.find(x => x[0] === 'transcode');
  assert.ok(transcode, '超限视频必须触发转码');
  assert.equal(transcode[1].height, 2048);
});

test('prepareVideo 直传 ssupload 引用时不下载不转码', async () => {
  const log = [];
  const effects = createEffects({ dataDir: 'data-test-fx', dryRun: false, transport: mockTransport(log, null) });
  const ref = await effects.prepareVideo(store(), 'ssupload:?id=vid-1');
  assert.equal(ref, 'ssupload:?id=vid-1');
  assert.equal(log.length, 0);
});
