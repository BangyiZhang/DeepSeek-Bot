import fs from 'node:fs/promises';
import path from 'node:path';

const position = process.argv.indexOf('--library');
if (position < 0 || !process.argv[position + 1]) throw new Error('Provide --library with an explicit destination.');
const home = path.resolve(process.argv[position + 1]);
const manifest = JSON.parse(await fs.readFile(new URL('./download-manifest.json', import.meta.url), 'utf8'));
const groups = [
  ['强颜欢笑', ['强颜欢笑', '职业假笑', 'i-am-fine', '好的呢'], ['假笑', '表面没事', '勉强营业', '苦笑']],
  ['委屈难过', ['泪水', '窝囊', '命运给我', '一直在打我', '被咬', '卡住喉咙'], ['委屈', '难过', '破防', '被生活暴打']],
  ['委屈道歉', ['对不起'], ['道歉', '抱歉', '对不起', '认错']],
  ['崩溃无语', ['苍天', '头大', '翻车', '跳了bro', '没眼看', '吃不下', '哎鸭'], ['崩溃', '无语', '翻车', '顶不住', '头疼']],
  ['躺平自闭', ['不想加油', '不想做', '只想玩', '看开点', '阴暗', '中不溜', '收到办不到', '周一', '忌讳'], ['躺平', '摆烂', '不想上班', '拒绝内耗', '自嘲']],
  ['看戏吃瓜', ['不简单', '快看', '警觉', '眼色'], ['吃瓜', '围观', '事情不简单', '警觉', '看戏']],
  ['开心庆祝', ['开心', '转正', '得意', '音乐', '扭屁股', '长发飘飘'], ['开心', '庆祝', '好耶', '得意', '快乐']],
  ['加油行动', ['冲鸭', '干票大的', '我来啦'], ['加油', '冲', '行动', '开干', '来了']],
  ['思考困惑', ['思考', '迷茫', '挠头', '愣住', 'emm', '左右摇摆', '约会是什么意思', '双眼', '老的老'], ['思考', '疑惑', '迷茫', '犹豫', '愣住']],
  ['亲昵安慰', ['亲我', '壁咚', '捏脸', '摸摸头', '小被子', '爱河', '等心肝', '接住'], ['安慰', '抱抱', '贴贴', '喜欢', '摸摸头']],
  ['孤独酸涩', ['单身', '寂寞', '舔狗', '柠檬', '蜜雪冰城'], ['单身', '孤独', '酸了', '羡慕', '自嘲']],
  ['害怕退缩', ['不要过来', '抱树'], ['害怕', '退退退', '别过来', '躲避']],
  ['尴尬害羞', ['没脸见人', '微笑', '行8', '行吧'], ['尴尬', '害羞', '行吧', '勉强同意']],
  ['吐槽制止', ['不要再说', '不许这样', '打屁股', '锁在办公室', '不要来'], ['吐槽', '制止', '别说了', '不许', '反抗']],
  ['轻松日常', ['下班', '干嘛', '带我玩', '太撑', '荡', '狗刨', '锻炼', '敷面膜', '管理意识', '三只狗', '大狗脸', '都是狗'], ['日常', '休息', '玩耍', '摸鱼']],
  ['平静淡定', ['一脸平静'], ['淡定', '平静', '稳住', '毫无波澜']],
  ['已读沉默', ['已读不回'], ['已读不回', '沉默', '细品', '暂不回复']],
  ['幽默调侃', ['狗头', '邪魅', '不费token', '蚊子', '人参和醋', '被我干掉', '跳起一只狗'], ['调侃', '搞怪', '狗头', '玩笑']]
];
const entries = manifest.files.map((file, position) => {
  const filename = path.basename(file.path);
  const match = filename.match(/^[^-]+-(.+)\.[^.]+$/u);
  const meaning = match ? match[1].replaceAll('-', '，') : 'Unlabeled image; manual review required';
  const selected = match ? groups.filter(([, words]) => words.some(word => filename.toLowerCase().includes(word.toLowerCase()))) : [];
  const categories = selected.length ? [...new Set(selected.map(group => group[0]))] : ['待人工标注'];
  const triggers = match ? [...new Set([meaning, ...selected.flatMap(group => group[2]), ...match[1].split('-')])] : [];
  const relative = `.memes/${file.path}`;
  return {
    id: `chinesebqb-${file.gitBlobSha1.slice(0, 12)}-${position + 1}`,
    series: file.path.split('/')[0], filename, path: relative,
    markdown: `![${match ? meaning : '表情'}](<${relative}>)`,
    meaning, emotions: categories, triggers,
    semanticSource: match ? 'filename-and-curated-keyword-rules' : 'unlabeled',
    semanticConfidence: selected.length ? 'medium' : 'unknown',
    visuallyReviewed: false,
    autoSelect: selected.length > 0,
    source: { repository: manifest.repository, commit: manifest.commit, path: file.path, gitBlobSha1: file.gitBlobSha1 },
    bytes: file.bytes, sha256: file.sha256
  };
});
const byEmotion = {};
const byTrigger = {};
for (const entry of entries) {
  for (const emotion of entry.emotions) (byEmotion[emotion] ??= []).push(entry.id);
  for (const trigger of entry.triggers) (byTrigger[trigger] ??= []).push(entry.id);
}
const index = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), repository: `https://github.com/${manifest.repository}`,
  commit: manifest.commit, workspaceLink: '.memes',
  semanticNotice: 'Meanings derive from filenames and curated rules; no visual review is claimed. Unlabeled entries must not be selected automatically.',
  usage: 'Select through triggers or byEmotion and use the markdown value relative to the workspace.',
  counts: { total: entries.length, bySeries: Object.fromEntries([...new Set(entries.map(entry => entry.series))].map(series => [series, entries.filter(entry => entry.series === series).length])), needsReview: entries.filter(entry => !entry.autoSelect).length },
  byEmotion, byTrigger, entries
};
await fs.writeFile(path.join(home, 'index.json'), JSON.stringify(index, null, 2));
console.log(JSON.stringify(index.counts, null, 2));
