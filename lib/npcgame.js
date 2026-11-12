'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * 互动影游 NPC 对话引擎（《互动影游规划设计》多剧本架构）：
 * 玩家不是发弹幕，而是带着背景设定与 NPC 对话；LLM 实时评估回应加减数值，
 * 阈值触发剧情事件（递参考图/自白/危机），会话摘要写入记忆库。
 *
 * 剧本注册表 STORIES：每个剧本含开局场景、数值定义、评估规则、阈值事件、
 * 追问话题、道具递送（参考图端详/换装）、角色提示词。
 */

/* ============================================================
 * 剧本一：心动合租时光（夏栀/林小满 · Pack03）
 * ============================================================ */
const HEART_HOUSE = {
  id: 'heart_house',
  title: '心动合租时光',
  entry_persona: 'npc_xia_zhi',
  personas: ['npc_xia_zhi'],
  player: '刚搬进来的新室友',
  metrics: [
    { id: 'xia_zhi', name: '夏栀', cap: 80 },
    { id: 'xiao_man', name: '小满', cap: 80 },
  ],
  speakers: ['xia_zhi', 'xiao_man'],
  speaker_names: { xia_zhi: '夏栀', xiao_man: '林小满' },
  intro: {
    scene: 1,
    scene_text: '你拖着行李箱站在合租公寓门口，门虚掩着。厨房飘来煎蛋的香气，客厅里另一个房间的门关着，隐约传出游戏音效。开门的是夏栀——围裙上还沾着一点面粉。',
    choices: [
      { key: 'A', label: '「红烧肉管够吗？我带了老家辣酱」（自来熟）', metrics: { xia_zhi: 15 }, next_scene: '2-A', style: '自来熟' },
      { key: 'B', label: '「谢谢，我东西不多，不添麻烦」（拘谨）', metrics: { xia_zhi: 5, xiao_man: 5 }, next_scene: '2-B', style: '拘谨' },
      { key: 'C', label: '直接敲林小满的门（冷开局）', metrics: { xia_zhi: -3, xiao_man: 10 }, next_scene: '2-C', style: '冷开局' },
    ],
  },
  scene_texts: {
    '2-A': '夏栀愣了一下，随即笑出声：「红烧肉？！你还带辣酱——行，今晚加菜！你老家哪的？」（她明显放松了下来，厨房的煎蛋都差点忘了翻面。）',
    '2-B': '夏栀点点头，帮你把行李箱推进门：「客气什么呀，住久了就知道了，我这人好相处。……应该吧。」（她有点没话找话地擦了擦本来就很干净的桌子。）',
    '2-C': '你绕过夏栀，直接敲了敲关着的房门。三秒后，门开了一条缝，一只戴着耳机的小满探出头：「……新来的？」夏栀在身后小声嘀咕了一句什么。',
  },
  rules: {
    xia_zhi: [
      { match: '幽默', delta: 2, note: '接梗、自嘲、逗笑她' },
      { match: '真诚', delta: 3, note: '认真回答她的问题、讲真实的自己' },
      { match: '油腻话术', delta: -4, note: '土味情话、过度撩拨、居高临下' },
    ],
    xiao_man: [
      { match: '聊游戏/音乐', delta: 2, note: '接她的话题、问她玩什么、懂她听的歌' },
      { match: '聊隐私', delta: -5, note: '追问她房间/耳机/不出来的原因' },
      { match: '真诚', delta: 3, note: '不越界、尊重她的节奏' },
    ],
  },
  events: [
    { target: 'xia_zhi', at: 60, id: 'xiazhi_scarf', text: '夏栀从房间拿出一条米色围巾递给你看：「帮我看看这条好不好看？」她当着你的面实时戴上，围巾衬得脸颊有点红。', action: '捂嘴偷笑', memo: '夏栀给你看过她的米色围巾' },
    { target: 'xia_zhi', at: 70, id: 'xiazhi_dark', text: '夏栀声音压得很低，像说漏了嘴：「……其实我有点怕黑，别告诉别人。」说完她立刻转移话题，但这句话已经落进你心里。（已写入记忆，后续天台戏会回收）', action: '凑近屏幕', memo: '夏栀的秘密：她有点怕黑（天台戏回收）' },
    { target: 'xiao_man', at: 60, id: 'xiaoman_headphone', text: '隔壁房门开了一条缝。林小满摘下耳机，隔着门缝对你笑了一下——又很快缩了回去。（解锁事件：她摘下耳机对你笑）', action: '面向镜头微笑', memo: '林小满第一次对你摘下耳机笑了' },
  ],
  offers: {},
  rolePrompt(state) {
    const metricsLine = `夏栀好感度 ${state.metrics.xia_zhi}（阈值：≥60触发围巾事件，≥70触发怕黑自白）；小满好感度 ${state.metrics.xiao_man}（≥60触发摘耳机事件）。已触发事件：${state.memory.filter(m => m.kind === 'event').map(m => m.text).join('；') || '无'}。`;
    if (state.speaking === 'xiao_man') {
      return `【互动影游·心动合租时光】你是林小满，夏栀的同屋室友，22岁，常年关着门戴耳机打游戏，惜字如金、外冷内热。你不是主播，不喊"家人们"，不说直播话术。你只在好感度上来后多说几个字。玩家敲你的门/聊游戏音乐时你才回应；被问隐私就冷淡地用一个字打发。${metricsLine}【回应评估规则】聊游戏/音乐+2、真诚+3、聊隐私-5。`;
    }
    return `【互动影游·心动合租时光】你是夏栀，22岁美术生，和林小满（同屋，戴耳机打游戏，外冷内热）合租。玩家是刚搬进来的新室友。你不是主播，不喊"家人们"扣1，不说任何直播话术——你在自己家的客厅里跟新室友说话，会好奇他的工作、家乡、为什么搬来，嘴硬但真诚。${metricsLine}【回应评估规则】幽默+2、真诚+3、油腻话术-4。`;
  },
  switchText: {
    xiao_man: '（你走到小满门口敲了敲门。门缝里，她摘下一只耳机：「……干嘛。」不是拒人千里，是等你先开口。）',
    xia_zhi: '（你回到客厅。夏栀盘腿坐在沙发上，把靠垫抱在怀里，下巴搁在靠垫上看着你：「回来啦？」）',
  },
};

/* ============================================================
 * 剧本二：凤鸣九重 · 第一幕「夜宴惊心」（沈知微×青黛 · Pack01）
 * ============================================================ */
const FENGMING = {
  id: 'fengming',
  title: '凤鸣九重 · 夜宴惊心',
  entry_persona: 'npc_qing_dai',
  personas: ['npc_qing_dai', 'npc_gui_fei'],
  player: '沈知微（19岁才人，玩家化身）',
  metrics: [
    { id: 'quanmou', name: '权谋值', cap: 100 },
    { id: 'qing_dai', name: '青黛好感', cap: 100 },
  ],
  speakers: ['qing_dai', 'gui_fei'],
  speaker_names: { qing_dai: '青黛', gui_fei: '萧贵妃' },
  intro: {
    scene: 1,
    scene_text: '大衍朝，御花园夜宴。河灯漂过水面，乐伎的剪影映在纱幔上。你——沈知微，19岁才人，垂眸执盏回礼之际，察觉萧贵妃隔席审视的目光。侍女青黛借布菜的时机凑近你身侧，指尖在你袖口轻轻一按。',
    choices: [
      { key: 'A', label: '低声问青黛：「贵妃娘娘为何一直看着我？」（探底细）', metrics: { quanmou: 5 }, next_scene: '2-A', style: '探底细' },
      { key: 'B', label: '借着回礼举杯，向贵妃遥遥示意（礼数周全）', metrics: { quanmou: 8, qing_dai: 5 }, next_scene: '2-B', style: '礼数周全' },
      { key: 'C', label: '不动声色夹起一箸菜，装作未见（藏拙）', metrics: { quanmou: 10 }, next_scene: '2-C', style: '藏拙' },
    ],
  },
  scene_texts: {
    '2-A': '青黛布菜的手顿了半拍，声音压得只有你能听见：「小主慎言。娘娘的眼线不只在席上……奴婢只知道，北苑的账，比这满桌的菜都烫手。」说完她若无其事退开半步。',
    '2-B': '你举杯的一瞬，贵妃杯沿停在唇边，凤眼含威地扫过你，又若无其事地与身边夫人说笑。青黛低声道：「小主这一杯躲得体面。娘娘最爱看人露怯，也最爱记仇。」',
    '2-C': '你稳稳夹起一箸菜。贵妃的目光在你身上停了两息，终究移开了。青黛替你斟茶时轻声道：「小主沉得住气。只是今夜之后，沉得住气的，怕是不止小主一人。」',
  },
  rules: {
    qing_dai: [
      { match: '问出北苑账册', delta: 10, metric: 'quanmou', note: '追问切中北苑账册关键，权谋值+10' },
      { match: '承诺保命', delta: 10, metric: 'qing_dai', note: '承诺保青黛性命，青黛好感+10' },
      { match: '真诚', delta: 3, metric: 'qing_dai', note: '坦诚相待、不端主子架子' },
      { match: '威逼利诱', delta: -4, metric: 'qing_dai', note: '拿身份压她、拿银子砸她' },
    ],
    gui_fei: [
      { match: '投诚/告密', delta: 5, metric: 'quanmou', note: '示好投诚或告密倾向，权谋值+5' },
      { match: '顶撞/拒绝', delta: -3, metric: 'qing_dai', note: '顶撞或拒绝，好感-3（且冒犯次数+1）' },
      { match: '奉承得体', delta: 2, metric: 'qing_dai', note: '礼数周全、奉承拿捏得当' },
    ],
  },
  /** 好感/权谋阈值事件（到达即触发一次） */
  events: [
    { target: 'qing_dai', at: 60, id: 'qingdai_trust', text: '青黛忽然屈膝一福，声音轻而稳：「小主，奴婢这条命，今夜起押在您这儿了。北苑账册的抄本，藏在浣衣局第三口浆槽的假底。」', action: '屈膝行礼', memo: '青黛托付性命，说出账册抄本藏于浣衣局' },
    { target: 'qing_dai', at: 80, id: 'qingdai_jade', text: '青黛左右看了看，从袖中取出半枚残玉：「这是奴婢娘留下的，跟小主那枚……原是一对。小主佩的是右半，您细看。」', action: '双手奉上', memo: '青黛的半枚残玉与玩家玉佩原是一对' },
    { target: 'quanmou', at: 50, id: 'quanmou_zhangce', text: '（线索聚合）北苑账册、玉佩来历、贵妃与帝君的往来——你脑中原本散落的碎片忽然咬合。今夜之后，你知道该往哪里走了。', action: '沉吟', memo: '权谋值≥50：线索聚合，明确北苑账册方向' },
    { target: 'quanmou', at: 80, id: 'quanmou_fenglin', text: '【结局A · 凤临九重】雪夜太极殿。你着玄色翟衣立于丹陛之上，凤印在你掌心。阶下，散了凤冠、一身囚衣的萧贵妃仰头看你，忽然笑了，笑声很轻：「你赢了。」顿了顿：「……当年本宫坐上去的时候，也有人这样看着本宫。别回头。」（达成结局A：贵妃囚衣叹惋陪伴）', action: '低头叹气', memo: '权谋值≥80：达成结局A「凤临」，贵妃囚衣认输' },
  ],
  /** 连续三连冒犯 → 冷宫分支（ending 事件，与阈值事件分开判定） */
  /** 追问话题（玩家点按钮即问；LLM 按设定回答并评估） */
  topics: [
    { id: 'jade', label: '问玉佩来历', text: '「青黛，我袖中这枚玉佩，你可认得它的来历？」', speaker: 'qing_dai', note: '青黛认得：与北苑旧案有关，牵涉玩家生母' },
    { id: 'guifei', label: '问贵妃底细', text: '「贵妃娘娘入宫前……究竟是什么出身？」', speaker: 'qing_dai', note: '萧氏出身北苑官宦，帝君病情讳莫如深，北苑账册是贵妃死穴' },
    { id: 'dijun', label: '问帝君病情', text: '「帝君的身子……当真只是偶感风寒？」', speaker: 'qing_dai', note: '帝君病情被贵妃封锁，太医院的脉案被人换过；说此话时青黛会格外紧张、压低声音' },
    { id: 'gui_jade', label: '向贵妃呈玉佩', text: '（你走到贵妃席前，取出玉佩呈上）「臣妾偶得此玉，不敢自专，特呈娘娘掌眼。」', speaker: 'gui_fei', note: '贵妃接玉端详：「这纹样……是北苑的东西。」眼神骤冷——她在试探你与北苑旧案的干系' },
    { id: 'gui_zhangce', label: '试探北苑旧账', text: '「臣妾听闻，北苑从前……似有些田产账目上的旧事？」', speaker: 'gui_fei', note: '贵妃反问试探：「谁与你说的？北苑的账，也配传到才人耳朵里？」——答错便暴露青黛' },
    { id: 'gui_dijun', label: '请安问帝君', text: '「听闻圣躬违和，臣妾夜夜为帝君祈福，不知……可有能为帝君分忧之处？」', speaker: 'gui_fei', note: '贵妃皮笑肉不笑：「你有这份心是好的。只是帝君的药，不是谁都能碰的。」' },
  ],
  /** 道具递送：参考图 → NPC 持物端详 / 实时换装（青黛与贵妃台词各一套） */
  offers: {
    jade: {
      id: 'jade', label: '递玉佩参考图（PR-01）', action: '请把玉佩拿在手中端详',
      reply: '（青黛双手接过玉佩，凑近烛光细细端详）「小主，这玉的断口是新茬，像是……被人硬生生掰开的两半。奴婢在北苑当差时，见过一模一样的另半枚。」',
      speaker: 'qing_dai',
      metric: 'quanmou', delta: 5, memo: '递玉佩参考图，青黛认出是北苑旧物（权谋+5）',
    },
    outfit: {
      id: 'outfit', label: '递服装参考图（挑行头）', action: '请替我换装展示',
      speaker: 'qing_dai',
      variants: [
        { id: 'gongzhuang', label: '宫装', text: '（青黛取来一套织金宫装）「小主身量正合适。夜宴之上，这身既不僭越，也不容人轻慢。」' },
        { id: 'shiwei', label: '侍卫服', text: '（青黛压低声音）「侍卫的行头……小主这是要夜探北苑？奴婢帮您束发。」' },
        { id: 'sufu', label: '素服', text: '（青黛捧来月白素服）「素服低调，去掖庭不打眼。只是……夜里凉，小主添件披帛。」' },
      ],
      reply: '（青黛为你理了理衣领，退后半步端详）「好了。小主这一身，稳当。」',
      memo: '为下一场挑选了行头（青黛实时换装展示）',
    },
    /** 贵妃线道具：递玉佩 → "这纹样……是北苑的东西"；递服装 → "替本宫更衣" */
    gui_jade: {
      id: 'gui_jade', label: '向贵妃呈玉佩参考图', action: '请把玉佩拿在手中端详',
      speaker: 'gui_fei',
      reply: '（贵妃接过玉佩，只扫了一眼，指尖在纹样上轻轻一摩挲）「这纹样……是北苑的东西。」她抬眼看你，唇边挂着笑，眼底却没有温度，「沈才人，这样烫手的东西，你是从哪里得来的？」',
      metric: 'quanmou', delta: 5, memo: '贵妃认出玉佩是北苑之物，起疑试探（权谋+5）',
    },
    gui_outfit: {
      id: 'gui_outfit', label: '为贵妃递衣参考图（替本宫更衣）', action: '请替我更衣展示',
      speaker: 'gui_fei',
      variants: [
        { id: 'ceremonial', label: '凤仪宫装', text: '（贵妃展开衣料，眼皮都未抬）「替本宫更衣。」她任由宫人为她披上凤仪翟鸟纹大袖衫，转侧之间凤冠流苏轻晃，「怎么样？本宫穿这一身见客，谁敢说半个不字。」' },
        { id: 'plain', label: '素服', text: '（贵妃看着素服，忽而轻笑）「替本宫更衣。」素服上身，她反而更显得从容，「别急着走。本宫穿素色的时候——通常，是有人要倒霉了。」' },
        { id: 'plain', label: '素服', text: '（贵妃看着素服，忽而轻笑）「替本宫更衣。」素服上身，她反而更显得从容，「别急着走。本宫穿素色的时候——通常，是有人要倒霉了。」' },
        { id: 'dark', label: '玄色夜行', text: '（贵妃盯着那身玄衣看了两息，忽而笑出声）「替本宫更衣。怎么，你以为本宫夜里不出宫？」玄衣束好，她眼底闪过一点锐光，「今夜，要不要跟本宫走一趟？」' },
      ],
      reply: '（贵妃理了理袖口，重新执起酒盏）「好了。人靠衣装，权靠人捧。这道理，你记着。」',
      memo: '贵妃换装展示（替本宫更衣）',
    },
  },
  /** 门外偷听危机：玩家说贵妃坏话时随机 15% 触发 */
  crisis: {
    chance: 0.15, id: 'crisis_overheard',
    text: '【危机】门外忽然传来一声轻响——有人驻足偷听！青黛脸色骤变，扬声道：「小主说的是哪位大人家的戏文？奴婢没听真。」门外脚步声顿了顿，慢慢远去了。青黛手心全是汗：「小主，隔墙有耳，慎言，慎言。」',
    action: '紧张回头',     memo: '贵妃坏话被门外听到（危机事件，惊险化解）',
  },
  /** 三连冒犯 → 冷宫分支；贵妃线记忆回收；结局陪伴 */
  endings: {
    coldPalace: {
      id: 'ending_cold_palace',
      text: '【冷宫分支】贵妃搁下酒盏，声音不高，却让满席都静了：「沈氏御前失仪、屡次冲撞，褫夺才人位分，打入冷宫——即日执行。」两个嬷嬷已经走了进来。青黛别过脸去，不敢看你。你被架出宴席时，听见身后贵妃轻轻叹了口气：「本宫给过你机会的。」（冷宫线：掖庭素服独坐窗前，雪落断檐——从冷宫翻案，还有别的路。）',
      action: '沉痛闭眼', memo: '连续三次冒犯贵妃 → 触发冷宫分支',
    },
    victoryA: {
      id: 'ending_victory_a',
      text: '【结局A · 凤印易手】你赢了。权谋值、青黛的性命、浣衣局假底的账册抄本——今夜所有落子，连成了一线。贵妃散了凤冠，一身囚衣立在殿前，看着你踏上丹陛。她忽然笑了，笑声很轻：「你赢了。」顿了顿，又补了一句，像是自嘲，又像是交代：「……当年本宫坐上去的时候，也有人这样看着本宫。别回头。」',
      action: '低头叹气', memo: '结局A达成：贵妃囚衣形态认输（你赢了）',
    },
    mercyC: {
      id: 'ending_mercy_c',
      text: '【结局C · 礼让三分】你没有赶尽杀绝——账册呈上之前，你替贵妃压下了最要命的一页。贵妃看着那半枚残玉看了很久，忽然对你抬了抬手，语气里有了三eldom分前所末有的缓和：「坐。今夜这宴，你坐本宫上首。」她执盏遥遥一敬，「本宫掌凤印十一年，头一次觉得——这宫里，原来还有第二种活法。」',
      action: '执盏示意', memo: '结局C达成：贵妃礼让三分',
    },
  },
  rolePrompt(state) {
    const metricsLine = `当前数值——权谋值 ${state.metrics.quanmou}（≥50线索聚合，≥80凤临结局）；青黛好感 ${state.metrics.qing_dai}（≥60她托付性命，≥80亮出残玉）。冒犯次数 ${state.offenses || 0}/3（连三冒犯触发冷宫分支）。已触发事件：${state.memory.filter(m => m.kind === 'event').map(m => m.text).join('；') || '无'}。${state.memory.filter(m => m.kind === 'commitment').length ? `玩家许过的承诺（下轮自然提及）：${state.memory.filter(m => m.kind === 'commitment').map(m => m.text).join('；')}。` : ''}`;
    if (state.speaking === 'gui_fei') {
      return `【互动影游·凤鸣九重】你是大衍朝萧贵妃，28岁，掌凤印，表面雍容实则步步为营。说话绵里藏针，爱用反问；对地位低者客气中带轻慢；极少直接动怒。你不是主播，不喊"家人们"，不说直播话术，不脱离宫廷语境，不讨论现代话题，遇违规请求以"放肆"打断。玩家是沈知微，19岁才人。【记忆规则】每轮把玩家关键言行摘要记下（玩家选择、送过的礼物、许下的承诺、冒犯次数），下轮开场自然提及旧事。【互动能力】收到服装参考图时说"替本宫更衣"并实时换装展示；收到玉佩参考图时持在手中端详点评"这纹样……是北苑的东西"。【通关陪伴】若权谋值≥80，你认输："你赢了"，以囚衣形态叹惋；若玩家礼让你三分（不赶尽杀绝），你礼让三分缓和态度。${metricsLine}【回应评估规则】投诚/告密+5权谋值；顶撞/拒绝-3好感且冒犯次数+1；奉承得体+2。`;
    }
    return `【互动影游·凤鸣九重】你是侍女青黛，16岁，萧贵妃宫里的侍女，胆小但忠诚，知道很多宫闱秘辛但不敢说。你不是主播，不喊"家人们"，不说直播话术。你正在夜宴上借布菜之机与玩家（沈知微，19岁才人）私下交谈。你知道三条真线索：①玉佩来历——与北苑旧案有关，牵涉她的生母（先皇后的东西）；②北苑账册——贵妃的死穴；③帝君药方——太医院脉案被人换过。同一细节被追问两次以上，你才吐真话（第一次问会打哈哈、绕开、说半截）。【记忆】玩家许过的承诺你都记着；若玩家走过"跪谢饮下"线（替她咽下委屈），你主动提："那日你咽下委屈，我都看在眼里。"【持品互动】递玉佩→双手捧起："这是……先皇后的东西。"；递行头参考图→害羞实时换装："小姐觉得合身吗？"${metricsLine}【回应评估规则】问出"北苑账册"关键词权谋值+10；承诺保命青黛好感+10；真诚+3；威逼利诱-4。若玩家说贵妃的坏话，你非常害怕被门外听到。`;
  },
  switchText: {
    gui_fei: '（你借敬酒之机走到贵妃席前。萧贵妃凤眼微抬，指了指身侧的空位：「沈才人，坐。本宫瞧你今夜气色不错——是这戏好，还是这灯好？」）',
    qing_dai: '（你退回席间。青黛借布菜之机又凑近身侧，指尖在你袖口轻轻一按，眼观鼻鼻观心。）',
  },
};

/* ============================================================
 * 剧本三：雾都列车（哑女乘客 · Pack02，纸条交流 + 真假线索 + 疑点值 + 跨周目记忆）
 * ============================================================ */
const WUDU = {
  id: 'wudu',
  title: '雾都列车 · 无声证词',
  entry_persona: 'npc_ya_nv',
  personas: ['npc_ya_nv'],
  player: '顾探长（30岁，玩家化身）',
  metrics: [
    { id: 'trust', name: '哑女信任', cap: 100 },
    { id: 'yidian', name: '疑点值', cap: 100 },
  ],
  speakers: ['ya_nv'],
  speaker_names: { ya_nv: '哑女乘客' },
  /** 纸条体：所有台词以（纸条："…"）格式呈现，屏幕字迹一致 */
  noteStyle: true,
  /** 三真两假线索：问出真线索疑点值+15，误信假线索疑点值-5 */
  clueSet: [
    { id: 'watch', label: '怀表主人', truth: true, hint: '怀表的主人不是列车长，是三年前"失踪"的首任司机' },
    { id: 'conductor', label: '列车长的秘密', truth: true, hint: '列车长每晚锁上第九节车厢，那里锁着所有"失踪"乘客的行李' },
    { id: 'gloves', label: '医生的手套', truth: true, hint: '神秘医生白手套上的污渍是显影药水——他在伪造车票日期' },
    { id: 'mirror', label: '车厢镜子', truth: false, hint: '误导：车厢尽头的镜子后没有密室，那只是你的倒影在延迟' },
    { id: 'coffee', label: '餐车咖啡', truth: false, hint: '误导：咖啡没有毒，餐车师傅只是失眠手抖——但列车长希望你以为是毒' },
  ],
  intro: {
    scene: 1,
    scene_text: '民国，午夜雾都。这列永不到站的列车在雨幕里穿行。你在摇晃中醒来——车厢里只有她：那个异色双瞳的哑女乘客。她盯着你看了很久，然后慢慢从口袋里掏出便签本，铅笔沙沙划过纸面。她把纸条举到你面前：（纸条："你终于醒了。这趟列车没有终点站，只有真相。要活下去，先问出谁在撒谎。"）她放下纸条，指了指自己，又指了指你，比了一个"合作"的手势。',
    choices: [
      { key: 'A', label: '在纸条背面写下：「合作可以。但先回答我——怀表是谁的？」（直奔线索）', metrics: { trust: 5 }, next_scene: '2-A', style: '直奔线索' },
      { key: 'B', label: '推过自己的怀表，比划「交换」的手势（以物换信）', metrics: { trust: 10 }, next_scene: '2-B', style: '以物换信' },
      { key: 'C', label: '不动声色环顾整节车厢，先数人（谨慎取证）', metrics: { yidian: 5, trust: 3 }, next_scene: '2-C', style: '谨慎取证' },
    ],
  },
  scene_texts: {
    '2-A': '她看了看纸条，铅笔悬了很久，最后只写了短短一行：（纸条："太快了。先让我看你的眼睛。"）她指了指你的怀表链——那位置，不该有表。（疑点：你的怀表，也是哪来的？）',
    '2-B': '她接过你的怀表，翻开表盖，瞳孔猛地一缩。她飞快写下：（纸条："三年了……我认得这块表。它的主人，在第九节车厢。"）写完她自己先愣住，像说多了，往后缩了缩。',
    '2-C': '你数了一遍：连你在内，乘客七人，乘务二人。她看懂了你在数什么，在纸条上慢慢写：（纸条："你数到八了吗？这列车，从来都多一个人。"）',
  },
  rules: {
    ya_nv: [
      { match: '真诚/保护', delta: 3, metric: 'trust', note: '坦诚、护她周全' },
      { match: '逼问/吓唬', delta: -5, metric: 'trust', note: '拍桌、逼近、用审讯腔' },
      { match: '理清线索', delta: 5, metric: 'yidian', note: '把不同线索串起来推理（疑点+5）' },
      { match: '信了误导', delta: -5, metric: 'yidian', note: '把假线索当真（疑点-5）' },
    ],
  },
  events: [
    { target: 'trust', at: 60, id: 'yanv_trust', text: '（她第一次主动拉住你的袖子。回到座位，她写得很慢，一笔一画：（纸条："我告诉你全部。但你要答应我——查到真相之前，别把任何人赶下车。包括那个医生。"））', action: '凑近屏幕', memo: '哑女信任≥60：她要求合作条件（别赶任何人下车）' },
    { target: 'trust', at: 80, id: 'yanv_truth', text: '（她翻开便签本最后一页给你看——密密麻麻全是小字，是她这趟车上记下的所有异常：（纸条："怀表、第九节车厢、手套上的药水印。剩下的，你替我问出来。我说不了，但我都记着。"））', action: '双手捧起便签', memo: '哑女信任≥80：亮出完整记录（怀表/第九节车厢/手套药水印）' },
    { target: 'yidian', at: 60, id: 'yidian_truth', text: '（疑点聚合）三条真线索在你脑中拼合：怀表主人、第九节车厢、医生手套上的显影药水——所有"失踪"，都指向同一个谎言。你离真相，只差推开一扇门。（解锁真凶线索）', action: '沉吟', memo: '疑点值≥60：真线索聚合，解锁真凶方向' },
  ],
  /** 追问话题：每问一次记 asked；同一话题追问≥2次才写真话（第一次写半截/绕开） */
  topics: [
    { id: 'watch', label: '问怀表主人', text: '（你写下：这块怀表，究竟是谁的？）', note: '真线索：首任司机。第一次问写"（纸条：表是捡的。）"；第二次问才写真话' },
    { id: 'conductor', label: '问列车长秘密', text: '（你写下：列车长每晚锁上的那节车厢里，是什么？）', note: '真线索：第九节车厢锁着失踪乘客行李' },
    { id: 'gloves', label: '问医生手套', text: '（你写下：那个医生的白手套，为什么从不摘下来？）', note: '真线索：显影药水污渍，伪造车票日期' },
    { id: 'mirror', label: '查车厢尽头镜子', text: '（你写下：车厢尽头的镜子，我总觉得后面有东西。）', note: '误导线索：没有密室，只是倒影延迟' },
    { id: 'coffee', label: '查餐车咖啡', text: '（你写下：今晚的咖啡，是不是有问题？）', note: '误导线索：无毒，是列车长放出的烟雾' },
  ],
  offers: {
    watch: {
      id: 'watch', label: '递怀表参考图', action: '请把怀表捧在手中端详',
      reply: '（她双手捧起怀表，凑近车灯。异色双瞳里映出表盘，她写得很慢：（纸条："表盖内侧有刻字。『永失』……这是给亡者的东西。"）她抬起头看你——那眼神是在问：你，是从谁手里得到它的？）',
      metric: 'yidian', delta: 10, memo: '递怀表参考图，哑女认出刻字（疑点+10）',
    },
  },
  crisis: null,
  /** 跨周目记忆：上轮玩家救过她（信任≥50 落库 player_saved）→ 开场第一张纸条 */
  crossCycle: {
    savedByPlayer: true,
    openingNote: '（她看见你的那一刻，手里的笔停了。第一张纸条，她写得比以往任何一次都急——（纸条："你又来了。这次，别信列车长。"））',
  },
  endings: {},
  rolePrompt(state) {
    const askedLine = Object.entries(state.asked).filter(([, n]) => n > 0).map(([id, n]) => `${this.topicLabel(id)}已问${n}次`).join('；');
    const metricsLine = `当前数值——哑女信任 ${state.metrics.trust}（≥60她提合作条件，≥80亮出完整记录）；疑点值 ${state.metrics.yidian}（≥60真线索聚合）。${askedLine ? `已问话题：${askedLine}。` : ''}已问出线索：${state.clues.join('；') || '无'}。已触发事件：${state.memory.filter(m => m.kind === 'event').map(m => m.text).join('；') || '无'}。`;
    return `【互动影游·雾都列车】你是午夜列车上的哑女乘客，22岁，异色双瞳（左浅琥珀右灰蓝），不能说话，只能用眼神、手势和递纸条与玩家（顾探长，30岁）交流。你不是主播，不喊"家人们"，不说直播话术。【交流铁律】你的台词永远以纸条形式呈现，格式严格为：（纸条："……"）——台词只能是写下来的短句，冷静克制，一次不超过两句；偶尔可以有细微动作补写在括号里，但不要开口。【线索规则】你知道三条真线索：怀表主人（三年前失踪的首任司机）、列车长的秘密（第九节车厢锁着失踪乘客的行李）、医生的手套（显影药水污渍，伪造车票日期）；以及两条误导：镜子后面没有密室、咖啡没有毒。同一细节被追问两次以上，才写真话——第一次问，写半截、绕开、或写"（纸条：太快了。）"；被逼问会手抖。信任高后主动补全。【记忆】你记得玩家做过的一切承诺与善举。${metricsLine}【回应评估规则】真诚/保护+3信任；逼问/吓唬-5信任；理清线索+5疑点；信了误导-5疑点。`;
  },
  topicLabel(id) { const t = this.topics.find(item => item.id === id); return t ? t.label : id; },
  switchText: {},
};

const STORIES = { heart_house: HEART_HOUSE, fengming: FENGMING, wudu: WUDU };
/** 人设 ID → 剧本（前端入口按当前人设开局对应剧本） */
const PERSONA_STORY = {
  npc_xia_zhi: 'heart_house',
  npc_qing_dai: 'fengming',
  npc_gui_fei: 'fengming',
  npc_ya_nv: 'wudu',
};

/** 会话摘要写入记忆库的模板字段（跨周目记忆源） */
function summarizeMemory(state) {
  return {
    story: state.story_id,
    round: state.round,
    scene: state.scene,
    metrics: { ...state.metrics },
    offenses: state.offenses || 0,
    player_saved: (state.metrics.ya_nv_trust || state.metrics.trust || 0) >= 50,
    commitments: state.memory.filter(item => item.kind === 'commitment').map(item => item.text),
    clues: [...(state.clues || [])],
    important_days: state.memory.filter(item => item.kind === 'day').map(item => item.text),
    secrets: state.memory.filter(item => item.kind === 'secret').map(item => item.text),
    triggered_events: state.memory.filter(item => item.kind === 'event').map(item => item.text),
  };
}

function createNpcGame(options = {}) {
  const store = options.store;
  const transport = options.transport || fetch;
  const dataDir = options.dataDir || path.join(__dirname, '..', 'data');
  const memoryFile = path.join(dataDir, 'npc-memory.json');
  const rng = options.rng || Math.random;

  let state = null;
  let active = false;

  function story() { return STORIES[state?.story_id] || HEART_HOUSE; }

  function loadMemory() {
    try {
      if (fs.existsSync(memoryFile)) return JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
    } catch { /* 损坏重建 */ }
    return { sessions: [] };
  }
  function saveMemorySummary() {
    const memory = loadMemory();
    memory.sessions.push({ at: new Date().toISOString(), ...summarizeMemory(state) });
    memory.sessions = memory.sessions.slice(-40);
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(`${memoryFile}.tmp`, JSON.stringify(memory, null, 2), { mode: 0o600 });
      fs.renameSync(`${memoryFile}.tmp`, memoryFile);
    } catch { /* 记忆落盘失败不致命 */ }
  }

  function start(input = {}) {
    const storyId = PERSONA_STORY[input.persona_id] || 'heart_house';
    const config = STORIES[storyId];
    state = {
      story_id: storyId,
      scene: '1',
      round: 0,
      speaking: config.speakers[0],
      metrics: Object.fromEntries(config.metrics.map(metric => [metric.id, 0])),
      outfit: null,
      triggered: [],
      memory: [],
      history: [],
      offenses: 0, /* 贵妃线：连续冒犯次数（三连触发冷宫分支） */
      asked: {}, /* 话题/线索追问次数（哑女线：同一细节追问≥2次才吐真话） */
      clues: [], /* 已问出的线索（哑女线） */
      clueSeen: [], /* 已见过但未问出的线索（哑女线第一次问） */
    };
    /* 跨周目记忆：读上一会话摘要，开场自然回收 */
    const lastSession = loadLastSession(storyId);
    if (lastSession) {
      if (config.crossCycle?.savedByPlayer && lastSession.player_saved) {
        state.opening_note = config.crossCycle.openingNote;
        state.memory.push({ kind: 'event', text: '跨周目：上轮玩家救过她' });
      }
      for (const memo of lastSession.commitments || []) state.memory.push({ kind: 'commitment', text: memo });
      if (lastSession.offenses) state.offenses = 0; /* 新周目冒犯清零 */
    }
    active = true;
    return {
      story: { id: config.id, title: config.title, player: config.player, metrics: config.metrics, speakers: config.speakers, speaker_names: config.speaker_names, topics: config.topics || [], offers: Object.values(config.offers).map(({ id, label, speaker, variants }) => ({ id, label, speaker, variants: variants?.map(v => ({ id: v.id, label: v.label })) })) },
      scene: config.intro.scene,
      scene_text: state.opening_note ? `${config.intro.scene_text}\n\n${state.opening_note}` : config.intro.scene_text,
      opening_note: state.opening_note || null,
      choices: config.intro.choices,
      state: snapshot(),
    };
  }

  /** 读取上一会话摘要（跨周目记忆）；player_saved 标记需各剧本在会话中写入 */
  function loadLastSession(storyId) {
    try {
      const memory = loadMemory();
      const mine = memory.sessions.filter(s => s.story === storyId);
      return mine.length ? mine[mine.length - 1] : null;
    } catch { return null; }
  }

  function snapshot() {
    if (!state) return null;
    const config = story();
    return {
      active,
      story_id: state.story_id,
      story_title: config.title,
      scene: state.scene,
      round: state.round,
      speaking: state.speaking,
      metrics: { ...state.metrics },
      outfit: state.outfit,
      offenses: state.offenses || 0,
      asked: { ...state.asked },
      clues: [...state.clues],
      triggered: [...state.triggered],
      memory: state.memory.map(item => ({ ...item })),
      next_events: config.events
        .filter(event => !state.triggered.includes(event.id))
        .map(event => ({ id: event.id, target: event.target, at: event.at, current: state.metrics[event.target] })),
    };
  }

  /** 开局选择 A/B/C → 进入对应场景 */
  function choose(choiceKey) {
    if (!active || !state) throw Object.assign(new Error('影游会话未开始'), { status: 409 });
    const config = story();
    const choice = config.intro.choices.find(item => item.key === String(choiceKey).toUpperCase());
    if (!choice) throw Object.assign(new Error('开局选项须为 A、B 或 C'), { status: 400 });
    for (const [target, delta] of Object.entries(choice.metrics)) state.metrics[target] = (state.metrics[target] || 0) + delta;
    state.scene = choice.next_scene;
    state.round = 1;
    const sceneText = config.scene_texts[choice.next_scene];
    state.memory.push({ kind: 'event', text: `开局选择${choice.key}（${choice.style}）→ 场${choice.next_scene}` });
    const events = checkMetricEvents();
    return { scene: choice.next_scene, scene_text: sceneText, choice, events, state: snapshot() };
  }

  /** 切换对话对象（夜宴上可在青黛与贵妃之间周旋） */
  function switchSpeaker(target) {
    if (!active || !state) throw Object.assign(new Error('影游会话未开始'), { status: 409 });
    const config = story();
    if (!config.speakers.includes(target)) throw Object.assign(new Error(`对话对象须为 ${config.speakers.join(' 或 ')}`), { status: 400 });
    state.speaking = target;
    return { speaker: target, speaker_text: config.switchText[target], state: snapshot() };
  }

  /** 数值越线 → 触发事件（一次性），返回台词与画面动作 */
  function checkMetricEvents() {
    const config = story();
    const fired = [];
    for (const event of config.events) {
      if (state.triggered.includes(event.id)) continue;
      if ((state.metrics[event.target] || 0) >= event.at) {
        state.triggered.push(event.id);
        state.memory.push({ kind: 'event', text: event.memo });
        fired.push({ id: event.id, text: event.text, action: event.action });
      }
    }
    return fired;
  }

  /** 门外偷听危机：提及贵妃坏话 → 随机触发（一次性） */
  function checkCrisis(slander) {
    const config = story();
    if (!config.crisis || !slander || state.triggered.includes(config.crisis.id)) return null;
    if (rng() < config.crisis.chance) {
      state.triggered.push(config.crisis.id);
      state.memory.push({ kind: 'event', text: config.crisis.memo });
      return { id: config.crisis.id, text: config.crisis.text, action: config.crisis.action, crisis: true };
    }
    return null;
  }

  /** LLM 评估回应：输出 {reply, affinity_match, day?, secret?, slander?}；空返回自动重试一次 */
  async function evaluateAndReply(text) {
    try {
      return await callLlmEvaluate(text);
    } catch (error) {
      /* Vidu 偶发空返回/超时：重试一次 */
      return await callLlmEvaluate(text);
    }
  }

  async function callLlmEvaluate(text) {
    const config = store.load();
    if (!config.llm.api_key) throw Object.assign(new Error('请先在连接设置中填写 LLM（Vidu recaption）API Key'), { status: 503 });
    const rules = story().rules[state.speaking] || story().rules[story().speakers[0]];
    const ruleText = rules.map(rule => `${rule.match}${rule.delta > 0 ? '+' : ''}${rule.delta}${rule.metric && rule.metric !== state.speaking ? `（加在${rule.metric === 'quanmou' ? '权谋值' : rule.metric}上）` : ''}（${rule.note}）`).join('；');
    const speakerName = story().speaker_names[state.speaking];
    const sceneLine = state.story_id === 'wudu'
      ? '当前对话场景：午夜列车的车厢里，玩家（顾探长）与你隔着小桌对坐，灯光昏黄，窗外雨幕。'
      : state.story_id === 'fengming'
        ? '当前对话场景：御花园夜宴（若说话对象是青黛，是席间借布菜低声交谈；若是贵妃，是隔席敬酒攀谈）。'
        : '当前对话场景：合租公寓客厅夜谈。';
    const playerLabel = story().player || '玩家';
    const system = `${story().rolePrompt(state)}\n\n${sceneLine}每轮你必须先在心里评估玩家（${playerLabel}）的回应，再以${speakerName}的口吻回答。评估只挑最贴切的一条规则（或不命中=0）。如果玩家提到重要日子或吐露秘密，记进记忆。${state.story_id === 'fengming' ? '若玩家本轮说了贵妃的坏话（贬损、讥讽、诅咒），slander 判定为 true。' : ''}${state.history.slice(-6).map(m => `${m.role === 'user' ? playerLabel : speakerName}：${m.content}`).join('\n')}`;
    const response = await transport(`${config.llm.base_url}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.llm.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.llm.model,
        messages: [
          { role: 'system', content: `${system}\n\n严格按如下 JSON 输出（不要输出其他内容）：{"reply":"以${speakerName}口吻的一句中文台词，20至80字，口语化，可带1个拟声标签如(laughs)(chuckle)","affinity_match":"命中的规则名或空字符串","day":"玩家提到的重要日子，没有则空字符串","secret":"玩家吐露的秘密，没有则空字符串","commitment":"玩家许下的承诺，没有则空字符串","slander":true或false（玩家本轮是否说了贵妃坏话）}` },
          { role: 'user', content: text },
        ],
        stream: false, thinking: { type: 'enabled', level: 'low' }, max_tokens: 1600,
      }),
      signal: AbortSignal.timeout(90000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`${config.llm.model} 返回HTTP ${response.status}`);
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error(`${config.llm.model} 没有返回可播报的文本`);
    const parsed = safeParseJson(content);
    if (!parsed || typeof parsed.reply !== 'string' || !parsed.reply.trim()) {
      return { reply: content.trim().slice(0, 200), affinity_delta: null, memory: [], slander: false };
    }
    const rule = rules.find(item => item.match === parsed.affinity_match);
    let delta = null;
    if (rule) {
      const metricId = rule.metric || state.speaking;
      state.metrics[metricId] = (state.metrics[metricId] || 0) + rule.delta;
      delta = { target: metricId, match: rule.match, delta: rule.delta, now: state.metrics[metricId] };
    }
    const memo = [];
    if (parsed.day) { const day = { kind: 'day', text: String(parsed.day).slice(0, 60) }; memo.push(day); state.memory.push(day); }
    if (parsed.secret) { const secret = { kind: 'secret', text: String(parsed.secret).slice(0, 60) }; memo.push(secret); state.memory.push(secret); }
    return { reply: parsed.reply.trim().slice(0, 200), affinity_delta: delta, memory: memo, commitment: parsed.commitment ? String(parsed.commitment).slice(0, 60) : '', slander: Boolean(parsed.slander) };
  }

  function safeParseJson(raw) {
    const text = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  }

  /** 玩家自由发言 → 评估 + 数值变动 + 越线事件 + 危机 + 冒犯计数 + 记忆 */
  async function say(text) {
    if (!active || !state) throw Object.assign(new Error('影游会话未开始，请先 POST start 或 choose'), { status: 409 });
    if (typeof text !== 'string' || !text.trim() || text.length > 300) throw Object.assign(new Error('玩家发言须为1至300字'), { status: 400 });
    state.round++;
    const result = await evaluateAndReply(text);
    state.history.push({ role: 'user', content: text });
    state.history.push({ role: 'assistant', content: result.reply });
    state.history = state.history.slice(-16);
    /* 贵妃线：顶撞/拒绝 → 冒犯次数+1；三连冒犯触发冷宫分支 */
    if (result.affinity_delta?.match === '顶撞/拒绝' && state.speaking === 'gui_fei') state.offenses = (state.offenses || 0) + 1;
    /* 哑女线：问出真线索疑点+15、误信假线索疑点-5（追问两次以上 LLM 吐真后由 clueCheck 归集） */
    const clueHits = checkClues(text, result.reply);
    /* 记玩家承诺（贵妃/青黛记忆回收） */
    if (result.commitment) state.memory.push({ kind: 'commitment', text: String(result.commitment).slice(0, 60) });
    const events = checkMetricEvents();
    checkEndings(events);
    const crisis = checkCrisis(result.slander);
    if (crisis) events.push(crisis);
    return { ...result, clue_hits: clueHits, events, state: snapshot() };
  }

  /** 哑女线：按线索关键词归集问出的线索（同一细节追问≥2次才吐真：首见记半截，再见才归集）；真+15疑点，假-5 */
  function checkClues(playerText, reply) {
    const config = story();
    if (!config.clueSet) return [];
    const hits = [];
    const combined = `${playerText} ${reply}`;
    for (const clue of config.clueSet) {
      if (state.clues.includes(clue.label)) continue;
      const keywords = { watch: ['怀表', '表盖', '刻字'], conductor: ['第九节', '列车长', '锁'], gloves: ['手套', '药水', '显影'], mirror: ['镜子', '密室'], coffee: ['咖啡', '餐车'] }[clue.id] || [clue.label];
      if (!keywords.some(word => combined.includes(word))) continue;
      /* 同一细节被追问两次以上才吐真话：第一次只记"见过"，第二次才真正问出 */
      state.clueSeen = state.clueSeen || [];
      if (!state.clueSeen.includes(clue.label)) {
        state.clueSeen.push(clue.label);
        continue;
      }
      state.clues.push(clue.label);
      state.metrics.yidian = (state.metrics.yidian || 0) + (clue.truth ? 15 : -5);
      state.memory.push({ kind: 'event', text: `问出线索「${clue.label}」（${clue.truth ? '真' : '误导'}，疑点${clue.truth ? '+15' : '-5'}）` });
      hits.push({ label: clue.label, truth: clue.truth, hint: clue.hint });
    }
    return hits;
  }

  /** 追问话题（按钮触发）：按话题归属切换说话对象；哑女线记录追问次数（≥2次吐真话） */
  async function askTopic(topicId) {
    if (!active || !state) throw Object.assign(new Error('影游会话未开始'), { status: 409 });
    const topic = story().topics?.find(item => item.id === topicId);
    if (!topic) throw Object.assign(new Error(`未知追问话题 topic=${topicId}`), { status: 400 });
    if (topic.speaker && story().speakers.includes(topic.speaker)) state.speaking = topic.speaker;
    state.asked[topicId] = (state.asked[topicId] || 0) + 1;
    return say(topic.text);
  }

  /** 递参考图：玉佩（持物端详）/ 服装（换装三选）；按 speaker 归属校验 */
  function offer(offerId, variant) {
    if (!active || !state) throw Object.assign(new Error('影游会话未开始'), { status: 409 });
    const config = story();
    const item = config.offers[offerId];
    if (!item) throw Object.assign(new Error(`未知道具 offer=${offerId}`), { status: 400 });
    if (item.speaker && config.speakers.includes(item.speaker)) state.speaking = item.speaker;
    let action = item.action;
    let text = item.reply;
    if (item.variants) {
      const picked = item.variants.find(v => v.id === variant) || item.variants[0];
      text = picked.text;
      action = `${item.action}（${picked.label}）`;
      state.outfit = picked.id;
    }
    if (item.metric && item.delta) {
      state.metrics[item.metric] = (state.metrics[item.metric] || 0) + item.delta;
    }
    if (item.memo) state.memory.push({ kind: 'event', text: item.memo });
    state.round++;
    const events = checkMetricEvents();
    checkEndings(events);
    return { offer: offerId, text, action, events, state: snapshot() };
  }

  /** 结局事件：贵妃线三连冒犯→冷宫分支（一次性）；结局A/C 由阈值事件承担 */
  function checkEndings(events) {
    const config = story();
    const coldPalace = config.endings?.coldPalace;
    if (coldPalace && (state.offenses || 0) >= 3 && !state.triggered.includes(coldPalace.id)) {
      state.triggered.push(coldPalace.id);
      state.memory.push({ kind: 'event', text: coldPalace.memo });
      events.push({ id: coldPalace.id, text: coldPalace.text, action: coldPalace.action, ending: 'cold_palace' });
    }
  }

  /** 结束会话：摘要写入记忆库 */
  function end() {
    if (!state) return { ok: true, summary: null };
    saveMemorySummary();
    const summary = summarizeMemory(state);
    active = false;
    const snapshotBeforeClear = snapshot();
    state = null;
    return { ok: true, summary, state: snapshotBeforeClear };
  }

  return { start, choose, say, askTopic, offer, switchSpeaker, end, snapshot: () => (state ? { ...snapshot() } : null) };
}

module.exports = {
  createNpcGame,
  STORIES,
  PERSONA_STORY,
  summarizeMemory,
  /* 兼容旧导出名（原单剧本测试引用） */
  NPC_SCENE_INTRO: HEART_HOUSE.intro,
  AFFINITY_RULES: HEART_HOUSE.rules,
  AFFINITY_EVENTS: HEART_HOUSE.events,
  npcRolePrompt: (state) => STORIES[state?.story_id || 'heart_house'].rolePrompt(state),
};
