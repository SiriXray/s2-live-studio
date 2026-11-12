'use strict';
/**
 * RTC token 签发。三家 provider 的签名密钥只在服务端使用，不下发浏览器。
 *
 * - ARTC (阿里云)   : sha256(appId + appKey + channelId + userId + timestamp)
 * - TRTC (腾讯云)   : UserSig = base64(zlib(json + hmac-sha256 签名))
 * - Agora (声网)    : AccessToken2 ("007" 前缀)
 */
const crypto = require('crypto');
const zlib = require('zlib');

// ───────────────────────── ARTC（阿里云 RTC）─────────────────────────

/**
 * 阿里云 RTC token。算法与 Vidu 文档一致：
 *   token = sha256(appId + appKey + channelId + userId + timestamp)
 * timestamp 为过期时间的 Unix 秒。
 */
function artcToken({ appId, appKey, channelId, userId, timestamp }) {
  return crypto
    .createHash('sha256')
    .update(`${appId}${appKey}${channelId}${userId}${timestamp}`, 'utf8')
    .digest('hex');
}

// ───────────────────────── TRTC（腾讯云）─────────────────────────

/**
 * 腾讯云 TRTC UserSig。
 * 注意 UserSig 不绑定房间号（房间由客户端 join 时指定）。
 */
function trtcUserSig({ sdkAppId, secretKey, userId, ttlSeconds }) {
  const now = Math.floor(Date.now() / 1000);
  const base = {
    'TLS.ver': '2.0',
    'TLS.identifier': String(userId),
    'TLS.sdkappid': Number(sdkAppId),
    'TLS.expire': Number(ttlSeconds),
    'TLS.time': now,
  };

  // 待签名串的字段顺序是协议的一部分，不能改。
  const content =
    `TLS.identifier:${base['TLS.identifier']}\n` +
    `TLS.sdkappid:${base['TLS.sdkappid']}\n` +
    `TLS.time:${base['TLS.time']}\n` +
    `TLS.expire:${base['TLS.expire']}\n`;

  base['TLS.sig'] = crypto
    .createHmac('sha256', secretKey)
    .update(content, 'utf8')
    .digest('base64');

  const compressed = zlib.deflateSync(Buffer.from(JSON.stringify(base), 'utf8'));
  // TRTC 使用 base64 变体：+/ → *- ，= → _
  return compressed
    .toString('base64')
    .replace(/\+/g, '*')
    .replace(/\//g, '-')
    .replace(/=/g, '_');
}

// ───────────────────────── Agora（声网）AccessToken2 ─────────────────────────

const AGORA_VERSION = '007';
const SERVICE_TYPE_RTC = 1;
// RTC 权限位
const PRIV_JOIN_CHANNEL = 1;
const PRIV_PUBLISH_AUDIO = 2;
const PRIV_PUBLISH_VIDEO = 3;
const PRIV_PUBLISH_DATA = 4;

function packUint16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
}
function packUint32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return b;
}
function packString(s) {
  const body = Buffer.from(s || '', 'utf8');
  return Buffer.concat([packUint16(body.length), body]);
}
/** map<uint16, uint32>，按 key 升序 */
function packMapUint32(map) {
  const keys = Object.keys(map)
    .map(Number)
    .sort((a, b) => a - b);
  const parts = [packUint16(keys.length)];
  for (const k of keys) parts.push(packUint16(k), packUint32(map[k]));
  return Buffer.concat(parts);
}

/**
 * 声网 AccessToken2。
 *
 * ⚠️ 未经真实 App Certificate 验证。本函数按 AccessToken2 公开规范实现，
 * 单测只覆盖了结构（版本前缀、可解压、字段可回读）。正式接入声网前，
 * 请用官方 SDK 生成一个 token 做交叉比对，或直接改用官方 SDK 签发。
 * ARTC 与 TRTC 两条链路不受此影响。
 */
function agoraAccessToken2({ appId, appCertificate, channelId, userId, ttlSeconds }) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expire = issuedAt + Number(ttlSeconds);
  const salt = crypto.randomInt(1, 0xffffffff);

  const privileges = {
    [PRIV_JOIN_CHANNEL]: expire,
    [PRIV_PUBLISH_AUDIO]: expire,
    [PRIV_PUBLISH_VIDEO]: expire,
    [PRIV_PUBLISH_DATA]: expire,
  };

  // service = type + privileges + channelName + uid
  const service = Buffer.concat([
    packUint16(SERVICE_TYPE_RTC),
    packMapUint32(privileges),
    packString(channelId),
    packString(String(userId)),
  ]);

  // signing key = hmac(appCertificate, issuedAt) 再 hmac salt
  const k1 = crypto.createHmac('sha256', Buffer.from(appCertificate, 'utf8')).update(packUint32(issuedAt)).digest();
  const signingKey = crypto.createHmac('sha256', k1).update(packUint32(salt)).digest();

  const toSign = Buffer.concat([packString(appId), packUint32(issuedAt), packUint32(expire), packUint32(salt), service]);
  const signature = crypto.createHmac('sha256', signingKey).update(toSign).digest();

  const body = Buffer.concat([
    packString(signature.toString('binary')),
    packString(appId),
    packUint32(issuedAt),
    packUint32(expire),
    packUint32(salt),
    packUint16(1), // service count
    service,
  ]);

  return AGORA_VERSION + zlib.deflateSync(body).toString('base64');
}

// ───────────────────────── 统一入口 ─────────────────────────

/**
 * 按 provider 签发 token。返回给浏览器的字段里不含任何密钥。
 * @returns {{provider,app_id,channel_id,user_id,token,timestamp}}
 */
function signToken(provider, rtcConfig, channelId, userId) {
  switch (provider) {
    case 'artc': {
      const c = rtcConfig.artc || {};
      if (!c.app_id || !c.app_key) throw new Error('rtc.artc.app_id / app_key 未配置');
      const ttl = Number(c.token_ttl_seconds) || 3600;
      const timestamp = Math.floor(Date.now() / 1000) + ttl;
      return {
        provider,
        app_id: c.app_id,
        channel_id: channelId,
        user_id: userId,
        token: artcToken({ appId: c.app_id, appKey: c.app_key, channelId, userId, timestamp }),
        timestamp,
      };
    }
    case 'agora': {
      const c = rtcConfig.agora || {};
      if (!c.app_id || !c.app_certificate) throw new Error('rtc.agora.app_id / app_certificate 未配置');
      const ttl = Number(c.token_ttl_seconds) || 3600;
      return {
        provider,
        app_id: c.app_id,
        channel_id: channelId,
        user_id: userId,
        token: agoraAccessToken2({
          appId: c.app_id,
          appCertificate: c.app_certificate,
          channelId,
          userId,
          ttlSeconds: ttl,
        }),
        timestamp: Math.floor(Date.now() / 1000) + ttl,
      };
    }
    case 'trtc': {
      const c = rtcConfig.trtc || {};
      if (!c.sdk_app_id || !c.secret_key) throw new Error('rtc.trtc.sdk_app_id / secret_key 未配置');
      const ttl = Number(c.token_ttl_seconds) || 3600;
      return {
        provider,
        app_id: String(c.sdk_app_id),
        channel_id: channelId,
        user_id: userId,
        token: trtcUserSig({ sdkAppId: c.sdk_app_id, secretKey: c.secret_key, userId, ttlSeconds: ttl }),
        timestamp: Math.floor(Date.now() / 1000) + ttl,
      };
    }
    default:
      throw new Error(`未知 provider: ${provider}（支持 artc / agora / trtc）`);
  }
}

module.exports = { signToken, artcToken, trtcUserSig, agoraAccessToken2 };
