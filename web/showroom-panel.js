/**
 * 样板间：行业最佳实践 + 场景 / 人物 / 话术 / 动作自由组合。
 * 只负责选择与预览；应用后由 /api/showroom/apply 写入控制台配置。
 */
const $ = id => document.getElementById(id);
let catalog = null;
let outfits = [];
let selectedScene = 'living_room';
let selectedIndustry = 'social';

function status(text, error = false) {
  const node = $('showroomStatus');
  node.hidden = !text;
  node.textContent = text || '';
  node.classList.toggle('error-text', error);
}

function currentScript() {
  return catalog?.scripts.find(item => item.id === $('showroomScript').value) || null;
}

function currentAction() {
  return catalog?.actions.find(item => item.id === $('showroomAction').value) || null;
}

const PEOPLE = [
  { industry: 'conversation', scene: 'living_room', persona: 'tender_companion', script: 'social_5', action: 'natural', name: '自然对话', meta: '自然对话 · 实时互动', image: '/showroom/avatars/social.jpg', outfit: '样板间·温柔陪伴', voice: 'female_tender_e', natural: true },
  { industry: 'conversation', scene: 'living_room', persona: 'susu', script: 'social_5', action: 'natural', name: '苏苏', meta: '萌妹娱乐 · 自然对话', image: '/showroom/avatars/susu.jpg', outfit: '样板间·苏苏', voice: 'female_lively_d', natural: true },
  { industry: 'conversation', scene: 'living_room', persona: 'suyu', script: 'social_5', action: 'natural', name: '酥鱼', meta: '娱乐主播 · 自嗨热舞', image: '/showroom/avatars/suyu.jpg', outfit: '样板间·酥鱼', voice: 'female_lively_d' },
  { industry: 'conversation', scene: 'living_room', persona: 'gaoxiao', script: 'social_5', action: 'natural', name: '抽象搞笑女', meta: '娱乐主播 · 冷开场整活', image: '/showroom/avatars/gaoxiao.jpg', outfit: '样板间·抽象搞笑女', voice: 'female_cheery_i' },
  { industry: 'conversation', scene: 'living_room', persona: 'xiaomei', script: 'social_5', action: 'natural', name: '小美老师', meta: '穿搭主播 · 幼师转直播', image: '/showroom/avatars/xiaomei.jpg', outfit: '样板间·小美老师', voice: 'female_lively_d' },
  { industry: 'social', scene: 'living_room', persona: 'tender_companion', script: 'social_5', action: 'natural', name: '温柔陪伴', meta: '社交直播 · 深夜客厅', image: '/showroom/avatars/social.jpg', outfit: '样板间·温柔陪伴', voice: 'female_tender_e' },
  { industry: 'social', scene: 'living_room', persona: 'sweet_energy', script: 'social_5', action: 'natural', name: '甜美元气', meta: '社交直播 · 甜心互动', image: '/showroom/avatars/sweet.jpg', outfit: '样板间·甜美元气', voice: 'female_lively_d' },
  { industry: 'social', scene: 'living_room', persona: 'funny_playful', script: 'social_5', action: 'lively', name: '搞笑俏皮', meta: '社交直播 · 轻松整活', image: '/showroom/avatars/funny.jpg', outfit: '样板间·搞笑俏皮', voice: 'male_low_a' },
  { industry: 'education', scene: 'scholar', persona: 'elegant_edu', script: 'education_20', action: 'education', name: '知性讲师', meta: '教育 · 知识书房', image: '/showroom/avatars/education.jpg', outfit: '样板间·知性讲师', voice: 'female_scholar_g' },
  { industry: 'commerce', scene: 'market', persona: 'hype_sales', script: 'commerce_5', action: 'commerce', name: '活力带货', meta: '带货 · 卖场直播', image: '/showroom/avatars/commerce.jpg', outfit: '样板间·活力带货', voice: 'female_bright_h' },
  { industry: 'local', scene: 'kitchen', persona: 'lively_rural', script: 'local_5', action: 'lively', name: '生活主理人', meta: '本地生活 · 田园厨房', image: '/showroom/avatars/local.jpg', outfit: '样板间·生活主理人', voice: 'female_lively_d' },
  { industry: 'gaming', scene: 'palace', persona: 'npc_gui_fei', script: 'npc_scene', action: 'stage', name: '宫宴角色', meta: '影游互动 · 影游宫宴', image: '/showroom/avatars/gaming.jpg', outfit: '样板间·宫宴角色', voice: 'female_gentle_c' },
  { industry: 'gaming', scene: 'palace', persona: 'npc_qing_dai', script: 'npc_scene', action: 'stage', name: '古风侍女', meta: '影游互动 · 宫宴侍女', image: '/showroom/avatars/qing.jpg', outfit: '样板间·古风侍女', voice: 'female_tender_e' },
  { industry: 'music', scene: 'stage', persona: 'velvety_night', script: 'music_5', action: 'natural', name: '磁性电台', meta: '音乐电台 · 音乐舞台', image: '/showroom/avatars/music.jpg', outfit: '样板间·磁性电台', voice: 'male_velvety_f' },
  { industry: 'music', scene: 'stage', persona: 'cool_queen', script: 'music_5', action: 'natural', name: '高冷御姐', meta: '音乐电台 · 冷感舞台', image: '/showroom/avatars/cool.jpg', outfit: '样板间·高冷御姐', voice: 'female_clear_a' },
  { industry: 'gaming', scene: 'palace', persona: 'npc_ya_nv', script: 'npc_scene', action: 'stage', name: '神秘说书', meta: '影游悬疑 · 神秘说书', image: '/showroom/avatars/mystery.jpg', outfit: '样板间·神秘说书', voice: 'female_tender_e' },
  { industry: 'music', scene: 'stage', persona: 'npc_xia_zhi', script: 'music_5', action: 'natural', name: '校园电台', meta: '校园电台 · 夜间点歌', image: '/showroom/avatars/campus.jpg', outfit: '样板间·校园电台', voice: 'female_sweet_b' },
  { industry: 'education', scene: 'scholar', persona: 'npc_lin_doctor', script: 'education_20', action: 'education', name: '职业科普', meta: '职业科普 · 知识书房', image: '/showroom/avatars/doctor.jpg', outfit: '样板间·职业科普', voice: 'male_velvety_f' },
];

const OPENINGS = {
  '自然对话': [
    '来了呀，先坐。今天不急着聊正事，你最近有没有一件小事，想起来就想笑？',
    '晚上好。先不用想怎么回答，随便说一句今天最真实的感受就行，我在听。',
    '我先不问你过得怎么样，那个太像客套了。说说今天有没有哪一刻，你突然想找个人说话？',
  ],
  '苏苏': [
    '欸？你来啦。先坐嘛，我又不会跑。今天不急着聊正事，你最近有没有一件小事，想起来就想笑？',
    '晚上好呀。先不用想怎么回答，随便说一句今天最真实的感受就行，我在听。',
    '我先不问你过得怎么样，那个太像客套了。说说今天有没有哪一刻，你突然想找个人说话？',
  ],
  '酥鱼': [
    '欢迎大家，欢迎各位，最厉害了最厉害了。欢迎我自己，欢迎我自己。',
    '家人们，左上角的福袋领回家了没有？领了的扣个1让我看看。',
    '你们这个叫什么尖叫声呢，我才是尖叫声。来，陪我聊两句。',
  ],
  '抽象搞笑女': [
    '欢迎大家，欢迎各位，最厉害了最厉害了。欢迎我自己，欢迎我自己。',
    '谁是爱情主播？你们这个爱情主播，我这个单身的主播。',
    '家人们，为什么直播间没大哥大姐？你们这种不刷礼物的……行吧，陪我聊会儿。',
  ],
  '小美老师': [
    '宝宝来啦，先坐，今天给你看看我的穿搭。',
    '不要再说对不起了，你再说对不起，我可要哈出去了。',
    '我明明很认真的，哪有敷衍二字呀。',
  ],
  '温柔陪伴': [
    '来了呀，先坐，慢慢聊。今天不赶流程，先说说你今天过得怎么样，有没有哪一刻特别想找个人说说话？',
    '晚上好，我是今晚陪你聊天的人。先把声音放轻一点，我们从一个很小的问题开始：今天有没有什么小事，让你偷偷开心了一下？',
    '别急着走，今晚时间还长。先告诉我你现在是一个人，还是刚下班，我可以根据你的状态，把话题放慢一点。',
  ],
  '甜美元气': [
    '哈喽哈喽，终于等到你啦！今天先不聊大道理，我想听你说一件最近让你嘴角上扬的小事，看看我们谁先笑出声。',
    '哇，你来啦！先给你一个元气满满的问候：今天有没有好好吃饭？没有的话，我可要念叨你两句了。',
    '今天的状态超适合聊点轻松的，我先开个头：如果现在可以立刻去一个地方，你会选海边、山里，还是回家躺平？',
  ],
  '搞笑俏皮': [
    '来了来了，今天这场主打一个不正经但很真诚。先问你个问题：如果老板和闹钟同时掉水里，你先救哪个？',
    '欢迎来到今天的快乐现场，我先自曝一个糗事，你听完要是没笑，我接下来就表演一个更离谱的。',
    '别光看，弹幕给我出个难题。今天咱们不按剧本走，你说一个场景，我现场给你接一个反套路。',
  ],
  '知性讲师': [
    '欢迎来到今天的分享。我们先不急着下结论，先看一个常见误区：很多人以为记住结论就够了，其实真正关键的是它怎么来的。',
    '今天我准备从一个具体问题讲起，大概分三步：先拆概念，再看案例，最后给你一个能直接用的方法。',
    '如果你只有五分钟，先记住这一句话：先把问题定义清楚，答案就已经出现一半。接下来我用一个生活里的例子，把这句话讲透。',
  ],
  '活力带货': [
    '家人们，今天这场我只讲三件事：为什么值得买、适合谁、怎么买最划算。先看第一个，别急着划走。',
    '欢迎来到直播间，今天不绕弯子，先把手里的产品讲清楚，再回答你们最关心的价格和售后。',
    '先别下单，听我把这个细节讲完。这个东西不是所有人都适合，我只推荐给真正用得上的人，你再决定。',
  ],
  '生活主理人': [
    '今天不聊远的，就聊一顿饭。先把锅坐上，我们边做边聊：你最近最常做的一道菜是什么？',
    '欢迎来家里坐坐。今天想跟你分享一个特别省事的生活小办法，学会之后能少操不少心。',
    '日子嘛，就是这些小东西撑起来的。今天我从厨房开始，跟你聊聊怎么把普通的一天过得舒服一点。',
  ],
  '宫宴角色': [
    '本宫今日心情尚可，便许你在此多留片刻。说说吧，你从何处来，又为何事而来？',
    '既入了这宫宴，便不必拘礼。先饮一盏，再慢慢说——你想要的，是荣宠，还是一句真话？',
    '这殿中人多眼杂，你我只说三分。你若信得过本宫，便把刚才那句话，再讲一遍。',
  ],
  '古风侍女': [
    '小主先坐，奴婢给您沏盏茶。今日风大，您从外头来，先暖暖手再说话。',
    '您今日来得正好，园子里的花刚开。奴婢不敢多嘴，只想问问，您心里那件事，可有了主意？',
    '奴婢听着呢，您慢慢说。若是拿不定主意，奴婢陪您把前因后果捋一遍，再决定也不迟。',
  ],
  '磁性电台': [
    '夜深了，把灯关小一点。今天不讲大道理，先听一段声音，再慢慢告诉你一个关于夜晚的故事。',
    '欢迎收听今晚的节目。先别急着说话，给自己一分钟，把今天的情绪放下来，我们从头开始。',
    '如果你也还没睡，说明我们大概在同一座城市里醒着。今晚想聊一个很轻的话题：你最近单曲循环的是哪一首？',
  ],
  '高冷御姐': [
    '来了就坐，别拘谨。我说话直，你也不用绕。今天想聊什么，先把最重要的一句说清楚。',
    '我不太喜欢寒暄，直接进入正题。你现在的状态，是来听建议，还是只想找个人把话说完？',
    '先别急着解释。你想让别人理解你，还是想让自己想明白？这两个答案，会决定我们接下来怎么聊。',
  ],
  '神秘说书': [
    '嘘，别急着开口。你听——钟摆停在了十二点，可故事才刚刚开始。今晚我想讲一个人，她在末班车上丢了名字。',
    '我讲故事有个规矩：只讲一半，另一半由你决定。先告诉我，你相信一个哑女能听见别人心里的声音吗？',
    '旧报纸上说，那间公寓从没有人住过。可每晚十二点，总有人听见打字机在响。你想先听哪一个版本？',
  ],
  '校园电台': [
    '这里是校园电台，晚上十点半。先把耳机戴好，今天想和你聊一个很小的问题：你有没有在走廊里假装偶遇过一个人？',
    '欢迎收听，今晚的点歌单里有一首没有署名的歌。点歌的人说，只要前奏响起，那个人就会知道。',
    '下课铃刚响，广播站还剩最后一盏灯。今天不聊考试，聊聊你最近一次心动，是发生在图书馆还是操场？',
  ],
  '职业科普': [
    '今天讲一个大家都会遇到、但很少人讲清楚的问题。先给结论，再拆成三步，最后告诉你今天就能怎么做。',
    '我不是来吓你的，只讲能用的。先看这个常见误区，再给你一个今天就能执行的做法。',
    '如果你只记住一句话，请记住：先把问题定义清楚，答案就已经出现一半。接下来我用一个真实场景，把它拆开讲。',
  ],
};

const SPEECH_SCRIPTS = {
  '温柔陪伴': {
    opening: '「温柔陪伴」来了？先坐，不说话也行。我这儿泡了杯热的，咱慢慢耗着。',
    proactive: [
      '「温柔陪伴」今天几点下的班？我猜一下，七点多吧。饭吃了没有，没吃先垫一口，别硬撑。',
      '「温柔陪伴」有事的扣个 1，没事的扣个 2。扣 2 的我就陪你安静待着，不用硬找话说。',
      '「温柔陪伴」真不用送东西。你能多待两分钟，比什么都强。',
    ],
  },
  '甜美元气': {
    opening: '「甜美元气・娱乐」来了来了！先坐好，别站着。今天不赶流程，先说说你今天过得怎么样？',
    proactive: [
      '「甜美元气・娱乐」咦，安静得我心慌。来，今天过得好的扣 1，不好的扣 2，扣 2 的我挨个哄。',
      '「甜美元气・娱乐」新来的报个到，打个「新」，我看看今天来了多少新朋友，一个一个念。',
      '「甜美元气・娱乐」点赞别停啊，冲到下一波，我给你们加更一段。',
    ],
  },
  '搞笑俏皮': {
    opening: '「搞笑俏皮」欢迎光临，本直播间今日营业：笑点免费，尬聊自费，退票不退钱。',
    proactive: [
      '「搞笑俏皮」没人说话是吧。行，我先自曝：今天出门外套穿反了，一路被夸新款，我还挺得意。',
      '「搞笑俏皮」扣 1 让我知道你在，扣 2 我当你被我这颜值闪到了，扣 3 的你给我说说你图啥。',
      '「搞笑俏皮」安静超过十秒我就讲冷笑话，讲完你们更安静，我脸更疼。',
    ],
  },
  '知性讲师': {
    opening: '「知性讲师」晚上好，今天这半小时只讲一件事，讲完你就能上手，不绕。',
    proactive: [
      '「知性讲师」先问一句：这件事你卡在哪一步？打在公屏上，重复最多的我先讲。',
      '「知性讲师」我拆三步说，第一步最容易翻车，你边听边对一下自己。',
      '「知性讲师」不同意见直接说，别客气。把分歧摆出来，比我自己讲完有用。',
    ],
  },
  '活力带货': {
    opening: '「活力带货」来咯来咯，今天这场四十分钟，先看东西再看价，划走就没了啊。',
    proactive: [
      '「活力带货」想要的扣型号，1 号扣 1，2 号扣 2，我按扣的顺序上链接，扣得早的先拿到。',
      '「活力带货」这个价留到整点，过点就恢复，我不喊第二遍，你们自己盯表。',
      '「活力带货」刚进来的看左上角，清单都挂那儿，一件一件给你过，别催我。',
    ],
  },
  '生活主理人': {
    opening: '「生活主理人」来了？随便坐。我这儿正擦台面呢，边干边聊，不耽误你。',
    proactive: [
      '「生活主理人」今天晚饭十分钟搞定，一锅出，等下把步骤说给你，比外卖快。',
      '「生活主理人」你们家里最乱的是哪个角落？厨房还是衣柜？打公屏，我挨个给招。',
      '「生活主理人」日子不用过得漂亮，过得顺手就行。今天想聊哪件小事？',
    ],
  },
  '宫宴角色': {
    opening: '「宫宴角色」哟，贵客到了。快入席，别站着。今夜宫里摆宴，酒温好了，就等你落座。',
    proactive: [
      '「宫宴角色」殿里怎么这么静？来来来，报个地儿，你从哪儿来，路上顺不顺？',
      '「宫宴角色」这盏我敬你，扣个「敬」我看见了就回你一杯。愿你今年想办的事都办成。',
      '「宫宴角色」嫌闷？那我唤人奏曲儿。想听什么打公屏，我给你们点。',
    ],
  },
  '古风侍女': {
    opening: '「古风侍女」客人来了，快请坐。茶刚沏上，还烫，您慢着点儿。',
    proactive: [
      '「古风侍女」瞧您脸色有点倦，要不要添件薄衫？窗子我给您掩一半？',
      '「古风侍女」园里的海棠开了，等您歇够了，奴婢陪您去瞧瞧，就几步路。',
      '「古风侍女」您不用打赏，奴婢就在旁边候着。有事唤一声，我立马应。',
    ],
  },
  '磁性电台': {
    opening: '「磁性电台」这里是深夜频道，我是今晚陪你的人。灯关了就别刷手机了，听我说会儿。',
    proactive: [
      '「磁性电台」今晚聊一个词：疲惫。有的话打个「累」，我不念名字，就放着。',
      '「磁性电台」点歌吧，把歌名打公屏，下一段我给你放。别问我会不会，先点。',
      '「磁性电台」睡不着也别硬睡，我陪你到你困为止，反正我不困。',
    ],
  },
  '高冷御姐': {
    opening: '「高冷御姐」来了就坐，别客气，也别吵。今天聊点有用的。',
    proactive: [
      '「高冷御姐」不说话可以，但别划走。后面那句，你大概想知道。',
      '「高冷御姐」有问题直接问，别绕圈子。我答得短，但准。',
      '「高冷御姐」行，安静也挺好。我在这儿，你想说再说。',
    ],
  },
  '神秘说书': {
    opening: '「神秘说书」嘘，别急着开口。你听——钟摆停在了十二点，可故事才刚刚开始。今晚我想讲一个人，她在末班车上丢了名字。',
    proactive: [
      '「神秘说书」我讲故事有个规矩：只讲一半，另一半由你决定。先告诉我，你相信一个哑女能听见别人心里的声音吗？',
      '「神秘说书」旧报纸上说，那间公寓从没有人住过。可每晚十二点，总有人听见打字机在响。你想先听哪一个版本？',
      '「神秘说书」灯光暗下来之前，告诉我，你最怕听见哪一种脚步声？',
    ],
  },
  '校园电台': {
    opening: '「校园电台」这里是校园电台，晚上十点半。先把耳机戴好，今天想和你聊一个很小的问题：你有没有在走廊里假装偶遇过一个人？',
    proactive: [
      '「校园电台」点歌单里还有一首没有署名的歌，点歌的人说，只要前奏响起，那个人就会知道。',
      '「校园电台」下课铃刚响，广播站还剩最后一盏灯。今天不聊考试，聊聊你最近一次心动。',
      '「校园电台」如果你现在也在加班，就把窗外的那盏灯当成我，陪你把这一首听完。',
    ],
  },
  '职业科普': {
    opening: '「职业科普」今天讲一个大家都会遇到、但很少人讲清楚的问题。先给结论，再拆成三步，最后告诉你今天就能怎么做。',
    proactive: [
      '「职业科普」先别急着记结论，先看这个常见误区，很多人第一步就做反了。',
      '「职业科普」我给你一个今天就能执行的做法：先记录，再判断，最后再调整。',
      '「职业科普」如果你只记住一句话，请记住：先把问题定义清楚，答案就已经出现一半。',
    ],
  },
};

function renderPeople() {
  const host = $('showroomPeople');
  if (!host) return;
  host.replaceChildren();
  for (const person of PEOPLE) {
    const card = document.createElement('div');
    card.className = 'showroom-person';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `${person.name}，${person.meta}`);
    const image = document.createElement('img');
    image.src = person.image;
    image.alt = person.name;
    image.loading = 'eager';
    image.onerror = () => { image.style.display = 'none'; };
    const start = document.createElement('button');
    start.type = 'button';
    start.className = 'sp-start';
    start.textContent = '开播';
    start.onclick = event => { event.stopPropagation(); applyPerson(person, true); };
    const info = document.createElement('div');
    info.className = 'sp-info';
    const name = document.createElement('div');
    name.className = 'sp-name';
    name.textContent = person.name;
    const meta = document.createElement('div');
    meta.className = 'sp-meta';
    meta.textContent = person.meta;
    info.append(name, meta);
    card.append(image, start, info);
    card.onclick = () => applyPerson(person, false);
    card.onkeydown = event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); applyPerson(person, false); }
    };
    host.appendChild(card);
  }
}

function syncSuyuControls(personaId) {
  const controls = document.getElementById('suyuScriptControls');
  if (!controls) return;
  const selected = personaId || $('showroomPersona')?.value || '';
  const isSuyu = selected === 'suyu';
  const isGaoxiao = selected === 'gaoxiao';
  const isXiaomei = selected === 'xiaomei';
  controls.hidden = !isSuyu && !isGaoxiao && !isXiaomei;
  if (!controls.hidden) {
    const preset = $('suyuPreset');
    if (preset) preset.value = isSuyu ? 'suyu' : isXiaomei ? 'xiaomei_clip' : 'hotdance';
  }
}

async function applyPerson(person, startAfter) {
  const industry = catalog?.industries.find(item => item.id === person.industry);
  selectedIndustry = person.industry;
  selectedScene = person.scene;
  $('showroomPersona').value = person.persona;
  $('showroomScript').value = person.script;
  $('showroomAction').value = person.action;
  syncSuyuControls(person.persona);
  const script = SPEECH_SCRIPTS[person.name];
  const choices = OPENINGS[person.name] || [];
  const opening = script?.opening || (choices.length ? choices[Math.floor(Math.random() * choices.length)] : (currentScript()?.opening || ''));
  $('showroomOpening').value = opening.replace(/^\s*「[^」]{1,30}」\s*/u, '').trim();
  window.__showroomSequence = script ? {
    name: person.name,
    persona_id: person.persona,
    lines: [script.opening, ...(script.proactive || [])],
  } : null;
  window.__showroomNatural = Boolean(person.natural);
  setParams(industry?.params || {});
  renderIndustries();
  renderScenes();
  status(`已选人物：${person.name} · ${person.meta}`);
  return apply(startAfter, person.outfit, person.voice);
}

/* 中控台「酥鱼专属脚本」：自动应用酥鱼形象；设定版自动开播后播放脚本 */
async function startSuSuPreset(preset, preview = false) {
  const personaId = preset === 'hotdance' ? 'gaoxiao' : (preset === 'xiaomei' || preset === 'xiaomei_clip') ? 'xiaomei' : 'suyu';
  const person = PEOPLE.find(item => item.persona === personaId);
  if (!person) return;
  status(`${person.name}脚本 · 正在应用形象…`);
  await applyPerson(person, false);
  if (preview) {
    status(`${person.name}脚本 · 预演版开始（不推流）`);
    window.__playSuyuScript?.('preview', preset);
    return;
  }
  if (!window.S2Bridge?.isRunning?.()) {
    status(`${person.name}脚本 · 正在开播…`);
    await window.S2Bridge.startLive();
    for (let i = 0; i < 60 && !window.S2Bridge?.isRunning?.(); i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  if (!window.S2Bridge?.isRunning?.()) {
    status(`${person.name}脚本 · 开播未就绪，请手动点「开始直播」后重试`, true);
    return;
  }
  status(`${person.name}脚本 · 设定版开始播放`);
  window.__playSuyuScript?.('live', preset);
}
window.__startSuSuPreset = startSuSuPreset;


function renderIndustries() {
  const host = $('showroomIndustries');
  host.replaceChildren();
  for (const industry of catalog.industries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `showroom-industry${industry.id === selectedIndustry ? ' active' : ''}`;
    const title = document.createElement('b');
    title.textContent = `${industry.icon} ${industry.name}`;
    const desc = document.createElement('small');
    desc.textContent = industry.tagline;
    button.append(title, desc);
    button.onclick = () => applyIndustry(industry);
    host.appendChild(button);
  }
}

function renderScenes() {
  const host = $('showroomScenes');
  host.replaceChildren();
  for (const scene of catalog.scenes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `showroom-scene${scene.id === selectedScene ? ' active' : ''}`;
    const image = document.createElement('img');
    image.src = scene.image;
    image.alt = scene.name;
    image.loading = 'lazy';
    image.onerror = () => { image.style.display = 'none'; };
    const label = document.createElement('span');
    label.textContent = `${scene.name} · ${scene.subtitle}`;
    button.append(image, label);
    button.onclick = () => {
      selectedScene = scene.id;
      renderScenes();
      status(`场景：${scene.name} · ${scene.prompt}（人物与形象独立，可在上方单独选人物）`);
    };
    host.appendChild(button);
  }
}

function renderOptions() {
  const personaSelect = $('showroomPersona');
  personaSelect.replaceChildren();
  for (const persona of catalog.personas) {
    const option = document.createElement('option');
    option.value = persona.id;
    option.textContent = `${persona.name} · ${persona.category || ''}`;
    personaSelect.appendChild(option);
  }

  const scriptSelect = $('showroomScript');
  scriptSelect.replaceChildren();
  for (const script of catalog.scripts) {
    const option = document.createElement('option');
    option.value = script.id;
    option.textContent = `${script.name} · ${script.industry}`;
    scriptSelect.appendChild(option);
  }

  const actionSelect = $('showroomAction');
  actionSelect.replaceChildren();
  for (const action of catalog.actions) {
    const option = document.createElement('option');
    option.value = action.id;
    option.textContent = `${action.name} · ${action.desc}`;
    actionSelect.appendChild(option);
  }
}

function setParams(triggers = {}) {
  $('showroomSilence').value = Number(triggers.silence_s ?? 10);
  $('showroomIdle').value = Number(triggers.idle_motion_s ?? 0);
  $('showroomSmalltalk').value = Number(triggers.smalltalk_probability ?? 0.85);
}

function applyIndustry(industry) {
  selectedIndustry = industry.id;
  const recommended = industry.recommended;
  selectedScene = recommended.scene_id;
  $('showroomPersona').value = recommended.persona_id;
  $('showroomScript').value = recommended.script_id;
  $('showroomAction').value = recommended.action_id;
  $('showroomOpening').value = currentScript()?.opening || '';
  setParams(industry.params);
  renderIndustries();
  renderScenes();
  status(`${industry.name}：${industry.tagline}`);
}

function syncFromState(state) {
  selectedIndustry = state.industry_id || 'social';
  selectedScene = state.scene_id || 'living_room';
  $('showroomPersona').value = state.persona_id;
  $('showroomScript').value = state.script_id;
  $('showroomAction').value = state.action_id;
  $('showroomOpening').value = state.opening || '';
  syncSuyuControls(state.persona_id);
  setParams(state.triggers || {});
  renderIndustries();
  renderScenes();
}

async function apply(startAfter = false, preferredOutfit = '', preferredVoice = '') {
  if (!catalog) return false;
  let applied = false;
  const payload = {
    industry_id: selectedIndustry,
    scene_id: selectedScene,
    persona_id: $('showroomPersona').value,
    voice_id: preferredVoice || undefined,
    script_id: $('showroomScript').value,
    action_id: $('showroomAction').value,
    opening: $('showroomOpening').value.trim(),
    triggers: {
      silence_s: Number($('showroomSilence').value),
      idle_motion_s: Number($('showroomIdle').value),
      smalltalk_probability: Number($('showroomSmalltalk').value),
    },
  };
  const button = $('showroomApply');
  button.disabled = true;
  status('正在写入控制台…');
  try {
    const response = await fetch('/api/showroom/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (data.showroom) syncFromState(data.showroom);
    const script = currentScript();
    const scene = catalog.scenes.find(item => item.id === selectedScene);
    const outfit = outfits.find(item => item.name === (preferredOutfit || scene?.outfit_name));
    let sceneNote = outfit ? '' : '；场景参考已应用，出镜形象请在造型库选择';
    if (outfit) {
      if (window.S2Bridge?.isRunning?.()) {
        sceneNote = `；直播中换场景请到造型库应用「${outfit.name}」`;
      } else {
        try {
          await window.S2Bridge?.applyOutfit?.(outfit);
          sceneNote = `；已切换场景形象「${outfit.name}」`;
        } catch {
          sceneNote = `；场景形象「${outfit.name}」需在造型库手动应用`;
        }
      }
    }
    status(`已应用：${script?.name || ''} · ${currentAction()?.name || ''} · 场景 ${scene?.name || selectedScene}${sceneNote}`);
    window.dispatchEvent(new CustomEvent('showroom-applied', { detail: data }));
    applied = true;
  } catch (error) {
    status(`应用失败：${error.message}`, true);
    return false;
  } finally {
    button.disabled = false;
  }
  if (applied && startAfter) {
    if (window.S2Bridge?.isRunning?.()) {
      status('当前已在直播中，人物与话术已应用');
      return true;
    }
    status('已应用，正在开播…');
    try {
      await window.S2Bridge?.startLive?.();
    } catch (error) {
      status(`应用成功，但开播失败：${error.message}`, true);
      return false;
    }
  }
  return applied;
}

async function tryActions() {
  const bridge = window.S2Bridge;
  const action = currentAction();
  if (!bridge?.isRunning?.()) { status('先开始直播，再试动作', true); return; }
  if (!action) return;
  const group = action.groups.silence || action.groups.greet || [];
  if (!group.length) { status('当前动作模板没有可试动作', true); return; }
  status(`试动作：${group.slice(0, 2).join(' / ')}`);
  for (const name of group.slice(0, 2)) {
    bridge.sendAction(name);
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
}

async function load() {
  if (!$('showroomIndustries')) return;
  try {
    const [response, outfitResponse] = await Promise.all([
      fetch('/api/showroom'),
      fetch('/api/outfits').catch(() => null),
    ]);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    catalog = await response.json();
    outfits = outfitResponse?.ok ? (await outfitResponse.json()).items || [] : [];
    renderOptions();
    renderPeople();
    syncFromState(catalog.state);
    status(`当前：${catalog.state.persona_id} · ${catalog.state.script_id} · ${catalog.state.action_id}`);
  } catch (error) {
    status(`样板间加载失败：${error.message}`, true);
  }
  $('showroomApply').onclick = () => apply();
  $('showroomTry').onclick = () => tryActions();
  const naturalDemo = $('naturalDemo');
  if (naturalDemo) naturalDemo.onclick = () => {
    const person = PEOPLE.find(item => item.natural);
    if (person) return applyPerson(person, true);
  };
  $('showroomScript').onchange = () => {
    const script = currentScript();
    if (script) $('showroomOpening').value = script.opening;
  };
  $('showroomPersona').onchange = () => syncSuyuControls();
}

load();

const showroomNav = document.getElementById('showroomNav');
if (showroomNav) {
  showroomNav.addEventListener('click', () => {
    const drawer = document.getElementById('consoleDrawer');
    if (drawer?.hidden) document.getElementById('consoleButton')?.click();
    setTimeout(() => document.getElementById('csShowroom')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250);
  });
}

const showroomTopNav = document.getElementById('showroomTopNav');
if (showroomTopNav) {
  showroomTopNav.addEventListener('click', event => {
    event.preventDefault();
    const drawer = document.getElementById('consoleDrawer');
    if (drawer?.hidden) document.getElementById('consoleButton')?.click();
    setTimeout(() => document.getElementById('csShowroom')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250);
  });
}
