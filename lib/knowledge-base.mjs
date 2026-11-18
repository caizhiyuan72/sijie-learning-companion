// The knowledge base is intentionally small and teacher-reviewable. Cards
// contain a principle and a question that can move one learning action
// forward; they never contain a worked solution or a student's answer.

const CURRICULUM_REFERENCE = Object.freeze({
  id: "moe-math-curriculum-2022",
  version: "2022",
  title: "义务教育数学课程标准（2022年版）",
  url: "https://www.moe.gov.cn/srcsite/A26/s8001/202204/W020220420582346895190.pdf",
  publisher: "中华人民共和国教育部",
  reason: "用于核对初中数学内容领域与术语范围；卡片表述仍需教师复核。"
});

// These open educational-text pages are used only as reference pointers. The
// Chinese card wording is an original short summary and still requires a
// teacher review before publication.
const DETAIL_REFERENCES = Object.freeze({
  isosceles: Object.freeze({ id: "euclid-book1-proposition5", version: "web", title: "Euclid’s Elements I.5：等腰三角形的底角", url: "https://mathcs.clarku.edu/~djoyce/elements/bookI/propI5.html", publisher: "Clark University / D. E. Joyce", reason: "核对等腰三角形底角相等的命题；其他线段关系仍需额外条件。" }),
  parallel: Object.freeze({ id: "mathopenref-alternate-interior", version: "web", title: "Math Open Reference：平行线与内错角", url: "https://www.mathopenref.com/anglesalternateinterior.html", publisher: "Math Open Reference", reason: "核对平行条件下的内错角关系与非平行情形的区别。" }),
  fractions: Object.freeze({ id: "openstax-fractions-4-2", version: "2e", title: "OpenStax Prealgebra 2e：分数乘除", url: "https://openstax.org/books/prealgebra-2e/pages/4-2-multiply-and-divide-fractions", publisher: "OpenStax", reason: "核对分数乘法及一个量的几分之几。" }),
  percent: Object.freeze({ id: "openstax-percent-6-2", version: "2e", title: "OpenStax Prealgebra 2e：百分数应用", url: "https://openstax.org/books/prealgebra-2e/pages/6-2-solve-general-applications-of-percent", publisher: "OpenStax", reason: "核对百分数的基准量和变化关系。" }),
  equation: Object.freeze({ id: "openstax-prealgebra-equations-2-3", version: "2e", title: "OpenStax Prealgebra 2e：使用等式的加减性质解方程", url: "https://openstax.org/books/prealgebra-2e/pages/2-3-solving-equations-using-the-subtraction-and-addition-properties-of-equality", publisher: "OpenStax", reason: "核对等式两边进行相同加减运算的基础表述；乘除性质仍需按题目条件核验。" }),
  rational: Object.freeze({ id: "openstax-prealgebra-signed-numbers-3", version: "2e", title: "OpenStax Prealgebra 2e：有理数与符号运算", url: "https://openstax.org/books/prealgebra-2e/pages/3-key-concepts", publisher: "OpenStax", reason: "核对有理数符号、乘除号和相反数的基础范围。" }),
  polynomial: Object.freeze({ id: "openstax-elementary-algebra-polynomials-6-3", version: "2e", title: "OpenStax Elementary Algebra 2e：整式乘法与分配律", url: "https://openstax.org/books/elementary-algebra-2e/pages/6-3-multiply-polynomials", publisher: "OpenStax", reason: "核对分配律和整式展开的基础表述。" }),
  inequality: Object.freeze({ id: "openstax-elementary-algebra-inequality-2-7", version: "2e", title: "OpenStax Elementary Algebra 2e：一元一次不等式", url: "https://openstax.org/books/elementary-algebra-2e/pages/2-7-solve-linear-inequalities", publisher: "OpenStax", reason: "核对乘除负数时不等号反向的基础表述。" }),
  proportion: Object.freeze({ id: "openstax-prealgebra-proportions-6-5", version: "2e", title: "OpenStax Prealgebra 2e：比例及其应用", url: "https://openstax.org/books/prealgebra-2e/pages/6-5-solve-proportions-and-their-applications", publisher: "OpenStax", reason: "核对比例关系与对应量的基础表述。" }),
  function: Object.freeze({ id: "openstax-elementary-algebra-linear-4", version: "2e", title: "OpenStax Elementary Algebra 2e：线性方程图象与斜率", url: "https://openstax.org/books/elementary-algebra-2e/pages/4-key-concepts", publisher: "OpenStax", reason: "核对变量对应关系、图象和变化率的基础范围。" }),
  congruence: Object.freeze({ id: "mathopenref-congruent-triangles", version: "web", title: "Math Open Reference：Congruent Triangles", url: "https://www.mathopenref.com/congruenttriangles.html", publisher: "Math Open Reference", reason: "核对三角形全等定义、SSS/SAS/ASA/AAS等判定及常见反例。" }),
  pythagorean: Object.freeze({ id: "openstax-elementary-algebra-pythagorean-3-4", version: "2e", title: "OpenStax Elementary Algebra 2e：勾股定理", url: "https://openstax.org/books/elementary-algebra-2e/pages/3-4-solve-geometry-applications-triangles-rectangles-and-the-pythagorean-theorem", publisher: "OpenStax", reason: "核对直角三角形两直角边与斜边的平方关系。" }),
  similarity: Object.freeze({ id: "openstax-elementary-algebra-similar-figures-8-7", version: "2e", title: "OpenStax Elementary Algebra 2e：相似图形比例应用", url: "https://openstax.org/books/elementary-algebra-2e/pages/8-7-solve-proportion-and-similar-figure-applications", publisher: "OpenStax", reason: "核对相似图形对应边比例与对应角关系。" }),
  statistics: Object.freeze({ id: "openstax-intro-statistics-center-2-5", version: "2e", title: "OpenStax Introductory Statistics 2e：数据中心趋势", url: "https://openstax.org/books/introductory-statistics-2e/pages/2-5-measures-of-the-center-of-the-data", publisher: "OpenStax", reason: "核对平均数、中位数和众数的基础含义。" }),
  probability: Object.freeze({ id: "openstax-intro-statistics-probability-3-1", version: "2e", title: "OpenStax Introductory Statistics 2e：概率术语", url: "https://openstax.org/books/introductory-statistics-2e/pages/3-1-terminology", publisher: "OpenStax", reason: "核对样本空间、事件、等可能结果和简单概率的基础含义。" }),
  modeling: Object.freeze({ id: "openstax-college-algebra-linear-modeling-4-2", version: "2e", title: "OpenStax College Algebra 2e：线性函数建模", url: "https://openstax.org/books/college-algebra-2e/pages/4-introduction-to-linear-functions", publisher: "OpenStax", reason: "核对将实际情境转成变量关系并解释模型的范围。" })
});

const CARD_STATUSES = Object.freeze(["draft", "published", "archived", "disabled"]);
const DEFAULT_STAGE_STRATEGIES = Object.freeze({
  initial_thinking: Object.freeze({
    id: "protect-initial-thinking",
    stage: "initial_thinking",
    action: "withhold",
    instruction: "先让学生整理已知条件和目标，暂不展示知识卡。"
  }),
  task_generation: Object.freeze({
    id: "task-generation-teaching-contract",
    stage: "task_generation",
    action: "plan",
    instruction: "只把已确认题面整理为可执行的学习任务；知识卡作为服务端候选参照，不替学生选择解法。"
  }),
  help: Object.freeze({
    id: "help-one-action",
    stage: "help",
    action: "question",
    instruction: "只推进一个认知动作，先询问适用条件，不直接给出解题链。"
  }),
  hint_level_1: Object.freeze({
    id: "hint-level-1",
    stage: "hint_level_1",
    action: "locate",
    instruction: "让学生从题面找出一个数量、关系或图形条件。"
  }),
  hint_level_2: Object.freeze({
    id: "hint-level-2",
    stage: "hint_level_2",
    action: "connect",
    instruction: "把知识卡原则连接到题目中的一个局部关系，仍不写完整解法。"
  }),
  hint_level_3: Object.freeze({
    id: "hint-level-3",
    stage: "hint_level_3",
    action: "scaffold",
    instruction: "给出最小脚手架，让学生补上缺失的一步，并保留核验责任。"
  }),
  judgment: Object.freeze({
    id: "judgment-check",
    stage: "judgment",
    action: "verify",
    instruction: "让学生核验AI建议是否满足知识卡的适用条件。"
  }),
  transfer: Object.freeze({
    id: "transfer-independent",
    stage: "transfer",
    action: "transfer",
    instruction: "先让学生独立迁移方法，知识卡不作为迁移题答案入口。"
  }),
  reflection: Object.freeze({
    id: "reflection-recall",
    stage: "reflection",
    action: "reflect",
    instruction: "让学生说明自己完成的部分、AI帮助和下次起步策略。"
  })
});

const SEED_CARDS = Object.freeze([
  {
    id: "equation", version: 1, status: "published", title: "等式的基本性质", category: "数与代数", subject: "初中数学",
    gradeRange: ["七年级", "八年级", "九年级"], keywords: ["一元一次方程", "解方程", "等式的性质", "等式两边", "移项"], aliases: ["方程", "未知数", "等式变形"],
    principle: "等式两边同时进行相同的加减运算，等式仍成立；同时乘或除以同一个非零数，等式也仍成立。",
    question: "为了让未知数更容易观察，可以先对等式两边进行什么相同的操作？",
    applicableWhen: ["题目给出等式或方程", "所乘或所除的数需要确认不为零"], avoidWhen: ["题目还没有形成等式", "把移项当成不说明依据的变号口诀"],
    source: "项目自编基础知识卡（待教师复核）", references: [CURRICULUM_REFERENCE, DETAIL_REFERENCES.equation]
  },
  {
    id: "rational-numbers", version: 1, status: "published", title: "有理数与符号运算", category: "数与代数", subject: "初中数学",
    gradeRange: ["七年级"], keywords: ["有理数", "正数", "负数", "相反数", "绝对值", "符号运算"], aliases: ["负数", "数轴", "有理数运算"],
    principle: "进行有理数运算时，先判断运算符号和数的符号，再按相应的运算法则处理绝对值；结果要回到题目的量和单位。",
    question: "这一步先要判断两个数的符号关系，还是先计算它们的绝对值？",
    applicableWhen: ["题目出现正负数或有理数运算", "数轴、相反数或绝对值的含义已经明确"], avoidWhen: ["只比较绝对值就判断数的大小规律", "漏掉负号或把减法当作交换运算"],
    source: "项目自编基础知识卡（待教师复核）", references: [CURRICULUM_REFERENCE, DETAIL_REFERENCES.rational]
  },
  {
    id: "polynomial-distributive", version: 1, status: "published", title: "整式与分配律", category: "数与代数", subject: "初中数学",
    gradeRange: ["七年级", "八年级"], keywords: ["整式", "单项式", "多项式", "分配律", "合并同类项", "去括号"], aliases: ["同类项", "代数式化简", "整式运算"],
    principle: "化简整式时，先正确使用分配律和去括号，再合并同类项；同类项必须有相同的字母及相同的指数。",
    question: "括号里的每一项都乘到了吗？接下来哪些项的字母和指数完全相同？",
    applicableWhen: ["题目要求化简或展开整式", "括号前的因式和同类项可以明确"], avoidWhen: ["只给第一项乘括号内因式", "把不同指数或不同字母的项合并"],
    source: "项目自编基础知识卡（待教师复核）", references: [CURRICULUM_REFERENCE, DETAIL_REFERENCES.polynomial]
  },
  {
    id: "inequality", version: 1, status: "published", title: "一元一次不等式", category: "数与代数", subject: "初中数学",
    gradeRange: ["七年级", "八年级"], keywords: ["不等式", "不等号", "解不等式", "大于", "小于", "解集"], aliases: ["不等式组", "数轴表示", "变号"],
    principle: "不等式两边同加、同减同一个数时方向不变；同乘或同除负数时不等号必须反向，最后要用数轴或代入检查解集。",
    question: "这一步是否要乘或除以负数？如果要，解集的不等号方向需要怎样变化？",
    applicableWhen: ["题目要求解不等式或表示解集", "每一步的乘除数符号已经确认"], avoidWhen: ["把不等式完全当作等式处理", "乘除负数后忘记反向或漏写端点"],
    source: "项目自编基础知识卡（待教师复核）", references: [CURRICULUM_REFERENCE, DETAIL_REFERENCES.inequality]
  },
  {
    id: "proportion", version: 1, status: "published", title: "比例关系", category: "数与代数", subject: "初中数学",
    gradeRange: ["七年级", "八年级", "九年级"], keywords: ["比例", "成正比", "成反比", "比值", "按比例", "比例关系"], aliases: ["相同比", "对应量", "比例式"],
    principle: "比例式表示两个比相等；建立比例关系时，要先确认对应量的顺序和分母不为零。",
    question: "题目中哪些量相互对应？它们之间的比是否保持不变？",
    applicableWhen: ["题目明确给出两个或多组对应量", "对应量的单位和顺序可以对齐"], avoidWhen: ["只看到两个数就直接设比例", "对应关系和基准量尚未确认"],
    source: "项目自编基础知识卡（待教师复核）", references: [CURRICULUM_REFERENCE, DETAIL_REFERENCES.proportion]
  },
  {
    id: "fraction-of", version: 1, status: "published", title: "一个量的几分之几", category: "数与代数", subject: "初中数学",
    gradeRange: ["七年级", "八年级"], keywords: ["几分之几", "的三分之", "的五分之", "的八分之", "的十分之", "的百分之", "分数乘法"], aliases: ["分数关系", "部分与整体", "基准量"],
    principle: "求一个量的几分之几，可以先明确作为基准的量，再用这个量乘相应的分数。连续关系中，每一步的基准需要分别确认。",
    question: "当前这个分数对应的是哪个量？下一步的基准量会改变吗？",
    applicableWhen: ["题目明确说明部分量与基准量的关系", "分数的分子、分母含义可以对应到题面"], avoidWhen: ["连续关系中沿用错误的基准量", "把百分数或分数关系直接当成加法关系"],
    source: "项目自编基础知识卡（待教师复核）", references: [CURRICULUM_REFERENCE, DETAIL_REFERENCES.fractions]
  },
  {
    id: "linear-function", version: 1, status: "published", title: "一次函数的对应关系", category: "函数", subject: "初中数学",
    gradeRange: ["八年级", "九年级"], keywords: ["一次函数", "函数", "自变量", "因变量", "图象", "斜率"], aliases: ["函数关系式", "对应法则", "增减变化"],
    principle: "研究一次函数时，要先明确自变量、因变量和对应关系，再用表格、式子或图象核对变化方向。",
    question: "题目中哪个量是自变量？另一个量如何随它变化？",
    applicableWhen: ["题目给出变量之间的对应关系", "表格、式子和图象表示的是同一关系"], avoidWhen: ["把一个具体点的数值当成整条关系", "尚未确认横纵坐标含义就判断增减"],
    source: "项目自编基础知识卡（待教师复核）", references: [CURRICULUM_REFERENCE, DETAIL_REFERENCES.function]
  },
  {
    id: "isosceles", version: 1, status: "published", title: "等腰三角形的性质", category: "图形与几何", subject: "初中数学",
    gradeRange: ["八年级", "九年级"], keywords: ["等腰三角形", "两腰相等", "等边对等角"], aliases: ["底角相等", "三线合一", "腰和底边"],
    principle: "等腰三角形的两腰相等，对应的两个底角也相等；使用中线、角平分线与高之间的关系时，还要确认线段所满足的具体条件。",
    question: "题目已经明确了哪两条边相等？所讨论的线段满足什么条件？",
    applicableWhen: ["题目明确指出两腰相等或给出可推出相等的条件", "使用三线合一时核对中线、角平分线或高的条件"], avoidWhen: ["只凭图形外观判断相等", "把任意中线、角平分线和高都当成三线合一"],
    source: "项目自编基础知识卡（待教师复核）", references: [CURRICULUM_REFERENCE, DETAIL_REFERENCES.isosceles]
  },
  {
    id: "parallel-lines", version: 1, status: "published", title: "平行线与角", category: "图形与几何", subject: "初中数学",
    gradeRange: ["七年级", "八年级"], keywords: ["两直线平行", "两条直线平行", "平行线", "同位角", "内错角"], aliases: ["同旁内角", "截线", "角关系"],
    principle: "两条平行线被第三条直线所截时，可以利用同位角相等、内错角相等或同旁内角互补等关系。",
    question: "题目明确给出哪两条直线平行？要找的角是否由同一条截线形成？",
    applicableWhen: ["题面明确给出平行关系或已经证明平行", "两个角的位置关系可以由同一条截线确认"], avoidWhen: ["只凭图形看起来平行", "未确认角的位置就套用同位角或内错角"],
    source: "项目自编基础知识卡（待教师复核）", references: [CURRICULUM_REFERENCE, DETAIL_REFERENCES.parallel]
  },
  {
    id: "congruence", version: 1, status: "published", title: "三角形全等", category: "图形与几何", subject: "初中数学",
    gradeRange: ["八年级", "九年级"], keywords: ["全等三角形", "三角形全等", "证明全等", "三角形≌", "三角形全等的判定"], aliases: ["SSS", "SAS", "ASA", "AAS", "对应边", "对应角"],
    principle: "判断三角形全等时，可以检查已知的对应边和对应角是否满足适用的全等判定条件。",
    question: "先找两组三角形的对应顶点：已知哪些对应边或对应角？",
    applicableWhen: ["两组三角形的对应关系能够逐项对齐", "已知条件满足一个适用的全等判定"], avoidWhen: ["只写出三个角相等就断言全等", "对应顶点顺序没有确认"],
    source: "项目自编基础知识卡（待教师复核）", references: [CURRICULUM_REFERENCE, DETAIL_REFERENCES.congruence]
  },
  {
    id: "pythagorean", version: 1, status: "published", title: "勾股定理", category: "图形与几何", subject: "初中数学",
    gradeRange: ["八年级", "九年级"], keywords: ["勾股定理", "直角三角形", "斜边", "两直角边", "勾股"], aliases: ["a²+b²=c²", "直角边", "平方关系"],
    principle: "只有在直角三角形中，才可以用两条直角边的平方和等于斜边的平方；使用前先确认直角和斜边位置。",
    question: "题目已经确认哪个角是直角？哪一条边与这个直角相对，是斜边？",
    applicableWhen: ["题目明确给出直角三角形", "两条直角边和斜边的位置可以确认"], avoidWhen: ["把任意三角形都套用勾股定理", "把最长边之外的边当作斜边"],
    source: "项目自编基础知识卡（待教师复核）", references: [CURRICULUM_REFERENCE, DETAIL_REFERENCES.pythagorean]
  },
  {
    id: "similarity", version: 1, status: "published", title: "相似三角形与对应比例", category: "图形与几何", subject: "初中数学",
    gradeRange: ["八年级", "九年级"], keywords: ["相似三角形", "相似图形", "对应边成比例", "对应角相等", "相似"], aliases: ["相似比", "比例线段", "对应顶点"],
    principle: "判断相似时，要先确认对应角和对应边的顺序；相似三角形的对应角相等、对应边成比例。",
    question: "两组三角形的对应顶点如何排列？对应边的比是否保持一致？",
    applicableWhen: ["两组三角形的对应关系可以逐项确认", "题面给出角关系或对应边比例"], avoidWhen: ["只凭一组边比相等就断言相似", "对应顶点顺序错位后继续列比例"],
    source: "项目自编基础知识卡（待教师复核）", references: [CURRICULUM_REFERENCE, DETAIL_REFERENCES.similarity]
  },
  {
    id: "percentage", version: 1, status: "published", title: "百分数与变化", category: "数与代数", subject: "初中数学",
    gradeRange: ["七年级", "八年级"], keywords: ["百分比", "百分之", "增长率", "下降率", "折扣"], aliases: ["变化率", "原量", "现量"],
    principle: "百分数表示以一百为基数的比；计算增长或下降时，先确认变化前的基准量及变化方向。",
    question: "题目中的百分数以哪个量为基准？它表示增加、减少，还是部分占整体？",
    applicableWhen: ["题目明确给出变化前后或整体与部分", "百分数的基准量和方向可以从题面确认"], avoidWhen: ["把增长率直接当作变化后的量", "忽略题目中的基准量变化"],
    source: "项目自编基础知识卡（待教师复核）", references: [CURRICULUM_REFERENCE, DETAIL_REFERENCES.percent]
  },
  {
    id: "statistics", version: 1, status: "published", title: "统计量与数据分布", category: "统计与概率", subject: "初中数学",
    gradeRange: ["七年级", "八年级", "九年级"], keywords: ["平均数", "中位数", "众数", "统计图", "数据分析", "频数"], aliases: ["数据分布", "样本", "频率"],
    principle: "分析数据时，先确认数据对象和统计量的定义，再结合数据分布判断代表性，不能只看一个极端值。",
    question: "题目要求比较或描述什么？选择的统计量能代表这组数据吗？",
    applicableWhen: ["数据范围和统计量定义已经明确", "统计图的横纵坐标及单位可读"], avoidWhen: ["把平均数、中位数和众数混为一谈", "忽略样本数量或统计图坐标"],
    source: "项目自编基础知识卡（待教师复核）", references: [CURRICULUM_REFERENCE, DETAIL_REFERENCES.statistics]
  },
  {
    id: "probability", version: 1, status: "published", title: "简单随机事件的概率", category: "统计与概率", subject: "初中数学",
    gradeRange: ["八年级", "九年级"], keywords: ["概率", "随机事件", "等可能", "频率", "可能性"], aliases: ["样本空间", "事件发生", "频率估计概率"],
    principle: "计算简单事件的概率时，先列出在题目条件下可能出现的结果，再判断这些结果是否等可能。",
    question: "所有可能结果是否已经列全？它们在当前条件下等可能吗？",
    applicableWhen: ["试验规则和结果范围明确", "等可能性或频率估计的条件已经说明"], avoidWhen: ["只凭直觉判断可能性", "未确认结果是否等可能就直接相除"],
    source: "项目自编基础知识卡（待教师复核）", references: [CURRICULUM_REFERENCE, DETAIL_REFERENCES.probability]
  },
  {
    id: "modeling", version: 1, status: "published", title: "实际问题的数学建模", category: "综合与实践", subject: "初中数学",
    gradeRange: ["七年级", "八年级", "九年级"], keywords: ["实际问题", "数学建模", "建立模型", "方案", "优化"], aliases: ["数量关系", "情境问题", "解释结果"],
    principle: "解决实际问题时，先把情境中的量和关系转成数学模型，再检查模型的条件、单位和结果是否回到原情境。",
    question: "题目中的数量如何对应到数学变量？算出的结果回到原情境后是否合理？",
    applicableWhen: ["题目给出真实情境、数量和约束", "单位和变量含义能够明确"], avoidWhen: ["只列式不说明变量含义", "得到数值后不检查单位和情境限制"],
    source: "项目自编基础知识卡（待教师复核）", references: [CURRICULUM_REFERENCE, DETAIL_REFERENCES.modeling]
  }
].map(card => Object.freeze(card)));

const STAGE_TITLES = { task_generation: "学习任务编排", help: "求助", hint_level_1: "一级提示", hint_level_2: "二级提示", hint_level_3: "三级提示", judgment: "判别", transfer: "迁移", reflection: "反思" };
const SEED_STRATEGIES = Object.entries(DEFAULT_STAGE_STRATEGIES)
  .filter(([stage]) => stage !== "initial_thinking")
  .map(([stage, strategy]) => ({
    id: `strategy-${stage.replaceAll("_", "-")}`, version: 1, status: "published", kind: "strategy",
    title: `${STAGE_TITLES[stage]}的教学策略`, category: "教学策略", subject: "初中数学", gradeRange: [], keywords: [], aliases: [],
    principle: strategy.instruction, question: "学生本轮已经独立完成了哪一个认知动作？",
    applicableWhen: [`当前处于${STAGE_TITLES[stage]}阶段`], avoidWhen: ["代替学生完成当前认知动作"],
    source: "项目五阶段教学流程规则（项目自编，待教师复核）", references: [],
    strategies: [{ ...strategy, cardId: `strategy-${stage.replaceAll("_", "-")}` }]
  }));
const INITIAL_SEED_DATE = "2026-11-11T00:00:00.000Z";
const INITIAL_RECORDS = [...SEED_CARDS, ...SEED_STRATEGIES].map(card => normalizeCard({ ...card, createdAt: INITIAL_SEED_DATE, updatedAt: INITIAL_SEED_DATE, publishedAt: INITIAL_SEED_DATE }, { status: "published", version: 1 }));
// Initial records are stable across Worker instances so concurrent first
// requests can insert the same immutable seed version idempotently.
for (const card of INITIAL_RECORDS) card.updatedAt = INITIAL_SEED_DATE;

function clean(value) { return typeof value === "string" ? value.trim() : ""; }

function list(value, max = 32) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(values.map(item => clean(item)).filter(Boolean))].slice(0, max);
}

function safeId(value) {
  const id = clean(value);
  return /^[a-z][a-z0-9_-]{1,63}$/iu.test(id) ? id : "";
}

function nextVersion(records, id) {
  return records.filter(record => record?.id === id).reduce((max, record) => Math.max(max, Number(record.version) || 0), 0) + 1;
}

function asReference(value, fallbackVersion = 1) {
  const source = value && typeof value === "object" ? value : {};
  const id = clean(source.id); const title = clean(source.title);
  if (!id || !title) return null;
  const version = Number(source.version || fallbackVersion);
  return {
    id: id.slice(0, 120), version: Number.isFinite(version) && version > 0 ? version : fallbackVersion,
    title: title.slice(0, 240), url: clean(source.url).slice(0, 1000),
    publisher: clean(source.publisher).slice(0, 160), reason: clean(source.reason).slice(0, 500)
  };
}

function normalizeReferences(value, version = 1) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map(item => asReference(item, version)).filter(Boolean);
}

function normalizeStage(value) {
  const stage = clean(value).toLowerCase();
  if (["help", "hint", "hint_level_1", "hint_level_2", "hint_level_3", "judgment", "transfer", "reflection", "initial_thinking", "initial", "task_generation"].includes(stage)) {
    return stage === "hint" ? "help" : stage === "initial" ? "initial_thinking" : stage;
  }
  return "help";
}

function normalizeStrategies(value, id = "") {
  if (Array.isArray(value) && value.length === 0) return [];
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const result = values.map((item, index) => {
    const source = item && typeof item === "object" ? item : {};
    const stage = normalizeStage(source.stage || source.phase || "help");
    const instruction = clean(source.instruction || source.promptFocus || source.content);
    if (!instruction) return null;
    return { id: clean(source.id) || `${id || "card"}-${stage}-${index + 1}`, cardId: id, stage, action: clean(source.action || source.kind || "question").slice(0, 80), instruction: instruction.slice(0, 600) };
  }).filter(Boolean);
  return result.length ? result : [
    { id: `${id || "card"}-help`, cardId: id, stage: "help", action: "question", instruction: "先询问这条知识关系在本题中的适用条件。" },
    { id: `${id || "card"}-hint-1`, cardId: id, stage: "hint_level_1", action: "locate", instruction: "请学生找出题面中与这条关系对应的一个条件。" },
    { id: `${id || "card"}-hint-2`, cardId: id, stage: "hint_level_2", action: "connect", instruction: "请学生说明该关系如何连接到当前的一步。" },
    { id: `${id || "card"}-hint-3`, cardId: id, stage: "hint_level_3", action: "scaffold", instruction: "给出最小脚手架，让学生补全缺失的一步。" },
    { id: `${id || "card"}-judgment`, cardId: id, stage: "judgment", action: "verify", instruction: "请学生核验AI建议是否满足这条关系的适用条件。" },
    { id: `${id || "card"}-transfer`, cardId: id, stage: "transfer", action: "transfer", instruction: "先让学生在迁移题中独立寻找这条关系，不直接给出答案。" }
  ];
}

function normalizeCard(input = {}, { existing = null, status = "draft", version = null } = {}) {
  const source = input && typeof input === "object" ? input : {};
  const id = safeId(source.id || existing?.id) || `card-${crypto.randomUUID()}`;
  const next = Number(version || source.version || existing?.version || 1);
  const cardStatus = status;
  const title = clean(source.title || existing?.title); const principle = clean(source.principle || existing?.principle); const question = clean(source.question || existing?.question);
  if (!title || !principle || !question) { const error = new Error("知识卡需要标题、原则和引导问题。 "); error.code = "INVALID_KNOWLEDGE_CARD"; error.status = 400; throw error; }
  const card = {
    id, version: Number.isFinite(next) && next > 0 ? Math.floor(next) : 1, status: cardStatus,
    kind: (source.kind || existing?.kind) === "strategy" ? "strategy" : "math",
    title: title.slice(0, 160), category: clean(source.category || existing?.category || "数与代数").slice(0, 80), subject: clean(source.subject || existing?.subject || "初中数学").slice(0, 80),
    gradeRange: list(source.gradeRange ?? existing?.gradeRange, 8), keywords: list(source.keywords ?? existing?.keywords, 32), aliases: list(source.aliases ?? existing?.aliases, 32),
    principle: principle.slice(0, 1000), question: question.slice(0, 600),
    applicableWhen: list(source.applicableWhen ?? source.requiredConditions ?? existing?.applicableWhen ?? existing?.requiredConditions, 12),
    avoidWhen: list(source.avoidWhen ?? existing?.avoidWhen, 12),
    requiredConditions: list(source.requiredConditions ?? source.applicableWhen ?? existing?.requiredConditions ?? existing?.applicableWhen, 12),
    source: clean(source.source ?? existing?.source).slice(0, 240), references: normalizeReferences(source.references ?? existing?.references, Number.isFinite(next) ? Math.floor(next) : 1),
    reviewStatus: (source.reviewStatus || existing?.reviewStatus) === "teacher_reviewed" ? "teacher_reviewed" : "pending_teacher_review", strategies: normalizeStrategies(source.strategies ?? existing?.strategies, id),
    createdAt: clean(source.createdAt || existing?.createdAt) || new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...(clean(source.updatedBy || existing?.updatedBy) ? { updatedBy: clean(source.updatedBy || existing?.updatedBy).slice(0, 120) } : {}),
    ...(cardStatus === "published" ? { publishedAt: clean(source.publishedAt) || new Date().toISOString() } : {}), ...(cardStatus === "disabled" ? { disabledAt: clean(source.disabledAt) || new Date().toISOString() } : {})
  };
  if (card.kind === "strategy" && !Array.isArray(source.strategies ?? existing?.strategies)) {
    card.strategies = [{ id: `${id}-help`, cardId: id, stage: "help", action: "question", instruction: card.principle }];
  }
  if (card.kind !== "strategy" && !card.keywords.length && !card.aliases.length) { const error = new Error("知识卡至少需要一个关键词或别名。 "); error.code = "INVALID_KNOWLEDGE_CARD_KEYWORDS"; error.status = 400; throw error; }
  if (card.status === "published" && card.kind === "strategy" && !card.strategies.length) throw Object.assign(new Error("教学策略发布前请至少填写一个阶段的引导动作。"), { code: "KNOWLEDGE_STRATEGY_REQUIRED", status: 400 });
  if (card.status === "published" && !card.source) throw Object.assign(new Error("发布前请填写可核对的来源说明。"), { code: "KNOWLEDGE_SOURCE_REQUIRED", status: 400 });
  for (const reference of card.references) {
    if (reference.url && !/^https?:\/\//iu.test(reference.url)) throw Object.assign(new Error("来源链接必须使用HTTP或HTTPS。"), { code: "INVALID_KNOWLEDGE_SOURCE", status: 400 });
  }
  return card;
}

function publicCard(card = {}) {
  const source = card && typeof card === "object" ? card : {};
  return {
    id: clean(source.id), version: Number(source.version) || 1, status: CARD_STATUSES.includes(source.status) ? source.status : "published", reviewStatus: source.reviewStatus === "teacher_reviewed" ? "teacher_reviewed" : "pending_teacher_review", title: clean(source.title), category: clean(source.category), subject: clean(source.subject), gradeRange: list(source.gradeRange, 8),
    principle: clean(source.principle), question: clean(source.question), applicableWhen: list(source.applicableWhen ?? source.requiredConditions, 12), requiredConditions: list(source.requiredConditions ?? source.applicableWhen, 12), avoidWhen: list(source.avoidWhen, 12), source: clean(source.source || "项目自编基础知识卡（待教师复核）"),
    // References are safe provenance metadata. Do not expose keywords,
    // aliases, server-side strategies, or any private rubric in this shape.
    references: normalizeReferences(source.references, Number(source.version) || 1)
  };
}

// Teacher endpoints need enough information to edit and audit a card. This
// shape is never used for student/task output; taskToPublic and publicCard
// intentionally omit matching keywords, aliases, and server-side strategies.
// Public cards retain bounded provenance and review status so a student or
// teacher can see that a card is project-authored and still awaiting review.
function managementCard(card = {}) {
  const source = card && typeof card === "object" ? card : {};
  return {
    id: clean(source.id), version: Number(source.version) || 1,
    status: CARD_STATUSES.includes(source.status) ? source.status : "draft",
    kind: source.kind === "strategy" ? "strategy" : "math", reviewStatus: source.reviewStatus === "teacher_reviewed" ? "teacher_reviewed" : "pending_teacher_review",
    title: clean(source.title), category: clean(source.category), subject: clean(source.subject),
    gradeRange: list(source.gradeRange, 8), keywords: list(source.keywords, 32), aliases: list(source.aliases, 32),
    principle: clean(source.principle), question: clean(source.question),
    applicableWhen: list(source.applicableWhen ?? source.requiredConditions, 12),
    requiredConditions: list(source.requiredConditions ?? source.applicableWhen, 12),
    avoidWhen: list(source.avoidWhen, 12), source: clean(source.source),
    references: normalizeReferences(source.references, Number(source.version) || 1),
    strategies: normalizeStrategies(source.strategies, clean(source.id)),
    ...(clean(source.createdAt) ? { createdAt: clean(source.createdAt) } : {}),
    ...(clean(source.updatedAt) ? { updatedAt: clean(source.updatedAt) } : {}),
    ...(clean(source.updatedBy) ? { updatedBy: clean(source.updatedBy) } : {}),
    ...(clean(source.publishedAt) ? { publishedAt: clean(source.publishedAt) } : {}),
    ...(clean(source.disabledAt) ? { disabledAt: clean(source.disabledAt) } : {})
  };
}

function queryText(task = {}) {
  const transfer = task.transferTask || task.transfer || {};
  const fields = [task.problemText, task.title, task.problemType, task.subject, task.learningGoal, task.proofGoal, task.category, ...(Array.isArray(task.knowledgePoints) ? task.knowledgePoints : []), ...(Array.isArray(task.knownFacts) ? task.knownFacts : []), transfer.knowledgePoint];
  return fields.filter(value => typeof value === "string").join(" ").toLowerCase().slice(0, 16000);
}

function rankCards(cards, task = {}, { studentText = "" } = {}) {
  const text = queryText(task);
  const studentQuery = clean(studentText).toLowerCase().slice(0, 4000);
  return cards.map(card => {
    const keywords = list(card.keywords); const aliases = list(card.aliases); const keywordHits = keywords.filter(term => text.includes(term.toLowerCase())); const aliasHits = aliases.filter(term => text.includes(term.toLowerCase()));
    const conditionTerms = [...list(card.applicableWhen), ...list(card.avoidWhen)];
    const conditionHits = conditionTerms.filter(condition => text.includes(condition.toLowerCase())).length;
    const avoidHits = list(card.avoidWhen).filter(condition => text.includes(condition.toLowerCase())).length;
    // Student text can refine already task-matched cards, but it can never
    // introduce a card that the confirmed task did not match.
    const studentHits = [...keywords, ...aliases].filter(term => studentQuery.includes(term.toLowerCase())).length;
    const grade = clean(task.grade || task.schoolGrade);
    // The UI uses “初中其他年级” when the exact grade is unavailable. Treat
    // that and other explicit unknown markers as unspecified; otherwise a
    // generic student task would accidentally lose every grade-scoped card.
    const gradeSpecified = grade && !/^(初中|初中其他年级|其他|未知|未指定|不详)$/iu.test(grade);
    const gradeMatch = !gradeSpecified || !Array.isArray(card.gradeRange) || !card.gradeRange.length || card.gradeRange.includes(grade);
    const baseScore = keywordHits.length * 3 + aliasHits.length * 2 + (gradeMatch ? 1 : -3);
    const score = baseScore + conditionHits * 0.25 - avoidHits * 0.5 + studentHits * 0.2;
    return {
      card,
      score,
      baseScore,
      hits: [...new Set([...keywordHits, ...aliasHits])].slice(0, 8),
      gradeMatch,
      conditionHits,
      avoidHits,
      studentHits
    };
  // A clear exclusion phrase is stronger than a keyword hit. The model still
  // receives the selected card's applicability conditions and is responsible
  // for the final mathematical check, but an explicit mismatch must not be
  // surfaced as a likely reference in the first place.
  }).filter(item => item.baseScore > 1 && item.gradeMatch && item.avoidHits === 0).sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id)).slice(0, 2);
}

function referencesFor(items) {
  const seen = new Set(); const result = [];
  for (const item of items) {
    const card = item.card || {};
    const key = `${card.id}@${card.version || 1}`;
    if (!card.id || seen.has(key)) continue;
    seen.add(key);
    const hits = Array.isArray(item.hits) && item.hits.length ? `匹配词：${item.hits.join("、")}。` : "按任务知识点匹配。";
    result.push({
      id: card.id,
      version: Number(card.version) || 1,
      title: clean(card.title),
      reason: `${hits}仅作为本阶段的候选通用参照，仍需结合题目条件核验。`
    });
  }
  return result;
}

async function recordsFromStore(store) {
  if (!store) return [...INITIAL_RECORDS];
  if (typeof store.knowledgeCards !== "function") return [];
  return await Promise.resolve(store.knowledgeCards());
}

async function activeRecords(store, options = {}) {
  const records = await recordsFromStore(store); const includeDrafts = options.includeDrafts === true; const includeDisabled = options.includeDisabled === true;
  if (options.history === true) return records.filter(record => includeDisabled || record.status !== "disabled");
  const grouped = new Map();
  for (const record of records) {
    if (!record?.id) continue;
    const group = grouped.get(record.id) || [];
    group.push(record);
    grouped.set(record.id, group);
  }
  const selected = [];
  for (const group of grouped.values()) {
    const ordered = group.sort((a, b) => Number(b.version || 0) - Number(a.version || 0));
    // A draft is an edit candidate and must not hide the currently published
    // version. Disabled is an explicit current state and therefore wins over
    // older published versions.
    const effective = ordered.find(record => record.status === "disabled" || record.status === "published");
    if (effective) selected.push(effective);
    if (includeDrafts) {
      const draft = ordered.find(record => record.status === "draft");
      if (draft) selected.push(draft);
    }
  }
  return selected.filter(record => includeDisabled || record.status !== "disabled");
}

export async function initializeKnowledge(store = null) {
  if (!store) return { seeded: false, cards: INITIAL_RECORDS.filter(card => card.kind === "math").map(publicCard), references: [CURRICULUM_REFERENCE] };
  if (typeof store.knowledgeCards !== "function" || typeof store.saveKnowledgeCard !== "function") throw new TypeError("知识库初始化需要支持 knowledgeCards/saveKnowledgeCard 的存储。");
  const existing = await store.knowledgeCards();
  if (!Array.isArray(existing)) throw new TypeError("知识库存储格式不正确，已停止初始化。");
  const present = new Set(existing.map(card => card.id));
  let seeded = false;
  for (const card of INITIAL_RECORDS) {
    if (present.has(card.id)) continue;
    try { await store.saveKnowledgeCard(structuredClone(card)); seeded = true; }
    catch (error) {
      // A concurrent initializer may have won. Never overwrite its row or
      // re-enable a teacher's disabled entry.
      if (error.code !== "KNOWLEDGE_VERSION_CONFLICT" || !(await store.knowledgeCards()).some(item => item.id === card.id)) throw error;
    }
  }
  return { seeded, cards: (await activeRecords(store)).filter(card => card.kind !== "strategy").map(publicCard), references: [CURRICULUM_REFERENCE] };
}

export async function listKnowledge(store = null, options = {}) {
  const records = await recordsFromStore(store);
  if (options.history === true) {
    return records
      .filter(card => options.includeDisabled === false ? card.status !== "disabled" : true)
      .map(managementCard)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)) || Number(a.version) - Number(b.version));
  }
  const latest = new Map();
  for (const record of records) {
    if (!record?.id) continue;
    const current = latest.get(record.id);
    if (!current || Number(record.version || 0) > Number(current.version || 0)) latest.set(record.id, record);
  }
  return [...latest.values()]
    .filter(card => options.publishedOnly !== true || card.status === "published")
    .filter(card => options.includeDisabled === false ? card.status !== "disabled" : true)
    .map(managementCard)
    .sort((a, b) => String(a.category || "").localeCompare(String(b.category || ""), "zh-CN") || String(a.title || "").localeCompare(String(b.title || ""), "zh-CN"));
}

async function allKnowledgeRecords(store) {
  if (!store) return [...INITIAL_RECORDS];
  return typeof store.knowledgeCards === "function" ? await Promise.resolve(store.knowledgeCards()) : [];
}
async function latestKnowledgeRecord(store, id) { return (await allKnowledgeRecords(store)).filter(item => item?.id === id).sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0] || null; }
async function nextStoreVersion(store, id) { if (!id) return 1; return nextVersion(await allKnowledgeRecords(store), safeId(id)); }

function assertEditorVersion(existing, input = {}) {
  if (input.expectedVersion === undefined) return;
  if (Number(input.expectedVersion) !== Number(existing?.version || 0)) throw Object.assign(new Error("这条知识内容已被更新，请重新读取后再保存。"), { code: "KNOWLEDGE_VERSION_CONFLICT", status: 409 });
}

export async function saveKnowledgeDraft(store, input = {}) {
  if (!store || typeof store.saveKnowledgeCard !== "function") throw new TypeError("保存知识库草稿需要可写入的存储。 ");
  const existing = input.id ? await latestKnowledgeRecord(store, safeId(input.id)) : null; assertEditorVersion(existing, input); const card = normalizeCard(input, { existing, status: "draft", version: await nextStoreVersion(store, input.id) }); card.status = "draft"; await store.saveKnowledgeCard(card); return card;
}

export async function publishKnowledge(store, id, input = {}) {
  if (!store || typeof store.saveKnowledgeCard !== "function") throw new TypeError("发布知识库需要可写入的存储。 ");
  const safe = safeId(id); if (!safe) throw new Error("知识卡 id 无效。 "); const existing = await latestKnowledgeRecord(store, safe); if (!existing && !Object.keys(input || {}).length) throw new Error("找不到要发布的知识卡草稿。 ");
  assertEditorVersion(existing, input); if (existing?.status === "published") return existing; if (existing?.status !== "draft") throw Object.assign(new Error("请先保存草稿，再发布。"), { code: "KNOWLEDGE_DRAFT_REQUIRED", status: 409 }); const card = normalizeCard({ ...(existing || {}), ...(input || {}), id: safe }, { existing, status: "published", version: await nextStoreVersion(store, safe) }); card.status = "published"; card.publishedAt = new Date().toISOString(); await store.saveKnowledgeCard(card); return card;
}

export async function disableKnowledge(store, id, input = {}) {
  if (!store || typeof store.saveKnowledgeCard !== "function") throw new TypeError("停用知识卡需要可写入的存储。 ");
  const safe = safeId(id); if (!safe) throw new Error("知识卡 id 无效。 "); const existing = await latestKnowledgeRecord(store, safe); if (!existing) throw new Error("找不到要停用的知识卡。 ");
  assertEditorVersion(existing, input); if (existing.status === "disabled") return existing; const card = normalizeCard({ ...existing, ...(input || {}), id: safe, status: "disabled" }, { existing, status: "disabled", version: await nextStoreVersion(store, safe) }); card.status = "disabled"; card.disabledAt = new Date().toISOString(); await store.saveKnowledgeCard(card); return card;
}

export async function retrieveKnowledge(store, { task = {}, session = {}, stage = "help", studentText = "" } = {}) {
  const currentStage = normalizeStage(stage || session?.stage || "help");
  if (currentStage === "initial_thinking") return { cards: [], strategies: [], references: [] };
  const active = await activeRecords(store);
  const math = active.filter(card => card.kind !== "strategy");
  const ranked = currentStage === "reflection" ? [] : rankCards(math, task, { studentText });
  const generic = active.filter(card => card.kind === "strategy" && !card.keywords?.length && !card.aliases?.length);
  const matched = rankCards(active.filter(card => card.kind === "strategy" && (card.keywords?.length || card.aliases?.length)), task, { studentText });
  const candidates = [...matched, ...generic.map(card => ({ card, hits: [] }))];
  const strategyItems = candidates.map(item => ({ ...item, instructions: (item.card.strategies || []).filter(strategy => strategy.stage === currentStage) }))
    .filter(item => item.instructions.length).slice(0, 2);
  const localInstructions = ranked.flatMap(item => (item.card.strategies || []).filter(strategy => strategy.stage === currentStage));
  return {
    cards: ranked.map(item => publicCard(item.card)),
    strategies: [...strategyItems.flatMap(item => item.instructions), ...localInstructions],
    references: referencesFor([...ranked, ...strategyItems]).map(reference => ({ ...reference, kind: strategyItems.some(item => item.card.id === reference.id) ? "strategy" : "math" }))
  };
}

export function findKnowledgeCards(task = {}) { return rankCards(INITIAL_RECORDS.filter(card => card.kind !== "strategy"), task).map(item => publicCard(item.card)); }

export { CARD_STATUSES, CURRICULUM_REFERENCE, DEFAULT_STAGE_STRATEGIES, publicCard as toPublicKnowledgeCard };
