'use strict';

const EDITING_TYPES = Object.freeze(['virtual_tryon', 'style_transfer', 'subject_replacement', 'background_replacement']);
const EDITING_TYPE_LABELS = Object.freeze({
  virtual_tryon: '虚拟试衣',
  style_transfer: '风格迁移',
  subject_replacement: '主体替换',
  background_replacement: '背景替换',
});

function capabilities() {
  return {
    avatar: true,
    editing: true,
    hot_swap: true,
    editing_types: EDITING_TYPES.slice(),
    editing_type_labels: { ...EDITING_TYPE_LABELS },
    reason: 'Avatar组件版推流到自有RTC；Editing通过sub_user_id订阅Avatar并发布独立结果流。type=13切换参考图，成功无回执，须以画面确认。',
  };
}

function assertEditingType(value) {
  if (!EDITING_TYPES.includes(value)) {
    throw Object.assign(new Error(`editing_type 必须是 ${EDITING_TYPES.join('、')} 之一`), { status: 400 });
  }
  return value;
}

function editingBody(reference, rtc, sourceUserId, editingType = 'virtual_tryon') {
  assertEditingType(editingType);
  if (!sourceUserId || sourceUserId === rtc.user_id) throw new Error('Editing输入与输出用户ID必须不同');
  return {
    image_url: reference,
    editing_type: editingType,
    customer_rtc: { provider: rtc.provider, app_id: rtc.app_id, channel_id: rtc.channel_id, user_id: rtc.user_id, sub_user_id: sourceUserId, token: rtc.token },
  };
}

module.exports = { capabilities, editingBody, assertEditingType, EDITING_TYPES, EDITING_TYPE_LABELS };
