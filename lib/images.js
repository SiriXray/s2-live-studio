'use strict';
const crypto = require('node:crypto');

function imageData(uri) {
  const match = typeof uri === 'string' && uri.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z\d+/]+={0,2})$/);
  if (!match) throw new Error('请上传PNG、JPEG或WebP图片');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 8 * 1024 * 1024 || bytes.length < 12) throw new Error('图片须小于8MB且内容有效');
  const valid = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) throw new Error('图片内容与格式不匹配');
  return { bytes, type: `image/${match[1]}`, id: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function imageUri(uri) {
  if (typeof uri !== 'string') throw new Error('请选择形象图');
  if (uri.startsWith('data:')) { imageData(uri); return uri; }
  const parsed = new URL(uri);
  if (!['https:', 'http:', 's3:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('形象图须为HTTP(S)、S3地址或图片data URI');
  return uri;
}

module.exports = { imageData, imageUri };
